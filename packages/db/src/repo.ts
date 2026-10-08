import type { Db } from './pool';
import { redactDetail } from './redact';

export interface UserRow {
  id: string;
  username: string;
  email: string;
  employee_id: string;
  first_name: string;
  last_name: string;
  department: string;
  title: string;
  phone_last4: string;
  is_vip: boolean;
  is_locked: boolean;
  locked_until: Date | null;
  must_change_password: boolean;
  created_at: Date;
}

export interface QuestionRow {
  id: string;
  question_text: string;
  answer_hash: string;
  position: number;
}

export interface VipProfileRow {
  user_id: string;
  pin_hash: string;
  executive_assistant_name: string;
  assistant_phone_last4: string;
  callback_phone_last4: string;
  concierge_queue: string;
}

export interface TicketRow {
  id: number;
  user_id: string | null;
  session_id: string | null;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  category: string;
  summary: string;
  status: string;
  created_at: Date;
}

export interface OutboxRow {
  id: number;
  user_id: string | null;
  channel: 'email' | 'sms';
  destination_masked: string;
  body: string;
  created_at: Date;
}

export interface SessionRecord {
  id: string;
  channel: string;
  pipeline: string;
  state: string;
  candidate_user_id: string | null;
  verified: boolean;
  verified_at: Date | null;
  failed_attempts: number;
  status: string;
  created_at: Date;
  ended_at: Date | null;
}

export async function findUserByIdentifier(db: Db, normalizedIdentifier: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT * FROM servicedesk.users
     WHERE lower(email) = lower($1) OR upper(employee_id) = upper($1) OR lower(username) = lower($1)`,
    [normalizedIdentifier],
  );
  return rows[0] ?? null;
}

export async function getUser(db: Db, id: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>('SELECT * FROM servicedesk.users WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function listSecurityQuestions(db: Db, userId: string): Promise<QuestionRow[]> {
  const { rows } = await db.query<QuestionRow>(
    'SELECT id, question_text, answer_hash, position FROM servicedesk.security_questions WHERE user_id = $1 ORDER BY position',
    [userId],
  );
  return rows;
}

export async function getVipProfile(db: Db, userId: string): Promise<VipProfileRow | null> {
  const { rows } = await db.query<VipProfileRow>('SELECT * FROM servicedesk.vip_profiles WHERE user_id = $1', [userId]);
  return rows[0] ?? null;
}

export async function lockUser(db: Db, userId: string, until: Date): Promise<void> {
  await db.query('UPDATE servicedesk.users SET is_locked = true, locked_until = $2 WHERE id = $1', [userId, until]);
}

export async function completePasswordReset(db: Db, userId: string): Promise<{ wasLocked: boolean }> {
  const { rows } = await db.query<{ was_locked: boolean }>(
    `UPDATE servicedesk.users u SET must_change_password = true, is_locked = false, locked_until = NULL
     FROM servicedesk.users old WHERE u.id = $1 AND old.id = u.id
     RETURNING old.is_locked AS was_locked`,
    [userId],
  );
  return { wasLocked: rows[0]?.was_locked ?? false };
}

export async function upsertSession(db: Db, s: SessionRecord): Promise<void> {
  await db.query(
    `INSERT INTO servicedesk.sessions
       (id, channel, pipeline, state, candidate_user_id, verified, verified_at, failed_attempts, status, created_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO UPDATE SET pipeline = EXCLUDED.pipeline, state = EXCLUDED.state,
       candidate_user_id = EXCLUDED.candidate_user_id, verified = EXCLUDED.verified, verified_at = EXCLUDED.verified_at,
       failed_attempts = EXCLUDED.failed_attempts, status = EXCLUDED.status, ended_at = EXCLUDED.ended_at`,
    [s.id, s.channel, s.pipeline, s.state, s.candidate_user_id, s.verified, s.verified_at, s.failed_attempts, s.status, s.created_at, s.ended_at],
  );
}

export async function createTicket(
  db: Db,
  t: { user_id: string | null; session_id: string | null; priority: TicketRow['priority']; category: string; summary: string },
): Promise<TicketRow> {
  const { rows } = await db.query<TicketRow>(
    `INSERT INTO servicedesk.tickets (user_id, session_id, priority, category, summary)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [t.user_id, t.session_id, t.priority, t.category, t.summary],
  );
  return rows[0];
}

export async function updateTicket(db: Db, id: number, patch: { priority: TicketRow['priority']; summary: string }): Promise<void> {
  await db.query('UPDATE servicedesk.tickets SET priority = $2, summary = $3 WHERE id = $1', [id, patch.priority, patch.summary]);
}

export async function listTicketsForUser(db: Db, userId: string): Promise<TicketRow[]> {
  const { rows } = await db.query<TicketRow>(
    'SELECT * FROM servicedesk.tickets WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 5',
    [userId],
  );
  return rows;
}

export async function insertOutbox(
  db: Db,
  o: { user_id: string | null; channel: 'email' | 'sms'; destination_masked: string; body: string },
): Promise<OutboxRow> {
  const { rows } = await db.query<OutboxRow>(
    'INSERT INTO servicedesk.outbox (user_id, channel, destination_masked, body) VALUES ($1, $2, $3, $4) RETURNING *',
    [o.user_id, o.channel, o.destination_masked, o.body],
  );
  return rows[0];
}

export async function listOutbox(db: Db, f: { user_id?: string; limit?: number } = {}): Promise<OutboxRow[]> {
  const { rows } = await db.query<OutboxRow>(
    'SELECT * FROM servicedesk.outbox WHERE $1::uuid IS NULL OR user_id = $1 ORDER BY id DESC LIMIT $2',
    [f.user_id ?? null, f.limit ?? null],
  );
  return rows;
}

export async function writeAudit(
  db: Db,
  e: { session_id: string | null; user_id: string | null; event: string; detail?: object },
): Promise<void> {
  await db.query(
    'INSERT INTO servicedesk.audit_log (session_id, user_id, event, detail) VALUES ($1, $2, $3, $4)',
    [e.session_id, e.user_id, e.event, JSON.stringify(redactDetail(e.detail ?? {}))],
  );
}
