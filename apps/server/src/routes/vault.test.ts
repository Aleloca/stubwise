import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  credentialKeyCopies,
  credentials,
  projects,
  securityEvents,
  userPasskeys,
  users,
  vaultPersonKeySeals,
  vaultPersonKeys,
  vaultSettings,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { generatePersonKeyPair, openActorChallenge, PRF_INPUT } from "@stubwise/vault-crypto";
import { buildApp } from "../app.js";
import { listInbox } from "../services/inbox.js";
import {
  createUserWithPat,
  createUserWithSession,
  fullSessionCookie,
  presetRoleId,
  seedUsers,
} from "../test/fixtures.js";

/**
 * Cassaforte: attivazione, chiavi delle persone, kit di recupero, e la PRF
 * nelle opzioni WebAuthn (Task 5 del piano). Il server vede solo chiavi
 * pubbliche e buste opache: qui le buste sono stringhe qualsiasi.
 */

const PUBLIC_URL = "https://stubwise.example.com";

let testDb: TestDb;
let app: FastifyInstance;
let adminId: string;
let admin: { cookie: string };
let member: { id: string; headers: { cookie: string } };
let memberPasskeyId: string;
let memberCredentialId: string;
let memberPasskey2Id: string;
let adminPasskeyId: string;
let projectId: string;

/** Una chiave pubblica P-256 come la esporta `@stubwise/vault-crypto`. */
function publicJwk(): string {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
}

/** Una busta cifrata finta: per il server è opaca. */
function envelope(): string {
  return JSON.stringify({ v: 1, data: randomBytes(16).toString("base64url") });
}

/** Una prova ben formata ma falsa. */
function bogusProof() {
  return { challengeId: randomUUID(), proof: randomBytes(32).toString("base64url") };
}

async function addPasskey(userId: string, name: string) {
  const credentialId = randomBytes(16).toString("base64url");
  const [row] = await testDb.db
    .insert(userPasskeys)
    .values({ userId, credentialId, publicKey: "pk", name })
    .returning({ id: userPasskeys.id });
  return { id: row!.id, credentialId };
}

function req(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: randomBytes(32).toString("base64"),
    authRateLimit: { max: 1000, timeWindow: "1 minute" },
    publicUrl: PUBLIC_URL,
  });
  ({ adminId } = await seedUsers(app));
  admin = { cookie: await fullSessionCookie(app, adminId) };
  member = await createUserWithSession(app, "vault-member@example.com");
  const p1 = await addPasskey(member.id, "Portatile");
  memberPasskeyId = p1.id;
  memberCredentialId = p1.credentialId;
  memberPasskey2Id = (await addPasskey(member.id, "Telefono")).id;
  adminPasskeyId = (await addPasskey(adminId, "Admin")).id;
  const [project] = await testDb.db
    .insert(projects)
    .values({ name: "Cassaforte", slug: "cassaforte", ingestionKey: "cassaforte-key" })
    .returning({ id: projects.id });
  projectId = project!.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

