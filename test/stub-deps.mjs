// Loaded with `node --import ./test/stub-deps.mjs`. Redirects the external SDKs to
// tiny stubs so tests never touch Square, MySQL or Google, and run without node_modules.
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  const STUBS = {
    'square':         new URL('./stubs/square.mjs',     ${JSON.stringify(import.meta.url)}).href,
    'mysql2/promise': new URL('./stubs/mysql2.mjs',     ${JSON.stringify(import.meta.url)}).href,
    'googleapis':     new URL('./stubs/googleapis.mjs', ${JSON.stringify(import.meta.url)}).href,
  };
  export async function resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    return next(specifier, context);
  }
`));
