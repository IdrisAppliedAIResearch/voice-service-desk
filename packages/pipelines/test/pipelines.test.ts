import { describe, expect, it } from 'vitest';
import { PIPELINES, nextState, type PipelineDef, type ToolName } from '../src/index';

const GATED: ToolName[] = ['recover_username', 'reset_password', 'get_ticket_status'];
const pipelines = Object.entries(PIPELINES);
const states = pipelines.flatMap(([p, def]) => Object.entries(def.states).map(([name, state]) => ({ p, name, state })));

// States reachable from the initial state without taking a transition into the action state.
function beforeVerification(def: PipelineDef): Set<string> {
  const seen = new Set([def.initial]);
  for (const name of seen)
    for (const outcomes of Object.values(def.states[name].on ?? {}))
      for (const next of Object.values(outcomes)) if (next !== def.actionState) seen.add(next);
  return seen;
}

describe('pipeline tables', () => {
  it('initial and action states exist', () => {
    for (const [, def] of pipelines) {
      expect(def.states[def.initial]).toBeDefined();
      if (def.actionState) expect(def.states[def.actionState]).toBeDefined();
      expect(def.states.closing.tools).toEqual(['end_call']);
    }
  });

  it.each(states)('$p/$name transitions to existing states', ({ p, state }) => {
    expect(state.tools.length).toBeGreaterThan(0);
    for (const [tool, outcomes] of Object.entries(state.on ?? {})) {
      expect(state.tools).toContain(tool);
      for (const next of Object.values(outcomes)) expect(PIPELINES[p as keyof typeof PIPELINES].states[next]).toBeDefined();
    }
    if (state.tools.includes('escalate')) expect(state.on?.escalate).toEqual({ escalated: 'closing' });
  });

  it('terminal states only offer end_call', () => {
    const terminal = states.filter(({ name }) => ['locked', 'failed', 'closing'].includes(name));
    expect(terminal.length).toBe(10);
    for (const { state } of terminal) {
      expect(state.tools).toEqual(['end_call']);
      expect(state.on).toBeUndefined();
    }
  });

  it.each(pipelines.filter(([, def]) => def.verification))(
    '%s never offers action tools or start_pipeline before verification',
    (_, def) => {
      const before = beforeVerification(def);
      expect(before.has(def.actionState!)).toBe(false);
      for (const name of before) {
        for (const tool of [...GATED, 'start_pipeline' as const]) expect(def.states[name].tools).not.toContain(tool);
      }
      for (const [name, state] of Object.entries(def.states)) {
        if (GATED.some((t) => state.tools.includes(t))) expect(name).toBe(def.actionState);
      }
    },
  );

  it('gated tools are never offered by pipelines without verification', () => {
    for (const p of ['triage', 'general_help'] as const)
      for (const state of Object.values(PIPELINES[p].states)) for (const tool of GATED) expect(state.tools).not.toContain(tool);
  });

  it('secret states wait for the caller and are the only states that do', () => {
    const waiting = states.filter(({ state }) => state.waitForCaller).map(({ name }) => name);
    expect(new Set(waiting)).toEqual(new Set(['await_answer', 'collect_pin', 'await_code']));
    for (const { state } of states) {
      if (state.tools.some((t) => t.startsWith('verify_'))) expect(state.waitForCaller).toBe(true);
    }
  });

  it('uses the verification policies from the design', () => {
    for (const p of ['username_recovery', 'password_reset', 'ticket_status'] as const) {
      expect(PIPELINES[p].verification).toEqual({
        requiredAnswers: 2,
        maxFailures: 3,
        lockAccountMinutes: 15,
        lockoutTicket: { priority: 'P3', category: 'account-verification' },
      });
    }
    expect(PIPELINES.vip.verification).toEqual({
      requiredAnswers: 2,
      maxFailures: 2,
      lockAccountMinutes: 15,
      lockoutTicket: { priority: 'P1', category: 'executive-support' },
    });
  });

  it('never names the VIP pipeline or executives to the model (beyond the fixed tool name)', () => {
    expect(PIPELINES.vip.label).toBe('account_verification');
    for (const { state } of states) {
      const text = typeof state.instruction === 'string' ? state.instruction : state.instruction('q');
      expect(text.replaceAll('verify_vip_pin', '')).not.toMatch(/vip|executive/i);
    }
    for (const [, def] of pipelines) expect(def.label).not.toMatch(/vip/i);
  });

  it('puts the pending question into the await_answer instruction', () => {
    const { instruction } = PIPELINES.password_reset.states.await_answer;
    expect(typeof instruction).toBe('function');
    const text = (instruction as Exclude<typeof instruction, string>)('What was the name of your first pet?');
    expect(text).toContain('"What was the name of your first pet?"');
    expect(text).toContain('call verify_security_answer with only their answer, word for word, without the words around it');
  });

  it('asks the model for only the identifier, never the whole sentence', () => {
    for (const p of ['username_recovery', 'password_reset', 'ticket_status'] as const)
      expect(PIPELINES[p].states.collect_identifier.instruction).toContain('call lookup_account with only that identifier, word for word, without the words around it');
  });
});

describe('nextState', () => {
  it('follows the table', () => {
    expect(nextState('password_reset', 'collect_identifier', 'lookup_account', 'found')).toBe('ask_question');
    expect(nextState('password_reset', 'await_answer', 'verify_security_answer', 'complete')).toBe('reset');
    expect(nextState('username_recovery', 'await_answer', 'verify_security_answer', 'complete')).toBe('recover');
    expect(nextState('ticket_status', 'await_answer', 'verify_security_answer', 'locked_out')).toBe('locked');
    expect(nextState('vip', 'await_answer', 'verify_security_answer', 'complete')).toBe('collect_pin');
    expect(nextState('vip', 'await_code', 'verify_one_time_code', 'expired')).toBe('send_code');
    expect(nextState('vip', 'await_code', 'verify_one_time_code', 'pass')).toBe('verified');
    expect(nextState('vip', 'send_code', 'send_one_time_code', 'locked_out')).toBe('failed');
    expect(nextState('vip', 'await_code', 'send_one_time_code', 'locked_out')).toBe('failed');
    expect(nextState('general_help', 'answer', 'search_kb', 'no_match')).toBe('no_match');
  });

  it('returns undefined when the table has no entry', () => {
    expect(nextState('general_help', 'answer', 'create_ticket', 'created')).toBeUndefined();
    expect(nextState('vip', 'verified', 'reset_password', 'done')).toBeUndefined();
    expect(nextState('password_reset', 'await_answer', 'reset_password', 'done')).toBeUndefined();
    expect(nextState('triage', 'nowhere', 'end_call', 'ended')).toBeUndefined();
  });
});
