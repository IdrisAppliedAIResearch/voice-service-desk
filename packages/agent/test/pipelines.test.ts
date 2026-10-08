import { afterAll, describe, expect, it } from 'vitest';
import { closePools } from '@vsd/db';
import { PIPELINES, type PipelineName, type ToolName } from '@vsd/pipelines';
import { createScriptedLlm } from '../src/llm/index';
import { auditEvents, testAgent } from './core-fixtures';

afterAll(closePools);

const states = Object.entries(PIPELINES).flatMap(([pipeline, p]) =>
  Object.entries(p.states).map(([state, def]) => ({ pipeline: pipeline as PipelineName, state, def })),
);

describe('allow-lists through the turn loop', () => {
  it.each(states)('$pipeline/$state offers exactly its tools and rejects any other', async ({ pipeline, state, def }) => {
    const forbidden = (['reset_password', 'lookup_account'] as ToolName[]).find((t) => !def.tools.includes(t))!;
    const llm = createScriptedLlm([{ tool: { name: forbidden, args: { identifier: 'someone' } } }, { say: 'Okay.' }]);
    const agent = testAgent({ llm });
    const { sessionId } = await agent.createSession('text');
    const s = agent.getSession(sessionId)!;
    Object.assign(s, { pipeline, state });

    const r = await agent.handleTurn(sessionId, 'hello');
    expect(llm.calls.map((c) => c.tools.map((t) => t.name))).toEqual([def.tools, def.waitForCaller ? [] : def.tools]);
    const block = llm.calls[0].messages.at(-1)!.content;
    expect(block).toContain(`pipeline=${PIPELINES[pipeline].label} state=${state}`);
    const toolsLine = block.split('\n').find((l) => l.startsWith('Tools you may call now:'))!;
    for (const tool of def.tools) expect(toolsLine).toContain(tool);
    expect(r).toMatchObject({ pipeline, state, status: 'active', reply: 'Okay.' });
    expect(r.events).toEqual([{ type: 'tool_rejected', name: forbidden, reason: 'not_allowed' }]);
    expect(s.candidate).toBeUndefined();
    const rejected = (await auditEvents(sessionId)).filter((e) => e.event === 'tool_not_allowed');
    expect(rejected.map((e) => e.detail)).toEqual([{ name: forbidden, state }]);
  });
});
