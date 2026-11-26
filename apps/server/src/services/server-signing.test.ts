import { randomBytes, createPublicKey, verify } from "node:crypto";
import { instanceSigningKeys } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { canonicalCommandPayload, type ServerCommandPayload } from "@stubwise/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commandPublicKey, signCommand } from "./server-signing.js";

/**
 * Area 8, F4b, S2: la chiave Ed25519 d'istanza e la firma dei comandi. La
 * privata è cifrata a riposo e non esce mai; la pubblica è quella che l'agente
 * fissa all'installazione.
 */

let t: TestDb;
const KEY = randomBytes(32);
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

const payload: ServerCommandPayload = {
  v: 1,
  serverId: "11111111-1111-4111-8111-111111111111",
  commandId: "22222222-2222-4222-8222-222222222222",
  action: "container.restart",
  params: { container: "web", timeoutSeconds: 10 },
  approvalId: "33333333-3333-4333-8333-333333333333",
  issuedAt: "2026-11-14T10:00:00.000Z",
  expiresAt: "2026-11-14T10:10:00.000Z",
};
const verifies = (publicKey: string, p: ServerCommandPayload, signature: string) =>
  verify(null, Buffer.from(canonicalCommandPayload(p)), createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(signature, "base64"));

describe("la chiave d'istanza e la firma", () => {
  it("la chiave nasce al primo bisogno, UNA (anche con richieste insieme); la privata è cifrata", async () => {
    const keys = await Promise.all([commandPublicKey(t.db, KEY), commandPublicKey(t.db, KEY), commandPublicKey(t.db, KEY)]);
    expect(new Set(keys).size).toBe(1);
    const rows = await t.db.select().from(instanceSigningKeys);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.privateKeyEncrypted).not.toContain("PRIVATE KEY");
    expect(rows[0]!.publicKey).toBe(keys[0]);
  });

  it("la firma si verifica con la pubblica; NEGATIVO: un campo cambiato, un altro server, un'altra chiave non verificano", async () => {
    const publicKey = await commandPublicKey(t.db, KEY);
    const signature = await signCommand(t.db, KEY, payload);
    expect(verifies(publicKey, payload, signature)).toBe(true);
    for (const over of [{ serverId: "44444444-4444-4444-8444-444444444444" }, { action: "container.stop" }, { params: { container: "db", timeoutSeconds: 10 } }, { expiresAt: "2026-11-14T12:00:00.000Z" }, { approvalId: null }]) {
      expect(verifies(publicKey, { ...payload, ...over }, signature), JSON.stringify(over)).toBe(false);
    }
    const { generateKeyPairSync } = await import("node:crypto");
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(verifies(other, payload, signature)).toBe(false);
  });

  it("con un'altra chiave di cifratura la privata non si apre: niente firma", async () => {
    await commandPublicKey(t.db, KEY);
    await expect(signCommand(t.db, randomBytes(32), payload)).rejects.toThrow();
  });
});
