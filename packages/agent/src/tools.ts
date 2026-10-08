import { createHash, randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DUMMY_HASH,
  QUESTION_POOL,
  completePasswordReset,
  createTicket,
  findUserByIdentifier,
  getUser,
  getVipProfile,
  hashSecret,
  insertOutbox,
  listSecurityQuestions,
  listTicketsForUser,
  lockUser,
  maskEmail,
  maskPhone,
  normalizeAnswer,
  redactText,
  updateTicket,
  verifySecret,
  writeAudit,
  type Db,
  type UserRow,
} from '@vsd/db';
import { PIPELINES, type StartablePipeline, type ToolName, type VerificationPolicy } from '@vsd/pipelines';
import { natoSpell } from './nato';
import type { AgentDeps, Session, ToolSpec } from './types';

// secret: the caller turn is in verification, so text the model writes may repeat an answer and is stored fully redacted.
export type ToolContext = Omit<Required<AgentDeps>, 'llm'> & { s: Session; secret?: boolean };
export interface ToolResult {
  outcome: string;
  data: object;
}
interface Tool {
  description: string;
  schema: z.ZodType;
  run: (ctx: ToolContext, args: any) => Promise<ToolResult>;
}

const VIP_POLICY = PIPELINES.vip.verification!;
// Times of recent wrong answers per account. Session counters start over in every call, so these also count across
// calls, or a caller who stops one short of the limit each time could keep guessing. In memory, like the rate limits.
const failedAnswers = new Map<string, number[]>();
const NUMBER_WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
const sixDigits = z.preprocess(
  (v) => String(v).toLowerCase().replace(/[a-z]+/g, (w) => NUMBER_WORDS[w] ?? w).replace(/\D/g, ''),
  z.string().regex(/^\d{6}$/, 'must be exactly six digits'),
);
const PASSWORD_SETS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!#$%*?'];
const PASSWORD_CHARS = PASSWORD_SETS.join('');

export function audit(ctx: { db: Db; s: Session }, event: string, detail: object = {}): Promise<void> {
  return writeAudit(ctx.db, { session_id: ctx.s.id, user_id: ctx.s.candidate?.userId ?? null, event, detail });
}

export function isVerifiedFor(s: Session): boolean {
  return !!s.candidate?.userId && s.verified && (!s.candidate.isVip || (s.questionsPassed && s.pinPassed));
}

export function spokenSymbols(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+dash\s+/g, '-')
    .replace(/\s+underscore\s+/g, '_')
    .replace(/\s+at\s+/g, '@')
    // A run spelled one character at a time ("s o f i a") is one word, so a spelled address is matched whole.
    .replace(/(?<=(?:^|[\s.@_-])\w)\s+(?=\w(?:$|[\s.@_-]))/g, '');
}

// Emails (written, or spoken once spokenSymbols ran) and employee ids (E + 5 digits, spaces or dashes allowed).
export const IDENTIFIERS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\be[\s-]*\d(?:[\s-]*\d){4}\b/g;

export function normalizeIdentifier(raw: string): string {
  const s = spokenSymbols(raw).replace(/\s+/g, '').replace(/[.,;:!?]+$/, '');
  return /^e(?:-?\d){5}$/.test(s) ? `E${s.replace(/\D/g, '')}` : s;
}

export function switchPipeline(s: Session, name: StartablePipeline): void {
  if (s.candidate?.isVip) return;
  const def = PIPELINES[name];
  s.pipeline = name;
  s.state = !def.verification ? def.initial : s.verified ? def.actionState! : s.candidate ? 'ask_question' : def.initial;
}

