import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { APIConnectionTimeoutError } from 'openai';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { embed } from '@vsd/rag';
import { checkLlmHealth, createLlmAdapter } from '../src/llm/index';
import { parseJsonModeOutput } from '../src/llm/json-mode';
import { buildMessages } from '../src/prompt';
import type { Msg, ToolSpec } from '../src/types';

interface Request {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: any;
}
const requests: Request[] = [];
let respond: (req: Request) => { status?: number; body: unknown } | undefined; // undefined: never answer
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const captured = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
  requests.push(captured);
  const reply = respond(captured);
  if (reply) res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
});
let baseURL = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  requests.length = 0;
});

const completion = (message: object) => ({
  body: {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null, ...message } }],
  },
});
const env = (provider: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  LLM_PROVIDER: provider,
  LLM_BASE_URL: baseURL,
  LLM_MODEL: 'test-model',
  ...extra,
});
const lookup: ToolSpec = {
  name: 'lookup_account',
  description: 'Look up the account for an email or employee ID.',
  parameters: { type: 'object', properties: { identifier: { type: 'string' } }, required: ['identifier'] },
};
const endCall: ToolSpec = { name: 'end_call', description: 'End the call.', parameters: { type: 'object', properties: {} } };
const history: Msg[] = [
  { role: 'system', content: 'SYSTEM' },
  { role: 'user', content: 'Caller said: "reset my password"' },
  { role: 'assistant', content: '', toolCall: { id: 'call_1', name: 'start_pipeline', arguments: '{"name":"password_reset"}' } },
  { role: 'tool', toolCallId: 'call_1', name: 'start_pipeline', content: '{"pipeline":"password_reset"}' },
  { role: 'user', content: '[Current step] pipeline=password_reset state=collect_identifier' },
];

describe('openai-compatible adapter', () => {
  it('sends tools with tool_choice auto, temperature 0.1 and max_tokens 300, and returns every tool call', async () => {
    respond = () =>
      completion({
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'lookup_account', arguments: '{"identifier":"E12345"}' } },
          { id: 'call_b', type: 'function', function: { name: 'end_call', arguments: '{}' } },
        ],
      });
    const llm = createLlmAdapter(env('openai-compatible'));
    expect(llm.name).toBe('openai-compatible');

    expect(await llm.complete(history, [lookup, endCall])).toEqual({
      text: '',
      toolCalls: [
        { id: 'call_a', name: 'lookup_account', arguments: '{"identifier":"E12345"}' },
        { id: 'call_b', name: 'end_call', arguments: '{}' },
      ],
    });
    const [req] = requests;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer not-needed');
    expect(req.body).toMatchObject({ model: 'test-model', tool_choice: 'auto', temperature: 0.1, max_tokens: 300 });
    expect(req.body.tools).toEqual([lookup, endCall].map((t) => ({ type: 'function', function: t })));
    expect(req.body.messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'Caller said: "reset my password"' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'start_pipeline', arguments: '{"name":"password_reset"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"pipeline":"password_reset"}' },
      { role: 'user', content: '[Current step] pipeline=password_reset state=collect_identifier' },
    ]);
  });

  it('never prints request bodies, even with OPENAI_LOG=debug', async () => {
    respond = () => completion({ content: 'ok' });
    vi.stubEnv('OPENAI_LOG', 'debug');
    const spies = (['log', 'debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    try {
      await createLlmAdapter(env('json-mode')).complete(history, []);
      await createLlmAdapter(env('openai-compatible')).complete(history, []);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });

  it('turns tool arguments that are not a JSON string into one, so validation handles them as usual', async () => {
    respond = () =>
      completion({
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'start_pipeline', arguments: { name: 'general_help' } } },
          { id: 'call_b', type: 'function', function: { name: 'end_call' } },
          { id: 'call_c', type: 'function', function: { name: 'end_call', arguments: null } },
        ],
      });
    const { toolCalls } = await createLlmAdapter(env('openai-compatible')).complete(history, [lookup]);
    expect(toolCalls.map((c) => c.arguments)).toEqual(['{"name":"general_help"}', '{}', '{}']);
  });

  it('omits tools and tool_choice when no tools are offered, and returns the text', async () => {
    respond = () => completion({ content: 'Is there anything else?' });
    const llm = createLlmAdapter(env('openai-compatible', { LLM_API_KEY: 'secret-key' }));

    expect(await llm.complete(history, [])).toEqual({ text: 'Is there anything else?', toolCalls: [] });
    expect(requests[0].headers.authorization).toBe('Bearer secret-key');
    expect(requests[0].body).not.toHaveProperty('tools');
    expect(requests[0].body).not.toHaveProperty('tool_choice');
  });
});

