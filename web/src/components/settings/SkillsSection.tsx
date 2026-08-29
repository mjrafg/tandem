import { GraduationCap, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RoleName, Skill } from '@shared/types';
import { api } from '../../api';
import { useStore } from '../../store';
import { Field, Modal, Spinner, Toggle } from '../ui';

/**
 * Skills — named instruction sets appended to a role's system text when
 * enabled. They teach the AI how and when to use capabilities (including
 * integration tools) without hardwiring any vendor: a skill refers to
 * capabilities in plain language, so swapping the integration behind them
 * doesn't require rewriting the skill.
 */
export function SkillsSection() {
  const toast = useStore((s) => s.toast);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [editing, setEditing] = useState<Skill | 'new' | null>(null);

  useEffect(() => { api.skills().then(setSkills).catch(() => setSkills([])); }, []);

  async function persist(next: Skill[]) {
    try {
      const res = await api.saveSkills(next);
      setSkills(res.skills);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    }
  }

  if (!skills) return <div className="card flex justify-center px-4 py-6"><Spinner size={16} /></div>;

  return (
    <div className="card px-4 py-3.5">
      <p className="mb-3 text-[12px] leading-relaxed text-dim">
        Named instruction sets appended to a role's system prompt when enabled — e.g. a deployment skill describing
        how to combine DNS, server, and browser tools. Skills reference capabilities in plain language, never
        credentials, so the integration behind a capability can change without rewriting the skill.
      </p>
      {skills.length === 0 && <p className="mb-2 text-[12.5px] text-dim">No skills yet.</p>}
      <div className="space-y-1">
        {skills.map((s) => (
          <div key={s.id} className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-bg2">
            <GraduationCap size={14} className="shrink-0 text-dim" />
            <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(s)}>
              <span className="block truncate text-[13px] hover:text-accent">{s.name}</span>
              <span className="block truncate text-[11px] text-dim">{s.description || `${s.instructions.slice(0, 80)}…`}</span>
            </button>
            <span className="shrink-0 text-[11px] text-dim">{s.roles.join(' + ') || 'no roles'}</span>
            <Toggle checked={s.enabled} onChange={(v) => void persist(skills.map((x) => (x.id === s.id ? { ...x, enabled: v } : x)))} label={`${s.name} enabled`} />
            <button
              className="shrink-0 rounded p-1 text-dim opacity-0 transition-opacity hover:bg-bg3 hover:text-err group-hover:opacity-100"
              onClick={() => { if (confirm(`Delete the skill "${s.name}"?`)) void persist(skills.filter((x) => x.id !== s.id)); }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <button className="btn-outline mt-3" onClick={() => setEditing('new')}><Plus size={14} /> Add skill</button>
      {editing && (
        <SkillModal
          skill={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(s) => {
            const next = editing === 'new' ? [...skills, s] : skills.map((x) => (x.id === s.id ? s : x));
            void persist(next);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function SkillModal({ skill, onClose, onSave }: { skill: Skill | null; onClose: () => void; onSave: (s: Skill) => void }) {
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [instructions, setInstructions] = useState(skill?.instructions ?? '');
  const [roles, setRoles] = useState<RoleName[]>(skill?.roles ?? ['builder']);

  const toggleRole = (r: RoleName) => setRoles((rs) => (rs.includes(r) ? rs.filter((x) => x !== r) : [...rs, r]));

  return (
    <Modal
      open
      onClose={onClose}
      title={skill ? `Skill — ${skill.name}` : 'New skill'}
      width={620}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!name.trim() || !instructions.trim()}
            onClick={() => onSave({
              id: skill?.id ?? crypto.randomUUID(),
              name: name.trim(), description: description.trim(), instructions,
              enabled: skill?.enabled ?? true, roles, updatedAt: Date.now(),
            })}
          >
            Save skill
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Deployment" /></Field>
          <Field label="Applies to">
            <div className="flex h-[34px] items-center gap-4">
              {(['builder', 'reviewer'] as RoleName[]).map((r) => (
                <label key={r} className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-mut">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-[#6e9bff]" checked={roles.includes(r)} onChange={() => toggleRole(r)} />
                  {r === 'builder' ? 'Builder' : 'Reviewer'}
                </label>
              ))}
            </div>
          </Field>
        </div>
        <Field label="Short description" hint="shown in this list only">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="How to publish a site end to end" />
        </Field>
        <Field label="Instructions" hint="appended verbatim to the role's system prompt">
          <textarea
            className="input mono min-h-[180px] resize-y text-[12.5px] leading-relaxed"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder={'When asked to publish a site:\n1. Use the DNS management tools to point the record…\n2. Use the remote server tools to place files…\n3. Verify with the browser.'}
          />
        </Field>
      </div>
    </Modal>
  );
}
