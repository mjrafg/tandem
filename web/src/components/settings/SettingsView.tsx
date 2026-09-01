import { ArrowLeft, Eye } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AppSettings, Effort, Provider, RoleConfig, RoleName } from '@shared/types';
import { CLAUDE_MODELS, CODEX_MODELS } from '@shared/types';
import { api } from '../../api';
import { useStore } from '../../store';
import { Field, MenuButton, Modal, SelectBox, Spinner, Toggle } from '../ui';
import { AgentsSection } from './AgentsSection';
import { CredentialsSection } from './CredentialsSection';
import { IntegrationsSection } from './IntegrationsSection';
import { PromptsSection } from './PromptsSection';
import { SkillsSection } from './SkillsSection';
import { ToolsSection } from './ToolsSection';

// one registry for every model selector in the app (shared/types.ts), so the
// Roles card, the Director card and Builder Agents can never drift apart
const MODEL_SUGGESTIONS: Record<Provider, readonly string[]> = {
  'claude-code': CLAUDE_MODELS,
  codex: CODEX_MODELS,
};

// TODO(provider-swap): provider selection is intentionally disabled — the
// execution layer only implements Builder = Claude Code and Reviewer = Codex
// (dispatch, resume/compaction, and MCP wiring are per-provider and not yet
// interchangeable). The server locks stored settings to the same pair
// (settings.ts lockProviders). Show a fixed label until real provider-aware
// dispatch exists, so the UI never implies cross-provider execution works.
const FIXED_PROVIDER: Record<RoleName, Provider> = { builder: 'claude-code', reviewer: 'codex' };
const PROVIDER_LABEL: Record<Provider, string> = { 'claude-code': 'Claude Code CLI', codex: 'Codex CLI' };

const ROLE_INFO: Record<RoleName, { title: string; blurb: string; dot: string }> = {
  builder: { title: 'Builder', blurb: 'Understands each request and does the actual work — investigates, edits, runs, verifies. These settings drive ordinary chats; Project Director sessions use the Builder Agent the Director selects (see Builder Agents below).', dot: 'bg-builder' },
  reviewer: { title: 'Reviewer', blurb: 'Independently evaluates each result against your request — changed files when there are any, otherwise the answer itself. Verifies with its own tools inside a read-only jail; max two rounds.', dot: 'bg-reviewer' },
};

