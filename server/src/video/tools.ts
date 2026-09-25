/**
 * The Channel and video-project tools agents use (the tandem_channel server),
 * the approvals only the user can decide, and the compact Channel context
 * handed to a session instead of the whole library.
 *
 * Authority is decided here, per role, whatever tools a role was served:
 *   - everyone with the server may READ channels and search assets;
 *   - writers (Builder, final repair, Director) may change a channel and add
 *     assets — inside a video project, new assets belong to the project;
 *   - only the Director asks for production approval or a channel upgrade;
 *   - nobody but the user, through the UI, can approve anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ChannelContent, MediaAsset, VideoProject } from '../../../shared/types';
import { db, getChat } from '../db';
import { addEvent, updateEvent } from '../events';
import { getDeliverable, deliverablePath } from '../deliverables';
import { getSettings } from '../settings';
import { projectRoot } from '../repoBrowse';
import {
  ENGINE_LIBRARY, VideoError, assetFilePath, costBreakdown, createApproval, createAsset, createChannel, findChannel,
  getApproval, getAsset, getChannelVersion, getVideoProject, listChannelVersions, listChannels, markApproval,
  patchVideoProject, pendingApprovals, previewPath, requireChannel, runIdForChat, searchAssets, setApprovalEvent,
  updateChannel, videoProjectForChat, visibleAssetIds, type AssetView,
} from './store';

const READERS = ['builder', 'final_repair', 'builder_reviewer', 'director_reviewer', 'reviewer', 'director'];
const WRITERS = ['builder', 'final_repair', 'director'];

type Reply = { ok: true; text: string } | { ok: false; status: number; error: string };

/** the Project Chat of a run — where approval cards are shown */
function projectChatOf(runId: string): string {
  const r = db.prepare('SELECT chat_id FROM project_runs WHERE id = ?').get(runId) as any;
  return r?.chat_id;
}

function need(role: string, allowed: string[], what: string): void {
  if (!allowed.includes(role)) throw new VideoError(403, `The ${role} role cannot ${what}.`);
}

function json(v: unknown): string {
  return JSON.stringify(v, null, 1);
}

/** what this chat sees: a video project's pinned version, or a named channel's latest */
function viewFor(chatId: string, channelRef?: unknown): { video: VideoProject | null; view: AssetView } {
  const video = videoProjectForChat(chatId);
  if (video && (channelRef === undefined || channelRef === null || channelRef === '' || findChannel(channelRef)?.id === video.channelId)) {
    return { video, view: { channelId: video.channelId, version: video.channelVersion, runId: video.runId } };
  }
  if (channelRef !== undefined && channelRef !== null && channelRef !== '') {
    const ch = requireChannel(channelRef);
    return { video, view: { channelId: ch.id, version: ch.headVersion, runId: video?.runId ?? null } };
  }
  return { video, view: { channelId: null, version: null, runId: null } };
}

function assetForAgent(a: MediaAsset) {
  const file = getAsset(a.id)!.file;
  return {
    id: a.id, kind: a.kind, scope: a.scope, entity: a.entityId, name: a.name, description: a.description,
    tags: a.tags, attributes: a.attributes, mime: a.mime, size: a.width && a.height ? `${a.width}x${a.height}` : undefined,
    // references are looked at (small preview) or passed to generation by id;
    // only production assets are importable into the engine
    preview: fs.existsSync(previewPath(a.id)) ? previewPath(a.id) : undefined,
    ...(a.kind === 'production' ? { engine_import: { library: ENGINE_LIBRARY, path: file } } : {}),
    provenance: a.provenance,
  };
}

