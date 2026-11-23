import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { AccessDeniedError } from '../access/access-denied-error.js';
import type { AccessCredential } from '../access/credential.js';
import { hasOrganisationPermission } from '../access/organisation-permission.js';
import { location } from '../db/schema/index.js';
import {
  updateRecord,
  type Tx,
  type UpdatePatch,
  type WriteContext,
} from '../db/write.js';
import { LibraryInputError } from './errors.js';
import {
  locationAccessChangesSchema,
  locationAccessSummary,
  type LocationAccessColumns,
  type LocationAccessSummary,
} from './location-access.js';
import {
  LOCATIONS_EDIT_PERMISSION,
  LOCATIONS_READ_PERMISSION,
} from './permissions.js';

/**
 * The location services of the library (decision D-69, P-02l2): read a location with the
 * summary of its access, set the answers about its access, and verify them. Locations belong
 * to the organisation and not to a project, so the permissions are organisation-level:
 * `locations:read` to read and `locations:edit` to set and to verify. A caller holding a
 * personal API token is narrowed by it (`credential`).
 *
 * A call on a location that does not exist, is deleted or belongs to another organisation
 * fails like any other denial, with no scope, so ids cannot be probed. Locations are not
 * sensitive personal data, so a denial writes no audit event. Changes go through the write
 * helper, so each is one change event naming the columns that changed.
 *
 * The answers about access are yes, no or unknown. Verifying them is its own act, and the
 * verification covers the answers as they were: any change to an answer or a detail clears
 * it in the same write. A reader never gets an unverified answer as a plain field: the
 * access columns are left out of `LocationView` and the summary carries them, with what to
 * rely on (see `locationAccessSummary`).
 */

/** Who is acting, and on which server and clock. Always a user. */
export type LibraryContext = {
  /** The user acting. */
  readonly userId: string;
  readonly requestId?: string | null;
  /** The server doing the work. */
  readonly originServer: string;
  readonly clock: () => Date;
  /**
   * How the request was authenticated. A personal API token narrows every permission check
   * by its organisation, project and read or write access, and its writes are the token's in
   * the change log, made for its owner; left out, or a session's, nothing is narrowed.
   */
  readonly credential?: AccessCredential;
};

type LocationRow = typeof location.$inferSelect;

/**
 * A location as a reader sees it: the row without the access columns, and the summary of its
 * access. The five answers, their details and the verification are in `access` only, each
 * labelled `stored` and `effective`, so no reader takes an unverified "yes" from a plain
 * field.
 */
export type LocationView = Omit<LocationRow, keyof LocationAccessColumns> & {
  readonly access: LocationAccessSummary;
};

/** The access columns of a row, by name, which a `LocationView` leaves out. */
const ACCESS_COLUMNS: ReadonlySet<string> = new Set<
  keyof LocationAccessColumns
>([
  'stepFreeRoute',
  'accessibleToilet',
  'accessibleToiletDistanceM',
  'accessibleParking',
  'accessibleParkingSurface',
  'parkingHeightClearanceCm',
  'quietRoom',
  'seating',
  'accessVerifiedAt',
  'accessVerifiedBy',
]);

/** The view of a row: its other columns, and the summary of its access. */
function viewOf(row: LocationRow): LocationView {
  const rest = Object.fromEntries(
    Object.entries(row).filter(([name]) => !ACCESS_COLUMNS.has(name)),
  ) as Omit<LocationRow, keyof LocationAccessColumns>;
  return { ...rest, access: locationAccessSummary(row) };
}

const UUID = z.uuid();

/** The write helper's context for `ctx`: a token's write is the token's in the change log, made for its owner. */
function writeContext(ctx: LibraryContext): WriteContext {
  const shared = {
    originServer: ctx.originServer,
    clock: ctx.clock,
    requestId: ctx.requestId ?? null,
  };
  return ctx.credential?.kind === 'token'
    ? {
        ...shared,
        actor: { type: 'token', id: ctx.credential.tokenId },
        onBehalfOfUserId: ctx.userId,
      }
    : { ...shared, actor: { type: 'user', id: ctx.userId } };
}

/**
 * The live location `locationId`, if the caller holds `key` in its organisation (narrowed by
 * a token's credential). One `AccessDeniedError`, with no scope, for a location that does
 * not exist, is deleted, is another organisation's, or one the caller may not use.
 */
