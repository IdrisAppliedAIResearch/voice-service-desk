import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUESTION_POOL, closePools, getUser, listOutbox } from '@vsd/db';
import type { StartablePipeline } from '@vsd/pipelines';
import { TOOLS, isVerifiedFor, normalizeIdentifier, runTool, toolSpecs, type ToolContext, type ToolResult } from '../src/tools';
import type { AgentDeps } from '../src/types';
import { auditEvents, createFixtureUser, db, testClock, ticketsFor, toolSession, type FixtureUser } from './core-fixtures';

const GATED = ['reset_password', 'recover_username', 'get_ticket_status'] as const;
const MINUTE = 60_000;
let standard: FixtureUser;
let vip: FixtureUser;

beforeAll(async () => {
  [standard, vip] = await Promise.all([createFixtureUser(), createFixtureUser({ vip: true })]);
});
afterAll(closePools);

async function flow(pipeline: StartablePipeline, identifier: string, deps: Partial<AgentDeps> = {}) {
  const t = await toolSession(deps);
  await runTool(t.ctx, 'start_pipeline', { name: pipeline });
  const lookup = await runTool(t.ctx, 'lookup_account', { identifier });
  return { ...t, lookup };
}

async function ask(ctx: ToolContext): Promise<string> {
  return ((await runTool(ctx, 'get_next_security_question', {})).data as { question: string }).question;
}

async function answer(ctx: ToolContext, user: FixtureUser | null, correct: boolean): Promise<ToolResult> {
  const question = await ask(ctx);
  return runTool(ctx, 'verify_security_answer', { answer: correct && user ? user.answerFor(question) : 'Definitely Wrong' });
}

// Tests that end in a lockout use their own executive: a lockout locks the account.
async function passQuestionsAndPin(ctx: ToolContext, user = vip) {
  await answer(ctx, user, true);
  expect((await answer(ctx, user, true)).outcome).toBe('complete');
  expect(await runTool(ctx, 'verify_vip_pin', { pin: 'four eight two, nine one three' })).toEqual({
    outcome: 'pass',
    data: { result: 'pass', attempts_remaining: 2 },
  });
}

async function latestCode(user = vip): Promise<string> {
  const [row] = await listOutbox(db, { user_id: user.id, limit: 1 });
  return /code: (\d{6})\./.exec(row.body)![1];
}

async function expectGatesHold(ctx: ToolContext, user: FixtureUser) {
  const outboxBefore = (await listOutbox(db, { user_id: user.id })).length;
  for (const name of GATED) expect(await runTool(ctx, name, {})).toEqual({ outcome: 'denied', data: { error: 'not_verified' } });
  const denied = (await auditEvents(ctx.s.id)).filter((e) => e.event === 'gate_denied').map((e) => e.detail.tool);
  expect(denied).toEqual(expect.arrayContaining([...GATED]));
  expect((await listOutbox(db, { user_id: user.id })).length).toBe(outboxBefore);
  expect(await getUser(db, user.id)).toMatchObject({ must_change_password: false });
  expect(isVerifiedFor(ctx.s)).toBe(false);
}

describe('gated actions deny unless the session is verified for the account', () => {
  it('with no candidate', async () => {
    const { ctx } = await toolSession();
    await expectGatesHold(ctx, standard);
  });

  it('with a real candidate that passed one question', async () => {
    const { ctx } = await flow('password_reset', standard.email);
    expect((await answer(ctx, standard, true)).outcome).toBe('pass');
    await expectGatesHold(ctx, standard);
  });

  it('for a decoy, even when the session flag is forced on', async () => {
    const { ctx, s } = await flow('password_reset', `nobody.${standard.username}@contoso-health.example`);
    s.verified = true;
    await expectGatesHold(ctx, standard);
  });

  it('for an executive who passed the questions only', async () => {
    const { ctx } = await flow('password_reset', vip.email);
    await answer(ctx, vip, true);
    await answer(ctx, vip, true);
    await expectGatesHold(ctx, vip);
  });

  it('for an executive who passed the questions and the PIN', async () => {
    const { ctx, s } = await flow('password_reset', vip.email);
    await passQuestionsAndPin(ctx);
    expect(s.verified).toBe(false);
    await expectGatesHold(ctx, vip);
  });

  it('for an executive whose verified flag is forced on without the PIN', async () => {
    const { ctx, s } = await flow('password_reset', vip.email);
    await answer(ctx, vip, true);
    await answer(ctx, vip, true);
    s.verified = true;
    await expectGatesHold(ctx, vip);
  });

  it('in a session that is no longer active, where only end_call runs', async () => {
    const { ctx, s } = await flow('password_reset', standard.email);
    await answer(ctx, standard, true);
    await answer(ctx, standard, true);
    s.status = 'escalated';
    expect(await runTool(ctx, 'reset_password', {})).toEqual({ outcome: 'denied', data: { error: 'not_available' } });
    expect(await runTool(ctx, 'search_kb', { query: 'vpn' })).toEqual({ outcome: 'denied', data: { error: 'not_available' } });
    expect((await runTool(ctx, 'end_call', { summary: 'bye' })).outcome).toBe('ended');
    expect(await listOutbox(db, { user_id: standard.id })).toEqual([]);
  });
});

