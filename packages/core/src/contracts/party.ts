import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { sqlList } from '../db/sql-list.js';
import {
  contract,
  contractParty,
  person,
  personCompany,
} from '../db/schema/index.js';
import type { Tx } from '../db/write.js';

/**
 * The relations that tie a person to a loan-out company so that the company's
 * contract is theirs too: the people who own or direct it. An `employee` or a
 * `represented-by` person does not count: working for a company, or being its
 * client, does not make its contracts yours (decision D-73, Q6).
 */
const COMPANY_PARTY_RELATIONS = ['owner', 'director', 'employee'] as const;

/**
 * The one definition of "a party to a contract" (decision D-73, Q6), as an SQL
 * condition that is true for the contract in `contractId` when `userId` is a party
 * to it. A user is a party when:
 *
 * - a live `contract_party` row names a live `person` whose `user_id` is that user;
 *   or
 * - a live `contract_party` row names a company, and a live `person_company` row
 *   links that company to such a person with the relation `owner` or `director`,
 *   valid on `today` (`start_date` empty or not after it, `end_date` empty or not
 *   before it). This is the loan-out company, which is common for crew.
 *
 * Every read that treats a party differently goes through this condition, so a
 * change of the rule is a change of this function: `isContractParty` and
 * `listOwnContracts` both use it. `contractId` is a column of the query it is
 * placed in, or a contract id. `today` is a calendar day, `YYYY-MM-DD`, in UTC.
 *
 * The condition lists the columns it reads and never selects a whole row of
 * `person` (CLAUDE.md, Data rules). It checks no permission and writes nothing.
 */
export function isPartyCondition(
  userId: string,
  contractId: AnyPgColumn | string,
  today: string,
): SQL {
  return sql`(
    exists (
      select 1 from ${contractParty}
      inner join ${person} on ${person.id} = ${contractParty.personId}
      where ${contractParty.contractId} = ${contractId}
        and ${contractParty.deletedAt} is null
        and ${person.userId} = ${userId}
        and ${person.deletedAt} is null
    )
    or exists (
      select 1 from ${contractParty}
      inner join ${personCompany} on ${personCompany.companyId} = ${contractParty.companyId}
      inner join ${person} on ${person.id} = ${personCompany.personId}
      where ${contractParty.contractId} = ${contractId}
        and ${contractParty.deletedAt} is null
        and ${personCompany.deletedAt} is null
        and ${personCompany.relation} in (${sqlList(COMPANY_PARTY_RELATIONS)})
        and (${personCompany.startDate} is null or ${personCompany.startDate} <= ${today}::date)
        and (${personCompany.endDate} is null or ${personCompany.endDate} >= ${today}::date)
        and ${person.userId} = ${userId}
        and ${person.deletedAt} is null
    )
  )`;
}

/**
 * True when `userId` is a party to the live contract `contractId`, by the rule in
 * `isPartyCondition`. A party always sees their own contract, its terms and its
 * amounts, whatever contracts permissions they hold, and being a party never
 * grants a write (decision D-73, Q6). A contract that does not exist, or is
 * deleted, has no parties, so the answer is `false`.
 *
 * `today` is a calendar day, `YYYY-MM-DD`, in UTC: the day the links of a loan-out
 * company are checked on. Checks no permission and writes nothing, and writes no
 * audit event: contracts are not sensitive personal data.
 */
export async function isContractParty(
  tx: Tx,
  userId: string,
  contractId: string,
  today: string,
): Promise<boolean> {
  const [found] = await tx
    .select({ one: sql<number>`1` })
    .from(contract)
    .where(
      and(
        eq(contract.id, contractId),
        isNull(contract.deletedAt),
        isPartyCondition(userId, contract.id, today),
      ),
    )
    .limit(1);
  return found !== undefined;
}
