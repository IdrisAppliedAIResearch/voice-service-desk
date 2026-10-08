import { afterAll, it } from 'vitest';
import { closePools } from '../../packages/db/src/index';
import { loadScenarios, runScenario } from './runner';

afterAll(closePools);

for (const scenario of loadScenarios()) it(scenario.name, () => runScenario(scenario), 30_000);
