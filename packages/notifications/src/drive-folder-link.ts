import { googleAccounts, projectMembers, roles } from "@stubwise/db";
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { userIsFullAdmin } from "./project-access.js";

/** Lo scope con cui Stubwise legge il Drive di una casella (area 6, F5b). */
export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/**
 * Condizione SQL: chi ha collegato una cartella Google (`linkedBy`) NON può
 * più alimentarla (area 6, F5b, B4 e la review del server, punto 4, decisione
 * del maintainer «O»). Vale «scaduta» quando:
 * - la sua casella (`accountId`) non c'è più, è disattivata o non ha
 *   `drive.readonly`;
 * - oppure lui non ha più `drive.manage` nel progetto (uscito dal progetto,
 *   ruolo cambiato, utente eliminato): un full admin lo ha sempre.
 *
 * Una cartella scaduta non si sincronizza e i suoi file non si leggono
 * (`access_lost`): niente testo, riassunto né frammenti a chi cerca o a
 * Claude. Si DERIVA a lettura, quindi ricollegata (o rimesso il permesso)
 * torna da sola. L'UNICA copia della regola: la usano il server (viste,
 * ricerca, contenuto) e il worker (claim della sincronizzazione, contenuto).
 * Le tabelle interne sono aliasate (`fl_ga`, `fl_pm`, `fl_r`) per non
 * catturare le colonne esterne passate come argomenti.
 */
export function folderLinkExpiredSql(link: { accountId: AnyColumn | SQL; linkedBy: AnyColumn | SQL; projectId: AnyColumn | SQL }): SQL<boolean> {
  return sql<boolean>`(
    not exists (
      select 1 from ${googleAccounts} fl_ga
      where fl_ga.id = ${link.accountId}
        and fl_ga.disabled_at is null
        and ${DRIVE_READONLY_SCOPE} = any(fl_ga.scopes)
    )
    or not (
      ${userIsFullAdmin(link.linkedBy)}
      or exists (
        select 1 from ${projectMembers} fl_pm
        inner join ${roles} fl_r on fl_r.id = fl_pm.role_id
        where fl_pm.user_id = ${link.linkedBy}
          and fl_pm.project_id = ${link.projectId}
          and fl_r.permissions @> array['drive.manage']::text[]
      )
    )
  )`;
}
