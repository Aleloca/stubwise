import { randomUUID } from "node:crypto";
import { createDb, emailBodies, emailMessages, encrypt, googleAccounts, googleWorkspaces } from "@stubwise/db";
import { stackDatabaseUrl } from "./second-factor";

/*
 * La posta per la suite: niente Google. Una casella collegata e un thread con
 * il corpo già in cache (`email_bodies`), come li lascia il poller del worker:
 * la rotta di lettura risponde dalla cache senza chiamare Gmail. Le stesse
 * righe che seminano i test del server (`me-mail.test.ts`).
 */

/** La chiave di cifratura dello stack (`start-stack.mjs`). */
const ENCRYPTION_KEY = Buffer.alloc(32, 7);

export interface SeededThread {
  subject: string;
  body: string;
  from: string;
}

export async function seedMailThread(userId: string, mailbox: string): Promise<SeededThread> {
  const { db, client } = createDb(stackDatabaseUrl());
  try {
    const [workspace] = await db
      .insert(googleWorkspaces)
      .values({ name: "Acme", domains: ["acme.test"], clientId: "client-id", clientSecretEncrypted: encrypt("client-secret", ENCRYPTION_KEY) })
      .returning({ id: googleWorkspaces.id });
    const [account] = await db
      .insert(googleAccounts)
      .values({
        userId,
        workspaceId: workspace!.id,
        email: mailbox,
        googleSub: `sub-${randomUUID()}`,
        refreshTokenEncrypted: encrypt("refresh-token", ENCRYPTION_KEY),
      })
      .returning({ id: googleAccounts.id });
    const thread: SeededThread = {
      subject: "Il checkout si blocca al pagamento",
      body: "Da ieri sera il pulsante «Paga» resta grigio dopo aver inserito la carta.",
      from: "laura@cliente.test",
    };
    const [message] = await db
      .insert(emailMessages)
      .values({
        accountId: account!.id,
        gmailMessageId: `m-${randomUUID()}`,
        threadId: `t-${randomUUID()}`,
        fromAddress: thread.from,
        fromName: "Laura Bianchi",
        toAddresses: [mailbox],
        subject: thread.subject,
        // Come lo scrive il worker: il testo del messaggio, tagliato solo oltre
        // `MAX_TEXT_LENGTH` (20.000 caratteri, `packages/google/src/gmail.ts`).
        textExcerpt: thread.body,
        receivedAt: new Date(Date.now() - 60 * 60_000),
        unread: true,
        status: "new",
      })
      .returning({ id: emailMessages.id });
    await db.insert(emailBodies).values({
      emailMessageId: message!.id,
      subject: thread.subject,
      fromAddress: thread.from,
      toAddresses: [mailbox],
      bodyText: thread.body,
      bodyHtml: null,
    });
    return thread;
  } finally {
    await client.end();
  }
}
