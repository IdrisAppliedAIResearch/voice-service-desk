import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import {
  createAgent,
  createScriptedLlm,
  FALLBACK_REPLY,
  type AgentEvent,
  type LlmAdapter,
  type ScriptedResponse,
  type Session,
} from '../../packages/agent/src/index';
import { buildSeedData, getPool, normalizeAnswer, QUESTION_POOL } from '../../packages/db/src/index';
import { retrieve } from '../../packages/rag/src/index';
import { createStt, createTts, type SttStream } from '../../packages/speech/src/index';

interface Expect {
  // Mode-independent: they hold for any model that lets the caller get as far as the scenario does.
  session?: Record<string, unknown>; // sessions row of the current session; a list means any of
  user?: { is_locked?: boolean; must_change_password?: boolean; locked_until?: number | null }; // minutes after the clock
  outbox?: string[]; // "<channel> <masked destination>" of every outbox row created in this scenario
  tickets?: string[]; // "<priority> <category> linked|unlinked" of the current session, in order
  audit?: { present?: string[]; absent?: string[] }; // "<event> [key=value ...]" of the current session
  kb?: { includes?: string[]; excludes?: string[]; below_threshold?: boolean }; // slugs, against search_kb results
  questions_from_pool?: boolean;
  not_mentioned?: string[]; // in no reply or tool result of this scenario
  // Scripted only. Except for same_path_as they describe the latest caller turn.
  events?: string[];
  offered?: string[][];
  fallback_reply?: boolean; // the line code speaks for an unusable model: the pending question, else FALLBACK_REPLY
  same_path_as?: string;
}

interface Step {
  caller?: string;
  model?: ScriptedResponse[];
  expect_error?: string;
  advance_minutes?: number;
  new_session?: string;
  expect?: Expect;
}

export interface Scenario {
  name: string;
  user?: string;
  local: boolean;
  steps: Step[];
}

interface Run {
  name: string;
  id: string;
  s: Session;
  stream: SttStream;
  heard: (text: string) => void;
  replies: string[];
  events: AgentEvent[];
}

const START = Date.parse('2026-10-07T12:00:00Z');
const WRONG_ANSWER = 'Springfield';
const UUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g;
const UNSPEAKABLE = /[*_#`~|<>[\]{}\\\n]|https?:\/\/|www\.|\.(?:example|com|org|net|gov)\b/i;
const POOL = QUESTION_POOL.map((q) => q.text);
const DIR = new URL('./', import.meta.url);
const stt = createStt({ STT_PROVIDER: 'text' });
const tts = createTts({ TTS_PROVIDER: 'text' });

export function loadScenarios(): Scenario[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => ({ name: f.slice(0, -5), ...parse(readFileSync(new URL(f, DIR), 'utf8')) }));
}

const label = (e: AgentEvent) =>
  e.type === 'tool'
    ? `${e.name} ${e.outcome}`
    : e.type === 'tool_rejected'
      ? `${e.name} ${e.reason}`
      : e.type === 'prerouter'
        ? `prerouter ${e.action} ${e.pipeline}`
        : e.type;

