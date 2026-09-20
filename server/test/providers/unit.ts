/**
 * The provider architecture, checked without a model call.
 *
 * Run with a throwaway DATA_DIR:  DATA_DIR=$(mktemp -d) npx tsx server/test/providers/unit.ts
 * (the db module opens DATA_DIR at import time, so the caller must set it).
 */
import { providerRegistry, canonicalProvider } from '../../src/providers/registry';
import { policyFor } from '../../src/providers/policies';
import { resolveBuilderReviewerRole, resolveBuilderRole, resolveDirectorReviewerRole, resolveDirectorRoleConfig, validateProviderModel } from '../../src/providers/resolve';
import { parseArbitration, parseDispositions, parseProceed } from '../../src/engine/arbitration';
import { parseVerdict } from '../../src/engine/workflow';
import { policyFor as _p, roleFamily } from '../../src/providers/policies';
import { resumableSession } from '../../src/providers/sessions';
import { providerOfModel } from '../../src/providers/catalog';
import { classifyCodexFailure } from '../../src/providers/codex-cli/errors';
import { classifyClaudeFailure } from '../../src/providers/claude-code-cli/errors';
import { outageFromFailure } from '../../src/engine/reviewWait';
import { DEFAULT_SETTINGS, getSettings, migrateReviewerSplit, validateRoleConfigs } from '../../src/settings';
import { db, kvGet, kvSet } from '../../src/db';
import { planSessions, createRun, setSessionDifficulty } from '../../src/director/store';
import type { AppSettings } from '../../../shared/types';

