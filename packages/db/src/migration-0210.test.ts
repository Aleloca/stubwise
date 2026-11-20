import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  emailMessages,
  emailProposals,
  googleAccounts,
  googleWorkspaces,
  meetingNotes,
  productClaudeMarks,
  productComments,
  productDocJobs,
  productPageRevisions,
  productPages,
  projectDecisions,
  projectStatuses,
  releases,
  tickets,
  users,
} from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0210 (20 nov 2026, area 11, F5): la coda del lavoro di Claude
 * sulla doc di prodotto, riempita dai trigger delle fonti nella transazione di
 * chi scrive, solo per i progetti con una pagina di prodotto, una fonte una
 * volta sola; i segni; le colonne di revisioni e commenti.
 */
let t: TestDb;
let projectId: string;
let repositoryId: string;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
beforeEach(async () => {
  ({ projectId, repositoryId } = await seedRepository(t.db));
});
afterAll(async () => {
  await t?.stop();
});

const jobsOf = (pid: string) => t.db.select({ kind: productDocJobs.sourceKind, sourceId: productDocJobs.sourceId, status: productDocJobs.status }).from(productDocJobs).where(eq(productDocJobs.projectId, pid)).orderBy(asc(productDocJobs.createdAt));
const withPage = async (pid = projectId) => (await t.db.insert(productPages).values({ projectId: pid, title: "Visione" }).returning())[0]!;
let n = 500;
const task = () => ({ projectId, number: n++, title: "Una task", type: "task" as const, priority: "medium" as const, source: "manual" as const });
const decision = (pid = projectId) => ({ projectId: pid, source: "manual" as const, sourceKey: `k-${randomUUID()}`, title: "Decisa", decision: "sì" });

