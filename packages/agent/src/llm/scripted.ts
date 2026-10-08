import type { LlmAdapter, Msg, ScriptedResponse, ToolSpec } from '../types';
import { parseJsonModeOutput } from './json-mode';

export type ScriptedLlm = LlmAdapter & {
  push(...r: ScriptedResponse[]): void;
  remaining(): number;
  calls: { messages: Msg[]; tools: ToolSpec[] }[];
};

export function createScriptedLlm(responses: ScriptedResponse[] = []): ScriptedLlm {
  const queue = [...responses];
  const calls: ScriptedLlm['calls'] = [];
  let lastId = 0;
  return {
    name: 'scripted',
    calls,
    push: (...r) => void queue.push(...r),
    remaining: () => queue.length,
    async complete(messages, tools) {
      const r = queue.shift();
      if (!r) throw new Error('scripted LLM exhausted');
      calls.push({ messages: [...messages], tools: [...tools] });
      if (r.raw !== undefined) return parseJsonModeOutput(r.raw);
      const { say = '', tool } = r;
      return {
        text: say,
        toolCalls: tool ? [{ id: `call_${++lastId}`, name: tool.name, arguments: tool.rawArgs ?? JSON.stringify(tool.args ?? {}) }] : [],
      };
    },
  };
}