describe('lookup_account', () => {
  it('returns the same outcome and data shape for real, executive and unknown accounts', async () => {
    const results = await Promise.all(
      [standard.email, vip.employee_id, `nobody.${standard.username}@contoso-health.example`].map(async (id) => (await flow('password_reset', id)).lookup),
    );
    const tokens = new Set<string>();
    for (const r of results) {
      expect(r.outcome).toBe('found');
      expect(Object.keys(r.data).sort()).toEqual(['candidate', 'next']);
      expect(r.data).toMatchObject({ next: 'ask the security questions', candidate: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      tokens.add((r.data as { candidate: string }).candidate);
    }
    expect(tokens.size).toBe(3);
  });

  it('normalizes spoken and spaced identifiers', () => {
    expect(normalizeIdentifier(' Jane Dot Doe at Contoso Dash Health Dot Example ')).toBe('jane.doe@contoso-health.example');
    expect(normalizeIdentifier('JANE.DOE@CONTOSO-HEALTH.EXAMPLE')).toBe('jane.doe@contoso-health.example');
    expect(normalizeIdentifier('jane underscore doe at contoso dot example.')).toBe('jane_doe@contoso.example');
    expect(normalizeIdentifier('E 1 2 3 4 5')).toBe('E12345');
    expect(normalizeIdentifier('e-12345.')).toBe('E12345');
    expect(normalizeIdentifier('E-6-8-6-1-6')).toBe('E68616');
    expect(normalizeIdentifier(' MChen2 ')).toBe('mchen2');
  });

  it.each([
    ['a written email', (u: FixtureUser) => `my email is ${u.email}`],
    ['a spoken email', (u: FixtureUser) => `it's fx dot ${u.username.slice(2)} at contoso dash health dot example`],
    ['an employee id', (u: FixtureUser) => `Sure, my employee ID is ${u.employee_id}.`],
    ['a spaced employee id', (u: FixtureUser) => `my employee ID is ${u.employee_id.split('').join(' ')}`],
    ['a dashed employee id', (u: FixtureUser) => `it's ${u.employee_id.split('').join('-')}`],
    ['a spelled email', (u: FixtureUser) => `it's f x dot ${u.username.slice(2).split('').join(' ')} at contoso dash health dot example`],
  ])('finds the account when %s comes inside a sentence', async (_, say) => {
    const { s, lookup } = await flow('password_reset', say(standard));
    expect(lookup.outcome).toBe('found');
    expect(s.candidate?.userId).toBe(standard.id);
  });

  it('finds the account from a spaced employee id and a spoken or spelled email', async () => {
    const spacedId = `${standard.employee_id[0]} ${standard.employee_id.slice(1).split('').join(' ')}`;
    expect((await flow('password_reset', spacedId)).s.candidate?.userId).toBe(standard.id);
    const spoken = `fx dot ${standard.username.slice(2)} at contoso dash health dot example`;
    expect((await flow('password_reset', spoken)).s.candidate?.userId).toBe(standard.id);
    const spelled = `f x dot ${standard.username.slice(2).split('').join(' ')} at contoso dash health dot example`;
    expect((await flow('password_reset', spelled)).s.candidate?.userId).toBe(standard.id);
  });

  // A real account answers to both forms, so a decoy must too, or comparing the two would reveal which accounts exist.
  it('gives a spelled address the decoy of its written form', async () => {
    const spelled = `g h o s t dot ${standard.username.split('').join(' ')} at contoso dash health dot example`;
    const forms = [`ghost.${standard.username}@contoso-health.example`, spelled];
    const [a, b] = await Promise.all(forms.map(async (id) => (await flow('password_reset', id)).s.candidate?.decoyKey));
    expect(b).toBe(a);
  });

  it('fixes the candidate for the rest of the session', async () => {
    const { ctx, s } = await flow('password_reset', `nobody.${standard.username}@contoso-health.example`);
    const candidate = s.candidate;
    expect(candidate).toMatchObject({ userId: null, isVip: false, decoyKey: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await runTool(ctx, 'lookup_account', { identifier: standard.email })).toEqual({ outcome: 'denied', data: { error: 'not_available' } });
    expect(s.candidate).toBe(candidate);
    expect((await auditEvents(s.id)).map((e) => e.event)).toContain('gate_denied');
  });

  it('hands an executive account to verification with one engagement ticket', async () => {
    const { s, lookup } = await flow('ticket_status', vip.email);
    expect(lookup.outcome).toBe('found');
    expect([s.pipeline, s.state]).toEqual(['vip', 'ask_question']);
    expect(s.candidate).toMatchObject({ userId: vip.id, isVip: true });
    const tickets = await ticketsFor(s.id);
    expect(tickets).toEqual([
      { id: s.vipTicketId, user_id: vip.id, priority: 'P3', category: 'executive-support', summary: 'Executive support contact via service desk' },
    ]);
    expect((await auditEvents(s.id)).map((e) => e.event)).toContain('vip_handoff');
  });
});

describe('security questions', () => {
  it("asks by position, repeats a pending question, skips passed ones and takes only the asked question's answer", async () => {
    const { ctx, s } = await flow('password_reset', standard.username);
    const [q1, q2, q3] = standard.questions.map((q) => q.text);
    expect(await ask(ctx)).toBe(q1);
    expect(await ask(ctx)).toBe(q1);
    expect(s.questionsAsked).toBe(1);
    expect(await runTool(ctx, 'verify_security_answer', { answer: '  biscuit!! ' })).toEqual({
      outcome: 'pass',
      data: { result: 'pass', attempts_remaining: 3 },
    });
    expect(await ask(ctx)).toBe(q2);
    expect(await runTool(ctx, 'verify_security_answer', { answer: standard.answerFor(q3) })).toEqual({
      outcome: 'fail',
      data: { result: 'fail', attempts_remaining: 2 },
    });
    expect(await ask(ctx)).toBe(q3);
    expect((await runTool(ctx, 'verify_security_answer', { answer: standard.answerFor(q1) })).outcome).toBe('fail');
    expect(await ask(ctx)).toBe(q2);
    expect(await runTool(ctx, 'verify_security_answer', { answer: 'honda civic' })).toEqual({
      outcome: 'complete',
      data: { result: 'pass', attempts_remaining: 1 },
    });
    expect(s).toMatchObject({ verified: true, questionsPassed: true, answersPassed: 2, failedAttempts: 2 });
    expect(s.verifiedAt).toBeInstanceOf(Date);
    expect(await runTool(ctx, 'get_next_security_question', {})).toEqual({ outcome: 'denied', data: { error: 'not_available' } });
  });

  it('rejects verification without a pending question', async () => {
    const { ctx, s } = await flow('password_reset', standard.email);
    expect(await runTool(ctx, 'verify_security_answer', { answer: 'Biscuit' })).toEqual({ outcome: 'denied', data: { error: 'not_available' } });
    expect(s.answersPassed).toBe(0);
  });

  it('gives a decoy three distinct pool questions, the same ones on every call, and never a pass', async () => {
    const identifier = `ghost.${standard.username}@contoso-health.example`;
    const a = await flow('username_recovery', identifier);
    const b = await flow('username_recovery', identifier);
    const asked: string[] = [];
    for (let i = 0; i < 3; i++) {
      asked.push(await ask(a.ctx));
      expect(await ask(b.ctx)).toBe(asked[i]);
      await runTool(a.ctx, 'verify_security_answer', { answer: 'Biscuit' });
      await runTool(b.ctx, 'verify_security_answer', { answer: 'Honda Civic' });
    }
    expect(new Set(asked).size).toBe(3);
    for (const q of asked) expect(QUESTION_POOL.map((p) => p.text)).toContain(q);
    expect(a.s).toMatchObject({ answersPassed: 0, failedAttempts: 3, status: 'locked' });
  });
});

describe('lockout', () => {
  const ACCOUNT_PIPELINES = ['password_reset', 'username_recovery', 'ticket_status'] as const;

  it.each(ACCOUNT_PIPELINES)('%s: three failures lock the account for 15 minutes and open a P3 ticket', async (pipeline) => {
    const user = await createFixtureUser();
    const clock = testClock();
    const { ctx, s } = await flow(pipeline, user.email, { now: clock.now });
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await answer(ctx, user, false));
    expect(results).toEqual([
      { outcome: 'fail', data: { result: 'fail', attempts_remaining: 2 } },
      { outcome: 'fail', data: { result: 'fail', attempts_remaining: 1 } },
      { outcome: 'locked_out', data: { result: 'fail', attempts_remaining: 0 } },
    ]);
    expect(s.status).toBe('locked');
    expect(await getUser(db, user.id)).toMatchObject({ is_locked: true, locked_until: new Date(clock.now().getTime() + 15 * MINUTE) });
    expect(await ticketsFor(s.id)).toEqual([
      { id: expect.any(Number), user_id: user.id, priority: 'P3', category: 'account-verification', summary: `Identity verification failed (${pipeline})` },
    ]);
    expect((await auditEvents(s.id)).map((e) => e.event)).toContain('verification_locked');
    expect(await runTool(ctx, 'get_next_security_question', {})).toEqual({ outcome: 'denied', data: { error: 'not_available' } });
    expect(await listOutbox(db, { user_id: user.id })).toEqual([]);
  });

  it('keeps counting failures across a pipeline switch', async () => {
    const user = await createFixtureUser();
    const clock = testClock();
    const { ctx, s } = await flow('password_reset', user.email, { now: clock.now });
    await answer(ctx, user, false);
    await answer(ctx, user, false);
    await runTool(ctx, 'start_pipeline', { name: 'ticket_status' });
    expect([s.pipeline, s.state, s.failedAttempts]).toEqual(['ticket_status', 'ask_question', 2]);
    expect((await answer(ctx, user, false)).outcome).toBe('locked_out');
    expect(await ticketsFor(s.id)).toMatchObject([{ summary: 'Identity verification failed (ticket_status)' }]);
    expect(await getUser(db, user.id)).toMatchObject({ is_locked: true, locked_until: new Date(clock.now().getTime() + 15 * MINUTE) });
  });

  it('a decoy goes down the identical lockout path', async () => {
    const user = await createFixtureUser();
    const real = await flow('password_reset', user.email);
    const decoy = await flow('password_reset', `ghost.${user.username}@contoso-health.example`);
    const realResults = [];
    const decoyResults = [];
    for (let i = 0; i < 3; i++) {
      realResults.push(await answer(real.ctx, user, false));
      decoyResults.push(await answer(decoy.ctx, null, false));
    }
    expect(decoyResults).toEqual(realResults);
    expect(decoy.s.status).toBe('locked');
    expect(await ticketsFor(decoy.s.id)).toMatchObject([{ user_id: null, priority: 'P3', category: 'account-verification', summary: 'Identity verification failed (password_reset)' }]);
    expect((await auditEvents(decoy.s.id)).map((e) => e.event)).toContain('verification_locked');
  });

  // The pipelines share the security answers, so failing them anywhere must not leave a fresh password reset unthrottled.
  it.each(ACCOUNT_PIPELINES)('a %s lockout fails even correct answers in a new password reset until it expires', async (pipeline) => {
    const user = await createFixtureUser();
    const clock = testClock();
    const first = await flow(pipeline, user.email, { now: clock.now });
    for (let i = 0; i < 3; i++) await answer(first.ctx, user, false);
    clock.advance(MINUTE);
    const second = await flow('password_reset', user.email, { now: clock.now });
    expect(second.s.verified).toBe(false);
    expect((await answer(second.ctx, user, true)).outcome).toBe('fail');
    clock.advance(15 * MINUTE);
    const third = await flow('password_reset', user.email, { now: clock.now });
    await answer(third.ctx, user, true);
    expect((await answer(third.ctx, user, true)).outcome).toBe('complete');
  });

  // Session counters start over in every call, so stopping one short of the limit each time must still run into the lock.
  it.each([
    ['a standard account', false, 2],
    ['an executive', true, 1],
  ])('wrong answers add up across calls and lock %s, while each call still sees only its own count', async (_, vip, perCall) => {
    const user = await createFixtureUser({ vip });
    const clock = testClock();
    const first = await flow('username_recovery', user.email, { now: clock.now });
    for (let i = 0; i < perCall; i++) await answer(first.ctx, user, false);
    clock.advance(MINUTE);
    const second = await flow('ticket_status', user.email, { now: clock.now });
    expect(await answer(second.ctx, user, false)).toEqual({ outcome: 'fail', data: { result: 'fail', attempts_remaining: perCall } });
    expect(second.s.status).toBe('active');
    expect(await getUser(db, user.id)).toMatchObject({ is_locked: true, locked_until: new Date(clock.now().getTime() + 15 * MINUTE) });
    expect((await auditEvents(second.s.id)).map((e) => e.event)).toContain('account_locked');
    expect((await answer((await flow('password_reset', user.email, { now: clock.now })).ctx, user, true)).outcome).toBe('fail');
  });

  it('forgets wrong answers from other calls after 15 minutes', async () => {
    const user = await createFixtureUser();
    const clock = testClock();
    for (const wait of [0, 0, 15 * MINUTE]) {
      clock.advance(wait);
      await answer((await flow('password_reset', user.email, { now: clock.now })).ctx, user, false);
    }
    expect(await getUser(db, user.id)).toMatchObject({ is_locked: false, locked_until: null });
  });

  it('a directory lockout (no expiry) does not block verification and a reset clears it', async () => {
    const user = await createFixtureUser({ locked: true });
    const { ctx, s } = await flow('password_reset', user.username);
    await answer(ctx, user, true);
    await answer(ctx, user, true);
    const reset = await runTool(ctx, 'reset_password', {});
    expect(reset).toEqual({
      outcome: 'done',
      data: {
        sent_to: ['the email address on file', 'the mobile phone ending in 7 0 0 3'],
        must_change_at_next_sign_in: true,
        account_unlocked: true,
      },
    });
    expect(await getUser(db, user.id)).toMatchObject({ is_locked: false, locked_until: null, must_change_password: true });
    const outbox = await listOutbox(db, { user_id: user.id });
    expect(outbox.map((o) => [o.channel, o.destination_masked]).sort()).toEqual([
      ['email', 'fx***'],
      ['sms', '***-***-7003'],
    ]);
    const password = /^Temporary password: (\S{16})$/m.exec(outbox[0].body)![1];
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/\d/);
    expect(password).toMatch(/[^A-Za-z\d]/);
    expect(outbox[1].body).toContain(password);
    expect(JSON.stringify(reset)).not.toContain(password);
    expect(JSON.stringify(await auditEvents(s.id))).not.toContain(password);
  });
});

describe('executive verification', () => {
  it('enforces the factor order', async () => {
    const outboxBefore = (await listOutbox(db, { user_id: vip.id })).length;
    const { ctx, s } = await flow('password_reset', vip.email);
    const notAvailable = { outcome: 'denied', data: { error: 'not_available' } };
    expect(await runTool(ctx, 'verify_vip_pin', { pin: vip.pin })).toEqual(notAvailable);
    expect(await runTool(ctx, 'send_one_time_code', {})).toEqual(notAvailable);
    expect(await runTool(ctx, 'verify_one_time_code', { code: '123456' })).toEqual(notAvailable);
    await answer(ctx, vip, true);
    await answer(ctx, vip, true);
    expect(s).toMatchObject({ questionsPassed: true, verified: false });
    expect(await runTool(ctx, 'send_one_time_code', {})).toEqual(notAvailable);
    expect(await runTool(ctx, 'verify_vip_pin', { pin: vip.pin })).toMatchObject({ outcome: 'pass' });
    expect(await runTool(ctx, 'verify_vip_pin', { pin: vip.pin })).toEqual(notAvailable);
    expect(await runTool(ctx, 'verify_one_time_code', { code: '123456' })).toEqual(notAvailable);
    expect(s).toMatchObject({ failedAttempts: 0, verified: false });
    expect((await listOutbox(db, { user_id: vip.id })).length).toBe(outboxBefore);
  });

  it('ends verification after two failures across factors, raises the ticket to P1 and locks the account', async () => {
    const exec = await createFixtureUser({ vip: true });
    const clock = testClock();
    const { ctx, s } = await flow('ticket_status', exec.employee_id, { now: clock.now });
    expect(await answer(ctx, exec, false)).toEqual({ outcome: 'fail', data: { result: 'fail', attempts_remaining: 1 } });
    await answer(ctx, exec, true);
    expect((await answer(ctx, exec, true)).outcome).toBe('complete');
    expect(await runTool(ctx, 'verify_vip_pin', { pin: '000000' })).toEqual({
      outcome: 'locked_out',
      data: { result: 'fail', attempts_remaining: 0 },
    });
    expect(s.status).toBe('locked');
    expect(await ticketsFor(s.id)).toEqual([
      { id: s.vipTicketId, user_id: exec.id, priority: 'P1', category: 'executive-support', summary: 'Executive verification failed; call back on file number' },
    ]);
    expect((await auditEvents(s.id)).map((e) => e.event)).toContain('vip_verification_failed');
    expect(await getUser(db, exec.id)).toMatchObject({ is_locked: true, locked_until: new Date(clock.now().getTime() + 15 * MINUTE) });
  });

  it('two wrong one-time codes end verification with nothing reset', async () => {
    const exec = await createFixtureUser({ vip: true });
    const { ctx, s } = await flow('password_reset', exec.email);
    await passQuestionsAndPin(ctx, exec);
    expect((await runTool(ctx, 'send_one_time_code', {})).outcome).toBe('sent');
    const code = await latestCode(exec);
    const wrong = code === '111111' ? '222222' : '111111';
    expect((await runTool(ctx, 'verify_one_time_code', { code: wrong })).outcome).toBe('fail');
    expect((await runTool(ctx, 'verify_one_time_code', { code: wrong })).outcome).toBe('locked_out');
    expect(await runTool(ctx, 'verify_one_time_code', { code })).toEqual({ outcome: 'denied', data: { error: 'not_available' } });
    expect(s).toMatchObject({ status: 'locked', verified: false });
    expect(await ticketsFor(s.id)).toMatchObject([{ priority: 'P1', category: 'executive-support' }]);
    expect(await getUser(db, exec.id)).toMatchObject({ must_change_password: false });
  });

  it('does not count an expired code as a failure', async () => {
    const clock = testClock();
    const { ctx, s } = await flow('password_reset', vip.email, { now: clock.now });
    await passQuestionsAndPin(ctx);
    expect(await runTool(ctx, 'send_one_time_code', {})).toEqual({ outcome: 'sent', data: { sent_to: 'the phone number on file ending in 7 0 0 2' } });
    const [sms] = await listOutbox(db, { user_id: vip.id, limit: 1 });
    expect(sms).toMatchObject({ channel: 'sms', destination_masked: '***-***-7002' });
    expect(sms.body).toMatch(/^Contoso Health service desk code: \d{6}\. It expires in 5 minutes\. Never share it with anyone who calls you\.$/);
    const expiredCode = await latestCode();
    clock.advance(5 * MINUTE);
    expect(await runTool(ctx, 'verify_one_time_code', { code: expiredCode })).toEqual({ outcome: 'expired', data: { result: 'expired' } });
    expect(s.failedAttempts).toBe(0);
    expect((await runTool(ctx, 'send_one_time_code', {})).outcome).toBe('sent');
    expect((await runTool(ctx, 'send_one_time_code', {})).outcome).toBe('sent');
    const codes = (await listOutbox(db, { user_id: vip.id, limit: 3 })).map((o) => /code: (\d{6})/.exec(o.body)![1]);
    expect(await runTool(ctx, 'verify_one_time_code', { code: codes[0].split('').join(' ') })).toEqual({ outcome: 'pass', data: { result: 'pass' } });
    expect(s).toMatchObject({ verified: true, failedAttempts: 0 });
    expect(isVerifiedFor(s)).toBe(true);
    const audit = JSON.stringify(await auditEvents(s.id));
    for (const code of [expiredCode, ...codes]) expect(audit).not.toContain(code);
  });

  it('sends at most three codes, and asking for a fourth ends verification like a failed factor', async () => {
    const exec = await createFixtureUser({ vip: true });
    const clock = testClock();
    const { ctx, s } = await flow('password_reset', exec.email, { now: clock.now });
    await passQuestionsAndPin(ctx, exec);
    for (let i = 0; i < 3; i++) expect((await runTool(ctx, 'send_one_time_code', {})).outcome).toBe('sent');
    clock.advance(5 * MINUTE);
    expect((await runTool(ctx, 'verify_one_time_code', { code: await latestCode(exec) })).outcome).toBe('expired');
    expect(await runTool(ctx, 'send_one_time_code', {})).toEqual({ outcome: 'locked_out', data: { result: 'fail', attempts_remaining: 0 } });
    expect(s).toMatchObject({ status: 'locked', verified: false, failedAttempts: 0 });
    expect(await ticketsFor(s.id)).toMatchObject([{ priority: 'P1', category: 'executive-support', summary: 'Executive verification failed; call back on file number' }]);
    expect(await listOutbox(db, { user_id: exec.id })).toHaveLength(3);
  });

  it('after full verification, a reset also reaches the assistant and username recovery is email only', async () => {
    const user = await createFixtureUser({ vip: true });
    const { ctx, s } = await flow('username_recovery', user.email);
    for (let i = 0; i < 2; i++) {
      const question = await ask(ctx);
      await runTool(ctx, 'verify_security_answer', { answer: user.answerFor(question) });
    }
    await runTool(ctx, 'verify_vip_pin', { pin: user.pin });
    await runTool(ctx, 'send_one_time_code', {});
    const [sms] = await listOutbox(db, { user_id: user.id, limit: 1 });
    await runTool(ctx, 'verify_one_time_code', { code: /code: (\d{6})/.exec(sms.body)![1] });
    expect(isVerifiedFor(s)).toBe(true);

    const recovered = await runTool(ctx, 'recover_username', {});
    expect(recovered).toEqual({ outcome: 'done', data: { sent_to: 'the email address on file', read_aloud: false } });
    expect(JSON.stringify(recovered).toLowerCase()).not.toContain(user.username);

    const reset = await runTool(ctx, 'reset_password', {});
    expect(reset.data).toMatchObject({ sent_to: ['the email address on file', 'the mobile phone ending in 7 0 0 3', 'your executive assistant'] });
    const outbox = await listOutbox(db, { user_id: user.id });
    expect(outbox.slice(0, 4).map((o) => [o.channel, o.destination_masked])).toEqual([
      ['sms', '***-***-7001'],
      ['sms', '***-***-7003'],
      ['email', 'fx***'],
      ['email', 'fx***'],
    ]);
    expect(outbox[0].body).toContain(`password reset for Fixture ${user.username.slice(2)}`);
    expect(outbox[3].body).toContain(user.username);
    expect(await ticketsFor(s.id)).toMatchObject([{ priority: 'P3', category: 'executive-support' }]);
  });
});

describe('other tools', () => {
  it('start_pipeline routes by verification state and keeps an executive in verification', async () => {
    const fresh = await toolSession();
    await runTool(fresh.ctx, 'start_pipeline', { name: 'ticket_status' });
    expect([fresh.s.pipeline, fresh.s.state]).toEqual(['ticket_status', 'collect_identifier']);

    const verified = await flow('password_reset', standard.email);
    await answer(verified.ctx, standard, true);
    await answer(verified.ctx, standard, true);
    expect(await runTool(verified.ctx, 'start_pipeline', { name: 'username_recovery' })).toEqual({ outcome: 'started', data: { pipeline: 'username_recovery' } });
    expect(verified.s.state).toBe('recover');
    await runTool(verified.ctx, 'start_pipeline', { name: 'general_help' });
    expect(verified.s.state).toBe('answer');

    const unverified = await flow('password_reset', standard.email);
    await runTool(unverified.ctx, 'start_pipeline', { name: 'ticket_status' });
    expect([unverified.s.pipeline, unverified.s.state]).toEqual(['ticket_status', 'ask_question']);

    const executive = await flow('password_reset', vip.email);
    await runTool(executive.ctx, 'start_pipeline', { name: 'general_help' });
    expect([executive.s.pipeline, executive.s.state]).toEqual(['vip', 'ask_question']);
  });

  it('recover_username spells the username and emails it to a verified standard account', async () => {
    const user = await createFixtureUser();
    const { ctx, s } = await flow('username_recovery', user.email);
    await answer(ctx, user, true);
    await answer(ctx, user, true);
    expect(await runTool(ctx, 'recover_username', {})).toEqual({
      outcome: 'done',
      data: { username_spelled: expect.stringMatching(/^Foxtrot X-ray /), sent_to: 'the email address on file' },
    });
    expect(await listOutbox(db, { user_id: user.id })).toMatchObject([
      { channel: 'email', destination_masked: 'fx***', body: expect.stringContaining(user.username) },
    ]);
    expect((await auditEvents(s.id)).map((e) => e.event)).toContain('username_recovered');
  });

  it('get_ticket_status lists the newest five tickets of the verified account', async () => {
    const user = await createFixtureUser();
    for (let i = 1; i <= 6; i++) {
      await db.query(`INSERT INTO servicedesk.tickets (user_id, priority, category, summary) VALUES ($1, 'P4', 'fixture', $2)`, [user.id, `issue ${i}`]);
    }
    const { ctx } = await flow('ticket_status', user.email);
    await answer(ctx, user, true);
    await answer(ctx, user, true);
    const { outcome, data } = await runTool(ctx, 'get_ticket_status', {});
    expect(outcome).toBe('done');
    const tickets = (data as { tickets: Record<string, unknown>[] }).tickets;
    expect(tickets.map((t) => t.summary)).toEqual(['issue 6', 'issue 5', 'issue 4', 'issue 3', 'issue 2']);
    expect(tickets[0]).toEqual({ number: expect.any(Number), priority: 'P4', status: 'open', summary: 'issue 6', opened: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it('search_kb returns titles, dates and text only, or a no-match note', async () => {
    const chunk = { articleId: 1, slug: 'vpn-new', title: 'Connect to the VPN', updated: '2025-08-04', text: 'Open GlobalProtect.', score: 0.4 };
    const hit = await toolSession({ retrieve: async () => [chunk] });
    expect(await runTool(hit.ctx, 'search_kb', { query: 'vpn' })).toEqual({
      outcome: 'match',
      data: { articles: [{ title: 'Connect to the VPN', updated: '2025-08-04', text: 'Open GlobalProtect.' }] },
    });
    const miss = await toolSession();
    expect(await runTool(miss.ctx, 'search_kb', { query: 'sourdough' })).toEqual({
      outcome: 'no_match',
      data: { articles: [], note: 'No matching article. Offer to open a ticket.' },
    });
  });

  it('create_ticket links the account only when verified and redacts the category and summary', async () => {
    const unverified = await flow('password_reset', standard.email);
    await runTool(unverified.ctx, 'create_ticket', { priority: 'P3', category: `access ${standard.email}`, summary: `Code 123456 for ${standard.email}` });
    expect(await ticketsFor(unverified.s.id)).toMatchObject([{ user_id: null, priority: 'P3', category: 'access fx***', summary: 'Code [code] for fx***' }]);
    await answer(unverified.ctx, standard, true);
    await answer(unverified.ctx, standard, true);
    const created = await runTool(unverified.ctx, 'create_ticket', { priority: 'P4', category: 'access', summary: 'Printer' });
    expect(created).toEqual({ outcome: 'created', data: { ticket_number: expect.any(Number) } });
    expect((await ticketsFor(unverified.s.id))[1]).toMatchObject({ user_id: standard.id });
  });

  it('escalate opens a P2 ticket, unlinked for an unverified caller, and leaves only end_call', async () => {
    const { ctx, s } = await flow('password_reset', standard.email);
    expect(await runTool(ctx, 'escalate', { reason: 'Caller wants a person' })).toEqual({
      outcome: 'escalated',
      data: { ticket_number: expect.any(Number), message: 'A specialist will follow up.' },
    });
    expect(s.status).toBe('escalated');
    expect(await ticketsFor(s.id)).toMatchObject([{ priority: 'P2', category: 'escalation', user_id: null }]);
    expect((await runTool(ctx, 'create_ticket', { priority: 'P1', category: 'x', summary: 'y' })).outcome).toBe('denied');
    expect(await runTool(ctx, 'end_call', { summary: `Bye, write to ${standard.email}` })).toEqual({ outcome: 'ended', data: { ended: true } });
    expect(s.status).toBe('ended');
    expect(s.endedAt).toBeInstanceOf(Date);
    const ended = (await auditEvents(s.id)).find((e) => e.event === 'call_ended');
    expect(ended?.detail).toEqual({});
  });

  it('describes every tool in one sentence that never mentions executives, with plain JSON Schema', () => {
    const specs = toolSpecs(Object.keys(TOOLS) as (keyof typeof TOOLS)[]);
    expect(specs.length).toBe(14);
    for (const spec of specs) {
      expect(spec.description).toMatch(/^[^.]+\.$/);
      expect(spec.description).not.toMatch(/vip|executive/i);
      expect(spec.parameters).toMatchObject({ type: 'object' });
      expect(spec.parameters).not.toHaveProperty('$schema');
    }
    expect(specs.find((s) => s.name === 'verify_vip_pin')!.parameters).toMatchObject({ properties: { pin: { type: 'string', pattern: '^\\d{6}$' } } });
    expect(specs.find((s) => s.name === 'lookup_account')!.parameters).toMatchObject({
      properties: { identifier: { description: 'Only the email, employee ID, or username, word for word as the caller said it' } },
    });
    expect(specs.find((s) => s.name === 'verify_security_answer')!.parameters).toMatchObject({
      properties: { answer: { description: "Only the caller's answer, word for word, without the words around it" } },
    });
  });

  it('normalizes spoken digits for PINs and codes and rejects anything that is not six digits', () => {
    const { schema } = TOOLS.verify_one_time_code;
    expect(schema.parse({ code: 'oh one two, three four five' })).toEqual({ code: '012345' });
    expect(schema.parse({ code: 482913 })).toEqual({ code: '482913' });
    expect(schema.safeParse({ code: '12345' }).success).toBe(false);
    expect(schema.safeParse({ code: '1234567' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });
});
