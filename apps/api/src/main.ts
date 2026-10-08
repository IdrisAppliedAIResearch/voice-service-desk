import { checkLlmHealth, createAgent, createLlmAdapter } from '@vsd/agent';
import { closePools, getPool, loadEnv } from '@vsd/db';
import { createStt, createTts } from '@vsd/speech';
import { buildServer } from './server';

loadEnv();
const stt = createStt();
const tts = createTts();
try {
  await checkLlmHealth();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const db = getPool();
const agent = createAgent({ db, llm: createLlmAdapter() });
const app = buildServer({ agent, stt, tts });
db.on('error', (err) => app.log.error({ err }, 'idle database connection failed'));
await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT) || 3000 });
setInterval(() => agent.sweep().catch((err) => app.log.error({ err }, 'session sweep failed')), 60_000).unref();

const shutdown = async () => {
  await app.close();
  await closePools();
};
process.once('SIGINT', shutdown).once('SIGTERM', shutdown);
