import { checkLlmHealth, createLlmAdapter } from '../../packages/agent/src/index';
import { closePools, loadEnv } from '../../packages/db/src/index';
import { loadScenarios, runScenario } from './runner';

const RUNS = 3;

loadEnv();
try {
  await checkLlmHealth();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
// The scenarios' database, which pnpm test:scenarios migrates and seeds; each scenario resets the users it drives.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://servicedesk:servicedesk@localhost:5432/voice_service_desk_test';

console.log(`Scenario quality report: ${process.env.LLM_MODEL} at ${process.env.LLM_BASE_URL}, ${RUNS} runs each.\n`);
console.log(`${'Scenario'.padEnd(34)} Passed  Rate`);
for (const scenario of loadScenarios().filter((s) => s.local)) {
  const failures: string[] = [];
  for (let run = 1; run <= RUNS; run++) {
    await runScenario(scenario, createLlmAdapter()).catch((e: Error) => failures.push(`run ${run}: ${e.message}`));
  }
  const passed = RUNS - failures.length;
  console.log(`${scenario.name.padEnd(34)} ${`${passed}/${RUNS}`.padEnd(7)} ${Math.round((100 * passed) / RUNS)}%`);
  for (const failure of failures) console.log(`    ${failure}`);
}
await closePools();
