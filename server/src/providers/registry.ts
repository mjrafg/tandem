/**
 * The authoritative map from a provider id to the adapter that implements it.
 *
 * This is the only place that knows which backends exist. Settings validation,
 * the Admin UI, role execution, context management and the tests all resolve
 * through it, so adding a provider is registering an adapter — not editing a
 * switch statement in the workflow.
 */
import type { AiRole, Provider, ProviderDescriptor } from '../../../shared/types';
import { claudeCodeCliAdapter } from './claude-code-cli/adapter';
import { codexCliAdapter } from './codex-cli/adapter';
import type { ProviderAdapter } from './types';

export { canonicalProvider } from './ids';
import { canonicalProvider } from './ids';

export class ProviderRegistry {
  private readonly adapters = new Map<Provider, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    const id = adapter.descriptor.id;
    if (this.adapters.has(id)) throw new Error(`Provider ${id} is already registered.`);
    this.adapters.set(id, adapter);
    return this;
  }

  /** The adapter for an id. Throws on anything unregistered — callers that can
   *  tolerate an unknown id should ask `has()` first. */
  get(id: unknown): ProviderAdapter {
    const canonical = canonicalProvider(id);
    const adapter = canonical ? this.adapters.get(canonical) : undefined;
    if (!adapter) {
      throw new Error(`Unknown AI provider "${String(id)}". Registered providers: ${this.ids().join(', ')}.`);
    }
    return adapter;
  }

  has(id: unknown): boolean {
    const canonical = canonicalProvider(id);
    return !!canonical && this.adapters.has(canonical);
  }

  ids(): Provider[] { return [...this.adapters.keys()]; }

  list(): ProviderDescriptor[] { return [...this.adapters.values()].map((a) => a.descriptor); }

  /** Providers that implement a given role. */
  forRole(role: AiRole): ProviderDescriptor[] {
    return this.list().filter((d) => d.roles.includes(role));
  }
}

export const providerRegistry = new ProviderRegistry()
  .register(claudeCodeCliAdapter)
  .register(codexCliAdapter);
