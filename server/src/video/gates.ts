/**
 * The video-production invariants, enforced where the calls actually happen —
 * the integration gateway and the image route — not in any prompt:
 *
 *   1. No paid generation in a video project before the user approves the
 *      production plan, and none beyond the approved budget.
 *   2. Visual timing (animation keyframes, final renders) only after the
 *      narration is locked.
 *   3. An identical paid request in the same project is answered from the
 *      earlier result — a retry, a resume or a duplicate never pays twice.
 *   4. The Video Engine is never handed a reference asset: its only Tandem
 *      library holds production assets, and every import is checked against
 *      what this project may see.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, VideoProject } from '../../../shared/types';
import { db } from '../db';
import { getSettings } from '../settings';
import { ENGINE_LIBRARY, findPaidOp, opKey, recordPaidOp, videoProjectForChat, visibleAssetIds } from './store';
import { engineWorkspaceRoot } from './tools';

function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
}

function matches(name: string, patterns: string[]): boolean {
  return patterns.some((p) => glob(p).test(name));
}

/** why paid spending is not allowed right now, or null when it is */
export function spendRefusal(video: VideoProject, costUsd: number): string | null {
  if (video.phase === 'planning' || video.phase === 'awaiting_approval') {
    return 'Paid generation is blocked in this video project until the user approves the production plan and its cost. Finish planning (story, script, reuse analysis, estimate), then the Director requests approval with video_request_production_approval.';
  }
  const budget = video.budgetUsd ?? 0;
  if (costUsd > 0 && video.spentUsd + costUsd > budget + 1e-9) {
    return `This would exceed the approved budget: $${video.spentUsd.toFixed(2)} spent of $${budget.toFixed(2)}, and this call is estimated at $${costUsd.toFixed(2)}. Stop and have the Director request a larger budget (video_request_production_approval) — the user must approve it.`;
  }
  return null;
}

export interface GateResult {
  /** refuse the call with this message */
  deny?: string;
  /** answer the call with this earlier result, without running it */
  cached?: string;
  /** record a successful call (charges the budget, remembers the result) */
  onSuccess?: (result: string) => void;
}

function ttsCost(args: Record<string, unknown>, s: AppSettings): number {
  const text = ['text', 'prompt', 'input', 'script'].map((k) => args[k]).find((v) => typeof v === 'string') as string | undefined;
  const chars = text?.length ?? 1000;
  return (chars / 1000) * s.video.rates.ttsUsdPer1kChars;
}

/**
 * Run before an integration tool executes. `integrationSlug` identifies the
 * Video Engine; `toolName` is the tool's own name within its integration.
 */
export function beforeIntegrationCall(input: { chatId?: string; fullName: string; toolName: string; integrationSlug: string; args: Record<string, unknown> }): GateResult {
  const s = getSettings();
  const video = input.chatId ? videoProjectForChat(input.chatId) : null;
  const isEngine = input.integrationSlug === s.video.engineIntegration;

  if (isEngine && input.toolName === 'asset_import') {
    const refusal = engineImportRefusal(input.args, video);
    if (refusal) return { deny: refusal };
  }
  if (!video) return {};

  if (isEngine && s.video.timingTools.includes(input.toolName) && video.phase !== 'narration_locked') {
    return { deny: `Visual timing waits for the narration: ${input.toolName} is blocked until the final narration is produced and locked (video_lock_narration with its real duration and segment timings — or none: true for a video without narration). Static scene setup and previews are allowed now.` };
  }

  if (matches(input.fullName, s.video.paidToolPatterns)) {
    const cost = matches(input.fullName, s.video.ttsToolPatterns) ? ttsCost(input.args, s) : s.video.rates.otherPaidUsd;
    const key = opKey(['tool', input.fullName, input.args]);
    const earlier = findPaidOp(video.runId, key);
    if (earlier) return { cached: `${earlier.result}\n\n(Tandem: this identical paid call already ran in this project — its earlier result is returned and nothing was charged again.)` };
    const refusal = spendRefusal(video, cost);
    if (refusal) return { deny: refusal };
    return {
      onSuccess: (result) => recordPaidOp({
        runId: video.runId, chatId: input.chatId!, key,
        category: matches(input.fullName, s.video.ttsToolPatterns) ? 'narration' : 'other paid APIs',
        label: input.fullName, costUsd: cost, result,
      }),
    };
  }
  return {};
}

/** the sha-256 of what an asset_import would bring in, when Tandem can see it */
function importedBytesHash(source: Record<string, unknown>, workspaceId: unknown): string | null {
  if (typeof source.base64 === 'string') {
    try { return createHash('sha256').update(Buffer.from(source.base64, 'base64')).digest('hex'); } catch { return null; }
  }
  if (typeof source.inbox === 'string' && typeof workspaceId === 'string') {
    const root = engineWorkspaceRoot();
    if (!root) return null;
    const file = path.resolve(root, workspaceId, 'inbox', source.inbox);
    if (!file.startsWith(path.resolve(root) + path.sep)) return null;
    try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
  }
  return null;
}

function engineImportRefusal(args: Record<string, unknown>, video: VideoProject | null): string | null {
  const source = (args.source ?? {}) as Record<string, unknown>;
  if (source.library === ENGINE_LIBRARY) {
    const file = String(source.path ?? '');
    const row = db.prepare('SELECT id, kind FROM media_assets WHERE file = ?').get(path.basename(file)) as any;
    if (!row || row.kind !== 'production' || file !== path.basename(file)) {
      return `"${file}" is not a production asset in Tandem's library. Import production assets by the engine_import path asset_search reports; reference assets are never engine layers.`;
    }
    if (video && !visibleAssetIds({ channelId: video.channelId, version: video.channelVersion, runId: video.runId }).has(row.id)) {
      return `${row.id} is not part of this video project's channel version ${video.channelVersion} or its own assets.`;
    }
    return null;
  }
  const hash = importedBytesHash(source, args.workspaceId);
  if (hash) {
    const kinds = (db.prepare('SELECT DISTINCT kind FROM media_assets WHERE sha256 = ?').all(hash) as any[]).map((r) => r.kind);
    if (kinds.includes('reference') && !kinds.includes('production')) {
      return 'That file is a REFERENCE asset (identity or style guidance), not an engine-ready layer. Prepare a production asset from it — generate or process a proper layer, register it with kind "production" — and import that instead.';
    }
  }
  return null;
}

/** paid-spend gate for image generation; null when not in a video project */
export function imageSpendGate(chatId: string, costUsd: number, keyParts: unknown): { video: VideoProject; key: string; cached: string | null; refusal: string | null } | null {
  const video = videoProjectForChat(chatId);
  if (!video) return null;
  const key = opKey(['image', keyParts]);
  const earlier = findPaidOp(video.runId, key);
  if (earlier) return { video, key, cached: earlier.result, refusal: null };
  let refusal = spendRefusal(video, costUsd);
  // the approved COUNT binds too: a $0 provider still spends quota, and the plan said how many
  if (!refusal && video.approvedImages != null && video.imagesGenerated >= video.approvedImages) {
    refusal = `The approved plan covers ${video.approvedImages} new image${video.approvedImages === 1 ? '' : 's'}, and ${video.imagesGenerated} ha${video.imagesGenerated === 1 ? 's' : 've'} been generated. Reuse what exists, or have the Director ask the user for more (video_request_production_approval with the new count).`;
  }
  return { video, key, cached: null, refusal };
}

export { recordPaidOp };