/** I test girano in ordine: prima della cassaforte attiva, poi dopo. */
describe("cassaforte: attivazione e chiavi delle persone", () => {
  it("prima dell'attivazione: lo stato lo dice, e una chiave → 409 vault_not_active", async () => {
    const status = await req("GET", "/api/vault/status", member.headers);
    expect(status.statusCode).toBe(200);
    // `passkeys`: tutte le passkey della persona, anche senza chiave — la web
    // ci ritrova la passkey appena usata per sigillare la PRIMA chiave.
    expect(status.json()).toEqual({
      activated: false,
      myKey: null,
      seals: [],
      passkeys: expect.arrayContaining([
        { passkeyId: memberPasskeyId, credentialIdB64url: memberCredentialId },
      ]),
    });
    // Solo le SUE passkey, nessuna di un altro.
    const own = await testDb.db
      .select({ id: userPasskeys.id })
      .from(userPasskeys)
      .where(eq(userPasskeys.userId, member.id));
    const listed = (status.json() as { passkeys: { passkeyId: string }[] }).passkeys;
    expect(listed.map((p) => p.passkeyId).sort()).toEqual(own.map((p) => p.id).sort());

    const res = await req("POST", "/api/vault/keys", member.headers, {
      publicKey: publicJwk(),
      seals: [{ passkeyId: memberPasskeyId, sealedPrivateKey: envelope() }],
      device: "Safari su macOS",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "vault_not_active" });
    expect(await testDb.db.select().from(vaultPersonKeys)).toHaveLength(0);
  });

  it("la rigenerazione del kit prima dell'attivazione → 409 vault_not_active", async () => {
    const res = await req("POST", "/api/vault/recovery-key", admin, {
      recoveryPublicKey: publicJwk(),
      copies: [],
      actorProof: bogusProof(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "vault_not_active" });
  });

  it("un non full admin non attiva → 403, nessuna riga", async () => {
    const res = await req("POST", "/api/vault/activate", member.headers, {
      recoveryPublicKey: publicJwk(),
    });
    expect(res.statusCode).toBe(403);
    expect(await testDb.db.select().from(vaultSettings)).toHaveLength(0);
  });

  it("una chiave PRIVATA (JWK con `d`) al posto della pubblica → 400", async () => {
    const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
      format: "jwk",
    });
    const res = await req("POST", "/api/vault/activate", admin, {
      recoveryPublicKey: JSON.stringify(jwk),
    });
    expect(res.statusCode).toBe(400);
    expect(await testDb.db.select().from(vaultSettings)).toHaveLength(0);
  });

  it("il full admin attiva una volta sola: la seconda → 409 vault_already_active", async () => {
    const recoveryPublicKey = publicJwk();
    const first = await req("POST", "/api/vault/activate", admin, { recoveryPublicKey });
    expect(first.statusCode).toBe(204);
    const second = await req("POST", "/api/vault/activate", admin, {
      recoveryPublicKey: publicJwk(),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "vault_already_active" });
    const rows = await testDb.db.select().from(vaultSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recoveryPublicKey, activatedByUserId: adminId });
    // Nel registro di sicurezza una volta sola: il secondo tentativo non attiva nulla.
    const events = await testDb.db
      .select()
      .from(securityEvents)
      .where(and(eq(securityEvents.userId, adminId), eq(securityEvents.kind, "vault_activated")));
    expect(events).toHaveLength(1);
  });

  it("la prima chiave del full admin che attiva nasce confermata", async () => {
    const res = await req("POST", "/api/vault/keys", admin, {
      publicKey: publicJwk(),
      seals: [{ passkeyId: adminPasskeyId, sealedPrivateKey: envelope() }],
      device: "Chrome su Windows",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "confirmed" });
    const [row] = await testDb.db
      .select()
      .from(vaultPersonKeys)
      .where(eq(vaultPersonKeys.userId, adminId));
    expect(row).toMatchObject({ status: "confirmed", confirmedByUserId: adminId });
  });

  it("la chiave di un'altra persona nasce pending, con evento di sicurezza e avviso", async () => {
    const publicKey = publicJwk();
    const sealed = envelope();
    const res = await req("POST", "/api/vault/keys", member.headers, {
      publicKey,
      seals: [{ passkeyId: memberPasskeyId, sealedPrivateKey: sealed }],
      device: "Safari su macOS",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; status: string };
    expect(body.status).toBe("pending");
    const [row] = await testDb.db
      .select()
      .from(vaultPersonKeys)
      .where(eq(vaultPersonKeys.id, body.id));
    expect(row).toMatchObject({
      userId: member.id,
      publicKey,
      status: "pending",
      device: "Safari su macOS",
      confirmedAt: null,
    });
    const events = await testDb.db
      .select()
      .from(securityEvents)
      .where(and(eq(securityEvents.userId, member.id), eq(securityEvents.kind, "vault_key_created")));
    expect(events).toHaveLength(1);
    const inbox = await listInbox(testDb.db, { userId: member.id, lang: "en" });
    expect(inbox.items.filter((i) => i.kind === "security.alert")).toHaveLength(1);
    expect(inbox.items[0]!.text).toMatch(/vault key/i);

    const status = await req("GET", "/api/vault/status", member.headers);
    expect(status.json()).toEqual({
      activated: true,
      myKey: { id: body.id, status: "pending", createdAt: expect.any(String) },
      seals: [{ passkeyId: memberPasskeyId, credentialIdB64url: memberCredentialId }],
      passkeys: expect.arrayContaining([
        { passkeyId: memberPasskeyId, credentialIdB64url: memberCredentialId },
      ]),
    });
    const mine = await req("GET", "/api/vault/keys/mine", member.headers);
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual({
      id: body.id,
      publicKey,
      status: "pending",
      seals: [
        {
          passkeyId: memberPasskeyId,
          credentialIdB64url: memberCredentialId,
          sealedPrivateKey: sealed,
        },
      ],
    });
  });

  it("un sigillo per la passkey di un altro → 404, nessuna chiave", async () => {
    const before = await testDb.db.select().from(vaultPersonKeys);
    const res = await req("POST", "/api/vault/keys", member.headers, {
      publicKey: publicJwk(),
      seals: [{ passkeyId: adminPasskeyId, sealedPrivateKey: envelope() }],
      device: "",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "passkey_not_found" });
    expect(await testDb.db.select().from(vaultPersonKeys)).toEqual(before);
  });

  it("aggiunge il sigillo di un'altra passkey alla propria chiave; non a quella di un altro", async () => {
    const mine = (await req("GET", "/api/vault/keys/mine", member.headers)).json() as { id: string };
    const ok = await req("POST", `/api/vault/keys/${mine.id}/seals`, member.headers, {
      passkeyId: memberPasskey2Id,
      sealedPrivateKey: envelope(),
    });
    expect(ok.statusCode).toBe(204);
    const seals = await testDb.db
      .select()
      .from(vaultPersonKeySeals)
      .where(eq(vaultPersonKeySeals.personKeyId, mine.id));
    expect(seals.map((s) => s.passkeyId).sort()).toEqual([memberPasskeyId, memberPasskey2Id].sort());
    const sealEvents = () =>
      testDb.db
        .select()
        .from(securityEvents)
        .where(and(eq(securityEvents.userId, member.id), eq(securityEvents.kind, "vault_seal_replaced")));
    // Un sigillo NUOVO non è una sostituzione (l'aggiunta della passkey è già nel registro).
    expect(await sealEvents()).toHaveLength(0);
    // Lo stesso sigillo riscritto: è una sostituzione, e finisce nel registro.
    const replacement = envelope();
    const replaced = await req("POST", `/api/vault/keys/${mine.id}/seals`, member.headers, {
      passkeyId: memberPasskey2Id,
      sealedPrivateKey: replacement,
    });
    expect(replaced.statusCode).toBe(204);
    expect(await sealEvents()).toHaveLength(1);

    const [adminKey] = await testDb.db
      .select({ id: vaultPersonKeys.id })
      .from(vaultPersonKeys)
      .where(eq(vaultPersonKeys.userId, adminId));
    const other = await req("POST", `/api/vault/keys/${adminKey!.id}/seals`, member.headers, {
      passkeyId: memberPasskeyId,
      sealedPrivateKey: envelope(),
    });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toMatchObject({ code: "vault_key_not_found" });

    const foreignPasskey = await req("POST", `/api/vault/keys/${mine.id}/seals`, member.headers, {
      passkeyId: adminPasskeyId,
      sealedPrivateKey: envelope(),
    });
    expect(foreignPasskey.statusCode).toBe(404);
    expect(foreignPasskey.json()).toMatchObject({ code: "passkey_not_found" });
  });

  it("ricreata: la vecchia è superseded e le sue copie spariscono (Review Focus 3)", async () => {
    const [old] = await testDb.db
      .select({ id: vaultPersonKeys.id })
      .from(vaultPersonKeys)
      .where(and(eq(vaultPersonKeys.userId, member.id), eq(vaultPersonKeys.status, "pending")));
    // La vecchia chiave è confermata e legge una credenziale; anche l'admin e il recupero.
    await testDb.db
      .update(vaultPersonKeys)
      .set({ status: "confirmed", confirmedAt: new Date(), confirmedByUserId: adminId })
      .where(eq(vaultPersonKeys.id, old!.id));
    const [adminKey] = await testDb.db
      .select({ id: vaultPersonKeys.id })
      .from(vaultPersonKeys)
      .where(eq(vaultPersonKeys.userId, adminId));
    const credentialId = randomUUID();
    await testDb.db
      .insert(credentials)
      .values({ id: credentialId, projectId, service: "AWS", passwordCiphertext: envelope() });
    await testDb.db.insert(credentialKeyCopies).values([
      { credentialId, recipientId: old!.id, wrappedKey: envelope() },
      { credentialId, recipientId: adminKey!.id, wrappedKey: envelope() },
      { credentialId, recipientId: "recovery", wrappedKey: envelope() },
    ]);

    const res = await req("POST", "/api/vault/keys", member.headers, {
      publicKey: publicJwk(),
      seals: [{ passkeyId: memberPasskeyId, sealedPrivateKey: envelope() }],
      device: "Firefox su Linux",
    });
    expect(res.statusCode).toBe(201);
    const fresh = res.json() as { id: string; status: string };
    // Una chiave confermata esiste già: la ricreata torna in attesa.
    expect(fresh.status).toBe("pending");

    const [oldRow] = await testDb.db
      .select()
      .from(vaultPersonKeys)
      .where(eq(vaultPersonKeys.id, old!.id));
    expect(oldRow!.status).toBe("superseded");
    const copies = await testDb.db
      .select({ recipientId: credentialKeyCopies.recipientId })
      .from(credentialKeyCopies)
      .where(eq(credentialKeyCopies.credentialId, credentialId));
    expect(copies.map((c) => c.recipientId).sort()).toEqual([adminKey!.id, "recovery"].sort());
    expect(
      await testDb.db
        .select()
        .from(vaultPersonKeySeals)
        .where(eq(vaultPersonKeySeals.personKeyId, old!.id)),
    ).toHaveLength(0);
    const mine = (await req("GET", "/api/vault/keys/mine", member.headers)).json() as { id: string };
    expect(mine.id).toBe(fresh.id);
    // Il sigillo della chiave vecchia non apre la nuova.
    const stale = await req("POST", `/api/vault/keys/${old!.id}/seals`, member.headers, {
      passkeyId: memberPasskey2Id,
      sealedPrivateKey: envelope(),
    });
    expect(stale.statusCode).toBe(404);
  });

  it("un full admin che NON è il primo crea una chiave pending", async () => {
    const other = await createUserWithSession(app, "admin2@example.com");
    await testDb.db
      .update(users)
      .set({ instanceRoleId: await presetRoleId(app, "admin") })
      .where(eq(users.id, other.id));
    const passkey = await addPasskey(other.id, "Admin 2");
    const cookie = await fullSessionCookie(app, other.id);
    const res = await req("POST", "/api/vault/keys", { cookie }, {
      publicKey: publicJwk(),
      seals: [{ passkeyId: passkey.id, sealedPrivateKey: envelope() }],
      device: "Edge su Windows",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "pending" });
  });

  it("V1: l'admin che attiva ricrea DUE volte — la nuova resta pending, nessuna conferma da sé", async () => {
    // Dopo due ricreazioni nessuna chiave è `confirmed` ADESSO: la conferma
    // d'ufficio vale solo se nessuna chiave è MAI stata confermata.
    for (const device of ["Ricreata 1", "Ricreata 2"]) {
      const res = await req("POST", "/api/vault/keys", admin, {
        publicKey: publicJwk(),
        seals: [{ passkeyId: adminPasskeyId, sealedPrivateKey: envelope() }],
        device,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json(), device).toMatchObject({ status: "pending" });
    }
    const confirmedNow = await testDb.db
      .select()
      .from(vaultPersonKeys)
      .where(eq(vaultPersonKeys.status, "confirmed"));
    expect(confirmedNow).toHaveLength(0);
  });
});

