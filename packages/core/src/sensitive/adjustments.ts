import { and, eq, isNull } from 'drizzle-orm';
import { hasProjectPermission } from '../access/project-permission.js';
import { person, project } from '../db/schema/index.js';
import { recordAudit, type Tx } from '../db/write.js';
import { auditActor, tokenMark } from './audit.js';
import { SensitiveAccessDeniedError } from './errors.js';
import { liveGrants, rolesHeldOn } from './grant-reads.js';
import { isUuid } from './guard.js';
import { readPermissionKey } from './permissions.js';
import { loadGovernedSource, PERSON_COLUMNS, pickFields } from './records.js';
import type { SensitivePayload } from './schemas.js';
import type { SensitiveContext } from './service.js';

/** The adjustments one person has granted the reader, on one project: only those fields. */
export type GrantedAdjustment = {
  readonly personId: string;
  /** Only the fields granted to a role the reader holds, and only those the person has filled in. */
  readonly adjustments: Partial<SensitivePayload<'accessibility'>>;
};

/** What `listGrantedAdjustments` returns: the people of a project, with what each granted the reader. */
export type GrantedAdjustments = {
  readonly projectId: string;
  /** In the order of the person ids. A person who granted the reader nothing is not here. */
  readonly people: readonly GrantedAdjustment[];
};

/**
 * The constraint view of a project: for each person, only the adjustments they have
 * granted to a role the reader holds on the project, which a schedule or a call sheet
 * check can plan around without knowing why anyone needs them (decision D-69). No
 * reasons, no medical data and no field that was not granted: the fields come from live
 * grants only (not revoked, project open, person still engaged, account not deleted), so a
 * person who was released, a project that wrapped, an account that was deleted or a grant
 * that was revoked a moment ago drops out at once. A person with an account is read from
 * their profile, and one without from the
 * production record; either way the person's own choice decides what is returned.
 *
 * Needs `sensitive:read:accessibility` on the project, and the permission alone shows
 * nothing: only grants to a role the reader holds there do. An organisation owner or
 * administrator sees only what a grant to a role they hold on the project opens. A
 * personal API token passes the permission only through its sensitive scope, and then sees
 * what its owner sees.
 *
 * Every person returned is one `sensitive.read` event, with the number of fields and never
 * their names; a call that returns nobody discloses nothing and writes none. A denial is
 * audited as `sensitive.denied` and thrown, the same for a project that does not exist.
 *
 * @throws SensitiveAccessDeniedError (after auditing it), so catch it inside the
 * transaction and commit.
 */
export async function listGrantedAdjustments(
  tx: Tx,
  ctx: SensitiveContext,
  projectId: string,
): Promise<GrantedAdjustments> {
  const now = ctx.clock();
  const [found] = isUuid(projectId)
    ? await tx
        .select({ organisationId: project.organisationId })
        .from(project)
        .where(and(eq(project.id, projectId), isNull(project.deletedAt)))
        .limit(1)
    : [];
  const allowed =
    found !== undefined &&
    (await hasProjectPermission(
      tx,
      ctx.userId,
      projectId,
      readPermissionKey('accessibility'),
      ctx.credential,
    ));
  if (found === undefined || !allowed) {
    await recordAudit(tx, {
      actor: auditActor(ctx),
      organisationId: found?.organisationId ?? null,
      projectId: found === undefined ? null : projectId,
      category: 'sensitive.denied',
      action: 'read',
      targetType: found === undefined ? null : 'project',
      targetId: found === undefined ? null : projectId,
      details: { category: 'accessibility', ...tokenMark(ctx) },
      requestId: ctx.requestId ?? null,
      occurredAt: now,
    });
    throw new SensitiveAccessDeniedError('accessibility', 'read');
  }

  const held = await rolesHeldOn(tx, ctx.userId, found.organisationId, [
    projectId,
  ]);
  const roles = held.get(projectId) ?? new Set<string>();
  const grants =
    roles.size === 0
      ? []
      : await liveGrants(
          tx,
          { organisationId: found.organisationId, projectId },
          'accessibility',
          now,
        );
  const granted = new Map<string, Set<string>>();
  for (const grant of grants) {
    if (!roles.has(grant.roleId)) continue;
    const fields = granted.get(grant.personId) ?? new Set<string>();
    for (const field of grant.fields) fields.add(field);
    granted.set(grant.personId, fields);
  }

  const people: GrantedAdjustment[] = [];
  for (const personId of [...granted.keys()].sort()) {
    const [subject] = await tx
      .select(PERSON_COLUMNS)
      .from(person)
      .where(and(eq(person.id, personId), isNull(person.deletedAt)))
      .limit(1);
    if (subject === undefined) continue;
    const source = await loadGovernedSource(tx, subject, 'accessibility');
    const adjustments =
      source === null ? {} : pickFields(source.payload, granted.get(personId)!);
    const fieldCount = Object.keys(adjustments).length;
    if (fieldCount === 0) continue;
    await recordAudit(tx, {
      actor: auditActor(ctx),
      organisationId: found.organisationId,
      projectId,
      category: 'sensitive.read',
      action: 'read',
      targetType: 'person',
      targetId: personId,
      details: { category: 'accessibility', fieldCount, ...tokenMark(ctx) },
      requestId: ctx.requestId ?? null,
      occurredAt: now,
    });
    people.push({
      personId,
      adjustments: adjustments,
    });
  }
  return { projectId, people };
}
