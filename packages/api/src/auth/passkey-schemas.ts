import { z } from 'zod';
import {
  PASSKEY_SETTINGS,
  type PasskeySummary,
} from '@osfpm/core/src/auth/passkeys.js';

/**
 * The Zod schemas of the passkey routes: what the browser's WebAuthn API sends
 * and what it needs (spec card SC-10, decision D-56). The response bodies the
 * server reads are checked for shape and size here, so a body is never a reason
 * to do a lot of work, and the checks of origin, relying party, challenge and
 * signature stay with the library in the core.
 */

/**
 * Bytes written as base64url, the form WebAuthn's JSON uses, with the padding
 * some clients add. Bounded by `max` characters.
 */
function base64url(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/);
}

/** The id a passkey options request returns, and the verify request sends back unchanged. */
export const passkeyChallenge = z
  .string()
  .min(1)
  .max(256)
  .describe(
    'The challenge the options request returned. Send it back as it is.',
  );

/**
 * A credential descriptor in the options: an id with the transports the browser
 * may use to reach it. The server names credentials only when a user adds a
 * passkey, to exclude the ones they have.
 */
const credentialDescriptor = z.object({
  id: z.string(),
  type: z.string(),
  transports: z.array(z.string()).optional(),
});

/** The extensions the server may ask a browser for. Only `credProps` is asked today. */
const extensionInputs = z.object({
  appid: z.string().optional(),
  credProps: z.boolean().optional(),
  hmacCreateSecret: z.boolean().optional(),
  minPinLength: z.boolean().optional(),
});

/**
 * What a browser passes to `navigator.credentials.create()` to add a passkey, as
 * the library writes it (`PublicKeyCredentialCreationOptionsJSON`). Every field
 * of that type is named here, and a response carries nothing else: the schema is
 * the list of what a client is told.
 */
export const creationOptionsSchema = z
  .object({
    challenge: z.string(),
    rp: z.object({ name: z.string(), id: z.string().optional() }),
    user: z.object({
      id: z.string(),
      name: z.string(),
      displayName: z.string(),
    }),
    pubKeyCredParams: z.array(
      z.object({ type: z.literal('public-key'), alg: z.number() }),
    ),
    timeout: z.number().optional(),
    attestation: z.string().optional(),
    attestationFormats: z.array(z.string()).optional(),
    excludeCredentials: z.array(credentialDescriptor).optional(),
    authenticatorSelection: z
      .object({
        authenticatorAttachment: z.string().optional(),
        requireResidentKey: z.boolean().optional(),
        residentKey: z.string().optional(),
        userVerification: z.string().optional(),
      })
      .optional(),
    hints: z.array(z.string()).optional(),
    extensions: extensionInputs.optional(),
  })
  .describe(
    'The options for navigator.credentials.create(), in the WebAuthn JSON form.',
  );

/**
 * What a browser passes to `navigator.credentials.get()` to sign in with a
 * passkey, as the library writes it (`PublicKeyCredentialRequestOptionsJSON`).
 * It names no credential. Every field of that type is named here.
 */
export const requestOptionsSchema = z
  .object({
    challenge: z.string(),
    rpId: z.string().optional(),
    timeout: z.number().optional(),
    allowCredentials: z.array(credentialDescriptor).optional(),
    userVerification: z.string().optional(),
    hints: z.array(z.string()).optional(),
    extensions: extensionInputs.optional(),
  })
  .describe(
    'The options for navigator.credentials.get(), in the WebAuthn JSON form.',
  );

/**
 * The extension results a browser reports. The server does not use them; only
 * the ones the library's types name are kept, and the rest is dropped.
 */
const clientExtensionResults = z.object({
  appid: z.boolean().optional(),
  credProps: z.object({ rk: z.boolean().optional() }).optional(),
  hmacCreateSecret: z.boolean().optional(),
});

/**
 * The browser's answer to `navigator.credentials.create()`, as JSON
 * (`RegistrationResponseJSON`, WebAuthn level 3). Checked for shape and size
 * only: the library verifies it.
 */
export const registrationResponseSchema = z.object({
  id: base64url(1400),
  rawId: base64url(1400),
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults,
  response: z.object({
    clientDataJSON: base64url(4096),
    attestationObject: base64url(16384),
    authenticatorData: base64url(8192).optional(),
    publicKey: base64url(4096).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    transports: z.array(z.string().max(32)).max(16).optional(),
  }),
});

/**
 * The browser's answer to `navigator.credentials.get()`, as JSON
 * (`AuthenticationResponseJSON`, WebAuthn level 3). Checked for shape and size
 * only: the library verifies it.
 */
export const authenticationResponseSchema = z.object({
  id: base64url(1400),
  rawId: base64url(1400),
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults,
  response: z.object({
    clientDataJSON: base64url(4096),
    authenticatorData: base64url(8192),
    signature: base64url(4096),
    userHandle: base64url(1400).optional(),
  }),
});

/** The name a person gives a passkey, as a request may carry it. The service trims it and refuses control characters. */
export const deviceNameField = z
  .string()
  .max(PASSKEY_SETTINGS.maxDeviceNameLength)
  .describe(
    `A name to tell the passkey apart, such as "Production office laptop". At most ${PASSKEY_SETTINGS.maxDeviceNameLength} characters.`,
  );

/** One live passkey of the signed-in user. Never the credential id, the public key or the sign count. */
export const passkeySchema = z.object({
  id: z.uuid(),
  deviceName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  transports: z
    .array(z.string())
    .describe(
      'How the browser says the passkey is reached, such as `internal`.',
    ),
});

/** A passkey as its response shows it: the dates as ISO text. */
export function passkeyView(passkey: PasskeySummary) {
  return {
    id: passkey.id,
    deviceName: passkey.deviceName,
    createdAt: passkey.createdAt.toISOString(),
    lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
    transports: passkey.transports,
  };
}
