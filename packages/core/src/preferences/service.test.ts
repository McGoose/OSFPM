import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessDeniedError } from '../access/access-denied-error.js';
import { markUserDeleted } from '../auth/test-support.js';
import { AuthStateError } from '../auth/errors.js';
import type { Database } from '../db/client.js';
import {
  auditEvent,
  changeEvent,
  person,
  userPreferences,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { RecordNotFoundError, VersionConflictError } from '../db/write.js';
import { TRANSIENT_CLEANUPS } from '../retention/transient-cleanups.js';
import { seedPerson, seedUser } from '../access/test-fixtures.js';
import {
  PreferencesInvalidError,
  UseAccountPreferencesError,
} from './errors.js';
import { PREFERENCE_DEFAULTS, type Preferences } from './schemas.js';
import {
  effectivePreferences,
  eraseUserPreferences,
  readOwnPreferences,
  readPersonPreferences,
  saveOwnPreferences,
  savePersonPreferences,
} from './service.js';
import {
  ctxFor,
  NOW,
  seedPreferencesScene,
  tokenFor,
  type PreferencesScene,
} from './test-support.js';

/**
 * Delivery preferences (decision D-69, P-02l2): how a person wants to receive information.
 * An account holder keeps theirs on the account (`user_preferences`) and changes them
 * themselves; staff with `people:edit` keep those of a person with no account on the person
 * (`person.communication_preferences`); `effectivePreferences` is what later modules call.
 */

const CHOICES: Preferences = {
  emailFormat: 'plain-text',
  documentFormat: 'easy-read',
  textSize: 'large',
  preferredChannel: 'sms',
  notificationRhythm: 'daily-digest',
  quietHours: { start: '22:00', end: '07:00' },
};

/** The words of the choices above, which no event may hold: a choice such as easy-read can hint at something unshared. */
const CHOICE_WORDS = [
  'plain-text',
  'easy-read',
  'large',
  'sms',
  'daily-digest',
  '22:00',
  '07:00',
];

describe.each(testTargets)('delivery preferences on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scene: PreferencesScene;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    scene = await seedPreferencesScene(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;

  /** A fresh account holder, so a test starts from nothing stored. */
  const newAccount = () => seedUser(database);

  const rowsOf = async (userId: string) =>
    (await db().select().from(userPreferences)).filter(
      (row) => row.userId === userId,
    );

  const eventsAbout = async (targetId: string, category: string) =>
    (await db().select().from(auditEvent))
      .filter(
        (event) => event.targetId === targetId && event.category === category,
      )
      .sort((a, b) => a.id.localeCompare(b.id));

  const personChanges = async (personId: string) =>
    (await db().select().from(changeEvent))
      .filter(
        (event) => event.entityType === 'person' && event.entityId === personId,
      )
      .sort((a, b) => a.id.localeCompare(b.id));

  const storedOnPerson = async (personId: string) =>
    (await db().select().from(person).where(eq(person.id, personId)))[0]!;

  describe('the preferences of an account holder', () => {
    it('are the defaults, with nothing stored, until the person chooses', async () => {
      const userId = await newAccount();
      expect(await readOwnPreferences(db(), ctxFor(userId))).toEqual({
        stored: {},
        effective: PREFERENCE_DEFAULTS,
      });
      expect(await rowsOf(userId)).toEqual([]);
    });

    it('store every choice and read it back with the defaults around it', async () => {
      const userId = await newAccount();

      const saved = await saveOwnPreferences(db(), ctxFor(userId), CHOICES);

      expect(saved).toEqual({ stored: CHOICES, effective: CHOICES });
      expect(await readOwnPreferences(db(), ctxFor(userId))).toEqual(saved);
      const [row] = await rowsOf(userId);
      expect(row).toMatchObject({
        payload: CHOICES,
        version: 1,
        retentionClass: 'account-lifetime',
        createdBy: userId,
        updatedBy: userId,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    it('keep only the choices made: a default is applied when they are read, never stored', async () => {
      const userId = await newAccount();

      const saved = await saveOwnPreferences(db(), ctxFor(userId), {
        textSize: 'extra-large',
      });

      expect(saved.stored).toEqual({ textSize: 'extra-large' });
      expect(saved.effective).toEqual({
        ...PREFERENCE_DEFAULTS,
        textSize: 'extra-large',
      });
      expect((await rowsOf(userId))[0]!.payload).toEqual({
        textSize: 'extra-large',
      });
    });

    it('make one row for the person and change it after: the version goes up, and a choice left out is cleared', async () => {
      const userId = await newAccount();
      await saveOwnPreferences(db(), ctxFor(userId), CHOICES);

      const changed = await saveOwnPreferences(db(), ctxFor(userId), {
        emailFormat: 'html',
        quietHours: { start: '23:00', end: '06:00' },
      });

      expect(changed.stored).toEqual({
        emailFormat: 'html',
        quietHours: { start: '23:00', end: '06:00' },
      });
      expect(changed.effective.textSize).toBe('default');
      const rows = await rowsOf(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ version: 2, updatedBy: userId });
    });

    it('can be saved empty: the person goes back to the defaults and the row stays', async () => {
      const userId = await newAccount();
      await saveOwnPreferences(db(), ctxFor(userId), CHOICES);

      const cleared = await saveOwnPreferences(db(), ctxFor(userId), {});

      expect(cleared).toEqual({ stored: {}, effective: PREFERENCE_DEFAULTS });
      expect((await rowsOf(userId))[0]!.payload).toEqual({});
    });

    it('write nothing and no event when the person saves what is stored, in whatever order the keys come', async () => {
      const userId = await newAccount();
      await saveOwnPreferences(db(), ctxFor(userId), CHOICES);
      const before = await rowsOf(userId);
      const events = (await eventsAbout(userId, 'preferences.saved')).length;

      const again = await saveOwnPreferences(db(), ctxFor(userId), {
        quietHours: { end: '07:00', start: '22:00' },
        notificationRhythm: 'daily-digest',
        preferredChannel: 'sms',
        textSize: 'large',
        documentFormat: 'easy-read',
        emailFormat: 'plain-text',
      });

      expect(again.stored).toEqual(CHOICES);
      expect(await rowsOf(userId)).toEqual(before);
      expect((await eventsAbout(userId, 'preferences.saved')).length).toBe(
        events,
      );
    });

    it('are audited with the names of the fields that changed, and never a value', async () => {
      const userId = await newAccount();
      await saveOwnPreferences(db(), ctxFor(userId), {
        documentFormat: 'easy-read',
        textSize: 'large',
      });
      await saveOwnPreferences(db(), ctxFor(userId), {
        documentFormat: 'easy-read',
        quietHours: { start: '22:00', end: '07:00' },
      });

      const events = await eventsAbout(userId, 'preferences.saved');

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        action: 'create',
        actorType: 'user',
        actorId: userId,
        targetType: 'user',
        occurredAt: NOW,
        details: { changedFields: ['documentFormat', 'textSize'] },
      });
      expect(events[1]).toMatchObject({
        action: 'update',
        actorType: 'user',
        actorId: userId,
        details: { changedFields: ['quietHours', 'textSize'] },
      });
      const text = JSON.stringify(events);
      for (const word of CHOICE_WORDS) expect(text).not.toContain(word);
      expect(text).not.toContain('easy-read');
    });

    it('are not change-logged: the table has no organisation to number a change in', async () => {
      const userId = await newAccount();
      const before = (await db().select().from(changeEvent)).length;

      await saveOwnPreferences(db(), ctxFor(userId), CHOICES);

      expect((await db().select().from(changeEvent)).length).toBe(before);
    });

    it('refuse a choice the schema does not allow, say where and never what, and store nothing', async () => {
      const userId = await newAccount();
      const secret = 'secret-marker-4f9c';

      const failure = await saveOwnPreferences(db(), ctxFor(userId), {
        emailFormat: secret,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(PreferencesInvalidError);
      expect((failure as PreferencesInvalidError).issues).toEqual([
        { path: 'emailFormat', code: 'invalid_value' },
      ]);
      expect((failure as Error).message).not.toContain(secret);
      expect(await rowsOf(userId)).toEqual([]);
      expect(await eventsAbout(userId, 'preferences.saved')).toEqual([]);
    });

    it('keep each account’s own: saving one leaves another alone', async () => {
      const one = await newAccount();
      const two = await newAccount();
      await saveOwnPreferences(db(), ctxFor(one), { textSize: 'large' });
      await saveOwnPreferences(db(), ctxFor(two), { textSize: 'extra-large' });

      expect((await readOwnPreferences(db(), ctxFor(one))).stored).toEqual({
        textSize: 'large',
      });
      expect((await readOwnPreferences(db(), ctxFor(two))).stored).toEqual({
        textSize: 'extra-large',
      });
    });

    it('cannot be saved for an account that is deleted', async () => {
      const userId = await newAccount();
      await markUserDeleted(database, userId);

      await expect(
        saveOwnPreferences(db(), ctxFor(userId), CHOICES),
      ).rejects.toBeInstanceOf(AuthStateError);

      expect(await rowsOf(userId)).toEqual([]);
    });

    it('are one step with the caller’s transaction: rolled back, nothing is stored and no event stays', async () => {
      const userId = await newAccount();

      await expect(
        db().transaction(async (tx) => {
          await saveOwnPreferences(tx, ctxFor(userId), CHOICES);
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');

      expect(await rowsOf(userId)).toEqual([]);
      expect(await eventsAbout(userId, 'preferences.saved')).toEqual([]);
    });

    it('stay when a project wraps and every cleanup has run a century later: nothing ends them by time', async () => {
      const userId = await newAccount();
      await saveOwnPreferences(db(), ctxFor(userId), CHOICES);
      const before = await rowsOf(userId);
      const aCenturyLater = new Date('2126-11-15T10:00:00.000Z');

      for (const run of TRANSIENT_CLEANUPS.values()) {
        await run(db(), aCenturyLater);
      }

      expect(await rowsOf(userId)).toEqual(before);
    });
  });

  describe('the preferences of a person with no account, kept by staff', () => {
    it('are the defaults until somebody says otherwise', async () => {
      const view = await readPersonPreferences(
        db(),
        ctxFor(scene.users.staff),
        scene.people.crewToo,
      );
      expect(view).toEqual({
        stored: {},
        effective: PREFERENCE_DEFAULTS,
        version: 1,
      });
    });

    it('are set through the write helper, which logs a change for the person and takes the version up', async () => {
      const personId = await seedPerson(database, scene.organisationId, {
        displayName: 'Ines Kovac',
      });

      const saved = await savePersonPreferences(
        db(),
        ctxFor(scene.users.staff),
        personId,
        CHOICES,
      );

      expect(saved).toEqual({
        stored: CHOICES,
        effective: CHOICES,
        version: 2,
      });
      expect((await storedOnPerson(personId)).communicationPreferences).toEqual(
        CHOICES,
      );
      const changes = await personChanges(personId);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        action: 'update',
        actorType: 'user',
        actorId: scene.users.staff,
        entityVersion: 2,
        changedFields: ['communication_preferences'],
      });
      expect(
        await readPersonPreferences(db(), ctxFor(scene.users.staff), personId),
      ).toEqual(saved);
    });

    it('write nothing when staff save what is stored', async () => {
      const personId = await seedPerson(database, scene.organisationId, {
        displayName: 'Ines Kovac',
      });
      const ctx = ctxFor(scene.users.staff);
      await savePersonPreferences(db(), ctx, personId, CHOICES);
      const changes = (await personChanges(personId)).length;

      const again = await savePersonPreferences(db(), ctx, personId, {
        ...CHOICES,
        quietHours: { end: '07:00', start: '22:00' },
      });

      expect(again.version).toBe(2);
      expect((await personChanges(personId)).length).toBe(changes);
    });

    it('can be set empty, which says nothing in particular', async () => {
      const personId = await seedPerson(database, scene.organisationId, {
        displayName: 'Ines Kovac',
      });
      const ctx = ctxFor(scene.users.staff);
      await savePersonPreferences(db(), ctx, personId, CHOICES);

      const cleared = await savePersonPreferences(db(), ctx, personId, {});

      expect(cleared).toMatchObject({
        stored: {},
        effective: PREFERENCE_DEFAULTS,
      });
    });

    it('are read and set only by someone who holds people:edit in the person’s organisation', async () => {
      const personId = scene.people.crew;
      for (const userId of [
        scene.users.reader,
        scene.users.otherStaff,
        scene.users.stranger,
      ]) {
        await expect(
          readPersonPreferences(db(), ctxFor(userId), personId),
        ).rejects.toBeInstanceOf(AccessDeniedError);
        await expect(
          savePersonPreferences(db(), ctxFor(userId), personId, CHOICES),
        ).rejects.toBeInstanceOf(AccessDeniedError);
      }
      expect(
        (await storedOnPerson(personId)).communicationPreferences,
      ).toBeNull();
    });

    it('are refused for a person who has an account: those are the account’s, and only the person reads them', async () => {
      const { personId } = scene.people.holder;
      const staff = ctxFor(scene.users.staff);

      await expect(
        readPersonPreferences(db(), staff, personId),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        savePersonPreferences(db(), staff, personId, CHOICES),
      ).rejects.toBeInstanceOf(UseAccountPreferencesError);
      expect(
        (await storedOnPerson(personId)).communicationPreferences,
      ).toBeNull();
    });

    it('do not say whether a person has an account to someone who may not edit them', async () => {
      const denied = await savePersonPreferences(
        db(),
        ctxFor(scene.users.reader),
        scene.people.holder.personId,
        CHOICES,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(denied).toBeInstanceOf(AccessDeniedError);
    });

    it('answer a person who does not exist, one who is deleted and one of another organisation like a refusal', async () => {
      const deleted = await seedPerson(database, scene.organisationId, {
        displayName: 'Deleted Person',
      });
      await db()
        .update(person)
        .set({ deletedAt: NOW })
        .where(eq(person.id, deleted));
      const answers = new Set<string>();
      for (const personId of [
        '0199a3c4-0000-7000-8000-00000000dead',
        'not-an-id',
        deleted,
        scene.people.elsewhere,
      ]) {
        const failure = await readPersonPreferences(
          db(),
          ctxFor(scene.users.staff),
          personId,
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure, personId).toBeInstanceOf(AccessDeniedError);
        answers.add(
          JSON.stringify([
            (failure as AccessDeniedError).message,
            (failure as AccessDeniedError).scope,
          ]),
        );
      }
      expect(answers.size).toBe(1);
    });

    it('refuse a choice the schema does not allow, and a version that is stale', async () => {
      const personId = await seedPerson(database, scene.organisationId, {
        displayName: 'Ines Kovac',
      });
      const ctx = ctxFor(scene.users.staff);

      await expect(
        savePersonPreferences(db(), ctx, personId, { textSize: 'huge' }),
      ).rejects.toBeInstanceOf(PreferencesInvalidError);
      await expect(
        savePersonPreferences(db(), ctx, personId, CHOICES, {
          expectedVersion: 7,
        }),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect(
        (await storedOnPerson(personId)).communicationPreferences,
      ).toBeNull();
      const saved = await savePersonPreferences(db(), ctx, personId, CHOICES, {
        expectedVersion: 1,
      });
      expect(saved.version).toBe(2);
    });

    it('go through the credential of a personal API token: a token that can only read is refused, one that can write passes as its owner', async () => {
      const personId = await seedPerson(database, scene.organisationId, {
        displayName: 'Ines Kovac',
      });
      const readOnly = ctxFor(scene.users.staff, {
        credential: tokenFor(scene.organisationId, 'read'),
      });
      const writer = ctxFor(scene.users.staff, {
        credential: tokenFor(scene.organisationId, 'write'),
      });
      const wrongOrganisation = ctxFor(scene.users.staff, {
        credential: tokenFor(scene.otherOrganisationId, 'write'),
      });

      await expect(
        readPersonPreferences(db(), readOnly, personId),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        savePersonPreferences(db(), readOnly, personId, CHOICES),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        savePersonPreferences(db(), wrongOrganisation, personId, CHOICES),
      ).rejects.toBeInstanceOf(AccessDeniedError);

      await savePersonPreferences(db(), writer, personId, CHOICES);
      // The token's write is the token's in the change log, made for its owner.
      const [change] = await personChanges(personId);
      expect(change).toMatchObject({
        actorType: 'token',
        actorId: '0199a3c4-0000-7000-8000-0000000000bb',
        changedFields: ['communication_preferences'],
      });
    });
  });

  describe('what applies to a person', () => {
    it('is the defaults for a person with no account and nothing stored', async () => {
      const personId = await seedPerson(database, scene.organisationId, {
        displayName: 'Ines Kovac',
      });
      expect(await effectivePreferences(db(), personId)).toEqual(
        PREFERENCE_DEFAULTS,
      );
    });

    it('is the person’s own column, with the defaults around it, when they have no account', async () => {
      const personId = await seedPerson(database, scene.organisationId, {
        displayName: 'Ines Kovac',
      });
      await savePersonPreferences(db(), ctxFor(scene.users.staff), personId, {
        documentFormat: 'large-print',
        quietHours: CHOICES.quietHours,
      });

      expect(await effectivePreferences(db(), personId)).toEqual({
        ...PREFERENCE_DEFAULTS,
        documentFormat: 'large-print',
        quietHours: { start: '22:00', end: '07:00' },
      });
    });

    it('is the account’s when they have one: the user wins over the person column', async () => {
      const userId = await newAccount();
      const personId = await seedPerson(database, scene.organisationId, {
        userId,
        displayName: 'Ines Kovac',
      });
      // What staff wrote before the person had an account.
      await db()
        .update(person)
        .set({
          communicationPreferences: {
            emailFormat: 'plain-text',
            documentFormat: 'easy-read',
          },
        })
        .where(eq(person.id, personId));
      await saveOwnPreferences(db(), ctxFor(userId), { textSize: 'large' });

      // Only the account's counts, whole: nothing of the person column is mixed in.
      expect(await effectivePreferences(db(), personId)).toEqual({
        ...PREFERENCE_DEFAULTS,
        textSize: 'large',
      });
    });

    it('is the account’s even when the person saved nothing in particular: an empty choice is still theirs', async () => {
      const userId = await newAccount();
      const personId = await seedPerson(database, scene.organisationId, {
        userId,
        displayName: 'Ines Kovac',
      });
      await db()
        .update(person)
        .set({ communicationPreferences: { documentFormat: 'easy-read' } })
        .where(eq(person.id, personId));
      await saveOwnPreferences(db(), ctxFor(userId), {});

      expect(await effectivePreferences(db(), personId)).toEqual(
        PREFERENCE_DEFAULTS,
      );
    });

    it('is what staff recorded, until the person with an account saves their own', async () => {
      const userId = await newAccount();
      const personId = await seedPerson(database, scene.organisationId, {
        userId,
        displayName: 'Ines Kovac',
      });
      await db()
        .update(person)
        .set({ communicationPreferences: { documentFormat: 'large-print' } })
        .where(eq(person.id, personId));

      expect((await effectivePreferences(db(), personId)).documentFormat).toBe(
        'large-print',
      );
    });

    it('ignores the preferences of an account that is deleted', async () => {
      const userId = await newAccount();
      const personId = await seedPerson(database, scene.organisationId, {
        userId,
        displayName: 'Ines Kovac',
      });
      await saveOwnPreferences(db(), ctxFor(userId), { textSize: 'large' });
      await markUserDeleted(database, userId);

      expect(await effectivePreferences(db(), personId)).toEqual(
        PREFERENCE_DEFAULTS,
      );
    });

    it('falls back to the defaults, and does not fail, for a stored value that no longer fits the schema', async () => {
      const userId = await newAccount();
      const personId = await seedPerson(database, scene.organisationId, {
        userId,
        displayName: 'Ines Kovac',
      });
      await saveOwnPreferences(db(), ctxFor(userId), { textSize: 'large' });
      await db()
        .update(userPreferences)
        .set({ payload: { textSize: 'a value a later release removed' } })
        .where(eq(userPreferences.userId, userId));

      expect(await effectivePreferences(db(), personId)).toEqual(
        PREFERENCE_DEFAULTS,
      );
    });

    it('is a new object each time, so a caller may change what it gets', async () => {
      const personId = scene.people.crew;
      const first = await effectivePreferences(db(), personId);
      first.textSize = 'extra-large';
      expect((await effectivePreferences(db(), personId)).textSize).toBe(
        'default',
      );
    });

    it('is not found for a person who does not exist or is deleted', async () => {
      const deleted = await seedPerson(database, scene.organisationId, {
        displayName: 'Deleted Person',
      });
      await db()
        .update(person)
        .set({ deletedAt: NOW })
        .where(eq(person.id, deleted));
      for (const personId of [
        '0199a3c4-0000-7000-8000-00000000dead',
        'not-an-id',
        deleted,
      ]) {
        await expect(
          effectivePreferences(db(), personId),
          personId,
        ).rejects.toBeInstanceOf(RecordNotFoundError);
      }
    });
  });

  describe('erasing an account’s preferences', () => {
    it('deletes the row, writes one event of its own, and says it did', async () => {
      const userId = await newAccount();
      await saveOwnPreferences(db(), ctxFor(userId), CHOICES);

      expect(await eraseUserPreferences(db(), userId, { now: NOW })).toBe(true);

      expect(await rowsOf(userId)).toEqual([]);
      const events = await eventsAbout(userId, 'preferences.erased');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'erase',
        actorType: 'system',
        actorId: null,
        targetType: 'user',
        occurredAt: NOW,
      });
      const text = JSON.stringify(events);
      for (const word of CHOICE_WORDS) expect(text).not.toContain(word);
    });

    it('does nothing, and writes no event, when the account chose nothing', async () => {
      const userId = await newAccount();

      expect(await eraseUserPreferences(db(), userId, { now: NOW })).toBe(
        false,
      );

      expect(await eventsAbout(userId, 'preferences.erased')).toEqual([]);
    });

    it('leaves other accounts’ preferences alone, and lets the person start again', async () => {
      const one = await newAccount();
      const two = await newAccount();
      await saveOwnPreferences(db(), ctxFor(one), { textSize: 'large' });
      await saveOwnPreferences(db(), ctxFor(two), { textSize: 'extra-large' });

      await eraseUserPreferences(db(), one);

      expect((await readOwnPreferences(db(), ctxFor(two))).stored).toEqual({
        textSize: 'extra-large',
      });
      expect(
        (await saveOwnPreferences(db(), ctxFor(one), { textSize: 'large' }))
          .stored,
      ).toEqual({ textSize: 'large' });
    });

    it('refuses an id that is not a user’s', async () => {
      await expect(eraseUserPreferences(db(), 'not-an-id')).rejects.toThrow(
        RangeError,
      );
    });
  });
});