const same = (actual: unknown, expected: unknown, what: string) =>
  assert.ok(isDeepStrictEqual(actual, expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const otherDigits = (digits: string) => String((Number(digits) + 1) % 1e6).padStart(6, '0');
const alnum = (s: string) => s.replace(/[^\dA-Za-z]/g, '');

// What a session revealed through its tools, minus the random candidate token.
const path = (r: Run) => [
  r.events.filter((e) => e.type === 'tool').map(label),
  r.s.history.flatMap((m) => (m.role === 'tool' && /^(lookup_account|verify_)/.test(m.name) ? [m.content.replace(UUID, 'token')] : [])),
];

async function speak(text: string): Promise<string> {
  let spoken = '';
  for await (const frame of tts.synthesize(text)) spoken += frame;
  return spoken;
}

// Scripted mode when `live` is omitted; otherwise `live` answers and only mode-independent expectations run.
export async function runScenario(scenario: Scenario, live?: LlmAdapter): Promise<void> {
  const db = getPool();
  const scripted = live ? undefined : createScriptedLlm();
  const calls = scripted?.calls ?? [];
  const llm: LlmAdapter = live
    ? { name: live.name, complete: (messages, tools) => (calls.push({ messages, tools }), live.complete(messages, tools)) }
    : scripted!;
  let clock = START;
  const agent = createAgent({ db, llm, now: () => new Date(clock) });
  const user = buildSeedData().users.find((u) => u.username === scenario.user);
  assert.ok(!scenario.user || user, `no seed user ${scenario.user}`);
  const userId: string | undefined =
    user &&
    (
      await db.query(
        'UPDATE servicedesk.users SET is_locked = $2, locked_until = NULL, must_change_password = false WHERE username = $1 RETURNING id',
        [user.username, user.is_locked],
      )
    ).rows[0].id;
  const outboxStart: number = (await db.query('SELECT coalesce(max(id), 0) AS id FROM servicedesk.outbox')).rows[0].id;
  const secrets = user ? [...user.questions.map((q) => q.answer), user.vip?.pin].flatMap((s) => (s ? [normalizeAnswer(s)] : [])) : [];
  const runs: Run[] = [];
  let said = '';
  let checked = 0;
  let last = { events: [] as AgentEvent[], calls: [] as typeof calls, reply: '' };

  async function open(name: string): Promise<Run> {
    const { sessionId, reply } = await agent.createSession('text');
    const run: Run = {
      name,
      id: sessionId,
      s: agent.getSession(sessionId)!,
      stream: stt.start(sessionId),
      heard: () => {},
      replies: [await speak(reply)],
      events: [],
    };
    run.stream.onTranscript((t) => t.final && run.heard(t.text));
    return run;
  }

  const hear = (run: Run, line: string) =>
    new Promise<string>((resolve) => {
      run.heard = resolve;
      run.stream.pushAudio(Buffer.from(line));
    });

  async function placeholder(key: string, run: Run): Promise<string> {
    if (key === 'wrong_answer') return WRONG_ANSWER;
    assert.ok(user, `{{${key}}} needs a scenario user`);
    if (key === 'answer') {
      const q = run.s.pendingQuestion;
      assert.ok(q && run.s.candidate?.userId === userId, '{{answer}}: no security question of the scenario user is pending');
      return user.questions.find((x) => x.text === q.text)!.answer;
    }
    if (key === 'pin' || key === 'wrong_pin') {
      assert.ok(user.vip, `{{${key}}} needs a VIP user`);
      return key === 'pin' ? user.vip.pin : otherDigits(user.vip.pin);
    }
    if (key === 'otp' || key === 'wrong_otp') {
      const { rows } = await db.query<{ body: string }>(
        "SELECT body FROM servicedesk.outbox WHERE id > $1 AND user_id = $2 AND channel = 'sms' ORDER BY id DESC",
        [outboxStart, userId],
      );
      const otp = rows.map((r) => /code: (\d{6})/.exec(r.body)?.[1]).find(Boolean);
      assert.ok(otp, `{{${key}}}: no one-time code was sent in this scenario`);
      return key === 'otp' ? otp : otherDigits(otp);
    }
    const field: unknown = user[key as keyof typeof user];
    assert.ok(typeof field === 'string', `unknown placeholder {{${key}}}`);
    return field;
  }

  async function fill<T>(value: T, run: Run): Promise<T> {
    let json = JSON.stringify(value);
    for (const key of new Set(Array.from(json.matchAll(/\{\{(\w+)\}\}/g), (m) => m[1])))
      json = json.replaceAll(`{{${key}}}`, JSON.stringify(await placeholder(key, run)).slice(1, -1));
    return JSON.parse(json);
  }

  async function turn(run: Run, step: Step): Promise<void> {
    scripted?.push(...(step.model ?? []));
    const given = scripted?.remaining();
    const before = calls.length;
    const transcript = await hear(run, step.caller!);
    said += ` ${normalizeAnswer(transcript)}`;
    const result = await agent.handleTurn(run.id, transcript).catch((e: Error) => {
      if (e.message === 'scripted LLM exhausted') throw new Error(`the agent needed more than the ${given} scripted responses given`);
      if (e.constructor.name !== step.expect_error) throw e;
    });
    assert.ok(!step.expect_error || !result, `expected ${step.expect_error}`);
    assert.ok(!scripted?.remaining(), `${scripted?.remaining()} of the ${given} scripted responses were not used`);
    last = { events: result?.events ?? [], calls: calls.slice(before), reply: result ? await speak(result.reply) : '' };
    run.events.push(...last.events);
    if (result) run.replies.push(last.reply);
  }

  async function check(run: Run, x: Expect): Promise<void> {
    if (x.session) {
      const { rows } = await db.query('SELECT * FROM servicedesk.sessions WHERE id = $1', [run.id]);
      for (const [key, want] of Object.entries(x.session))
        assert.ok([want].flat().includes(rows[0][key]), `session ${key}: expected ${want}, got ${rows[0][key]}`);
    }
    if (x.user) {
      const { rows } = await db.query('SELECT is_locked, must_change_password, locked_until FROM servicedesk.users WHERE id = $1', [userId]);
      rows[0].locked_until &&= Math.round((rows[0].locked_until.getTime() - clock) / 60_000);
      for (const [key, want] of Object.entries(x.user)) same(rows[0][key], want, `user ${key}`);
    }
    if (x.outbox) {
      const { rows } = await db.query('SELECT channel, destination_masked FROM servicedesk.outbox WHERE id > $1', [outboxStart]);
      same(rows.map((r) => `${r.channel} ${r.destination_masked}`).sort(), [...x.outbox].sort(), 'outbox');
    }
    if (x.tickets) {
      const { rows } = await db.query('SELECT priority, category, user_id FROM servicedesk.tickets WHERE session_id = $1 ORDER BY id', [run.id]);
      const link = (id: string | null) => (id === null ? 'unlinked' : id === userId ? 'linked' : id);
      same(rows.map((r) => `${r.priority} ${r.category} ${link(r.user_id)}`), x.tickets, 'tickets');
    }
    if (x.audit) {
      const { rows } = await db.query('SELECT event, detail FROM servicedesk.audit_log WHERE session_id = $1', [run.id]);
      const logged = rows.map((r) => [r.event, ...Object.entries(r.detail).map(([k, v]) => `${k}=${v}`)]);
      for (const want of x.audit.present ?? []) {
        const [event, ...details] = want.split(' ');
        assert.ok(logged.some(([e, ...d]) => e === event && details.every((p) => d.includes(p))), `audit: no ${want}`);
      }
      for (const event of x.audit.absent ?? []) assert.ok(!logged.some(([e]) => e === event), `audit: unexpected ${event}`);
    }
    if (x.kb) {
      const searches = run.s.history.flatMap((m, i) => {
        const call = run.s.history[i - 1];
        const data = m.role === 'tool' && m.name === 'search_kb' ? JSON.parse(m.content) : {};
        if (!data.articles || call.role !== 'assistant') return [];
        return [{ query: JSON.parse(call.toolCall!.arguments).query as string, titles: data.articles.map((a: { title: string }) => a.title) as string[] }];
      });
      assert.ok(searches.length, 'kb: search_kb returned no result in this session');
      const titles = searches.flatMap((s) => s.titles);
      const title = async (slug: string) => {
        const { rows } = await db.query('SELECT title FROM servicedesk.kb_articles WHERE slug = $1', [slug]);
        assert.ok(rows.length, `kb: no article ${slug}`);
        return rows[0].title;
      };
      for (const slug of x.kb.includes ?? []) assert.ok(titles.includes(await title(slug)), `kb: ${slug} was not returned`);
      for (const slug of x.kb.excludes ?? []) assert.ok(!titles.includes(await title(slug)), `kb: ${slug} was returned`);
      for (const s of x.kb.below_threshold ? searches : []) {
        same(s.titles, [], 'kb titles');
        assert.ok((await retrieve(db, s.query, { minScore: 0 })).length, `kb: "${s.query}" shares no word with the knowledge base`);
      }
    }
    if (x.questions_from_pool) {
      const asked = run.s.history.flatMap((m) => (m.role === 'tool' && m.name === 'get_next_security_question' ? [JSON.parse(m.content).question] : []));
      assert.ok(asked.length && asked.every((q) => POOL.includes(q)), `questions not from the pool: ${JSON.stringify(asked)}`);
    }
    if (x.not_mentioned) {
      const visible = JSON.stringify(runs.map((r) => [r.replies, r.s.history.filter((m) => m.role === 'tool')])).toLowerCase();
      for (const word of x.not_mentioned) assert.ok(!visible.includes(word.toLowerCase()), `"${word}" appears in a reply or tool result`);
    }
    if (!scripted) return;
    if (x.events) same(last.events.filter((e) => e.type !== 'state').map(label), x.events, 'events');
    if (x.offered) same(last.calls.map((c) => c.tools.map((t) => t.name)), x.offered, 'offered tools');
    if (x.fallback_reply) same(last.reply, run.s.pendingQuestion?.text ?? FALLBACK_REPLY, 'reply');
    if (x.same_path_as) {
      const other = runs.find((r) => r.name === x.same_path_as);
      assert.ok(other, `no session ${x.same_path_as}`);
      same(path(run), path(other), `tool path versus ${x.same_path_as}`);
    }
  }

  // Safety invariants, after every step whatever the scenario expects. Secrets are compared as letters and digits
  // only, so a password the post-processor stripped of symbols or a code read out digit by digit still counts.
  async function invariants(): Promise<void> {
    const { rows } = await db.query<{ body: string }>('SELECT body FROM servicedesk.outbox WHERE id > $1', [outboxStart]);
    const bodies = rows.map((r) => r.body).join('\n');
    const passwords = Array.from(bodies.matchAll(/Temporary password: (\S+)/g), (m) => alnum(m[1]));
    const codes = Array.from(bodies.matchAll(/code: (\d{6})/g), (m) => m[1]);
    const audit = (await db.query('SELECT detail FROM servicedesk.audit_log WHERE session_id = ANY($1)', [runs.map((r) => r.id)])).rows;
    // The caller reads a one-time code back, so their words and the tool arguments copied from them may hold one.
    const callerWords = alnum(
      JSON.stringify(runs.map((r) => r.s.history.map((m) => (m.role === 'user' ? m.content : m.role === 'assistant' ? m.toolCall?.arguments : '')))),
    );
    const agentWords = alnum(
      JSON.stringify([audit, runs.map((r) => [r.replies, r.events, r.s.history.map((m) => (m.role === 'user' ? '' : m.content))])]),
    );
    for (const pw of passwords)
      assert.ok(!agentWords.includes(pw) && !callerWords.includes(pw), 'a temporary password appears in a reply, the history, an event or the audit log');
    for (const code of codes) assert.ok(!agentWords.includes(code), 'a one-time code appears in a reply, the history, an event or the audit log');
    const auditText = normalizeAnswer(JSON.stringify(audit));
    assert.ok(!secrets.some((s) => auditText.includes(s)), 'a stored answer or PIN appears in the audit log');
    for (const reply of runs.flatMap((r) => r.replies)) assert.ok(!UNSPEAKABLE.test(reply), `reply is not speakable: ${reply}`);
    for (const call of calls.slice(checked)) {
      const request = JSON.stringify(call);
      assert.ok(!passwords.some((pw) => alnum(request).includes(pw)), 'a temporary password was sent to the model');
      assert.ok(!request.includes('$argon2'), 'an argon2 hash was sent to the model');
      const normalized = normalizeAnswer(request);
      assert.ok(!secrets.some((s) => normalized.includes(s) && !said.includes(s)), 'a stored answer the caller had not said was sent to the model');
    }
    checked = calls.length;
  }

  runs.push(await open('first'));
  for (const [i, raw] of scenario.steps.entries()) {
    try {
      if (raw.new_session) runs.push(await open(raw.new_session));
      clock += (raw.advance_minutes ?? 0) * 60_000;
      const run = runs[runs.length - 1];
      const step = await fill({ ...raw, model: scripted && raw.model }, run);
      if (step.caller !== undefined) await turn(run, step);
      if (step.expect) await check(run, step.expect);
      await invariants();
    } catch (e) {
      throw new Error(`step ${i + 1}${raw.caller === undefined ? '' : ` "${raw.caller}"`}: ${(e as Error).message}`);
    }
  }
}
