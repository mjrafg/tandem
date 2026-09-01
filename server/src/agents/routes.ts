/**
 * Builder Agent admin API — generic CRUD over agent_profiles.
 *
 * Every route is behind the same authenticated admin boundary as the rest of
 * Settings (see the global auth hook). Validation lives in the store, so the
 * server is authoritative no matter what a client sends: provider can only be
 * 'claude-code', models and efforts must come from the shared registry, slugs
 * must be unique among active profiles, and the "exactly one enabled default"
 * invariant is enforced transactionally.
 */
import type { FastifyInstance } from 'fastify';
import {
  AgentError, archiveAgent, createAgent, getAgent, listAgents, restoreAgent,
  setDefaultAgent, updateAgent, type AgentInput,
} from './store';

function body(req: any): AgentInput {
  const b = (req.body ?? {}) as Record<string, unknown>;
  return {
    slug: b.slug as string | undefined,
    name: b.name as string | undefined,
    description: b.description as string | undefined,
    systemPrompt: (b.systemPrompt ?? b.system_prompt) as string | undefined,
    provider: b.provider,
    model: b.model as string | undefined,
    effort: b.effort as string | undefined,
    enabled: b.enabled as boolean | undefined,
    isDefault: (b.isDefault ?? b.is_default) as boolean | undefined,
  };
}

export function registerAgentRoutes(app: FastifyInstance): void {
  const guard = async (fn: () => unknown, reply: any) => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof AgentError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  };

  app.get('/api/agents', async (req) => {
    const q = (req.query ?? {}) as { archived?: string };
    return listAgents({ includeArchived: q.archived === '1' || q.archived === 'true' });
  });

  app.get('/api/agents/:id', async (req, reply) => {
    const agent = getAgent((req.params as any).id);
    if (!agent) return reply.code(404).send({ error: 'Agent profile not found.' });
    return agent;
  });

  app.post('/api/agents', async (req, reply) => guard(() => createAgent(body(req)), reply));

  app.patch('/api/agents/:id', async (req, reply) =>
    guard(() => updateAgent((req.params as any).id, body(req)), reply));

  app.post('/api/agents/:id/default', async (req, reply) =>
    guard(() => setDefaultAgent((req.params as any).id), reply));

  app.post('/api/agents/:id/archive', async (req, reply) =>
    guard(() => archiveAgent((req.params as any).id), reply));

  app.post('/api/agents/:id/restore', async (req, reply) =>
    guard(() => restoreAgent((req.params as any).id), reply));
}