export async function setCandidate(ctx: ToolContext, identifier: string, user: UserRow | null): Promise<void> {
  const { s, db } = ctx;
  s.candidate = user
    ? { token: randomUUID(), userId: user.id, isVip: user.is_vip }
    : { token: randomUUID(), userId: null, isVip: false, decoyKey: createHash('sha256').update(identifier).digest('hex') };
  if (!user?.is_vip) return;
  s.pipeline = 'vip';
  s.state = PIPELINES.vip.initial;
  const vip = await getVipProfile(db, user.id);
  const ticket = await createTicket(db, {
    user_id: user.id,
    session_id: s.id,
    priority: 'P3',
    category: vip!.concierge_queue,
    summary: 'Executive support contact via service desk',
  });
  s.vipTicketId = ticket.id;
  await audit(ctx, 'vip_handoff', { ticket_number: ticket.id });
}

async function deny(ctx: ToolContext, tool: ToolName, error: 'not_verified' | 'not_available' = 'not_available'): Promise<ToolResult> {
  await audit(ctx, 'gate_denied', { tool, error });
  return { outcome: 'denied', data: { error } };
}

function decoyQuestions(decoyKey: string): { id: string; question_text: string }[] {
  const bytes = Buffer.from(decoyKey, 'hex');
  const pool = [...QUESTION_POOL];
  return [0, 1, 2].map((i) => {
    const { key, text } = pool.splice(bytes[i] % pool.length, 1)[0];
    return { id: key, question_text: text };
  });
}

async function lockout(ctx: ToolContext, policy: VerificationPolicy): Promise<void> {
  const { s, db } = ctx;
  const userId = s.candidate!.userId;
  s.status = 'locked';
  // Every pipeline checks the same security answers, so every lockout locks the account (a decoy has none to lock);
  // a lock that only one pipeline set would leave the others as an unthrottled way to guess them.
  if (userId) await lockUser(db, userId, new Date(ctx.now().getTime() + policy.lockAccountMinutes * 60_000));
  if (s.candidate!.isVip) {
    const patch = { priority: policy.lockoutTicket.priority, summary: 'Executive verification failed; call back on file number' };
    if (s.vipTicketId) await updateTicket(db, s.vipTicketId, patch);
    else s.vipTicketId = (await createTicket(db, { user_id: userId, session_id: s.id, category: policy.lockoutTicket.category, ...patch })).id;
    return audit(ctx, 'vip_verification_failed', { ticket_number: s.vipTicketId });
  }
  const ticket = await createTicket(db, {
    user_id: userId,
    session_id: s.id,
    ...policy.lockoutTicket,
    summary: `Identity verification failed (${s.pipeline})`,
  });
  await audit(ctx, 'verification_locked', { pipeline: s.pipeline, ticket_number: ticket.id });
}

async function failAttempt(ctx: ToolContext, policy: VerificationPolicy): Promise<ToolResult> {
  const { s } = ctx;
  const userId = s.candidate!.userId;
  const now = ctx.now().getTime();
  const lockMs = policy.lockAccountMinutes * 60_000;
  const recent = userId ? [...(failedAnswers.get(userId) ?? []), now].filter((t) => t > now - lockMs) : [];
  if (userId) failedAnswers.set(userId, recent);
  s.failedAttempts++;
  const lockedOut = s.failedAttempts >= policy.maxFailures;
  if (lockedOut) await lockout(ctx, policy);
  // Only the account locks: the call goes on with its own count, so the caller hears what a decoy's caller would.
  else if (recent.length >= policy.maxFailures) {
    await lockUser(ctx.db, userId!, new Date(now + lockMs));
    await audit(ctx, 'account_locked');
  }
  return { outcome: lockedOut ? 'locked_out' : 'fail', data: { result: 'fail', attempts_remaining: policy.maxFailures - s.failedAttempts } };
}

const vipStep = (s: Session) => !!s.candidate?.isVip && s.questionsPassed && !s.verified;
const spaced = (digits: string) => digits.split('').join(' ');

function tempPassword(): string {
  for (;;) {
    const pw = Array.from({ length: 16 }, () => PASSWORD_CHARS[randomInt(PASSWORD_CHARS.length)]).join('');
    if (PASSWORD_SETS.every((set) => [...pw].some((c) => set.includes(c)))) return pw;
  }
}

function tool<S extends z.ZodType>(description: string, schema: S, run: (ctx: ToolContext, args: z.output<S>) => Promise<ToolResult>): Tool {
  return { description, schema, run };
}

