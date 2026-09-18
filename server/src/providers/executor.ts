/**
 * One entry point for running a role on whatever provider it is configured to
 * use. Workflow and Project Director call this; neither imports an adapter,
 * and neither knows which backend answered.
 *
 *   role → role configuration → provider → registry → adapter → execution
 */
import type { Provider } from '../../../shared/types';
import { policyFor } from './policies';
import { providerRegistry } from './registry';
import { resumableSession } from './sessions';
import type { RoleExecutionRequest, ProviderTurnResult } from './types';

/** chats already told, once, that their session did not survive a provider change */
const switchNoted = new Set<string>();

export async function executeRole(req: RoleExecutionRequest): Promise<ProviderTurnResult> {
  const adapter = providerRegistry.get(req.provider);
  const { session, switchedFrom } = resumableSession(req.session, req.provider);

  // A provider change is a visible fact about the run, not a silent downgrade:
  // the conversation continues from Tandem's own history, but the backend's
  // native session does not carry over and the operator should know why the
  // next turn starts cold.
  if (switchedFrom && !switchNoted.has(`${req.handle.chat.id}:${req.provider}`)) {
    switchNoted.add(`${req.handle.chat.id}:${req.provider}`);
    req.handle.status(
      `${providerLabel(req.provider)} is now running the ${req.role.replace('_', ' ')} role. `
      + `The ${providerLabel(switchedFrom)} session cannot be continued by another provider, so this turn starts a new one; the conversation itself is preserved.`,
    );
  }

  return adapter.runTurn({
    handle: req.handle,
    role: req.role,
    model: req.model,
    effort: req.effort,
    cwd: req.cwd,
    systemPrompt: req.systemPrompt,
    userPrompt: req.userPrompt,
    timeoutMs: req.timeoutMs,
    policy: policyFor(req.role),
    ...(session ? { session } : {}),
    ...(req.emitActivity !== undefined ? { emitActivity: req.emitActivity } : {}),
    ...(req.nameSession ? { nameSession: true } : {}),
  });
}

export function providerLabel(provider: Provider): string {
  return providerRegistry.has(provider) ? providerRegistry.get(provider).descriptor.label : provider;
}

/** the one-word name for running prose: "Claude overload", "Codex usage limit" */
export function providerShortLabel(provider: Provider): string {
  return providerRegistry.has(provider) ? providerRegistry.get(provider).descriptor.shortLabel : provider;
}

/** Health of every registered provider. Never spends model usage. */
export async function allProviderHealth() {
  return Promise.all(providerRegistry.list().map((d) => providerRegistry.get(d.id).health()));
}