describe("cassaforte: rigenerazione del kit di recupero", () => {
  /** La chiave confermata (VERA) dell'admin e la sua privata, per la prova di possesso. */
  let adminKeyId: string;
  let adminPrivateKey: CryptoKey;

  async function actorProof(cookie = admin.cookie): Promise<{ challengeId: string; proof: string }> {
    const res = await req("POST", "/api/vault/actor-challenge", { cookie });
    expect(res.statusCode, res.body).toBe(201);
    const { challengeId, wrapped, personKeyId } = res.json();
    expect(personKeyId).toBe(adminKeyId);
    return { challengeId, proof: await openActorChallenge(wrapped, adminPrivateKey, challengeId, personKeyId) };
  }

  async function rotationEvents() {
    return testDb.db
      .select()
      .from(securityEvents)
      .where(and(eq(securityEvents.userId, adminId), eq(securityEvents.kind, "vault_recovery_key_rotated")));
  }

  beforeAll(async () => {
    // L'admin ha ricreato la chiave (pending) nei test prima: qui ne ha una
    // confermata vera, con la copia di ogni credenziale meno una.
    await testDb.db
      .update(vaultPersonKeys)
      .set({ status: "superseded" })
      .where(eq(vaultPersonKeys.userId, adminId));
    const pair = await generatePersonKeyPair();
    const [row] = await testDb.db
      .insert(vaultPersonKeys)
      .values({ userId: adminId, publicKey: pair.publicKey, status: "confirmed", confirmedAt: new Date() })
      .returning({ id: vaultPersonKeys.id });
    adminKeyId = row!.id;
    adminPrivateKey = pair.privateKey;
    const existing = await testDb.db.select({ id: credentials.id }).from(credentials);
    for (const c of existing) {
      await testDb.db.insert(credentialKeyCopies).values({ credentialId: c.id, recipientId: adminKeyId, wrappedKey: envelope() });
    }
  });

  it("anteprima: la copia dell'admin per OGNI credenziale, e quelle che gli mancano (full admin, solo da sessione)", async () => {
    const credentialId = randomUUID();
    await testDb.db
      .insert(credentials)
      .values({ id: credentialId, projectId, service: "Senza copia", passwordCiphertext: envelope() });
    await testDb.db.insert(credentialKeyCopies).values({ credentialId, recipientId: "recovery", wrappedKey: envelope() });

    const res = await req("GET", "/api/vault/recovery-key/preview", admin);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      personKeyId: string;
      credentials: { id: string; wrappedKey: string }[];
      missing: { id: string; service: string }[];
    };
    expect(body.personKeyId).toBe(adminKeyId);
    expect(body.missing).toEqual([expect.objectContaining({ id: credentialId, service: "Senza copia" })]);
    const mine = await testDb.db
      .select({ credentialId: credentialKeyCopies.credentialId, wrappedKey: credentialKeyCopies.wrappedKey })
      .from(credentialKeyCopies)
      .where(eq(credentialKeyCopies.recipientId, adminKeyId));
    expect(body.credentials.map((c) => ({ credentialId: c.id, wrappedKey: c.wrappedKey })).sort((a, b) => a.credentialId.localeCompare(b.credentialId))).toEqual(
      [...mine].sort((a, b) => a.credentialId.localeCompare(b.credentialId)),
    );
    expect(res.body).not.toContain("passwordCiphertext");
    expect((await req("GET", "/api/vault/recovery-key/preview", member.headers)).statusCode).toBe(403);
    // Il PAT di un full admin: solo da sessione.
    const adminPat = await createUserWithPat(app, "vault-admin-pat@example.com");
    await testDb.db
      .update(users)
      .set({ instanceRoleId: await presetRoleId(app, "admin") })
      .where(eq(users.id, adminPat.id));
    const viaPat = await req("GET", "/api/vault/recovery-key/preview", adminPat.headers);
    expect(viaPat.statusCode).toBe(403);
    expect(viaPat.json()).toMatchObject({ code: "session_required" });

    // Data la copia che mancava, l'anteprima non ne segnala più.
    await testDb.db.insert(credentialKeyCopies).values({ credentialId, recipientId: adminKeyId, wrappedKey: envelope() });
    const after = (await req("GET", "/api/vault/recovery-key/preview", admin)).json();
    expect(after.missing).toEqual([]);
  });

  it("copie che non coprono ESATTAMENTE le credenziali → 409 recipients_changed, niente scritto", async () => {
    const [settingsBefore] = await testDb.db.select().from(vaultSettings);
    const copiesBefore = await testDb.db.select().from(credentialKeyCopies);
    const existing = await testDb.db.select({ id: credentials.id }).from(credentials);
    expect(existing.length).toBeGreaterThan(0);
    const cases = [
      [],
      [...existing.map((c) => ({ credentialId: c.id, wrappedKey: envelope() })), { credentialId: randomUUID(), wrappedKey: envelope() }],
      [...existing, ...existing].map((c) => ({ credentialId: c.id, wrappedKey: envelope() })),
    ];
    for (const copies of cases) {
      const res = await req("POST", "/api/vault/recovery-key", admin, {
        recoveryPublicKey: publicJwk(),
        copies,
        actorProof: await actorProof(),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "recipients_changed" });
    }
    expect(await testDb.db.select().from(vaultSettings)).toEqual([settingsBefore]);
    expect(await testDb.db.select().from(credentialKeyCopies)).toEqual(copiesBefore);
    expect(await rotationEvents()).toHaveLength(0);
  });

  it("un non full admin → 403", async () => {
    const res = await req("POST", "/api/vault/recovery-key", member.headers, {
      recoveryPublicKey: publicJwk(),
      copies: [],
      actorProof: bogusProof(),
    });
    expect(res.statusCode).toBe(403);
  });

  it("login rubato di un full admin: senza la prova della SUA chiave non ruota il kit (403, nulla cambia)", async () => {
    const [settingsBefore] = await testDb.db.select().from(vaultSettings);
    const copiesBefore = await testDb.db.select().from(credentialKeyCopies);
    const existing = await testDb.db.select({ id: credentials.id }).from(credentials);
    const copies = existing.map((c) => ({ credentialId: c.id, wrappedKey: envelope() }));
    const challenge = (await req("POST", "/api/vault/actor-challenge", admin)).json();
    for (const proof of [
      bogusProof(),
      { challengeId: challenge.challengeId, proof: randomBytes(32).toString("base64url") },
    ]) {
      const res = await req("POST", "/api/vault/recovery-key", admin, {
        recoveryPublicKey: publicJwk(),
        copies,
        actorProof: proof,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "vault_proof_invalid" });
    }
    // Senza prova, il corpo non valida.
    expect(
      (await req("POST", "/api/vault/recovery-key", admin, { recoveryPublicKey: publicJwk(), copies })).statusCode,
    ).toBe(400);
    expect(await testDb.db.select().from(vaultSettings)).toEqual([settingsBefore]);
    expect(await testDb.db.select().from(credentialKeyCopies)).toEqual(copiesBefore);
    expect(await rotationEvents()).toHaveLength(0);
  });

  it("copie esatte: sostituisce copie `recovery` e chiave pubblica, registro di sicurezza e avviso agli ALTRI full admin", async () => {
    const existing = await testDb.db.select({ id: credentials.id }).from(credentials);
    const recoveryPublicKey = publicJwk();
    const copies = existing.map((c) => ({ credentialId: c.id, wrappedKey: envelope() }));
    const othersBefore = (await testDb.db.select().from(credentialKeyCopies)).filter(
      (c) => c.recipientId !== "recovery",
    );
    const [otherAdmin] = await testDb.db.select({ id: users.id }).from(users).where(eq(users.email, "admin2@example.com"));
    const alertsOf = async (userId: string) =>
      (await listInbox(testDb.db, { userId, lang: "it" })).items.filter((i) => i.kind === "security.alert");
    const otherBefore = (await alertsOf(otherAdmin!.id)).length;
    const actorBefore = (await alertsOf(adminId)).length;

    const res = await req("POST", "/api/vault/recovery-key", admin, {
      recoveryPublicKey,
      copies,
      actorProof: await actorProof(),
    });
    expect(res.statusCode).toBe(204);
    const [settings] = await testDb.db.select().from(vaultSettings);
    expect(settings!.recoveryPublicKey).toBe(recoveryPublicKey);
    const after = await testDb.db.select().from(credentialKeyCopies);
    expect(
      after
        .filter((c) => c.recipientId === "recovery")
        .map((c) => ({ credentialId: c.credentialId, wrappedKey: c.wrappedKey }))
        .sort((a, b) => a.credentialId.localeCompare(b.credentialId)),
    ).toEqual([...copies].sort((a, b) => a.credentialId.localeCompare(b.credentialId)));
    expect(after.filter((c) => c.recipientId !== "recovery")).toEqual(othersBefore);

    expect(await rotationEvents()).toEqual([expect.objectContaining({ actorUserId: adminId })]);
    const otherAlerts = await alertsOf(otherAdmin!.id);
    expect(otherAlerts).toHaveLength(otherBefore + 1);
    expect(otherAlerts[0]!.text).toContain("kit di recupero");
    expect(await alertsOf(adminId)).toHaveLength(actorBefore);
  });
});

