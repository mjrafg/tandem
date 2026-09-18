/**
 * The provider architecture, checked without a model call.
 *
 * Run with a throwaway DATA_DIR:  DATA_DIR=$(mktemp -d) npx tsx server/test/providers/unit.ts
 * (the db module opens DATA_DIR at import time, so the caller must set it).
 */
import { providerRegistry, canonicalProvider } from '../../src/providers/registry';
import { policyFor } from '../../src/providers/policies';
import { resolveBuilderRole, resolveDirectorRoleConfig, resolveReviewerRole, validateProviderModel } from '../../src/providers/resolve';
import { resumableSession } from '../../src/providers/sessions';
import { providerOfModel } from '../../src/providers/catalog';
import { classifyCodexFailure } from '../../src/providers/codex-cli/errors';
import { classifyClaudeFailure } from '../../src/providers/claude-code-cli/errors';
import { outageFromFailure } from '../../src/engine/reviewWait';
import { DEFAULT_SETTINGS, validateRoleConfigs } from '../../src/settings';
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
check('every provider implements every role', providerRegistry.list().every((d) => ['builder', 'reviewer', 'director', 'final_repair'].every((r) => d.roles.includes(r as any))));
check('canonicalization is case-insensitive and null for junk', canonicalProvider(' Codex-CLI ') === 'codex' && canonicalProvider(42) === null);

console.log('--- capabilities are declared, not assumed');
const claude = providerRegistry.get('claude-code'), codex = providerRegistry.get('codex');
check('Claude declares native context + compaction and implements both', claude.descriptor.capabilities.nativeContextInspection && claude.descriptor.capabilities.nativeCompaction && !!claude.readContext && !!claude.compactSession);
check('Codex declares neither and implements neither', !codex.descriptor.capabilities.nativeContextInspection && !codex.descriptor.capabilities.nativeCompaction && !codex.readContext && !codex.compactSession);
check('both declare resumable sessions', claude.descriptor.capabilities.resumableSessions && codex.descriptor.capabilities.resumableSessions);
check('model catalogs are provider-owned and disjoint', claude.descriptor.models.every((m) => providerOfModel(m.id) === 'claude-code') && codex.descriptor.models.every((m) => providerOfModel(m.id) === 'codex'));
check('each default model is in its own catalog', claude.descriptor.models.some((m) => m.id === claude.descriptor.defaultModel) && codex.descriptor.models.some((m) => m.id === codex.descriptor.defaultModel));

