import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import OpenAI from 'openai';
import type pg from 'pg';
import { parse } from 'yaml';
import type { Article, KbChunk } from './types';

export * from './types';

const MIN_WORDS = 60;
const MAX_WORDS = 180;
const DEFAULT_MIN_SCORE = 0.7;
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

export function parseArticle(slug: string, markdown: string): Article {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error(`${slug}: missing frontmatter`);
  const { title, category, tags, updated, topic = slug } = parse(match[1]) ?? {};
  for (const [key, value] of Object.entries({ title, category, topic })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${slug}: ${key} must be a non-empty string`);
  }
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) throw new Error(`${slug}: tags must be a list of strings`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updated)) throw new Error(`${slug}: updated must be a YYYY-MM-DD date`);
  return { slug, title, category, tags, updated, topic, body: match[2].trim() };
}

const words = (s: string) => s.match(/\S+/g)?.length ?? 0;

function pack(units: string[], separator: string): string[] {
  const total = units.reduce((n, u) => n + words(u), 0);
  const target = total / Math.ceil(total / MAX_WORDS);
  const out: string[] = [];
  for (const unit of units) {
    const last = out.length - 1;
    const n = last < 0 ? 0 : words(out[last]);
    if (last >= 0 && (n < MIN_WORDS || (n < target && n + words(unit) <= MAX_WORDS))) out[last] += separator + unit;
    else out.push(unit);
  }
  if (out.length > 1 && words(out[out.length - 1]) < MIN_WORDS) out.push(out.splice(-2).join(separator));
  return out;
}

function sentences(paragraph: string): string[] {
  const out: string[] = [];
  for (const { segment } of sentenceSegmenter.segment(paragraph)) {
    if (out.length && !/\p{L}/u.test(out[out.length - 1])) out[out.length - 1] += segment;
    else out.push(segment);
  }
  return out;
}

export function chunkText(body: string): string[] {
  const paragraphs = body
    .split(/(?<!^#.*\s*)\n\s*\n/m)
    .map((p) => p.trim())
    .filter(Boolean);
  return pack(
    paragraphs.flatMap((p) => (words(p) > MAX_WORDS ? pack(sentences(p), '').map((s) => s.trim()) : [p])),
    '\n\n',
  );
}

const vector = (v: number[]) => `[${v.join(',')}]`;

export async function indexKb(db: pg.Pool, dir: string): Promise<{ articles: number; chunks: number }> {
  const docs = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()) {
    const article = parseArticle(file.slice(0, -3), await readFile(join(dir, file), 'utf8'));
    const chunks = chunkText(article.body);
    const vectors = process.env.RAG_MODE === 'hybrid' ? await embed(chunks.map((c) => `${article.title}\n\n${c}`)) : [];
    docs.push({ article, chunks, vectors });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE servicedesk.kb_articles, servicedesk.kb_chunks RESTART IDENTITY');
    for (const { article: a, chunks, vectors } of docs) {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO servicedesk.kb_articles (slug, title, body, category, topic, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [a.slug, a.title, a.body, a.category, a.topic, a.updated],
      );
      for (const [i, text] of chunks.entries()) {
        await client.query(
          `INSERT INTO servicedesk.kb_chunks (article_id, chunk_index, text, tsv, embedding)
           VALUES ($1, $2, $3, setweight(to_tsvector('english', $4), 'A') || setweight(to_tsvector('english', $3), 'B'), $5)`,
          [rows[0].id, i, text, `${a.title} ${a.tags.join(' ')}`, vectors[i] ? vector(vectors[i]) : null],
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { articles: docs.length, chunks: docs.reduce((n, d) => n + d.chunks.length, 0) };
}

export async function retrieve(
  db: pg.Pool,
  query: string,
  opts: { limit?: number; minScore?: number; mode?: 'fts' | 'hybrid' } = {},
): Promise<KbChunk[]> {
  const { limit = 5, minScore = Number(process.env.RAG_MIN_SCORE) || DEFAULT_MIN_SCORE, mode = process.env.RAG_MODE } = opts;
  const hybrid = mode === 'hybrid';
  // Scores are at most 1. fts: ts_rank_cd normalization 32 is rank / (rank + 1), and for an OR query rank sums the weights
  // of every matched word (1.0 in the title or tags, 0.4 in the chunk text): one text hit scores 0.29, one title hit 0.5.
  // hybrid: the mean of that and the cosine similarity of the embeddings.
  const score = hybrid ? '(ts_rank_cd(c.tsv, q, 32) + 1 - (c.embedding <=> $3)) / 2' : 'ts_rank_cd(c.tsv, q, 32)';
  const { rows } = await db.query<KbChunk>(
    `SELECT c.article_id AS "articleId", a.slug, a.title, to_char(a.updated_at, 'YYYY-MM-DD') AS updated, c.text,
            ${score} AS score
     FROM servicedesk.kb_chunks c
     JOIN servicedesk.kb_articles a ON a.id = c.article_id,
          CAST(replace(plainto_tsquery('english', $1)::text, '&', '|') AS tsquery) q
     WHERE ${hybrid ? 'c.embedding IS NOT NULL' : 'c.tsv @@ q'}
       AND NOT EXISTS (SELECT 1 FROM servicedesk.kb_articles n WHERE n.topic = a.topic AND n.updated_at > a.updated_at)
     ORDER BY score DESC, c.id
     LIMIT $2`,
    hybrid ? [query, limit, vector((await embed([query]))[0])] : [query, limit],
  );
  if (hybrid && !rows.length) throw new Error('RAG_MODE=hybrid needs embedded articles: run pnpm seed with RAG_MODE=hybrid');
  return rows.filter((r) => r.score >= minScore);
}

export async function embed(texts: string[]): Promise<number[][]> {
  const { LLM_BASE_URL: baseURL, EMBEDDING_MODEL: model } = process.env;
  if (!baseURL || !model) throw new Error('RAG_MODE=hybrid needs LLM_BASE_URL and EMBEDDING_MODEL to be set');
  // Queries carry the caller's words; an explicit level stops OPENAI_LOG=debug from printing request bodies.
  const client = new OpenAI({ baseURL, apiKey: process.env.LLM_API_KEY || 'not-needed', logLevel: 'off', timeout: 30_000, maxRetries: 1 });
  const { data } = await client.embeddings.create({ model, input: texts, encoding_format: 'float' });
  return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}