describe('json-mode adapter', () => {
  it('sends no tools, puts the output contract and tool schemas in the system message, and maps history to plain turns', async () => {
    respond = () =>
      completion({ content: 'Sure.\n```json\n{"say": "", "tool": {"name": "lookup_account", "args": {"identifier": "E12345"}}}\n```' });
    const llm = createLlmAdapter(env('json-mode'));
    expect(llm.name).toBe('json-mode');

    const result = await llm.complete(history, [lookup, endCall]);
    expect(result).toEqual({
      text: '',
      toolCalls: [{ id: expect.any(String), name: 'lookup_account', arguments: '{"identifier":"E12345"}' }],
    });
    const { body } = requests[0];
    expect(body).toMatchObject({ model: 'test-model', temperature: 0.1, max_tokens: 300 });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    const [system, , assistant, user] = body.messages;
    expect(system.content).toMatch(/^SYSTEM\n\nReply with exactly one JSON object/);
    expect(system.content).toContain('{"say": string, "tool": {"name": string, "args": object} | null}');
    expect(system.content).toContain(`lookup_account: ${lookup.description} ${JSON.stringify(lookup.parameters)}`);
    expect(system.content).toContain(`end_call: ${endCall.description} ${JSON.stringify(endCall.parameters)}`);
    expect(JSON.parse(assistant.content)).toEqual({ say: '', tool: { name: 'start_pipeline', args: { name: 'password_reset' } } });
    expect(user.content).toBe(
      'Result of start_pipeline: {"pipeline":"password_reset"}\n\n[Current step] pipeline=password_reset state=collect_identifier',
    );
  });

  it('tells the model when no tools are available and maps plain replies to the JSON shape', async () => {
    respond = () => completion({ content: '{"say": "Anything else?", "tool": null}' });
    const llm = createLlmAdapter(env('json-mode'));

    const messages: Msg[] = [
      { role: 'system', content: 'SYSTEM' },
      { role: 'assistant', content: 'Hello.' },
      { role: 'user', content: 'Caller said: "thanks"' },
    ];
    expect(await llm.complete(messages, [])).toEqual({ text: 'Anything else?', toolCalls: [] });
    const [system, assistant] = requests[0].body.messages;
    expect(system.content).toContain('No tools are available now, so "tool" must be null.');
    expect(JSON.parse(assistant.content)).toEqual({ say: 'Hello.', tool: null });
  });

  it('alternates user and assistant turns for a real conversation, including retry feedback', async () => {
    respond = () => completion({ content: '{"say": "Done.", "tool": null}' });
    const conversation: Msg[] = [
      { role: 'assistant', content: 'Thanks for calling. How can I help you today?' },
      ...history.slice(1, 4),
      { role: 'assistant', content: 'What is your employee ID?' },
      { role: 'user', content: 'E12345' },
    ];
    const view = { pipelineLabel: 'password_reset', state: 'collect_identifier', progress: 'x', instruction: 'y', tools: ['lookup_account'] };
    const messages = [...buildMessages(conversation, view), { role: 'user' as const, content: 'Your last reply could not be used.' }];
    await createLlmAdapter(env('json-mode')).complete(messages, [lookup]);
    expect(requests[0].body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(requests[0].body.messages.at(-1).content).toMatch(/^Caller said: "E12345"\n\n\[Current step\][^]*\n\nYour last reply could not be used\.$/);
  });

  it('reports output that has no valid object as malformed', async () => {
    respond = () => completion({ content: 'I will look that up for you.' });
    expect(await createLlmAdapter(env('json-mode')).complete(history, [lookup])).toEqual({
      text: '',
      toolCalls: [],
      malformed: 'no JSON object found',
    });
  });
});

describe('parseJsonModeOutput', () => {
  it.each([
    ['{"say": "Hello.", "tool": null}', { text: 'Hello.', toolCalls: [] }],
    ['{"say": "Hello."}', { text: 'Hello.', toolCalls: [] }],
    ['noise {"say":"","tool":{"name":"end_call","args":{"summary":"done"}}} noise', {
      text: '',
      toolCalls: [{ id: expect.stringMatching(/^call_/), name: 'end_call', arguments: '{"summary":"done"}' }],
    }],
    ['{"say": "", "tool": {"name": "end_call"}}', { text: '', toolCalls: [{ id: expect.stringMatching(/^call_/), name: 'end_call', arguments: '{}' }] }],
    ['<think>I will call lookup_account with {"identifier": "E12345"} as the args.</think>{"say": "", "tool": {"name": "lookup_account", "args": {"identifier": "E12345"}}}', {
      text: '',
      toolCalls: [{ id: expect.stringMatching(/^call_/), name: 'lookup_account', arguments: '{"identifier":"E12345"}' }],
    }],
  ])('parses %j', (text, expected) => {
    expect(parseJsonModeOutput(text)).toEqual(expected);
  });

  it.each([
    ['Hello there.', 'no JSON object found'],
    ['{"say": 42, "tool": null}', '"say" must be a string'],
    ['{"tool": null}', '"say" must be a string'],
    ['{"say": "", "tool": "end_call"}', '"tool" must be null or {"name": string, "args": object}'],
    ['{"say": "", "tool": {"args": {}}}', '"tool" must be null or {"name": string, "args": object}'],
    ['{"say": "", "tool": {"name": "end_call", "args": []}}', '"tool" must be null or {"name": string, "args": object}'],
  ])('marks %j malformed', (text, reason) => {
    expect(parseJsonModeOutput(text)).toEqual({ text: '', toolCalls: [], malformed: reason });
  });
});

describe('a model server that never answers', () => {
  it.each([
    ['chat completions', () => createLlmAdapter(env('openai-compatible')).complete(history, [])],
    ['embeddings', () => embed(['vpn'])],
  ])('fails %s after 30 seconds and one retry', async (_, call) => {
    respond = () => undefined;
    vi.stubEnv('LLM_BASE_URL', baseURL);
    vi.stubEnv('EMBEDDING_MODEL', 'embed-model');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const result = call().catch((e: unknown) => e);
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(1_000); // the SDK's backoff before its retry
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toBeInstanceOf(APIConnectionTimeoutError);
      expect(requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
});

describe('createLlmAdapter', () => {
  it.each([
    [{ LLM_PROVIDER: 'gpt' }, 'LLM_PROVIDER must be openai-compatible, json-mode or scripted, got "gpt"'],
    [{ LLM_PROVIDER: 'json-mode', LLM_MODEL: 'm' }, 'LLM_BASE_URL and LLM_MODEL must both be set'],
    [{ LLM_BASE_URL: 'http://127.0.0.1:1/v1' }, 'LLM_BASE_URL and LLM_MODEL must both be set'],
  ])('rejects %j', (bad, message) => {
    expect(() => createLlmAdapter(bad)).toThrow(message);
  });
});

describe('checkLlmHealth', () => {
  const models = (...ids: string[]) => () => ({ body: { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) } });

  it('passes when the model is listed, sending the bearer key', async () => {
    respond = models('other', 'test-model');
    await checkLlmHealth(env('openai-compatible', { LLM_API_KEY: 'secret-key' }));
    expect(requests).toMatchObject([{ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer secret-key' } }]);
  });

  it('accepts a trailing slash on the base URL', async () => {
    respond = models('test-model');
    await checkLlmHealth(env('json-mode', { LLM_BASE_URL: `${baseURL}/` }));
    expect(requests[0].url).toBe('/v1/models');
  });

  it('names the URL and the available ids when the model is missing', async () => {
    respond = models('model-a', 'model-b');
    await expect(checkLlmHealth(env('openai-compatible'))).rejects.toThrow(
      `LLM_MODEL "test-model" is not listed by ${baseURL}/models. Available: model-a, model-b`,
    );
  });

  it('checks the embedding model only in hybrid mode', async () => {
    respond = models('test-model');
    await checkLlmHealth(env('openai-compatible', { RAG_MODE: 'fts', EMBEDDING_MODEL: 'embed' }));
    await expect(checkLlmHealth(env('openai-compatible', { RAG_MODE: 'hybrid', EMBEDDING_MODEL: 'embed' }))).rejects.toThrow(
      `EMBEDDING_MODEL "embed" is not listed by ${baseURL}/models. Available: test-model`,
    );
    await expect(checkLlmHealth(env('openai-compatible', { RAG_MODE: 'hybrid' }))).rejects.toThrow(
      'EMBEDDING_MODEL must be set when RAG_MODE=hybrid',
    );
    respond = models('test-model', 'embed');
    await checkLlmHealth(env('openai-compatible', { RAG_MODE: 'hybrid', EMBEDDING_MODEL: 'embed' }));
  });

  it('reports a non-OK status', async () => {
    respond = () => ({ status: 401, body: { error: 'unauthorized' } });
    await expect(checkLlmHealth(env('openai-compatible'))).rejects.toThrow(`The model server at ${baseURL}/models answered HTTP 401`);
  });

  it('reports an unreachable server', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(checkLlmHealth(env('openai-compatible', { LLM_BASE_URL: `http://127.0.0.1:${port}/v1` }))).rejects.toThrow(
      `Cannot reach the model server at http://127.0.0.1:${port}/v1/models: connect ECONNREFUSED`,
    );
  });

  it('requires a known provider and the server settings, and skips the scripted provider', async () => {
    await expect(checkLlmHealth(env('gpt'))).rejects.toThrow('LLM_PROVIDER must be openai-compatible, json-mode or scripted, got "gpt"');
    await expect(checkLlmHealth({ LLM_PROVIDER: 'openai-compatible' })).rejects.toThrow('LLM_BASE_URL and LLM_MODEL must both be set');
    await checkLlmHealth({ LLM_PROVIDER: 'scripted' });
    expect(requests).toHaveLength(0);
  });
});
