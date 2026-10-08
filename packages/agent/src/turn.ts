import { z } from 'zod';
import { redactText } from '@vsd/db';
import { PIPELINES, nextState, type ToolName, type VerificationPolicy } from '@vsd/pipelines';
import { extractJson } from './json-extract';
import { postProcess } from './postprocess';
import { preRoute } from './prerouter';
import { buildMessages, type StateView } from './prompt';
import { TOOLS, audit, runTool, toolSpecs } from './tools';
import type { AgentDeps, AgentEvent, LlmResult, Session, TurnResult } from './types';

export const FALLBACK_REPLY = "Sorry, I didn't catch that. Could you say it again?";
const MAX_STEPS = 4;

function progress(s: Session, policy?: VerificationPolicy): string {
  if (!s.candidate) return 'No account identified yet.';
  return [
    'Account identified.',
    policy && `Correct security answers: ${s.answersPassed} of ${policy.requiredAnswers}. Failed attempts: ${s.failedAttempts} of ${policy.maxFailures}.`,
    s.pinPassed && 'PIN checked.',
    s.verified && 'Verification complete.',
  ]
    .filter(Boolean)
    .join(' ');
}

function view(s: Session, tools: ToolName[]): StateView {
  const { label, states, verification: policy } = PIPELINES[s.pipeline];
  const { instruction } = states[s.state];
  return {
    pipelineLabel: label,
    state: s.state,
    progress: progress(s, policy),
    instruction: typeof instruction === 'string' ? instruction : instruction(s.pendingQuestion?.text),
    tools,
  };
}

function validate(r: LlmResult, allowed: ToolName[]): { problem?: string; args?: unknown } {
  if (r.malformed) return { problem: r.malformed };
  const call = r.toolCalls[0];
  if (!call || !allowed.includes(call.name as ToolName)) return {};
  const parsed = TOOLS[call.name as ToolName].schema.safeParse(extractJson(call.arguments.trim() || '{}'));
  return parsed.success ? { args: parsed.data } : { problem: `invalid arguments for ${call.name}: ${z.prettifyError(parsed.error)}` };
}

export async function runTurn(deps: Required<AgentDeps>, s: Session, transcript: string): Promise<TurnResult> {
  // A question can be re-asked in the model's own words, or the canned line can follow an answer, from a state that does
  // not wait for the caller, so the whole verification phase is secret: neither the utterance nor the reply (a model may
  // echo it) is persisted.
  const secret = !!s.candidate && !s.verified;
  const ctx = { ...deps, s, secret };
  const events: AgentEvent[] = [];
  s.lastActivityAt = deps.now();
  await audit(ctx, 'caller_turn', { text: redactText(transcript, { fully: secret }) });
  await preRoute(ctx, transcript, events);
  s.history.push({ role: 'user', content: transcript, ...(secret && { secret }) });
  let reply = '';
  let kbMatched = false;
  // A tool runs at most once per caller turn, so a model that repeats an action cannot send a second password or ticket.
  const ran = new Set<ToolName>();
  for (let step = 0; step < MAX_STEPS; step++) {
    const def = PIPELINES[s.pipeline].states[s.state];
    const allowed =
      step === MAX_STEPS - 1 || (step > 0 && def.waitForCaller) || s.status === 'ended' ? [] : def.tools.filter((t) => !ran.has(t));
    const sv = view(s, allowed);
    const specs = toolSpecs(allowed);
    let r = await deps.llm.complete(buildMessages(s.history, sv), specs);
    let v = validate(r, allowed);
    if (v.problem) {
      await audit(ctx, r.malformed ? 'llm_malformed' : 'tool_invalid_args', { tool: r.toolCalls[0]?.name, reason: v.problem });
      if (!r.malformed) events.push({ type: 'tool_rejected', name: r.toolCalls[0].name, reason: 'invalid_args' });
      events.push({ type: 'llm_retry', reason: v.problem });
      const feedback = `Your last reply could not be used (${v.problem}). Reply again following the current step.`;
      r = await deps.llm.complete(buildMessages(s.history, { ...sv, instruction: `${sv.instruction} ${feedback}` }), specs);
      v = validate(r, allowed);
      if (v.problem) {
        events.push({ type: 'fallback', reason: v.problem });
        break;
      }
    }
    const [call, ...extra] = r.toolCalls;
    if (extra.length) {
      await audit(ctx, 'extra_tool_calls_ignored', { names: extra.map((c) => c.name) });
      for (const c of extra) events.push({ type: 'tool_rejected', name: c.name, reason: 'extra_call' });
    }
    if (!call) {
      reply = r.text;
      break;
    }
    if (!allowed.includes(call.name as ToolName)) {
      await audit(ctx, 'tool_not_allowed', { name: call.name, state: s.state });
      const error = { error: 'tool_not_allowed', message: `${call.name} is not available now. Continue with the current instruction.` };
      s.history.push({ role: 'assistant', content: r.text, toolCall: call }, { role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(error) });
      events.push({ type: 'tool_rejected', name: call.name, reason: 'not_allowed' });
      continue;
    }
    const name = call.name as ToolName;
    const pipeline = s.pipeline;
    const result = await runTool(ctx, name, v.args);
    ran.add(name);
    s.history.push({ role: 'assistant', content: r.text, toolCall: call }, { role: 'tool', toolCallId: call.id, name, content: JSON.stringify(result.data) });
    if (s.pipeline === pipeline) s.state = nextState(pipeline, s.state, name, result.outcome) ?? s.state;
    kbMatched ||= name === 'search_kb' && result.outcome === 'match';
    events.push({ type: 'tool', name, outcome: result.outcome }, { type: 'state', pipeline: s.pipeline, state: s.state, status: s.status });
  }
  // With nothing usable from the model, a pending question is what to repeat: the caller may already have answered the
  // one before it.
  reply = postProcess(reply, kbMatched ? { maxSentences: 6, maxChars: 700 } : undefined) || s.pendingQuestion?.text || FALLBACK_REPLY;
  s.history.push({ role: 'assistant', content: reply });
  await audit(ctx, 'agent_turn', { text: redactText(reply, { fully: secret }) });
  return { reply, pipeline: s.pipeline, state: s.state, status: s.status, events };
}
