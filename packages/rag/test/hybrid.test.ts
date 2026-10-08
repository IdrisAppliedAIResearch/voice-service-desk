import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../db/src/migrate';
import { embed, indexKb, retrieve } from '../src/index';

const meaning = (text: string) => [/vpn|house/i.test(text) ? 1 : 0, /password/i.test(text) ? 1 : 0, 0.1];

const requests: { url?: string; auth?: string; body: { model: string; input: string[]; encoding_format: string } }[] = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  requests.push({ url: req.url, auth: req.headers.authorization, body });
  const data = body.input.map((text: string, index: number) => ({ object: 'embedding', index, embedding: meaning(text) }));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ object: 'list', model: body.model, data: data.reverse(), usage: { prompt_tokens: 1, total_tokens: 1 } }));
});

const kb: [slug: string, title: string, updated: string, body: string, topic?: string][] = [
  ['vpn-anyconnect', 'Connect to the VPN with AnyConnect', '2023-03-01', 'Open AnyConnect and connect to the VPN.', 'vpn-setup'],
  ['vpn-globalprotect', 'Connect to the VPN with GlobalProtect', '2025-08-04', 'Open GlobalProtect and connect to the VPN.', 'vpn-setup'],
  ['password-policy', 'Password rules', '2025-01-15', 'A password needs at least 14 characters.'],
];

const scratch = new URL(process.env.DATABASE_URL!);
scratch.pathname += '_hybrid';
const name = scratch.pathname.slice(1);
const adminUrl = new URL(scratch);
adminUrl.pathname = '/postgres';
const admin = new pg.Pool({ connectionString: adminUrl.href });
const db = new pg.Pool({ connectionString: scratch.href });
let dir: string;
let counts: { articles: number; chunks: number };

beforeAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  vi.stubEnv('EMBEDDING_DIM', '3');
  await migrate(scratch.href);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  vi.stubEnv('LLM_BASE_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  vi.stubEnv('EMBEDDING_MODEL', 'mock-embed');
  vi.stubEnv('LLM_API_KEY', undefined);
  vi.stubEnv('RAG_MODE', 'hybrid');
  dir = await mkdtemp(join(tmpdir(), 'vsd-kb-'));
  for (const [slug, title, updated, body, topic = slug] of kb) {
    const frontmatter = `title: ${title}\ncategory: Network\ntags: [fixture]\nupdated: ${updated}\ntopic: ${topic}`;
    await writeFile(join(dir, `${slug}.md`), `---\n${frontmatter}\n---\n${body}\n`);
  }
  counts = await indexKb(db, dir);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  server.close();
  await db.end();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
  await rm(dir, { recursive: true, force: true });
});

describe('hybrid retrieval', () => {
  it('stores each chunk embedding, title included, in input order', async () => {
    expect(counts).toEqual({ articles: 3, chunks: 3 });
    const { rows } = await db.query<{ title: string; text: string; embedding: string }>(
      `SELECT a.title, c.text, c.embedding::text AS embedding
       FROM servicedesk.kb_chunks c JOIN servicedesk.kb_articles a ON a.id = c.article_id`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(JSON.parse(r.embedding)).toEqual(meaning(`${r.title}\n\n${r.text}`));
    expect(await embed(['vpn', 'password'])).toEqual([meaning('vpn'), meaning('password')]);
  });

  it('calls the embeddings endpoint with the configured model, float encoding and the default key', () => {
    expect(requests.length).toBeGreaterThanOrEqual(3);
    for (const r of requests) {
      expect(r).toMatchObject({
        url: '/v1/embeddings',
        auth: 'Bearer not-needed',
        body: { model: 'mock-embed', encoding_format: 'float' },
      });
    }
  });

  it('never prints request bodies, even with OPENAI_LOG=debug', async () => {
    vi.stubEnv('OPENAI_LOG', 'debug');
    const spies = (['log', 'debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    try {
      await embed(['my vpn drops at the house']);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.stubEnv('OPENAI_LOG', undefined);
      vi.restoreAllMocks();
    }
  });

  it('weights a title or tag word 1.0 and a chunk text word 0.4 in full-text scores', async () => {
    const [title] = await retrieve(db, 'rules', { mode: 'fts', minScore: 0 });
    const [text] = await retrieve(db, 'characters', { mode: 'fts', minScore: 0 });
    expect(title).toMatchObject({ slug: 'password-policy', score: expect.closeTo(1 / 2, 5) });
    expect(text).toMatchObject({ slug: 'password-policy', score: expect.closeTo(0.4 / 1.4, 5) });
    expect((await retrieve(db, 'fixture', { mode: 'fts', minScore: 0 })).map((c) => c.score)).toEqual([0.5, 0.5]);
  });

  it('finds the newest article by meaning when no word matches', async () => {
    const query = 'can I work from my house';
    expect(await retrieve(db, query, { mode: 'fts', minScore: 0 })).toEqual([]);
    const found = await retrieve(db, query, { minScore: 0.3 });
    expect(found.map((c) => c.slug)).toEqual(['vpn-globalprotect']);
    expect(found[0].score).toBeCloseTo(0.5, 5);
  });

  it('scores the mean of the text rank and cosine similarity, and still drops stale versions', async () => {
    const query = 'connect to the VPN with AnyConnect';
    const [fts] = await retrieve(db, query, { mode: 'fts', minScore: 0 });
    const hybrid = await retrieve(db, query, { minScore: 0 });
    expect(hybrid.map((c) => c.slug)).toEqual(['vpn-globalprotect', 'password-policy']);
    expect(hybrid[0]).toMatchObject({ slug: fts.slug, updated: '2025-08-04' });
    expect(hybrid[0].score).toBeCloseTo((fts.score + 1) / 2, 5);
  });

  it('explains what is missing when embeddings are not configured or not indexed', async () => {
    const unembedded = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await expect(retrieve(unembedded, 'vpn')).rejects.toThrow('run pnpm seed with RAG_MODE=hybrid');
    await unembedded.end();
    vi.stubEnv('EMBEDDING_MODEL', '');
    await expect(embed(['vpn'])).rejects.toThrow('RAG_MODE=hybrid needs LLM_BASE_URL and EMBEDDING_MODEL');
    vi.stubEnv('EMBEDDING_MODEL', 'mock-embed');
  });
});
