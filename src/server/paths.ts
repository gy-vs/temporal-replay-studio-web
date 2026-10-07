import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

declare const __TRS_DIR__: string | undefined;

/**
 * Directory this server module lives in, under both:
 *  - dev (tsx, ESM): src/server
 *  - prod (esbuild CJS bundle): dist-server (__TRS_DIR__ injected by banner)
 */
export function serverDir(): string {
  if (typeof __TRS_DIR__ === 'string') return __TRS_DIR__;
  return dirname(fileURLToPath(import.meta.url));
}

/** Workflow source directory (copied next to the bundle in production). */
export function workflowsDir(): string {
  const candidates = [
    join(serverDir(), 'workflows'),
    join(serverDir(), '..', 'src', 'server', 'workflows'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/** Built web assets directory. */
export function webDistDir(): string {
  return join(serverDir(), '..', 'dist');
}
