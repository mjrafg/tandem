/**
 * Provider identifiers and their aliases — dependency-free on purpose, so
 * settings and the agent store can canonicalize an id without importing the
 * registry (whose adapters import them back).
 *
 * The stored ids stay as they were written when roles were pinned to backends,
 * so historical settings, agent profiles, ai_call events and session rows keep
 * meaning exactly what they meant; the longer `-cli` spellings are accepted
 * and canonicalized.
 */
import type { Provider } from '../../../shared/types';

const ALIASES: Record<string, Provider> = {
  'claude-code': 'claude-code',
  'claude-code-cli': 'claude-code',
  claude: 'claude-code',
  codex: 'codex',
  'codex-cli': 'codex',
};

export const PROVIDER_IDS: Provider[] = ['claude-code', 'codex'];

export function canonicalProvider(id: unknown): Provider | null {
  if (typeof id !== 'string') return null;
  return ALIASES[id.trim().toLowerCase()] ?? null;
}