async function requireOnLocation(
  tx: Tx,
  ctx: LibraryContext,
  locationId: string,
  key: string,
): Promise<LocationRow> {
  const denied = () => new AccessDeniedError(key);
  if (!UUID.safeParse(locationId).success) throw denied();
  const [found] = await tx
    .select()
    .from(location)
    .where(and(eq(location.id, locationId), isNull(location.deletedAt)))
    .limit(1);
  if (
    found === undefined ||
    !(await hasOrganisationPermission(
      tx,
      ctx.userId,
      found.organisationId,
      key,
      ctx.credential,
    ))
  ) {
    throw denied();
  }
  return found;
}

/**
 * Reads a location with the summary of its access. Needs `locations:read` in the location's
 * organisation. The summary is the reader's view of the answers: what is stored, what to
 * rely on, and whether it was verified, and an unverified answer reads `unknown`. The row
 * itself comes without the access columns. Not audited: locations are not sensitive data.
 *
 * @throws AccessDeniedError, with no scope, for a location that is unknown, deleted or in
 * another organisation, and for a caller without the permission: all look the same.
 */
export async function getLocation(
  tx: Tx,
  ctx: LibraryContext,
  locationId: string,
): Promise<LocationView> {
  return viewOf(
    await requireOnLocation(tx, ctx, locationId, LOCATIONS_READ_PERMISSION),
  );
}

/**
 * What a change to the access of `current` makes of it, as the columns that differ. The
 * details of an answer that is no longer yes go with it (a distance means nothing under a
 * toilet that is not there), and a detail named for an answer that is not yes is refused:
 * one that contradicts itself is a mistake to say, not a state to keep. Any column that
 * differs also clears the verification, in the same patch, because it vouched for the answers
 * as they were. A change that alters nothing is an empty patch and keeps the verification.
 */
function accessPatch(
  current: LocationRow,
  changes: z.infer<typeof locationAccessChangesSchema>,
): UpdatePatch<typeof location> {
  const toiletYes =
    (changes.accessibleToilet ?? current.accessibleToilet) === 'yes';
  const parkingYes =
    (changes.accessibleParking ?? current.accessibleParking) === 'yes';
  if (
    !toiletYes &&
    changes.accessibleToiletDistanceM !== undefined &&
    changes.accessibleToiletDistanceM !== null
  ) {
    throw new LibraryInputError(
      'The distance to an accessible toilet needs the toilet answered yes',
    );
  }
  if (
    !parkingYes &&
    ((changes.accessibleParkingSurface !== undefined &&
      changes.accessibleParkingSurface !== null) ||
      (changes.parkingHeightClearanceCm !== undefined &&
        changes.parkingHeightClearanceCm !== null))
  ) {
    throw new LibraryInputError(
      'The surface and height clearance of accessible parking need the parking answered yes',
    );
  }
  const next = {
    stepFreeRoute: changes.stepFreeRoute ?? current.stepFreeRoute,
    accessibleToilet: changes.accessibleToilet ?? current.accessibleToilet,
    accessibleToiletDistanceM: !toiletYes
      ? null
      : changes.accessibleToiletDistanceM === undefined
        ? current.accessibleToiletDistanceM
        : changes.accessibleToiletDistanceM,
    accessibleParking: changes.accessibleParking ?? current.accessibleParking,
    accessibleParkingSurface: !parkingYes
      ? null
      : changes.accessibleParkingSurface === undefined
        ? current.accessibleParkingSurface
        : changes.accessibleParkingSurface,
    parkingHeightClearanceCm: !parkingYes
      ? null
      : changes.parkingHeightClearanceCm === undefined
        ? current.parkingHeightClearanceCm
        : changes.parkingHeightClearanceCm,
    quietRoom: changes.quietRoom ?? current.quietRoom,
    seating: changes.seating ?? current.seating,
  };
  const patch: UpdatePatch<typeof location> = {};
  if (next.stepFreeRoute !== current.stepFreeRoute) {
    patch.stepFreeRoute = next.stepFreeRoute;
  }
  if (next.accessibleToilet !== current.accessibleToilet) {
    patch.accessibleToilet = next.accessibleToilet;
  }
  if (next.accessibleToiletDistanceM !== current.accessibleToiletDistanceM) {
    patch.accessibleToiletDistanceM = next.accessibleToiletDistanceM;
  }
  if (next.accessibleParking !== current.accessibleParking) {
    patch.accessibleParking = next.accessibleParking;
  }
  if (next.accessibleParkingSurface !== current.accessibleParkingSurface) {
    patch.accessibleParkingSurface = next.accessibleParkingSurface;
  }
  if (next.parkingHeightClearanceCm !== current.parkingHeightClearanceCm) {
    patch.parkingHeightClearanceCm = next.parkingHeightClearanceCm;
  }
  if (next.quietRoom !== current.quietRoom) patch.quietRoom = next.quietRoom;
  if (next.seating !== current.seating) patch.seating = next.seating;
  if (Object.keys(patch).length > 0) {
    patch.accessVerifiedAt = current.accessVerifiedAt;
    patch.accessVerifiedBy = current.accessVerifiedBy;
  }
  return patch;
}

