import { randomUUID } from "node:crypto";
import { emailProposals, instanceSettings, notifications, productComments, productDocJobs, productFirstVersions, productPageRevisions, productPages, projectMembers, projects, roles, users } from "@stubwise/db";
import { seedEmailMessage, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { ProductBlock } from "@stubwise/shared";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRunOptions, AgentRunResult, AgentRunner } from "../agent/runner.js";
import { FIRST_VERSION_CITATION_PREFIX, FIRST_VERSION_FALLBACK } from "./first-version.js";
import { claimProductDocJob, runProductDocJob } from "./job.js";

// Il codice del progetto da un contatore, non a caso: 4 cifre esadecimali a caso
// su un test per `beforeEach` collidevano su `projects_code_unique` (CI di #150).
// Il vincolo è `^[A-Z][A-Z0-9]{1,5}$`: lettera più 5 cifre.
let codeSeq = 0;
const projectCode = () => String(codeSeq++).padStart(5, "0");

/**
 * Area 11, F6 — il lavoro della prima versione col runner finto: la bozza del
 * modello UNA volta, le fonti con la visibilità di chi l'ha chiesta, le pagine
 * una alla volta, solo testo e senza link, la riga che cita le fonti.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function member(projectId: string, name: string) {
  const [u] = await t.db.insert(users).values({ email: `${randomUUID()}@x.it`, passwordHash: "x", role: "member", displayName: name }).returning();
  const [role] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "project_lead"));
  await t.db.insert(projectMembers).values({ projectId, userId: u!.id, roleId: role!.id });
  return u!.id;
}

function fakeRunner(answer: string) {
  const calls: AgentRunOptions[] = [];
  const runner = { async run(opts: AgentRunOptions): Promise<AgentRunResult> { calls.push(opts); return { output: answer, exitCode: 0 }; } } as AgentRunner;
  return { runner, calls };
}
const log = { warn: () => undefined, info: () => undefined };
const p = (text: string, marks: unknown[] = []) => ({ type: "paragraph", content: { text, marks } });
const DRAFT = JSON.stringify({
  pages: [
    { title: "Overview", depth: 0, blocks: [p("Un negozio online.", [{ type: "link", start: 0, end: 3, href: "https://evil.example" }]), { type: "image", src: "product-image:6f1d3c2a-1b2c-4d3e-8f40-516273849501", caption: "", alt: "" }] },
    { title: "Pagamenti", depth: 2, blocks: [p("A 60 giorni.")] },
    { title: "Spedizioni", depth: 0, blocks: [] },
  ],
});

async function setup() {
  const { projectId } = await seedRepository(t.db);
  await t.db.update(projects).set({ code: `F${projectCode()}` }).where(eq(projects.id, projectId));
  const ada = await member(projectId, "Ada");
  const bea = await member(projectId, "Bea");
  const mine = await seedEmailMessage(t.db, { userId: ada, subject: "Oggetto di Ada" });
  const theirs = await seedEmailMessage(t.db, { userId: bea, subject: "Oggetto di Bea" });
  for (const m of [mine, theirs]) await t.db.insert(emailProposals).values({ emailMessageId: m.messageId, projectId, status: "proposed", classification: {} });
  // La riga come la scrive il server; anche l'email di Bea, che Ada non vede (il worker la deve saltare).
  const [fv] = await t.db
    .insert(productFirstVersions)
    .values({ projectId, startedBy: ada, sources: [{ kind: "email", id: mine.messageId }, { kind: "email", id: theirs.messageId }, { kind: "text" }], pastedText: "Le note incollate" })
    .returning();
  await t.db.insert(productDocJobs).values({ projectId, sourceKind: "first_version", sourceId: fv!.id });
  return { projectId, ada, fv: fv!, theirs };
}

const pagesOf = (projectId: string) => t.db.select().from(productPages).where(eq(productPages.projectId, projectId)).orderBy(asc(productPages.createdAt));

describe("la prima versione nel worker", () => {
  it("UNA chiamata; le pagine una alla volta coi livelli giusti; solo testo, senza link; la riga che cita le fonti; il testo incollato non resta", async () => {
    const { projectId, ada, fv, theirs } = await setup();
    const job = (await claimProductDocJob(t.db))!;
    expect(job.sourceId).toBe(fv.id);
    const { runner, calls } = fakeRunner(DRAFT);
    expect(await runProductDocJob({ db: t.db, runner, log }, job)).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("Le note incollate");
    expect(calls[0]!.prompt).toContain("Oggetto di Ada");
    // L'email di un'altra casella non arriva al modello.
    expect(calls[0]!.prompt).not.toContain("Oggetto di Bea");
    void theirs;
    const pages = await pagesOf(projectId);
    expect(pages.map((x) => x.title)).toEqual(["Overview", "Pagamenti", "Spedizioni"]);
    // «Pagamenti» chiedeva depth 2 subito dopo la radice: diventa 1, sotto «Overview».
    expect(pages[1]!.parentId).toBe(pages[0]!.id);
    expect(pages[2]!.parentId).toBeNull();
    const overview = pages[0]!.blocks as ProductBlock[];
    expect((overview[0] as { content: { text: string } }).content.text).toMatch(new RegExp(`^${FIRST_VERSION_CITATION_PREFIX}an email of Ada \\(.+\\) and the pasted notes\\.$`));
    // Mai l'oggetto dell'email nella pagina (la legge tutto il progetto).
    expect(JSON.stringify(pages.map((x) => x.blocks))).not.toContain("Oggetto di Ada");
    expect(overview.some((b) => b.type === "image")).toBe(false);
    expect(JSON.stringify(overview)).not.toContain("evil.example");
    // Una pagina senza blocchi ha la frase di ripiego.
    expect(JSON.stringify(pages[2]!.blocks)).toContain("don't say anything about this yet");
    const revs = await t.db.select().from(productPageRevisions).where(eq(productPageRevisions.pageId, pages[0]!.id));
    expect(revs).toEqual([expect.objectContaining({ kind: "first_version", via: "claude", onBehalfOf: ada })]);
    const [row] = await t.db.select().from(productFirstVersions).where(eq(productFirstVersions.id, fv.id));
    expect(row).toMatchObject({ status: "done", interrupted: false, pastedText: null });
    expect(row!.written).toHaveLength(3);
  });

  it("un dubbio della bozza: la frase di ripiego nella pagina, con una domanda `vague` di Claude sopra, senza card", async () => {
    const { projectId, fv } = await setup();
    const draft = JSON.stringify({
      pages: [{ title: "Overview", depth: 0, blocks: [p("Un negozio.")], doubts: [{ text: "Forse i pagamenti a 60 giorni.", request: { title: "Chiarire i pagamenti", description: "Il cliente non ha deciso" } }] }],
    });
    const job = (await claimProductDocJob(t.db))!;
    expect(await runProductDocJob({ db: t.db, runner: fakeRunner(draft).runner, log }, job)).toBe("done");
    const [page] = await pagesOf(projectId);
    const blocks = page!.blocks as { id: string; content?: { text: string } }[];
    const fallback = blocks.find((b) => b.content?.text === FIRST_VERSION_FALLBACK)!;
    expect(fallback).toBeDefined();
    // Il dubbio non è scritto come fatto nella pagina.
    expect(JSON.stringify(blocks)).not.toContain("60 giorni");
    const comments = await t.db.select().from(productComments).where(eq(productComments.pageId, page!.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ anchorId: fallback.id, body: "", quote: FIRST_VERSION_FALLBACK });
    expect(comments[0]!.question).toMatchObject({
      reason: "vague",
      sourceRef: { kind: "first_version" },
      apply: { text: "Forse i pagamenti a 60 giorni." },
      request: { title: "Chiarire i pagamenti" },
      recommended: "keep",
    });
    // Senza card: è un gesto di chi l'ha chiesta, che segue già le pagine.
    expect(await t.db.select().from(notifications).where(eq(notifications.kind, "product_doc.question"))).toEqual([]);
    void fv;
  });

  it("un lavoro ripreso non richiama il modello e riparte dalla pagina dopo", async () => {
    const { projectId, fv } = await setup();
    const draft = [{ title: "Uno", depth: 0, blocks: [p("a")] }, { title: "Due", depth: 0, blocks: [p("b")] }];
    await t.db.update(productFirstVersions).set({ draft, plan: draft.map((d) => ({ title: d.title, depth: d.depth })) }).where(eq(productFirstVersions.id, fv.id));
    const { writeFirstVersionPage } = await import("@stubwise/notifications");
    await writeFirstVersionPage(t.db, fv.id, 0);
    const job = (await claimProductDocJob(t.db))!;
    const { runner, calls } = fakeRunner(DRAFT);
    expect(await runProductDocJob({ db: t.db, runner, log }, job)).toBe("done");
    expect(calls).toEqual([]);
    expect((await pagesOf(projectId)).map((x) => x.title)).toEqual(["Uno", "Due"]);
  });

  it("una risposta che non è una bozza: la prima versione finisce interrotta, col motivo, e nessuna pagina", async () => {
    const { projectId, fv } = await setup();
    const job = (await claimProductDocJob(t.db))!;
    expect(await runProductDocJob({ db: t.db, runner: fakeRunner("Ecco la tua documentazione!").runner, log }, job)).toBe("failed");
    expect((await t.db.select().from(productFirstVersions).where(eq(productFirstVersions.id, fv.id)))[0]).toMatchObject({ status: "done", interrupted: true, error: "invalid_answer", pastedText: null });
    expect(await pagesOf(projectId)).toEqual([]);
  });

  it("«Stop» prima della bozza (il lavoro in coda o fermo per il limite): il modello non si chiama, la prima versione finisce interrotta e senza pagine", async () => {
    const { projectId, fv } = await setup();
    await t.db.update(productFirstVersions).set({ stopRequested: true }).where(eq(productFirstVersions.id, fv.id));
    const job = (await claimProductDocJob(t.db))!;
    expect(job.sourceId).toBe(fv.id);
    const { runner, calls } = fakeRunner(DRAFT);
    expect(await runProductDocJob({ db: t.db, runner, log }, job)).toBe("done");
    expect(calls).toEqual([]);
    expect((await t.db.select().from(productFirstVersions).where(eq(productFirstVersions.id, fv.id)))[0]).toMatchObject({ status: "done", interrupted: true, error: null, pastedText: null });
    expect(await pagesOf(projectId)).toEqual([]);
  });

  it("revisione del lotto 1: col modulo Docs spento la prima versione finisce interrotta col motivo, senza modello né pagine", async () => {
    const { projectId, fv } = await setup();
    const job = (await claimProductDocJob(t.db))!;
    expect(job.sourceId).toBe(fv.id);
    await t.db.update(projects).set({ modules: ["releases"] }).where(eq(projects.id, projectId));
    const { runner, calls } = fakeRunner(DRAFT);
    expect(await runProductDocJob({ db: t.db, runner, log }, job)).toBe("done");
    expect(calls).toEqual([]);
    expect((await t.db.select().from(productFirstVersions).where(eq(productFirstVersions.id, fv.id)))[0]).toMatchObject({ status: "done", interrupted: true, error: "docs_module_off" });
    expect(await pagesOf(projectId)).toEqual([]);
  });

  it("«Stop» col budget del mese finito (revisione, I1): la prima versione si chiude interrotta, non resta `stopping` fino al budget nuovo", async () => {
    const { projectId, fv } = await setup();
    await t.db.update(productFirstVersions).set({ stopRequested: true }).where(eq(productFirstVersions.id, fv.id));
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "1" } });
    try {
      const job = (await claimProductDocJob(t.db))!;
      const { runner, calls } = fakeRunner(DRAFT);
      expect(await runProductDocJob({ db: t.db, runner, log, monthlyCostUsdFn: async () => 5 }, job)).toBe("done");
      expect(calls).toEqual([]);
      expect((await t.db.select().from(productFirstVersions).where(eq(productFirstVersions.id, fv.id)))[0]).toMatchObject({ status: "done", interrupted: true });
      expect(await pagesOf(projectId)).toEqual([]);
    } finally {
      await t.db.delete(instanceSettings);
    }
  });

  it("«Stop» mentre il lavoro gira, prima della sosta per il budget (revisione, M3): la sosta rilegge lo stop e la prima versione si chiude interrotta, non resta `stopping` fino al prossimo giro", async () => {
    const { projectId, fv } = await setup();
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "1" } });
    try {
      const job = (await claimProductDocJob(t.db))!;
      expect(job.sourceId).toBe(fv.id);
      const { runner, calls } = fakeRunner(DRAFT);
      // Lo «Stop» arriva DOPO la lettura della riga e prima della sosta: il server vede il lavoro `running` e segna solo lo stop.
      const monthlyCostUsdFn = async () => {
        await t.db.update(productFirstVersions).set({ stopRequested: true }).where(eq(productFirstVersions.id, fv.id));
        return 5;
      };
      expect(await runProductDocJob({ db: t.db, runner, log, monthlyCostUsdFn }, job)).toBe("done");
      expect(calls).toEqual([]);
      expect((await t.db.select().from(productDocJobs).where(eq(productDocJobs.id, job.id)))[0]).toMatchObject({ status: "done", heldReason: null });
      expect((await t.db.select().from(productFirstVersions).where(eq(productFirstVersions.id, fv.id)))[0]).toMatchObject({ status: "done", interrupted: true, pastedText: null });
      expect(await pagesOf(projectId)).toEqual([]);
    } finally {
      await t.db.delete(instanceSettings);
    }
  });

  it("«Stop» mentre il lavoro gira, prima della sosta per il limite dei provider (revisione, M3): anche questa sosta rilegge lo stop", async () => {
    const { projectId, fv } = await setup();
    const job = (await claimProductDocJob(t.db))!;
    expect(job.sourceId).toBe(fv.id);
    const { runner, calls } = fakeRunner(DRAFT);
    const select = {
      db: t.db,
      encryptionKey: Buffer.alloc(32),
      backgroundWeeklyThreshold: 0.8,
      // Lo «Stop» arriva mentre si scelgono i provider, e nessuno è disponibile.
      selectProvidersFn: async () => {
        await t.db.update(productFirstVersions).set({ stopRequested: true }).where(eq(productFirstVersions.id, fv.id));
        return { candidates: [], legacyAuth: false, emptyReason: null };
      },
    };
    expect(await runProductDocJob({ db: t.db, runner, log, select }, job)).toBe("done");
    expect(calls).toEqual([]);
    expect((await t.db.select().from(productDocJobs).where(eq(productDocJobs.id, job.id)))[0]).toMatchObject({ status: "done", heldReason: null });
    expect((await t.db.select().from(productFirstVersions).where(eq(productFirstVersions.id, fv.id)))[0]).toMatchObject({ status: "done", interrupted: true });
    expect(await pagesOf(projectId)).toEqual([]);
  });

  it("col budget finito una bozza GIÀ pronta scrive le sue pagine (non chiamano il modello); senza bozza il lavoro aspetta col budget", async () => {
    const ready = await setup();
    const draft = [{ title: "Uno", depth: 0, blocks: [p("a")] }, { title: "Due", depth: 0, blocks: [p("b")] }];
    await t.db.update(productFirstVersions).set({ draft, plan: draft.map((d) => ({ title: d.title, depth: d.depth })) }).where(eq(productFirstVersions.id, ready.fv.id));
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "1" } });
    try {
      const job = (await claimProductDocJob(t.db))!;
      expect(job.sourceId).toBe(ready.fv.id);
      const { runner, calls } = fakeRunner(DRAFT);
      expect(await runProductDocJob({ db: t.db, runner, log, monthlyCostUsdFn: async () => 5 }, job)).toBe("done");
      expect(calls).toEqual([]);
      expect((await pagesOf(ready.projectId)).map((x) => x.title)).toEqual(["Uno", "Due"]);
      // Senza bozza: il modello servirebbe, quindi il lavoro aspetta.
      const fresh = await setup();
      const job2 = (await claimProductDocJob(t.db))!;
      expect(job2.sourceId).toBe(fresh.fv.id);
      const second = fakeRunner(DRAFT);
      expect(await runProductDocJob({ db: t.db, runner: second.runner, log, monthlyCostUsdFn: async () => 5 }, job2)).toBe("held");
      expect(second.calls).toEqual([]);
      expect((await t.db.select().from(productDocJobs).where(eq(productDocJobs.id, job2.id)))[0]).toMatchObject({ status: "held", heldReason: "budget" });
    } finally {
      await t.db.delete(instanceSettings);
    }
  });

  it("D-7.1 (review del lotto 4, I-1): col budget finito un lavoro chiesto da chi lo scavalca (`budget_bypass`) chiama il modello; il claim «solo scavalco» salta gli altri", async () => {
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "1" } });
    try {
      const plain = await setup();
      const bypassed = await setup();
      await t.db.update(productDocJobs).set({ budgetBypass: true }).where(eq(productDocJobs.sourceId, bypassed.fv.id));
      const job = (await claimProductDocJob(t.db, [], { onlyBypass: true }))!;
      expect(job.sourceId).toBe(bypassed.fv.id);
      expect(await claimProductDocJob(t.db, [], { onlyBypass: true })).toBeNull();
      const { runner, calls } = fakeRunner(DRAFT);
      expect(await runProductDocJob({ db: t.db, runner, log, monthlyCostUsdFn: async () => 5 }, job)).not.toBe("held");
      expect(calls.length).toBeGreaterThan(0);
      // L'altro resta in coda: lo prende il claim normale, e aspetta col budget.
      const other = (await claimProductDocJob(t.db))!;
      expect(other.sourceId).toBe(plain.fv.id);
    } finally {
      await t.db.delete(instanceSettings);
    }
  });

  it("review del lotto 5 (decisione di 46): lo scavalco si RILEGGE quando il lavoro parte — chi l'ha chiesto ha perso plans.approve, e il lavoro torna ad aspettare col budget", async () => {
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "1" } });
    try {
      const { projectId, ada, fv } = await setup();
      await t.db.update(productDocJobs).set({ budgetBypass: true }).where(eq(productDocJobs.sourceId, fv.id));
      // Ada era Project Lead alla richiesta; ora è Developer (niente plans.approve).
      const [dev] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer"));
      await t.db.update(projectMembers).set({ roleId: dev!.id }).where(eq(projectMembers.userId, ada));
      const job = (await claimProductDocJob(t.db, [], { onlyBypass: true }))!;
      expect(job.sourceId).toBe(fv.id);
      const { runner, calls } = fakeRunner(DRAFT);
      expect(await runProductDocJob({ db: t.db, runner, log, monthlyCostUsdFn: async () => 5 }, job)).toBe("held");
      expect(calls).toEqual([]);
      void projectId;
    } finally {
      await t.db.delete(instanceSettings);
    }
  });

  it("la pausa della coda non ferma la prima versione (è un gesto di chi l'ha chiesta)", async () => {
    const { projectId, fv } = await setup();
    await t.db.update(projects).set({ queuePausedAt: new Date() }).where(eq(projects.id, projectId));
    const job = await claimProductDocJob(t.db);
    expect(job?.sourceId).toBe(fv.id);
    expect(await runProductDocJob({ db: t.db, runner: fakeRunner(DRAFT).runner, log }, job!)).toBe("done");
  });
});
