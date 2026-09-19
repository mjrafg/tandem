import { Eye } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AppSettings, ConfigurableRole, Effort, Provider, ProviderDescriptor, RoleConfig } from '@shared/types';
import { EFFORTS } from '@shared/types';
import { api } from '../../../api';
import { Field, Modal, SelectBox, Spinner, Toggle } from '../../ui';
import { PageHeader } from '../SettingsLayout';
import { useSettingsDraft } from '../useSettingsDraft';
import { descriptorFor, modelForProvider, providerOptions, useProviders } from '../useProviders';

// Provider, model and effort are chosen per role, and each role resolves on
// its own: the Reviewer does not follow the Builder's backend and the Director
// does not follow anyone's. The provider list and each provider's models come
// from the server's registry (/api/providers); nothing here knows a model name.

type CardRole = Exclude<ConfigurableRole, 'director'>;

const ROLE_INFO: Record<CardRole, { title: string; blurb: string; dot: string }> = {
  builder: {
    title: 'Builder',
    blurb: 'Does the actual work — investigates, edits, runs, verifies — and OWNS the implementation: Reviewer findings are advice it answers, not orders. These settings drive ordinary chats; Project Director sessions run on the Builder Agent the Director assigns.',
    dot: 'bg-builder',
  },
  builder_reviewer: {
    title: 'Builder Reviewer',
    blurb: 'Independently verifies each session result and reports defects with evidence. Advisory: the Builder answers each finding, the Director arbitrates disagreements. Two rounds at most — round 2 looks for new problems and failed repairs, never re-argues settled ones.',
    dot: 'bg-reviewer',
  },
  director_reviewer: {
    title: 'Director Reviewer',
    blurb: 'Independently reviews the Project Director\'s own decisions — the master plan, replanning, significant recovery. A separate role with its own configuration: it never inherits from the Builder Reviewer, and it does not arbitrate sessions.',
    dot: 'bg-reviewer',
  },
};

export function RolesPage() {
  const { draft, set } = useSettingsDraft();
  const [promptRole, setPromptRole] = useState<string | null>(null);
  const { providers, error: providerError } = useProviders();

  if (!draft) return <div className="flex justify-center py-16"><Spinner size={18} /></div>;

  return (
    <>
      <PageHeader title="Roles">
        Four AI roles, each on its own provider, model and reasoning effort — chosen independently, so changing one
        never changes another. Builder owns implementation; Builder Reviewer advises and verifies it; Director
        arbitrates their disagreements and owns delivery; Director Reviewer independently reviews the Director.
      </PageHeader>

      <div className="space-y-3">
        {providerError && (
          <div className="rounded-lg border border-err/30 bg-err/[0.07] px-3 py-2 text-[12.5px] text-err">
            The provider list could not be loaded ({providerError}); the selectors below show stored values only.
          </div>
        )}
        {(['builder', 'builder_reviewer'] as CardRole[]).map((role) => (
          <RoleCard
            key={role}
            role={role}
            cfg={draft.roles[role]}
            providers={providers}
            onChange={(patch) => set((d) => Object.assign(d.roles[role], patch))}
            onPreview={() => setPromptRole(role)}
          />
        ))}

        <DirectorCard
          cfg={draft.roles.director}
          builder={draft.roles.builder}
          providers={providers}
          onChange={(patch) => set((d) => {
            d.roles.director = { ...(d.roles.director ?? { model: '' }), ...patch };
          })}
          onPreview={() => setPromptRole('director')}
        />

        <RoleCard
          role="director_reviewer"
          cfg={draft.roles.director_reviewer}
          providers={providers}
          onChange={(patch) => set((d) => Object.assign(d.roles.director_reviewer, patch))}
          onPreview={() => setPromptRole('director_reviewer')}
        />

        <div className="card px-4 py-3.5">
          <div className="mb-1.5 text-[13.5px] font-semibold">Final repair</div>
          <p className="mb-2.5 text-[12px] leading-relaxed text-dim">
            Extra instructions for the Builder&apos;s last repair round — the one that is never re-reviewed.
          </p>
          <textarea
            className="input min-h-[60px] resize-y text-[13px]"
            placeholder="e.g. Keep the final repair minimal; prefer reverting over rewriting."
            value={draft.finalRepairInstructions}
            onChange={(e) => set((d) => { d.finalRepairInstructions = e.target.value; })}
          />
          <button className="btn-ghost -ml-2 mt-1.5 text-[12px]" onClick={() => setPromptRole('final_repair')}>
            <Eye size={13} /> Preview effective prompt
          </button>
        </div>

        <div className="card px-4 py-3.5">
          <div className="mb-1.5 text-[13.5px] font-semibold">Shared instructions</div>
          <p className="mb-2.5 text-[12px] leading-relaxed text-dim">Included in every role&apos;s prompt.</p>
          <textarea
            className="input min-h-[60px] resize-y text-[13px]"
            placeholder="e.g. Answer in English. Never touch files outside the project directory."
            value={draft.sharedInstructions}
            onChange={(e) => set((d) => { d.sharedInstructions = e.target.value; })}
          />
        </div>

        <p className="px-1 text-[12px] leading-relaxed text-dim">
          Looking for a session&apos;s specialist prompt or model? Those live on each profile in{' '}
          <Link to="/settings/agents" className="text-accent hover:underline">Builder Agents</Link>.
        </p>
      </div>

      <PromptPreviewModal role={promptRole} onClose={() => setPromptRole(null)} />
    </>
  );
}

