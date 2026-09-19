/**
 * Provider-native sessions, and the rule that they never cross a provider.
 *
 * A session id is transport state: it means something to the backend that
 * minted it and nothing at all to any other. Handing a Claude session id to
 * Codex does not continue the conversation — at best it starts a new one, at
 * worst it resumes an unrelated thread. So every stored id carries its owner,
 * and a resume happens only when the owner matches the provider now resolved.
 *
 * When they do not match, nothing is deleted. The provider session is a
 * continuity aid, not the conversation: Tandem's own history is the record, and
 * a fresh session is seeded from it (see engine/workflow builderMessage). That
 * is what "switching provider does not lose the chat" means here.
 */
import type { AiRole, Provider, ProviderSessionRef } from '../../../shared/types';
import { getBuilderSession, getBuilderSessionProvider, getBuilderSessionRole, setBuilderSession } from '../db';
import { providerRegistry } from './registry';

/** The chat's stored session with its owner, or null when it has none. */
export function storedSessionRef(chatId: string): ProviderSessionRef | null {
  const id = getBuilderSession(chatId);
  if (!id) return null;
  return { provider: getBuilderSessionProvider(chatId), role: getBuilderSessionRole(chatId), id };
}

export function rememberSession(chatId: string, ref: ProviderSessionRef | undefined | null): void {
  if (!ref?.id) return;
  setBuilderSession(chatId, ref.id, ref.provider, ref.role);
}

/**
 * The session to hand this provider for this role, or nothing to start fresh.
 *
 * Three independent reasons to refuse, all ordinary: the stored session belongs
 * to another provider; it belongs to another logical role (a Builder Reviewer
 * thread is not the Builder's conversation, whatever backend both use); or
 * this backend cannot resume sessions at all.
 */
export function resumableSession(
  stored: ProviderSessionRef | null | undefined,
  provider: Provider,
  role: AiRole,
): { session?: ProviderSessionRef; switchedFrom?: Provider; otherRole?: AiRole } {
  if (!stored?.id) return {};
  if (stored.provider !== provider) return { switchedFrom: stored.provider };
  if (!sameRoleLineage(stored.role, role)) return { otherRole: stored.role };
  if (!providerRegistry.get(provider).descriptor.capabilities.resumableSessions) return {};
  return { session: stored };
}

/** the Builder and its final repair are one conversation; every other role is its own */
function sameRoleLineage(a: AiRole, b: AiRole): boolean {
  const norm = (r: AiRole) => (r === 'final_repair' ? 'builder' : r);
  return norm(a) === norm(b);
}
