/**
 * Images from a prompt, for the agents (the tandem_generate_image tool).
 *
 * Two providers, chosen in Admin → Image generation:
 *   - codex (default): the Codex CLI's built-in image tool. It runs on the
 *     Codex sign-in Tandem already has, so there is no key to manage. Codex
 *     writes what it generates under $CODEX_HOME/generated_images/<thread>/,
 *     which is where the image is collected from.
 *   - openai: the OpenAI Images API, with an API key from a stored credential.
 *
 * Either way the result is the same: the image is stored as a shared file (so
 * the chat shows it, with a Download button), and, when the agent names a
 * path, also written into its working directory.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings, ImageGenConfig } from '../../shared/types';
import { config } from './config';
import { db, getChat } from './db';
import { DeliverableError, deliverablePath, getDeliverable, shareBytes, type Deliverable } from './deliverables';
import type { MediaAsset } from '../../shared/types';
import { imageSpendGate, recordPaidOp } from './video/gates';
import { VideoError, assetFilePath, getAsset, videoProjectForChat, visibleAssetIds } from './video/store';
import { addAssets } from './video/tools';
import { credentialSecret } from './integrations/store';
import { BrowseError, cleanRel, projectRoot } from './repoBrowse';

export type ImageShape = 'square' | 'landscape' | 'portrait' | 'auto';

export interface ImageRequest {
  prompt: string;
  shape: ImageShape;
  transparent: boolean;
  /** reference images (absolute paths) that condition identity or style */
  references?: string[];
}

export interface GeneratedImage {
  bytes: Buffer;
  /** png, jpeg or webp — from the bytes, not from what anyone claimed */
  ext: 'png' | 'jpg' | 'webp';
  width: number | null;
  height: number | null;
  provider: ImageGenConfig['provider'];
  model: string;
}

/** Codex's image tool takes a while; stay inside the tool call's own time limits */
const CODEX_TIMEOUT_MS = 270_000;
const OPENAI_TIMEOUT_MS = 240_000;
export const MAX_PROMPT_CHARS = 8_000;

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** what the bytes are, and how big — PNG, JPEG and WebP headers */
function sniff(b: Buffer): { ext: GeneratedImage['ext']; width: number | null; height: number | null } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { ext: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) {
    // walk the markers to the first start-of-frame
    let i = 2;
    while (i + 9 < b.length && b[i] === 0xff) {
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { ext: 'jpg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
    return { ext: 'jpg', width: null, height: null };
  }
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', width: null, height: null };
  return null;
}

// ---------------------------------------------------------------- codex

function codexInstruction(req: ImageRequest): string {
  const shape = {
    square: 'Aspect: square.',
    landscape: 'Aspect: landscape (wider than tall).',
    portrait: 'Aspect: portrait (taller than wide).',
    auto: '',
  }[req.shape];
  return [
    'Generate exactly ONE image with your built-in image generation tool (image_gen), from the specification below.',
    'Do not run shell commands, do not read or write files, and do not ask questions: generate it once, then finish with one short sentence.',
    'Follow the specification faithfully; do not add subjects, text or branding it does not ask for.',
    shape,
    req.transparent ? 'Background: genuinely transparent (preserve the alpha channel).' : '',
    req.references?.length ? `${req.references.length === 1 ? 'The attached image is a REFERENCE' : `The ${req.references.length} attached images are REFERENCES, in the order the specification names them`}: keep the identity, design, proportions, colours and rendering style they show exactly, and change only what the specification asks for.` : '',
    '',
    'Specification:',
    req.prompt,
  ].filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== '')).join('\n');
}

