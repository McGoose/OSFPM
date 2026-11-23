import type { ProjectStatus } from '../db/schema/index.js';

/**
 * Whether an access grant is live is worked out when it is read, from the state of the
 * project and the person, so nothing needs a job to end one (decision D-69). A grant is
 * live while it is not revoked, the project is open (`projectIsOpen`) and the person
 * still has an engagement on the project that is live (`LIVE_ENGAGEMENT_STATUSES`).
 */

/**
 * The project statuses at which a project is closed: the work is delivered or the
 * project is archived. A grant is not live on a closed project.
 */
export const CLOSED_PROJECT_STATUSES: readonly ProjectStatus[] = [
  'delivered',
  'archived',
];

/**
 * The `project_person` statuses at which a person is still on the production: proposed
 * or confirmed. A person who is released, or whose row is deleted, is not, and the
 * grants made for them there stop opening anything.
 */
export const LIVE_ENGAGEMENT_STATUSES = ['proposed', 'confirmed'] as const;

/** What `projectIsOpen` needs to know of a project. */
export type ProjectTiming = {
  readonly deletedAt: Date | null;
  readonly status: ProjectStatus;
  /** The last day of the shoot, as `YYYY-MM-DD`, or `null` when none is set. */
  readonly wrapDate: string | null;
  /** The project's own time zone, which says what day it is there. */
  readonly timezone: string;
};

/**
 * The calendar date of `at` in `timeZone`, as `YYYY-MM-DD`. A time zone that the runtime
 * does not know reads as UTC, so a bad value can only move the end of a grant by a day,
 * never throw in the middle of a read.
 */
export function dateInZone(timeZone: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * Whether a project is open for access grants at `now`: it is not deleted, its status is
 * not a closed one, and its wrap date has not passed. The project's own wrap date
 * (`project.wrap_date`, the date retention counts from) is the end: a grant is live on
 * the wrap date itself, because the last day of the shoot still runs on it, and ends the
 * day after, by the date in the project's own time zone. A project with no wrap date is
 * open until its status says otherwise.
 */
export function projectIsOpen(project: ProjectTiming, now: Date): boolean {
  if (project.deletedAt !== null) return false;
  if (CLOSED_PROJECT_STATUSES.includes(project.status)) return false;
  if (project.wrapDate === null) return true;
  // `YYYY-MM-DD` strings compare as dates.
  return dateInZone(project.timezone, now) <= project.wrapDate;
}