/** a short text inventory of a channel version — what a session is handed up front */
export function channelSummaryText(channelId: string, version: number, runId: string | null): string {
  const v = getChannelVersion(channelId, version);
  const c = v.content;
  const assets = searchAssets({ channelId, version, runId }, { limit: 200 });
  const count = (entityId: string | null, kind?: string) => assets.filter((a) => a.entityId === entityId && (!kind || a.kind === kind)).length;
  const entityLine = (e: ChannelContent['entities'][number]) =>
    `- ${e.id} · ${e.type} · ${e.name}${e.summary ? ` — ${e.summary}` : ''} [${count(e.id, 'reference')} reference, ${count(e.id, 'production')} production]`;
  const sections = Object.keys(c.styleBible.sections);
  return [
    `Channel: ${c.name} (id ${channelId}) · version ${version}`,
    c.description ? `About: ${c.description.slice(0, 400)}` : '',
    `Style Bible: ${c.styleBible.summary ? c.styleBible.summary.slice(0, 900) : '(no summary yet)'}`,
    sections.length ? `Style Bible sections (read with channel_get detail=true): ${sections.join(', ')}` : '',
    c.entities.length ? `Entities:\n${c.entities.map(entityLine).join('\n')}` : 'Entities: none yet',
    `Assets visible here: ${assets.length} (${assets.filter((a) => a.kind === 'reference').length} reference, ${assets.filter((a) => a.kind === 'production').length} production; ${assets.filter((a) => a.scope === 'project').length} belong to this project only)`,
  ].filter(Boolean).join('\n');
}

/** the Channel block for a session in a video project, or '' outside one */
export function channelContextFor(chatId: string): string {
  const video = videoProjectForChat(chatId);
  if (!video) return '';
  return [
    '# Video project — channel context',
    'This is a VIDEO project. It is pinned to the channel version below; everything you read or create belongs to that version. Details and images are NOT included here: fetch them only when you need them, with channel_get and asset_search (tandem_channel tools).',
    channelSummaryText(video.channelId, video.channelVersion, video.runId),
    `Production phase: ${video.phase}${video.budgetUsd != null ? ` · approved budget $${video.budgetUsd.toFixed(2)}, spent $${video.spentUsd.toFixed(2)}` : ''}.`,
    'Reuse before you generate: search project and channel assets (characters, their variants, locations, props) first, and prefer engine transforms — crop, scale, camera moves, masks, layer composition — over a new image. Many scenes can share few assets. New assets belong to this project; the channel only gains them through asset_promote, which the user approves. A reference asset guides generation (pass its id as reference_asset_ids to tandem_generate_image); it is never an engine layer — the engine imports production assets only, from library "tandem".',
  ].join('\n\n');
}

