import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { changeLog, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forbiddenChangeLogKeys, recordChange } from "./change-log.js";

/** Area 9, F2, Task 3: lo scrittore del registro e il controllo sui segreti. */

let testDb: TestDb;
let db: Db;
beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);
afterAll(async () => {
  await testDb.stop();
});

async function person() {
  const email = `w-${randomUUID().slice(0, 6)}@acme.com`;
  const [u] = await db.insert(users).values({ email, passwordHash: "x", role: "member" }).returning({ id: users.id });
  return { id: u!.id, email };
}
const object = { type: "role", id: randomUUID(), label: "Release manager" };

describe("recordChange", () => {
  it("scrive la voce nella transazione, con l'email dell'attore fissata", async () => {
    const actor = await person();
    await db.transaction(async (tx) => {
      await recordChange(tx, { type: "role.created", actor, projectId: null, data: { object } });
    });
    const [row] = await db.select().from(changeLog).where(eq(changeLog.subjectId, object.id));
    expect(row).toMatchObject({ actorUserId: actor.id, actorEmail: actor.email, actorKind: "user", type: "role.created", subjectKind: "role", projectId: null });
    expect(row!.data).toMatchObject({ object, before: null, after: null, params: {} });
  });

  it("una transazione annullata DOPO la voce non la lascia", async () => {
    const actor = await person();
    const id = randomUUID();
    await expect(
      db.transaction(async (tx) => {
        await recordChange(tx, { type: "role.deleted", actor, projectId: null, data: { object: { ...object, id } } });
        throw new Error("la modifica fallisce dopo");
      }),
    ).rejects.toThrow("la modifica fallisce dopo");
    expect(await db.select().from(changeLog).where(eq(changeLog.subjectId, id))).toHaveLength(0);
  });

  it("un tipo sconosciuto, o un `data` che manca dei suoi `params`, è un errore", async () => {
    const actor = await person();
    await expect(db.transaction((tx) => recordChange(tx, { type: "role.exploded" as never, actor, projectId: null, data: { object } }))).rejects.toThrow();
    // Un progetto vero: così la voce la ferma lo SCHEMA (manca `params.permission`), non l'ambito.
    const { projectId } = await seedRepository(db);
    await expect(db.transaction((tx) => recordChange(tx, { type: "member.permission_granted", actor, projectId, data: { object } }))).rejects.toThrow(/permission/);
    await db.transaction((tx) => recordChange(tx, { type: "member.permission_granted", actor, projectId, data: { object, params: { permission: "release.merge" } } }));
  });

  it("una voce di progetto vuole il progetto, una d'istanza no", async () => {
    const actor = await person();
    await expect(db.transaction((tx) => recordChange(tx, { type: "member.added", actor, projectId: null, data: { object } }))).rejects.toThrow(/projectId/);
    await expect(db.transaction((tx) => recordChange(tx, { type: "role.created", actor, projectId: randomUUID(), data: { object } }))).rejects.toThrow(/projectId/);
  });

  it("il sistema scrive senza attore", async () => {
    const id = randomUUID();
    await db.transaction((tx) => recordChange(tx, { type: "instance.first_admin_created", actor: "system", projectId: null, data: { object: { type: "person", id, label: "Ada" } } }));
    const [row] = await db.select().from(changeLog).where(eq(changeLog.subjectId, id));
    expect(row).toMatchObject({ actorUserId: null, actorKind: "system", actorEmail: "system" });
  });
});

/** I moduli del server che scrivono nel registro: si trovano, così uno nuovo è coperto senza toccare il test. */
function writers(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...writers(path));
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith("change-log.ts") && readFileSync(path, "utf8").includes("recordChange(")) out.push(path);
  }
  return out;
}

describe("un segreto non entra nel registro (test di sorgente)", () => {
  it("il controllo prende una chiave proibita (e lascia passare `keyLast4`)", () => {
    expect(forbiddenChangeLogKeys(`recordChange(tx, { type: "x", data: { object, params: { tokenHash: h, keyLast4: k } } })`)).toEqual(["tokenHash"]);
    expect(forbiddenChangeLogKeys(`recordChange(tx, { data: { params: { webhookSecret: s } } })`)).toEqual(["webhookSecret"]);
    expect(forbiddenChangeLogKeys(`recordChange(tx, { data: { object, params: { role: r, keyLast4: k } } })`)).toEqual([]);
  });

  it("nessuno scrittore del server passa al registro un campo il cui nome sa di segreto", () => {
    const root = join(import.meta.dirname, "..");
    for (const file of writers(root)) {
      expect(forbiddenChangeLogKeys(readFileSync(file, "utf8")), file).toEqual([]);
    }
  });
});