describe("cassaforte: solo da sessione", () => {
  it("un PAT riceve 403 session_required su OGNI rotta, senza effetti", async () => {
    const { headers } = await createUserWithPat(app, "vault-pat@example.com");
    const keysBefore = await testDb.db.select().from(vaultPersonKeys);
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/vault/status"],
      ["GET", "/api/vault/keys/mine"],
      ["POST", "/api/vault/activate", { recoveryPublicKey: publicJwk() }],
      [
        "POST",
        "/api/vault/keys",
        {
          publicKey: publicJwk(),
          seals: [{ passkeyId: memberPasskeyId, sealedPrivateKey: envelope() }],
          device: "script",
        },
      ],
      [
        "POST",
        `/api/vault/keys/${randomUUID()}/seals`,
        { passkeyId: memberPasskeyId, sealedPrivateKey: envelope() },
      ],
      ["POST", "/api/vault/recovery-key", { recoveryPublicKey: publicJwk(), copies: [], actorProof: bogusProof() }],
      ["POST", "/api/vault/actor-challenge"],
    ];
    for (const [method, url, payload] of calls) {
      const res = await req(method as "GET" | "POST", url, headers, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json(), `${method} ${url}`).toMatchObject({ code: "session_required" });
    }
    expect(await testDb.db.select().from(vaultPersonKeys)).toEqual(keysBefore);
  });
});

