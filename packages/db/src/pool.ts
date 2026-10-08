import pg from 'pg';

pg.types.setTypeParser(pg.types.builtins.INT8, Number);

export type Db = Pick<pg.Pool, 'query'>;

const pools = new Map<string, pg.Pool>();

export function getPool(url = process.env.DATABASE_URL): pg.Pool {
  if (!url) throw new Error('DATABASE_URL is not set');
  let pool = pools.get(url);
  if (!pool) pools.set(url, (pool = new pg.Pool({ connectionString: url })));
  return pool;
}

export async function closePools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((p) => p.end()));
}
