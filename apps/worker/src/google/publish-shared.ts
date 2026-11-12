import { emailMessages, emailProposalRecipients, emailProposals, googleAccounts, projects, type Db } from "@stubwise/db";
import { publishNotification, projectViewerIds, resolveRecipientUserIds } from "@stubwise/notifications";
import type { Language } from "@stubwise/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getContentLanguage } from "../settings.js";
import { buildSharedProposalEvent, type SharedAction } from "./proposal.js";

/**
 * LA PUBBLICAZIONE DELLE PROPOSTE CONDIVISE (area 6, fetta 2, D4).
 *
 * Una proposta per email (Message-ID) e progetto; una CARD per ogni
 * destinatario che è una persona di Stubwise E vede il progetto (membro, o
 * full admin — membro implicito — che sia ANCHE destinatario). Chi riceve la
 * card è scritto in `email_proposal_recipients`, ed è da lì che la proposta
 * si vede e si decide: un admin che non è fra i destinatari non è in quella
 * tabella, e per lui la proposta non esiste. Non c'è un ramo per gli admin.
 *
 * Decisione del maintainer B = (b), 12 nov 2026: l'interruttore «Proposte
 * attive per questa casella» decide solo se classificare la PROPRIA posta;
 * la card arriva a TUTTI i destinatari membri, anche a chi l'ha spento.
 *
 * I destinatari: mittente, `to`, `cc` (mai `bcc`, che non vediamo) di OGNI
 * copia dell'email nelle caselle collegate, più i proprietari di quelle
 * caselle. Una proposta senza destinatari si chiude (`ignored`,
 * `no_recipients`): nessuno la vedrebbe.
 */
export async function publishSharedProposals(
  deps: { db: Db; lang?: Language; publish?: typeof publishNotification; limit?: number },
  accountId: string,
): Promise<number> {
  const db = deps.db;
  const publish = deps.publish ?? publishNotification;
  const rows = await db
    .select({ proposal: emailProposals, message: emailMessages, mailboxEmail: googleAccounts.email })
    .from(emailProposals)
    .innerJoin(emailMessages, eq(emailMessages.id, emailProposals.emailMessageId))
    .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
    .where(
      and(
        eq(emailMessages.accountId, accountId),
        eq(emailProposals.audience, "mail_recipients"),
        eq(emailProposals.status, "classified"),
      ),
    )
    .orderBy(asc(emailProposals.createdAt))
    .limit(deps.limit ?? 20);
  if (rows.length === 0) return 0;
  const lang = deps.lang ?? (await getContentLanguage(db));

  let published = 0;
  for (const { proposal, message, mailboxEmail } of rows) {
    const stored = proposal.classification as { actions?: SharedAction[]; choose?: { projectIds?: string[] } };
    const choose = stored.choose?.projectIds;

    // Le copie dell'email (la stessa chiave) e i loro proprietari.
    const copies = await db
      .select({
        fromAddress: emailMessages.fromAddress,
        to: emailMessages.toAddresses,
        cc: emailMessages.ccAddresses,
        owner: googleAccounts.email,
      })
      .from(emailMessages)
      .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
      .where(
        sql`coalesce(${emailMessages.rfcMessageId}, 'gmail:' || ${emailMessages.accountId} || ':' || ${emailMessages.gmailMessageId}) = ${proposal.rfcMessageId}`,
      );
    const addresses = copies.flatMap((c) => [c.fromAddress, ...c.to, ...(c.cc ?? []), c.owner]);
    const people = await resolveRecipientUserIds(db, addresses);
    // Chi vede il progetto: i membri e i full admin — ma qui solo se sono
    // ANCHE destinatari (l'intersezione).
    const viewers = new Set(await projectViewerIds(db, proposal.projectId));
    const recipients = people.filter((id) => viewers.has(id));

    if (recipients.length === 0) {
      await db
        .update(emailProposals)
        .set({ status: "ignored", outcome: { type: "no_recipients" } })
        .where(and(eq(emailProposals.id, proposal.id), eq(emailProposals.status, "classified")));
      continue;
    }

    const projectIds = [...new Set([proposal.projectId, ...(choose ?? [])])];
    const names = new Map(
      (await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))).map((r) => [r.id, r.name]),
    );
    const event = buildSharedProposalEvent({
      lang,
      proposalId: proposal.id,
      projectId: proposal.projectId,
      projectNames: names,
      mailboxEmail,
      message,
      actions: stored.actions ?? [],
      ...(choose ? { choose } : {}),
    });
    if (!event) {
      await db
        .update(emailProposals)
        .set({ status: "failed", error: "nessuna azione pubblicabile" })
        .where(and(eq(emailProposals.id, proposal.id), eq(emailProposals.status, "classified")));
      continue;
    }

    await db.transaction(async (tx) => {
      // Il claim: solo chi porta la riga da `classified` a `proposed` pubblica.
      const [claimed] = await tx
        .update(emailProposals)
        .set({ status: "proposed" })
        .where(and(eq(emailProposals.id, proposal.id), eq(emailProposals.status, "classified")))
        .returning({ id: emailProposals.id });
      if (!claimed) return;
      for (const userId of recipients) {
        // Audience `mailbox_owner` con UN destinatario alla volta: è la regola
        // di consegna «solo questa persona», mai gli admin.
        const { notificationIds } = await publish(tx, event, { mailboxOwnerUserId: userId, projectId: proposal.projectId });
        await tx
          .insert(emailProposalRecipients)
          .values({ proposalId: proposal.id, userId, notificationId: notificationIds[0] ?? null })
          .onConflictDoNothing();
      }
      published += 1;
    });
  }
  return published;
}
