import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLlmAdapter, createScriptedLlm, type ScriptedLlm } from '../src/llm/index';
import type { Msg, ToolSpec } from '../src/types';

const messages: Msg[] = [{ role: 'user', content: 'hello' }];
const tools: ToolSpec[] = [{ name: 'end_call', description: 'End the call.', parameters: { type: 'object' } }];

describe('scripted LLM', () => {
  it('replays responses in order with generated call ids and records every request', async () => {
    const llm = createScriptedLlm([
      { say: 'Hi there.' },
      { tool: { name: 'lookup_account', args: { identifier: 'E12345' } } },
      { say: 'One moment.', tool: { name: 'end_call' } },
      { tool: { name: 'verify_vip_pin', rawArgs: '{"pin": 12' } },
    ]);
    expect(llm.name).toBe('scripted');
    expect(llm.remaining()).toBe(4);

    expect(await llm.complete(messages, tools)).toEqual({ text: 'Hi there.', toolCalls: [] });
    expect(await llm.complete(messages, [])).toEqual({
      text: '',
      toolCalls: [{ id: 'call_1', name: 'lookup_account', arguments: '{"identifier":"E12345"}' }],
    });
    expect(await llm.complete(messages, tools)).toEqual({
      text: 'One moment.',
      toolCalls: [{ id: 'call_2', name: 'end_call', arguments: '{}' }],
    });
    expect(await llm.complete(messages, tools)).toEqual({
      text: '',
      toolCalls: [{ id: 'call_3', name: 'verify_vip_pin', arguments: '{"pin": 12' }],
    });
    expect(llm.calls).toEqual([
      { messages, tools },
      { messages, tools: [] },
      { messages, tools },
      { messages, tools },
    ]);
    expect(llm.remaining()).toBe(0);

    const sent: Msg[] = [...messages];
    llm.push({ say: 'ok' });
    await llm.complete(sent, tools);
    sent.push({ role: 'user', content: 'added after the call' });
    expect(llm.calls.at(-1)?.messages).toEqual(messages);
  });

  it('parses raw responses exactly like json-mode output', async () => {
    const llm = createScriptedLlm([{ raw: 'ok {"say":"","tool":{"name":"end_call","args":{"summary":"bye"}}}' }, { raw: 'not json' }]);
    expect(await llm.complete(messages, tools)).toEqual({
      text: '',
      toolCalls: [{ id: expect.any(String), name: 'end_call', arguments: '{"summary":"bye"}' }],
    });
    expect(await llm.complete(messages, tools)).toEqual({ text: '', toolCalls: [], malformed: 'no JSON object found' });
  });

  it('accepts pushed responses, throws when exhausted, and records only answered requests', async () => {
    const llm: ScriptedLlm = createScriptedLlm();
    await expect(llm.complete(messages, tools)).rejects.toThrow('scripted LLM exhausted');
    llm.push({ say: 'a' }, { say: 'b' });
    expect(llm.remaining()).toBe(2);
    expect((await llm.complete(messages, tools)).text).toBe('a');
    expect((await llm.complete(messages, tools)).text).toBe('b');
    await expect(llm.complete(messages, tools)).rejects.toThrow('scripted LLM exhausted');
    expect(llm.calls).toHaveLength(2);
  });

  it('loads LLM_SCRIPT from a YAML or JSON list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vsd-llm-'));
    const yaml = join(dir, 'script.yaml');
    writeFileSync(yaml, '- say: Hello.\n- tool:\n    name: lookup_account\n    args: { identifier: E12345 }\n');
    const json = join(dir, 'script.json');
    writeFileSync(json, JSON.stringify([{ raw: '{"say": "From JSON.", "tool": null}' }]));

    const fromYaml = createLlmAdapter({ LLM_PROVIDER: 'scripted', LLM_SCRIPT: yaml });
    expect((await fromYaml.complete(messages, tools)).text).toBe('Hello.');
    expect((await fromYaml.complete(messages, tools)).toolCalls).toEqual([
      { id: 'call_1', name: 'lookup_account', arguments: '{"identifier":"E12345"}' },
    ]);
    expect((await createLlmAdapter({ LLM_PROVIDER: 'scripted', LLM_SCRIPT: json }).complete(messages, tools)).text).toBe('From JSON.');
    expect(createLlmAdapter({ LLM_PROVIDER: 'scripted' }).name).toBe('scripted');

    writeFileSync(yaml, 'say: not a list\n');
    expect(() => createLlmAdapter({ LLM_PROVIDER: 'scripted', LLM_SCRIPT: yaml })).toThrow(`LLM_SCRIPT ${yaml} must contain a list of responses`);
  });
});
