import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerMsg } from '../../shared/types';

type Client = { write: (chunk: string) => void };
const clients = new Set<Client>();

export function sseHandler(req: FastifyRequest, reply: FastifyReply): void {
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
  clients.add(client);
  const heartbeat = setInterval(() => {
    try { res.write(':hb\n\n'); } catch { /* closed */ }
  }, 25_000);
  req.raw.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

export function broadcast(msg: ServerMsg): void {
  if (clients.size === 0) return;
  const frame = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of clients) {
    try { c.write(frame); } catch { clients.delete(c); }
  }
}
