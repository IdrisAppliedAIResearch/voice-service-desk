import { closePools, getPool, listOutbox, loadEnv, type OutboxRow } from '@vsd/db';

export function formatOutbox(rows: OutboxRow[]): string {
  if (!rows.length) return 'The outbox is empty.';
  return rows
    .map((r) => `${r.created_at.toLocaleString()}  ${r.channel} to ${r.destination_masked}\n  ${r.body.replaceAll('\n', '\n  ')}`)
    .join('\n');
}

if (import.meta.filename === process.argv[1]) {
  loadEnv();
  console.log(formatOutbox(await listOutbox(getPool(), { limit: 10 })));
  await closePools();
}
