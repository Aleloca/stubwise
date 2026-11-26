import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { changeLog, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forbiddenChangeLogKeys, forbiddenKeysIn, recordChange } from "./change-log.js";

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

const WRITER_FILE = join(import.meta.dirname, "change-log.ts");

/**
 * Gli helper che COSTRUISCONO oggetto e `params` fuori dalla chiamata (review
 * di F2, m6): il controllo dentro `recordChange(...)` non li vedrebbe.
 */
const HELPERS: [file: string, name: string][] = [
  ["services/invite-change.ts", "inviteObject"],
  ["services/invite-change.ts", "inviteParams"],
  ["services/change-log.ts", "personObject"],
  ["services/roles.ts", "memberObject"],
  ["routes/departments.ts", "peopleParams"],
  ["services/instance-settings-writes.ts", "recordInstanceChanges"],
];

/**
 * Il corpo di un helper, SENZA la lista dei parametri (un parametro `token`
 * che l'helper riceve per derivarne l'id opaco non è una chiave della voce):
 * da dopo la parentesi che chiude i parametri alla riga vuota o alla graffa di
 * chiusura.
 */
function helperBody(source: string, name: string): string {
  const start = source.search(new RegExp(`(function ${name}\\(|const ${name} =)`));
  if (start === -1) throw new Error(`helper ${name} non trovato: aggiorna HELPERS`);
  let i = source.indexOf("(", start);
  for (let depth = 0; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) break;
  }
  const end = source.indexOf("\n}\n", i);
  const blank = source.indexOf("\n\n", i);
  return source.slice(i + 1, Math.min(...[end, blank].filter((x) => x !== -1)));
}

/** I moduli del server che scrivono nel registro: si trovano, così uno nuovo è coperto senza toccare il test. */
function writers(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...writers(path));
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && path !== WRITER_FILE && readFileSync(path, "utf8").includes("recordChange(")) out.push(path);
  }
  return out;
}

describe("un segreto non entra nel registro (a runtime, revisione del lotto 5, I1)", () => {
  const hook = () => ({ type: "webhook", id: randomUUID(), label: "W" });

  it("un prima/dopo costruito da un helper con una chiave dall'aria segreta è un errore, non una voce", async () => {
    const actor = await person();
    for (const key of ["webhookSecret", "token", "dsn", "apiKey"]) {
      await expect(
        recordChange(db, { type: "webhook.updated", actor, projectId: null, data: { object: hook(), before: JSON.stringify({ [key]: "a" }), after: JSON.stringify({ [key]: "b" }) } }),
        key,
      ).rejects.toThrow(/segreto/);
    }
    // `keyLast4` e `accessKeyId` restano le eccezioni dichiarate.
    await recordChange(db, { type: "webhook.updated", actor, projectId: null, data: { object: hook(), before: JSON.stringify({ keyLast4: "1234" }), after: JSON.stringify({ keyLast4: "5678" }) } });
  });

  it("le credenziali dentro un URL (user:pass@) si mascherano, in prima/dopo e nei params", async () => {
    const actor = await person();
    const object = hook();
    await recordChange(db, {
      type: "webhook.updated",
      actor,
      projectId: null,
      data: { object, before: JSON.stringify({ url: "https://bob:s3cr3t@git.example.com/r.git" }), after: JSON.stringify({ url: "https://git.example.com/r.git" }) },
    });
    const [row] = await db.select().from(changeLog).where(eq(changeLog.subjectId, object.id));
    expect(JSON.stringify(row!.data)).not.toContain("s3cr3t");
    expect(JSON.parse((row!.data as { before: string }).before)).toEqual({ url: "https://bob:***@git.example.com/r.git" });
  });
});

describe("un segreto non entra nel registro (test di sorgente)", () => {
  it("il controllo prende una chiave proibita (e lascia passare `keyLast4`)", () => {
    expect(forbiddenChangeLogKeys(`recordChange(tx, { type: "x", data: { object, params: { tokenHash: h, keyLast4: k } } })`)).toEqual(["tokenHash"]);
    expect(forbiddenChangeLogKeys(`recordChange(tx, { data: { params: { webhookSecret: s } } })`)).toEqual(["webhookSecret"]);
    expect(forbiddenChangeLogKeys(`recordChange(tx, { data: { object, params: { role: r, keyLast4: k } } })`)).toEqual([]);
    // L'id della chiave d'accesso S3 è un'eccezione dichiarata; la chiave segreta no.
    expect(forbiddenKeysIn("const f = { accessKeyId: a, secretAccessKey: s }")).toEqual(["secretAccessKey"]);
  });

  it("nemmeno gli helper che costruiscono oggetto e params", () => {
    const root = join(import.meta.dirname, "..");
    for (const [file, name] of HELPERS) {
      expect(forbiddenKeysIn(helperBody(readFileSync(join(root, file), "utf8"), name)), `${file}#${name}`).toEqual([]);
    }
    expect(forbiddenKeysIn("const x = { inviteToken: t, label: l }")).toEqual(["inviteToken"]);
  });

  it("nessuno scrittore del server passa al registro un campo il cui nome sa di segreto", () => {
    const root = join(import.meta.dirname, "..");
    for (const file of writers(root)) {
      expect(forbiddenChangeLogKeys(readFileSync(file, "utf8")), file).toEqual([]);
    }
  });
});
