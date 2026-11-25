import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runAdmin } from './run.js';

/**
 * The entry point of the admin command line:
 * `pnpm --filter @osfpm/api admin <command> [options]`. It hands the process's
 * arguments, environment and output to `runAdmin` and exits with its code. A real
 * `osfpm` binary comes with the production image; this is the development form.
 */

/** True when this file is the program being run, not a module a test imports. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const code = await runAdmin(process.argv.slice(2), {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exitCode = code;
  // A connection that never came up must not keep a finished command alive: the
  // timer does not hold the process open, but ends it if something else does.
  setTimeout(() => process.exit(code), 3_000).unref();
}
