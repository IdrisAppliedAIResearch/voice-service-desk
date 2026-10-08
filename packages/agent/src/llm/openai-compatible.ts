import type OpenAI from 'openai';
import type { LlmAdapter, Msg } from '../types';

// Some servers send tool arguments as an object or leave them out; the turn loop validates a JSON string.
const argsText = (a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a ?? {}));

function toWire(m: Msg): OpenAI.ChatCompletionMessageParam {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCall) {
    const { id, name, arguments: args } = m.toolCall;
    return { role: 'assistant', content: m.content, tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] };
  }
  return { role: m.role, content: m.content };
}

export function createOpenAiCompatibleLlm(client: OpenAI, model: string): LlmAdapter {
  return {
    name: 'openai-compatible',
    async complete(messages, tools) {
      const res = await client.chat.completions.create({
        model,
        messages: messages.map(toWire),
        ...(tools.length > 0 && {
          tools: tools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } })),
          tool_choice: 'auto',
        }),
        temperature: 0.1,
        max_tokens: 300,
      });
      const message = res.choices[0]?.message;
      return {
        text: message?.content ?? '',
        toolCalls: (message?.tool_calls ?? []).flatMap((c) =>
          c.type === 'custom' ? [] : [{ id: c.id, name: c.function.name, arguments: argsText(c.function.arguments) }],
        ),
      };
    },
  };
}