/** the Director's view of a video project, appended to its instructions each turn */
export function directorVideoText(runId: string): string {
  const video = getVideoProject(runId);
  if (!video) return '';
  const pending = pendingApprovals(runId);
  return [
    channelSummaryText(video.channelId, video.channelVersion, runId),
    `Pinned channel version: ${video.channelVersion}${video.newerVersion ? ` (the channel is now at version ${video.newerVersion}; this project stays on ${video.channelVersion} unless you request video_upgrade_channel and the user approves)` : ''}.`,
    `Production phase: ${video.phase}. Budget: ${video.budgetUsd != null ? `$${video.budgetUsd.toFixed(2)} approved` : 'none approved yet'} · spent $${video.spentUsd.toFixed(2)}.`,
    pending.length ? `Waiting for the user: ${pending.map((p) => `${p.kind} — ${p.title}`).join('; ')}.` : '',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- asset sources

/** a file an agent names: a shared/generated file id, or a path in its working directory or the engine's workspaces */
function readSource(chatId: string, src: Record<string, unknown>, workdir: unknown): { bytes: Buffer; ext: string; from: string } {
  if (typeof src.file_id === 'string' && src.file_id) {
    const d = getDeliverable(src.file_id);
    const run = runIdForChat(chatId);
    const sameProject = !!d && (d.chatId === chatId || (run !== null && runIdForChat(d.chatId) === run));
    if (!d || !sameProject) throw new VideoError(404, `No shared file ${src.file_id} in this chat or project.`);
    return { bytes: fs.readFileSync(deliverablePath(d)), ext: path.extname(d.name), from: `file ${d.name}` };
  }
  if (typeof src.path !== 'string' || !src.path.trim()) throw new VideoError(400, 'Each asset needs a source: path (a file in your working directory) or file_id (a shared or generated file).');
  const chat = getChat(chatId);
  const roots: string[] = [];
  // the agent's own working directory places a relative path; the chat's project is the fallback
  if (typeof workdir === 'string' && workdir) { try { roots.push(fs.realpathSync(workdir)); } catch { /* ignore */ } }
  try { if (chat) roots.push(projectRoot(chat.projectId)); } catch { /* gone */ }
  const engineRoot = engineWorkspaceRoot();
  if (engineRoot) roots.push(engineRoot);
  const given = src.path.trim();
  let real: string;
  try { real = fs.realpathSync(path.isAbsolute(given) ? given : path.resolve(roots[0] ?? '/', given)); } catch {
    throw new VideoError(404, `There is no file at ${given}.`);
  }
  const inside = roots.some((r) => real === r || real.startsWith(r + path.sep));
  if (!inside) throw new VideoError(403, 'An asset file must come from your working directory or the Video Engine\'s workspaces.');
  if (!fs.statSync(real).isFile()) throw new VideoError(400, `${given} is not a file.`);
  return { bytes: fs.readFileSync(real), ext: path.extname(real), from: real };
}

/** where the Video Engine keeps workspaces, from its integration's configuration */
export function engineWorkspaceRoot(): string | null {
  const slug = getSettings().video.engineIntegration;
  const r = db.prepare('SELECT config FROM integrations WHERE slug = ?').get(slug) as any;
  if (!r) return null;
  try {
    const root = JSON.parse(r.config)?.env?.VIDEO_ENGINE_ROOT;
    return typeof root === 'string' && root ? fs.realpathSync(root) : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- operations

function entityCheck(channelId: string | null, version: number | null, entityId: unknown): string | null {
  if (entityId === undefined || entityId === null || entityId === '') return null;
  if (!channelId || !version) throw new VideoError(400, 'entity_id needs a channel.');
  const e = getChannelVersion(channelId, version).content.entities.find((x) => x.id === entityId);
  if (!e) throw new VideoError(404, `There is no entity ${String(entityId)} in channel version ${version}. Create it with channel_update first.`);
  return e.id;
}

/**
 * Register new assets. In a video project they belong to the project; outside
 * one (channel development) they join the channel, all in one new version.
 */
export function addAssets(chatId: string, role: string, items: Record<string, unknown>[], opts: { channel?: unknown; note?: unknown; workdir?: unknown; defaultProvenance?: Record<string, unknown>; bytes?: { bytes: Buffer; ext: string } }): { assets: MediaAsset[]; version: number | null; channelId: string } {
  need(role, WRITERS, 'add assets');
  const { video, view } = viewFor(chatId, opts.channel);
  if (!view.channelId) throw new VideoError(400, 'Name the channel these assets belong to (channel), or add them from a video project.');
  if (items.length === 0) throw new VideoError(400, 'No assets given.');
  if (items.length > 40) throw new VideoError(400, 'Add at most 40 assets at a time.');
  const inProject = !!video && video.channelId === view.channelId;
  const created: MediaAsset[] = [];
  for (const it of items) {
    const src = opts.bytes ? { ...opts.bytes, from: 'generated' } : readSource(chatId, it, opts.workdir);
    const kind = String(it.kind ?? '');
    const attributes = it.attributes && typeof it.attributes === 'object' ? { ...(it.attributes as Record<string, unknown>) } : {};
    created.push(createAsset({
      bytes: src.bytes, ext: src.ext, kind: kind as any,
      scope: inProject ? 'project' : 'channel',
      channelId: view.channelId, projectRunId: inProject ? video!.runId : null,
      entityId: entityCheck(view.channelId, view.version, it.entity_id),
      name: String(it.name ?? '').trim() || path.basename(String(it.path ?? 'asset')),
      description: typeof it.description === 'string' ? it.description : '',
      tags: Array.isArray(it.tags) ? it.tags.map(String) : [],
      attributes,
      provenance: { source: 'added', from: src.from, by: role, ...(opts.defaultProvenance ?? {}), ...((it.provenance as object) ?? {}) },
    }));
  }
  if (inProject) return { assets: created, version: null, channelId: view.channelId };
  const { version } = updateChannel(view.channelId, { addAssetIds: created.map((a) => a.id) }, { by: role, note: opts.note ?? `${created.length} asset(s) added` });
  return { assets: created, version: version.version, channelId: view.channelId };
}

export async function handleChannelTool(chatId: string, role: string, op: string, args: Record<string, any>, workdir?: unknown): Promise<Reply> {
  try {
    if (!getChat(chatId)) throw new VideoError(404, 'This chat does not exist.');
    need(role, READERS, 'use channel tools');
    switch (op) {
      case 'channel_list': {
        const channels = listChannels();
        if (channels.length === 0) return { ok: true, text: 'No channels yet. Create one with channel_update { create: { name, description }, … }.' };
        return { ok: true, text: json(channels.map((c) => {
          const v = getChannelVersion(c.id).content;
          return { id: c.id, name: c.name, version: c.headVersion, description: v.description.slice(0, 200), entities: v.entities.map((e) => `${e.id} (${e.type})`), assets: v.assetIds.length };
        })) };
      }
      case 'channel_get': {
        const { video, view } = viewFor(chatId, args.channel);
        if (!view.channelId) throw new VideoError(400, 'Name a channel (channel), or call this from a video project.');
        const version = args.version !== undefined ? Number(args.version) : view.version!;
        const v = getChannelVersion(view.channelId, version);
        const detail = args.detail === true;
        const out: Record<string, unknown> = {
          channel: view.channelId, version: v.version,
          ...(video && video.channelId === view.channelId ? { pinned_version: video.channelVersion, latest_version: requireChannel(view.channelId).headVersion } : { latest_version: requireChannel(view.channelId).headVersion }),
          name: v.content.name, description: v.content.description,
          style_bible: detail ? v.content.styleBible : { summary: v.content.styleBible.summary, sections: Object.keys(v.content.styleBible.sections) },
          entities: v.content.entities.map((e) => detail ? e : { id: e.id, type: e.type, name: e.name, summary: e.summary }),
          defaults: v.content.defaults,
          channel_assets: v.content.assetIds.length,
          history: listChannelVersions(view.channelId).slice(0, 8),
        };
        return { ok: true, text: json(out) };
      }
      case 'channel_update': {
        need(role, WRITERS, 'change a channel');
        const patch = {
          description: args.description,
          styleBible: args.style_bible,
          entities: Array.isArray(args.entities) ? args.entities : undefined,
          removeEntities: Array.isArray(args.remove_entities) ? args.remove_entities : undefined,
          defaults: args.defaults,
          name: args.rename,
        };
        if (args.create) {
          const created = createChannel({ name: args.create.name, description: args.create.description, patch, note: args.note, by: role });
          return { ok: true, text: `Created channel "${created.channel.name}" (id ${created.channel.id}) at version 1.${created.changes.length ? ` Included: ${created.changes.join('; ')}.` : ''}\n${json(created.version.content.entities.map((e) => ({ id: e.id, type: e.type, name: e.name })))}` };
        }
        const { video, view } = viewFor(chatId, args.channel);
        if (!view.channelId) throw new VideoError(400, 'Name the channel to change (channel), or create one with create: { name }.');
        const { version, changes } = updateChannel(view.channelId, patch, { expectedVersion: args.expected_version, by: role, note: args.note });
        const pinnedNote = video && video.channelId === view.channelId
          ? ` This video project stays on version ${video.channelVersion}; moving it to version ${version.version} is an explicit upgrade.`
          : '';
        return { ok: true, text: `Channel is now at version ${version.version}: ${changes.join('; ')}.${pinnedNote}\nEntities: ${json(version.content.entities.map((e) => ({ id: e.id, type: e.type, name: e.name })))}` };
      }
      case 'asset_search': {
        const { view } = viewFor(chatId, args.channel);
        if (!view.channelId && !view.runId) throw new VideoError(400, 'Name a channel to search (channel), or search from a video project.');
        const found = searchAssets(view, {
          query: typeof args.query === 'string' ? args.query : undefined,
          kind: args.kind === 'reference' || args.kind === 'production' ? args.kind : undefined,
          entityId: typeof args.entity_id === 'string' ? args.entity_id : undefined,
          scope: args.scope === 'channel' || args.scope === 'project' ? args.scope : undefined,
          tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
          engineReady: typeof args.engine_ready === 'boolean' ? args.engine_ready : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
        if (found.length === 0) return { ok: true, text: `No matching assets in ${view.channelId ? `channel version ${view.version}` : 'this project'}${view.runId ? ' or this project' : ''}.` };
        return { ok: true, text: `${found.length} asset(s):\n${json(found.map(assetForAgent))}` };
      }
      case 'asset_add': {
        const items = Array.isArray(args.assets) ? args.assets : [];
        const r = addAssets(chatId, role, items, { channel: args.channel, note: args.note, workdir });
        return { ok: true, text: `Added ${r.assets.length} asset(s)${r.version ? ` to the channel (now version ${r.version})` : ' to this video project (project scope — promote to share with the channel)'}:\n${json(r.assets.map(assetForAgent))}` };
      }
      case 'asset_promote': {
        need(role, WRITERS, 'propose a promotion');
        const video = videoProjectForChat(chatId);
        if (!video) throw new VideoError(400, 'Promotion moves a video project\'s asset into its channel; this chat is not in a video project.');
        const a = getAsset(String(args.asset_id ?? ''));
        if (!a || a.projectRunId !== video.runId) throw new VideoError(404, `No asset ${String(args.asset_id ?? '')} in this video project.`);
        if (getChannelVersion(video.channelId).content.assetIds.includes(a.id)) return { ok: true, text: `${a.id} is already in the channel.` };
        if (pendingApprovals(video.runId, 'promotion').some((p) => p.detail.assetId === a.id)) return { ok: true, text: `Promoting ${a.id} is already waiting for the user's decision.` };
        const approval = requestApproval(video, 'promotion', `Add "${a.name}" to the ${video.channelName} channel`,
          `${a.kind === 'reference' ? 'Reference' : 'Production'} asset${a.entityId ? ` for ${a.entityId}` : ''}. Reason: ${String(args.reason ?? 'reusable in future videos').slice(0, 400)}`,
          { assetId: a.id, assetName: a.name, kind: a.kind, entityId: a.entityId, reason: args.reason ?? '' });
        return { ok: true, text: `Asked the user to approve promoting ${a.id} into the channel (approval ${approval.id}). It stays project-only unless they approve; you will be told the decision.` };
      }
      case 'video_status': {
        const video = videoProjectForChat(chatId);
        if (!video) return { ok: true, text: 'This chat is not part of a video project.' };
        return { ok: true, text: json({
          channel: video.channelName, channel_id: video.channelId, pinned_version: video.channelVersion, newer_version: video.newerVersion,
          phase: video.phase, budget_usd: video.budgetUsd, spent_usd: video.spentUsd, costs: costBreakdown(video.runId),
          estimate: video.estimate, narration: video.narration,
          pending_approvals: pendingApprovals(video.runId).map((p) => ({ id: p.id, kind: p.kind, title: p.title })),
        }) };
      }
      case 'video_request_production_approval': {
        need(role, ['director'], 'request production approval');
        const video = videoProjectForChat(chatId);
        if (!video) throw new VideoError(400, 'This is not a video project.');
        const estimate = estimateFrom(video, args);
        if (pendingApprovals(video.runId, 'production').length > 0) throw new VideoError(409, 'A production approval is already waiting for the user. Wait for their decision.');
        const revising = video.phase === 'approved' || video.phase === 'narration_locked';
        patchVideoProject(video.runId, { estimate, ...(revising ? {} : { phase: 'awaiting_approval' }) });
        const approval = requestApproval(video, 'production',
          revising ? `Raise the production budget to $${estimate.totalUsd.toFixed(2)}` : `Approve production · estimated $${estimate.totalUsd.toFixed(2)}`,
          String(args.summary ?? '').slice(0, 6000), estimate);
        return { ok: true, text: `The production plan and estimate ($${estimate.totalUsd.toFixed(2)}) are waiting for the user's approval (${approval.id}). Paid generation stays blocked until they approve. End your turn; you will be told the decision.` };
      }
      case 'video_lock_narration': {
        need(role, WRITERS, 'lock the narration');
        const video = videoProjectForChat(chatId);
        if (!video) throw new VideoError(400, 'This is not a video project.');
        if (video.phase === 'planning' || video.phase === 'awaiting_approval') throw new VideoError(409, 'Production is not approved yet — narration comes after the user approves the plan.');
        let narration: Record<string, unknown>;
        if (args.none === true) {
          narration = { none: true, reason: String(args.reason ?? '').slice(0, 500), durationSeconds: Number(args.duration_seconds) || null };
        } else {
          const a = getAsset(String(args.asset_id ?? ''));
          if (!a || !visibleAssetIds({ channelId: video.channelId, version: video.channelVersion, runId: video.runId }).has(a.id)) throw new VideoError(404, 'Name the narration audio asset (asset_id), registered with asset_add.');
          if (!a.mime.startsWith('audio/')) throw new VideoError(400, `${a.id} is ${a.mime}, not audio.`);
          const duration = Number(args.duration_seconds);
          if (!Number.isFinite(duration) || duration <= 0) throw new VideoError(400, 'Give the narration\'s real duration_seconds.');
          const segments = Array.isArray(args.segments) ? args.segments.slice(0, 500).map((s: any) => ({ id: String(s.id ?? ''), text: String(s.text ?? '').slice(0, 2000), start: Number(s.start), end: Number(s.end) })) : [];
          narration = { assetId: a.id, durationSeconds: duration, segments, lockedAt: Date.now() };
        }
        patchVideoProject(video.runId, { phase: 'narration_locked', narration });
        return { ok: true, text: `Narration locked${narration.none ? ' (no narration)' : ` · ${narration.durationSeconds}s, ${(narration.segments as unknown[]).length} segment(s)`}. Visual timing may now follow it.` };
      }
      case 'video_upgrade_channel': {
        need(role, ['director'], 'move a project to another channel version');
        const video = videoProjectForChat(chatId);
        if (!video) throw new VideoError(400, 'This is not a video project.');
        const head = requireChannel(video.channelId).headVersion;
        const to = args.to_version !== undefined ? Number(args.to_version) : head;
        getChannelVersion(video.channelId, to);
        if (to === video.channelVersion) return { ok: true, text: `The project is already on version ${to}.` };
        const approval = requestApproval(video, 'channel_upgrade', `Move this video to ${video.channelName} version ${to}`,
          `From version ${video.channelVersion} to ${to}. ${String(args.reason ?? '').slice(0, 600)}`, { from: video.channelVersion, to, reason: args.reason ?? '' });
        return { ok: true, text: `Asked the user to approve moving this project from version ${video.channelVersion} to ${to} (${approval.id}). Nothing changes until they approve.` };
      }
      default:
        throw new VideoError(400, `Unknown channel tool: ${op}`);
    }
  } catch (err) {
    if (err instanceof VideoError) return { ok: false, status: err.status, error: err.message };
    throw err;
  }
}

/** the estimate is computed HERE from the configured rates — the Director supplies counts, not prices */
function estimateFrom(video: VideoProject, args: Record<string, any>): Record<string, any> & { totalUsd: number } {
  const s = getSettings();
  const provider = s.imageGeneration.provider;
  const newImages = Array.isArray(args.new_images) ? args.new_images.slice(0, 500) : [];
  const variants = Math.max(0, Math.floor(Number(args.new_character_variants) || 0));
  const ttsChars = Math.max(0, Math.floor(Number(args.tts_characters) || 0));
  const otherPaid = Array.isArray(args.other_paid) ? args.other_paid.slice(0, 50) : [];
  const otherCalls = otherPaid.reduce((n: number, o: any) => n + Math.max(0, Math.floor(Number(o?.count) || 0)), 0);
  const view = { channelId: video.channelId, version: video.channelVersion, runId: video.runId };
  const visible = visibleAssetIds(view);
  const reused = (Array.isArray(args.reused_assets) ? args.reused_assets : []).map(String);
  const unknown = reused.filter((id: string) => !visible.has(id));
  if (unknown.length) throw new VideoError(400, `These reused assets are not visible in this project: ${unknown.join(', ')}. Use ids from asset_search.`);
  const images = (newImages.length + variants) * s.video.rates.imageUsd[provider];
  const tts = (ttsChars / 1000) * s.video.rates.ttsUsdPer1kChars;
  const other = otherCalls * s.video.rates.otherPaidUsd;
  const totalUsd = Math.round((images + tts + other) * 100) / 100;
  return {
    narrationSeconds: Number(args.narration_seconds) || null,
    reusedAssets: reused,
    newImages: newImages.map((i: any) => ({ purpose: String(i?.purpose ?? '').slice(0, 300), entityId: i?.entity_id ?? null })),
    newCharacterVariants: variants,
    ttsCharacters: ttsChars,
    otherPaid: otherPaid.map((o: any) => ({ tool: String(o?.tool ?? ''), count: Math.max(0, Math.floor(Number(o?.count) || 0)) })),
    providers: { images: provider, narration: args.tts_provider ?? null },
    lines: [
      { label: `Images (${newImages.length + variants} × ${provider})`, usd: Math.round(images * 100) / 100 },
      { label: `Narration (${ttsChars.toLocaleString('en')} characters)`, usd: Math.round(tts * 100) / 100 },
      { label: `Other paid calls (${otherCalls})`, usd: Math.round(other * 100) / 100 },
      { label: 'Local rendering (Video Engine)', usd: 0 },
    ],
    totalUsd,
    exact: false,
    note: 'Estimated from the rates in Settings → Video production; provider bills may differ.',
  };
}

function requestApproval(video: VideoProject, kind: 'production' | 'promotion' | 'channel_upgrade', title: string, summary: string, detail: Record<string, unknown>) {
  const chatId = projectChatOf(video.runId);
  const approval = createApproval({ runId: video.runId, chatId, kind, title, summary, detail });
  const ev = addEvent(chatId, 'approval', { id: approval.id, kind, status: 'pending', title, summary, detail });
  setApprovalEvent(approval.id, ev.id);
  return approval;
}

// ---------------------------------------------------------------- the user decides

/**
 * Only reachable from the signed-in UI. Applies the decision, updates the
 * card, and tells the Director.
 */
export function decideApproval(id: string, decision: 'approve' | 'decline', onDecided: (runId: string, text: string) => void): { ok: true } | { ok: false; status: number; error: string } {
  const a = getApproval(id);
  if (!a) return { ok: false, status: 404, error: 'That approval does not exist.' };
  if (a.status !== 'pending') return { ok: false, status: 409, error: `That was already ${a.status}.` };
  const video = getVideoProject(a.runId);
  if (!video) return { ok: false, status: 404, error: 'The video project no longer exists.' };
  let outcome = '';
  try {
    if (decision === 'approve') {
      if (a.kind === 'production') {
        const total = Number(a.detail.totalUsd) || 0;
        patchVideoProject(a.runId, { budgetUsd: total, ...(video.phase === 'planning' || video.phase === 'awaiting_approval' ? { phase: 'approved' } : {}) });
        outcome = `The user APPROVED production with a budget of $${total.toFixed(2)}. Paid generation is now allowed within that budget; narration first, then visual timing.`;
      } else if (a.kind === 'promotion') {
        const assetId = String(a.detail.assetId);
        const { version } = updateChannel(video.channelId, { addAssetIds: [assetId] }, { by: 'user', note: `Promoted ${assetId} from a video project` });
        db.prepare('UPDATE media_assets SET promoted_at = ? WHERE id = ?').run(Date.now(), assetId);
        outcome = `The user APPROVED promoting ${assetId}: it is in the channel from version ${version.version}. This project stays on version ${video.channelVersion} (it already owns the asset).`;
      } else if (a.kind === 'channel_upgrade') {
        const to = Number(a.detail.to);
        patchVideoProject(a.runId, { channelVersion: to });
        outcome = `The user APPROVED moving this project to channel version ${to}.`;
      }
    } else {
      if (a.kind === 'production' && video.phase === 'awaiting_approval') patchVideoProject(a.runId, { phase: 'planning' });
      outcome = `The user DECLINED: ${a.title}. Nothing was changed${a.kind === 'production' ? '; paid generation stays blocked — revise the plan or ask the user what to change' : ''}.`;
    }
  } catch (err) {
    if (err instanceof VideoError) return { ok: false, status: err.status, error: err.message };
    throw err;
  }
  markApproval(id, decision === 'approve' ? 'approved' : 'declined');
  if (a.eventId) updateEvent(a.eventId, { status: decision === 'approve' ? 'approved' : 'declined', decidedAt: Date.now() });
  onDecided(a.runId, outcome);
  return { ok: true };
}

// used by the image route and gates
export { assetFilePath, getAsset, visibleAssetIds };
