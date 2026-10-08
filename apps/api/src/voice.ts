import type { WebSocket } from '@fastify/websocket';
import { type Agent, SessionClosedError, SessionExpiredError, SessionNotFoundError } from '@vsd/agent';
import type { SttAdapter, SttStream, Transcript, TtsAdapter } from '@vsd/speech';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

// No NUL and no lone UTF-16 surrogate: Postgres jsonb rejects both, so the audit insert would fail with transcript text in its error.
export const TurnText = z.string().min(1).max(2000).regex(/^[^\0\ud800-\udfff]*$/u);
export const RATE_LIMITED = 'Too many requests. Wait a minute and try again.';
const TextMessage = z.object({ type: z.literal('text'), text: TurnText });

const SESSION_ERRORS = [
  { type: SessionNotFoundError, status: 404, message: 'Session not found.' },
  { type: SessionExpiredError, status: 410, message: 'Session expired after 10 idle minutes.' },
  { type: SessionClosedError, status: 409, message: 'Session has ended.' },
];

export const sessionError = (e: unknown) => SESSION_ERRORS.find(({ type }) => e instanceof type);

export function handleVoice(
  socket: WebSocket,
  req: FastifyRequest,
  { agent, stt, tts, allowTurn }: { agent: Agent; stt: SttAdapter; tts: TtsAdapter; allowTurn: (ip: string, sessionId: string) => boolean },
): void {
  const send = (message: object) => socket.send(JSON.stringify(message));
  const open = () => socket.readyState === socket.OPEN;
  let sessionId = '';
  let stream: SttStream | undefined;
  let queue = Promise.resolve();
  let refusedAudio = false;

  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((e: unknown) => {
      const known = sessionError(e);
      if (!known) req.log.error({ err: e }, 'voice call failed');
      send({ type: 'error', message: known?.message ?? 'Something went wrong. Please try again.' });
      if (known || !sessionId) socket.close();
    });
  };

  const speak = async (text: string) => {
    send({ type: 'reply', text });
    for await (const frame of tts.synthesize(text)) {
      socket.send(typeof frame === 'string' ? JSON.stringify({ type: 'tts_text', text: frame }) : frame);
    }
    send({ type: 'audio_end' });
  };

  const heard = ({ text, final }: Transcript) => {
    if (!text) return;
    send({ type: 'transcript', text, final });
    if (!final) return;
    if (!TurnText.safeParse(text).success) return send({ type: 'error', message: 'Could not use that. Please try again.' });
    enqueue(async () => {
      if (!open()) return;
      if (!allowTurn(req.ip, sessionId)) return send({ type: 'error', message: RATE_LIMITED });
      const result = await agent.handleTurn(sessionId, text);
      // Events are rebuilt field by field so tool arguments and results can never reach the client.
      for (const e of result.events) {
        if (e.type === 'tool') send({ type: e.type, name: e.name, outcome: e.outcome });
        if (e.type === 'tool_rejected') send({ type: e.type, name: e.name, reason: e.reason });
      }
      send({ type: 'state', pipeline: result.pipeline, state: result.state, status: result.status });
      await speak(result.reply);
      if (result.status === 'ended') socket.close();
    });
  };

  enqueue(async () => {
    const session = await agent.createSession('voice');
    if (!open()) return;
    sessionId = session.sessionId;
    stream = stt.start(sessionId);
    stream.onTranscript(heard);
    stream.onError((err) => {
      req.log.error({ err }, 'speech recognition failed');
      send({ type: 'error', message: 'Speech recognition is unavailable. Type instead.' });
    });
    send({ type: 'session', sessionId, audio: stt.audio });
    await speak(session.reply);
  });

  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (stt.audio) stream?.pushAudio(data);
      else if (!refusedAudio) {
        refusedAudio = true;
        send({ type: 'error', message: 'This server takes no audio (STT_PROVIDER=text). Send {"type":"text","text":"..."} instead.' });
      }
      return;
    }
    let text: string | undefined;
    try {
      text = TextMessage.parse(JSON.parse(data.toString())).text;
    } catch {}
    if (text) heard({ text, final: true });
    else send({ type: 'error', message: 'Expected binary audio or {"type":"text","text":"..."}.' });
  });
  socket.on('close', () => stream?.stop().catch((err: unknown) => req.log.warn({ err }, 'stopping speech recognition failed')));
}
