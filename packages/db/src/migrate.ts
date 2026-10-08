import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { loadEnv } from './env';

export async function migrate(databaseUrl: string): Promise<string[]> {
  const ran = await runner({
    databaseUrl,
    dir: fileURLToPath(new URL('../migrations', import.meta.url)),
    direction: 'up',
    schema: 'servicedesk',
    createSchema: true,
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
  return ran.map((m) => m.name);
}

if (import.meta.filename === process.argv[1]) {
  loadEnv();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const ran = await migrate(process.env.DATABASE_URL);
  console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Database is up to date');
}
