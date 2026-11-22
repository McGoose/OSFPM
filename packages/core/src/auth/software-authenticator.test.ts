import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { describe, expect, it } from 'vitest';
import {
  softwareAuthenticator,
  type SoftwareAuthenticator,
  type SoftwareKeyAlgorithm,
} from './test-support.js';

/**
 * The passkey tests lean on the software authenticator for every response they
 * send, and the tests that expect a refusal would pass for any fault. So this
 * file shows, with the library's own verification and no service of ours, that
 * the authenticator's responses are valid, and that each tweak breaks exactly
 * what it says it breaks.
 */

const RP_ID = 'osfpm.example.test';
const ORIGIN = `https://${RP_ID}`;

async function registrationOptions() {
  return generateRegistrationOptions({
    rpName: 'OSFPM',
    rpID: RP_ID,
    userName: 'fixture.user@example.test',
    userID: new Uint8Array(16).fill(7),
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });
}

async function verifiedRegistration(
  authenticator: SoftwareAuthenticator,
  tweaks: Parameters<SoftwareAuthenticator['register']>[1] = {},
) {
  const options = await registrationOptions();
  return verifyRegistrationResponse({
    response: authenticator.register(options, tweaks),
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });
}

/** Registers `authenticator` with the library and returns the credential the library keeps. */
async function credentialOf(authenticator: SoftwareAuthenticator) {
  const verified = await verifiedRegistration(authenticator);
  expect(verified.verified).toBe(true);
  return verified.registrationInfo!.credential;
}

async function verifiedSignIn(
  authenticator: SoftwareAuthenticator,
  credential: Awaited<ReturnType<typeof credentialOf>>,
  tweaks: Parameters<SoftwareAuthenticator['authenticate']>[1] = {},
) {
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
  });
  return verifyAuthenticationResponse({
    response: authenticator.authenticate(options, tweaks),
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential,
    requireUserVerification: true,
  });
}

describe('the software authenticator', () => {
  const algorithms: SoftwareKeyAlgorithm[] = ['ES256', 'RS256', 'EdDSA'];

  it.each(algorithms)(
    'makes a registration the library verifies, with a %s key',
    async (algorithm) => {
      const authenticator = softwareAuthenticator({ algorithm });
      const verified = await verifiedRegistration(authenticator);
      expect(verified.verified).toBe(true);
      const info = verified.registrationInfo!;
      expect(info.fmt).toBe('none');
      expect(info.userVerified).toBe(true);
      expect(info.credential.id).toBe(authenticator.credentialId);
      expect([...info.credential.publicKey]).toEqual([
        ...authenticator.publicKey,
      ]);
      expect(info.credential.counter).toBe(0);
      expect(info.credential.transports).toEqual(['internal']);
    },
  );

  it.each(algorithms)(
    'signs a sign-in the library verifies, with a %s key, and counts up',
    async (algorithm) => {
      const authenticator = softwareAuthenticator({ algorithm });
      const credential = await credentialOf(authenticator);
      const first = await verifiedSignIn(authenticator, credential);
      expect(first.verified).toBe(true);
      expect(first.authenticationInfo.newCounter).toBe(1);
      const second = await verifiedSignIn(authenticator, {
        ...credential,
        counter: 1,
      });
      expect(second.verified).toBe(true);
      expect(second.authenticationInfo.newCounter).toBe(2);
    },
  );

  it('reports a counter of 0 every time for a device that does not count', async () => {
    const authenticator = softwareAuthenticator({ counts: false });
    const credential = await credentialOf(authenticator);
    for (let i = 0; i < 3; i += 1) {
      const signedIn = await verifiedSignIn(authenticator, credential);
      expect(signedIn.verified).toBe(true);
      expect(signedIn.authenticationInfo.newCounter).toBe(0);
    }
  });

  it('reports the transports it is told to, and the credential id it is given', async () => {
    const first = softwareAuthenticator();
    const second = softwareAuthenticator({
      credentialId: first.credentialId,
    });
    expect(second.credentialId).toBe(first.credentialId);
    expect(
      Buffer.from(second.publicKey).equals(Buffer.from(first.publicKey)),
    ).toBe(false);
    const verified = await verifiedRegistration(first, {
      transports: ['usb', 'nfc'],
    });
    expect(verified.registrationInfo!.credential.transports).toEqual([
      'usb',
      'nfc',
    ]);
  });

  it('puts the user handle it was registered with in the sign-in, and can leave it out', async () => {
    const authenticator = softwareAuthenticator();
    const options = await registrationOptions();
    authenticator.register(options);
    const signIn = authenticator.authenticate(
      await generateAuthenticationOptions({ rpID: RP_ID }),
    );
    expect(signIn.response.userHandle).toBe(options.user.id);
    const without = authenticator.authenticate(
      await generateAuthenticationOptions({ rpID: RP_ID }),
      { userHandle: null },
    );
    expect(without.response.userHandle).toBeUndefined();
  });

  describe('each tweak breaks one thing and the library notices', () => {
    const registrationTweaks: [
      string,
      Parameters<SoftwareAuthenticator['register']>[1],
    ][] = [
      ['another origin', { origin: 'https://evil.example.test' }],
      ['another relying party id', { rpId: 'evil.example.test' }],
      ['another challenge', { challenge: 'bm90LXRoZS1jaGFsbGVuZ2U' }],
      ['no user verification', { userVerified: false }],
      ['no user presence', { userPresent: false, userVerified: false }],
    ];
    it.each(registrationTweaks)(
      'a registration with %s is refused',
      async (_name, tweaks) => {
        // The same call with no tweak verifies (above), so the tweak is the cause.
        await expect(
          verifiedRegistration(softwareAuthenticator(), tweaks),
        ).rejects.toThrow();
      },
    );

    const authenticationTweaks: [
      string,
      Parameters<SoftwareAuthenticator['authenticate']>[1],
    ][] = [
      ['another origin', { origin: 'https://evil.example.test' }],
      ['another relying party id', { rpId: 'evil.example.test' }],
      ['another challenge', { challenge: 'bm90LXRoZS1jaGFsbGVuZ2U' }],
      ['no user verification', { userVerified: false }],
      ['a wrong signature', { wrongSignature: true }],
    ];
    it.each(authenticationTweaks)(
      'a sign-in with %s is refused',
      async (_name, tweaks) => {
        const authenticator = softwareAuthenticator();
        const credential = await credentialOf(authenticator);
        // A refusal is a throw, or `verified: false`, depending on the check.
        const outcome = await verifiedSignIn(
          authenticator,
          credential,
          tweaks,
        ).then(
          (result) => result.verified,
          () => false,
        );
        expect(outcome).toBe(false);
      },
    );

    it('a signature made by another key is refused', async () => {
      const authenticator = softwareAuthenticator();
      const credential = await credentialOf(authenticator);
      const other = softwareAuthenticator();
      const outcome = await verifiedSignIn(other, credential).then(
        (result) => result.verified,
        () => false,
      );
      expect(outcome).toBe(false);
    });
  });
});
