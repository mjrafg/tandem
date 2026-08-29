import type { AppSettings, ChangedFile, FindingsPayload } from '../../../shared/types';
import { getEvents } from '../events';

/**
 * Simulated compactor output (milestone 1): builds a faithful summary from the
 * chat's real stored events. The real Compactor CLI call replaces this.
 */
export function generateCompactionSummary(chatId: string, settings: AppSettings): { summary: string; preserved: string[] } {
  const events = getEvents(chatId);

  const userMessages = events.filter((e) => e.kind === 'user_message').map((e) => (e.payload as any).text as string);
  const changed = new Map<string, ChangedFile>();
  for (const e of events) {
    if (e.kind === 'file_change') {
      for (const f of (e.payload as any).files as ChangedFile[]) changed.set(f.path, f);
    }
  }
  const lastFindings = [...events].reverse().find((e) => e.kind === 'findings');
  const lastAssistant = [...events].reverse().find((e) => e.kind === 'assistant_message');
  const commands = events.filter((e) => e.kind === 'command');
  const failedCommands = commands.filter((e) => ((e.payload as any).exitCode ?? 0) !== 0);

  const lines: string[] = [];
  lines.push('## Goal');
  lines.push(userMessages[0] ? `- ${userMessages[0]}` : '- (no user request recorded)');
  if (userMessages.length > 1) {
    lines.push('', '## Follow-up requests');
    for (const m of userMessages.slice(1).slice(-4)) lines.push(`- ${m}`);
  }
  if (changed.size > 0) {
    lines.push('', '## Files changed so far');
    for (const f of changed.values()) lines.push(`- \`${f.path}\` (+${f.additions} −${f.deletions})`);
  }
  if (lastFindings) {
    const p = lastFindings.payload as FindingsPayload;
    lines.push('', '## Review state');
    lines.push(p.verdict === 'pass'
      ? `- Reviewer PASS (round ${p.round})`
      : `- Reviewer findings (round ${p.round}): ${p.items.map((i) => i.title).join('; ')}`);
  }
  if (commands.length > 0) {
    lines.push('', '## Verification');
    lines.push(`- ${commands.length} command(s) run; ${failedCommands.length === 0 ? 'latest checks passed' : `${failedCommands.length} failed — see history`}`);
  }
  if (lastAssistant) {
    const text = ((lastAssistant.payload as any).text as string).split('\n')[0];
    lines.push('', '## Last reported state', `- ${text}`);
  }
  lines.push('', '## Remaining', '- Continue from the most recent user request; no other open threads recorded.');

  const preserved = [
    'Original goal and all user instructions',
    `${Math.min(userMessages.length, 5)} most recent user message(s) verbatim`,
    changed.size > 0 ? `Changed-file list (${changed.size})` : 'No file changes yet',
    lastFindings ? 'Latest reviewer verdict' : 'No review rounds yet',
    `~${Math.round(settings.context.preserveRecentTokens / 1000)}k tokens of the most recent conversation kept verbatim`,
  ];

  return { summary: lines.join('\n'), preserved };
}