function RoleCard({ role, cfg, providers, onChange, onPreview }: {
  role: CardRole;
  cfg: RoleConfig;
  providers: ProviderDescriptor[];
  onChange: (patch: Partial<RoleConfig>) => void;
  onPreview: () => void;
}) {
  const info = ROLE_INFO[role];
  return (
    <div className="card px-4 py-3.5">
      <div className="mb-1 flex items-center gap-2">
        <span className={`h-[8px] w-[8px] shrink-0 rounded-full ${info.dot}`} />
        <span className="min-w-0 truncate text-[13.5px] font-semibold">{info.title}</span>
        {role === 'builder_reviewer' && (
          <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-3">
            <button
              type="button"
              className="cursor-pointer select-none whitespace-nowrap text-[12px] text-dim transition-colors hover:text-mut"
              onClick={() => onChange({ enabled: cfg.enabled === false })}
            >
              Review results
            </button>
            <Toggle checked={cfg.enabled !== false} onChange={(v) => onChange({ enabled: v })} label="Reviewer enabled" />
          </span>
        )}
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-dim">{info.blurb}</p>
      <ProviderModelEffort
        role={role}
        label={info.title}
        providers={providers}
        provider={cfg.provider}
        model={cfg.model}
        effort={cfg.effort}
        onChange={onChange}
      />
      <div className="mt-3">
        <Field label="Additional instructions" hint="appended to the built-in role prompt">
          <textarea
            className="input min-h-[56px] resize-y text-[13px]"
            placeholder={role === 'builder' ? 'e.g. Prefer minimal diffs.' : role === 'director_reviewer' ? 'e.g. Flag any milestone without a testable acceptance criterion.' : 'e.g. Treat missing tests for changed code as a minor finding.'}
            value={cfg.instructions}
            onChange={(e) => onChange({ instructions: e.target.value })}
          />
        </Field>
      </div>
      <button className="btn-ghost -ml-2 mt-1.5 text-[12px]" onClick={onPreview}>
        <Eye size={13} /> Preview effective prompt
      </button>
    </div>
  );
}

/**
 * The three selectors every role shares. Changing the provider re-points the
 * model at one that provider knows (the same name if it has it, otherwise its
 * default), so the form can never submit a pair the server would refuse.
 */
