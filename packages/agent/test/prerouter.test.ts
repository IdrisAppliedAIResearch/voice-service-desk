import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '@vsd/db';
import { createScriptedLlm } from '../src/llm/index';
import { preRoute } from '../src/prerouter';
import type { AgentEvent } from '../src/types';
import { auditEvents, createFixtureUser, testAgent, ticketsFor, toolSession, type FixtureUser } from './core-fixtures';

let standard: FixtureUser;
let vip: FixtureUser;
beforeAll(async () => {
  [standard, vip] = await Promise.all([createFixtureUser(), createFixtureUser({ vip: true })]);
});
afterAll(closePools);

async function route(transcript: string, setup: (s: Awaited<ReturnType<typeof toolSession>>['s']) => void = () => {}) {
  const t = await toolSession();
  setup(t.s);
  const events: AgentEvent[] = [];
  await preRoute(t.ctx, transcript, events);
  return { ...t, events };
}

const spokenEmail = (u: FixtureUser) => `fx dot ${u.username.slice(2)} at contoso dash health dot example`;

describe('pre-router: executive accounts', () => {
  it.each([
    ['a spaced employee id', (u: FixtureUser) => `Hi, my employee ID is ${u.employee_id[0]} ${u.employee_id.slice(1).split('').join(' ')} and the VPN is down`],
    ['a dashed employee id', (u: FixtureUser) => `This is ${u.employee_id[0].toLowerCase()}-${u.employee_id.slice(1)}. I forgot my password.`],
    ['a digit-by-digit dashed employee id', (u: FixtureUser) => `It's ${u.employee_id.split('').join('-')}, I forgot my password.`],
    ['a written email', (u: FixtureUser) => `my email is ${u.email.toUpperCase()}.`],
    ['a spoken email', (u: FixtureUser) => `sure it's ${spokenEmail(u)} thanks`],
  ])('hands off silently on %s, before any intent routing', async (_, say) => {
    const { s, events } = await route(say(vip));
    expect(events).toEqual([{ type: 'prerouter', action: 'vip_handoff', pipeline: 'vip' }]);
    expect([s.pipeline, s.state]).toEqual(['vip', 'ask_question']);
    expect(s.candidate).toMatchObject({ userId: vip.id, isVip: true, token: expect.any(String) });
    expect(await ticketsFor(s.id)).toMatchObject([{ user_id: vip.id, priority: 'P3', category: 'executive-support' }]);
    const audit = (await auditEvents(s.id)).map((e) => e.event);
    expect(audit).toContain('vip_handoff');
    expect(audit).not.toContain('prerouter_intent');
  });

  it('leaves standard and unknown identifiers for the model', async () => {
    for (const transcript of [`it is ${standard.email}`, `my id is ${standard.employee_id}`, 'it is nobody at contoso dash health dot example']) {
      const { s, events } = await route(transcript, (s) => Object.assign(s, { pipeline: 'password_reset', state: 'collect_identifier' }));
      expect(events).toEqual([]);
      expect(s.candidate).toBeUndefined();
      expect(s.state).toBe('collect_identifier');
    }
  });

  it('does nothing once a candidate is set or the session is no longer active', async () => {
    const withCandidate = await route(`my email is ${vip.email}`, (s) => {
      s.candidate = { token: 't', userId: null, isVip: false, decoyKey: '00' };
    });
    expect(withCandidate.events).toEqual([]);
    expect(withCandidate.s.pipeline).toBe('triage');
    const escalated = await route(`my email is ${vip.email}, I forgot my password`, (s) => {
      s.status = 'escalated';
    });
    expect(escalated.events).toEqual([]);
    expect([escalated.s.pipeline, escalated.s.candidate]).toEqual(['triage', undefined]);
  });

  it('engages the full verification through the turn loop while the caller asked a general question', async () => {
    const llm = createScriptedLlm([{ tool: { name: 'get_next_security_question' } }, { say: 'Before we start, a quick question.' }]);
    const agent = testAgent({ llm });
    const { sessionId } = await agent.createSession('voice');
    const r = await agent.handleTurn(sessionId, `How do I connect to the VPN? My employee ID is ${vip.employee_id}.`);
    expect(r).toMatchObject({ pipeline: 'vip', state: 'await_answer', status: 'active' });
    expect(r.events[0]).toEqual({ type: 'prerouter', action: 'vip_handoff', pipeline: 'vip' });
    expect(llm.calls.map((c) => c.tools.map((t) => t.name))).toEqual([['get_next_security_question'], []]);
    const block = llm.calls[0].messages.at(-1)!.content;
    expect(block).toContain('pipeline=account_verification');
    expect(block).not.toMatch(/\bvip\b|executive/i);
  });
});

describe('pre-router: intents', () => {
  it.each([
    ['I forgot my password', 'password_reset'],
    ['I need to reset the password on my laptop', 'password_reset'],
    ['my password expired this morning', 'password_reset'],
    ["I can't remember my username", 'username_recovery'],
    ['I forgot my username and my password', 'password_reset'],
    ['What is the status of my ticket?', 'ticket_status'],
    ['any update on my case', 'ticket_status'],
    ['How do I connect to the VPN from home?', 'general_help'],
    ['Outlook keeps crashing', 'general_help'],
  ] as const)('routes "%s" to %s', async (transcript, pipeline) => {
    const { s, events } = await route(transcript);
    expect(events).toEqual([{ type: 'prerouter', action: 'start_pipeline', pipeline }]);
    expect(s.pipeline).toBe(pipeline);
    expect(s.state).toBe(pipeline === 'general_help' ? 'answer' : 'collect_identifier');
    expect((await auditEvents(s.id)).find((e) => e.event === 'prerouter_intent')?.detail).toEqual({ pipeline });
  });

  it.each(['Hello', 'What is the password policy?', 'I want to talk to a person'])('leaves "%s" to the model', async (transcript) => {
    const { s, events } = await route(transcript);
    expect(events).toEqual([]);
    expect([s.pipeline, s.state]).toEqual(['triage', 'greet']);
  });

  it('only routes from triage/greet', async () => {
    const { s, events } = await route('I forgot my password', (s) => Object.assign(s, { pipeline: 'general_help', state: 'answer' }));
    expect(events).toEqual([]);
    expect(s.pipeline).toBe('general_help');
  });
});
