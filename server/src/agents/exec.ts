/**
 * The one place Builder execution configuration is resolved.
 *
 * A chat that carries an Agent snapshot (every Project Director session since
 * Agent profiles landed) executes with THAT snapshot — its model, its reasoning
 * effort, its specialist prompt overlay — for every turn of its life: first
 * Builder turn, continuation, repair, final repair, review retry after an
 * outage, and anything resumed after a restart. The mutable profile row is
 * never consulted again.
 *
 * A chat without a snapshot (ordinary Tandem chats, and every session that
 * predates this feature) keeps the historical behavior exactly: the Builder
 * role settings from Admin → AI Roles. Nothing is migrated or retrofitted.
 */
import type { AppSettings, Effort } from '../../../shared/types';
import { getAgentSnapshot } from './store';

export interface BuilderExec {
  model: string;
  effort: Effort;
  /** specialist overlay for builderSystemText; undefined = no agent profile */
  agentPrompt?: string;
  /** display/observability only */
  agentName?: string;
}

export function builderExecFor(chatId: string, settings: AppSettings): BuilderExec {
  const snap = getAgentSnapshot(chatId);
  if (!snap) {
    const b = settings.roles.builder;
    return { model: b.model, effort: b.effort };
  }
  return { model: snap.model, effort: snap.effort, agentPrompt: snap.systemPrompt, agentName: snap.profileName };
}
