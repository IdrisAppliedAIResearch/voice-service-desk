import { defineConfig } from 'vitest/config';

try {
  process.loadEnvFile(new URL('.env', import.meta.url));
} catch {}
process.env.TEST_DATABASE_URL ||= 'postgres://servicedesk:servicedesk@localhost:5432/voice_service_desk_test';
const globalSetup = ['tests/global-setup.ts'];

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      LLM_PROVIDER: 'scripted',
      STT_PROVIDER: 'text',
      TTS_PROVIDER: 'text',
      RAG_MODE: 'fts',
    },
    fileParallelism: false,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'], globalSetup },
      },
      { extends: true, test: { name: 'scenarios', include: ['tests/scenarios/**/*.test.ts'], globalSetup } },
    ],
  },
});
