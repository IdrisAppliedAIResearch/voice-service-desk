import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import {
  type Agent,
  type AgentEvent,
  SessionClosedError,
  SessionExpiredError,
  SessionNotFoundError,
} from '@vsd/agent';
import { createStt, type SttAdapter, type Transcript, type TtsAdapter } from '@vsd/speech';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { buildServer } from '../src/server';

const SESSION_ID = randomUUID();
const GREETING = 'Thanks for calling.';
const AUDIO = Buffer.from([1, 2, 3]);
const LIMITED = 'Too many requests. Wait a minute and try again.';
// The extra fields stand in for tool data that must never reach a voice client.
const EVENTS = [
  { type: 'prerouter', action: 'start_pipeline', pipeline: 'password_reset' },
  { type: 'tool', name: 'lookup_account', outcome: 'found', args: { identifier: 'secret-identifier' } },
  { type: 'state', pipeline: 'password_reset', state: 'ask_question', status: 'active', data: { candidate: 'secret-token' } },
  { type: 'tool_rejected', name: 'reset_password', reason: 'not_allowed', arguments: '{"answer":"secret-answer"}' },
  { type: 'llm_retry', reason: 'secret-model-output' },
] as AgentEvent[];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function freezeClock() {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-07T12:00:30Z') });
}

function setup(realStt?: SttAdapter) {
  const agent = {
    createSession: vi.fn<Agent['createSession']>(async () => ({ sessionId: SESSION_ID, reply: GREETING, pipeline: 'triage', state: 'greet' })),
    handleTurn: vi.fn<Agent['handleTurn']>(async (_id, text) => ({
      reply: `You said: ${text}`,
      pipeline: 'password_reset',
      state: 'ask_question',
      status: 'active',
      events: EVENTS,
    })),
    getSession: vi.fn<Agent['getSession']>(),
    sweep: vi.fn<Agent['sweep']>(async () => 0),
  };
  const audio: Buffer[] = [];
  const stopStt = vi.fn(async () => {});
  let failStt = (_err: unknown) => {};
  const stt = {
    audio: true,
    start: vi.fn<SttAdapter['start']>(() => {
      let emit = (_t: Transcript) => {};
      return {
        pushAudio(pcm) {
          audio.push(pcm);
          emit({ text: 'reset my', final: false });
          emit({ text: pcm.toString('utf8'), final: true });
        },
        onTranscript(cb) {
          emit = cb;
        },
        onError(cb) {
          failStt = cb;
        },
        stop: stopStt,
      };
    }),
  };
  const tts: TtsAdapter = {
    async *synthesize(text) {
      yield text;
      yield AUDIO;
    },
  };
  const app = buildServer({ agent, stt: realStt ?? stt, tts });
  app.log.level = 'silent';
  onTestFinished(() => app.close());
  return { app, agent, stt, audio, stopStt, failStt: (err: unknown) => failStt(err) };
}

const turn = (app: FastifyInstance, payload: object, remoteAddress?: string) =>
  app.inject({ method: 'POST', url: '/v1/turn', payload, remoteAddress });

