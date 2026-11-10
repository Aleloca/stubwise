import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatChannels, chatMessageLinks, chatMessages, tickets } from "./schema.js";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0137 (10 nov 2026, area 4, fetta 2 della Chat): la chiave dei DM,
 * il nome unico dei canali generali, «anche nel canale», il testo piegato per
 * la ricerca (con il backfill dei messaggi che c'erano), le domande ignorate e
 * i legami messaggio → task/richiesta.
 */

const DRIZZLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

let t: TestDb;
let projectId: string;
let general: string;
beforeAll(async () => {
  t = await startTestDb();
  ({ projectId } = await seedRepository(t.db));
  const [g] = await t.db.select({ id: chatChannels.id }).from(chatChannels).where(eq(chatChannels.projectId, projectId));
  general = g!.id;
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

/** Lo statement di backfill della 0137, eseguito di nuovo sui dati di adesso. */
async function rerunBackfill(): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0137_chat_fetta2.sql"), "utf8");
  const update = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .map((s) => s.split("\n").filter((l) => !l.startsWith("--")).join("\n"))
    .find((s) => s.startsWith('UPDATE "chat_messages"'));
  expect(update).toBeDefined();
  await t.db.execute(sql.raw(update!));
}

describe("0137 Chat, fetta 2", () => {
  it("backfill: il testo dei messaggi di prima in minuscole (gli accenti li toglie il server); un eliminato resta vuoto", async () => {
    const [live] = await t.db
      .insert(chatMessages)
      .values({ channelId: general, body: "Perché NON è già Pronto?" })
      .returning({ id: chatMessages.id });
    const [gone] = await t.db
      .insert(chatMessages)
      .values({ channelId: general, body: "", deletedAt: new Date() })
      .returning({ id: chatMessages.id });
    await rerunBackfill();
    const rows = await t.db
      .select({ id: chatMessages.id, folded: chatMessages.searchFolded })
      .from(chatMessages)
      .where(sql`${chatMessages.id} in (${live!.id}, ${gone!.id})`);
    const byId = new Map(rows.map((r) => [r.id, r.folded]));
    expect(byId.get(live!.id)).toBe("perché non è già pronto?");
    expect(byId.get(gone!.id)).toBe("");
  });

  it("un DM ha la sua chiave, un canale che non è un DM no", async () => {
    await expect(
      t.db.insert(chatChannels).values({ kind: "dm", visibility: "private", name: "" }),
    ).rejects.toThrow();
    await expect(
      t.db.insert(chatChannels).values({ kind: "general", name: "annunci-k", dmKey: "a,b" }),
    ).rejects.toThrow();
    const key = "00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000002";
    const [a] = await t.db
      .insert(chatChannels)
      .values({ kind: "dm", visibility: "private", name: "", dmKey: key })
      .returning({ id: chatChannels.id });
    // Non unica: un gruppo da cui qualcuno è uscito può coincidere con un DM che c'è già.
    const [b] = await t.db
      .insert(chatChannels)
      .values({ kind: "dm", visibility: "private", name: "", dmKey: key })
      .returning({ id: chatChannels.id });
    expect(a!.id).not.toBe(b!.id);
  });

  it("il nome di un canale generale è unico fra i generali; due DM senza nome sì", async () => {
    await t.db.insert(chatChannels).values({ kind: "general", name: "annunci" });
    await expect(t.db.insert(chatChannels).values({ kind: "general", name: "annunci" })).rejects.toThrow();
    // Un canale di progetto con lo stesso nome non si scontra con un generale.
    await t.db.insert(chatChannels).values({ kind: "project", projectId, name: "annunci" });
  });

  it("un legame è una task o una richiesta, una volta sola, e se ne va con la task", async () => {
    const [m] = await t.db.insert(chatMessages).values({ channelId: general, body: "da qui" }).returning({ id: chatMessages.id });
    const task = { id: (await seedTicket(t.db, { projectId })).ticketId };
    await expect(t.db.insert(chatMessageLinks).values({ messageId: m!.id })).rejects.toThrow();
    await t.db.insert(chatMessageLinks).values({ messageId: m!.id, ticketId: task.id });
    await expect(t.db.insert(chatMessageLinks).values({ messageId: m!.id, ticketId: task.id })).rejects.toThrow();
    await t.db.delete(tickets).where(eq(tickets.id, task.id));
    expect(await t.db.select().from(chatMessageLinks).where(eq(chatMessageLinks.messageId, m!.id))).toEqual([]);
  });
});