export function SettingsView() {
  const settings = useStore((s) => s.settings);
  const loadSettings = useStore((s) => s.loadSettings);
  const toast = useStore((s) => s.toast);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [promptRole, setPromptRole] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) void loadSettings();
  }, [settings, loadSettings]);

  useEffect(() => {
    if (settings) setDraft(structuredClone(settings));
  }, [settings]);

  const dirty = useMemo(() => !!settings && !!draft && JSON.stringify(settings) !== JSON.stringify(draft), [settings, draft]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await api.saveSettings(draft);
      useStore.setState({ settings: saved });
      toast('Settings saved');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!draft) {
    return <div className="flex flex-1 items-center justify-center"><Spinner size={20} /></div>;
  }

  const set = (fn: (d: AppSettings) => void) => {
    setDraft((d) => {
      if (!d) return d;
      const copy = structuredClone(d);
      fn(copy);
      return copy;
    });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[780px] px-4 pb-28 pt-5 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <MenuButton />
          <Link to="/" className="btn-ghost -ml-2 px-2"><ArrowLeft size={16} /></Link>
          <div>
            <h1 className="text-[17px] font-semibold">Admin</h1>
            <p className="text-[12.5px] text-dim">Providers, models, instructions and context behavior — no code edits required.</p>
          </div>
        </div>

        {/* ------------------------------------------------ roles */}
        <SectionTitle>Roles</SectionTitle>
        <div className="space-y-4">
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
              d.roles.director = { model: d.roles.director?.model ?? '', effort: d.roles.director?.effort ?? d.roles.builder.effort, ...patch };
            })}
            onPreview={() => setPromptRole('director')}
          />

          <div className="card px-4 py-3.5">
            <div className="mb-2 text-[13.5px] font-semibold">Final repair</div>
            <p className="mb-2.5 text-[12px] leading-relaxed text-dim">
              Extra instructions for the Builder's last repair round — the one that is never re-reviewed.
            </p>
            <textarea
              className="input min-h-[64px] resize-y text-[13px]"
              placeholder="e.g. Keep the final repair minimal; prefer reverting over rewriting."
              value={draft.finalRepairInstructions}
              onChange={(e) => set((d) => { d.finalRepairInstructions = e.target.value; })}
            />
            <button className="btn-ghost -ml-2 mt-1.5 text-[12px]" onClick={() => setPromptRole('final_repair')}>
              <Eye size={13} /> Preview effective prompt
            </button>
          </div>

          <div className="card px-4 py-3.5">
            <div className="mb-2 text-[13.5px] font-semibold">Shared instructions</div>
            <p className="mb-2.5 text-[12px] leading-relaxed text-dim">Included in every role's prompt.</p>
            <textarea
              className="input min-h-[64px] resize-y text-[13px]"
              placeholder="e.g. Answer in English. Never touch files outside the project directory."
              value={draft.sharedInstructions}
              onChange={(e) => set((d) => { d.sharedInstructions = e.target.value; })}
            />
          </div>
        </div>

        {/* ------------------------------------------------ builder agents */}
        <SectionTitle>Builder Agents</SectionTitle>
        <AgentsSection />

        {/* ------------------------------------------------ AI prompts */}
        <SectionTitle>AI Prompts</SectionTitle>
        <PromptsSection />

        {/* ------------------------------------------------ AI tools */}
        <SectionTitle>AI Tools</SectionTitle>
        <ToolsSection />

        {/* ------------------------------------------------ skills */}
        <SectionTitle>Skills</SectionTitle>
        <SkillsSection />

        {/* ------------------------------------------------ integrations */}
        <SectionTitle>Integrations</SectionTitle>
        <IntegrationsSection />

        {/* ------------------------------------------------ credentials */}
        <SectionTitle>Credentials</SectionTitle>
        <CredentialsSection />

        {/* ------------------------------------------------ context */}
        <SectionTitle>Context</SectionTitle>
        <div className="card space-y-4 px-4 py-4">
          <div className="grid grid-cols-1 gap-x-5 gap-y-3.5 sm:grid-cols-2">
            <Field label="Warning threshold" hint="% of provider window"><Num value={draft.context.warnPct} onChange={(v) => set((d) => { d.context.warnPct = v; })} /></Field>
            <Field label="Auto compact at" hint="% of provider window"><Num value={draft.context.compactPct} onChange={(v) => set((d) => { d.context.compactPct = v; })} /></Field>
            <Field label="Critical threshold" hint="% of provider window"><Num value={draft.context.critPct} onChange={(v) => set((d) => { d.context.critPct = v; })} /></Field>
            <Field label="Recent context seeded on a new session" hint="tokens"><Num value={draft.context.preserveRecentTokens} onChange={(v) => set((d) => { d.context.preserveRecentTokens = v; })} /></Field>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-linesoft pt-3.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">Automatic compaction</div>
              <p className="text-[12px] text-dim">Ask the session's provider to compact natively once the threshold is crossed. Off by default — you stay in control.</p>
            </div>
            <Toggle checked={draft.context.autoCompact} onChange={(v) => set((d) => { d.context.autoCompact = v; })} label="Automatic compaction" />
          </div>
          <p className="text-[11.5px] leading-snug text-dim">
            Compaction is provider-native: the CLI that owns the active session (per the Builder's provider above) compacts
            its own context — no separate Compactor model. Thresholds are percentages of the provider's reported context
            window; the meter labels provider-reported values and estimates distinctly, and unknown stays unknown.
          </p>
        </div>

        {/* ------------------------------------------------ account */}
        <SectionTitle>Account</SectionTitle>
        <AccountCard />

        {/* ------------------------------------------------ about */}
        <SectionTitle>About</SectionTitle>
        <div className="card px-4 py-3.5 text-[12.5px] leading-relaxed text-mut">
          <p><b className="text-ink">Tandem</b> v0.2 — real engine.</p>
          <p className="mt-1">
            Builder runs on the authenticated Claude Code CLI with full agency; the Reviewer runs on the Codex CLI with
            network access and the tools you grant it, inside a Tandem-enforced read-only jail (bubblewrap) where the
            project, Tandem's code and its database cannot be written — so it can verify with real tools without being
            able to change anything. Context compaction is provider-native — the session's own CLI compacts its own
            context. Every prompt and tool description Tandem sends is editable above, and every actual request is
            recorded in the chat timeline.
          </p>
        </div>
      </div>

      {dirty && (
        <div className="pointer-events-none sticky bottom-0 z-30 flex justify-center pb-5">
          <div className="pointer-events-auto card flex items-center gap-3 px-4 py-2.5 shadow-2xl shadow-black/50">
            <span className="text-[12.5px] text-mut">Unsaved changes</span>
            <button className="btn-ghost" onClick={() => setDraft(structuredClone(settings!))}>Discard</button>
            <button className="btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size={13} /> : 'Save changes'}
            </button>
          </div>
        </div>
      )}

      <PromptPreviewModal role={promptRole} onClose={() => setPromptRole(null)} />
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2.5 mt-8 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-dim first:mt-0">{children}</h2>;
}

function Num({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      className="input tabular-nums"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
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
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ]}
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
        Plans projects into milestones and orchestrates normal sessions from the Project Chat, read-only, on its own model —
        project sessions keep using the Builder settings. The provider is fixed to Claude Code: the Director&apos;s
        orchestration tools, session continuity, and sandbox depend on it.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Provider / CLI" hint="fixed">
          <input className="input mono text-[12.5px] opacity-60" value="Claude Code CLI" disabled />
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
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ]}
          />
        </Field>
      </div>
      <button className="btn-ghost -ml-2 mt-1.5 text-[12px]" onClick={onPreview}>
        <Eye size={13} /> Preview effective prompt
      </button>
    </div>
  );
}

function AccountCard() {
  const email = useStore((s) => s.email);
  const toast = useStore((s) => s.toast);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);

  async function change() {
    if (next !== confirm) {
      toast('New passwords do not match', 'error');
      return;
    }
    setPending(true);
    try {
      await api.changePassword(current, next);
      toast('Password changed');
      setCurrent(''); setNext(''); setConfirm('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Change failed', 'error');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card px-4 py-4">
      <div className="mb-3 text-[12.5px] text-mut">Signed in as <b className="text-ink">{email}</b> · single-user workspace</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Current password"><input type="password" autoComplete="current-password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" hint="min 8 chars"><input type="password" autoComplete="new-password" className="input" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="Repeat new password"><input type="password" autoComplete="new-password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
      </div>
      <button className="btn-outline mt-3" disabled={!current || next.length < 8 || pending} onClick={() => void change()}>
        {pending ? <Spinner size={13} /> : 'Change password'}
      </button>
    </div>
  );
}

function PromptPreviewModal({ role, onClose }: { role: string | null; onClose: () => void }) {
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
