import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { projectFollows, users } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

/**
 * Test di `/api/me/follows` e `/api/me/notification-prefs`: le preferenze
 * PERSONALI dell'utente autenticato. Il punto delicato è l'isolamento — ogni
 * utente vede e scrive solo le proprie righe — e la sostituzione atomica
 * dell'insieme dei progetti seguiti.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let seeded: SeededUsers;
let projectA: string;
let projectB: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({
    db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  seeded = await seedUsers(app);
  ({ projectId: projectA } = await seedRepository(db));
  ({ projectId: projectB } = await seedRepository(db));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  await db.delete(projectFollows);
});

function getFollows(cookie = seeded.adminCookie) {
  return app.inject({ method: "GET", url: "/api/me/follows", headers: { cookie } });
}

function putFollows(projectIds: string[], cookie = seeded.adminCookie) {
  return app.inject({
    method: "PUT",
    url: "/api/me/follows",
    headers: { cookie },
    payload: { projectIds },
  });
}

function getPrefs(cookie = seeded.adminCookie) {
  return app.inject({ method: "GET", url: "/api/me/notification-prefs", headers: { cookie } });
}

/** Il PUT è una PATCH: si mandano i campi da cambiare, non l'insieme intero. */
function putPrefs(
  prefs: { slackDm?: boolean; push?: boolean },
  cookie = seeded.adminCookie,
) {
  return app.inject({
    method: "PUT",
    url: "/api/me/notification-prefs",
    headers: { cookie },
    payload: prefs,
  });
}

