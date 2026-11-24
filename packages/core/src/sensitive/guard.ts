import { z } from 'zod';
import { RecordNotFoundError, RecordWriteError } from '../db/write.js';
import {
  AccessGrantBusyError,
  AccessGrantRefusedError,
  AccessProfileExistsError,
  AccountDeletedError,
  RoleNotAvailableError,
  SensitiveAccessDeniedError,
  SensitivePayloadInvalidError,
  UseAccessProfileError,
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
export function driverErrorOf(
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
 * Runs a query or write on the tables only this module writes and turns any database
 * failure into a `RecordWriteError` that carries the SQLSTATE and constraint name only.
 * Drivers and Drizzle put the values written in their messages, and here those are a
 * person's access needs, which must never reach a log or an error (CLAUDE.md, Privacy
 * rule). The typed errors of this module pass through unchanged.
 */
export async function guardedSensitive<R>(
  entityType: string,
  operation: string,
  action: () => Promise<R>,
): Promise<R> {
  try {
    return await action();
  } catch (error) {
    if (
      error instanceof SensitiveAccessDeniedError ||
      error instanceof SensitivePayloadInvalidError ||
      error instanceof UseAccessProfileError ||
      error instanceof RoleNotAvailableError ||
      error instanceof AccountDeletedError ||
      error instanceof AccessGrantRefusedError ||
      error instanceof AccessProfileExistsError ||
      error instanceof AccessGrantBusyError ||
      error instanceof RecordNotFoundError ||
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
