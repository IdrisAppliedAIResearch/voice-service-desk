import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { parse } from 'yaml';
import type { LlmAdapter } from '../types';
import { createJsonModeLlm } from './json-mode';
import { createOpenAiCompatibleLlm } from './openai-compatible';
import { createScriptedLlm } from './scripted';

export { createScriptedLlm, type ScriptedLlm } from './scripted';

function provider(env: NodeJS.ProcessEnv): string {
  const name = env.LLM_PROVIDER || 'openai-compatible';
  if (!['openai-compatible', 'json-mode', 'scripted'].includes(name))
    throw new Error(`LLM_PROVIDER must be openai-compatible, json-mode or scripted, got "${name}"`);
  return name;
}

function serverSettings(env: NodeJS.ProcessEnv) {
  if (!env.LLM_BASE_URL || !env.LLM_MODEL)
    throw new Error('LLM_BASE_URL and LLM_MODEL must both be set when LLM_PROVIDER is openai-compatible or json-mode');
  return { baseURL: env.LLM_BASE_URL, model: env.LLM_MODEL, apiKey: env.LLM_API_KEY || 'not-needed' };
}

export function createLlmAdapter(env: NodeJS.ProcessEnv = process.env): LlmAdapter {
  const name = provider(env);
  if (name === 'scripted') {
    const script = env.LLM_SCRIPT ? parse(readFileSync(env.LLM_SCRIPT, 'utf8')) : [];
    if (!Array.isArray(script)) throw new Error(`LLM_SCRIPT ${env.LLM_SCRIPT} must contain a list of responses`);
    return createScriptedLlm(script);
  }
  const { baseURL, apiKey, model } = serverSettings(env);
  // Request bodies carry the caller's spoken answers; an explicit level stops OPENAI_LOG=debug from printing them. A
  // stalled server fails the turn within about a minute, not after the SDK's 10-minute timeout tried three times.
  const client = new OpenAI({ baseURL, apiKey, logLevel: 'off', timeout: 30_000, maxRetries: 1 });
  return name === 'json-mode' ? createJsonModeLlm(client, model) : createOpenAiCompatibleLlm(client, model);
}

export async function checkLlmHealth(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (provider(env) === 'scripted') return;
  const { baseURL, apiKey, model } = serverSettings(env);
  const wanted: Record<string, string> = { LLM_MODEL: model };
  if (env.RAG_MODE === 'hybrid') {
    if (!env.EMBEDDING_MODEL) throw new Error('EMBEDDING_MODEL must be set when RAG_MODE=hybrid');
    wanted.EMBEDDING_MODEL = env.EMBEDDING_MODEL;
  }
  const url = `${baseURL.replace(/\/+$/, '')}/models`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    const cause = (e as Error).cause as { code?: string; message?: string } | undefined;
    throw new Error(`Cannot reach the model server at ${url}: ${cause?.message || cause?.code || (e as Error).message}`);
  }
  if (!res.ok) throw new Error(`The model server at ${url} answered HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
  const ids = Array.isArray(body?.data) ? body.data.map((m) => m?.id) : [];
  for (const [key, id] of Object.entries(wanted)) {
    if (!ids.includes(id)) throw new Error(`${key} "${id}" is not listed by ${url}. Available: ${ids.join(', ') || 'none'}`);
  }
}