let bad = 0;
const check = (label: string, ok: boolean, detail?: string) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`); };
const settings = (roles: Partial<AppSettings['roles']>): AppSettings => ({ ...structuredClone(DEFAULT_SETTINGS), roles: { ...structuredClone(DEFAULT_SETTINGS.roles), ...roles } as AppSettings['roles'] });

console.log('--- registry');
check('codex-cli resolves', providerRegistry.get('codex-cli').descriptor.id === 'codex');
check('claude-code-cli resolves', providerRegistry.get('claude-code-cli').descriptor.id === 'claude-code');
check('stored ids resolve unchanged', providerRegistry.get('codex').descriptor.id === 'codex' && providerRegistry.get('claude-code').descriptor.id === 'claude-code');
let threw = ''; try { providerRegistry.get('openai-api'); } catch (e) { threw = String(e); }
check('unknown provider is rejected', /Unknown AI provider "openai-api"/.test(threw), threw);
check('registry lists exactly the two CLI providers', providerRegistry.ids().sort().join(',') === 'claude-code,codex');
check('every provider implements every role', providerRegistry.list().every((d) => ['builder', 'builder_reviewer', 'director_reviewer', 'director', 'final_repair', 'arbiter'].every((r) => d.roles.includes(r as any))));
check('canonicalization is case-insensitive and null for junk', canonicalProvider(' Codex-CLI ') === 'codex' && canonicalProvider(42) === null);

console.log('--- capabilities are declared, not assumed');
const claude = providerRegistry.get('claude-code'), codex = providerRegistry.get('codex');
check('Claude declares native context + compaction and implements both', claude.descriptor.capabilities.nativeContextInspection && claude.descriptor.capabilities.nativeCompaction && !!claude.readContext && !!claude.compactSession);
check('Codex declares neither and implements neither', !codex.descriptor.capabilities.nativeContextInspection && !codex.descriptor.capabilities.nativeCompaction && !codex.readContext && !codex.compactSession);
check('both declare resumable sessions', claude.descriptor.capabilities.resumableSessions && codex.descriptor.capabilities.resumableSessions);
check('model catalogs are provider-owned and disjoint', claude.descriptor.models.every((m) => providerOfModel(m.id) === 'claude-code') && codex.descriptor.models.every((m) => providerOfModel(m.id) === 'codex'));
check('each default model is in its own catalog', claude.descriptor.models.some((m) => m.id === claude.descriptor.defaultModel) && codex.descriptor.models.some((m) => m.id === codex.descriptor.defaultModel));

console.log('--- role resolution, each of the four roles on each provider, independently');
for (const p of ['codex', 'claude-code'] as const) {
  const model = p === 'codex' ? 'gpt-5.6-terra' : 'claude-sonnet-5';
  const s = settings({
    builder: { provider: p, model, effort: 'low', instructions: '' },
    builder_reviewer: { provider: p, model, effort: 'medium', instructions: '', enabled: true },
    director: { provider: p, model, effort: 'high' },
    director_reviewer: { provider: p, model, effort: 'high', instructions: '' },
  });
  const b = resolveBuilderRole(s), br = resolveBuilderReviewerRole(s), d = resolveDirectorRoleConfig(s), dr = resolveDirectorReviewerRole(s);
  check(`Builder resolves ${p}`, b.provider === p && b.model === model && b.effort === 'low', JSON.stringify(b));
  check(`Builder Reviewer resolves ${p}`, br.provider === p && br.model === model && br.effort === 'medium', JSON.stringify(br));
  check(`Director resolves ${p}`, d.provider === p && d.model === model && d.effort === 'high', JSON.stringify(d));
  check(`Director Reviewer resolves ${p}`, dr.ok && dr.role.provider === p && dr.role.model === model, JSON.stringify(dr));
}
{
  // the example configuration from the brief: four different choices, none leaking
  const s = settings({
    builder: { provider: 'claude-code', model: 'claude-opus-5', effort: 'high', instructions: '' },
    builder_reviewer: { provider: 'claude-code', model: 'claude-sonnet-5', effort: 'medium', instructions: '', enabled: true },
    director: { provider: 'claude-code', model: 'claude-fable-5-1', effort: 'high' },
    director_reviewer: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high', instructions: '' },
  });
  const br = resolveBuilderReviewerRole(s), dr = resolveDirectorReviewerRole(s);
  check('Builder Reviewer = Claude Sonnet 5 / medium', br.provider === 'claude-code' && br.model === 'claude-sonnet-5' && br.effort === 'medium');
  check('Director Reviewer = Codex GPT-5.6 / high, independent of the Builder Reviewer', dr.ok && dr.role.provider === 'codex' && dr.role.model === 'gpt-5.6-sol' && dr.role.effort === 'high');
  const d = resolveDirectorRoleConfig(s);
  check('Director = Claude Fable 5.1, not inherited from anyone', d.provider === 'claude-code' && d.model === 'claude-fable-5-1');
}
{
  const s = settings({ builder: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high', instructions: '' } });
  const d = resolveDirectorRoleConfig(s);
  check('Director does NOT inherit a Codex Builder provider', d.provider === 'claude-code' && providerOfModel(d.model) === 'claude-code', JSON.stringify(d));
  const r = resolveBuilderReviewerRole(s);
  check('Builder Reviewer does NOT inherit the Builder provider', r.provider === 'codex' && r.model === DEFAULT_SETTINGS.roles.builder_reviewer.model);
}
{
  const bad = settings({ director_reviewer: { provider: 'anthropic-api' as any, model: 'x', effort: 'high', instructions: '' } });
  const dr = resolveDirectorReviewerRole(bad);
  check('an invalid Director Reviewer is REPORTED, not replaced by the Builder Reviewer', !dr.ok && /Director Reviewer configuration problem/.test((dr as any).error), JSON.stringify(dr));
  const cross = settings({ director_reviewer: { provider: 'codex', model: 'claude-opus-5', effort: 'high', instructions: '' } });
  check('a cross-provider Director Reviewer model is reported too', !resolveDirectorReviewerRole(cross).ok);
}
{
  const legacy = settings({ builder: { provider: 'nope' as any, model: 'claude-opus-5', effort: 'high', instructions: '' } });
  check('an unknown stored Builder provider falls back to the historical one', resolveBuilderRole(legacy).provider === 'claude-code');
  const swapped = settings({ builder_reviewer: { provider: 'claude-code', model: 'gpt-5.6-sol', effort: 'high', instructions: '', enabled: true } });
  const r = resolveBuilderReviewerRole(swapped);
  check('a model from the other backend is replaced by the provider default on read', r.provider === 'claude-code' && r.model === claude.descriptor.defaultModel, JSON.stringify(r));
}

console.log('--- the reviewer split migration');
{
  kvSet('settings', { roles: { builder: { provider: 'claude-code', model: 'claude-opus-5', effort: 'high', instructions: '' }, reviewer: { provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium', instructions: 'be strict', enabled: true } } });
  const before = getSettings();
  check('before migration both reviewers read the legacy value in memory', before.roles.builder_reviewer.model === 'gpt-5.6-terra' && before.roles.director_reviewer.model === 'gpt-5.6-terra' && before.roles.director_reviewer.instructions === 'be strict');
  migrateReviewerSplit();
  const stored = kvGet<any>('settings');
  check('migration wrote both roles and removed the legacy key', stored.roles.builder_reviewer?.model === 'gpt-5.6-terra' && stored.roles.director_reviewer?.model === 'gpt-5.6-terra' && !('reviewer' in stored.roles));
  check('the Director Reviewer carries no "enabled" switch', !('enabled' in stored.roles.director_reviewer) && stored.roles.builder_reviewer.enabled === true);
  stored.roles.builder_reviewer = { ...stored.roles.builder_reviewer, provider: 'claude-code', model: 'claude-sonnet-5' };
  kvSet('settings', stored);
  const after = getSettings();
  check('after migration changing the Builder Reviewer leaves the Director Reviewer untouched', after.roles.builder_reviewer.model === 'claude-sonnet-5' && after.roles.director_reviewer.model === 'gpt-5.6-terra' && after.roles.director_reviewer.provider === 'codex');
  kvSet('settings', {});
}

console.log('--- provider/model validation');
check('codex + gpt model ok', validateProviderModel('codex', 'gpt-5.6-sol').ok);
check('claude-code-cli alias + claude model ok', validateProviderModel('claude-code-cli', 'claude-opus-5').ok);
check('codex + claude model refused', !validateProviderModel('codex', 'claude-opus-5').ok);
check('claude + gpt model refused', !validateProviderModel('claude-code', 'gpt-5.6-terra').ok);
check('unknown provider refused', !validateProviderModel('openrouter', 'anything').ok);
check('unfamiliar model on its own provider accepted', validateProviderModel('codex', 'gpt-7-preview').ok);
check('settings PUT refuses cross-provider pair', /not a model/.test(validateRoleConfigs({ roles: { builder: { provider: 'codex', model: 'claude-opus-5' } } } as any) ?? ''));
check('settings PUT refuses a cross-provider Director Reviewer pair', /not a model/.test(validateRoleConfigs({ roles: { director_reviewer: { provider: 'claude-code', model: 'gpt-5.6-sol' } } } as any) ?? ''));
check('settings PUT refuses unknown provider', /Unknown AI provider/.test(validateRoleConfigs({ roles: { director: { provider: 'anthropic-api', model: 'x' } } } as any) ?? ''));
check('settings PUT accepts a valid director change', validateRoleConfigs({ roles: { director: { provider: 'codex', model: 'gpt-5.6-sol' } } } as any) === null);

console.log('--- sessions never cross providers, and never cross roles');
const claudeSess = { provider: 'claude-code' as const, role: 'builder' as const, id: 'sess-claude-1' };
const codexSess = { provider: 'codex' as const, role: 'builder' as const, id: 'thread-codex-1' };
check('Claude Builder session resumes on Claude as Builder', resumableSession(claudeSess, 'claude-code', 'builder').session?.id === 'sess-claude-1');
check('…and as the final repair (same conversation)', resumableSession(claudeSess, 'claude-code', 'final_repair').session?.id === 'sess-claude-1');
check('Codex session resumes on Codex', resumableSession(codexSess, 'codex', 'builder').session?.id === 'thread-codex-1');
check('switching Claude → Codex does NOT reuse the Claude session', resumableSession(claudeSess, 'codex', 'builder').session === undefined && resumableSession(claudeSess, 'codex', 'builder').switchedFrom === 'claude-code');
check('switching Codex → Claude does NOT reuse the Codex session', resumableSession(codexSess, 'claude-code', 'builder').session === undefined && resumableSession(codexSess, 'claude-code', 'builder').switchedFrom === 'codex');
const reviewerThread = { provider: 'claude-code' as const, role: 'builder_reviewer' as const, id: 'sess-review-9' };
check('a Builder Reviewer thread is never resumed as the Builder (same provider)', resumableSession(reviewerThread, 'claude-code', 'builder').session === undefined && resumableSession(reviewerThread, 'claude-code', 'builder').otherRole === 'builder_reviewer');
check('…nor as the Director', resumableSession(reviewerThread, 'claude-code', 'director').session === undefined);
check('…nor as the Director Reviewer', resumableSession(reviewerThread, 'claude-code', 'director_reviewer').session === undefined);
check('a Director session is never resumed as the Builder', resumableSession({ provider: 'claude-code', role: 'director', id: 'd1' }, 'claude-code', 'builder').session === undefined);
check('no stored session → no resume, no note', JSON.stringify(resumableSession(null, 'codex', 'builder')) === '{}');

console.log('--- role policy is separate from provider');
const b = policyFor('builder'), r = policyFor('builder_reviewer'), d = policyFor('director');
check('Builder writes, has workdir tools, no director tools', b.filesystem === 'read-write' && b.workdirTools && !b.directorTools);
check('Builder Reviewer is read-only with no workdir tools', r.filesystem === 'read-only' && !r.workdirTools && r.browserTools);
check('Director Reviewer has the same read-only posture', JSON.stringify(policyFor('director_reviewer')) === JSON.stringify(r));
check('the arbiter is read-only with no tools at all', policyFor('arbiter').filesystem === 'read-only' && !policyFor('arbiter').browserTools && !policyFor('arbiter').directorTools);
check('tool grants follow the role family', roleFamily('builder_reviewer') === 'reviewer' && roleFamily('director_reviewer') === 'reviewer' && roleFamily('final_repair') === 'builder');
check('Director is read-only with director tools only', d.filesystem === 'read-only' && d.directorTools && !d.workdirTools && !d.browserTools);
check('final repair carries Builder authority', JSON.stringify(policyFor('final_repair')) === JSON.stringify(b));

console.log('--- failures classified by the adapter that saw them');
const cq = classifyCodexFailure("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 4:34 PM.");
check('Codex usage limit → quota', cq.kind === 'quota' && cq.retryable);
check('…and the workflow turns it into a wait, labelled by provider', outageFromFailure(cq, 'Codex CLI')?.reason === 'Codex CLI usage limit');
const cs = classifyClaudeFailure("You've hit your session limit · resets 3pm");
check('Claude session limit → quota', cs.kind === 'quota');
check('Claude 529 → overloaded (transient wait)', classifyClaudeFailure('API Error: 529 Overloaded').kind === 'overloaded' && outageFromFailure(classifyClaudeFailure('API Error: 529 Overloaded'), 'Claude Code CLI')?.transient === true);
check('an auth failure is not a wait', classifyClaudeFailure('OAuth session expired and could not be refreshed').kind === 'authentication' && outageFromFailure(classifyClaudeFailure('OAuth session expired'), 'x') === null);
check('a generic crash is not a wait', outageFromFailure(classifyCodexFailure('codex: fatal: unexpected internal error'), 'x') === null);

console.log('--- the contracts: dispositions, decisions, round 2');
const F = [{ id: 'F-001', severity: 'major' as const, title: 'DOM tests crash before collection', detail: 'x' }, { id: 'F-002', severity: 'minor' as const, title: 'Co-author trailer', detail: 'y' }];
const disp = parseDispositions('Did the work.\n\nFINDING 1: accepted\nReason: fixed the jsdom setup\nEvidence: vitest now collects\nFINDING 2: rejected\nReason: the brief line is not a user requirement\nEvidence: git log', F);
check('dispositions parse with ids, reasons and evidence', disp[0].id === 'F-001' && disp[0].disposition === 'accepted' && disp[1].disposition === 'rejected' && disp[1].evidence === 'git log' && disp[1].source === 'builder');
check('an unanswered finding is recorded as accepted (assumed)', parseDispositions('no block here', F)[1].disposition === 'accepted' && parseDispositions('no block here', F)[1].source === 'assumed');
check('a word outside the contract is recorded as accepted (assumed)', parseDispositions('FINDING 1: maybe\nReason: hm', F)[0].source === 'assumed');
const arb = parseArbitration('FINDING 1: builder_upheld\nReason: generated brief, not a requirement\nRequired: none\nBlocking: no\nFINDING 2: reviewer_upheld\nReason: real crash\nRequired: tests must collect\nBlocking: yes\nPROCEED: no — a real defect remains',
  [{ finding: F[1], index: 1 }, { finding: F[0], index: 2 }]);
check('decisions parse with the new vocabulary', arb[0].decision === 'builder_upheld' && arb[0].blocking === false && arb[1].decision === 'reviewer_upheld' && arb[1].blocking === true && arb[1].required === 'tests must collect');
check('non_blocking and deferred are accepted and never blocking', parseArbitration('FINDING 1: non_blocking\nReason: r\nBlocking: yes', [{ finding: F[0], index: 1 }])[0].blocking === false && parseArbitration('FINDING 1: deferred\nReason: r', [{ finding: F[0], index: 1 }])[0].decision === 'deferred');
check('a missing decision is unresolved and blocking', parseArbitration('nothing usable', [{ finding: F[0], index: 1 }])[0].decision === 'unresolved' && parseArbitration('nothing usable', [{ finding: F[0], index: 1 }])[0].blocking === true);
check('the PROCEED line parses', parseProceed('…\nPROCEED: no — a real defect remains').proceed === false && parseProceed('PROCEED: yes').proceed === true && parseProceed('no line').proceed === undefined);
const known = F.map((f) => ({ ...f, chatId: 'c', taskSeq: 1, round: 1, category: null, file: null, line: null, evidence: null, recommendation: null, state: 'accepted' as const, disposition: 'accepted' as const, dispositionReason: null, dispositionEvidence: null, repairStatus: 'claimed' as const, arbitrationDecision: null, arbitrationReason: null, arbitrationRequired: null, blocking: null, restated: 0, updatedAt: 0 }));
const r2a = parseVerdict('PASS\nRESOLVED F-001 — vitest collects and passes\nRESOLVED F-002 — n/a', known);
check('round 2 PASS with RESOLVED lines parses to pass + verified ids', r2a.verdict === 'pass' && r2a.verified.join(',') === 'F-001,F-002' && r2a.items.length === 0);
const r2b = parseVerdict('FINDINGS\nREPAIR_FAILED F-001 — still crashes: TypeError in setup', known);
check('REPAIR_FAILED reopens the SAME finding and raises nothing new', r2b.verdict === 'findings' && r2b.repairFailed[0].id === 'F-001' && /still crashes/.test(r2b.repairFailed[0].evidence) && r2b.items.length === 0);
const r2c = parseVerdict('FINDINGS\nRESOLVED F-001 — ok\n1. [minor] Unused import — b.ts:3\n   dead code\n   Evidence: b.ts line 3\n   Category: preference\n   Recommendation: remove it', known);
check('a genuinely new round-2 finding parses with evidence and category', r2c.items.length === 1 && r2c.items[0].category === 'preference' && r2c.items[0].evidence === 'b.ts line 3' && r2c.verified[0] === 'F-001');
check('round 1 output still parses as before', parseVerdict('FINDINGS\n1. [major] Broken — a.ts:1\n   detail').items[0].title === 'Broken' && parseVerdict('PASS').verdict === 'pass');

console.log('--- difficulty tiers resolve live, per request');
{
  const tiers = (over: Partial<AppSettings['difficulty']>): AppSettings['difficulty'] => ({
    easy: { builder: null, reviewer: null }, medium: { builder: null, reviewer: null }, hard: { builder: null, reviewer: null }, very_hard: { builder: null, reviewer: null }, ...over,
  });
  const base = settings({});
  // an ordinary chat (no session) has no difficulty: role defaults, as before
  const plain = resolveBuilderRole({ ...base, difficulty: tiers({ hard: { builder: { provider: 'claude-code', model: 'claude-opus-5', effort: 'high' }, reviewer: null } }) }, undefined);
  check('a chat without a session resolves the role default (source role, no difficulty)', plain.source === 'role' && plain.difficulty === undefined && plain.model === DEFAULT_SETTINGS.roles.builder.model);
  // a Director session with a difficulty
  db.prepare("INSERT OR IGNORE INTO projects (id, name, root_path, source, created_at, last_opened_at) VALUES ('p1','p','/tmp/p1','directory',0,0)").run();
  db.prepare("INSERT OR IGNORE INTO chats (id, project_id, title, created_at, updated_at, running, kind) VALUES ('c-proj','p1','project',0,0,0,'project')").run();
  const run = createRun('p1', 'c-proj', 'difficulty test');
  db.prepare("INSERT INTO pd_milestones (id, run_id, key, name, goal, acceptance, status, order_idx, depends_on) VALUES ('m1', ?, 'M1', 'M', 'g', 'a', 'planned', 0, '[]')").run(run.id);
  planSessions(run.id, 'M1', [{ key: 'S1', name: 's', purpose: 'p', prompt: 'x', dependsOn: [], isolated: false, difficulty: 'hard' }]);
  db.prepare("INSERT INTO chats (id, project_id, title, created_at, updated_at, running, kind) VALUES ('c-s1','p1','s',0,0,0,'pd-session')").run();
  db.prepare("UPDATE pd_sessions SET chat_id = 'c-s1' WHERE run_id = ? AND key = 'S1'").run(run.id);
  const cfgA = { ...base, difficulty: tiers({ hard: { builder: { provider: 'claude-code', model: 'claude-sonnet-5', effort: 'medium' }, reviewer: { provider: 'codex', model: 'gpt-5.6-terra', effort: 'low' } } }) };
  const b1 = resolveBuilderRole(cfgA, 'c-s1'), r1 = resolveBuilderReviewerRole(cfgA, 'c-s1');
  check('a hard session resolves the hard tier for the Builder (source difficulty)', b1.source === 'difficulty' && b1.difficulty === 'hard' && b1.model === 'claude-sonnet-5' && b1.effort === 'medium');
  check('…and the hard tier for the Builder Reviewer, independently', r1.source === 'difficulty' && r1.provider === 'codex' && r1.model === 'gpt-5.6-terra' && r1.effort === 'low');
  // the admin changes the tier: the next resolution follows, nothing is frozen
  const cfgB = { ...base, difficulty: tiers({ hard: { builder: { provider: 'claude-code', model: 'claude-haiku-4-5', effort: 'low' }, reviewer: null } }) };
  const b2 = resolveBuilderRole(cfgB, 'c-s1'), r2 = resolveBuilderReviewerRole(cfgB, 'c-s1');
  check('changing the hard tier changes the NEXT Builder resolution', b2.model === 'claude-haiku-4-5' && b2.source === 'difficulty');
  check('clearing the reviewer tier falls back to the role default', r2.source === 'role' && r2.model === DEFAULT_SETTINGS.roles.builder_reviewer.model && r2.difficulty === 'hard');
  // the Director changes the difficulty: the next resolution follows the new tier
  const prev = setSessionDifficulty(run.id, 'S1', 'easy');
  const cfgC = { ...base, difficulty: tiers({ easy: { builder: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' }, reviewer: null }, hard: { builder: { provider: 'claude-code', model: 'claude-opus-5', effort: 'high' }, reviewer: null } }) };
  const b3 = resolveBuilderRole(cfgC, 'c-s1');
  check('set_session_difficulty returns the previous level and the next resolution uses the new tier', prev === 'hard' && b3.difficulty === 'easy' && b3.provider === 'codex' && b3.model === 'gpt-5.6-sol');
  // a tier with a model from the other backend is refused by validation and neutralized on read
  check('settings PUT refuses a cross-provider tier', /not a model/.test(validateRoleConfigs({ difficulty: { hard: { builder: { provider: 'codex', model: 'claude-opus-5', effort: 'high' } } } } as any) ?? ''));
  // a standalone chat: the user's own difficulty on the chat row, same tiers, same live resolution
  db.prepare("INSERT INTO chats (id, project_id, title, created_at, updated_at, running, kind, difficulty) VALUES ('c-plain','p1','plain',0,0,0,'chat','easy')").run();
  const p1 = resolveBuilderRole(cfgC, 'c-plain');
  check('a standalone chat with difficulty easy resolves the easy tier (source difficulty)', p1.source === 'difficulty' && p1.difficulty === 'easy' && p1.model === 'gpt-5.6-sol');
  db.prepare("UPDATE chats SET difficulty = 'hard' WHERE id = 'c-plain'").run();
  const p2 = resolveBuilderRole(cfgC, 'c-plain');
  check('changing the chat difficulty changes the NEXT resolution', p2.difficulty === 'hard' && p2.model === 'claude-opus-5');
  db.prepare("UPDATE chats SET difficulty = NULL WHERE id = 'c-plain'").run();
  const p3 = resolveBuilderRole(cfgC, 'c-plain');
  check('clearing it returns to the role default', p3.source === 'role' && p3.difficulty === undefined);
  // a Director session row always wins over anything on its chat row
  db.prepare("UPDATE chats SET difficulty = 'very_hard' WHERE id = 'c-s1'").run();
  check('a project session takes its difficulty from the session row, never the chat row', resolveBuilderRole(cfgC, 'c-s1').difficulty === 'easy');
  check('settings PUT refuses an unknown level', /Unknown difficulty/.test(validateRoleConfigs({ difficulty: { brutal: { builder: null } } } as any) ?? ''));
  kvSet('settings', { difficulty: { medium: { builder: { provider: 'codex', model: 'claude-opus-5', effort: 'high' }, reviewer: { provider: 'claude-code', model: 'claude-sonnet-5', effort: 'high' } } } });
  const read = getSettings();
  check('an incoherent stored tier reads back as inherit; a coherent one stays', read.difficulty.medium.builder === null && read.difficulty.medium.reviewer?.model === 'claude-sonnet-5');
  kvSet('settings', {});
}

console.log(bad ? `\n${bad} FAILED` : '\nALL PROVIDER UNIT CHECKS PASSED');
process.exit(bad ? 1 : 0);
