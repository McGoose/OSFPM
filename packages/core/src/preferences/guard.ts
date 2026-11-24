import { z } from 'zod';
import { AccessDeniedError } from '../access/access-denied-error.js';
import { AuthStateError } from '../auth/errors.js';
import {
  RecordNotFoundError,
  RecordStateError,
  RecordWriteError,
  VersionConflictError,
} from '../db/write.js';
import {
  PreferencesInvalidError,
  UseAccountPreferencesError,
} from './errors.js';

const UUID = z.uuid();

/**
 * True when `value` is the text of a UUID. An id that comes from a caller is checked with
 * this before it reaches a `uuid` column, which would refuse anything else with a database
 * error: a value that is not an id matches nothing, as an id that does not exist does.
 */
export function isUuid(value: unknown): value is string {
  return UUID.safeParse(value).success;
}

/** The SQLSTATE code and constraint name in a database error's cause chain. */
function driverErrorOf(
  error: unknown,
): { code: string; constraint: string | undefined } | undefined {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    const candidate = current as { code?: unknown; constraint?: unknown };
    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        constraint:
          typeof candidate.constraint === 'string'
            ? candidate.constraint
            : undefined,
      };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Runs a query or write on the table only this module writes and turns any database failure
 * into a `RecordWriteError` that carries the SQLSTATE and constraint name only. Drivers and
 * Drizzle put the values written in their messages, and here those are a person's choices,
 * which should not reach a log or an error. The typed errors of this module, and of the
 * calls it makes, pass through unchanged.
 */
export async function guardedPreferences<R>(
  entityType: string,
  operation: string,
  action: () => Promise<R>,
): Promise<R> {
  try {
    return await action();
  } catch (error) {
    if (
      error instanceof PreferencesInvalidError ||
      error instanceof UseAccountPreferencesError ||
      error instanceof AccessDeniedError ||
      error instanceof AuthStateError ||
      error instanceof RecordNotFoundError ||
      error instanceof RecordStateError ||
      error instanceof VersionConflictError ||
      error instanceof RecordWriteError
    ) {
      throw error;
    }
    const found = driverErrorOf(error);
    throw new RecordWriteError(
      entityType,
      operation,
      found?.code,
      found?.constraint,
    );
  }
}