describe('http api', () => {
  test('POST /v1/session answers 201 with the new session', async () => {
    const { app, agent } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/session', payload: { channel: 'voice' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ sessionId: SESSION_ID, reply: GREETING, pipeline: 'triage', state: 'greet' });
    expect(agent.createSession).toHaveBeenCalledWith('voice');
  });

  test('POST /v1/session defaults to the text channel and rejects unknown channels', async () => {
    const { app, agent } = setup();
    expect((await app.inject({ method: 'POST', url: '/v1/session' })).statusCode).toBe(201);
    expect(agent.createSession).toHaveBeenCalledWith('text');
    expect((await app.inject({ method: 'POST', url: '/v1/session', payload: { channel: 'fax' } })).statusCode).toBe(400);
  });

  test('POST /v1/turn answers 200 with the turn result', async () => {
    const { app, agent } = setup();
    const sessionId = randomUUID();
    const res = await turn(app, { sessionId, text: 'I forgot my password' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      reply: 'You said: I forgot my password',
      pipeline: 'password_reset',
      state: 'ask_question',
      status: 'active',
    });
    expect(agent.handleTurn).toHaveBeenCalledWith(sessionId, 'I forgot my password');
  });

  test.each([
    ['no text', { sessionId: randomUUID() }],
    ['empty text', { sessionId: randomUUID(), text: '' }],
    ['text over 2000 characters', { sessionId: randomUUID(), text: 'x'.repeat(2001) }],
    ['text with a NUL character', { sessionId: randomUUID(), text: 'hi\u0000' }],
    ['text with a lone surrogate', { sessionId: randomUUID(), text: 'hi \ud800' }],
    ['a session id that is not a uuid', { sessionId: 'abc', text: 'hi' }],
    ['malformed JSON', '{"sessionId":'],
  ])('POST /v1/turn answers 400 for %s', async (_case, payload) => {
    const { app, agent } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/turn', headers: { 'content-type': 'application/json' }, payload });
    expect(res.statusCode).toBe(400);
    expect(agent.handleTurn).not.toHaveBeenCalled();
  });

  test.each([
    { name: 'unknown', error: SessionNotFoundError, status: 404 },
    { name: 'expired', error: SessionExpiredError, status: 410 },
    { name: 'ended', error: SessionClosedError, status: 409 },
  ])('POST /v1/turn answers $status for an $name session', async ({ error, status }) => {
    const { app, agent } = setup();
    agent.handleTurn.mockRejectedValueOnce(new error('x'));
    expect((await turn(app, { sessionId: randomUUID(), text: 'hi' })).statusCode).toBe(status);
  });

  test('unexpected failures answer 500 without details', async () => {
    const { app, agent } = setup();
    agent.handleTurn.mockRejectedValueOnce(new Error('connect ECONNREFUSED secret-host'));
    const res = await turn(app, { sessionId: randomUUID(), text: 'hi' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret');
  });

  test('POST /v1/turn answers 429 past the per-session limit', async () => {
    freezeClock();
    vi.stubEnv('RATE_LIMIT_SESSION_PER_MIN', '2');
    const { app, agent } = setup();
    const [a, b] = [randomUUID(), randomUUID()];
    const codes = [];
    for (const sessionId of [a, a, a, b]) codes.push((await turn(app, { sessionId, text: 'hi' })).statusCode);
    expect(codes).toEqual([200, 200, 429, 200]);
    expect(agent.handleTurn).toHaveBeenCalledTimes(3);
  });

  test('POST /v1/turn answers 429 past the per-IP limit', async () => {
    freezeClock();
    vi.stubEnv('RATE_LIMIT_IP_PER_MIN', '2');
    const { app } = setup();
    const codes = [];
    for (const ip of ['10.0.0.1', '10.0.0.1', '10.0.0.1', '10.0.0.2']) {
      codes.push((await turn(app, { sessionId: randomUUID(), text: 'hi' }, ip)).statusCode);
    }
    expect(codes).toEqual([200, 200, 429, 200]);
  });

  test('new sessions count against the per-IP limit together with turns', async () => {
    freezeClock();
    vi.stubEnv('RATE_LIMIT_IP_PER_MIN', '2');
    const { app, agent } = setup();
    const session = (remoteAddress: string) => app.inject({ method: 'POST', url: '/v1/session', remoteAddress });
    const codes = [
      (await session('10.0.0.1')).statusCode,
      (await turn(app, { sessionId: randomUUID(), text: 'hi' }, '10.0.0.1')).statusCode,
      (await session('10.0.0.1')).statusCode,
      (await session('10.0.0.2')).statusCode,
    ];
    expect(codes).toEqual([201, 200, 429, 201]);
    expect(agent.createSession).toHaveBeenCalledTimes(2);
  });

  test('GET /healthz answers ok', async () => {
    const { app } = setup();
    expect((await app.inject('/healthz')).json()).toEqual({ ok: true });
  });

  test('GET / serves the browser test page', async () => {
    const { app } = setup();
    const res = await app.inject('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toContain('/v1/voice');
  });

  test('the page enables the mic only when the server takes audio, and otherwise points to the text box', async () => {
    const { app } = setup();
    const script = /<script>([\s\S]*)<\/script>/.exec((await app.inject('/')).body)![1];
    const elements: Record<string, any> = {};
    const document = {
      createElement: (tagName: string) => ({ tagName }),
      getElementById: (id: string) =>
        (elements[id] ??= { disabled: true, tagName: id === 'log' ? 'UL' : 'DIV', children: [], appendChild: (el: any) => (elements[id].children.push(el), el) }),
    };
    const onEvent = runInNewContext(`${script}; onEvent`, { document });
    onEvent({ type: 'session', sessionId: SESSION_ID, audio: false });
    expect([elements.mic.disabled, elements.text.disabled, elements.send.disabled]).toEqual([true, false, false]);
    expect(elements.transcript.children.at(-1).textContent).toContain('type in the box below');
    onEvent({ type: 'session', sessionId: SESSION_ID, audio: true });
    expect(elements.mic.disabled).toBe(false);
  });
});

describe('voice socket', () => {
  async function open(app: FastifyInstance) {
    await app.ready();
    const received: any[] = [];
    let closed!: Promise<void>;
    const ws = await app.injectWS('/v1/voice', {}, {
      onInit(ws) {
        ws.on('message', (data: Buffer, isBinary: boolean) => received.push(isBinary ? data : JSON.parse(data.toString())));
        closed = new Promise((resolve) => ws.on('close', () => resolve()));
      },
    });
    const replies = (n: number) => vi.waitFor(() => expect(received.filter((m) => m.type === 'audio_end')).toHaveLength(n));
    const say = (text: string) => ws.send(JSON.stringify({ type: 'text', text }));
    return { ws, received, closed, replies, say };
  }

  async function connect(app: FastifyInstance) {
    const call = await open(app);
    await call.replies(1);
    return call;
  }

  test('sends the session id, the greeting and its speech on connect', async () => {
    const { app, stt } = setup();
    const { received } = await connect(app);
    expect(received).toEqual([
      { type: 'session', sessionId: SESSION_ID, audio: true },
      { type: 'reply', text: GREETING },
      { type: 'tts_text', text: GREETING },
      AUDIO,
      { type: 'audio_end' },
    ]);
    expect(stt.start).toHaveBeenCalledWith(SESSION_ID);
  });

  test('a failed session start is reported and the socket closes', async () => {
    const { app, agent, stt } = setup();
    agent.createSession.mockRejectedValueOnce(new Error('connect ECONNREFUSED secret-host'));
    const { received, closed } = await open(app);
    await closed;
    expect(received).toEqual([{ type: 'error', message: 'Something went wrong. Please try again.' }]);
    expect(stt.start).not.toHaveBeenCalled();
  });

  test('a typed turn sends transcript, tool, state and reply events but never tool data', async () => {
    const { app, agent } = setup();
    const { received, replies, say } = await connect(app);
    say('I forgot my password');
    await replies(2);
    expect(agent.handleTurn).toHaveBeenCalledWith(SESSION_ID, 'I forgot my password');
    expect(received.slice(5)).toEqual([
      { type: 'transcript', text: 'I forgot my password', final: true },
      { type: 'tool', name: 'lookup_account', outcome: 'found' },
      { type: 'tool_rejected', name: 'reset_password', reason: 'not_allowed' },
      { type: 'state', pipeline: 'password_reset', state: 'ask_question', status: 'active' },
      { type: 'reply', text: 'You said: I forgot my password' },
      { type: 'tts_text', text: 'You said: I forgot my password' },
      AUDIO,
      { type: 'audio_end' },
    ]);
    expect(JSON.stringify(received)).not.toContain('secret');
  });

  test('binary audio goes to speech recognition and a final transcript becomes a turn', async () => {
    const { app, agent, audio } = setup();
    const { ws, received, replies } = await connect(app);
    ws.send(Buffer.from('reset my password'));
    await replies(2);
    expect(audio).toEqual([Buffer.from('reset my password')]);
    expect(received.slice(5, 7)).toEqual([
      { type: 'transcript', text: 'reset my', final: false },
      { type: 'transcript', text: 'reset my password', final: true },
    ]);
    expect(agent.handleTurn).toHaveBeenCalledExactlyOnceWith(SESSION_ID, 'reset my password');
  });

  test('a final transcript that is not valid turn text gets an error instead of a turn', async () => {
    const { app, agent } = setup();
    const { ws, received, replies, say } = await connect(app);
    ws.send(Buffer.from('x'.repeat(2001)));
    ws.send(Buffer.from('hi\u0000'));
    say('hello');
    await replies(2);
    expect(received.filter((m) => m.type === 'error')).toHaveLength(2);
    expect(agent.handleTurn).toHaveBeenCalledExactlyOnceWith(SESSION_ID, 'hello');
  });

  test('a frame over 64 KiB closes the socket before it reaches speech recognition', async () => {
    const { app, audio } = setup();
    const { ws, closed } = await connect(app);
    ws.send(Buffer.alloc(64 * 1024 + 1));
    await closed;
    expect(audio).toEqual([]);
  });

  test('with text speech recognition, binary frames get one error and never become turns', async () => {
    const { app, agent } = setup(createStt({}));
    const { ws, received, replies, say } = await connect(app);
    ws.send(Buffer.alloc(3200));
    ws.send(Buffer.alloc(3200));
    say('hello');
    await replies(2);
    expect(received[0]).toEqual({ type: 'session', sessionId: SESSION_ID, audio: false });
    expect(received.filter((m) => m.type === 'error' || m.type === 'transcript')).toEqual([
      { type: 'error', message: 'This server takes no audio (STT_PROVIDER=text). Send {"type":"text","text":"..."} instead.' },
      { type: 'transcript', text: 'hello', final: true },
    ]);
    expect(agent.handleTurn).toHaveBeenCalledExactlyOnceWith(SESSION_ID, 'hello');
  });

  test('a speech recognition failure is reported to the caller without details', async () => {
    const { app, failStt } = setup();
    const { received } = await connect(app);
    failStt(new Error('Could not load credentials from any providers'));
    await vi.waitFor(() => expect(received.at(-1)).toEqual({ type: 'error', message: 'Speech recognition is unavailable. Type instead.' }));
    expect(JSON.stringify(received)).not.toContain('credentials');
  });

  test('turns run one at a time in arrival order', async () => {
    const { app, agent } = setup();
    const { received, replies, say } = await connect(app);
    let release = () => {};
    agent.handleTurn.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { reply: 'First.', pipeline: 'triage', state: 'greet', status: 'active', events: [] };
    });
    say('one');
    say('two');
    await vi.waitFor(() => expect(received.filter((m) => m.type === 'transcript')).toHaveLength(2));
    await vi.waitFor(() => expect(agent.handleTurn).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agent.handleTurn).toHaveBeenCalledOnce();
    release();
    await replies(3);
    expect(received.filter((m) => m.type === 'reply').map((m) => m.text)).toEqual([GREETING, 'First.', 'You said: two']);
  });

  test('invalid messages get an error and the call goes on', async () => {
    const { app, agent } = setup();
    const { ws, received, replies, say } = await connect(app);
    for (const m of [
      'not json',
      '{"type":"hello"}',
      '{"type":"text","text":""}',
      JSON.stringify({ type: 'text', text: 'x'.repeat(2001) }),
      JSON.stringify({ type: 'text', text: 'hi\u0000' }),
      JSON.stringify({ type: 'text', text: 'hi \ud800' }),
    ]) {
      ws.send(m);
    }
    say('hello');
    await replies(2);
    expect(received.filter((m) => m.type === 'error')).toHaveLength(6);
    expect(agent.handleTurn).toHaveBeenCalledExactlyOnceWith(SESSION_ID, 'hello');
  });

  test('voice turns count against the per-session rate limit', async () => {
    freezeClock();
    vi.stubEnv('RATE_LIMIT_SESSION_PER_MIN', '1');
    const { app, agent } = setup();
    const { received, say } = await connect(app);
    say('one');
    say('two');
    await vi.waitFor(() => expect(received).toContainEqual({ type: 'error', message: LIMITED }));
    expect(agent.handleTurn).toHaveBeenCalledExactlyOnceWith(SESSION_ID, 'one');
  });

  test('voice connects count against the per-IP rate limit', async () => {
    freezeClock();
    vi.stubEnv('RATE_LIMIT_IP_PER_MIN', '1');
    const { app, agent } = setup();
    await connect(app);
    const { received, closed } = await open(app);
    await closed;
    expect(received).toEqual([{ type: 'error', message: LIMITED }]);
    expect(agent.createSession).toHaveBeenCalledOnce();
  });

  test.each([
    { name: 'unknown', error: SessionNotFoundError, message: 'Session not found.' },
    { name: 'expired', error: SessionExpiredError, message: 'Session expired after 10 idle minutes.' },
    { name: 'ended', error: SessionClosedError, message: 'Session has ended.' },
  ])('an $name session is reported and the socket closes', async ({ error, message }) => {
    const { app, agent } = setup();
    const { received, closed, say } = await connect(app);
    agent.handleTurn.mockRejectedValueOnce(new error('x'));
    say('hello');
    await closed;
    expect(received.at(-1)).toEqual({ type: 'error', message });
  });

  test('an unexpected failure is reported without details and the call goes on', async () => {
    const { app, agent } = setup();
    const { received, replies, say } = await connect(app);
    agent.handleTurn.mockRejectedValueOnce(new Error('connect ECONNREFUSED secret-host'));
    say('one');
    say('two');
    await replies(2);
    expect(received).toContainEqual({ type: 'error', message: 'Something went wrong. Please try again.' });
    expect(JSON.stringify(received)).not.toContain('secret');
    expect(agent.handleTurn).toHaveBeenCalledTimes(2);
  });

  test('the socket closes after the goodbye when the call ends', async () => {
    const { app, agent } = setup();
    const { received, closed, say } = await connect(app);
    agent.handleTurn.mockResolvedValueOnce({ reply: 'Goodbye.', pipeline: 'triage', state: 'closing', status: 'ended', events: [] });
    say('bye');
    await closed;
    expect(received.slice(-3)).toEqual([{ type: 'tts_text', text: 'Goodbye.' }, AUDIO, { type: 'audio_end' }]);
  });

  test('a dropped connection stops speech recognition', async () => {
    const { app, stopStt } = setup();
    const { ws } = await connect(app);
    ws.terminate();
    await vi.waitFor(() => expect(stopStt).toHaveBeenCalledOnce());
  });
});