async function mail(admitted: boolean) {
  const [u] = await t.db.insert(users).values({ email: `m-${randomUUID().slice(0, 6)}@x.test`, passwordHash: "x", role: "member" }).returning();
  const [ws] = await t.db.insert(googleWorkspaces).values({ name: "W", domains: ["x.test"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  const [box] = await t.db.insert(googleAccounts).values({ userId: u!.id, workspaceId: ws!.id, email: `box-${randomUUID()}@x.test`, googleSub: randomUUID(), refreshTokenEncrypted: "r" }).returning();
  const [m] = await t.db.insert(emailMessages).values({ accountId: box!.id, gmailMessageId: `g-${randomUUID()}`, threadId: "t", fromAddress: "c@x.it", subject: "S", receivedAt: new Date(), textExcerpt: "x", admitted }).returning();
  return m!;
}

describe("migrazione 0210: i trigger accodano una fonte, una volta", () => {
  it("una task che entra nella famiglia chiusa; un altro cambio di stato no; richiusa dopo una riapertura non raddoppia", async () => {
    await withPage();
    const statuses = await t.db.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
    const todo = statuses.find((s) => s.family === "todo")!.id;
    const closed = statuses.filter((s) => s.family === "closed").map((s) => s.id);
    const [row] = await t.db.insert(tickets).values({ ...task(), statusId: todo } as typeof tickets.$inferInsert).returning();
    expect(await jobsOf(projectId)).toEqual([]);
    await t.db.update(tickets).set({ statusId: closed[0]! }).where(eq(tickets.id, row!.id));
    expect(await jobsOf(projectId)).toEqual([{ kind: "task", sourceId: row!.id, status: "queued" }]);
    await t.db.update(tickets).set({ statusId: todo }).where(eq(tickets.id, row!.id));
    await t.db.update(tickets).set({ statusId: closed[0]! }).where(eq(tickets.id, row!.id));
    expect(await jobsOf(projectId)).toHaveLength(1);
  });

  it("una decisione registrata e un rilascio", async () => {
    await withPage();
    const [d] = await t.db.insert(projectDecisions).values(decision() as typeof projectDecisions.$inferInsert).returning();
    const [r] = await t.db
      .insert(releases)
      .values({ projectId, repositoryId, code: `R-${randomUUID().slice(0, 4)}`, seq: n++, prNumber: 3, prUrl: "https://x/pr/3", title: "R", mergeSha: "b".repeat(40), mergedAt: new Date(), viaStubwise: false } as typeof releases.$inferInsert)
      .returning();
    expect((await jobsOf(projectId)).map((j) => [j.kind, j.sourceId])).toEqual([["decision", d!.id], ["release", r!.id]]);
  });

  it("una riunione: solo quando il documento è pronto E c'è un progetto", async () => {
    await withPage();
    const m = await mail(true);
    const [note] = await t.db.insert(meetingNotes).values({ docFileId: `doc-${randomUUID()}`, sourceMessageId: m.id }).returning();
    expect(await jobsOf(projectId)).toEqual([]);
    await t.db.update(meetingNotes).set({ docStatus: "ready" }).where(eq(meetingNotes.id, note!.id));
    expect(await jobsOf(projectId)).toEqual([]);
    await t.db.update(meetingNotes).set({ projectId }).where(eq(meetingNotes.id, note!.id));
    expect(await jobsOf(projectId)).toEqual([{ kind: "meeting", sourceId: note!.id, status: "queued" }]);
  });

  it("una proposta della posta: solo di un messaggio AMMESSO (N-2 = a); la fonte è il messaggio", async () => {
    await withPage();
    const admitted = await mail(true);
    const kept = await mail(false);
    for (const m of [admitted, kept]) await t.db.insert(emailProposals).values({ emailMessageId: m.id, projectId, status: "proposed", classification: { summary: "s", proposals: [], recommendedIndex: 0 } });
    expect(await jobsOf(projectId)).toEqual([{ kind: "email", sourceId: admitted.id, status: "queued" }]);
  });

  it("un progetto senza pagine di prodotto non accoda niente", async () => {
    await t.db.insert(projectDecisions).values(decision() as typeof projectDecisions.$inferInsert);
    expect(await jobsOf(projectId)).toEqual([]);
  });

  it("la stessa fonte due volte non raddoppia (l'unicità di progetto, tipo e fonte)", async () => {
    await withPage();
    const [d] = await t.db.insert(projectDecisions).values(decision() as typeof projectDecisions.$inferInsert).returning();
    await t.db.execute(`select product_doc_enqueue('${projectId}', 'decision', '${d!.id}')`);
    expect(await jobsOf(projectId)).toHaveLength(1);
  });
});

describe("migrazione 0210: segni, revisioni e commenti", () => {
  it("una revisione `claude` vuole la fonte e `via`; un segno sta su una revisione; una risposta solo a una domanda", async () => {
    const page = await withPage();
    const base = { pageId: page.id, seq: 1, lastSeq: 1 };
    await expect(t.db.insert(productPageRevisions).values({ ...base, kind: "claude" })).rejects.toThrow();
    const [rev] = await t.db.insert(productPageRevisions).values({ ...base, kind: "claude", sourceKind: "email", sourceId: randomUUID(), via: "claude" }).returning();
    await t.db.insert(productPageRevisions).values({ ...base, seq: 2, lastSeq: 2, kind: "undo" });
    const [mark] = await t.db.insert(productClaudeMarks).values({ revisionId: rev!.id, pageId: page.id, anchorId: "blk-1", sourceKind: "email", sourceId: randomUUID() }).returning();
    expect(mark!.status).toBe("open");
    await expect(t.db.insert(productComments).values({ pageId: page.id, anchorId: "blk-1", quote: "q", body: "", answer: { option: "keep" } })).rejects.toThrow();
    await t.db.insert(productComments).values({ pageId: page.id, anchorId: "blk-1", quote: "q", body: "", question: { reason: "vague" }, answer: { option: "keep" } });
    const marks = await t.db.select().from(productClaudeMarks).where(and(eq(productClaudeMarks.pageId, page.id)));
    expect(marks).toHaveLength(1);
  });

  it("il journal: 0209 e 0210 in fila, `when` crescente", () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0209_product_section_holds");
    expect(tags.slice(i, i + 2)).toEqual(["0209_product_section_holds", "0210_product_doc_jobs"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
  });
});
