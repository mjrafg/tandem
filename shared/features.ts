/**
 * Capabilities that are BUILT but not currently active.
 *
 * An archived feature keeps its code, its database columns, its recorded
 * history and its tests. What it loses is its seat in normal operation: the
 * Director is not asked to reason about it, it does not influence routing, and
 * it does not occupy space in Settings. That is a one-line decision, made here,
 * so archiving and reactivating are the same small edit rather than a series of
 * deletions and a later re-implementation.
 */

/**
 * Difficulty-based model routing: the Director classifying every session as
 * easy/medium/hard/very hard, and Settings mapping each tier to a Builder and
 * Builder Reviewer.
 *
 * Archived 2026-09-20. A capability benchmark found that the cheaper models a
 * tier would route easy work to were not consistently good enough to trust
 * unattended — one repeated a hard task with a whole feature silently broken —
 * so the classification cost the Director attention on every session without
 * buying quality. Reactivate when cheaper models can be trusted at a tier:
 * flip DIFFICULTY_ROUTING_DEFAULT to true.
 *
 * What stays true while it is archived:
 *   - pd_sessions.difficulty and chats.difficulty keep their recorded values
 *   - stored Settings keep any tiers already configured
 *   - ai_call records already attributed to a tier still display that way
 *   - per-session review_required is a separate capability and stays active
 */
export const DIFFICULTY_ROUTING_DEFAULT = false;

/**
 * The live answer. The environment override exists so the archived feature's
 * own tests can still exercise it without changing the default; the server
 * publishes it to its tool subprocesses at boot, so one value governs
 * everything.
 */
export const DIFFICULTY_ROUTING_ENABLED: boolean = DIFFICULTY_ROUTING_DEFAULT
  || (typeof process !== 'undefined' && process?.env?.TANDEM_DIFFICULTY_ROUTING === '1');
