import { createInterface } from 'node:readline';
import { styleText } from 'node:util';
import {
  checkLlmHealth,
  createAgent,
  createLlmAdapter,
  SessionClosedError,
  SessionExpiredError,
  SessionNotFoundError,
} from '@vsd/agent';
import { closePools, getPool, listOutbox, loadEnv } from '@vsd/db';
import { createStt, createTts, type SttStream } from '@vsd/speech';
import { formatOutbox } from './outbox';

loadEnv();
try {
  await checkLlmHealth();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const db = getPool();
const agent = createAgent({ db, llm: createLlmAdapter() });
const stt = createStt({ ...process.env, STT_PROVIDER: 'text' });
const tts = createTts({ ...process.env, TTS_PROVIDER: 'text' });
let sessionId = '';
let stream: SttStream | undefined;
let heard = (_text: string) => {};

async function say(text: string) {
  for await (const frame of tts.synthesize(text)) if (typeof frame === 'string') console.log(`agent> ${frame}`);
}

async function newSession() {
  await stream?.stop();
  const session = await agent.createSession('text');
  sessionId = session.sessionId;
  stream = stt.start(sessionId);
  stream.onTranscript((t) => {
    if (t.final) heard(t.text);
  });
  await say(session.reply);
}

async function turn(line: string) {
  const text = await new Promise<string>((resolve) => {
    heard = resolve;
    stream!.pushAudio(Buffer.from(line));
  });
  const r = await agent.handleTurn(sessionId, text);
  await say(r.reply);
  const tools = r.events.flatMap((e) =>
    e.type === 'tool' ? [`${e.name} ${e.outcome}`] : e.type === 'tool_rejected' ? [`${e.name} rejected (${e.reason})`] : [],
  );
  console.log(styleText('dim', [`${r.pipeline}/${r.state} ${r.status}`, ...tools].join(' | ')));
}

function showState() {
  const s = agent.getSession(sessionId);
  if (!s) return console.log('No session. Type /new to start one.');
  const { pipeline, state, status, verified, answersPassed, failedAttempts, questionsPassed, pinPassed } = s;
  console.log({ pipeline, state, status, verified, answersPassed, failedAttempts, questionsPassed, pinPassed });
}

function explain(e: unknown): string {
  if (e instanceof SessionExpiredError) return 'This session expired after 10 idle minutes. Type /new to start a new one.';
  if (e instanceof SessionClosedError) return 'This call has ended. Type /new to start a new one.';
  if (e instanceof SessionNotFoundError) return 'This session no longer exists. Type /new to start a new one.';
  return `Error: ${e instanceof Error ? e.message : String(e)}`;
}

console.log(styleText('dim', 'Type what the caller says. Commands: /state, /outbox, /new, /quit'));
await newSession();
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
let closed = false;
rl.on('close', () => (closed = true)).prompt();
for await (const line of rl) {
  const input = line.trim();
  if (input === '/quit') break;
  try {
    if (input === '/new') await newSession();
    else if (input === '/state') showState();
    else if (input === '/outbox') console.log(formatOutbox(await listOutbox(db, { limit: 5 })));
    else if (input) await turn(input);
  } catch (e) {
    console.log(styleText('red', explain(e)));
  }
  if (!closed) rl.prompt();
}
rl.close();
await stream?.stop();
await closePools();
