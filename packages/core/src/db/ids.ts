import { v7 } from 'uuid';

/**
 * Generates a UUIDv7. All record IDs are created by the application, never by
 * the database. UUIDv7 values sort by creation time.
 */
export function newId(): string {
  return v7();
}