function ProviderModelEffort({ role, label, providers, provider, model, effort, modelHint, modelPlaceholder, onChange }: {
  role: ConfigurableRole;
  label: string;
  providers: ProviderDescriptor[];
  provider: Provider;
  model: string;
  effort: Effort;
  modelHint?: string;
  modelPlaceholder?: string;
  onChange: (patch: { provider?: Provider; model?: string; effort?: Effort }) => void;
}) {
  const options = providerOptions(providers, role);
  const desc = descriptorFor(providers, provider);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Field label="Provider">
        <SelectBox
          ariaLabel={`${label} provider`}
          value={provider}
          onChange={(v) => onChange({ provider: v as Provider, model: modelForProvider(providers, v, model) })}
          options={options.length > 0 ? options : [{ value: provider, label: provider }]}
        />
      </Field>
      <Field label="Model" hint={modelHint}>
        <>
          <input
            className="input mono text-[12.5px]"
            list={`models-${role}`}
            value={model}
            placeholder={modelPlaceholder ?? desc?.defaultModel ?? ''}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={`${label} model`}
            onChange={(e) => onChange({ model: e.target.value })}
          />
          <datalist id={`models-${role}`}>
            {(desc?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </datalist>
        </>
      </Field>
      <Field label="Reasoning effort">
        <SelectBox
          ariaLabel={`${label} effort`}
          value={effort}
          onChange={(v) => onChange({ effort: v as Effort })}
          options={EFFORTS.map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1) }))}
        />
      </Field>
    </div>
  );
}

/**
 * The Project Director's own configuration. It resolves independently of the
 * Builder: its provider is its own choice, and an empty model follows the
 * Builder's only when both run on the same provider.
 */
function DirectorCard({ cfg, builder, providers, onChange, onPreview }: {
  cfg: AppSettings['roles']['director'];
  builder: AppSettings['roles']['builder'];
  providers: ProviderDescriptor[];
  onChange: (patch: Partial<{ provider: Provider; model: string; effort: Effort }>) => void;
  onPreview: () => void;
}) {
  const provider: Provider = cfg?.provider ?? 'claude-code';
  const sameAsBuilder = builder.provider === provider;
  const fallback = sameAsBuilder ? builder.model : (descriptorFor(providers, provider)?.defaultModel ?? '');
  return (
    <div className="card px-4 py-3.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="h-[8px] w-[8px] shrink-0 rounded-full bg-accent" />
        <span className="min-w-0 truncate text-[13.5px] font-semibold">Director</span>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-dim">
        Plans projects into milestones and orchestrates sessions from the Project Chat, read-only, on its own provider
        and model — never inherited from the Builder.
      </p>
      <ProviderModelEffort
        role="director"
        label="Director"
        providers={providers}
        provider={provider}
        model={cfg?.model ?? ''}
        effort={cfg?.effort ?? builder.effort}
        modelHint={sameAsBuilder ? 'empty follows the Builder model' : `empty uses the provider default (${fallback})`}
        modelPlaceholder={fallback}
        onChange={(patch) => onChange({ ...patch, ...(patch.provider && !cfg?.model ? { model: '' } : {}) })}
      />
      <button className="btn-ghost -ml-2 mt-1.5 text-[12px]" onClick={onPreview}>
        <Eye size={13} /> Preview effective prompt
      </button>
    </div>
  );
}

export function PromptPreviewModal({ role, onClose }: { role: string | null; onClose: () => void }) {
  const [prompt, setPrompt] = useState<string | null>(null);

  useEffect(() => {
    if (!role) {
      setPrompt(null);
      return;
    }
    let cancelled = false;
    api.effectivePrompt(role).then((r) => { if (!cancelled) setPrompt(r.prompt); }).catch(() => { if (!cancelled) setPrompt('Failed to load.'); });
    return () => { cancelled = true; };
  }, [role]);

  const label = role === 'final_repair' ? 'Final repair' : role === 'builder_reviewer' ? 'Builder Reviewer' : role === 'director_reviewer' ? 'Director Reviewer' : role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
  return (
    <Modal open={!!role} onClose={onClose} title={`Effective prompt — ${label}`} width={640}>
      {prompt == null ? (
        <div className="flex justify-center py-8"><Spinner size={16} /></div>
      ) : (
        <>
          <pre className="mono max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-linesoft bg-bg0 px-3.5 py-3 text-[12px] leading-[1.6] text-[#c3c9d4]">{prompt}</pre>
          <p className="mt-2 text-[11.5px] leading-snug text-dim">
            This is exactly what the application will assemble for this role — built-in instructions, your Admin additions,
            and the live context appended at call time. No hidden layers.
          </p>
        </>
      )}
    </Modal>
  );
}
