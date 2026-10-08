import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { indexKb } from '@vsd/rag';
import type pg from 'pg';
import { hashSecret, normalizeAnswer } from './crypto';
import { loadEnv, REPO_ROOT } from './env';
import { closePools, getPool } from './pool';
import { buildSeedData, type SeedUser } from './seed-data';

export async function seedDatabase(
  db: pg.Pool,
  opts: { writeAnswersFile?: boolean } = {},
): Promise<{ users: number; questions: number; vips: number; tickets: number; articles: number; chunks: number }> {
  const data = buildSeedData();
  const users = await Promise.all(
    data.users.map(async (u) => ({
      ...u,
      answerHashes: await Promise.all(u.questions.map((q) => hashSecret(normalizeAnswer(q.answer)))),
      pinHash: u.vip && (await hashSecret(u.vip.pin)),
    })),
  );
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `TRUNCATE servicedesk.users, servicedesk.security_questions, servicedesk.vip_profiles, servicedesk.sessions,
         servicedesk.tickets, servicedesk.outbox, servicedesk.audit_log RESTART IDENTITY CASCADE`,
    );
    const ids = new Map<string, string>();
    for (const u of users) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO servicedesk.users
           (username, email, employee_id, first_name, last_name, department, title, phone_last4, is_vip, is_locked)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [u.username, u.email, u.employee_id, u.first_name, u.last_name, u.department, u.title, u.phone_last4, u.is_vip, u.is_locked],
      );
      const id = rows[0].id;
      ids.set(u.username, id);
      for (const [i, q] of u.questions.entries()) {
        await client.query(
          'INSERT INTO servicedesk.security_questions (user_id, question_text, answer_hash, position) VALUES ($1, $2, $3, $4)',
          [id, q.text, u.answerHashes[i], q.position],
        );
      }
      if (u.vip) {
        await client.query(
          `INSERT INTO servicedesk.vip_profiles
             (user_id, pin_hash, executive_assistant_name, assistant_phone_last4, callback_phone_last4, concierge_queue)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, u.pinHash, u.vip.executive_assistant_name, u.vip.assistant_phone_last4, u.vip.callback_phone_last4, u.vip.concierge_queue],
        );
      }
    }
    for (const t of data.tickets) {
      await client.query(
        'INSERT INTO servicedesk.tickets (user_id, priority, category, summary, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [ids.get(t.username), t.priority, t.category, t.summary, t.status, t.created_at],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const kb = await indexKb(db, resolve(REPO_ROOT, 'seed/kb'));
  if (opts.writeAnswersFile !== false) writeFileSync(resolve(REPO_ROOT, 'seed/ANSWERS.local.md'), answersMarkdown(data.users));
  return {
    users: data.users.length,
    questions: data.users.flatMap((u) => u.questions).length,
    vips: data.users.filter((u) => u.vip).length,
    tickets: data.tickets.length,
    ...kb,
  };
}

function answersMarkdown(users: SeedUser[]): string {
  const vips = users.filter((u) => u.vip);
  const [exec] = vips;
  const vip = exec.vip!;
  return `# Seed answers and PINs

> **Fake data, never commit.** \`pnpm seed\` writes this file and git ignores it. It holds the plaintext security
> answers and VIP PINs; the database stores only argon2id hashes. Answers match regardless of case, punctuation and
> extra spaces.

## Users

Locked users have a directory lockout that a successful password reset clears.

| Username | Employee ID | Email | Locked | Question 1 | Answer 1 | Question 2 | Answer 2 | Question 3 | Answer 3 |
|---|---|---|---|---|---|---|---|---|---|
${users.map((u) => `| ${u.username} | ${u.employee_id} | ${u.email} | ${u.is_locked ? 'yes' : 'no'} | ${u.questions.map((q) => `${q.text} | ${q.answer}`).join(' | ')} |`).join('\n')}

## VIP users

| Username | Employee ID | Title | PIN | Executive assistant | Assistant phone ends | Callback phone ends |
|---|---|---|---|---|---|---|
${vips.map((u) => `| ${u.username} | ${u.employee_id} | ${u.title} | ${u.vip!.pin} | ${u.vip!.executive_assistant_name} | ${u.vip!.assistant_phone_last4} | ${u.vip!.callback_phone_last4} |`).join('\n')}

## Drive the VIP flow

1. Start the agent: \`pnpm chat\` for text, or \`pnpm start\` and open http://127.0.0.1:3000 for voice.
2. Ask for something and give the employee ID, for example: "I need to reset my password, my employee ID is ${exec.employee_id}."
3. Answer the security questions one at a time; two correct answers are needed. ${exec.first_name} ${exec.last_name}'s answers: ${exec.questions.map((q) => `"${q.text}" ${q.answer}`).join('; ')}.
4. When asked for the PIN, say ${vip.pin}.
5. In another terminal run \`pnpm outbox\`. The newest SMS, to the phone ending ${vip.callback_phone_last4}, holds the six-digit one-time code. It expires in 5 minutes.
6. Read the code back. Once verified, the agent carries out the request: a password reset sends the temporary password by email and SMS to ${exec.first_name} ${exec.last_name}, and an SMS to ${vip.executive_assistant_name} at the phone ending ${vip.assistant_phone_last4}.

Two failures in total across the questions, PIN and code end verification and open a P1 executive-support ticket.
`;
}

if (import.meta.filename === process.argv[1]) {
  loadEnv();
  const counts = await seedDatabase(getPool());
  console.log(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', '));
  console.log('Plaintext answers and PINs for testers: seed/ANSWERS.local.md');
  await closePools();
}