describe("autenticazione", () => {
  it("tutte le rotte /api/me rispondono 401 senza sessione", async () => {
    const calls = [
      app.inject({ method: "GET", url: "/api/me/follows" }),
      app.inject({ method: "PUT", url: "/api/me/follows", payload: { projectIds: [] } }),
      app.inject({ method: "GET", url: "/api/me/notification-prefs" }),
      app.inject({
        method: "PUT",
        url: "/api/me/notification-prefs",
        payload: { slackDm: true, push: true },
      }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("/api/me/follows", () => {
  it("parte da un insieme vuoto", async () => {
    const res = await getFollows();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projectIds: [] });
  });

  it("PUT sostituisce l'insieme (non aggiunge)", async () => {
    expect((await putFollows([projectA, projectB])).statusCode).toBe(204);
    expect(((await getFollows()).json() as { projectIds: string[] }).projectIds.sort()).toEqual(
      [projectA, projectB].sort(),
    );

    expect((await putFollows([projectB])).statusCode).toBe(204);
    expect((await getFollows()).json()).toEqual({ projectIds: [projectB] });

    expect((await putFollows([])).statusCode).toBe(204);
    expect((await getFollows()).json()).toEqual({ projectIds: [] });
  });

  it("è idempotente e tollera i duplicati nel payload", async () => {
    expect((await putFollows([projectA, projectA])).statusCode).toBe(204);
    expect((await getFollows()).json()).toEqual({ projectIds: [projectA] });
    expect((await putFollows([projectA])).statusCode).toBe(204);
    expect((await getFollows()).json()).toEqual({ projectIds: [projectA] });
  });

  it("400 unknown_project su un progetto inesistente, senza scrivere nulla", async () => {
    await putFollows([projectA]);
    const res = await putFollows([projectA, randomUUID()]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "unknown_project" });
    // L'insieme precedente resta intatto: la sostituzione è tutto-o-niente.
    expect((await getFollows()).json()).toEqual({ projectIds: [projectA] });
  });

  it("rifiuta un id non-uuid", async () => {
    const res = await putFollows(["non-un-uuid"]);
    expect(res.statusCode).toBe(400);
  });

  it("i follow di un utente non si vedono dall'altro", async () => {
    await putFollows([projectA], seeded.adminCookie);
    await putFollows([projectB], seeded.memberCookie);
    expect((await getFollows(seeded.adminCookie)).json()).toEqual({ projectIds: [projectA] });
    expect((await getFollows(seeded.memberCookie)).json()).toEqual({ projectIds: [projectB] });
    // La sostituzione dell'admin non tocca le righe del member.
    await putFollows([], seeded.adminCookie);
    expect((await getFollows(seeded.memberCookie)).json()).toEqual({ projectIds: [projectB] });
  });
});

describe("/api/me/notification-prefs", () => {
  it("GET: default acceso, ma senza identità Slack collegata", async () => {
    const res = await getPrefs();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ slackDm: true, push: true, slackLinked: false });
  });

  it("PUT aggiorna i toggle e non tocca gli altri utenti", async () => {
    expect((await putPrefs({ slackDm: false, push: false })).statusCode).toBe(204);
    expect((await getPrefs()).json()).toMatchObject({ slackDm: false, push: false });
    expect((await getPrefs(seeded.memberCookie)).json()).toMatchObject({
      slackDm: true,
      push: true,
    });

    expect((await putPrefs({ slackDm: true, push: true })).statusCode).toBe(204);
    expect((await getPrefs()).json()).toMatchObject({ slackDm: true, push: true });
  });

  it("PATCH: un body col solo slackDm non azzera push", async () => {
    // È la proprietà che rende sicuro aggiungere un canale: un client vecchio
    // manda solo i campi che conosceva e non spegne quelli che ignora.
    expect((await putPrefs({ slackDm: true, push: true })).statusCode).toBe(204);
    expect((await putPrefs({ slackDm: false })).statusCode).toBe(204);
    expect((await getPrefs()).json()).toMatchObject({ slackDm: false, push: true });
  });

  it("PATCH: un body col solo push non azzera slackDm", async () => {
    expect((await putPrefs({ slackDm: true, push: true })).statusCode).toBe(204);
    expect((await putPrefs({ push: false })).statusCode).toBe(204);
    expect((await getPrefs()).json()).toMatchObject({ slackDm: true, push: false });
  });

  it("PATCH: un body vuoto è un no-op da 204, non un 400", async () => {
    expect((await putPrefs({ slackDm: false, push: false })).statusCode).toBe(204);
    expect((await putPrefs({})).statusCode).toBe(204);
    expect((await getPrefs()).json()).toMatchObject({ slackDm: false, push: false });
  });

  it("slackLinked segue users.slack_user_id", async () => {
    await db
      .update(users)
      .set({ slackUserId: `U${randomUUID().replace(/-/g, "").slice(0, 8)}` })
      .where(eq(users.id, seeded.adminId));
    expect((await getPrefs()).json()).toMatchObject({ slackLinked: true });
    await db.update(users).set({ slackUserId: null }).where(eq(users.id, seeded.adminId));
    expect((await getPrefs()).json()).toMatchObject({ slackLinked: false });
  });

  it("rifiuta un campo sconosciuto: un typo non deve passare per successo", async () => {
    // Il gemello del test qui sopra, e i due vanno letti insieme: `{}` è 204
    // perché una patch vuota è legittima, ma `{ pussh: false }` NON deve
    // finire nello stesso 204 — con tutti i campi opzionali lo strip lo
    // ridurrebbe a `{}` e il client crederebbe di aver salvato. Da qui lo
    // `.strict()` sul solo schema di update.
    const res = await app.inject({
      method: "PUT",
      url: "/api/me/notification-prefs",
      headers: { cookie: seeded.adminCookie },
      payload: { pussh: false },
    });
    expect(res.statusCode).toBe(400);
    // Il nome sbagliato dev'essere NEL messaggio: è l'informazione che serve a
    // chi ha fatto il typo, e senza di essa il 400 è solo un muro.
    expect(JSON.stringify(res.json())).toContain("pussh");
  });

  it("rifiuta un campo presente col tipo sbagliato", async () => {
    // Opzionale non vuol dire libero: se il campo c'è, deve essere un boolean.
    const res = await app.inject({
      method: "PUT",
      url: "/api/me/notification-prefs",
      headers: { cookie: seeded.adminCookie },
      payload: { slackDm: "si" },
    });
    expect(res.statusCode).toBe(400);
  });
});
