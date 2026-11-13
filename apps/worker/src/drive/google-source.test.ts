import { randomUUID } from "node:crypto";
import { encrypt, googleAccounts, googleWorkspaces, users } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGoogleDriveSource, DRIVE_READONLY_SCOPE } from "./google-source.js";

/**
 * La sorgente Google del contenuto (area 6, F5b, B3): si legge SOLO con la
 * casella del riferimento; una casella mancante, disattivata o senza
 * `drive.readonly` non legge (e non chiama Google).
 */

const KEY = Buffer.alloc(32, 8);
let t: TestDb;
let ws: string;
beforeAll(async () => {
  t = await startTestDb();
  ws = (await t.db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: encrypt("s", KEY) }).returning())[0]!.id;
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function box(over: Partial<typeof googleAccounts.$inferInsert> = {}) {
  const [u] = await t.db.insert(users).values({ email: `u-${randomUUID()}@acme.com`, passwordHash: "x", role: "member" }).returning();
  return (await t.db.insert(googleAccounts).values({ userId: u!.id, workspaceId: ws, email: `b-${randomUUID()}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: encrypt("r", KEY), scopes: ["openid", DRIVE_READONLY_SCOPE], ...over }).returning())[0]!.id;
}

describe("createGoogleDriveSource", () => {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "at", expires_in: 3600, token_type: "Bearer" }), { status: 200 });
    return new Response("testo del doc", { status: 200 });
  };

  it("senza casella, disattivata o senza drive.readonly: access_lost, e Google non viene chiamato", async () => {
    calls.length = 0;
    const source = createGoogleDriveSource({ db: t.db, encryptionKey: KEY, fetchImpl });
    const file = { googleFileId: "g1", mime: "application/vnd.google-apps.document" };
    expect(await source({ ...file, googleAccountId: null })).toEqual({ gone: "access_lost" });
    expect(await source({ ...file, googleAccountId: await box({ disabledAt: new Date(), disabledReason: "invalid_grant" }) })).toEqual({ gone: "access_lost" });
    expect(await source({ ...file, googleAccountId: await box({ scopes: ["openid"] }) })).toEqual({ gone: "access_lost" });
    expect(calls).toEqual([]);
  });

  it("con la casella giusta: il token di QUELLA casella e l'export del Doc", async () => {
    calls.length = 0;
    const source = createGoogleDriveSource({ db: t.db, encryptionKey: KEY, fetchImpl });
    const out = await source({ googleFileId: "g1", mime: "application/vnd.google-apps.document", googleAccountId: await box() });
    expect("stream" in out && out.mime).toBe("text/plain");
    if ("stream" in out) {
      const chunks: Buffer[] = [];
      for await (const c of out.stream) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe("testo del doc");
    }
    expect(calls.some((u) => u.includes("/drive/v3/files/g1/export"))).toBe(true);
  });
});
