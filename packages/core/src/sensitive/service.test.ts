import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  base,
  engagePerson,
  ensurePermissions,
  grantOnProject,
  ORIGIN,
  seedDepartment,
  seedOrganisation,
  seedPerson,
  seedProject,
  seedUser,
  type SeedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  auditEvent,
  orgMembership,
  projectPerson,
  type ProjectPersonStatus,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { RecordNotFoundError } from '../db/write.js';
import { leafStrings, VALID_PAYLOADS } from './payload-fixtures.js';
import {
  editPermissionKey,
  readPermissionKey,
  SENSITIVE_PERMISSIONS,
} from './permissions.js';
import { SENSITIVE_CATEGORIES, type SensitiveCategory } from './schemas.js';
import {
  deleteSensitive,
  readSensitive,
  SensitiveAccessDeniedError,
  SensitivePayloadInvalidError,
  writeSensitive,
  type SensitiveChangeNotifier,
  type SensitiveContext,
} from './service.js';

type Row = Record<string, unknown>;

const NOW = new Date('2026-11-15T10:00:00.000Z');

class FakeNotifier implements SensitiveChangeNotifier {
  readonly calls: {
    personId: string;
    category: SensitiveCategory;
    changedByUserId: string;
  }[] = [];
  notifyPersonOfStaffChange(input: {
    personId: string;
    category: SensitiveCategory;
    changedByUserId: string;
  }) {
    this.calls.push(input);
    return Promise.resolve();
  }
}

const ctxFor = (
  userId: string,
  notifier?: SensitiveChangeNotifier,
): SensitiveContext => ({
  userId,
  originServer: ORIGIN,
  clock: () => NOW,
  ...(notifier ? { notifier } : {}),
});

/** Every string in the demo payloads long enough to be a meaningful leak check. */
const SENTINELS = Object.values(VALID_PAYLOADS)
  .flatMap(leafStrings)
  .filter((s) => s.length >= 5);

function expectNoValues(value: unknown, label: string) {
  const text = JSON.stringify(value);
  for (const sentinel of SENTINELS) {
    expect(text, `${label} leaks ${sentinel.length}-char value`).not.toContain(
      sentinel,
    );
  }
}

const OPTIONS = { legalBasis: 'consent' } as const;

