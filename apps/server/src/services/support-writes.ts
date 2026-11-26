import { backlogItems, createRequestItem, widgetConversations, widgetMessages, type Db } from "@stubwise/db";
import { publishSupportRequestAlert } from "@stubwise/notifications";
import type { SupportConversation, SupportOpenRequestBody, SupportReplyBody } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import { conversationByCode, SupportError, supportView } from "./support.js";

/**
 * Support, le scritture (area 8, F3). Ognuna ricontrolla qui il permesso
 * (le rotte dichiarano `user`), blocca la riga della conversazione (due
 * clic insieme fanno una cosa sola) e risponde con la vista aggiornata.
 *
 * ⚠️ Il team non scrive MAI al cliente del widget (maintainer, 14 nov 2026).
 * Un messaggio `team` nasce SOLO da `replyToCollaborator`, e solo sul canale
 * `mcp` (test sul sorgente in `support-writes.test.ts`).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

const lock = (tx: Db, id: string) => tx.execute(sql`select ${widgetConversations.id} from ${widgetConversations} where ${widgetConversations.id} = ${id} for update`);

/**
 * La risposta al collaboratore (S3): SOLO sul canale `mcp`, il collaboratore
 * interno che ha aperto la richiesta da Claude Code (gli arriva con
 * `my_requests`). Su una conversazione del widget 409: al cliente il team non
 * scrive mai (maintainer, 14 nov 2026). `clientId` rende un doppio invio uno.
 */
export async function replyToCollaborator(db: Db, viewer: Viewer, code: string, input: SupportReplyBody): Promise<SupportConversation> {
  const { row, ctx } = await conversationByCode(db, viewer, code);
  if (!ctx.permissions.has("support.manage")) throw new SupportError(403, "forbidden", "Replying to collaborators needs support.manage");
  if (row.channel !== "mcp") {
    throw new SupportError(409, "support_widget_no_reply", "The team never writes to a widget customer");
  }
  await db.transaction(async (tx) => {
    await lock(tx, row.id);
    if (input.clientId) {
      const [already] = await tx
        .select({ id: widgetMessages.id })
        .from(widgetMessages)
        .where(and(eq(widgetMessages.conversationId, row.id), eq(widgetMessages.clientId, input.clientId)));
      if (already) return;
    }
    const now = new Date();
    await tx.insert(widgetMessages).values({
      conversationId: row.id,
      role: "team",
      content: input.body,
      authorId: viewer.id,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      createdAt: now,
    });
    await tx.update(widgetConversations).set({ lastMessageAt: now }).where(eq(widgetConversations.id, row.id));
  });
  return supportView(db, row, ctx);
}

/**
 * «Apri la richiesta» (S6) su una conversazione non conclusa
 * (`support.manage` E `backlog.create`): nasce legata alla conversazione, chi la apre è il
 * richiedente (come `openRequestFrom` del prototipo). Una conversazione che ha
 * già la sua richiesta la restituisce (`created: false`).
 */
export async function openRequestFrom(
  db: Db,
  viewer: Viewer,
  code: string,
  input: SupportOpenRequestBody,
  opts: { publicUrl?: string | null } = {},
): Promise<{ created: boolean; conversation: SupportConversation; request: { id: string; code: string } }> {
  const { row, ctx } = await conversationByCode(db, viewer, code);
  if (!ctx.permissions.has("support.manage") || !ctx.permissions.has("backlog.create")) {
    throw new SupportError(403, "forbidden", "Opening a request needs support.manage and backlog.create");
  }
  const result = await db.transaction(async (tx) => {
    await lock(tx, row.id);
    const [existing] = await tx
      .select({ id: backlogItems.id, number: backlogItems.number })
      .from(backlogItems)
      .where(eq(backlogItems.supportConversationId, row.id))
      .limit(1);
    if (existing) return { created: false, id: existing.id, number: existing.number };
    if ((await supportView(tx, row, ctx)).state !== "not_concluded") {
      throw new SupportError(409, "support_not_concluded", "Only a not-concluded conversation becomes a request");
    }
    const id = await createRequestItem(tx, {
      projectId: row.projectId,
      title: input.title,
      document: input.description ?? "",
      requesterId: viewer.id,
      supportConversationId: row.id,
    });
    const [item] = await tx.select({ number: backlogItems.number }).from(backlogItems).where(eq(backlogItems.id, id));
    // S7: l'avviso nasce con la richiesta (nella sua transazione).
    await publishSupportRequestAlert(tx, opts.publicUrl, id);
    return { created: true, id, number: item!.number };
  });
  return {
    created: result.created,
    conversation: await supportView(db, row, ctx),
    request: { id: result.id, code: `${ctx.projectCode}-R${result.number}` },
  };
}

/**
 * «Non conclusa» (S15, decisione del maintainer): rimette una conversazione
 * `answered` fra quelle che aspettano il team. Il giudizio porta la persona
 * come autrice, e `triage_checked_at` ferma il controllo del worker finché il
 * cliente non riscrive. Idempotente su una già non conclusa.
 */
export async function markNotConcluded(db: Db, viewer: Viewer, code: string): Promise<SupportConversation> {
  const { row, ctx } = await conversationByCode(db, viewer, code);
  if (!ctx.permissions.has("support.manage")) throw new SupportError(403, "forbidden", "Needs support.manage");
  await db.transaction(async (tx) => {
    await lock(tx, row.id);
    const state = (await supportView(tx, row, ctx)).state;
    if (state === "not_concluded") return;
    if (state !== "answered") throw new SupportError(409, "support_not_answered", "Only an answered conversation can be marked not concluded");
    const now = new Date();
    await tx
      .update(widgetConversations)
      .set({ triageOutcome: "not_concluded", triageOutcomeAt: now, triageOutcomeByUserId: viewer.id, triageCheckedAt: now })
      .where(eq(widgetConversations.id, row.id));
  });
  return supportView(db, row, ctx);
}