describe("PRF nelle opzioni WebAuthn", () => {
  it("la riconferma con purpose vault chiede la PRF con l'input fisso della cassaforte", async () => {
    const res = await req("POST", "/api/me/security/reauth/passkey/options", member.headers, {
      purpose: "vault",
    });
    expect(res.statusCode).toBe(200);
    const options = res.json() as { extensions?: { prf: { eval: { first: string } } } };
    expect(options.extensions?.prf.eval.first).toBe(isoBase64URL.fromBuffer(PRF_INPUT));
    expect(isoBase64URL.toBuffer(options.extensions!.prf.eval.first)).toEqual(PRF_INPUT);
  });

  it("la riconferma senza purpose resta senza estensioni", async () => {
    const res = await req("POST", "/api/me/security/reauth/passkey/options", member.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("extensions");
  });

  it("un purpose sconosciuto → 400", async () => {
    const res = await req("POST", "/api/me/security/reauth/passkey/options", member.headers, {
      purpose: "altro",
    });
    expect(res.statusCode).toBe(400);
  });

  it("la registrazione di una passkey chiede la PRF (`prf: {}`)", async () => {
    const res = await req("POST", "/api/me/security/passkeys/options", member.headers);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { extensions: unknown }).extensions).toMatchObject({ prf: {} });
  });
});

