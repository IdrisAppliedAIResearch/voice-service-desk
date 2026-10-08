import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import { extractJson } from '../json-extract';
import { THINK } from '../postprocess';
import type { LlmAdapter, LlmResult, Msg, ToolSpec } from '../types';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const malformed = (reason: string): LlmResult => ({ text: '', toolCalls: [], malformed: reason });

export function parseJsonModeOutput(text: string): LlmResult {
  const out = extractJson(text.replace(THINK, ''));
  if (!isObject(out)) return malformed('no JSON object found');
  if (typeof out.say !== 'string') return malformed('"say" must be a string');
  const { tool } = out;
  if (tool == null) return { text: out.say, toolCalls: [] };
  // Models often leave out the args of a tool that takes none; the tool's schema still validates them.
  if (!isObject(tool) || typeof tool.name !== 'string' || !isObject(tool.args ?? {}))
    return malformed('"tool" must be null or {"name": string, "args": object}');
  return { text: out.say, toolCalls: [{ id: `call_${randomUUID()}`, name: tool.name, arguments: JSON.stringify(tool.args ?? {}) }] };
}

function outputContract(tools: ToolSpec[]): string {
  return `Reply with exactly one JSON object and nothing else, shaped like {"say": string, "tool": {"name": string, "args": object} | null}.
To talk to the caller, put your words in "say" and set "tool" to null. To call a tool, set "tool" and leave "say" empty; you will see the result and reply after it.
${
  tools.length > 0
    ? `Tools you may call now, each with the JSON Schema of its args:\n${tools.map((t) => `${t.name}: ${t.description} ${JSON.stringify(t.parameters)}`).join('\n')}`
    : 'No tools are available now, so "tool" must be null.'
}`;
}

type Turn = { role: 'system' | 'user' | 'assistant'; content: string };

function toTurn(m: Msg, tools: ToolSpec[]): Turn {
  if (m.role === 'system') return { role: 'system', content: `${m.content}\n\n${outputContract(tools)}` };
  if (m.role === 'tool') return { role: 'user', content: `Result of ${m.name}: ${m.content}` };
  if (m.role === 'user') return { role: 'user', content: m.content };
  const tool = m.toolCall ? { name: m.toolCall.name, args: extractJson(m.toolCall.arguments) ?? {} } : null;
  return { role: 'assistant', content: JSON.stringify({ say: m.content, tool }) };
}

export function createJsonModeLlm(client: OpenAI, model: string): LlmAdapter {
  return {
    name: 'json-mode',
    async complete(messages, tools) {
      const wire: Turn[] = [];
      for (const turn of messages.map((m) => toTurn(m, tools))) {
        const last = wire.at(-1);
        if (last?.role === turn.role) last.content += `\n\n${turn.content}`;
        else wire.push(turn);
      }
      const res = await client.chat.completions.create({ model, messages: wire, temperature: 0.1, max_tokens: 300 });
      return parseJsonModeOutput(res.choices[0]?.message.content ?? '');
    },
  };
}
