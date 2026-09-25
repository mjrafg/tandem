import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Integration, VideoConfig } from '@shared/types';
import { api } from '../../../api';
import { Field, SelectBox, Spinner } from '../../ui';
import { PageHeader } from '../SettingsLayout';
import { useSettingsDraft } from '../useSettingsDraft';

/**
 * Admin → Video production. The rules themselves (no paid work before
 * approval, narration before timing, reuse before generation) are enforced in
 * code; this page only says which tools they apply to and how estimates are
 * priced.
 */
export function VideoPage() {
  const { draft, set } = useSettingsDraft();
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  useEffect(() => { api.integrations().then(setIntegrations).catch(() => setIntegrations([])); }, []);
  if (!draft?.video) return <div className="flex justify-center py-16"><Spinner size={18} /></div>;
  const v = draft.video;
  const update = (fn: (v: VideoConfig) => void) => set((d) => { fn(d.video); });
  const lines = (list: string[]) => list.join('\n');
  const parse = (text: string) => text.split('\n').map((t) => t.trim()).filter(Boolean);
  const money = (x: string) => Math.max(0, Number(x) || 0);

  return (
    <>
      <PageHeader title="Video production">
        Video projects run on channels, the Director and the video agents. These settings say which integration is the Video
        Engine, which tools cost money or set visual timing, and the rates cost estimates use. The production rules are enforced in
        code whatever the agents are told.
      </PageHeader>

      <div className="space-y-3">
        <section className="card space-y-3.5 px-4 py-4">
          <Field label="Video Engine integration" hint="its production-asset library is provided by Tandem">
            <SelectBox
              ariaLabel="Video Engine integration"
              value={v.engineIntegration}
              onChange={(slug) => update((x) => { x.engineIntegration = slug; })}
              options={[
                ...(integrations ?? []).filter((i) => i.type === 'mcp').map((i) => ({ value: i.slug, label: `${i.name} (${i.slug})` })),
                ...((integrations ?? []).some((i) => i.slug === v.engineIntegration) ? [] : [{ value: v.engineIntegration, label: `${v.engineIntegration} (not installed)` }]),
              ]}
            />
          </Field>
          <p className="text-[12px] leading-relaxed text-dim">
            Add or configure the engine under <Link className="text-accent hover:underline" to="/settings/integrations">Integrations</Link>.
            Tandem gives it a read-only library called <span className="mono">tandem</span> holding production assets only.
          </p>
        </section>

        <section className="card px-4 py-4">
          <h2 className="mb-3 text-[13px] font-semibold">Rates for estimates</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Image · Codex" hint="$ per image — runs on the subscription">
              <input type="number" step="0.01" min="0" className="input tabular-nums" value={v.rates.imageUsd.codex} onChange={(e) => update((x) => { x.rates.imageUsd.codex = money(e.target.value); })} />
            </Field>
            <Field label="Image · OpenAI Images API" hint="$ per image">
              <input type="number" step="0.01" min="0" className="input tabular-nums" value={v.rates.imageUsd.openai} onChange={(e) => update((x) => { x.rates.imageUsd.openai = money(e.target.value); })} />
            </Field>
            <Field label="Narration" hint="$ per 1,000 characters">
              <input type="number" step="0.01" min="0" className="input tabular-nums" value={v.rates.ttsUsdPer1kChars} onChange={(e) => update((x) => { x.rates.ttsUsdPer1kChars = money(e.target.value); })} />
            </Field>
            <Field label="Other paid call" hint="$ per call">
              <input type="number" step="0.01" min="0" className="input tabular-nums" value={v.rates.otherPaidUsd} onChange={(e) => update((x) => { x.rates.otherPaidUsd = money(e.target.value); })} />
            </Field>
          </div>
          <p className="mt-2 text-[12px] text-dim">Estimates are labelled as estimates; set these to your plans' real prices for useful budgets.</p>
        </section>

        <section className="card px-4 py-4">
          <h2 className="mb-3 text-[13px] font-semibold">Which tools the rules apply to</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Paid tools" hint="patterns on the tool's full name, one per line">
              <textarea className="input mono min-h-[120px] text-[12px]" defaultValue={lines(v.paidToolPatterns)} onBlur={(e) => update((x) => { x.paidToolPatterns = parse(e.target.value); })} />
            </Field>
            <Field label="…of which narration (TTS)" hint="priced per character">
              <textarea className="input mono min-h-[120px] text-[12px]" defaultValue={lines(v.ttsToolPatterns)} onBlur={(e) => update((x) => { x.ttsToolPatterns = parse(e.target.value); })} />
            </Field>
            <Field label="Timing tools" hint="engine tools blocked until narration is locked">
              <textarea className="input mono min-h-[88px] text-[12px]" defaultValue={lines(v.timingTools)} onBlur={(e) => update((x) => { x.timingTools = parse(e.target.value); })} />
            </Field>
            <Field label="Reviewer engine tools" hint="read-only tools a Reviewer may inspect with">
              <textarea className="input mono min-h-[88px] text-[12px]" defaultValue={lines(v.reviewerEngineTools)} onBlur={(e) => update((x) => { x.reviewerEngineTools = parse(e.target.value); })} />
            </Field>
          </div>
        </section>
      </div>
    </>
  );
}
