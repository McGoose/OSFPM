import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVER_KEYS_REFUSALS, ServerKeysError } from './errors.js';

/**
 * What the operator reads when start-up refuses because key files are gone. The two
 * refusals an install with no backup can get out of say where to look and which
 * command does it (P-09a1); the others must not, because a wrong key directory is
 * not cured by making a new key.
 */
const API_README = readFileSync(
  fileURLToPath(new URL('../../../api/README.md', import.meta.url)),
  'utf8',
);

describe('the refusals that say what to do with no backup', () => {
  it.each([
    ['identity-missing', 'new-identity'],
    ['data-keys-missing', 'accept-data-key-loss'],
  ] as const)(
    '%s still says to restore from the backup, and then points to the command %s in the README',
    (reason, command) => {
      const message = new ServerKeysError(reason).message;

      expect(message).toContain('backup');
      expect(message).toContain(
        '"Admin command line" in packages/api/README.md',
      );
      expect(message).toContain(command);
      // The pointer is true: the section and the command are in that README.
      expect(API_README).toContain('## Admin command line');
      expect(API_README).toContain(`\`${command}`);
    },
  );

  it('is fixed text: a path given to it does not reach these two messages', () => {
    for (const reason of ['identity-missing', 'data-keys-missing'] as const) {
      const message = new ServerKeysError(reason, '/secret/place').message;

      expect(message).not.toContain('/secret/place');
      expect(message).toBe(new ServerKeysError(reason).message);
    }
  });

  it('does not point the others to a command, because they are cured another way', () => {
    for (const reason of SERVER_KEYS_REFUSALS) {
      if (reason === 'identity-missing' || reason === 'data-keys-missing') {
        continue;
      }
      const { message } = new ServerKeysError(reason, '/a/key/file');

      expect(message, reason).not.toContain('new-identity');
      expect(message, reason).not.toContain('accept-data-key-loss');
    }
  });
});
