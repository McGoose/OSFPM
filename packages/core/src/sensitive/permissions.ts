import type { PermissionDefinition } from '../access/permission-sync.js';
import { SENSITIVE_CATEGORIES, type SensitiveCategory } from './schemas.js';

/** Permission to read count-only compliance reports for a project. */
export const COMPLIANCE_REPORT_PERMISSION = 'compliance:report';

/** The permission key to read one category of a person's sensitive data. */
export function readPermissionKey(category: SensitiveCategory): string {
  return `sensitive:read:${category}`;
}

/** The permission key to enter, change or delete one category. */
export function editPermissionKey(category: SensitiveCategory): string {
  return `sensitive:edit:${category}`;
}

/**
 * Catalogue rows for the sensitive data module: one read and one edit
 * permission per category, plus the compliance report. The read and edit
 * permissions are flagged `grants_sensitive`; the count-only report is not
 * (CLAUDE.md, Privacy rule).
 */
export const SENSITIVE_PERMISSIONS: readonly PermissionDefinition[] = [
  ...SENSITIVE_CATEGORIES.flatMap((category) => [
    {
      key: readPermissionKey(category),
      module: 'sensitive',
      description: `Read ${category} data of people on the project`,
      grantsSensitive: true,
    },
    {
      key: editPermissionKey(category),
      module: 'sensitive',
      description: `Enter and change ${category} data of people on the project`,
      grantsSensitive: true,
    },
  ]),
  {
    key: COMPLIANCE_REPORT_PERMISSION,
    module: 'compliance',
    description: 'See count-only compliance reports for the project',
    grantsSensitive: false,
  },
];
