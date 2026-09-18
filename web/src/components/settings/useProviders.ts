import { useEffect, useState } from 'react';
import type { AiRole, Provider, ProviderDescriptor } from '@shared/types';
import { api } from '../../api';

/**
 * The provider registry as the Admin UI sees it. Loaded once per page from
 * /api/providers — the server is the only source of which providers exist and
 * which models each one knows, so no list of model names lives in the client.
 */
export function useProviders(): { providers: ProviderDescriptor[]; loaded: boolean; error: string | null } {
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.providers()
      .then((r) => { if (!cancelled) setProviders(r.providers); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the provider list.'); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);
  return { providers, loaded, error };
}

export function providerOptions(providers: ProviderDescriptor[], role: AiRole): { value: string; label: string }[] {
  return providers.filter((p) => p.roles.includes(role)).map((p) => ({ value: p.id, label: p.label }));
}

export function descriptorFor(providers: ProviderDescriptor[], id: Provider | string | undefined): ProviderDescriptor | undefined {
  return providers.find((p) => p.id === id);
}

/**
 * The model to carry across a provider change: the same name if the new
 * provider knows it, otherwise that provider's default — never a model the
 * new provider cannot run.
 */
export function modelForProvider(providers: ProviderDescriptor[], provider: Provider | string, current: string): string {
  const d = descriptorFor(providers, provider);
  if (!d) return current;
  return d.models.some((m) => m.id === current) ? current : d.defaultModel;
}