console.log('--- role resolution, each role on each provider');
for (const p of ['codex', 'claude-code'] as const) {
  const model = p === 'codex' ? 'gpt-5.6-terra' : 'claude-sonnet-5';
  const s = settings({
    builder: { provider: p, model, effort: 'low', instructions: '' },
    reviewer: { provider: p, model, effort: 'medium', instructions: '', enabled: true },
    director: { provider: p, model, effort: 'high' },
  });
  const b = resolveBuilderRole(s), r = resolveReviewerRole(s), d = resolveDirectorRoleConfig(s);
  check(`Builder resolves ${p}`, b.provider === p && b.model === model && b.effort === 'low', JSON.stringify(b));
  check(`Reviewer resolves ${p}`, r.provider === p && r.model === model && r.effort === 'medium', JSON.stringify(r));
  check(`Director resolves ${p}`, d.provider === p && d.model === model && d.effort === 'high', JSON.stringify(d));
}
{
  const s = settings({ builder: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high', instructions: '' } });
  const d = resolveDirectorRoleConfig(s);
  check('Director does NOT inherit a Codex Builder provider', d.provider === 'claude-code' && providerOfModel(d.model) === 'claude-code', JSON.stringify(d));
  const r = resolveReviewerRole(s);
  check('Reviewer does NOT inherit the Builder provider', r.provider === 'codex' && r.model === DEFAULT_SETTINGS.roles.reviewer.model);
}
{
  const s = settings({ reviewer: { provider: 'claude-code', model: 'claude-sonnet-5', effort: 'medium', instructions: '', enabled: true } });
  const r = resolveReviewerRole(s), b = resolveBuilderRole(s);
  check('Reviewer = Claude Code / Sonnet 5 resolves through the registry', r.provider === 'claude-code' && r.model === 'claude-sonnet-5' && providerRegistry.get(r.provider).descriptor.label === 'Claude Code CLI');
  check('…and the Builder is untouched by it', b.provider === 'claude-code' && b.model === DEFAULT_SETTINGS.roles.builder.model);
}
{
  const legacy = settings({ builder: { provider: 'nope' as any, model: 'claude-opus-5', effort: 'high', instructions: '' } });
  check('an unknown stored provider falls back to the historical one', resolveBuilderRole(legacy).provider === 'claude-code');
  const swapped = settings({ reviewer: { provider: 'claude-code', model: 'gpt-5.6-sol', effort: 'high', instructions: '', enabled: true } });
  const r = resolveReviewerRole(swapped);
  check('a model from the other backend is replaced by the provider default on read', r.provider === 'claude-code' && r.model === claude.descriptor.defaultModel, JSON.stringify(r));
}

console.log('--- provider/model validation');
check('codex + gpt model ok', validateProviderModel('codex', 'gpt-5.6-sol').ok);
check('claude-code-cli alias + claude model ok', validateProviderModel('claude-code-cli', 'claude-opus-5').ok);
check('codex + claude model refused', !validateProviderModel('codex', 'claude-opus-5').ok);
check('claude + gpt model refused', !validateProviderModel('claude-code', 'gpt-5.6-terra').ok);
check('unknown provider refused', !validateProviderModel('openrouter', 'anything').ok);
check('unfamiliar model on its own provider accepted', validateProviderModel('codex', 'gpt-7-preview').ok);
check('settings PUT refuses cross-provider pair', /not a model/.test(validateRoleConfigs({ roles: { builder: { provider: 'codex', model: 'claude-opus-5' } } } as any) ?? ''));
check('settings PUT refuses unknown provider', /Unknown AI provider/.test(validateRoleConfigs({ roles: { director: { provider: 'anthropic-api', model: 'x' } } } as any) ?? ''));
check('settings PUT accepts a valid director change', validateRoleConfigs({ roles: { director: { provider: 'codex', model: 'gpt-5.6-sol' } } } as any) === null);

console.log('--- sessions never cross providers');
const claudeSess = { provider: 'claude-code' as const, id: 'sess-claude-1' };
const codexSess = { provider: 'codex' as const, id: 'thread-codex-1' };
check('Claude session resumes on Claude', resumableSession(claudeSess, 'claude-code').session?.id === 'sess-claude-1');
check('Codex session resumes on Codex', resumableSession(codexSess, 'codex').session?.id === 'thread-codex-1');
check('switching Claude → Codex does NOT reuse the Claude session', resumableSession(claudeSess, 'codex').session === undefined && resumableSession(claudeSess, 'codex').switchedFrom === 'claude-code');
check('switching Codex → Claude does NOT reuse the Codex session', resumableSession(codexSess, 'claude-code').session === undefined && resumableSession(codexSess, 'claude-code').switchedFrom === 'codex');
check('no stored session → no resume, no switch note', JSON.stringify(resumableSession(null, 'codex')) === '{}');

console.log('--- role policy is separate from provider');
const b = policyFor('builder'), r = policyFor('reviewer'), d = policyFor('director');
check('Builder writes, has workdir tools, no director tools', b.filesystem === 'read-write' && b.workdirTools && !b.directorTools);
check('Reviewer is read-only with no workdir tools', r.filesystem === 'read-only' && !r.workdirTools && r.browserTools);
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

console.log(bad ? `\n${bad} FAILED` : '\nALL PROVIDER UNIT CHECKS PASSED');
process.exit(bad ? 1 : 0);
