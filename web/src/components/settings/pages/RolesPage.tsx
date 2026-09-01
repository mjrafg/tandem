import { Eye } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AppSettings, Effort, Provider, RoleConfig, RoleName } from '@shared/types';
import { CLAUDE_MODELS, CODEX_MODELS, EFFORTS } from '@shared/types';
import { api } from '../../../api';
import { Field, Modal, SelectBox, Spinner, Toggle } from '../../ui';
import { PageHeader } from '../SettingsLayout';
import { useSettingsDraft } from '../useSettingsDraft';

// one registry for every model selector in the app (shared/types.ts), so the
// role cards and Builder Agents can never drift apart
const MODEL_SUGGESTIONS: Record<Provider, readonly string[]> = { 'claude-code': CLAUDE_MODELS, codex: CODEX_MODELS };

// TODO(provider-swap): provider selection is intentionally disabled — the
// execution layer only implements Builder = Claude Code and Reviewer = Codex
// (dispatch, resume/compaction, and MCP wiring are per-provider and not yet
// interchangeable). The server locks stored settings to the same pair
// (settings.ts lockProviders). Show a fixed label until real provider-aware
// dispatch exists, so the UI never implies cross-provider execution works.
const FIXED_PROVIDER: Record<RoleName, Provider> = { builder: 'claude-code', reviewer: 'codex' };
const PROVIDER_LABEL: Record<Provider, string> = { 'claude-code': 'Claude Code CLI', codex: 'Codex CLI' };

const ROLE_INFO: Record<RoleName, { title: string; blurb: string; dot: string }> = {
  builder: {
    title: 'Builder',
    blurb: 'Does the actual work — investigates, edits, runs, verifies. These settings drive ordinary chats; Project Director sessions run on the Builder Agent the Director assigns.',
    dot: 'bg-builder',
  },
  reviewer: {
    title: 'Reviewer',
    blurb: 'Independently evaluates each result against your request — changed files when there are any, otherwise the answer itself. Verifies with its own tools inside a read-only jail; max two rounds.',
    dot: 'bg-reviewer',
  },
};

export function RolesPage() {
  const { draft, set } = useSettingsDraft();
  const [promptRole, setPromptRole] = useState<string | null>(null);

  if (!draft) return <div className="flex justify-center py-16"><Spinner size={18} /></div>;

  return (
    <>
      <PageHeader title="Roles">
        The three AI roles and the defaults they run on. Each role&apos;s CLI is fixed to the one Tandem actually
        executes; model, reasoning effort and extra instructions are yours.
      </PageHeader>

      <div className="space-y-3">
        {(Object.keys(ROLE_INFO) as RoleName[]).map((role) => (
          <RoleCard
            key={role}
            role={role}
            cfg={draft.roles[role]}
            onChange={(patch) => set((d) => Object.assign(d.roles[role], patch))}
            onPreview={() => setPromptRole(role)}
          />
        ))}

        <DirectorCard
          cfg={draft.roles.director}
          builder={draft.roles.builder}
          onChange={(patch) => set((d) => {
            d.roles.director = { ...(d.roles.director ?? { model: '' }), ...patch };
          })}
          onPreview={() => setPromptRole('director')}
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

function RoleCard({ role, cfg, onChange, onPreview }: {
  role: RoleName;
  cfg: RoleConfig;
  onChange: (patch: Partial<RoleConfig>) => void;
  onPreview: () => void;
}) {
  const info = ROLE_INFO[role];
  return (
    <div className="card px-4 py-3.5">
      <div className="mb-1 flex items-center gap-2">
        <span className={`h-[8px] w-[8px] shrink-0 rounded-full ${info.dot}`} />
        <span className="min-w-0 truncate text-[13.5px] font-semibold">{info.title}</span>
        {role === 'reviewer' && (
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Provider / CLI" hint="fixed">
          <input
            className="input mono text-[12.5px] opacity-60"
            value={PROVIDER_LABEL[FIXED_PROVIDER[role]]}
            disabled
            aria-label={`${info.title} provider (fixed)`}
          />
        </Field>
        <Field label="Model">
          <>
            <input
              className="input mono text-[12.5px]"
              list={`models-${role}`}
              value={cfg.model}
              onChange={(e) => onChange({ model: e.target.value })}
            />
            <datalist id={`models-${role}`}>
              {MODEL_SUGGESTIONS[FIXED_PROVIDER[role]].map((m) => <option key={m} value={m} />)}
            </datalist>
          </>
        </Field>
        <Field label="Reasoning effort">
          <SelectBox
            ariaLabel={`${info.title} effort`}
            value={cfg.effort}
            onChange={(v) => onChange({ effort: v as Effort })}
            options={EFFORTS.map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1) }))}
          />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Additional instructions" hint="appended to the built-in role prompt">
          <textarea
            className="input min-h-[56px] resize-y text-[13px]"
            placeholder={role === 'builder' ? 'e.g. Prefer minimal diffs. Always run the test suite after changes.' : 'e.g. Treat missing tests for changed code as a minor finding.'}
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
 * The Project Director's own model settings. The provider is fixed: the
 * Director runtime depends on the tandem_director MCP tools, Claude session
 * resume/continuity, and the read-only sandbox — all Claude Code.
 */
function DirectorCard({ cfg, builder, onChange, onPreview }: {
  cfg: AppSettings['roles']['director'];
  builder: AppSettings['roles']['builder'];
  onChange: (patch: Partial<{ model: string; effort: Effort }>) => void;
  onPreview: () => void;
}) {
  return (
    <div className="card px-4 py-3.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="h-[8px] w-[8px] shrink-0 rounded-full bg-accent" />
        <span className="min-w-0 truncate text-[13.5px] font-semibold">Director</span>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-dim">
        Plans projects into milestones and orchestrates sessions from the Project Chat, read-only, on its own model.
        The provider is fixed to Claude Code: the Director&apos;s orchestration tools, session continuity, and sandbox
        depend on it.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Provider / CLI" hint="fixed">
          <input className="input mono text-[12.5px] opacity-60" value="Claude Code CLI" disabled aria-label="Director provider (fixed)" />
        </Field>
        <Field label="Model" hint={`empty follows the Builder model${builder.provider !== 'claude-code' ? ' (Builder is Codex → stock Claude model is used instead)' : ''}`}>
          <>
            <input
              className="input mono text-[12.5px]"
              list="models-director"
              placeholder={builder.provider === 'claude-code' ? builder.model : 'claude-opus-5'}
              value={cfg?.model ?? ''}
              onChange={(e) => onChange({ model: e.target.value })}
            />
            <datalist id="models-director">
              {MODEL_SUGGESTIONS['claude-code'].map((m) => <option key={m} value={m} />)}
            </datalist>
          </>
        </Field>
        <Field label="Reasoning effort">
          <SelectBox
            ariaLabel="Director effort"
            value={cfg?.effort ?? builder.effort}
            onChange={(v) => onChange({ effort: v as Effort })}
            options={EFFORTS.map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1) }))}
          />
        </Field>
      </div>
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

  const label = role === 'final_repair' ? 'Final repair' : role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
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
