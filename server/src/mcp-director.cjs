#!/usr/bin/env node
/**
 * Tandem's MCP stdio server for the PROJECT DIRECTOR — the orchestration
 * capabilities that let the Director operate normal Tandem sessions from
 * above. Every call is forwarded to the Tandem app, which enforces the
 * deterministic invariants (dependencies, cycles, isolation, review policy),
 * persists the decision, and records project activity.
 */
'use strict';

const readline = require('node:readline');

const BASE = (process.env.TANDEM_INTERNAL_URL || '').replace(/\/workdir$/, '');
const CHAT_ID = process.env.TANDEM_CHAT_ID;
const TOKEN = process.env.TANDEM_INTERNAL_TOKEN;

const TOOLS = [
  {
    name: 'project_get_state',
    description: 'Fetch the live project state: milestones, sessions, statuses, dependencies, recent activity. Use it whenever you need fresher detail than the snapshot at the top of your turn.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'project_set_plan',
    description: [
      'Submit or revise the MASTER PLAN as milestones only — do not pre-plan sessions here.',
      'Each milestone needs a short unique key (M1, M2…), a name, a concrete goal, checkable acceptance criteria, and its dependencies (keys of milestones that must complete first).',
      'The plan is independently reviewed after your turn; you will receive the verdict or findings.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short project title (shown in the UI).' },
        summary: { type: 'string', description: 'One-paragraph summary of the overall approach.' },
        milestones: {
          type: 'array',
          description: 'The full milestone list, in intended order.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Unique key, e.g. "M1".' },
              name: { type: 'string', description: 'Short name, e.g. "Foundation".' },
              goal: { type: 'string', description: 'What this milestone delivers.' },
              acceptance: { type: 'string', description: 'How completion is objectively judged.' },
              depends_on: { type: 'array', items: { type: 'string' }, description: 'Keys of prerequisite milestones.' },
            },
            required: ['key', 'name', 'goal', 'acceptance'],
          },
        },
      },
      required: ['milestones', 'summary'],
    },
  },
  {
    name: 'plan_milestone_sessions',
    description: [
      'Decompose ONE milestone into sessions, just in time — after inspecting the actual repository state.',
      'Each session becomes a normal Tandem chat with its own Builder and independent Reviewer. Write each prompt as a full self-contained contract (goal, context, constraints, definition of done) — the session knows nothing about this conversation.',
      'Set isolated=true for sessions that should run in parallel with siblings touching the same repository (each gets its own git worktree and branch); leave it false for sequential work in the shared project directory.',
      'Choose a Builder Agent for each session with agent_profile_id, using an ID from the AVAILABLE BUILDER AGENTS catalog in your instructions.',
      'Judge each session\'s difficulty (easy / medium / hard / very_hard): it selects the configured model tier, so trivial work runs on cheaper models and hard work on stronger ones. You can change it later.',
      'Decide per session whether an independent review is worth its cost (review_required, default true) — by the nature and risk of the work, independently of difficulty. You can change that later too.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        milestone: { type: 'string', description: 'The milestone key, e.g. "M2".' },
        reasoning: { type: 'string', description: 'Why this decomposition and this parallel/sequential shape — recorded as a project decision.' },
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Unique key within the project, e.g. "S2.1".' },
              name: { type: 'string', description: 'Short name, e.g. "Ledger schema".' },
              purpose: { type: 'string', description: 'One-line purpose (shown in the UI).' },
              prompt: { type: 'string', description: 'The complete self-contained instructions for the session\'s Builder.' },
              depends_on: { type: 'array', items: { type: 'string' }, description: 'Session keys that must complete first.' },
              isolated: { type: 'boolean', description: 'true = own worktree/branch for safe parallel work.' },
              agent_profile_id: { type: 'string', description: 'ID of the Builder Agent profile from the AVAILABLE BUILDER AGENTS catalog. Omit to use the default agent.' },
              review_required: { type: 'boolean', description: 'Whether this session needs an INDEPENDENT review (default true). Decide by the nature of the work, not its difficulty: waive it for simple, mechanical, low-risk changes whose result is self-evident; require it for anything sensitive, security-relevant, data-affecting, cross-cutting, hard to verify, or consequential. Changeable later with set_session_review.' },
              difficulty: { type: 'string', enum: ['easy', 'medium', 'hard', 'very_hard'], description: 'Your judgment of how hard this work is. Decides which configured Builder/Reviewer models handle it (Settings → Difficulty tiers): easy = trivial, mechanical changes; medium = ordinary feature work; hard = architecture, tricky debugging, cross-cutting or risky changes; very_hard = research-grade or high-risk work needing the strongest models. Changeable later with set_session_difficulty. Default medium.' },
            },
            required: ['key', 'name', 'purpose', 'prompt', 'difficulty'],
          },
        },
      },
      required: ['milestone', 'sessions', 'reasoning'],
    },
  },
  {
    name: 'set_session_difficulty',
    description: 'Reassess an existing session\'s difficulty (easy / medium / hard / very_hard) — before it starts or while it runs. Difficulty is live: the session\'s NEXT model request (Builder or Builder Reviewer) resolves through the new tier\'s configured models; a request already in flight finishes on the model it started with. Use it when the work turns out substantially easier or harder than planned, or when a cheaper/stronger model is warranted for what remains.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The session key, e.g. "S2.1".' },
        difficulty: { type: 'string', enum: ['easy', 'medium', 'hard', 'very_hard'] },
        reasoning: { type: 'string', description: 'Why — recorded as a project decision.' },
      },
      required: ['key', 'difficulty', 'reasoning'],
    },
  },
  {
    name: 'set_session_review',
    description: 'Change whether a session needs an independent review — before it starts, while it runs (the decision is read when the Builder hands off), or even after it completed with the review waived (a review then runs on the result as it stands). Waive it when the work turns out simple and low-risk; require it when the Builder uncovers complexity, risk or sensitivity you did not expect.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The session key, e.g. "S2.1".' },
        review_required: { type: 'boolean' },
        reasoning: { type: 'string', description: 'Why — recorded as a project decision.' },
      },
      required: ['key', 'review_required', 'reasoning'],
    },
  },
  {
    name: 'start_sessions',
    description: 'Start the listed planned sessions now. The engine refuses any session whose dependencies are unfinished or whose shared directory is occupied. Each starts as a normal Tandem session; you are woken when they finish, fail, or time out.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'array', items: { type: 'string' }, description: 'Session keys to start now.' },
        timeout_minutes: { type: 'number', description: 'Optional per-session time budget in minutes (default 30, max 90).' },
      },
      required: ['keys'],
    },
  },
  {
    name: 'resume_sessions',
    description: 'Resume paused sessions (after a project pause or an interruption). Each continues its OWN existing chat and provider session — completed work is never redone. Only resume what should run now; dependencies are enforced.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'array', items: { type: 'string' } },
        note: { type: 'string', description: 'Optional guidance appended to the continuation message.' },
      },
      required: ['keys'],
    },
  },
  {
    name: 'recover_session',
    description: [
      'Decide how to handle a session that timed out or failed. This is a SIGNIFICANT decision: it is independently reviewed (max two reviews; your second revision applies without further review).',
      'Actions: continue (same chat, optionally more time and guidance), restart (fresh run of the same session, optionally with a rewritten prompt), abandon (work stays on disk; you replan around it), wait (leave it paused until blockers clear).',
      'Ground the decision in the provided context: preserved work, the actual failure cause, and the state of the rest of the milestone.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The session key.' },
        action: { type: 'string', enum: ['continue', 'restart', 'abandon', 'wait'] },
        reasoning: { type: 'string', description: 'Why this recovery is right — the reviewer evaluates this.' },
        new_prompt: { type: 'string', description: 'Updated instructions/contract when the action needs one.' },
        extra_minutes: { type: 'number', description: 'Time budget for the continued/restarted run (max 90).' },
      },
      required: ['key', 'action', 'reasoning'],
    },
  },
  {
    name: 'integrate_milestone',
    description: 'Start the milestone\'s integration session: a normal session on the project integration branch that merges the completed session branches in your chosen order, resolves conflicts honestly, and runs the validations you specify. Requires every milestone session to be completed or abandoned.',
    inputSchema: {
      type: 'object',
      properties: {
        milestone: { type: 'string' },
        instructions: { type: 'string', description: 'Merge order, validations/tests to run, and what would make integration a failure.' },
        timeout_minutes: { type: 'number' },
      },
      required: ['milestone', 'instructions'],
    },
  },
  {
    name: 'complete_milestone',
    description: 'Mark a milestone complete — only when its acceptance criteria actually hold (typically after its integration session passed). Then revise later milestones if what you learned changes them.',
    inputSchema: {
      type: 'object',
      properties: {
        milestone: { type: 'string' },
        summary: { type: 'string', description: 'What was actually delivered.' },
      },
      required: ['milestone', 'summary'],
    },
  },
  {
    name: 'project_deliver',
    description: 'Deliver the finished work: the engine fast-forwards the project\'s base branch to the integration branch and checks the base branch out. Call it when all milestones are complete, before complete_project. If it reports a diverged base branch, launch a reconciliation session that merges the integration branch into the base, then deliver again.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'complete_project',
    description: 'Mark the whole project complete when every milestone is done, the overall goal is satisfied, and the work is delivered (project_deliver). The engine refuses while a milestone is open or the base branch is behind the integration branch; on success it also cleans up session worktrees and merged pd/ branches.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'The delivered result.' } },
      required: ['summary'],
    },
  },
  {
    name: 'project_need_user',
    description: 'Pause orchestration because a genuine decision belongs to the user (ambiguous requirements, a trade-off only they can make). Ask the question in your chat reply; their next message resumes you.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
  },
];