describe("cassaforte: la radice confermata è solo chi ha attivato (V1)", () => {
  it("un full admin che NON ha attivato e crea la prima chiave dell'istanza → pending", async () => {
    // Istanza appena attivata dall'admin, nessuna chiave ancora.
    await testDb.db.delete(vaultPersonKeys);
    await testDb.db.delete(vaultSettings);
    await testDb.db
      .insert(vaultSettings)
      .values({ id: 1, recoveryPublicKey: publicJwk(), activatedByUserId: adminId });
    const other = await createUserWithSession(app, "admin3@example.com");
    await testDb.db
      .update(users)
      .set({ instanceRoleId: await presetRoleId(app, "admin") })
      .where(eq(users.id, other.id));
    const passkey = await addPasskey(other.id, "Admin 3");
    const cookie = await fullSessionCookie(app, other.id);
    const res = await req("POST", "/api/vault/keys", { cookie }, {
      publicKey: publicJwk(),
      seals: [{ passkeyId: passkey.id, sealedPrivateKey: envelope() }],
      device: "Chrome su macOS",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "pending" });

    // Rifiutata: lo stato la mostra (va ricreata) ma senza sigilli da proporre.
    const { id } = res.json() as { id: string };
    await testDb.db
      .update(vaultPersonKeys)
      .set({ status: "rejected" })
      .where(eq(vaultPersonKeys.id, id));
    const status = await req("GET", "/api/vault/status", { cookie });
    expect(status.json()).toMatchObject({ myKey: { id, status: "rejected" }, seals: [] });
  });
});
