import { z } from 'zod';
import {
  effectivePreferencesSchema,
  preferencesSchema,
} from '@osfpm/core/src/preferences/schemas.js';

/**
 * What `GET` and `PUT /me/preferences` answer: the values the person chose, and the values
 * that apply with the defaults filled in. Both come from the core's one schema, so the body
 * of a `PUT`, the answer and the OpenAPI document cannot drift apart.
 */
export const preferencesViewSchema = z.object({
  stored: preferencesSchema.describe(
    'What the person chose, and only that: a field they have not chosen is missing.',
  ),
  effective: effectivePreferencesSchema.describe(
    'What applies: each choice, and the default for every field not chosen. Quiet hours are `null` when there are none.',
  ),
});
