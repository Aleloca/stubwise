import { googleAccounts, projectMembers, users, type Db } from "@stubwise/db";
import { userIsFullAdmin } from "@stubwise/notifications";
import type { MailRecipientSuggestion } from "@stubwise/shared";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";

/**
 * I DESTINATARI SUGGERITI mentre si scrive un indirizzo (area 6, F3, task 5).
 *
 * Due gruppi, in quest'ordine:
 * - `team`: le persone che chi scrive VEDE — la stessa regola di `GET
 *   /api/users` (chi condivide un progetto, i full admin; tutti con
 *   `users.view_all`), mai l'utente di sistema, mai sé stessi;
 * - `mail`: gli indirizzi visti nelle caselle di CHI SCRIVE (mittenti, `to`,
 *   `cc`), il più frequente prima, senza le sue caselle e senza chi è già
 *   nel team. La casella di un altro non entra mai: la WHERE è sulle sue.
 *
 * Nessuna chiamata a Google. La ricerca è per sottostringa, letterale (i
 * jolly di LIKE sono scappati).
 */

export const RECIPIENT_SUGGESTIONS_PER_GROUP = 8;

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function suggestRecipients(
  db: Db,
  viewer: Pick<SessionUser, "id" | "instancePermissions">,
  q: string,
): Promise<MailRecipientSuggestion[]> {
  const needle = q.trim();
  if (needle.length === 0) return [];
  const pattern = likePattern(needle);
  const visible = viewer.instancePermissions.has("users.view_all")
    ? undefined
    : sql`(
        ${userIsFullAdmin(users.id)}
        or exists (
          select 1 from ${projectMembers} theirs
          inner join ${projectMembers} mine on mine.project_id = theirs.project_id
          where theirs.user_id = ${users.id} and mine.user_id = ${viewer.id}
        )
      )`;
  const team = await db
    .select({ id: users.id, email: users.email, name: users.displayName })
    .from(users)
    .where(
      and(
        eq(users.isAgent, false),
        ne(users.id, viewer.id),
        visible,
        sql`(${users.email} ilike ${pattern} escape '\\' or coalesce(${users.displayName}, '') ilike ${pattern} escape '\\')`,
      ),
    )
    .orderBy(asc(sql`lower(coalesce(${users.displayName}, ${users.email}))`))
    .limit(RECIPIENT_SUGGESTIONS_PER_GROUP);

  const teamEmails = team.map((t) => t.email.toLowerCase());
  const mine = db.select({ id: googleAccounts.id }).from(googleAccounts).where(eq(googleAccounts.userId, viewer.id));
  const mail = await db.execute<{ email: string; name: string | null }>(sql`
    with seen as (
      select m.from_address as address, m.from_name as name, m.received_at
        from email_messages m where m.account_id in (${mine})
      union all
      select a, null, m.received_at
        from email_messages m, unnest(m.to_addresses || coalesce(m.cc_addresses, '{}')) as a
        where m.account_id in (${mine})
    )
    select min(address) as email, max(name) as name
      from seen
      where address ilike ${pattern} escape '\\'
        and lower(address) not in (select lower(email) from google_accounts where user_id = ${viewer.id})
        ${teamEmails.length > 0 ? sql`and lower(address) not in (${sql.join(teamEmails.map((e) => sql`${e}`), sql`, `)})` : sql``}
      group by lower(address)
      order by count(*) desc, max(received_at) desc, lower(address)
      limit ${RECIPIENT_SUGGESTIONS_PER_GROUP}
  `);

  return [
    ...team.map((t) => ({ name: t.name, email: t.email, personId: t.id, group: "team" as const })),
    ...[...mail].map((r) => ({ name: r.name, email: r.email, personId: null, group: "mail" as const })),
  ];
}
