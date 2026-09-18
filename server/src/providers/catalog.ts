/**
 * Model catalogs, owned by the provider they belong to.
 *
 * Nothing outside a provider module should hold a list of model names: that is
 * how "the Claude models" ended up in a shared constant that the Codex role
 * also imported, and why adding a backend meant editing the UI. Each descriptor
 * below travels with its adapter, and the Admin UI renders whatever the
 * registry reports.
 *
 * A catalog is a list of KNOWN models, not a whitelist. A name Tandem has not
 * heard of is still accepted for its own provider — new models ship faster than
 * this file changes. What is refused is a model that demonstrably belongs to a
 * different backend (see validateProviderModel), because that is a
 * misconfiguration rather than a new release.
 */
import type { ModelDescriptor, Provider } from '../../../shared/types';

export const CLAUDE_CODE_MODELS: ModelDescriptor[] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', note: 'most capable' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'balanced' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'fastest' },
];

export const CODEX_MODELS: ModelDescriptor[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
];

/**
 * Which provider a model name plainly belongs to, or null when it is not
 * recognizable. Deliberately narrow: it answers "is this the OTHER backend's
 * model", not "which model is this".
 */
export function providerOfModel(model: string): Provider | null {
  const m = model.trim().toLowerCase();
  if (!m) return null;
  if (CLAUDE_CODE_MODELS.some((d) => d.id === m) || /^claude[-.]/.test(m)) return 'claude-code';
  if (CODEX_MODELS.some((d) => d.id === m) || /^(gpt|o[34])[-.]/.test(m)) return 'codex';
  return null;
}
