import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiJobs, prCorrections } from "./schema.js";
import { seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * 0220 (rimandi, lotto 4, A8): l'esito di una correzione. Il backfill marca
 * `discarded` le correzioni di prima chiuse per un push rifiutato (il worker
 * scriveva quella frase come errore del job), e solo quelle.
 */
const MIGRATION = join(fileURLToPath(new URL(".", import.meta.url)), "..", "drizzle", "0220_pr_correction_outcome.sql");

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t.stop();
});

describe("0220: outcome di pr_corrections", () => {
  it("il backfill: push rifiutato → discarded; un altro errore e una riuscita restano null", async () => {
    const { ticketId, repositoryId } = await seedTicket(t.db);
    const add = async (job: { status: "failed" | "pr_opened"; error?: string }) => {
      const [c] = await t.db.insert(prCorrections).values({ ticketId, repositoryId, prNumber: 7, trigger: "review", status: "done" }).returning();
      await t.db.insert(aiJobs).values({ ticketId, correctionId: c!.id, status: job.status, error: job.error ?? null });
      return c!.id;
    };
    const rejected = await add({ status: "failed", error: "push rifiutato: qualcuno ha pushato sul branch b durante la correzione" });
    const otherError = await add({ status: "failed", error: "credenziali dell'account git non decifrabili" });
    const pushed = await add({ status: "pr_opened" });
    const backfill = readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint").at(-1)!;
    await t.db.execute(sql.raw(backfill));
    const outcome = async (id: string) => (await t.db.select({ o: prCorrections.outcome }).from(prCorrections).where(eq(prCorrections.id, id)))[0]!.o;
    expect(await outcome(rejected)).toBe("discarded");
    expect(await outcome(otherError)).toBeNull();
    expect(await outcome(pushed)).toBeNull();
  });

  it("il CHECK ammette solo i tre esiti", async () => {
    const { ticketId, repositoryId } = await seedTicket(t.db);
    await expect(t.db.insert(prCorrections).values({ ticketId, repositoryId, prNumber: 8, trigger: "review", status: "done", outcome: "boh" as never })).rejects.toThrow();
  });
});
