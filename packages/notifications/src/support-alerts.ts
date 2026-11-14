import { backlogItems, projects, widgetConversations, type Db } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { publishNotification } from "./publish.js";

/**
 * L'avviso di Support (area 8, F3, S7), nel catalogo: lo pubblicano il server
 * («Apri la richiesta») e il worker (l'intake che nasce dal ticket di un
 * widget), con UNA forma. Best-effort:
 * `publishNotification` non lancia. Senza radice pubblica il link resta
 * RELATIVO (`/app/#/…`), come gli avvisi dei rilasci.
 */

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const root = (publicUrl: string | null | undefined) => (publicUrl ?? "").replace(/\/+$/, "");

/** `support.request`: una richiesta nata da una conversazione. Nessun obbligatorio (il catalogo: default per `backlog.edit`). */
export async function publishSupportRequestAlert(db: DbOrTx, publicUrl: string | null | undefined, itemId: string): Promise<void> {
  const [row] = await db
    .select({
      projectId: backlogItems.projectId,
      number: backlogItems.number,
      title: backlogItems.title,
      code: projects.code,
      customerName: widgetConversations.externalUserName,
    })
    .from(backlogItems)
    .innerJoin(projects, eq(projects.id, backlogItems.projectId))
    .innerJoin(widgetConversations, eq(widgetConversations.id, backlogItems.supportConversationId))
    .where(eq(backlogItems.id, itemId));
  if (!row) return;
  await publishNotification(
    db as Db,
    {
      kind: "support.request",
      projectId: row.projectId,
      requestCode: `${row.code}-R${row.number}`,
      title: row.title,
      customerName: row.customerName,
      url: `${root(publicUrl)}/app/#/p/${row.code}/requests?request=${itemId}`,
    },
    { projectId: row.projectId },
  );
}
