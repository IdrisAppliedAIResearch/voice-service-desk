import { readFile } from 'node:fs/promises';
import websocket from '@fastify/websocket';
import type { Agent } from '@vsd/agent';
import type { SttAdapter, TtsAdapter } from '@vsd/speech';
import fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createRateLimiter } from './limiter';
import { handleVoice, RATE_LIMITED, sessionError, TurnText } from './voice';

const INDEX_HTML = new URL('../public/index.html', import.meta.url);
const SessionBody = z.object({ channel: z.enum(['text', 'voice']).default('text') });
const TurnBody = z.object({ sessionId: z.uuid(), text: TurnText });

export function buildServer({ agent, stt, tts }: { agent: Agent; stt: SttAdapter; tts: TtsAdapter }): FastifyInstance {
  const ipLimit = Number(process.env.RATE_LIMIT_IP_PER_MIN) || 60;
  const sessionLimit = Number(process.env.RATE_LIMIT_SESSION_PER_MIN) || 20;
  const allow = createRateLimiter();
  // A new session (HTTP or voice) spends the per-IP budget like a turn, so clients cannot mint sessions without limit.
  const allowIp = (ip: string) => allow(`ip:${ip}`, ipLimit);
  const allowTurn = (ip: string, sessionId: string) => allowIp(ip) && allow(`session:${sessionId}`, sessionLimit);

  const app = fastify({ logger: true });
  app.setErrorHandler<FastifyError>((err, req, reply) => {
    const known = sessionError(err);
    if (known) return reply.code(known.status).send({ error: known.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request body.' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'Internal server error.' });
  });

  // ws buffers messages up to 100 MiB by default; audio frames and typed turns are a few KiB.
  app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  app.register(async (app) => {
    app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(await readFile(INDEX_HTML)));
    app.get('/healthz', async () => ({ ok: true }));
    app.post('/v1/session', async (req, reply) => {
      const { channel } = SessionBody.parse(req.body ?? {});
      if (!allowIp(req.ip)) return reply.code(429).send({ error: RATE_LIMITED });
      reply.code(201);
      return agent.createSession(channel);
    });
    app.post('/v1/turn', async (req, reply) => {
      const { sessionId, text } = TurnBody.parse(req.body);
      if (!allowTurn(req.ip, sessionId)) return reply.code(429).send({ error: RATE_LIMITED });
      return agent.handleTurn(sessionId, text);
    });
    app.get('/v1/voice', { websocket: true }, (socket, req) => {
      if (allowIp(req.ip)) return handleVoice(socket, req, { agent, stt, tts, allowTurn });
      socket.send(JSON.stringify({ type: 'error', message: RATE_LIMITED }));
      socket.close();
    });
  });
  return app;
}
