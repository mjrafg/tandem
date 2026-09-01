import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ObservabilitySignal, ServerMsg } from '../../shared/types';

const HEARTBEAT_MS = Number(process.env.TANDEM_SSE_HEARTBEAT_MS || 25_000);

type Client = { write: (chunk: string) => void };
const clients = new Set<Client>();
/**
 * Observability consumers share this SSE implementation but NOT the UI's client
 * set: the app stream carries full chat events, while the observability stream
 * carries only small wake-up signals. One transport, two audiences — no second
 * realtime stack.
 */
const observers = new Set<Client>();

export function sseHandler(req: FastifyRequest, reply: FastifyReply): void {
  attach(req, reply, clients);
}

/**
 * The Observability lifecycle stream (bearer-authenticated by its route).
 * `stillValid` is re-checked on every heartbeat so a revoked key's existing
 * connection is dropped instead of streaming until the process restarts.
 */
export function observabilityStreamHandler(req: FastifyRequest, reply: FastifyReply, stillValid?: () => boolean): void {
  attach(req, reply, observers, stillValid);
}

function attach(req: FastifyRequest, reply: FastifyReply, set: Set<Client>, stillValid?: () => boolean): void {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':connected\n\n');
  const client: Client = { write: (chunk) => res.write(chunk) };
  set.add(client);
  const heartbeat = setInterval(() => {
    if (stillValid && !stillValid()) {
      set.delete(client);
      clearInterval(heartbeat);
      try { res.end(); } catch { /* already gone */ }
      return;
    }
    try { res.write(':hb\n\n'); } catch { /* closed */ }
  }, HEARTBEAT_MS);
  req.raw.on('close', () => {
    clearInterval(heartbeat);
    set.delete(client);
  });
}

export function broadcast(msg: ServerMsg): void {
  fan(clients, msg);
}

/**
 * A lifecycle wake-up for Observability consumers. Identities and a sequence
 * only — never transcript content. Callers must persist the state this
 * describes BEFORE calling, so a consumer that fetches immediately always
 * finds the evidence already landed.
 */
export function notifyObservability(signal: ObservabilitySignal): void {
  fan(observers, signal);
}

function fan(set: Set<Client>, msg: unknown): void {
  if (set.size === 0) return;
  const frame = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of set) {
    try { c.write(frame); } catch { set.delete(c); }
  }
}
