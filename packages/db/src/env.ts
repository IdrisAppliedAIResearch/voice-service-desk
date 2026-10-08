import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export function loadEnv(): void {
  try {
    process.loadEnvFile(resolve(REPO_ROOT, '.env'));
  } catch {}
}
