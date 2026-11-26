import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notifications, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { listInbox } from "./inbox.js";

/**
 * Registro, A11 r.1414: nelle card dell'inbox chi legge non riceve l'id di chi
 * non conosce né di un progetto che non vede. Lo sconosciuto è VERO: nessun
 * progetto in comune, nessun canale, nessun messaggio.
 */
let t: TestDb;
let db: Db;
beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
}, 120_000);
afterAll(async () => {
  await t.stop();
});

const person = async (prefix: string) =>
  (await db.insert(users).values({ email: `${prefix}-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member" }).returning({ id: users.id }))[0]!.id;

describe("le card dell'inbox senza gli sconosciuti", () => {
  it("la proposta della posta (l'unica card che resta a chi non vede il progetto) gestita da uno sconosciuto: `hidden-<n>` senza email, `hidden-project-<n>`", async () => {
    const reader = await person("reader");
    const stranger = await person("stranger");
    const { projectId } = await seedRepository(db);
    const event = { kind: "google.proposal", proposalId: randomUUID(), projectName: "Altrove", subject: "Un'email", options: [] };
    for (let i = 0; i < 2; i++) {
      await db.insert(notifications).values({ userId: reader, kind: "google.proposal", event, projectId, status: "handled", handledAt: new Date(), handledByUserId: stranger } as never);
    }
    const { items } = await listInbox(db, { userId: reader, lang: "en", status: "handled" });
    expect(items).toHaveLength(2);
    for (const i of items) {
      expect(i.projectId).toBe("hidden-project-1");
      expect(i.handledBy).toEqual({ id: "hidden-1", email: "" });
    }
    const raw = JSON.stringify(items);
    expect(raw).not.toContain(stranger);
    expect(raw).not.toContain(projectId);
  });
});
