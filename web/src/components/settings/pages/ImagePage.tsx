import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CredentialMeta, ImageGenConfig, ImageProvider } from '@shared/types';
import { api } from '../../../api';
import { Field, SelectBox, Spinner, Toggle } from '../../ui';
import { PageHeader } from '../SettingsLayout';
import { useSettingsDraft } from '../useSettingsDraft';
import { descriptorFor, useProviders } from '../useProviders';

const FALLBACK: ImageGenConfig = { enabled: true, provider: 'codex', model: '', credentialId: null, quality: 'auto' };

const OPENAI_IMAGE_MODELS = [
  { id: 'gpt-image-2', label: 'GPT Image 2' },
  { id: 'gpt-image-1.5', label: 'GPT Image 1.5' },
  { id: 'gpt-image-1', label: 'GPT Image 1' },
  { id: 'gpt-image-1-mini', label: 'GPT Image 1 mini' },
];

/** Admin → Image generation: which provider and model the Builder's image tool uses. */
export function ImagePage() {
  const { draft, set } = useSettingsDraft();
  const { providers } = useProviders();
  const [creds, setCreds] = useState<CredentialMeta[] | null>(null);

  useEffect(() => {
    api.credentials().then(setCreds).catch(() => setCreds([]));
  }, []);

  if (!draft) return <div className="flex justify-center py-16"><Spinner size={18} /></div>;
  const img = draft.imageGeneration ?? FALLBACK;
  const update = (patch: Partial<ImageGenConfig>) => set((d) => { d.imageGeneration = { ...(d.imageGeneration ?? FALLBACK), ...patch }; });
  const codexModels = descriptorFor(providers, 'codex')?.models ?? [];
  const keyCreds = (creds ?? []).filter((c) => c.type === 'bearer_token' || c.type === 'api_key_header');

  return (
    <>
      <PageHeader title="Image generation">
        The Builder can generate images from a prompt with the <span className="mono text-[12px]">tandem_generate_image</span> tool.
        Every image appears in the chat with a Download button, and can also be saved into the project.
      </PageHeader>

      <div className="card space-y-4 px-4 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">Let the Builder generate images</div>
            <p className="text-[12px] leading-relaxed text-dim">When off, the tool is not offered and the Builder is not told about it.</p>
          </div>
          <Toggle checked={img.enabled} onChange={(v) => update({ enabled: v })} label="Let the Builder generate images" />
        </div>

        <div className={`grid grid-cols-1 gap-x-5 gap-y-3.5 border-t border-linesoft pt-3.5 sm:grid-cols-2 ${img.enabled ? '' : 'opacity-60'}`}>
          <Field label="Provider">
            <SelectBox
              ariaLabel="Image provider"
              value={img.provider}
              onChange={(v) => update({ provider: v as ImageProvider, model: v === 'openai' ? 'gpt-image-2' : '' })}
              options={[
                { value: 'codex', label: 'Codex (your Codex sign-in)' },
                { value: 'openai', label: 'OpenAI Images API (API key)' },
              ]}
            />
          </Field>

          <Field label="Model" hint={img.provider === 'codex' ? 'the Codex model that calls its image tool' : 'the image model'}>
            <>
              <input
                className="input mono text-[12.5px]"
                list="image-models"
                value={img.model}
                placeholder={img.provider === 'codex' ? 'Codex default' : 'gpt-image-2'}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="Image model"
                onChange={(e) => update({ model: e.target.value })}
              />
              <datalist id="image-models">
                {(img.provider === 'codex' ? codexModels : OPENAI_IMAGE_MODELS).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </datalist>
            </>
          </Field>

          {img.provider === 'openai' && (
            <>
              <Field label="API key" hint="a stored credential">
                <SelectBox
                  ariaLabel="Image API key"
                  value={img.credentialId ?? ''}
                  onChange={(v) => update({ credentialId: v || null })}
                  options={[
                    { value: '', label: creds === null ? 'Loading…' : 'Choose a credential' },
                    ...keyCreds.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />
              </Field>
              <Field label="Quality">
                <SelectBox
                  ariaLabel="Image quality"
                  value={img.quality}
                  onChange={(v) => update({ quality: v as ImageGenConfig['quality'] })}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'low', label: 'Low' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'high', label: 'High' },
                  ]}
                />
              </Field>
            </>
          )}
        </div>

        <p className="border-t border-linesoft pt-3.5 text-[12px] leading-relaxed text-dim">
          {img.provider === 'codex' ? (
            <>Codex generates with its built-in image tool on the Codex sign-in you already have (see <Link className="text-accent hover:underline" to="/settings/providers">Provider sign-in</Link>), so there is no key to add. Images count against your Codex usage.</>
          ) : (
            <>Add your OpenAI API key under <Link className="text-accent hover:underline" to="/settings/integrations">Integrations → Credentials</Link> as a bearer token, then choose it here. Images are billed to that API account.</>
          )}
        </p>
        {img.provider === 'openai' && creds !== null && keyCreds.length === 0 && (
          <p className="rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[12.5px] text-warn">
            No API-key credential exists yet, so the Builder cannot generate images with this provider.
          </p>
        )}
      </div>
    </>
  );
}
