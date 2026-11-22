import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { changeLog, issueChatToolToken, projects, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { createSession, findSessionUser } from "../auth/session.js";
import { patchProject } from "../services/project-patch.js";
import { undoGroup } from "./undo.js";
import { addMember, seedUsers } from "../test/fixtures.js";

/**
 * «Annulla» di Claude, i Minor della review di F7 (registro dei rimandi, area 9):
 * - la guardia `changed_after` blocca la riga del soggetto: un salvataggio a
 *   mano in corso finisce prima, e la sua voce si vede;
 * - lo `stamp` è l'istante a FINE scrittura e le voci hanno quello del loro
 *   inserimento: un salvataggio a mano iniziato PRIMA dell'azione ma arrivato
 *   dopo si vede;
 * - `updateProjectGeneral` accetta ciò che la rotta accetta (niente massimi):
 *   l'inverso di un nome lungo passa;
 * - una posizione a mano di un account AI scrive `provider.reordered`.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminCookie: string;
let n = 0;
const admin = () => ({ id: adminId, email: "admin@example.com" });

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), encryptionKey: randomBytes(32).toString("base64"), publicUrl: "https://stubwise.example" });
  ({ adminId, adminCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

async function run(actions: unknown[]) {
  const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: adminCookie }, payload: {} });
  const sid = (res.json() as { id: string }).id;
  const tok = await issueChatToolToken(t.db, { sessionId: sid, userId: adminId, ttlMs: 60_000 });
  const proposed = await app.inject({ method: "POST", url: `/api/claude/conversations/${sid}/proposals`, headers: { authorization: `Bearer ${tok}` }, payload: { toolUseId: `tu-um-${++n}`, actions } });
  const body = proposed.json() as { status: string; proposalId?: string };
  expect(body.status, proposed.body).toBe("awaiting_confirmation");
  const done = await app.inject({ method: "POST", url: `/api/claude/proposals/${body.proposalId}/confirm`, headers: { cookie: adminCookie }, payload: {} });
  expect(done.statusCode, done.body).toBe(200);
  return (done.json() as { groupId: string }).groupId;
}
const undo = (groupId: string) => app.inject({ method: "POST", url: `/api/claude/groups/${groupId}/undo`, headers: { cookie: adminCookie } });
const nameOf = async (projectId: string) => (await t.db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)))[0]!.name;
async function project() {
  const { projectId } = await seedRepository(t.db);
  await addMember(app, projectId, adminId, "project_lead");
  return projectId;
}
async function untilSomeoneWaits() {
  for (let i = 0; i < 200; i++) {
    const [row] = (await t.db.execute(sql`select count(*)::int as n from pg_locks where not granted`)) as unknown as { n: number }[];
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("nessuno in coda su un lock");
}
/** Una transazione «a mano» tenuta aperta: `step` gira dentro, poi aspetta `release`. */
function heldTransaction(step: (tx: Db) => Promise<void>) {
  let ready!: () => void;
  const started = new Promise<void>((r) => (ready = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const done = t.db.transaction(async (txRaw) => {
    await step(txRaw as unknown as Db);
    ready();
    await gate;
  });
  return { started, release, done };
}

describe("«Annulla» di Claude: i Minor della review di F7", () => {
  it("la guardia blocca la riga: un salvataggio a mano in corso finisce prima, e «Annulla» è `changed_after`", async () => {
    const projectId = await project();
    const groupId = await run([{ fn: "updateProjectGeneral", args: { projectId, name: "Da Claude" } }]);
    // A mano: il nome cambia (riga bloccata, voce scritta) ma il commit aspetta.
    const manual = heldTransaction(async (tx) => {
      expect((await patchProject(tx, admin(), projectId, { name: "A mano" })).ok).toBe(true);
    });
    await manual.started;
    // «Annulla» confermato (la scheda già confermata): niente prova a secco, si va dritti alla guardia.
    const session = await createSession(t.db, adminId, { stage: "full", secondFactorAt: new Date() });
    const user = (await findSessionUser(t.db, session.id))!;
    const undoing = undoGroup(t.db, user, groupId, { confirmed: true });
    await untilSomeoneWaits();
    manual.release();
    await manual.done;
    expect(await undoing).toEqual({ ok: false, error: "changed_after" });
    expect(await nameOf(projectId)).toBe("A mano");
  });

  it("lo `stamp` a fine scrittura: un salvataggio a mano iniziato PRIMA di Claude ma arrivato dopo blocca «Annulla»", async () => {
    const projectId = await project();
    // La transazione a mano comincia (il suo `now()` è adesso) e non scrive ancora.
    let begun!: () => void;
    const began = new Promise<void>((r) => (begun = r));
    let go!: () => void;
    const write = new Promise<void>((r) => (go = r));
    const manual = t.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.execute(sql`select now()`);
      begun();
      await write;
      expect((await patchProject(tx, admin(), projectId, { name: "A mano dopo" })).ok).toBe(true);
    });
    await began;
    await new Promise((r) => setTimeout(r, 20));
    const groupId = await run([{ fn: "updateProjectGeneral", args: { projectId, name: "Da Claude" } }]);
    go();
    await manual;
    expect(await nameOf(projectId)).toBe("A mano dopo");
    const res = await undo(groupId);
    expect([res.statusCode, (res.json() as { code?: string }).code]).toEqual([409, "changed_after"]);
    expect(await nameOf(projectId)).toBe("A mano dopo");
  });

  it("le voci delle altre azioni dello stesso gruppo non bloccano «Annulla»", async () => {
    const projectId = await project();
    const groupId = await run([
      { fn: "updateProjectGeneral", args: { projectId, name: "Uno" } },
      { fn: "updateProjectGeneral", args: { projectId, name: "Due" } },
    ]);
    const before = await t.db.select().from(changeLog).where(and(eq(changeLog.projectId, projectId), eq(changeLog.type, "project.renamed")));
    expect(before).toHaveLength(2);
    expect((await undo(groupId)).statusCode).toBe(200);
  });

  it("`updateProjectGeneral` senza i massimi della rotta: l'inverso di un nome e di una descrizione lunghi passa", async () => {
    const projectId = await project();
    const longName = "N".repeat(250);
    const longDescription = "D".repeat(2500);
    expect((await app.inject({ method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie: adminCookie }, payload: { name: longName, description: longDescription } })).statusCode).toBe(200);
    const groupId = await run([{ fn: "updateProjectGeneral", args: { projectId, name: "Breve", description: "Corta" } }]);
    expect(await nameOf(projectId)).toBe("Breve");
    const res = await undo(groupId);
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await t.db.select({ name: projects.name, description: projects.description }).from(projects).where(eq(projects.id, projectId));
    expect(row).toEqual({ name: longName, description: longDescription });
  });

  it("una posizione a mano (`PATCH /api/ai-providers/:id`) scrive `provider.reordered`, e «Annulla» di moveProvider la vede", async () => {
    const mk = async (label: string) => ((await app.inject({ method: "POST", url: "/api/ai-providers", headers: { cookie: adminCookie }, payload: { kind: "api_key", label, secret: "sk-ant-xxxxxxxx" } })).json() as { id: string }).id;
    const a = await mk("Alfa");
    const b = await mk("Beta");
    const groupId = await run([{ fn: "moveProvider", args: { id: b, toIndex: 0 } }]);
    const reordered = async () => (await t.db.select().from(changeLog).where(eq(changeLog.type, "provider.reordered"))).length;
    const count = await reordered();
    // A mano: Alfa torna prima (posizione sotto quella di Beta).
    expect((await app.inject({ method: "PATCH", url: `/api/ai-providers/${a}`, headers: { cookie: adminCookie }, payload: { position: -1 } })).statusCode).toBe(200);
    expect(await reordered()).toBe(count + 1);
    const res = await undo(groupId);
    expect([res.statusCode, (res.json() as { code?: string }).code]).toEqual([409, "changed_after"]);
    // Una posizione che non cambia l'ordine non scrive.
    expect((await app.inject({ method: "PATCH", url: `/api/ai-providers/${a}`, headers: { cookie: adminCookie }, payload: { position: -2 } })).statusCode).toBe(200);
    expect(await reordered()).toBe(count + 1);
  });
});