/**
 * Sets the answers about a location's access: the five that are yes, no or unknown, and the
 * details that only make sense under a yes (the distance to the toilet, and the surface and
 * height clearance of the parking). Only the fields named change, `null` clears a detail, and
 * the details of an answer that stops being yes go with it. Any change to an answer or a
 * detail **clears the verification in the same write**: the verification covered the answers
 * as they were. A call that changes nothing writes nothing and keeps the verification. The
 * write goes through the write helper, so it is one change event naming the columns that
 * changed, the verification included. Needs `locations:edit` in the location's organisation.
 * `expectedVersion` is the version of the location the caller read; left out, the version
 * just read is used.
 *
 * @throws AccessDeniedError, with no scope, for a location that is unknown, deleted or in
 * another organisation, and for a caller without the permission: all look the same.
 * @throws LibraryInputError for a field the call does not take, an answer or number the rules
 * refuse, or a detail named for an answer that is not yes; it names fields, never values.
 * @throws VersionConflictError for a stale `expectedVersion`.
 * @throws RecordWriteError when the database refuses the write.
 */
export async function updateLocationAccess(
  tx: Tx,
  ctx: LibraryContext,
  locationId: string,
  fields: unknown,
  options: { readonly expectedVersion?: number } = {},
): Promise<LocationView> {
  const current = await requireOnLocation(
    tx,
    ctx,
    locationId,
    LOCATIONS_EDIT_PERMISSION,
  );
  const parsed = locationAccessChangesSchema.safeParse(fields);
  if (!parsed.success) {
    throw new LibraryInputError(
      'Invalid location access at: ' +
        parsed.error.issues
          .map((issue) => issue.path.map(String).join('.') || '(root)')
          .join(', '),
    );
  }
  const updated = await updateRecord(
    tx,
    location,
    current.id,
    options.expectedVersion ?? current.version,
    accessPatch(current, parsed.data),
    writeContext(ctx),
  );
  return viewOf(updated);
}

/**
 * Verifies a location's access answers: someone has checked them, and says so with who and
 * when. It sets `access_verified_at` to now and `access_verified_by` to the caller (the
 * owner, for a personal API token), in one write that the change log names. Verifying again
 * moves the date. From then on the summary presents the stored answers as they are, until a
 * change to them clears it (`updateLocationAccess`). The verification covers the answers as
 * the verifier saw them: pass the version they read as `expectedVersion`, and an answer that
 * changed since makes the call fail and verify nothing. Needs `locations:edit` in the
 * location's organisation.
 *
 * @throws AccessDeniedError, with no scope, for a location that is unknown, deleted or in
 * another organisation, and for a caller without the permission: all look the same.
 * @throws VersionConflictError for a stale `expectedVersion`.
 * @throws RecordWriteError when the database refuses the write.
 */
export async function verifyLocationAccess(
  tx: Tx,
  ctx: LibraryContext,
  locationId: string,
  options: { readonly expectedVersion?: number } = {},
): Promise<LocationView> {
  const current = await requireOnLocation(
    tx,
    ctx,
    locationId,
    LOCATIONS_EDIT_PERMISSION,
  );
  const updated = await updateRecord(
    tx,
    location,
    current.id,
    options.expectedVersion ?? current.version,
    { accessVerifiedAt: ctx.clock(), accessVerifiedBy: ctx.userId },
    writeContext(ctx),
  );
  return viewOf(updated);
}
