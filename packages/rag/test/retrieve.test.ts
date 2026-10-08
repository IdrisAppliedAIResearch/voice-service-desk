import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { retrieve } from '../src/index';

const kbDir = fileURLToPath(new URL('../../../seed/kb', import.meta.url));
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const slugs = async (query: string) => (await retrieve(db, query)).map((c) => c.slug);

beforeAll(async () => {
  vi.stubEnv('RAG_MIN_SCORE', undefined);
  // The global setup indexed seed/kb into the shared test database; tests never re-index it.
  const { rows } = await db.query<{ articles: number; chunks: number }>(
    'SELECT (SELECT count(*) FROM servicedesk.kb_articles)::int AS articles, (SELECT count(*) FROM servicedesk.kb_chunks)::int AS chunks',
  );
  expect(rows[0].articles).toBe((await readdir(kbDir)).filter((f) => f.endsWith('.md')).length);
  expect(rows[0].chunks).toBeGreaterThan(rows[0].articles);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.end();
});

describe('retrieve over the seeded knowledge base', () => {
  it('answers a VPN question from the GlobalProtect article and never the retired AnyConnect one', async () => {
    const found = await slugs('how do I connect to the VPN from home');
    expect(found[0]).toBe('vpn-setup-globalprotect');
    expect(found).not.toContain('vpn-setup-anyconnect');
  });

  it('keeps stale versions indexed but never returns them, even when the query names them', async () => {
    const { rows } = await db.query(`SELECT slug FROM servicedesk.kb_articles WHERE slug = 'vpn-setup-anyconnect'`);
    expect(rows).toHaveLength(1);
    expect(await slugs('cisco anyconnect vpn client')).not.toContain('vpn-setup-anyconnect');
  });

  it('answers password rules from the current policy only', async () => {
    const found = await slugs('how long does my new password have to be');
    expect(found).toContain('password-policy');
    expect(found).not.toContain('password-policy-2022');
  });

  it('answers service desk hours from the current article only', async () => {
    const found = await slugs('what hours is the service desk open on weekends');
    expect(found).toContain('service-desk-hours');
    expect(found).not.toContain('service-desk-hours-2023');
  });

  it('answers a short MFA enrollment question from the MFA setup article', async () => {
    expect((await slugs('how do I enroll in MFA'))[0]).toBe('mfa-enrollment');
  });

  it('answers a typed wifi question from the wifi article', async () => {
    expect((await slugs('how do I get on the wifi'))[0]).toBe('wifi-onboarding');
  });

  it('returns nothing for unrelated questions, even one that shares words with an article', async () => {
    expect(await retrieve(db, 'what is a good sourdough bread recipe')).toEqual([]);
    const sharesWords = 'who won the football game last night';
    expect((await retrieve(db, sharesWords, { minScore: 0 })).length).toBeGreaterThan(0);
    expect(await retrieve(db, sharesWords)).toEqual([]);
  });

  it('returns at most the limit, best first, with title and updated date', async () => {
    const all = await retrieve(db, 'how do I connect to the VPN from home', { minScore: 0 });
    expect(all).toHaveLength(5);
    expect(all.map((c) => c.score)).toEqual(all.map((c) => c.score).sort((a, b) => b - a));
    for (const c of all) {
      expect(c).toMatchObject({ articleId: expect.any(Number), title: expect.any(String), text: expect.any(String) });
      expect(c.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(all[0].slug).toBe('vpn-setup-globalprotect');
    expect(await retrieve(db, 'how do I connect to the VPN from home', { minScore: 0, limit: 2 })).toEqual(all.slice(0, 2));
  });
});
