import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildSeedData,
  closePools,
  findUserByIdentifier,
  getPool,
  getVipProfile,
  listSecurityQuestions,
  normalizeAnswer,
  QUESTION_POOL,
  REPO_ROOT,
  verifySecret,
} from '../src/index';

const ARGON2ID = /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;
const data = buildSeedData();
const vips = data.users.filter((u) => u.is_vip);
const usernames = data.users.map((u) => u.username);
const byUsername = [...data.users].sort((a, b) => (a.username < b.username ? -1 : 1));
const secrets = [
  ...data.users.flatMap((u) => u.questions.flatMap((q) => [q.answer.toLowerCase(), normalizeAnswer(q.answer)])),
  ...vips.map((u) => u.vip!.pin),
];
const leaked = (text: string) => secrets.filter((s) => text.toLowerCase().includes(s));

describe('buildSeedData', () => {
  it('is deterministic', () => {
    expect(buildSeedData()).toEqual(data);
  });

  it('has 40 standard users and 5 VIPs in the directory formats', () => {
    expect([data.users.length, vips.length]).toEqual([45, 5]);
    expect(vips.map((u) => u.title).sort()).toEqual([
      'Chief Executive Officer',
      'Chief Financial Officer',
      'Chief Information Officer',
      'Chief Medical Officer',
      'General Counsel',
    ]);
    for (const u of data.users) {
      expect(u.email).toBe(`${u.first_name}.${u.last_name}@contoso-health.example`.toLowerCase());
      expect(u.username).toMatch(/^[a-z]+\d*$/);
      expect(u.username.replace(/\d+$/, '')).toBe((u.first_name[0] + u.last_name).toLowerCase());
      if (/\d$/.test(u.username)) expect(usernames).toContain(u.username.replace(/\d+$/, ''));
      expect(u.employee_id).toMatch(/^E\d{5}$/);
      expect(u.phone_last4).toMatch(/^\d{4}$/);
      expect(['Claims', 'Finance', 'HR', 'Clinical Ops', 'IT', 'Legal', 'Facilities']).toContain(u.department);
      expect(Boolean(u.vip)).toBe(u.is_vip);
    }
    for (const u of vips) {
      expect(u.vip).toMatchObject({
        pin: expect.stringMatching(/^\d{6}$/),
        executive_assistant_name: expect.stringMatching(/^\S+ \S+$/),
        assistant_phone_last4: expect.stringMatching(/^\d{4}$/),
        callback_phone_last4: expect.stringMatching(/^\d{4}$/),
        concierge_queue: 'executive-support',
      });
    }
  });

  it('locks exactly 5 standard users', () => {
    const locked = data.users.filter((u) => u.is_locked);
    expect(locked).toHaveLength(5);
    expect(locked.some((u) => u.is_vip)).toBe(false);
  });

  it('keeps usernames, emails and employee ids unique across both files', () => {
    const ids = data.users.flatMap((u) => [u.username, u.email, u.employee_id].map((s) => s.toLowerCase()));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('spreads VIP employee ids among the others instead of a recognizable block', () => {
    const sorted = data.users.map((u) => u.employee_id).sort();
    const ranks = vips.map((u) => sorted.indexOf(u.employee_id));
    expect(Math.max(...ranks) - Math.min(...ranks)).toBeGreaterThan(sorted.length / 2);
  });

  it('gives everyone 3 distinct pool questions with answers that exercise normalization', () => {
    for (const u of data.users) {
      expect(u.questions.map((q) => q.position)).toEqual([1, 2, 3]);
      expect(new Set(u.questions.map((q) => q.key)).size).toBe(3);
      for (const q of u.questions) {
        expect(QUESTION_POOL).toContainEqual({ key: q.key, text: q.text });
        expect(normalizeAnswer(q.answer)).not.toBe('');
      }
    }
    const asked = data.users.flatMap((u) => u.questions);
    expect(new Set(asked.map((q) => q.key)).size).toBe(QUESTION_POOL.length);
    expect(asked.some((q) => q.answer.includes(' '))).toBe(true);
    expect(asked.some((q) => /\p{P}/u.test(q.answer))).toBe(true);
  });

  it('has 25 tickets dated before 2026-10-01, 2 or 3 of them for VIPs, oldest first', () => {
    const vipTickets = data.tickets.filter((t) => vips.some((u) => u.username === t.username));
    expect(data.tickets).toHaveLength(25);
    expect(vipTickets.length).toBeGreaterThanOrEqual(2);
    expect(vipTickets.length).toBeLessThanOrEqual(3);
    expect(new Set(data.tickets.map((t) => t.category))).toEqual(
      new Set(['hardware', 'software', 'network', 'access', 'email', 'printing']),
    );
    expect(new Set(data.tickets.map((t) => t.status))).toEqual(
      new Set(['open', 'in_progress', 'waiting_on_user', 'resolved', 'closed']),
    );
    for (const t of data.tickets) {
      expect(usernames).toContain(t.username);
      expect(t.created_at < '2026-10-01').toBe(true);
    }
    const dates = data.tickets.map((t) => t.created_at);
    expect(dates).toEqual([...dates].sort());
  });

  it('keeps answers and PINs out of the committed JSON files', () => {
    const profile = ['username', 'email', 'employee_id', 'first_name', 'last_name', 'department', 'title', 'phone_last4', 'is_locked'];
    const files = {
      'users.json': profile,
      'vip.json': [...profile, 'executive_assistant_name', 'assistant_phone_last4', 'callback_phone_last4'],
    };
    for (const [file, keys] of Object.entries(files)) {
      const raw = readFileSync(resolve(REPO_ROOT, 'seed', file), 'utf8');
      for (const row of JSON.parse(raw)) expect(Object.keys(row)).toEqual(keys);
      expect(raw).not.toMatch(/\d{6}/);
      expect(leaked(raw)).toEqual([]);
    }
  });
});

describe('seeded database', () => {
  const db = getPool();
  afterAll(closePools);

  it('holds the seed users, security questions and VIP profiles', async () => {
    const users = await db.query(
      `SELECT username, email, employee_id, first_name, last_name, department, title, phone_last4, is_vip
       FROM servicedesk.users WHERE username = ANY($1) ORDER BY username COLLATE "C"`,
      [usernames],
    );
    const questions = await db.query(
      `SELECT u.username, q.position, q.question_text AS text
       FROM servicedesk.security_questions q JOIN servicedesk.users u ON u.id = q.user_id
       WHERE u.username = ANY($1) ORDER BY u.username COLLATE "C", q.position`,
      [usernames],
    );
    const profiles = await db.query(
      `SELECT u.username, v.executive_assistant_name, v.assistant_phone_last4, v.callback_phone_last4, v.concierge_queue
       FROM servicedesk.vip_profiles v JOIN servicedesk.users u ON u.id = v.user_id
       WHERE u.username = ANY($1) ORDER BY u.username COLLATE "C"`,
      [usernames],
    );
    expect(byUsername).toMatchObject(users.rows);
    expect(byUsername.flatMap((u) => u.questions.map((q) => ({ username: u.username, ...q })))).toMatchObject(questions.rows);
    expect(byUsername.filter((u) => u.vip).map((u) => ({ username: u.username, ...u.vip }))).toMatchObject(profiles.rows);
  });

  it('numbers the seed tickets from 10001 in date order', async () => {
    const { rows } = await db.query(
      `SELECT u.username, t.priority, t.category, t.summary, t.status, t.created_at
       FROM servicedesk.tickets t JOIN servicedesk.users u ON u.id = t.user_id
       WHERE t.id BETWEEN 10001 AND 10025 ORDER BY t.id`,
    );
    expect(rows).toEqual(data.tickets.map((t) => ({ ...t, created_at: new Date(t.created_at) })));
  });

  it('stores argon2id hashes and no plaintext answer or PIN', async () => {
    const { rows } = await db.query<{ plain: string; answer_hash: string; pin_hash: string | null }>(
      `SELECT (to_jsonb(u) - 'id' - 'created_at' - 'locked_until')::text || (to_jsonb(q) - 'id' - 'user_id' - 'answer_hash')::text
                || coalesce((to_jsonb(v) - 'user_id' - 'pin_hash')::text, '') AS plain,
              q.answer_hash, v.pin_hash
       FROM servicedesk.users u
       JOIN servicedesk.security_questions q ON q.user_id = u.id
       LEFT JOIN servicedesk.vip_profiles v ON v.user_id = u.id
       WHERE u.username = ANY($1)`,
      [usernames],
    );
    expect(rows).toHaveLength(135);
    for (const r of rows) {
      expect(r.answer_hash).toMatch(ARGON2ID);
      if (r.pin_hash !== null) expect(r.pin_hash).toMatch(ARGON2ID);
    }
    expect(rows.flatMap((r) => leaked(r.plain))).toEqual([]);
  });

  it('verifies sampled answers however the caller formats them, and every VIP PIN', async () => {
    const sample = [
      data.users[0],
      data.users.find((u) => u.is_locked)!,
      vips[0],
      data.users.find((u) => u.questions.some((q) => /\p{P}/u.test(q.answer)))!,
    ];
    const cases: [hash: string, said: string, ok: boolean][] = [];
    for (const u of sample) {
      const stored = await listSecurityQuestions(db, (await findUserByIdentifier(db, u.username))!.id);
      u.questions.forEach((q, i) => {
        for (const said of [q.answer.toUpperCase(), `  ${q.answer.replaceAll(' ', '   ')} `, `${q.answer}?!`]) {
          cases.push([stored[i].answer_hash, normalizeAnswer(said), true]);
        }
        cases.push([stored[i].answer_hash, normalizeAnswer(u.questions[(i + 1) % 3].answer), false]);
      });
    }
    for (const u of vips) {
      const { pin_hash } = (await getVipProfile(db, (await findUserByIdentifier(db, u.username))!.id))!;
      cases.push([pin_hash, u.vip!.pin, true], [pin_hash, String((Number(u.vip!.pin) + 1) % 1e6).padStart(6, '0'), false]);
    }
    expect(await Promise.all(cases.map(([hash, said]) => verifySecret(hash, said)))).toEqual(cases.map(([, , ok]) => ok));
  });
});
