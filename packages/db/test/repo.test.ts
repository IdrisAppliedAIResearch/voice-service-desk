import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closePools,
  completePasswordReset,
  createTicket,
  findUserByIdentifier,
  getPool,
  getUser,
  getVipProfile,
  insertOutbox,
  listOutbox,
  listSecurityQuestions,
  listTicketsForUser,
  lockUser,
  maskEmail,
  maskPhone,
  updateTicket,
  upsertSession,
  writeAudit,
} from '../src/index';

const db = getPool();
const tag = randomUUID().slice(0, 8);
const fixture = {
  username: `fixture${tag}`,
  email: `fixture.${tag}@contoso-health.example`,
  employee_id: `T${tag.toUpperCase()}`,
};
let userId: string;

beforeAll(async () => {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO servicedesk.users (username, email, employee_id, first_name, last_name, department, title, phone_last4)
     VALUES ($1, $2, $3, 'Fixture', 'User', 'IT', 'Analyst', '0000') RETURNING id`,
    [fixture.username, fixture.email, fixture.employee_id],
  );
  userId = rows[0].id;
});

afterAll(closePools);

describe('findUserByIdentifier', () => {
  it.each([fixture.email.toUpperCase(), fixture.employee_id.toLowerCase(), fixture.username.toUpperCase()])(
    'finds the user by %s',
    async (identifier) => {
      expect((await findUserByIdentifier(db, identifier))?.id).toBe(userId);
    },
  );

  it('returns null for an unknown identifier', async () => {
    expect(await findUserByIdentifier(db, `nobody.${tag}@contoso-health.example`)).toBeNull();
  });
});

describe('repo', () => {
  it('reads questions in position order and finds no VIP profile for a standard user', async () => {
    await db.query(
      `INSERT INTO servicedesk.security_questions (user_id, question_text, answer_hash, position)
       VALUES ($1, 'q3', 'h', 3), ($1, 'q1', 'h', 1), ($1, 'q2', 'h', 2)`,
      [userId],
    );
    expect((await listSecurityQuestions(db, userId)).map((q) => q.question_text)).toEqual(['q1', 'q2', 'q3']);
    expect(await getVipProfile(db, userId)).toBeNull();
  });

  it('completePasswordReset clears the lock and reports whether there was one', async () => {
    await lockUser(db, userId, new Date(Date.now() + 15 * 60_000));
    expect((await getUser(db, userId))?.locked_until).toBeInstanceOf(Date);
    expect(await completePasswordReset(db, userId)).toEqual({ wasLocked: true });
    expect(await getUser(db, userId)).toMatchObject({ is_locked: false, locked_until: null, must_change_password: true });
    expect(await completePasswordReset(db, userId)).toEqual({ wasLocked: false });
  });

  it('writeAudit stores redacted detail', async () => {
    const sessionId = randomUUID();
    await writeAudit(db, {
      session_id: sessionId,
      user_id: userId,
      event: 'fixture_event',
      detail: { answer: 'St. Louis', text: `code 123456 from ${fixture.email}` },
    });
    await writeAudit(db, { session_id: sessionId, user_id: null, event: 'fixture_empty' });
    const { rows } = await db.query(
      'SELECT user_id, event, detail FROM servicedesk.audit_log WHERE session_id = $1 ORDER BY id',
      [sessionId],
    );
    expect(rows).toEqual([
      { user_id: userId, event: 'fixture_event', detail: { answer: '[redacted]', text: 'code [code] from fi***' } },
      { user_id: null, event: 'fixture_empty', detail: {} },
    ]);
  });

  it('upsertSession inserts and then updates the row', async () => {
    const s = {
      id: randomUUID(),
      channel: 'text',
      pipeline: 'triage',
      state: 'greet',
      candidate_user_id: null,
      verified: false,
      verified_at: null,
      failed_attempts: 0,
      status: 'active',
      created_at: new Date(),
      ended_at: null,
    };
    await upsertSession(db, s);
    await upsertSession(db, {
      ...s,
      pipeline: 'password_reset',
      state: 'done',
      candidate_user_id: userId,
      verified: true,
      verified_at: new Date(),
      failed_attempts: 1,
      status: 'ended',
      ended_at: new Date(),
    });
    const { rows } = await db.query(
      `SELECT pipeline, state, candidate_user_id, verified, failed_attempts, status, ended_at IS NOT NULL AS ended
       FROM servicedesk.sessions WHERE id = $1`,
      [s.id],
    );
    expect(rows).toEqual([
      { pipeline: 'password_reset', state: 'done', candidate_user_id: userId, verified: true, failed_attempts: 1, status: 'ended', ended: true },
    ]);
  });

  it('creates tickets and lists them newest first', async () => {
    const first = await createTicket(db, { user_id: userId, session_id: null, priority: 'P3', category: 'fixture', summary: 'first' });
    const second = await createTicket(db, { user_id: userId, session_id: null, priority: 'P4', category: 'fixture', summary: 'second' });
    expect(first).toMatchObject({ priority: 'P3', status: 'open' });
    expect(typeof first.id).toBe('number');
    await updateTicket(db, first.id, { priority: 'P1', summary: 'first, raised' });
    expect((await listTicketsForUser(db, userId)).map((t) => [t.id, t.priority, t.status, t.summary])).toEqual([
      [second.id, 'P4', 'open', 'second'],
      [first.id, 'P1', 'open', 'first, raised'],
    ]);
  });

  it('listOutbox returns newest first and honours the filters', async () => {
    const a = await insertOutbox(db, { user_id: userId, channel: 'email', destination_masked: maskEmail(fixture.email), body: 'first' });
    const b = await insertOutbox(db, { user_id: userId, channel: 'sms', destination_masked: maskPhone('0000'), body: 'second' });
    expect((await listOutbox(db, { user_id: userId })).map((r) => r.id)).toEqual([b.id, a.id]);
    expect((await listOutbox(db, { limit: 1 })).map((r) => r.id)).toEqual([b.id]);
  });
});
