# keys

The server's own keys, which live outside the database (spec, section Cryptography and keys). Two kinds: an **identity key pair** (Ed25519), whose public half identifies this server and is published, and **data keys** (AES-256), which encrypt a secret that has to be read back, such as an authenticator-app secret. Only the built-in `node:crypto` is used; nothing here is a primitive of our own, and there is no new dependency.

**Entry points**

- `server-keys.ts`: `loadServerKeys(dir, create?)`, the one place that reads, makes and checks the key files (file input and output stays here). It returns `{ identity, dataKeys }`. `create` says which missing parts may be made, both by default; start-up turns one off when the database says that part must already exist (see below). `SERVER_KEY_FILES` names the files, and `permissionsTooOpen(mode)` is the permission rule. For the admin command line, which must look at a key directory without changing it, there are three reads that never make a file: `readServerIdentity(dir)` (the identity key, or null when there is no file), `readDataKeyRing(dir)` (the ring, or null when there is no usable current key) and `inspectKeyDirectory(dir)` (which files are there, how many data keys, and on POSIX systems how many key files are too open: counts and facts, no key id). `addDataKey(dir)` is the one write the admin command line makes to the data keys: it adds a new key file (mode 0600, never over a file that is there), then replaces `current` in one step, and answers the ring of every key that is there; old key files are never deleted (`rotate-data-key` and `accept-data-key-loss`, see `src/auth/server-key-admin.ts`). `prepareReplacementIdentity()` makes a new identity key pair in memory and answers it with a `write(dir)` that makes the file last (`wx`, mode 0600, never over anything that is there), so `new-identity` can store the public key first and roll back if the file cannot be written.
- `data-keys.ts`: `DataKeyRing`, built by the loader, with `encrypt(plaintext, aad)` and `decrypt(sealed, aad)`. `isEncryptedValue(value)` and `ENCRYPTED_PREFIX` (`v1.`) tell a sealed value from a plain one.
- `identity.ts`: `ServerIdentity` (`publicKey`, `fingerprint`, and `sign(message)`, which is the one door to the private key) and `publicKeyFingerprint`.
- `errors.ts`: `ServerKeysError` (a refusal to load, with a `reason` and a fixed message for the operator) and `DecryptionError` (a sealed value could not be opened, with no detail).
- `test-support.ts`: `createTestKeyDirectory` and `useTestServerKeys`, which make a key directory for a test file and delete it afterwards. Only tests import it.

The services take the key ring as an argument (`dataKeys`), loaded once at start-up and passed down; nothing reads a global. The start-up step that loads the keys against the database is `bindServerKeys`, in `src/auth/server-key-binding.ts`.

**The key directory** (`OSFPM_KEYS_DIR` in the API; with PGlite it defaults to `<OSFPM_DATA_DIR>/keys`):

| File                    | Content                                           |
| ----------------------- | ------------------------------------------------- |
| `server-identity.pem`   | The Ed25519 private key, PKCS #8 PEM              |
| `data-keys/<keyId>.key` | 32 random bytes in base64. The key id is a UUIDv7 |
| `data-keys/current`     | The key id of the key that seals new values       |

The server makes any file that is missing, when the database allows it, with mode 0600 in directories of mode 0700. **It must be backed up with the database.** Existing files are never changed, and a file that cannot be read, or is not a key of the right kind, stops the server instead of being replaced.

**How a value is sealed.** `v1.<key id>.<nonce>.<ciphertext and tag>`, base64url parts, AES-256-GCM, a fresh 12-byte nonce each time. The additional authenticated data names the row the value belongs to (`totp_credential:<user id>`), so a value copied to another row does not open. The key id in the text is how an older key is found, so a later rotation can add a current key while old values still open (there is no rotation command yet).

**Rules you must not break**

- Key material is never in the database, a log, an error, an audit event, a change event, a response or `/meta`. Only the public key and its fingerprint are public. The identity public key is raw 32 bytes in base64url; the fingerprint is the SHA-256 of those bytes in hex, in groups of four, separated by a space.
- On POSIX systems a key file (the identity key and every data key) that the group or others can read is refused at start-up, with the path in the message and nothing from the file. `current` holds a key id and no secret, so its mode is not checked. On Windows the mode bits say nothing about access, so the check is skipped there (and the test for it is skipped); protect the folder with its access rules.
- **A missing file is not always made.** If the database has stored the identity public key, a missing or different `server-identity.pem` stops the server (`identity-missing`, `identity-mismatch`) and the stored key is never replaced: a swapped or empty volume must not change the server's identity. If the database holds an encrypted secret, a missing data-keys folder (or a `current` that names a missing file) stops the server (`data-keys-missing`). The two messages for a missing file (`identity-missing`, `data-keys-missing`) say to restore from the backup and, for an install with none, point to "Admin command line" in `packages/api/README.md` (`new-identity`, `accept-data-key-loss`); they are fixed text and hold no value. Only when the database holds no such secret are fresh data keys made.
- A sealed value that cannot be opened is a value with no valid secret: callers answer as for a wrong code, and the trail says why with a fixed reason and no value.
- Keys are held in private fields of `DataKeyRing` and `ServerIdentity`, so printing one or turning it into JSON shows public values only.

**Not here:** rotating keys (a later admin tool), signing documents or requests, end-to-end encryption, and the encryption of anything but authenticator secrets (the reserved `key_id` columns are left alone).

**Tests:** `pnpm test packages/core/src/keys` runs `data-keys.test.ts` (the sealed format, the nonce, the additional data, tampering, an unknown key id, no detail in an error, no key in JSON) and `server-keys.test.ts` (first start, a later start, a key added by hand, the permission check on POSIX systems, what is not made, bad files). The start-up step is tested in `src/auth/server-key-binding.test.ts` and `totp-encryption.test.ts`.
