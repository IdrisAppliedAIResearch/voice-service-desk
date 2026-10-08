import { closePools, getPool, seedDatabase } from '../packages/db/src/index';
import { migrate } from '../packages/db/src/migrate';

export async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL!;
  const admin = new URL(url);
  const name = admin.pathname.slice(1);
  admin.pathname = '/postgres';
  await getPool(admin.href)
    .query(`CREATE DATABASE "${name}"`)
    .catch((e) => {
      if (e.code !== '42P04') throw e;
    });
  await migrate(url);
  await seedDatabase(getPool(url), { writeAnswersFile: false });
}

export const teardown = closePools;