describe.each(testTargets)('sensitive data service on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let s: SeedOrganisation;
  let projectB: string;

  let readerDietary: string;
  let editorDietary: string;
  let editorAll: string;
  let readerOnB: string;
  let owner: string;
  let admin: string;

  const db = () => database.db;

  /** A person engaged on project A, optionally linked to a user account. */
  async function newPerson(
    options: { userId?: string; engaged?: boolean } = {},
  ) {
    const personId = await seedPerson(database, s.organisationId, {
      ...(options.userId ? { userId: options.userId } : {}),
    });
    if (options.engaged !== false) {
      await engagePerson(database, s.organisationId, s.projectId, personId);
    }
    return personId;
  }

  const auditOf = async (personId: string, category?: string) => {
    const all = await db()
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.targetId, personId));
    return category ? all.filter((e) => e.category === category) : all;
  };

  const changesOf = (personId: string) =>
    db().execute(
      sql`select ce.* from change_event ce
          join person_sensitive ps on ps.id = ce.entity_id
          where ps.person_id = ${personId} order by ce.seq`,
    ) as Promise<{ rows: Row[] }>;

  const countSensitiveRows = async (personId: string) => {
    const r = (await db().execute(
      sql`select count(*)::int as n from person_sensitive where person_id = ${personId}`,
    )) as { rows: { n: number }[] };
    return r.rows[0]!.n;
  };

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    s = await seedOrganisation(database);
    projectB = await seedProject(database, s.organisationId);
    await ensurePermissions(
      database,
      SENSITIVE_PERMISSIONS.map((p) => p.key),
    );
    const grant = (userId: string, keys: string[], projectId = s.projectId) =>
      grantOnProject(database, s.organisationId, projectId, userId, keys);

    readerDietary = await seedUser(database);
    await grant(readerDietary, [readPermissionKey('dietary')]);
    editorDietary = await seedUser(database);
    await grant(editorDietary, [editPermissionKey('dietary')]);
    editorAll = await seedUser(database);
    await grant(
      editorAll,
      SENSITIVE_CATEGORIES.flatMap((c) => [
        readPermissionKey(c),
        editPermissionKey(c),
      ]),
    );
    readerOnB = await seedUser(database);
    await grant(readerOnB, [readPermissionKey('dietary')], projectB);

    owner = await seedUser(database);
    admin = await seedUser(database);
    for (const [userId, orgRole] of [
      [owner, 'owner'],
      [admin, 'admin'],
    ] as const) {
      await database.db.insert(orgMembership).values({
        ...base(s.organisationId),
        userId,
        orgRole,
        status: 'active',
      });
    }
  });
  afterAll(async () => {
    await cleanup();
  });

  describe('the person themselves', () => {
    it.each(SENSITIVE_CATEGORIES)('can write and read %s', async (category) => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      const written = await writeSensitive(
        db(),
        ctxFor(self),
        personId,
        category,
        VALID_PAYLOADS[category],
        OPTIONS,
      );
      expect(written).toMatchObject({
        category,
        version: 1,
        enteredByKind: 'self',
        enteredBy: self,
      });
      expect(written).not.toHaveProperty('payload');

      const read = await readSensitive(db(), ctxFor(self), personId, category);
      expect(read?.payload).toEqual(VALID_PAYLOADS[category]);
      expect(read).toMatchObject({
        enteredByKind: 'self',
        legalBasis: 'consent',
      });
    });

    it('needs no engagement on any project', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self, engaged: false });
      await writeSensitive(
        db(),
        ctxFor(self),
        personId,
        'medical',
        VALID_PAYLOADS.medical,
        OPTIONS,
      );
      const read = await readSensitive(db(), ctxFor(self), personId, 'medical');
      expect(read?.payload).toEqual(VALID_PAYLOADS.medical);
    });

    it('cannot read or write another person’s data', async () => {
      const self = await seedUser(database);
      await newPerson({ userId: self });
      const other = await newPerson();
      await expect(
        readSensitive(db(), ctxFor(self), other, 'dietary'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await expect(
        writeSensitive(
          db(),
          ctxFor(self),
          other,
          'dietary',
          VALID_PAYLOADS.dietary,
          OPTIONS,
        ),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });

    it('records consent time and text version, and confirmation time, on a consent write', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      await writeSensitive(
        db(),
        ctxFor(self),
        personId,
        'dietary',
        VALID_PAYLOADS.dietary,
        { legalBasis: 'consent', consentTextVersion: '2026-01' },
      );
      const read = await readSensitive(db(), ctxFor(self), personId, 'dietary');
      expect(read).toMatchObject({
        consentRecordedAt: NOW,
        consentTextVersion: '2026-01',
        lastConfirmedAt: NOW,
      });
    });

    it('updates an existing row, bumping its version', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      const c = ctxFor(self);
      await writeSensitive(
        db(),
        c,
        personId,
        'dietary',
        VALID_PAYLOADS.dietary,
        OPTIONS,
      );
      const updated = await writeSensitive(
        db(),
        c,
        personId,
        'dietary',
        { restrictions: ['vegan'], allergies: [] },
        OPTIONS,
      );
      expect(updated.version).toBe(2);
      expect(await countSensitiveRows(personId)).toBe(1);
      const read = await readSensitive(db(), c, personId, 'dietary');
      expect(read?.payload).toEqual({ restrictions: ['vegan'], allergies: [] });
    });

    it('sets retention_class by category', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      const expected: Record<SensitiveCategory, string> = {
        dietary: 'crew-health',
        medical: 'crew-health',
        accessibility: 'crew-health',
        emergency: 'crew-health',
        identity: 'crew-personal',
        financial: 'crew-personal',
        representation: 'crew-personal',
        compliance: 'financial-record',
      };
      for (const category of SENSITIVE_CATEGORIES) {
        await writeSensitive(
          db(),
          ctxFor(self),
          personId,
          category,
          VALID_PAYLOADS[category],
          OPTIONS,
        );
      }
      const found = (await db().execute(
        sql`select category, retention_class from person_sensitive where person_id = ${personId}`,
      )) as { rows: { category: string; retention_class: string }[] };
      expect(
        Object.fromEntries(
          found.rows.map((r) => [r.category, r.retention_class]),
        ),
      ).toEqual(expected);
    });
  });

  describe('staff with per-category permissions', () => {
    it('reads dietary but not medical with sensitive:read:dietary on a shared project', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      for (const category of ['dietary', 'medical'] as const) {
        await writeSensitive(
          db(),
          ctxFor(self),
          personId,
          category,
          VALID_PAYLOADS[category],
          OPTIONS,
        );
      }
      const read = await readSensitive(
        db(),
        ctxFor(readerDietary),
        personId,
        'dietary',
      );
      expect(read?.payload).toEqual(VALID_PAYLOADS.dietary);
      await expect(
        readSensitive(db(), ctxFor(readerDietary), personId, 'medical'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });

    it('reads nothing without a shared project', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      await writeSensitive(
        db(),
        ctxFor(self),
        personId,
        'dietary',
        VALID_PAYLOADS.dietary,
        OPTIONS,
      );
      // Holds the permission, but on a project the person is not engaged on.
      await expect(
        readSensitive(db(), ctxFor(readerOnB), personId, 'dietary'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });

    it('does not count a deleted engagement as a shared project', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self, engaged: false });
      const engagementId = await engagePerson(
        database,
        s.organisationId,
        s.projectId,
        personId,
      );
      await writeSensitive(
        db(),
        ctxFor(self),
        personId,
        'dietary',
        VALID_PAYLOADS.dietary,
        OPTIONS,
      );
      await db()
        .update(projectPerson)
        .set({ deletedAt: NOW })
        .where(eq(projectPerson.id, engagementId));
      await expect(
        readSensitive(db(), ctxFor(readerDietary), personId, 'dietary'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });

    describe('engagement status', () => {
      /** A person with dietary data, linked to a user, engaged only as given. */
      async function personWith(
        engagements: { projectId: string; status: ProjectPersonStatus }[],
      ) {
        const self = await seedUser(database);
        const personId = await newPerson({ userId: self, engaged: false });
        for (const { projectId, status } of engagements) {
          await engagePerson(database, s.organisationId, projectId, personId, {
            status,
          });
        }
        await writeSensitive(
          db(),
          ctxFor(self),
          personId,
          'dietary',
          VALID_PAYLOADS.dietary,
          OPTIONS,
        );
        return { self, personId };
      }

      it.each(['confirmed', 'released'] as const)(
        'a %s engagement gives access',
        async (status) => {
          const { personId } = await personWith([
            { projectId: s.projectId, status },
          ]);
          const read = await readSensitive(
            db(),
            ctxFor(readerDietary),
            personId,
            'dietary',
          );
          expect(read?.payload).toEqual(VALID_PAYLOADS.dietary);
          await writeSensitive(
            db(),
            ctxFor(editorDietary),
            personId,
            'dietary',
            { restrictions: [], allergies: [] },
            { legalBasis: 'contract' },
          );
        },
      );

      it('a proposed engagement gives no read, write or delete access', async () => {
        const { personId } = await personWith([
          { projectId: s.projectId, status: 'proposed' },
        ]);
        await expect(
          readSensitive(db(), ctxFor(readerDietary), personId, 'dietary'),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
        await expect(
          writeSensitive(
            db(),
            ctxFor(editorDietary),
            personId,
            'dietary',
            VALID_PAYLOADS.dietary,
            { legalBasis: 'contract' },
          ),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
        await expect(
          deleteSensitive(db(), ctxFor(editorDietary), personId, 'dietary'),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
        expect(await auditOf(personId, 'sensitive.denied')).toHaveLength(3);
      });

      it('only the project with a confirmed engagement gives access', async () => {
        const { personId } = await personWith([
          { projectId: s.projectId, status: 'proposed' },
          { projectId: projectB, status: 'confirmed' },
        ]);
        await expect(
          readSensitive(db(), ctxFor(readerDietary), personId, 'dietary'),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
        const read = await readSensitive(
          db(),
          ctxFor(readerOnB),
          personId,
          'dietary',
        );
        expect(read?.payload).toEqual(VALID_PAYLOADS.dietary);
      });

      it('leaves the person’s own access unaffected by a proposed engagement', async () => {
        const { self, personId } = await personWith([
          { projectId: s.projectId, status: 'proposed' },
        ]);
        const read = await readSensitive(
          db(),
          ctxFor(self),
          personId,
          'dietary',
        );
        expect(read?.payload).toEqual(VALID_PAYLOADS.dietary);
        await writeSensitive(
          db(),
          ctxFor(self),
          personId,
          'dietary',
          { restrictions: ['vegan'], allergies: [] },
          OPTIONS,
        );
        await deleteSensitive(db(), ctxFor(self), personId, 'dietary');
      });
    });

    it('counts a permission limited to a department', async () => {
      const sound = await seedDepartment(database, s.organisationId, 'sound-x');
      const scoped = await seedUser(database);
      await grantOnProject(
        database,
        s.organisationId,
        s.projectId,
        scoped,
        [readPermissionKey('dietary')],
        { departmentId: sound },
      );
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      await writeSensitive(
        db(),
        ctxFor(self),
        personId,
        'dietary',
        VALID_PAYLOADS.dietary,
        OPTIONS,
      );
      const read = await readSensitive(
        db(),
        ctxFor(scoped),
        personId,
        'dietary',
      );
      expect(read?.payload).toEqual(VALID_PAYLOADS.dietary);
    });

    it('returns null for an allowed read when the person has no data in the category', async () => {
      const personId = await newPerson();
      const read = await readSensitive(
        db(),
        ctxFor(readerDietary),
        personId,
        'dietary',
      );
      expect(read).toBeNull();
      expect(await auditOf(personId, 'sensitive.read')).toHaveLength(1);
    });

    it('does not let a reader write', async () => {
      const personId = await newPerson();
      await expect(
        writeSensitive(
          db(),
          ctxFor(readerDietary),
          personId,
          'dietary',
          VALID_PAYLOADS.dietary,
          OPTIONS,
        ),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      expect(await countSensitiveRows(personId)).toBe(0);
    });

    it('does not let an editor read, or edit another category', async () => {
      const personId = await newPerson();
      await expect(
        readSensitive(db(), ctxFor(editorDietary), personId, 'dietary'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await expect(
        writeSensitive(
          db(),
          ctxFor(editorDietary),
          personId,
          'medical',
          VALID_PAYLOADS.medical,
          OPTIONS,
        ),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });
  });

  describe('organisation owners and admins', () => {
    it.each([
      ['owner', () => owner],
      ['admin', () => admin],
    ])('an org %s without project grants is denied', async (_name, who) => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      await writeSensitive(
        db(),
        ctxFor(self),
        personId,
        'dietary',
        VALID_PAYLOADS.dietary,
        OPTIONS,
      );
      await expect(
        readSensitive(db(), ctxFor(who()), personId, 'dietary'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await expect(
        writeSensitive(
          db(),
          ctxFor(who()),
          personId,
          'dietary',
          VALID_PAYLOADS.dietary,
          OPTIONS,
        ),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await expect(
        deleteSensitive(db(), ctxFor(who()), personId, 'dietary'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });
  });

  describe('unknown people', () => {
    it('are denied like any other target, so ids cannot be probed', async () => {
      await expect(
        readSensitive(db(), ctxFor(editorAll), newId(), 'dietary'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });
  });

  describe('audit events', () => {
    it('writes exactly one sensitive.read event per allowed read, with no values', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      await writeSensitive(
        db(),
        ctxFor(self),
        personId,
        'identity',
        VALID_PAYLOADS.identity,
        OPTIONS,
      );
      await readSensitive(db(), ctxFor(self), personId, 'identity');
      await readSensitive(db(), ctxFor(editorAll), personId, 'identity');
      const reads = await auditOf(personId, 'sensitive.read');
      expect(reads).toHaveLength(2);
      for (const event of reads) {
        expect(event).toMatchObject({
          category: 'sensitive.read',
          targetType: 'person',
          targetId: personId,
          actorType: 'user',
          organisationId: s.organisationId,
          details: { category: 'identity' },
        });
      }
      expect(reads.map((e) => e.actorId).sort()).toEqual(
        [self, editorAll].sort(),
      );
      expectNoValues(reads, 'read audit');
      expect(await auditOf(personId, 'sensitive.denied')).toHaveLength(0);
    });

    it('writes exactly one sensitive.denied event per denial, with no values', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      await writeSensitive(
        db(),
        ctxFor(self),
        personId,
        'medical',
        VALID_PAYLOADS.medical,
        OPTIONS,
      );
      await expect(
        readSensitive(db(), ctxFor(owner), personId, 'medical'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await expect(
        readSensitive(db(), ctxFor(readerDietary), personId, 'medical'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      const denied = await auditOf(personId, 'sensitive.denied');
      expect(denied).toHaveLength(2);
      for (const event of denied) {
        expect(event).toMatchObject({
          category: 'sensitive.denied',
          targetType: 'person',
          targetId: personId,
          details: { category: 'medical' },
        });
      }
      expect(denied.map((e) => e.actorId).sort()).toEqual(
        [owner, readerDietary].sort(),
      );
      expectNoValues(denied, 'denied audit');
      expect(await auditOf(personId, 'sensitive.read')).toHaveLength(0);
    });

    it('audits a denied write and a denied delete too', async () => {
      const personId = await newPerson();
      await expect(
        writeSensitive(
          db(),
          ctxFor(readerDietary),
          personId,
          'dietary',
          VALID_PAYLOADS.dietary,
          OPTIONS,
        ),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await expect(
        deleteSensitive(db(), ctxFor(readerDietary), personId, 'dietary'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      const denied = await auditOf(personId, 'sensitive.denied');
      expect(denied.map((e) => e.action).sort()).toEqual(['delete', 'write']);
      expectNoValues(denied, 'denied audit');
    });

    it('keeps the denial event when the caller catches the error and commits', async () => {
      const personId = await newPerson();
      await db().transaction(async (tx) => {
        await readSensitive(tx, ctxFor(owner), personId, 'dietary').catch(
          () => undefined,
        );
      });
      expect(await auditOf(personId, 'sensitive.denied')).toHaveLength(1);
    });

    it('records the request id', async () => {
      const personId = await newPerson();
      await readSensitive(
        db(),
        { ...ctxFor(editorAll), requestId: 'req-42' },
        personId,
        'dietary',
      );
      const [event] = await auditOf(personId, 'sensitive.read');
      expect(event?.requestId).toBe('req-42');
    });

    it('records a denial for an unknown person without an organisation', async () => {
      const unknown = newId();
      await expect(
        readSensitive(db(), ctxFor(editorAll), unknown, 'dietary'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      const [event] = await auditOf(unknown, 'sensitive.denied');
      expect(event?.organisationId).toBeNull();
    });
  });

  describe('change events', () => {
    it('name payload in changed_fields and never store its value', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      const c = ctxFor(self);
      await writeSensitive(
        db(),
        c,
        personId,
        'identity',
        VALID_PAYLOADS.identity,
        OPTIONS,
      );
      await writeSensitive(
        db(),
        c,
        personId,
        'identity',
        { dateOfBirth: '1991-05-24' },
        OPTIONS,
      );
      await deleteSensitive(db(), c, personId, 'identity');
      const { rows } = await changesOf(personId);
      expect(rows.map((r) => r.action)).toEqual(['create', 'update', 'delete']);
      for (const row of rows.slice(0, 2)) {
        expect(row.changed_fields as string[]).toContain('payload');
      }
      for (const row of rows) {
        expect(row.entity_type).toBe('person_sensitive');
        expect(row.before === null || !('payload' in (row.before as Row))).toBe(
          true,
        );
        expect(!('payload' in (row.after as Row))).toBe(true);
        expectNoValues(
          { before: row.before, after: row.after },
          'change_event',
        );
      }
      expect(JSON.stringify(rows)).not.toContain('1991-05-24');
    });
  });

  describe('staff writes', () => {
    it('are recorded as staff and notify the person once, without values', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      const notifier = new FakeNotifier();
      const written = await writeSensitive(
        db(),
        ctxFor(editorDietary, notifier),
        personId,
        'dietary',
        VALID_PAYLOADS.dietary,
        { legalBasis: 'contract' },
      );
      expect(written).toMatchObject({
        enteredByKind: 'staff',
        enteredBy: editorDietary,
      });
      expect(notifier.calls).toEqual([
        { personId, category: 'dietary', changedByUserId: editorDietary },
      ]);
      expectNoValues(notifier.calls, 'notifier');
      const read = await readSensitive(db(), ctxFor(self), personId, 'dietary');
      expect(read).toMatchObject({
        enteredByKind: 'staff',
        enteredBy: editorDietary,
        legalBasis: 'contract',
        consentRecordedAt: null,
      });
    });

    it('notify on every staff write, including an update and a delete', async () => {
      const personId = await newPerson();
      const notifier = new FakeNotifier();
      const c = ctxFor(editorAll, notifier);
      await writeSensitive(
        db(),
        c,
        personId,
        'dietary',
        VALID_PAYLOADS.dietary,
        { legalBasis: 'contract' },
      );
      await writeSensitive(
        db(),
        c,
        personId,
        'dietary',
        { restrictions: [], allergies: [] },
        { legalBasis: 'contract' },
      );
      await deleteSensitive(db(), c, personId, 'dietary');
      expect(notifier.calls).toHaveLength(3);
    });

    it('do not touch the person’s consent record on update', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      await writeSensitive(
        db(),
        ctxFor(self),
        personId,
        'dietary',
        VALID_PAYLOADS.dietary,
        {
          legalBasis: 'consent',
          consentTextVersion: '2026-01',
        },
      );
      await writeSensitive(
        db(),
        ctxFor(editorDietary),
        personId,
        'dietary',
        { restrictions: [], allergies: [] },
        { legalBasis: 'consent' },
      );
      const read = await readSensitive(db(), ctxFor(self), personId, 'dietary');
      expect(read).toMatchObject({
        enteredByKind: 'staff',
        consentRecordedAt: NOW,
        consentTextVersion: '2026-01',
      });
    });

    it('do not notify for a self write', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      const notifier = new FakeNotifier();
      await writeSensitive(
        db(),
        ctxFor(self, notifier),
        personId,
        'dietary',
        VALID_PAYLOADS.dietary,
        OPTIONS,
      );
      expect(notifier.calls).toEqual([]);
    });

    it('do not notify when the write is denied', async () => {
      const personId = await newPerson();
      const notifier = new FakeNotifier();
      await expect(
        writeSensitive(
          db(),
          ctxFor(readerDietary, notifier),
          personId,
          'dietary',
          VALID_PAYLOADS.dietary,
          OPTIONS,
        ),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      expect(notifier.calls).toEqual([]);
    });

    it('work with the default no-op notifier', async () => {
      const personId = await newPerson();
      await writeSensitive(
        db(),
        ctxFor(editorDietary),
        personId,
        'dietary',
        VALID_PAYLOADS.dietary,
        { legalBasis: 'contract' },
      );
    });

    it('roll back when the notifier fails, so no change goes unannounced', async () => {
      const personId = await newPerson();
      const failing: SensitiveChangeNotifier = {
        notifyPersonOfStaffChange: () => Promise.reject(new Error('mail down')),
      };
      await expect(
        db().transaction((tx) =>
          writeSensitive(
            tx,
            ctxFor(editorDietary, failing),
            personId,
            'dietary',
            VALID_PAYLOADS.dietary,
            { legalBasis: 'contract' },
          ),
        ),
      ).rejects.toThrow('mail down');
      expect(await countSensitiveRows(personId)).toBe(0);
    });
  });

  describe('invalid payloads', () => {
    it('are rejected before any write, with an error that holds no values', async () => {
      const personId = await newPerson();
      const secret = 'SECRET-DIETARY-VALUE';
      const notifier = new FakeNotifier();
      const before = await changesCount();
      const error = await writeSensitive(
        db(),
        ctxFor(editorDietary, notifier),
        personId,
        'dietary',
        { restrictions: secret, allergies: [], [secret]: secret },
        { legalBasis: 'contract' },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SensitivePayloadInvalidError);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).stack).not.toContain(secret);
      expect(await countSensitiveRows(personId)).toBe(0);
      expect(await changesCount()).toBe(before);
      expect(await auditOf(personId)).toHaveLength(0);
      expect(notifier.calls).toEqual([]);
    });

    it('refuse a category that does not exist', async () => {
      const personId = await newPerson();
      await expect(
        writeSensitive(
          db(),
          ctxFor(editorAll),
          personId,
          'religion' as never,
          {},
          OPTIONS,
        ),
      ).rejects.toThrow(/category/i);
    });

    it('refuse an unknown legal basis', async () => {
      const personId = await newPerson();
      await expect(
        writeSensitive(
          db(),
          ctxFor(editorAll),
          personId,
          'dietary',
          VALID_PAYLOADS.dietary,
          { legalBasis: 'legitimate-interest' as never },
        ),
      ).rejects.toThrow(/legal basis/i);
      expect(await countSensitiveRows(personId)).toBe(0);
    });

    it('answer an unauthorised caller with a denial, not with validation detail', async () => {
      const personId = await newPerson();
      await expect(
        writeSensitive(
          db(),
          ctxFor(owner),
          personId,
          'dietary',
          { nonsense: true },
          OPTIONS,
        ),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });

    async function changesCount() {
      const r = (await db().execute(
        sql`select count(*)::int as n from change_event`,
      )) as { rows: { n: number }[] };
      return r.rows[0]!.n;
    }
  });

  describe('deleting', () => {
    it('soft-deletes, hides the data from reads, and lets it be written again', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      const c = ctxFor(self);
      await writeSensitive(
        db(),
        c,
        personId,
        'dietary',
        VALID_PAYLOADS.dietary,
        OPTIONS,
      );
      await deleteSensitive(db(), c, personId, 'dietary');
      expect(await readSensitive(db(), c, personId, 'dietary')).toBeNull();
      expect(await countSensitiveRows(personId)).toBe(1);

      const again = await writeSensitive(
        db(),
        c,
        personId,
        'dietary',
        { restrictions: ['vegan'], allergies: [] },
        OPTIONS,
      );
      expect(again.version).toBeGreaterThan(1);
      const read = await readSensitive(db(), c, personId, 'dietary');
      expect(read?.payload).toEqual({ restrictions: ['vegan'], allergies: [] });
      const [row] = (
        (await db().execute(
          sql`select deleted_at from person_sensitive where person_id = ${personId}`,
        )) as { rows: Row[] }
      ).rows;
      expect(row?.deleted_at).toBeNull();
    });

    it('erases the values: a deleted row holds a null payload and nothing else sensitive', async () => {
      const self = await seedUser(database);
      const personId = await newPerson({ userId: self });
      const c = ctxFor(self);
      for (const category of ['identity', 'emergency'] as const) {
        await writeSensitive(
          db(),
          c,
          personId,
          category,
          VALID_PAYLOADS[category],
          OPTIONS,
        );
        await deleteSensitive(db(), c, personId, category);
      }
      const { rows } = (await db().execute(
        sql`select * from person_sensitive where person_id = ${personId}`,
      )) as { rows: Row[] };
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.payload).toBeNull();
        expect(row.deleted_at).not.toBeNull();
        expect(row.deleted_by).toBe(self);
        expect(row.category).toBeTruthy();
        expectNoValues(row, 'deleted row');
      }
      const { rows: events } = await changesOf(personId);
      const deletes = events.filter((e) => e.action === 'delete');
      expect(deletes).toHaveLength(2);
      for (const event of deletes) {
        expect(event.changed_fields as string[]).toContain('payload');
        expectNoValues({ b: event.before, a: event.after }, 'delete event');
      }
    });

    it('erases the values of a staff delete too, and a later write restores the row with fresh data', async () => {
      const personId = await newPerson();
      await writeSensitive(
        db(),
        ctxFor(editorAll),
        personId,
        'medical',
        VALID_PAYLOADS.medical,
        { legalBasis: 'contract' },
      );
      await deleteSensitive(db(), ctxFor(editorAll), personId, 'medical');
      const { rows } = (await db().execute(
        sql`select payload from person_sensitive where person_id = ${personId}`,
      )) as { rows: Row[] };
      expect(rows).toEqual([{ payload: null }]);

      await writeSensitive(
        db(),
        ctxFor(editorAll),
        personId,
        'medical',
        { conditions: 'Hay fever' },
        { legalBasis: 'contract' },
      );
      const read = await readSensitive(
        db(),
        ctxFor(editorAll),
        personId,
        'medical',
      );
      expect(read?.payload).toEqual({ conditions: 'Hay fever' });
      const { rows: events } = await changesOf(personId);
      expect(events.map((e) => e.action)).toEqual([
        'create',
        'delete',
        'restore',
      ]);
    });

    it('is allowed with the edit permission and refused with only the read permission', async () => {
      const personId = await newPerson();
      await writeSensitive(
        db(),
        ctxFor(editorDietary),
        personId,
        'dietary',
        VALID_PAYLOADS.dietary,
        { legalBasis: 'contract' },
      );
      await expect(
        deleteSensitive(db(), ctxFor(readerDietary), personId, 'dietary'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await deleteSensitive(db(), ctxFor(editorDietary), personId, 'dietary');
      expect(
        await readSensitive(db(), ctxFor(editorAll), personId, 'dietary'),
      ).toBeNull();
    });

    it('reports a missing record to an allowed caller', async () => {
      const personId = await newPerson();
      await expect(
        deleteSensitive(db(), ctxFor(editorAll), personId, 'dietary'),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
    });
  });
});
