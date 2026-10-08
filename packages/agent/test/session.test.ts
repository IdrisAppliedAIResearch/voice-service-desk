import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closePools } from '@vsd/db';
import { createScriptedLlm } from '../src/llm/index';
import { GREETING, SESSION_IDLE_MS } from '../src/session';
import { runTool } from '../src/tools';
import { FALLBACK_REPLY } from '../src/turn';
import { SessionClosedError, SessionExpiredError, SessionNotFoundError, type LlmAdapter } from '../src/types';
import { auditEvents, createFixtureUser, db, testAgent, testClock } from './core-fixtures';

afterAll(closePools);

async function sessionRow(id: string) {
  const { rows } = await db.query('SELECT pipeline, state, status, verified, candidate_user_id, ended_at FROM servicedesk.sessions WHERE id = $1', [id]);
  return rows[0];
}

describe('session store', () => {
  it('creates a session with the greeting, a row and an audit event', async () => {
    const agent = testAgent();
    const created = await agent.createSession('voice');
    expect(created).toEqual({ sessionId: expect.any(String), reply: GREETING, pipeline: 'triage', state: 'greet' });
    expect(agent.getSession(created.sessionId)).toMatchObject({
      channel: 'voice',
      status: 'active',
      verified: false,
      answersPassed: 0,
      failedAttempts: 0,
      history: [{ role: 'assistant', content: GREETING }],
    });
    expect(await sessionRow(created.sessionId)).toMatchObject({ pipeline: 'triage', state: 'greet', status: 'active', verified: false, ended_at: null });
    expect(await auditEvents(created.sessionId)).toEqual([{ event: 'session_started', user_id: null, detail: { channel: 'voice' } }]);
  });

  it('rejects unknown sessions', async () => {
    await expect(testAgent().handleTurn(randomUUID(), 'hi')).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('expires after 10 idle minutes and verification does not carry over to a new session', async () => {
    const user = await createFixtureUser();
    const clock = testClock();
    const llm = createScriptedLlm(Array(2).fill({ say: 'Hello again.' }));
    const agent = testAgent({ llm, now: clock.now });
    const { sessionId } = await agent.createSession('text');
    const s = agent.getSession(sessionId)!;
    const ctx = { db, now: clock.now, retrieve: async () => [], s };
    await runTool(ctx, 'start_pipeline', { name: 'password_reset' });
    await runTool(ctx, 'lookup_account', { identifier: user.email });
    for (let i = 0; i < 2; i++) {
      const { question } = (await runTool(ctx, 'get_next_security_question', {})).data as { question: string };
      await runTool(ctx, 'verify_security_answer', { answer: user.answerFor(question) });
    }
    expect(s.verified).toBe(true);

    for (let i = 0; i < 2; i++) {
      clock.advance(SESSION_IDLE_MS);
      expect((await agent.handleTurn(sessionId, 'still there?')).reply).toBe('Hello again.');
    }
    clock.advance(SESSION_IDLE_MS + 1);
    await expect(agent.handleTurn(sessionId, 'reset my password now')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(s.status).toBe('expired');
    expect(agent.getSession(sessionId)).toBeUndefined();
    expect(await sessionRow(sessionId)).toMatchObject({ status: 'expired', ended_at: clock.now() });
    expect((await auditEvents(sessionId)).at(-1)).toMatchObject({ event: 'session_expired', user_id: user.id });
    await expect(agent.handleTurn(sessionId, 'hello?')).rejects.toBeInstanceOf(SessionExpiredError);

    const next = agent.getSession((await agent.createSession('text')).sessionId)!;
    expect(next).toMatchObject({ pipeline: 'triage', verified: false, failedAttempts: 0 });
    expect(next.candidate).toBeUndefined();
    expect(await runTool({ ...ctx, s: next }, 'reset_password', {})).toEqual({ outcome: 'denied', data: { error: 'not_verified' } });
  });

  it('refuses turns after the call ended, including a turn queued behind the ending one', async () => {
    const llm = createScriptedLlm([{ tool: { name: 'end_call', args: { summary: 'Caller hung up' } } }, { say: 'Goodbye.' }]);
    const agent = testAgent({ llm });
    const { sessionId } = await agent.createSession('text');
    const [ending, queued] = await Promise.allSettled([agent.handleTurn(sessionId, 'bye'), agent.handleTurn(sessionId, 'wait')]);
    expect(ending).toMatchObject({ status: 'fulfilled', value: { status: 'ended', reply: 'Goodbye.' } });
    expect(queued).toMatchObject({ status: 'rejected', reason: expect.any(SessionClosedError) });
    expect(await sessionRow(sessionId)).toMatchObject({ status: 'ended', ended_at: expect.any(Date) });
    await expect(agent.handleTurn(sessionId, 'hello')).rejects.toBeInstanceOf(SessionClosedError);
  });

  it('serializes turns for one session and keeps going after a failed turn', async () => {
    const log: string[] = [];
    let n = 0;
    const llm: LlmAdapter = {
      name: 'slow',
      async complete() {
        const turn = ++n;
        if (turn === 2) throw new Error('model down');
        log.push(`start ${turn}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        log.push(`end ${turn}`);
        return { text: `reply ${turn}`, toolCalls: [] };
      },
    };
    const agent = testAgent({ llm });
    const { sessionId } = await agent.createSession('text');
    const results = await Promise.allSettled(['one', 'two', 'three'].map((t) => agent.handleTurn(sessionId, t)));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(log).toEqual(['start 1', 'end 1', 'start 3', 'end 3']);
  });

  it('still ends a turn that failed after a tool ran on an assistant message', async () => {
    const llm = createScriptedLlm([{ tool: { name: 'start_pipeline', args: { name: 'general_help' } } }]);
    const agent = testAgent({ llm });
    const { sessionId } = await agent.createSession('text');
    await expect(agent.handleTurn(sessionId, 'hello')).rejects.toThrow('scripted LLM exhausted');
    expect(agent.getSession(sessionId)!.history.slice(-2)).toEqual([
      { role: 'tool', toolCallId: expect.any(String), name: 'start_pipeline', content: '{"pipeline":"general_help"}' },
      { role: 'assistant', content: FALLBACK_REPLY },
    ]);
  });

  it('sweep expires idle sessions and drops ended ones', async () => {
    const clock = testClock();
    const agent = testAgent({ now: clock.now });
    const idle = (await agent.createSession('text')).sessionId;
    const ended = (await agent.createSession('text')).sessionId;
    agent.getSession(ended)!.status = 'ended';
    clock.advance(SESSION_IDLE_MS + 1);
    const fresh = (await agent.createSession('text')).sessionId;
    expect(await agent.sweep()).toBe(1);
    await expect(agent.handleTurn(idle, 'hello?')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(agent.getSession(idle)).toBeUndefined();
    expect(agent.getSession(ended)).toBeUndefined();
    expect(agent.getSession(fresh)).toBeDefined();
    expect(await sessionRow(idle)).toMatchObject({ status: 'expired' });
    expect(await agent.sweep()).toBe(0);
  });
});