async function generateWithCodex(req: ImageRequest, cfg: ImageGenConfig): Promise<GeneratedImage> {
  const scratch = path.join(config.dataDir, 'tmp', `image-${randomUUID()}`);
  fs.mkdirSync(scratch, { recursive: true });
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only'];
  if (cfg.model) args.push('-m', cfg.model);
  // the image tool does the work; the model only has to call it once
  args.push('-c', 'model_reasoning_effort="low"');
  // -i takes several files and would swallow the prompt: -- ends the list
  for (const ref of req.references ?? []) args.push('-i', ref);
  args.push('--', codexInstruction(req));

  let threadId = '';
  let lastText = '';
  let failure = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(config.codexBin, args, { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      let buf = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new DeliverableError(504, 'Codex took too long to generate the image, so it was stopped.')); }, CODEX_TIMEOUT_MS);
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'thread.started' && ev.thread_id) threadId = String(ev.thread_id);
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) lastText = String(ev.item.text);
          if (ev.type === 'error' && ev.message) failure = String(ev.message);
          if (ev.type === 'turn.failed') failure = String(ev.error?.message ?? failure ?? 'the turn failed');
        }
      });
      child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-2000); });
      child.on('error', (err) => { clearTimeout(timer); reject(new DeliverableError(502, `Codex could not be started: ${err.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new DeliverableError(502, `Codex stopped with an error: ${failure || stderr.trim().split('\n').pop() || `exit ${code}`}`));
      });
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  if (!threadId) throw new DeliverableError(502, 'Codex did not report a session, so its image could not be found.');
  const dir = path.join(codexHome(), 'generated_images', threadId);
  let files: { file: string; mtime: number }[] = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { /* no directory: nothing was generated */ }
  if (files.length === 0) {
    throw new DeliverableError(502, `Codex finished without generating an image${failure ? ` (${failure})` : lastText ? `. It said: ${lastText.slice(0, 300)}` : '.'}`);
  }
  const bytes = fs.readFileSync(files[0].file);
  // the copy Tandem keeps is the one that matters; Codex's own is not needed
  fs.rmSync(dir, { recursive: true, force: true });
  const kind = sniff(bytes);
  if (!kind) throw new DeliverableError(502, 'Codex produced a file that is not a PNG, JPEG or WebP image.');
  return { bytes, ...kind, provider: 'codex', model: cfg.model || 'Codex default' };
}

// ---------------------------------------------------------------- openai

function openaiKey(credentialId: string | null): string {
  const cred = credentialSecret(credentialId);
  if (!cred) throw new DeliverableError(400, 'Image generation is set to the OpenAI Images API, but no API key is selected. Choose a credential in Admin → Image generation.');
  const key = cred.data.token || cred.data.value || '';
  if (!key.trim()) throw new DeliverableError(400, 'The credential chosen for image generation holds no API key (use a bearer token, or an API-key header).');
  return key.trim();
}

function openaiSize(model: string, shape: ImageShape): string {
  if (/^dall-e-3/i.test(model)) return { square: '1024x1024', landscape: '1792x1024', portrait: '1024x1792', auto: '1024x1024' }[shape];
  return { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536', auto: 'auto' }[shape];
}

async function generateWithOpenAI(req: ImageRequest, cfg: ImageGenConfig): Promise<GeneratedImage> {
  const key = openaiKey(cfg.credentialId);
  const model = cfg.model || 'gpt-image-2';
  const dalle = /^dall-e/i.test(model);
  const body: Record<string, unknown> = { model, prompt: req.prompt, n: 1, size: openaiSize(model, req.shape) };
  if (dalle) body.response_format = 'b64_json';
  else {
    if (cfg.quality !== 'auto') body.quality = cfg.quality;
    if (req.transparent) { body.background = 'transparent'; body.output_format = 'png'; }
  }
  const base = (process.env.TANDEM_OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  let res: Response;
  try {
    if (req.references?.length) {
      // references go to the edits endpoint, which conditions on several images
      if (dalle) throw new DeliverableError(400, `${model} cannot use reference images; choose a gpt-image model in Admin → Image generation.`);
      const form = new FormData();
      for (const [k, v] of Object.entries(body)) if (k !== 'n' && v !== undefined) form.append(k, String(v));
      for (const ref of req.references) form.append('image[]', new Blob([new Uint8Array(fs.readFileSync(ref))], { type: 'image/png' }), path.basename(ref));
      res = await fetch(`${base}/images/edits`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS) });
    } else {
      res = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
      });
    }
  } catch (err) {
    if (err instanceof DeliverableError) throw err;
    const reason = (err as Error).name === 'TimeoutError' ? 'it took too long' : (err as Error).message;
    throw new DeliverableError(502, `The OpenAI Images API could not be reached (${reason}).`);
  }
  const json = await res.json().catch(() => ({})) as any;
  if (!res.ok) {
    throw new DeliverableError(502, `The OpenAI Images API refused the request (HTTP ${res.status}): ${json?.error?.message ?? 'no detail'}`);
  }
  const b64 = json?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string') throw new DeliverableError(502, 'The OpenAI Images API returned no image.');
  const bytes = Buffer.from(b64, 'base64');
  const kind = sniff(bytes);
  if (!kind) throw new DeliverableError(502, 'The OpenAI Images API returned something that is not an image.');
  return { bytes, ...kind, provider: 'openai', model };
}

export async function generateImage(req: ImageRequest, settings: AppSettings): Promise<GeneratedImage> {
  const cfg = settings.imageGeneration;
  return cfg.provider === 'openai' ? generateWithOpenAI(req, cfg) : generateWithCodex(req, cfg);
}

// ---------------------------------------------------------------- saving

/** a file name from the prompt, when the agent gave none */
function nameFromPrompt(prompt: string, ext: string): string {
  const words = prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6);
  return `${words.join('-') || 'image'}.${ext}`;
}

/** the name the agent asked for, with the extension the bytes actually have */
function withExt(name: string, ext: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/\.(png|jpe?g|webp|gif)$/i, '');
  return `${base || 'image'}.${ext}`;
}

/**
 * The directory the agent is working in: the one its tool server was started
 * in, accepted only when it belongs to this chat (its project, or the
 * worktree of its Director session).
 */
function workingDir(chatId: string, claimed: unknown): string {
  const chat = getChat(chatId);
  if (!chat) throw new DeliverableError(404, 'This chat does not exist.');
  let root: string;
  try { root = projectRoot(chat.projectId); } catch (err) {
    if (err instanceof BrowseError) throw new DeliverableError(err.status, err.message);
    throw err;
  }
  if (typeof claimed !== 'string' || !claimed.trim()) return root;
  let real: string;
  try { real = fs.realpathSync(claimed); } catch { return root; }
  if (real === root || real.startsWith(root + path.sep)) return real;
  const session = db.prepare('SELECT cwd FROM pd_sessions WHERE chat_id = ? AND cwd IS NOT NULL').all(chatId) as { cwd: string }[];
  for (const s of session) {
    try { if (fs.realpathSync(s.cwd) === real) return real; } catch { /* gone */ }
  }
  return root;
}

/** write the image into the working directory; never over an existing file */
function saveInto(dir: string, rawRel: unknown, ext: string): string {
  let rel: string;
  try { rel = cleanRel(rawRel); } catch (err) {
    if (err instanceof BrowseError) throw new DeliverableError(400, `save_to: ${err.message}`);
    throw err;
  }
  if (!rel) throw new DeliverableError(400, 'save_to names the working directory itself — give a file path, e.g. "assets/hero.png".');
  // keep the name, but the extension must match what was generated
  rel = path.posix.join(path.posix.dirname(rel), withExt(path.posix.basename(rel), ext));
  const target = path.join(dir, rel);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const realParent = fs.realpathSync(parent);
  if (realParent !== dir && !realParent.startsWith(dir + path.sep)) {
    throw new DeliverableError(403, 'save_to leads outside the working directory.');
  }
  if (fs.existsSync(target)) {
    throw new DeliverableError(409, `${rel} already exists. Choose a new name (for example ${rel.replace(/(\.\w+)$/, '-v2$1')}) — generated images never overwrite a file.`);
  }
  fs.writeFileSync(target, new Uint8Array(0), { flag: 'wx' });
  return rel;
}

export interface ImageToolResult {
  deliverable: Deliverable;
  image: GeneratedImage;
  savedTo: string;
  /** the searchable asset it was registered as, if asked */
  asset?: MediaAsset;
  /** an identical earlier generation in this video project was returned instead */
  reused?: boolean;
  /** what it was charged to the video budget */
  costUsd?: number;
}

export async function generateForChat(opts: {
  chatId: string;
  prompt: unknown;
  shape?: unknown;
  transparent?: unknown;
  name?: unknown;
  saveTo?: unknown;
  note?: unknown;
  workdir?: unknown;
  referenceAssetIds?: unknown;
  register?: unknown;
  variant?: unknown;
  role?: string;
  settings: AppSettings;
}): Promise<ImageToolResult> {
  if (!opts.settings.imageGeneration.enabled) throw new DeliverableError(403, 'Image generation is turned off in Admin → Image generation.');
  if (!getChat(opts.chatId)) throw new DeliverableError(404, 'This chat does not exist.');
  const prompt = typeof opts.prompt === 'string' ? opts.prompt.trim() : '';
  if (!prompt) throw new DeliverableError(400, 'Describe the image to generate in `prompt`.');
  if (prompt.length > MAX_PROMPT_CHARS) throw new DeliverableError(400, `The prompt is ${prompt.length} characters; keep it under ${MAX_PROMPT_CHARS}.`);
  const shape: ImageShape = ['square', 'landscape', 'portrait', 'auto'].includes(String(opts.shape)) ? opts.shape as ImageShape : 'auto';
  const saveTo = typeof opts.saveTo === 'string' && opts.saveTo.trim() ? opts.saveTo.trim() : '';

  // reference assets: images this chat can see (in a video project, only its pinned channel version and its own)
  const refIds = Array.isArray(opts.referenceAssetIds) ? [...new Set(opts.referenceAssetIds.map(String))].slice(0, 8) : [];
  const video = videoProjectForChat(opts.chatId);
  const visible = video ? visibleAssetIds({ channelId: video.channelId, version: video.channelVersion, runId: video.runId }) : null;
  const references = refIds.map((id) => {
    const a = getAsset(id);
    if (!a || (visible && !visible.has(id))) throw new DeliverableError(404, `Reference asset ${id} is not available here${video ? ` (channel version ${video.channelVersion} or this project)` : ''}. Find ids with asset_search.`);
    if (!a.mime.startsWith('image/')) throw new DeliverableError(400, `Reference ${id} is ${a.mime}, not an image.`);
    return assetFilePath(a);
  });

  // a video project pays only after approval, within budget, and never twice for the same request
  const provider = opts.settings.imageGeneration.provider;
  const costUsd = opts.settings.video.rates.imageUsd[provider];
  const gate = imageSpendGate(opts.chatId, costUsd, [provider, opts.settings.imageGeneration.model, prompt, shape, opts.transparent === true, [...refIds].sort(), String(opts.variant ?? ''), saveTo]);
  if (gate?.refusal) throw new DeliverableError(402, gate.refusal);
  if (gate?.cached) {
    const earlier = JSON.parse(gate.cached) as { deliverableId: string; assetId?: string };
    const deliverable = getDeliverable(earlier.deliverableId);
    if (deliverable) {
      const bytes = fs.readFileSync(deliverablePath(deliverable));
      const kind = sniff(bytes)!;
      return {
        deliverable, savedTo: deliverable.sourcePath, reused: true, costUsd: 0,
        image: { bytes, ...kind, provider, model: opts.settings.imageGeneration.model || 'Codex default' },
        ...(earlier.assetId && getAsset(earlier.assetId) ? { asset: getAsset(earlier.assetId)! } : {}),
      };
    }
  }

  // refuse a bad destination BEFORE spending a generation on it
  const dir = saveTo ? workingDir(opts.chatId, opts.workdir) : '';
  if (saveTo) {
    let rel: string;
    try { rel = cleanRel(saveTo); } catch (err) {
      if (err instanceof BrowseError) throw new DeliverableError(400, `save_to: ${err.message}`);
      throw err;
    }
    if (!rel) throw new DeliverableError(400, 'save_to names the working directory itself — give a file path, e.g. "assets/hero.png".');
    // most generations are PNG; saveInto checks again with the real extension
    const likely = path.posix.join(path.posix.dirname(rel), withExt(path.posix.basename(rel), 'png'));
    if (fs.existsSync(path.join(dir, likely))) {
      throw new DeliverableError(409, `${likely} already exists. Choose a new name (for example ${likely.replace(/(\.\w+)$/, '-v2$1')}) — generated images never overwrite a file.`);
    }
  }

  const image = await generateImage({ prompt, shape, transparent: opts.transparent === true, references }, opts.settings);
  let savedTo = '';
  if (saveTo) {
    savedTo = saveInto(dir, saveTo, image.ext);
    fs.writeFileSync(path.join(dir, savedTo), image.bytes);
  }
  const name = typeof opts.name === 'string' && opts.name.trim()
    ? withExt(opts.name.trim(), image.ext)
    : savedTo ? path.posix.basename(savedTo) : nameFromPrompt(prompt, image.ext);
  const deliverable = shareBytes(opts.chatId, image.bytes, { name, note: opts.note, sourcePath: savedTo });

  // register it as a searchable asset (project-scoped in a video project, else the named channel's)
  let asset: MediaAsset | undefined;
  if (opts.register && typeof opts.register === 'object') {
    const r = opts.register as Record<string, unknown>;
    try {
      asset = addAssets(opts.chatId, opts.role ?? 'builder', [{ ...r, name: r.name ?? name }], {
        channel: r.channel, bytes: { bytes: image.bytes, ext: image.ext },
        defaultProvenance: { source: 'generated', provider: image.provider, model: image.model, prompt, references: refIds, deliverableId: deliverable.id },
      }).assets[0];
    } catch (err) {
      // the image exists and the user can see it; say why it is not in the library
      if (err instanceof VideoError) throw new DeliverableError(err.status, `The image was generated (it is in the chat) but not registered as an asset: ${err.message}`);
      throw err;
    }
  }
  if (gate) {
    recordPaidOp({
      runId: gate.video.runId, chatId: opts.chatId, key: gate.key, category: 'images',
      label: `${image.provider} image: ${prompt.slice(0, 120)}`, costUsd,
      result: JSON.stringify({ deliverableId: deliverable.id, assetId: asset?.id }),
    });
  }
  return { deliverable, image, savedTo, ...(asset ? { asset } : {}), ...(gate ? { costUsd } : {}) };
}
