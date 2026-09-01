import { useState } from 'react';
import { api } from '../../../api';
import { useStore } from '../../../store';
import { Field, Spinner, Toggle } from '../../ui';
import { PageHeader } from '../SettingsLayout';
import { useSettingsDraft } from '../useSettingsDraft';
import { PromptsSection } from '../PromptsSection';
import { SkillsSection } from '../SkillsSection';
import { ToolsSection } from '../ToolsSection';
import { IntegrationsSection } from '../IntegrationsSection';
import { CredentialsSection } from '../CredentialsSection';

/** Everything textual Tandem sends: the built-in registry, plus optional skills. */
export function InstructionsPage() {
  return (
    <>
      <PageHeader title="Prompts & Skills">
        Every built-in instruction Tandem sends is editable here, and skills are named instruction sets appended to a
        role&apos;s prompt when enabled.
      </PageHeader>
      <PromptsSection />
      <h2 className="mb-2.5 mt-7 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-dim">Skills</h2>
      <SkillsSection />
    </>
  );
}

export function ToolsPage() {
  return (
    <>
      <PageHeader title="Tools">
        How each tool is described to the AI. Descriptions are the contract the model reads before calling a tool —
        Tandem&apos;s own enforcement never depends on this wording.
      </PageHeader>
      <ToolsSection />
    </>
  );
}

export function IntegrationsPage() {
  return (
    <>
      <PageHeader title="Integrations">
        External capabilities served to the AI as tools, and the credentials that authenticate them. Secrets are stored
        server-side and never reach a prompt.
      </PageHeader>
      <IntegrationsSection />
      <h2 className="mb-2.5 mt-7 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-dim">Credentials</h2>
      <CredentialsSection />
    </>
  );
}

export function ContextPage() {
  const { draft, set } = useSettingsDraft();
  if (!draft) return <div className="flex justify-center py-16"><Spinner size={18} /></div>;

  return (
    <>
      <PageHeader title="Context">
        Thresholds are percentages of the provider&apos;s reported context window — Tandem has no fixed limit of its own.
        Compaction is provider-native: the CLI that owns a session compacts its own context.
      </PageHeader>

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
            <p className="text-[12px] leading-relaxed text-dim">Ask the session&apos;s provider to compact natively once the threshold is crossed. Off by default — you stay in control.</p>
          </div>
          <Toggle checked={draft.context.autoCompact} onChange={(v) => set((d) => { d.context.autoCompact = v; })} label="Automatic compaction" />
        </div>
      </div>

    </>
  );
}

function Num({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return <input type="number" className="input tabular-nums" value={value} onChange={(e) => onChange(Number(e.target.value))} />;
}

export function AccountPage() {
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
    <>
      <PageHeader title="Account">
        Signed in as <b className="text-ink">{email}</b> · single-user workspace.
      </PageHeader>

      <div className="card px-4 py-4">
        <div className="mb-3 text-[13px] font-medium">Change password</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Current password"><input type="password" autoComplete="current-password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
          <Field label="New password" hint="min 8 chars"><input type="password" autoComplete="new-password" className="input" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          <Field label="Repeat new password"><input type="password" autoComplete="new-password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        </div>
        <button className="btn-outline mt-3" disabled={!current || next.length < 8 || pending} onClick={() => void change()}>
          {pending ? <Spinner size={13} /> : 'Change password'}
        </button>
      </div>

      <h2 className="mb-2.5 mt-7 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-dim">About</h2>
      <div className="card px-4 py-3.5 text-[12.5px] leading-relaxed text-mut">
        <p><b className="text-ink">Tandem</b> v0.2 — real engine.</p>
        <p className="mt-1">
          Builder runs on the authenticated Claude Code CLI with full agency; the Reviewer runs on the Codex CLI with
          network access and the tools you grant it, inside a Tandem-enforced read-only jail (bubblewrap) where the
          project, Tandem&apos;s code and its database cannot be written — so it can verify with real tools without being
          able to change anything. Context compaction is provider-native. Every prompt and tool description Tandem sends
          is editable in Admin, and every actual request is recorded in the chat timeline.
        </p>
      </div>
    </>
  );
}
