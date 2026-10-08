import { randomUUID } from 'node:crypto';
import { QUESTION_POOL, getPool, hashSecret, normalizeAnswer } from '@vsd/db';
import { createAgent } from '../src/session';
import type { ToolContext } from '../src/tools';
import type { AgentDeps, LlmAdapter, Session } from '../src/types';

export const db = getPool();

export interface FixtureUser {
  id: string;
  username: string;
  email: string;
  employee_id: string;
  questions: { text: string; answer: string }[];
  answerFor: (question: string) => string;
  pin: string;
}

const QUESTIONS = [
  { text: QUESTION_POOL[0].text, answer: 'Biscuit' },
  { text: QUESTION_POOL[3].text, answer: 'Honda Civic' },
  { text: QUESTION_POOL[5].text, answer: 'St. Louis' },
];

export async function createFixtureUser(opts: { vip?: boolean; locked?: boolean } = {}): Promise<FixtureUser> {
  const tag = randomUUID().replaceAll('-', '').slice(0, 10);
  const username = `fx${tag}`;
  const email = `fx.${tag}@contoso-health.example`;
  // Employee ids look like seeded ones (E + 5 digits) so the pre-router can find them; pick one not in use.
  const { rows } = await db.query<{ id: string; employee_id: string }>(
    `INSERT INTO servicedesk.users (username, email, employee_id, first_name, last_name, department, title, phone_last4, is_vip, is_locked)
     SELECT $1, $2, 'E' || n, 'Fixture', $3, 'IT', $4, '7003', $5, $6
     FROM generate_series(10000, 99999) n
     WHERE NOT EXISTS (SELECT 1 FROM servicedesk.users u WHERE u.employee_id = 'E' || n)
     ORDER BY random() LIMIT 1
     RETURNING id, employee_id`,
    [username, email, tag, opts.vip ? 'Chief Executive Officer' : 'Analyst', !!opts.vip, !!opts.locked],
  );
  const { id, employee_id } = rows[0];
  for (const [i, q] of QUESTIONS.entries()) {
    await db.query(
      'INSERT INTO servicedesk.security_questions (user_id, question_text, answer_hash, position) VALUES ($1, $2, $3, $4)',
      [id, q.text, await hashSecret(normalizeAnswer(q.answer)), i + 1],
    );
  }
  const pin = '482913';
  if (opts.vip) {
    await db.query(
      `INSERT INTO servicedesk.vip_profiles (user_id, pin_hash, executive_assistant_name, assistant_phone_last4, callback_phone_last4)
       VALUES ($1, $2, 'Pat Assistant', '7001', '7002')`,
      [id, await hashSecret(pin)],
    );
  }
  const answerFor = (question: string) => QUESTIONS.find((q) => q.text === question)!.answer;
  return { id, username, email, employee_id, questions: QUESTIONS, answerFor, pin };
}

export function testClock() {
  let t = Date.parse('2026-10-07T12:00:00Z');
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

const noLlm: LlmAdapter = {
  name: 'none',
  complete: () => Promise.reject(new Error('no LLM in this test')),
};

export function testAgent(deps: Partial<AgentDeps> = {}) {
  return createAgent({ db, llm: noLlm, retrieve: async () => [], ...deps });
}

// A live session plus the context a tool handler receives, for calling handlers directly.
export async function toolSession(deps: Partial<AgentDeps> = {}): Promise<{ s: Session; ctx: ToolContext }> {
  const now = deps.now ?? (() => new Date());
  const agent = testAgent({ ...deps, now });
  const { sessionId } = await agent.createSession('text');
  const s = agent.getSession(sessionId)!;
  return { s, ctx: { db, now, retrieve: deps.retrieve ?? (async () => []), s } };
}

export async function auditEvents(sessionId: string): Promise<{ event: string; user_id: string | null; detail: Record<string, unknown> }[]> {
  const { rows } = await db.query('SELECT event, user_id, detail FROM servicedesk.audit_log WHERE session_id = $1 ORDER BY id', [sessionId]);
  return rows;
}

export async function ticketsFor(sessionId: string): Promise<{ id: number; user_id: string | null; priority: string; category: string; summary: string }[]> {
  const { rows } = await db.query(
    'SELECT id, user_id, priority, category, summary FROM servicedesk.tickets WHERE session_id = $1 ORDER BY id',
    [sessionId],
  );
  return rows;
}
