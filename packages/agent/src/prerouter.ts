import { findUserByIdentifier } from '@vsd/db';
import type { StartablePipeline } from '@vsd/pipelines';
import { IDENTIFIERS, audit, normalizeIdentifier, setCandidate, spokenSymbols, switchPipeline, type ToolContext } from './tools';
import type { AgentEvent } from './types';

const INTENTS: [StartablePipeline, RegExp][] = [
  ['password_reset', /\b(?:reset|forgot|forgotten|lost)\b[\w\s']{0,30}\bpassword\b|\bpassword\b[\w\s']{0,30}\b(?:reset|expired)\b/i],
  ['username_recovery', /\b(?:forgot|forgotten|lost|recover|remember)\b[\w\s']{0,30}\buser ?name\b/i],
  ['ticket_status', /\b(?:status|update)\b[\w\s']{0,30}\b(?:ticket|case)\b|\b(?:ticket|case)\b[\w\s']{0,30}\bstatus\b/i],
  ['general_help', /\bhow (?:do|can|to|should)\b|\b(?:vpn|wi-?fi|printer|outlook|teams|mfa)\b/i],
];

export async function preRoute(ctx: ToolContext, transcript: string, events: AgentEvent[]): Promise<void> {
  const { s } = ctx;
  if (s.status !== 'active') return;
  if (!s.candidate) {
    for (const [match] of spokenSymbols(transcript).matchAll(IDENTIFIERS)) {
      const identifier = normalizeIdentifier(match);
      const user = await findUserByIdentifier(ctx.db, identifier);
      if (!user?.is_vip) continue;
      // Silent: the model only sees the new verification step, nothing tells the caller the account is special.
      await setCandidate(ctx, identifier, user);
      events.push({ type: 'prerouter', action: 'vip_handoff', pipeline: 'vip' });
      return;
    }
  }
  if (s.pipeline !== 'triage' || s.state !== 'greet') return;
  const intent = INTENTS.find(([, pattern]) => pattern.test(transcript))?.[0];
  if (!intent) return;
  switchPipeline(s, intent);
  await audit(ctx, 'prerouter_intent', { pipeline: intent });
  events.push({ type: 'prerouter', action: 'start_pipeline', pipeline: intent });
}