export const TOOLS: Record<ToolName, Tool> = {
  start_pipeline: tool(
    'Switch to the workflow the caller needs.',
    z.object({ name: z.enum(['general_help', 'username_recovery', 'password_reset', 'ticket_status']) }),
    async (ctx, { name }) => {
      switchPipeline(ctx.s, name);
      return { outcome: 'started', data: { pipeline: name } };
    },
  ),

  lookup_account: tool(
    'Look up the account from the email, employee ID, or username the caller gave.',
    z.object({ identifier: z.string().min(1).describe('Only the email, employee ID, or username, word for word as the caller said it') }),
    async (ctx, { identifier }) => {
      if (ctx.s.candidate) return deny(ctx, 'lookup_account');
      // The candidate is fixed once set, so an email or employee id inside a whole sentence must still find the account.
      const normalized = normalizeIdentifier(spokenSymbols(identifier).match(IDENTIFIERS)?.[0] ?? identifier);
      await setCandidate(ctx, normalized, await findUserByIdentifier(ctx.db, normalized));
      return { outcome: 'found', data: { candidate: ctx.s.candidate!.token, next: 'ask the security questions' } };
    },
  ),

  get_next_security_question: tool('Get the next security question to ask the caller.', z.object({}), async (ctx) => {
    const { s } = ctx;
    if (!s.candidate || !PIPELINES[s.pipeline].verification || s.questionsPassed) return deny(ctx, 'get_next_security_question');
    if (!s.pendingQuestion) {
      const questions = s.candidate.userId ? await listSecurityQuestions(ctx.db, s.candidate.userId) : decoyQuestions(s.candidate.decoyKey!);
      const start = s.questionsAsked % questions.length;
      const q = [...questions.slice(start), ...questions.slice(0, start)].find((c) => !s.passedQuestionIds.includes(c.id))!;
      s.pendingQuestion = { id: q.id, text: q.question_text };
      s.questionsAsked++;
    }
    return { outcome: 'asked', data: { question: s.pendingQuestion.text } };
  }),

  verify_security_answer: tool(
    "Check the caller's answer to the security question that was just asked.",
    z.object({ answer: z.string().min(1).describe("Only the caller's answer, word for word, without the words around it") }),
    async (ctx, { answer }) => {
      const { s } = ctx;
      const policy = PIPELINES[s.pipeline].verification;
      const q = s.pendingQuestion;
      if (!q || !policy) return deny(ctx, 'verify_security_answer');
      s.pendingQuestion = undefined;
      const user = s.candidate!.userId ? await getUser(ctx.db, s.candidate!.userId) : null;
      const failureLocked = !!user?.locked_until && user.locked_until > ctx.now();
      const hash = user && !failureLocked ? (await listSecurityQuestions(ctx.db, user.id)).find((r) => r.id === q.id)?.answer_hash : undefined;
      // Decoys and accounts in a failure lockout still pay for one argon2 verify (equal timing) and can never pass,
      // so calling back during the lockout cannot bypass it.
      const ok = (await verifySecret(hash ?? DUMMY_HASH, normalizeAnswer(answer))) && !!hash;
      if (!ok) return failAttempt(ctx, policy);
      s.answersPassed++;
      s.passedQuestionIds.push(q.id);
      const data = { result: 'pass', attempts_remaining: policy.maxFailures - s.failedAttempts };
      if (s.answersPassed < policy.requiredAnswers) return { outcome: 'pass', data };
      s.questionsPassed = true;
      if (!s.candidate!.isVip) {
        s.verified = true;
        s.verifiedAt = ctx.now();
      }
      return { outcome: 'complete', data };
    },
  ),

  verify_vip_pin: tool('Check the six-digit PIN the caller said.', z.object({ pin: sixDigits }), async (ctx, { pin }) => {
    const { s } = ctx;
    if (!vipStep(s) || s.pinPassed) return deny(ctx, 'verify_vip_pin');
    const vip = await getVipProfile(ctx.db, s.candidate!.userId!);
    if (!(await verifySecret(vip!.pin_hash, pin))) return failAttempt(ctx, VIP_POLICY);
    s.pinPassed = true;
    return { outcome: 'pass', data: { result: 'pass', attempts_remaining: VIP_POLICY.maxFailures - s.failedAttempts } };
  }),

  send_one_time_code: tool('Text a one-time code to the phone number on file.', z.object({}), async (ctx) => {
    const { s, db } = ctx;
    if (!vipStep(s) || !s.pinPassed) return deny(ctx, 'send_one_time_code');
    const sends = s.otp?.sends ?? 0;
    // Out of codes ends verification like a failed factor, so the caller still gets the P1 ticket and the callback.
    if (sends >= 3) {
      await lockout(ctx, VIP_POLICY);
      return { outcome: 'locked_out', data: { result: 'fail', attempts_remaining: 0 } };
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const vip = (await getVipProfile(db, s.candidate!.userId!))!;
    s.otp = { hash: await hashSecret(code), expiresAt: new Date(ctx.now().getTime() + 5 * 60_000), sends: sends + 1 };
    await insertOutbox(db, {
      user_id: vip.user_id,
      channel: 'sms',
      destination_masked: maskPhone(vip.callback_phone_last4),
      body: `Contoso Health service desk code: ${code}. It expires in 5 minutes. Never share it with anyone who calls you.`,
    });
    await audit(ctx, 'otp_sent', { sends: s.otp.sends });
    return { outcome: 'sent', data: { sent_to: `the phone number on file ending in ${spaced(vip.callback_phone_last4)}` } };
  }),

  verify_one_time_code: tool('Check the one-time code the caller read back.', z.object({ code: sixDigits }), async (ctx, { code }) => {
    const { s } = ctx;
    if (!vipStep(s) || !s.pinPassed || !s.otp) return deny(ctx, 'verify_one_time_code');
    // An expired code stays on the session (it can never match again): clearing it would reset the 3-send limit.
    if (s.otp.expiresAt <= ctx.now()) return { outcome: 'expired', data: { result: 'expired' } };
    if (!(await verifySecret(s.otp.hash, code))) return failAttempt(ctx, VIP_POLICY);
    s.otp = undefined;
    s.verified = true;
    s.verifiedAt = ctx.now();
    return { outcome: 'pass', data: { result: 'pass' } };
  }),

  recover_username: tool('Email the username to the address on file.', z.object({}), async (ctx) => {
    const { s } = ctx;
    if (!isVerifiedFor(s)) return deny(ctx, 'recover_username', 'not_verified');
    const user = (await getUser(ctx.db, s.candidate!.userId!))!;
    await insertOutbox(ctx.db, {
      user_id: user.id,
      channel: 'email',
      destination_masked: maskEmail(user.email),
      body: `Your Contoso Health username is ${user.username}.`,
    });
    await audit(ctx, 'username_recovered');
    const sent_to = 'the email address on file';
    return { outcome: 'done', data: s.candidate!.isVip ? { sent_to, read_aloud: false } : { username_spelled: natoSpell(user.username), sent_to } };
  }),

  reset_password: tool('Reset the password and send a temporary one to the contacts on file.', z.object({}), async (ctx) => {
    const { s, db } = ctx;
    if (!isVerifiedFor(s)) return deny(ctx, 'reset_password', 'not_verified');
    const user = (await getUser(db, s.candidate!.userId!))!;
    const password = tempPassword();
    const { wasLocked } = await completePasswordReset(db, user.id);
    const body = `Your Contoso Health password was reset.\nTemporary password: ${password}\nYou must change it at your next sign-in.`;
    await insertOutbox(db, { user_id: user.id, channel: 'email', destination_masked: maskEmail(user.email), body });
    await insertOutbox(db, { user_id: user.id, channel: 'sms', destination_masked: maskPhone(user.phone_last4), body });
    const sent_to = ['the email address on file', `the mobile phone ending in ${spaced(user.phone_last4)}`];
    if (s.candidate!.isVip) {
      const vip = (await getVipProfile(db, user.id))!;
      await insertOutbox(db, {
        user_id: user.id,
        channel: 'sms',
        destination_masked: maskPhone(vip.assistant_phone_last4),
        body: `Contoso Health password reset for ${user.first_name} ${user.last_name}.\nTemporary password: ${password}\nIt must be changed at next sign-in.`,
      });
      sent_to.push('your executive assistant');
    }
    await audit(ctx, 'password_reset', { account_unlocked: wasLocked });
    return { outcome: 'done', data: { sent_to, must_change_at_next_sign_in: true, account_unlocked: wasLocked } };
  }),

  search_kb: tool(
    "Search the knowledge base for the caller's question.",
    z.object({ query: z.string().min(1) }),
    async (ctx, { query }) => {
      const chunks = await ctx.retrieve(query);
      return chunks.length
        ? { outcome: 'match', data: { articles: chunks.map(({ title, updated, text }) => ({ title, updated, text })) } }
        : { outcome: 'no_match', data: { articles: [], note: 'No matching article. Offer to open a ticket.' } };
    },
  ),

  get_ticket_status: tool("Get the caller's most recent tickets.", z.object({}), async (ctx) => {
    const { s } = ctx;
    if (!isVerifiedFor(s)) return deny(ctx, 'get_ticket_status', 'not_verified');
    const tickets = await listTicketsForUser(ctx.db, s.candidate!.userId!);
    return {
      outcome: 'done',
      data: {
        tickets: tickets.map((t) => ({
          number: t.id,
          priority: t.priority,
          status: t.status,
          summary: t.summary,
          opened: t.created_at.toISOString().slice(0, 10),
        })),
      },
    };
  }),

  create_ticket: tool(
    "Open a support ticket for the caller's issue.",
    z.object({ priority: z.enum(['P1', 'P2', 'P3', 'P4']), category: z.string().min(1), summary: z.string().min(1) }),
    async (ctx, t) => {
      const ticket = await createTicket(ctx.db, {
        ...t,
        user_id: isVerifiedFor(ctx.s) ? ctx.s.candidate!.userId : null,
        session_id: ctx.s.id,
        category: redactText(t.category, { fully: ctx.secret }),
        summary: redactText(t.summary, { fully: ctx.secret }),
      });
      return { outcome: 'created', data: { ticket_number: ticket.id } };
    },
  ),

  escalate: tool('Hand the call to a human specialist.', z.object({ reason: z.string().min(1) }), async (ctx, { reason }) => {
    const ticket = await createTicket(ctx.db, {
      user_id: isVerifiedFor(ctx.s) ? ctx.s.candidate!.userId : null,
      session_id: ctx.s.id,
      priority: 'P2',
      category: 'escalation',
      summary: redactText(reason, { fully: ctx.secret }),
    });
    ctx.s.status = 'escalated';
    return { outcome: 'escalated', data: { ticket_number: ticket.id, message: 'A specialist will follow up.' } };
  }),

  // The summary is model-written text that may repeat answers, and nothing reads it, so it is not stored.
  end_call: tool('End the call once the caller has nothing else.', z.object({ summary: z.string() }), async (ctx) => {
    ctx.s.status = 'ended';
    ctx.s.endedAt = ctx.now();
    await audit(ctx, 'call_ended');
    return { outcome: 'ended', data: { ended: true } };
  }),
};

export function toolSpecs(names: readonly ToolName[]): ToolSpec[] {
  return names.map((name) => {
    const { $schema, ...parameters } = z.toJSONSchema(TOOLS[name].schema, { io: 'input' });
    return { name, description: TOOLS[name].description, parameters };
  });
}

export async function runTool(ctx: ToolContext, name: ToolName, args: unknown): Promise<ToolResult> {
  if (ctx.s.status !== 'active' && name !== 'end_call') return deny(ctx, name);
  return TOOLS[name].run(ctx, TOOLS[name].schema.parse(args));
}