// Admin-edited AI-facing text (descriptions only) — see Admin → AI Tools.
try {
  const overrides = JSON.parse(process.env.TANDEM_TOOL_TEXT || '{}');
  for (const tool of TOOLS) {
    const ov = overrides[`tandem_director.${tool.name}`];
    if (!ov) continue;
    if (typeof ov.description === 'string' && ov.description.trim()) tool.description = ov.description;
    if (ov.params && tool.inputSchema && tool.inputSchema.properties) {
      for (const [param, desc] of Object.entries(ov.params)) {
        if (tool.inputSchema.properties[param] && typeof desc === 'string' && desc.trim()) {
          tool.inputSchema.properties[param].description = desc;
        }
      }
    }
  }
} catch { /* factory text stands */ }

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function callTool(name, args) {
  const res = await fetch(`${BASE}/director`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: CHAT_ID, token: TOKEN, op: name.replace(/^project_/, '').replace(/^plan_milestone_sessions$/, 'plan_sessions'), args: args || {} }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    return { content: [{ type: 'text', text: `Director engine: ${body.error || 'error'}` }], isError: true };
  }
  return { content: [{ type: 'text', text: body.text || 'ok' }] };
}

const OPS = new Map(TOOLS.map((t) => [t.name, true]));

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'tandem_director', version: '1.0.0' },
    });
  } else if (method && method.startsWith('notifications/')) {
    // no response needed
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    const name = params && params.name;
    if (!OPS.has(name)) {
      reply(id, { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true });
      return;
    }
    callTool(name, params && params.arguments)
      .then((result) => reply(id, result))
      .catch((err) => reply(id, { content: [{ type: 'text', text: `Tool call failed: ${String(err)}` }], isError: true }));
  } else if (method === 'ping') {
    reply(id, {});
  } else if (id !== undefined) {
    replyError(id, -32601, `Method not implemented: ${method}`);
  }
});
rl.on('close', () => process.exit(0));
