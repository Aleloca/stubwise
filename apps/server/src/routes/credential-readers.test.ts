import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  credentialKeyCopies,
  credentialReaders,
  credentials,
  projects,
  securityEvents,
  userPasskeys,
  users,
  vaultPersonKeySeals,
  vaultPersonKeys,
  vaultRecoveryChallenges,
  vaultSettings,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import {
  generatePersonKeyPair,
  generateRecoveryKit,
  openActorChallenge,
  openRecoveryChallenge,
  parseRecoveryKit,
} from "@stubwise/vault-crypto";
import { buildApp } from "../app.js";
import { listInbox } from "../services/inbox.js";
import { addMember, createUserWithPat, fullSessionCookie, presetRoleId, seedUsers } from "../test/fixtures.js";

/**
 * Lettori, conferme e recupero della cassaforte (Task 7 del piano). Il server
 * non vede crittografia vera: copie della chiave e password cifrate sono
 * buste opache. Gli stati (chiavi, copie, inviti) si preparano in DB.
 */

let testDb: TestDb;
let app: FastifyInstance;

type Headers = Record<string, string>;
interface Person {
  id: string;
  email: string;
  session: Headers;
  pat: Headers;
}

let admin: Person;
let admin2: Person;
let lead: Person;
let lead2: Person;
let devReader: Person;
let projectId: string;
let otherProjectId: string;
let developerRoleId: string;
/** Il kit di recupero VERO dell'istanza: la pubblica è in `vault_settings`. */
let kit: { publicKey: string; kitText: string };

function publicJwk(): string {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
}

function envelope(tag = "x"): string {
  return JSON.stringify({ v: 1, iv: randomBytes(12).toString("base64url"), ct: randomBytes(32).toString("base64url"), tag });
}

function req(method: "GET" | "POST" | "DELETE", url: string, headers: Headers, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

let counter = 0;
/** Un utente con sessione completa (secondo fattore fresco) e PAT, membro col preset dato. */
async function person(prefix: string, preset?: string, project = projectId): Promise<Person> {
  const email = `${prefix}-${++counter}@example.com`;
  const user = await createUserWithPat(app, email);
  if (preset) await addMember(app, project, user.id, preset);
  return { id: user.id, email, pat: user.headers, session: { cookie: await fullSessionCookie(app, user.id) } };
}

/** Le private VERE delle chiavi create da `key()`: servono a rispondere alle sfide di possesso. */
const privateKeys = new Map<string, CryptoKey>();

async function key(userId: string, status: "pending" | "confirmed"): Promise<string> {
  const pair = await generatePersonKeyPair();
  const [row] = await testDb.db
    .insert(vaultPersonKeys)
    .values({
      userId,
      publicKey: pair.publicKey,
      status,
      device: "Safari su macOS",
      ...(status === "confirmed" ? { confirmedAt: new Date() } : {}),
    })
    .returning({ id: vaultPersonKeys.id });
  privateKeys.set(row!.id, pair.privateKey);
  return row!.id;
}

/**
 * La prova di possesso della chiave confermata di `who`: chiede la sfida con
 * la sua sessione e la apre con la sua privata, come fa il browser.
 */
async function proof(who: Person): Promise<{ challengeId: string; proof: string }> {
  const res = await req("POST", "/api/vault/actor-challenge", who.session);
  expect(res.statusCode, res.body).toBe(201);
  const { challengeId, wrapped, personKeyId } = res.json();
  const privateKey = privateKeys.get(personKeyId);
  if (!privateKey) throw new Error("nessuna privata per la chiave della sfida");
  return { challengeId, proof: await openActorChallenge(wrapped, privateKey, challengeId, personKeyId) };
}

/** Una prova ben formata ma falsa (per le richieste respinte prima di guardarla). */
function bogusProof() {
  return { challengeId: randomUUID(), proof: randomBytes(32).toString("base64url") };
}

/** La `keyVersion` di una credenziale, come la calcola il server (md5 della password cifrata). */
async function keyVersionOf(credentialId: string): Promise<string> {
  const [row] = await testDb.db
    .select({ c: credentials.passwordCiphertext })
    .from(credentials)
    .where(eq(credentials.id, credentialId));
  return createHash("md5").update(row!.c).digest("hex");
}

const keys = new Map<string, string>();
/** La chiave viva (confermata) di un utente, creata alla prima richiesta. */
async function confirmedKeyOf(p: Person): Promise<string> {
  if (!keys.has(p.id)) keys.set(p.id, await key(p.id, "confirmed"));
  return keys.get(p.id)!;
}

/** Una credenziale con gli inviti diretti e le copie per le chiavi indicate (più `recovery`). */
async function seedCredential(opts: { readers?: string[]; roleReaders?: string[]; copiesFor?: string[]; project?: string }) {
  const id = randomUUID();
  await testDb.db.insert(credentials).values({
    id,
    projectId: opts.project ?? projectId,
    service: `Servizio ${++counter}`,
    passwordCiphertext: envelope("password"),
    createdByUserId: admin.id,
    updatedByUserId: admin.id,
  });
  for (const userId of opts.readers ?? []) {
    await testDb.db.insert(credentialReaders).values({ credentialId: id, userId });
  }
  for (const roleId of opts.roleReaders ?? []) {
    await testDb.db.insert(credentialReaders).values({ credentialId: id, roleId });
  }
  for (const recipientId of [...(opts.copiesFor ?? []), "recovery"]) {
    await testDb.db.insert(credentialKeyCopies).values({ credentialId: id, recipientId, wrappedKey: envelope() });
  }
  return id;
}

async function copyRecipients(credentialId: string): Promise<string[]> {
  const rows = await testDb.db
    .select({ recipientId: credentialKeyCopies.recipientId })
    .from(credentialKeyCopies)
    .where(eq(credentialKeyCopies.credentialId, credentialId));
  return rows.map((r) => r.recipientId).sort();
}

async function keyRow(id: string) {
  const [row] = await testDb.db.select().from(vaultPersonKeys).where(eq(vaultPersonKeys.id, id));
  return row!;
}

function reveal(credentialId: string, who: Person) {
  return req("POST", `/api/credentials/${credentialId}/reveal`, who.session, { action: "show" });
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: randomBytes(32).toString("base64"),
    authRateLimit: { max: 1000, timeWindow: "1 minute" },
  });
  const seeded = await seedUsers(app);
  admin = {
    id: seeded.adminId,
    email: "admin@example.com",
    session: { cookie: seeded.adminCookie },
    pat: {},
  };
  const [p1, p2] = await testDb.db
    .insert(projects)
    .values([
      { name: "cassaforte", slug: "cassaforte", ingestionKey: "cassaforte-key" },
      { name: "altro", slug: "altro", ingestionKey: "altro-key" },
    ])
    .returning({ id: projects.id });
  projectId = p1!.id;
  otherProjectId = p2!.id;
  developerRoleId = await presetRoleId(app, "developer");

  // Un secondo full admin, per l'avviso del recupero.
  const [second] = await testDb.db
    .insert(users)
    .values({ email: "admin2@example.com", passwordHash: "x", role: "admin", notifySlackDm: false })
    .returning({ id: users.id });
  admin2 = {
    id: second!.id,
    email: "admin2@example.com",
    session: { cookie: await fullSessionCookie(app, second!.id) },
    pat: {},
  };

  lead = await person("lead", "project_lead");
  lead2 = await person("lead2", "project_lead");
  devReader = await person("dev-reader", "developer");

  kit = await generateRecoveryKit();
  await testDb.db.insert(vaultSettings).values({ id: 1, recoveryPublicKey: kit.publicKey, activatedByUserId: admin.id });
  for (const p of [admin, lead, lead2, devReader]) await confirmedKeyOf(p);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe("lettori di una credenziale", () => {
  it("GET readers: credentials.share + lettore, o full admin; gli altri no", async () => {
    const id = await seedCredential({
      readers: [lead.id, devReader.id],
      copiesFor: [await confirmedKeyOf(lead), await confirmedKeyOf(devReader)],
    });
    const res = await req("GET", `/api/credentials/${id}/readers`, lead.session);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.readers.map((r: { userId: string }) => r.userId).sort()).toEqual([lead.id, devReader.id].sort());
    expect(body.people).toContainEqual(
      expect.objectContaining({ userId: devReader.id, status: "can_read", keyStatus: "confirmed", fullAdmin: false }),
    );
    // Il full admin è lettore effettivo, ma senza copia di questa credenziale.
    expect(body.people).toContainEqual(
      expect.objectContaining({ userId: admin.id, status: "pending", keyStatus: "confirmed", fullAdmin: true }),
    );
    expect(res.body).not.toContain("wrappedKey");
    expect(res.body).not.toContain("passwordCiphertext");

    expect((await req("GET", `/api/credentials/${id}/readers`, admin.session)).statusCode).toBe(200);
    // Lettore senza credentials.share: non vede i lettori.
    expect((await req("GET", `/api/credentials/${id}/readers`, devReader.session)).statusCode).toBe(403);
    // credentials.share ma non lettore.
    const notReader = await req("GET", `/api/credentials/${id}/readers`, lead2.session);
    expect(notReader.statusCode).toBe(403);
    expect(notReader.json()).toMatchObject({ code: "not_a_reader" });
    // Fuori dal progetto: 404 come una credenziale che non esiste.
    const stranger = await person("stranger");
    expect((await req("GET", `/api/credentials/${id}/readers`, stranger.session)).statusCode).toBe(404);
    // Un PAT, anche di un lettore con credentials.share: 403 session_required.
    const pat = await req("GET", `/api/credentials/${id}/readers`, lead.pat);
    expect(pat.statusCode).toBe(403);
    expect(pat.json()).toMatchObject({ code: "session_required" });
  });

  it("condividere senza poterla aprire → 403 anche con credentials.share, nulla scritto", async () => {
    const target = await person("target", "developer");
    const targetKey = await confirmedKeyOf(target);
    // lead2 ha credentials.share ma non è lettore; lead è lettore ma senza copia (in attesa).
    const id = await seedCredential({ readers: [lead.id], copiesFor: [] });
    for (const who of [lead2, lead]) {
      const res = await req("POST", `/api/credentials/${id}/readers`, who.session, {
        userId: target.id,
        copies: [{ recipientId: targetKey, wrappedKey: envelope() }],
        keyVersion: "qualsiasi",
        actorProof: await proof(who),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "not_a_reader" });
    }
    // Un lettore che la apre ma senza credentials.share → 403 forbidden.
    const readable = await seedCredential({ readers: [devReader.id], copiesFor: [await confirmedKeyOf(devReader)] });
    const noShare = await req("POST", `/api/credentials/${readable}/readers`, devReader.session, {
      userId: target.id,
      copies: [],
      keyVersion: "x",
      actorProof: bogusProof(),
    });
    expect(noShare.statusCode).toBe(403);
    expect(noShare.json()).toMatchObject({ code: "forbidden" });
    for (const c of [id, readable]) {
      const readers = await testDb.db.select().from(credentialReaders).where(eq(credentialReaders.credentialId, c));
      expect(readers.map((r) => r.userId)).not.toContain(target.id);
      expect(await copyRecipients(c)).not.toContain(targetKey);
    }
  });

  it("condividere a un ruolo: accesso subito a chi ha la chiave confermata, in attesa gli altri", async () => {
    const devConfirmed = await person("dev-confirmed", "developer");
    const devPending = await person("dev-pending", "developer");
    const devNoKey = await person("dev-nokey", "developer");
    const confirmedId = await confirmedKeyOf(devConfirmed);
    const pendingId = await key(devPending.id, "pending");
    const id = await seedCredential({ readers: [lead.id], copiesFor: [await confirmedKeyOf(lead)] });

    const preview = await req("GET", `/api/credentials/${id}/readers/preview?roleId=${developerRoleId}`, lead.session);
    expect(preview.statusCode).toBe(200);
    const p = preview.json();
    const [leadCopy] = await testDb.db
      .select({ wrappedKey: credentialKeyCopies.wrappedKey })
      .from(credentialKeyCopies)
      .where(and(eq(credentialKeyCopies.credentialId, id), eq(credentialKeyCopies.recipientId, keys.get(lead.id)!)));
    expect(p.wrappedKey).toBe(leadCopy!.wrappedKey);
    expect(typeof p.keyVersion).toBe("string");
    expect(preview.body).not.toContain("passwordCiphertext");
    // I developer con chiave confermata (devConfirmed, devReader, quelli dei test prima) ricevono
    // subito; chi ha la chiave da confermare o nessuna chiave aspetta.
    const immediate = p.people.map((x: { personKeyId: string }) => x.personKeyId) as string[];
    expect(immediate).toEqual(expect.arrayContaining([confirmedId, keys.get(devReader.id)!]));
    expect(immediate).not.toContain(pendingId);
    const statuses = await testDb.db
      .select({ status: vaultPersonKeys.status })
      .from(vaultPersonKeys)
      .where(inArray(vaultPersonKeys.id, immediate));
    expect(statuses.every((row) => row.status === "confirmed")).toBe(true);
    expect(p.waiting.map((x: { userId: string }) => x.userId)).toEqual(
      expect.arrayContaining([devPending.id, devNoKey.id]),
    );
    expect(p.waiting.map((x: { userId: string }) => x.userId)).not.toContain(devConfirmed.id);

    const res = await req("POST", `/api/credentials/${id}/readers`, lead.session, {
      roleId: developerRoleId,
      copies: p.people.map((x: { personKeyId: string }) => ({ recipientId: x.personKeyId, wrappedKey: envelope() })),
      keyVersion: p.keyVersion,
      actorProof: await proof(lead),
    });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.readers).toContainEqual(expect.objectContaining({ roleId: developerRoleId, roleName: "Developer", userId: null }));
    expect(view.people).toContainEqual(expect.objectContaining({ userId: devConfirmed.id, status: "can_read" }));
    expect(view.people).toContainEqual(
      expect.objectContaining({ userId: devPending.id, status: "pending", keyStatus: "pending" }),
    );
    expect(view.people).toContainEqual(expect.objectContaining({ userId: devNoKey.id, status: "pending", keyStatus: "none" }));

    expect((await reveal(id, devConfirmed)).statusCode).toBe(200);
    expect((await reveal(id, devPending)).statusCode).toBe(404);
    expect(await copyRecipients(id)).not.toContain(pendingId);
    // Il ruolo Developer lettore renderebbe «in attesa» i developer dei test dopo.
    await testDb.db.delete(credentials).where(eq(credentials.id, id));
  });

  it("copie che non coprono ESATTAMENTE l'anteprima, o per una chiave vecchia → 409 con l'anteprima, nulla scritto", async () => {
    const target = await person("exact", "developer");
    const targetKey = await confirmedKeyOf(target);
    const id = await seedCredential({ readers: [lead.id], copiesFor: [await confirmedKeyOf(lead)] });
    const p = (await req("GET", `/api/credentials/${id}/readers/preview?userId=${target.id}`, lead.session)).json();
    expect(p.people.map((x: { personKeyId: string }) => x.personKeyId)).toEqual([targetKey]);

    for (const body of [
      { userId: target.id, copies: [], keyVersion: p.keyVersion },
      {
        userId: target.id,
        copies: [
          { recipientId: targetKey, wrappedKey: envelope() },
          { recipientId: keys.get(devReader.id)!, wrappedKey: envelope() },
        ],
        keyVersion: p.keyVersion,
      },
      { userId: target.id, copies: [{ recipientId: targetKey, wrappedKey: envelope() }], keyVersion: "vecchia" },
    ]) {
      const res = await req("POST", `/api/credentials/${id}/readers`, lead.session, {
        ...body,
        actorProof: await proof(lead),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "recipients_changed", preview: { keyVersion: p.keyVersion } });
    }
    const readers = await testDb.db.select().from(credentialReaders).where(eq(credentialReaders.credentialId, id));
    expect(readers.map((r) => r.userId)).toEqual([lead.id]);
    expect(await copyRecipients(id)).toEqual([keys.get(lead.id)!, "recovery"].sort());
  });

  it("una password cambiata in parallelo (riga bloccata) → la condivisione aspetta e dà 409", async () => {
    const target = await person("race", "developer");
    const targetKey = await confirmedKeyOf(target);
    const id = await seedCredential({ readers: [lead.id], copiesFor: [await confirmedKeyOf(lead)] });
    const p = (await req("GET", `/api/credentials/${id}/readers/preview?userId=${target.id}`, lead.session)).json();

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    // Come `replacePassword`: blocca la riga e cambia password (e chiave).
    const replacement = testDb.db.transaction(async (tx) => {
      await tx.select().from(credentials).where(eq(credentials.id, id)).for("update");
      locked();
      await held;
      await tx.update(credentials).set({ passwordCiphertext: envelope("nuova") }).where(eq(credentials.id, id));
    });
    await isLocked;
    let settled = false;
    const actorProof = await proof(lead);
    const sharing = req("POST", `/api/credentials/${id}/readers`, lead.session, {
      userId: target.id,
      copies: [{ recipientId: targetKey, wrappedKey: envelope() }],
      keyVersion: p.keyVersion,
      actorProof,
    }).then((res) => {
      settled = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    release();
    await replacement;
    const res = await sharing;
    expect(res.statusCode).toBe(409);
    expect(res.json().preview.keyVersion).not.toBe(p.keyVersion);
    expect(await copyRecipients(id)).not.toContain(targetKey);
  });

  it("lettore non invitabile: persona fuori dal progetto → 400 not_a_member; ruolo d'istanza → 400 invalid_role", async () => {
    const id = await seedCredential({ readers: [lead.id], copiesFor: [await confirmedKeyOf(lead)] });
    const outsider = await person("fuori", "developer", otherProjectId);
    const notMember = await req("GET", `/api/credentials/${id}/readers/preview?userId=${outsider.id}`, lead.session);
    expect(notMember.statusCode).toBe(400);
    expect(notMember.json()).toMatchObject({ code: "not_a_member" });
    const userPreset = await presetRoleId(app, "user");
    const instanceRole = await req("POST", `/api/credentials/${id}/readers`, lead.session, {
      roleId: userPreset,
      copies: [],
      keyVersion: "x",
      actorProof: await proof(lead),
    });
    expect(instanceRole.statusCode).toBe(400);
    expect(instanceRole.json()).toMatchObject({ code: "invalid_role" });
    // Né l'una né l'altro, o entrambi → 400 di validazione.
    expect((await req("POST", `/api/credentials/${id}/readers`, lead.session, { copies: [], keyVersion: "x" })).statusCode).toBe(400);
  });

  it("revoca: togliere il ruolo cancella SUBITO le copie di chi non legge più; il lettore diretto resta", async () => {
    const viaRole = await person("via-ruolo", "developer");
    const viaRoleKey = await confirmedKeyOf(viaRole);
    const id = await seedCredential({
      readers: [lead.id, devReader.id],
      roleReaders: [developerRoleId],
      copiesFor: [await confirmedKeyOf(lead), viaRoleKey, keys.get(devReader.id)!],
    });
    const [roleReader] = await testDb.db
      .select({ id: credentialReaders.id })
      .from(credentialReaders)
      .where(and(eq(credentialReaders.credentialId, id), eq(credentialReaders.roleId, developerRoleId)));

    // PAT → 403 session_required, nulla tolto.
    const pat = await req("DELETE", `/api/credentials/${id}/readers/${roleReader!.id}`, lead.pat, {
      actorProof: bogusProof(),
    });
    expect(pat.statusCode).toBe(403);
    expect(pat.json()).toMatchObject({ code: "session_required" });
    expect(await copyRecipients(id)).toContain(viaRoleKey);

    // Senza una prova valida della propria chiave → 403 vault_proof_invalid, nulla tolto.
    const unproven = await req("DELETE", `/api/credentials/${id}/readers/${roleReader!.id}`, lead.session, {
      actorProof: bogusProof(),
    });
    expect(unproven.statusCode).toBe(403);
    expect(unproven.json()).toMatchObject({ code: "vault_proof_invalid" });
    expect(await copyRecipients(id)).toContain(viaRoleKey);

    const res = await req("DELETE", `/api/credentials/${id}/readers/${roleReader!.id}`, lead.session, {
      actorProof: await proof(lead),
    });
    expect(res.statusCode).toBe(200);
    expect(await copyRecipients(id)).toEqual([keys.get(lead.id)!, keys.get(devReader.id)!, "recovery"].sort());
    expect((await reveal(id, viaRole)).statusCode).toBe(404);
    // devReader è anche lettore diretto: legge ancora.
    expect((await reveal(id, devReader)).statusCode).toBe(200);
    // Lo stesso lettore una seconda volta → 404.
    expect(
      (
        await req("DELETE", `/api/credentials/${id}/readers/${roleReader!.id}`, lead.session, {
          actorProof: await proof(lead),
        })
      ).statusCode,
    ).toBe(404);
  });

  it("condividere senza la prova della propria chiave (login rubato) → 403 vault_proof_invalid, nulla scritto", async () => {
    const target = await person("attaccante", "developer");
    const targetKey = await confirmedKeyOf(target);
    const id = await seedCredential({ readers: [lead.id], copiesFor: [await confirmedKeyOf(lead)] });
    const p = (await req("GET", `/api/credentials/${id}/readers/preview?userId=${target.id}`, lead.session)).json();
    const body = {
      userId: target.id,
      copies: [{ recipientId: targetKey, wrappedKey: envelope("spazzatura") }],
      keyVersion: p.keyVersion,
    };
    // Senza prova: il corpo non valida.
    expect((await req("POST", `/api/credentials/${id}/readers`, lead.session, body)).statusCode).toBe(400);
    // Una sfida chiesta ma non aperta (manca la privata), o la prova di un ALTRO.
    const challenge = (await req("POST", "/api/vault/actor-challenge", lead.session)).json();
    for (const actorProof of [
      { challengeId: challenge.challengeId, proof: randomBytes(32).toString("base64url") },
      await proof(devReader),
    ]) {
      const res = await req("POST", `/api/credentials/${id}/readers`, lead.session, { ...body, actorProof });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "vault_proof_invalid" });
    }
    const readers = await testDb.db.select().from(credentialReaders).where(eq(credentialReaders.credentialId, id));
    expect(readers.map((r) => r.userId)).toEqual([lead.id]);
    expect(await copyRecipients(id)).not.toContain(targetKey);
    // La prova vale una volta sola.
    const once = await proof(lead);
    expect((await req("POST", `/api/credentials/${id}/readers`, lead.session, { ...body, actorProof: once })).statusCode).toBe(200);
    const again = await req("POST", `/api/credentials/${id}/readers`, lead.session, { ...body, actorProof: once });
    expect(again.json()).toMatchObject({ code: "vault_proof_invalid" });
  });

  it("PAT sull'anteprima e sulla condivisione → 403 session_required", async () => {
    const id = await seedCredential({ readers: [lead.id], copiesFor: [await confirmedKeyOf(lead)] });
    const preview = await req("GET", `/api/credentials/${id}/readers/preview?userId=${devReader.id}`, lead.pat);
    expect(preview.statusCode).toBe(403);
    expect(preview.json()).toMatchObject({ code: "session_required" });
    const share = await req("POST", `/api/credentials/${id}/readers`, lead.pat, {
      userId: devReader.id,
      copies: [],
      keyVersion: "x",
      actorProof: bogusProof(),
    });
    expect(share.statusCode).toBe(403);
    expect(share.json()).toMatchObject({ code: "session_required" });
  });
});

describe("accessi in attesa: elenco, conferma, rifiuto", () => {
  /** Una persona developer con chiave pending, lettrice diretta di una credenziale che lead apre. */
  async function pendingScenario(prefix: string) {
    const who = await person(prefix, "developer");
    const pendingKey = await key(who.id, "pending");
    const credentialId = await seedCredential({
      readers: [lead.id, devReader.id, who.id],
      copiesFor: [await confirmedKeyOf(lead), keys.get(devReader.id)!],
    });
    return { who, pendingKey, credentialId };
  }

  async function pendingOf(viewer: Person) {
    const res = await req("GET", "/api/vault/pending", viewer.session);
    expect(res.statusCode).toBe(200);
    return res.json().items as {
      user: { id: string; email: string };
      personKey: { id: string; status: string; device: string | null; fingerprintSource: string; createdAt: string };
      credentials: { id: string; projectId: string; service: string; wrappedKey: string; keyVersion: string }[];
    }[];
  }

  it("l'elenco mostra a chi ha credentials.share e la apre; un lettore senza share non vede nulla", async () => {
    const { who, pendingKey, credentialId } = await pendingScenario("in-attesa");
    const items = await pendingOf(lead);
    const entry = items.find((i) => i.personKey.id === pendingKey);
    expect(entry).toMatchObject({
      user: { id: who.id, email: who.email },
      personKey: { status: "pending", device: "Safari su macOS", fingerprintSource: expect.stringContaining("P-256") },
    });
    const [leadCopy] = await testDb.db
      .select({ wrappedKey: credentialKeyCopies.wrappedKey })
      .from(credentialKeyCopies)
      .where(and(eq(credentialKeyCopies.credentialId, credentialId), eq(credentialKeyCopies.recipientId, keys.get(lead.id)!)));
    expect(entry!.credentials).toEqual([
      expect.objectContaining({ id: credentialId, projectId, wrappedKey: leadCopy!.wrappedKey, keyVersion: expect.any(String) }),
    ]);
    // devReader la apre ma non ha credentials.share: non vede né conferma.
    expect((await pendingOf(devReader)).find((i) => i.personKey.id === pendingKey)).toBeUndefined();
    const res = await req("POST", `/api/vault/pending/${pendingKey}/confirm`, devReader.session, {
      copies: [{ credentialId, wrappedKey: envelope(), keyVersion: entry!.credentials[0]!.keyVersion }],
      actorProof: await proof(devReader),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "nothing_to_confirm" });
    expect((await keyRow(pendingKey)).status).toBe("pending");
    expect(await copyRecipients(credentialId)).not.toContain(pendingKey);
    // Chi guarda non vede la propria chiave in attesa.
    expect((await pendingOf(who)).find((i) => i.personKey.id === pendingKey)).toBeUndefined();
    // PAT → 403 session_required.
    expect((await req("GET", "/api/vault/pending", lead.pat)).json()).toMatchObject({ code: "session_required" });
  });

  it("conferma: la chiave diventa confirmed (con confirmedAt/By), si salvano solo le copie che chi conferma poteva dare", async () => {
    const { who, pendingKey, credentialId } = await pendingScenario("conferma");
    // Una seconda credenziale in attesa che lead NON apre (nessuna copia per lead).
    const notMine = await seedCredential({ readers: [who.id, lead.id], copiesFor: [keys.get(admin.id)!] });
    // Una terza che lead apre, ma con la password cambiata dopo l'elenco.
    const changed = await seedCredential({ readers: [who.id, lead.id], copiesFor: [keys.get(lead.id)!] });
    const entry = (await pendingOf(lead)).find((i) => i.personKey.id === pendingKey)!;
    const version = (id: string) => entry.credentials.find((c) => c.id === id)!.keyVersion;
    await testDb.db.update(credentials).set({ passwordCiphertext: envelope("nuova") }).where(eq(credentials.id, changed));

    const res = await req("POST", `/api/vault/pending/${pendingKey}/confirm`, lead.session, {
      copies: [
        { credentialId, wrappedKey: envelope(), keyVersion: version(credentialId) },
        { credentialId: notMine, wrappedKey: envelope(), keyVersion: "x" },
        { credentialId: changed, wrappedKey: envelope(), keyVersion: version(changed) },
      ],
      actorProof: await proof(lead),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      personKeyId: pendingKey,
      status: "confirmed",
      saved: [credentialId],
      skipped: expect.arrayContaining([
        { credentialId: notMine, reason: "not_allowed" },
        { credentialId: changed, reason: "key_changed" },
      ]),
    });
    const row = await keyRow(pendingKey);
    expect(row.status).toBe("confirmed");
    expect(row.confirmedAt).toBeInstanceOf(Date);
    expect(row.confirmedByUserId).toBe(lead.id);
    expect(await copyRecipients(credentialId)).toContain(pendingKey);
    expect(await copyRecipients(notMine)).not.toContain(pendingKey);
    expect(await copyRecipients(changed)).not.toContain(pendingKey);
    expect((await reveal(credentialId, who)).statusCode).toBe(200);
    expect((await reveal(notMine, who)).statusCode).toBe(404);

    // Confermata ma senza copia di `notMine`: resta in elenco per chi può darla (l'admin, che la apre).
    const forAdmin = (await pendingOf(admin)).find((i) => i.personKey.id === pendingKey);
    expect(forAdmin).toMatchObject({ personKey: { status: "confirmed" } });
    expect(forAdmin!.credentials.map((c) => c.id)).toEqual([notMine]);
  });

  it("la propria chiave non si conferma; `viaRecovery: true` sulla via normale → 400; PAT → 403", async () => {
    // Chi ha la chiave in attesa non ha una chiave confermata: nessuna prova possibile.
    const mine = await person("propria", "project_lead");
    const mineKey = await key(mine.id, "pending");
    const noKey = await req("POST", "/api/vault/actor-challenge", mine.session);
    expect(noKey.statusCode).toBe(403);
    expect(noKey.json()).toMatchObject({ code: "vault_key_not_confirmed" });
    const unproven = await req("POST", `/api/vault/pending/${mineKey}/confirm`, mine.session, {
      copies: [],
      actorProof: bogusProof(),
    });
    expect(unproven.statusCode).toBe(403);
    expect(unproven.json()).toMatchObject({ code: "vault_proof_invalid" });
    // Una chiave CONFERMATA a cui manca una copia: nemmeno la propria, anche con la prova.
    const self = await person("propria-confermata", "project_lead");
    const selfKey = await confirmedKeyOf(self);
    const missing = await seedCredential({ readers: [self.id], copiesFor: [] });
    const own = await req("POST", `/api/vault/pending/${selfKey}/confirm`, self.session, {
      copies: [{ credentialId: missing, wrappedKey: envelope(), keyVersion: await keyVersionOf(missing) }],
      actorProof: await proof(self),
    });
    expect(own.statusCode).toBe(403);
    expect(own.json()).toMatchObject({ code: "own_key" });
    expect(await copyRecipients(missing)).not.toContain(selfKey);
    const viaRecovery = await req("POST", `/api/vault/pending/${mineKey}/confirm`, admin.session, {
      copies: [],
      viaRecovery: true,
      actorProof: await proof(admin),
    });
    expect(viaRecovery.statusCode).toBe(400);
    const pat = await req("POST", `/api/vault/pending/${mineKey}/confirm`, lead.pat, {
      copies: [],
      actorProof: bogusProof(),
    });
    expect(pat.statusCode).toBe(403);
    expect(pat.json()).toMatchObject({ code: "session_required" });
    expect((await keyRow(mineKey)).status).toBe("pending");
  });

  it("nessuno conferma «a vuoto»: nemmeno un full admin, senza almeno una copia salvata → 403 nothing_to_confirm", async () => {
    const newcomer = await person("nuovo");
    const pendingKey = await key(newcomer.id, "pending");
    const res = await req("POST", `/api/vault/pending/${pendingKey}/confirm`, admin.session, {
      copies: [],
      actorProof: await proof(admin),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "nothing_to_confirm" });
    expect(await keyRow(pendingKey)).toMatchObject({ status: "pending", confirmedAt: null, confirmedByUserId: null });
    // Copie spazzatura per credenziali che l'admin non può passare: scartate, e la chiave resta in attesa.
    const notReader = await seedCredential({ readers: [], copiesFor: [] });
    const junk = await req("POST", `/api/vault/pending/${pendingKey}/confirm`, admin.session, {
      copies: [{ credentialId: notReader, wrappedKey: envelope("spazzatura"), keyVersion: await keyVersionOf(notReader) }],
      actorProof: await proof(admin),
    });
    expect(junk.json()).toMatchObject({ code: "nothing_to_confirm" });
    expect((await keyRow(pendingKey)).status).toBe("pending");
  });

  it("login rubato di un full admin: senza la prova della SUA chiave non conferma una chiave fantoccio (403, nulla cambia)", async () => {
    const puppet = await person("fantoccio", "developer");
    const puppetKey = await key(puppet.id, "pending");
    const id = await seedCredential({ readers: [puppet.id], copiesFor: [keys.get(admin.id)!] });
    const copies = [{ credentialId: id, wrappedKey: envelope("spazzatura"), keyVersion: await keyVersionOf(id) }];
    // Sfida chiesta col login rubato, ma senza la privata non si apre.
    const challenge = (await req("POST", "/api/vault/actor-challenge", admin.session)).json();
    for (const actorProof of [
      { challengeId: challenge.challengeId, proof: randomBytes(32).toString("base64url") },
      bogusProof(),
      await proof(lead),
    ]) {
      const res = await req("POST", `/api/vault/pending/${puppetKey}/confirm`, admin.session, { copies, actorProof });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "vault_proof_invalid" });
    }
    expect((await keyRow(puppetKey)).status).toBe("pending");
    expect(await copyRecipients(id)).not.toContain(puppetKey);
    // Scaduta, o di un'altra sessione dello stesso admin.
    const expired = await proof(admin);
    await testDb.db
      .update(vaultRecoveryChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(vaultRecoveryChallenges.id, expired.challengeId));
    const otherSession = { ...admin, session: { cookie: await fullSessionCookie(app, admin.id) } };
    for (const [who, actorProof] of [
      [admin, expired],
      [otherSession, await proof(admin)],
    ] as const) {
      const res = await req("POST", `/api/vault/pending/${puppetKey}/confirm`, who.session, { copies, actorProof });
      expect(res.json()).toMatchObject({ code: "vault_proof_invalid" });
    }
    expect((await keyRow(puppetKey)).status).toBe("pending");
  });

  it("una sfida del kit di recupero non vale come prova della chiave, né viceversa", async () => {
    const who = await person("incrocio", "developer");
    const pendingKey = await key(who.id, "pending");
    const id = await seedCredential({ readers: [who.id], copiesFor: [keys.get(admin.id)!] });
    const copies = [{ credentialId: id, wrappedKey: envelope(), keyVersion: await keyVersionOf(id) }];
    const rc = (await req("POST", "/api/vault/recovery/challenge", admin.session)).json();
    const recoveryProof = {
      challengeId: rc.challengeId,
      proof: await openRecoveryChallenge(rc.wrapped, await parseRecoveryKit(kit.kitText), rc.challengeId),
    };
    const res = await req("POST", `/api/vault/pending/${pendingKey}/confirm`, admin.session, {
      copies,
      actorProof: recoveryProof,
    });
    expect(res.json()).toMatchObject({ code: "vault_proof_invalid" });
    const actor = await proof(admin);
    const list = await req("POST", "/api/vault/recovery/pending", admin.session, actor);
    expect(list.json()).toMatchObject({ code: "recovery_proof_invalid" });
  });

  it("rifiuto: nessuna copia, la persona resta senza accesso e deve ricrearla", async () => {
    const { who, pendingKey, credentialId } = await pendingScenario("rifiuto");
    const [passkey] = await testDb.db
      .insert(userPasskeys)
      .values({ userId: who.id, credentialId: randomBytes(16).toString("base64url"), publicKey: "pk", name: "P" })
      .returning({ id: userPasskeys.id });
    await testDb.db.insert(vaultPersonKeySeals).values({ personKeyId: pendingKey, passkeyId: passkey!.id, sealedPrivateKey: envelope() });

    // Chi non potrebbe confermare nulla per lei → 403; un PAT → 403 session_required.
    const devReject = await req("POST", `/api/vault/pending/${pendingKey}/reject`, devReader.session, {
      actorProof: await proof(devReader),
    });
    expect(devReject.statusCode).toBe(403);
    expect(devReject.json()).toMatchObject({ code: "forbidden" });
    expect(
      (await req("POST", `/api/vault/pending/${pendingKey}/reject`, lead.pat, { actorProof: bogusProof() })).json(),
    ).toMatchObject({ code: "session_required" });
    // La persona stessa ha solo la chiave in attesa: nessuna prova possibile.
    expect(
      (await req("POST", `/api/vault/pending/${pendingKey}/reject`, who.session, { actorProof: bogusProof() })).json(),
    ).toMatchObject({ code: "vault_proof_invalid" });
    // Un login rubato di chi potrebbe rifiutare: senza prova, nulla.
    const unproven = await req("POST", `/api/vault/pending/${pendingKey}/reject`, lead.session, {
      actorProof: bogusProof(),
    });
    expect(unproven.json()).toMatchObject({ code: "vault_proof_invalid" });
    expect((await keyRow(pendingKey)).status).toBe("pending");

    const res = await req("POST", `/api/vault/pending/${pendingKey}/reject`, lead.session, {
      actorProof: await proof(lead),
    });
    expect(res.statusCode).toBe(204);
    expect((await keyRow(pendingKey)).status).toBe("rejected");
    expect(await testDb.db.select().from(vaultPersonKeySeals).where(eq(vaultPersonKeySeals.personKeyId, pendingKey))).toHaveLength(0);
    expect(await copyRecipients(credentialId)).not.toContain(pendingKey);
    expect((await reveal(credentialId, who)).statusCode).toBe(404);
    expect((await pendingOf(lead)).find((i) => i.personKey.id === pendingKey)).toBeUndefined();
    // Una chiave rifiutata non si conferma più.
    const confirm = await req("POST", `/api/vault/pending/${pendingKey}/confirm`, admin.session, {
      copies: [],
      actorProof: await proof(admin),
    });
    expect(confirm.statusCode).toBe(404);
    expect(confirm.json()).toMatchObject({ code: "vault_key_not_found" });
  });

  it("una chiave già confermata non si rifiuta (409 not_pending)", async () => {
    const res = await req("POST", `/api/vault/pending/${keys.get(devReader.id)}/reject`, admin.session, {
      actorProof: await proof(admin),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "not_pending" });
  });

  it("Review Focus 3: una chiave ricreata perde le copie, torna in attesa e serve una conferma", async () => {
    const who = await person("ricrea", "developer");
    const oldKey = await confirmedKeyOf(who);
    const id = await seedCredential({ readers: [lead.id, who.id], copiesFor: [keys.get(lead.id)!, oldKey] });
    expect((await reveal(id, who)).statusCode).toBe(200);
    const [passkey] = await testDb.db
      .insert(userPasskeys)
      .values({ userId: who.id, credentialId: randomBytes(16).toString("base64url"), publicKey: "pk", name: "P" })
      .returning({ id: userPasskeys.id });
    const created = await req("POST", "/api/vault/keys", who.session, {
      publicKey: publicJwk(),
      seals: [{ passkeyId: passkey!.id, sealedPrivateKey: envelope() }],
      device: "Chrome su Windows",
    });
    expect(created.statusCode).toBe(201);
    const newKey = created.json().id as string;
    expect(created.json().status).toBe("pending");
    expect(await copyRecipients(id)).toEqual([keys.get(lead.id)!, "recovery"].sort());
    expect((await reveal(id, who)).statusCode).toBe(404);

    const entry = (await pendingOf(lead)).find((i) => i.personKey.id === newKey)!;
    expect(entry.personKey.device).toBe("Chrome su Windows");
    const res = await req("POST", `/api/vault/pending/${newKey}/confirm`, lead.session, {
      copies: [{ credentialId: id, wrappedKey: envelope(), keyVersion: entry.credentials.find((c) => c.id === id)!.keyVersion }],
      actorProof: await proof(lead),
    });
    expect(res.statusCode).toBe(200);
    expect((await reveal(id, who)).statusCode).toBe(200);
  });
});

describe("recupero", () => {
  /** Chiede una sfida con la sessione data e la apre col kit: la prova di possesso. */
  async function proofFor(who: Person, kitText = kit.kitText): Promise<{ challengeId: string; proof: string }> {
    const res = await req("POST", "/api/vault/recovery/challenge", who.session);
    expect(res.statusCode).toBe(201);
    const { challengeId, wrapped } = res.json();
    return { challengeId, proof: await openRecoveryChallenge(wrapped, await parseRecoveryKit(kitText), challengeId) };
  }

  async function recoveryEvents(userIds: string[]) {
    return testDb.db
      .select()
      .from(securityEvents)
      .where(and(eq(securityEvents.kind, "vault_recovery_used"), inArray(securityEvents.userId, userIds)));
  }

  it("la sfida: solo l'hash del segreto in DB, legato a chi la chiede e alla sua sessione, 5 minuti", async () => {
    const res = await req("POST", "/api/vault/recovery/challenge", admin.session);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const proof = await openRecoveryChallenge(body.wrapped, await parseRecoveryKit(kit.kitText), body.challengeId);
    const [row] = await testDb.db
      .select()
      .from(vaultRecoveryChallenges)
      .where(eq(vaultRecoveryChallenges.id, body.challengeId));
    expect(row).toMatchObject({ userId: admin.id, usedAt: null });
    expect(row!.secretHash).not.toContain(proof);
    expect(JSON.stringify(row)).not.toContain(proof);
    const ttl = row!.expiresAt.getTime() - row!.createdAt.getTime();
    expect(ttl).toBeGreaterThan(4 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
    // Non full admin → 403; PAT → 403 session_required.
    expect((await req("POST", "/api/vault/recovery/challenge", lead.session)).statusCode).toBe(403);
    expect((await req("POST", "/api/vault/recovery/challenge", lead.pat)).json()).toMatchObject({
      code: "session_required",
    });
  });

  it("elenco col kit: con la prova, tutte le attese con la copia di recupero; la prova non si consuma", async () => {
    const who = await person("recupero-elenco", "developer");
    const pendingKey = await key(who.id, "pending");
    // Una credenziale che nessuna persona apre: la copia di recupero c'è sempre.
    const id = await seedCredential({ readers: [who.id], copiesFor: [] });
    const proof = await proofFor(admin);
    const res = await req("POST", "/api/vault/recovery/pending", admin.session, proof);
    expect(res.statusCode).toBe(200);
    const entry = (res.json().items as { personKey: { id: string }; credentials: { id: string; wrappedKey: string }[] }[]).find(
      (i) => i.personKey.id === pendingKey,
    )!;
    const [recoveryCopy] = await testDb.db
      .select({ wrappedKey: credentialKeyCopies.wrappedKey })
      .from(credentialKeyCopies)
      .where(and(eq(credentialKeyCopies.credentialId, id), eq(credentialKeyCopies.recipientId, "recovery")));
    expect(entry.credentials).toEqual([expect.objectContaining({ id, wrappedKey: recoveryCopy!.wrappedKey })]);
    // Rileggibile con la stessa prova.
    expect((await req("POST", "/api/vault/recovery/pending", admin.session, proof)).statusCode).toBe(200);

    // Senza una prova valida → 403 recovery_proof_invalid.
    const wrong = await req("POST", "/api/vault/recovery/pending", admin.session, {
      challengeId: proof.challengeId,
      proof: Buffer.alloc(32, 1).toString("base64url"),
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ code: "recovery_proof_invalid" });
    expect((await req("POST", "/api/vault/recovery/pending", lead.session, proof)).statusCode).toBe(403);
  });

  it("conferma col kit: copie salvate anche senza essere lettori, evento di sicurezza e avviso agli ALTRI full admin", async () => {
    const who = await person("recupero", "developer");
    const pendingKey = await key(who.id, "pending");
    const id = await seedCredential({ readers: [who.id], copiesFor: [] });
    const listProof = await proofFor(admin);
    const entry = (await req("POST", "/api/vault/recovery/pending", admin.session, listProof))
      .json()
      .items.find((i: { personKey: { id: string } }) => i.personKey.id === pendingKey);
    const copies = [
      {
        credentialId: id,
        wrappedKey: envelope(),
        keyVersion: entry.credentials.find((c: { id: string }) => c.id === id).keyVersion,
      },
    ];

    // Un non full admin, anche con credentials.share, non usa il kit.
    expect(
      (await req("POST", `/api/vault/recovery/confirm/${pendingKey}`, lead.session, { ...listProof, copies: [] })).statusCode,
    ).toBe(403);

    // La stessa prova dell'elenco vale ancora (non consumata) e la conferma la consuma.
    const res = await req("POST", `/api/vault/recovery/confirm/${pendingKey}`, admin.session, { ...listProof, copies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "confirmed", saved: [id], skipped: [] });
    const row = await keyRow(pendingKey);
    expect(row).toMatchObject({ status: "confirmed", confirmedByUserId: admin.id });
    expect(row.confirmedAt).toBeInstanceOf(Date);
    expect((await reveal(id, who)).statusCode).toBe(200);
    const [challenge] = await testDb.db
      .select()
      .from(vaultRecoveryChallenges)
      .where(eq(vaultRecoveryChallenges.id, listProof.challengeId));
    expect(challenge!.usedAt).toBeInstanceOf(Date);

    expect(await recoveryEvents([admin.id, who.id])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: admin.id, actorUserId: admin.id }),
        expect.objectContaining({ userId: who.id, actorUserId: admin.id, actorEmail: "admin@example.com" }),
      ]),
    );
    const inbox2 = await listInbox(testDb.db, { userId: admin2.id, lang: "it" });
    expect(inbox2.items.filter((i) => i.kind === "security.alert")).toHaveLength(1);
    expect(inbox2.items[0]!.text).toContain("admin@example.com");
    const inbox1 = await listInbox(testDb.db, { userId: admin.id, lang: "it" });
    expect(inbox1.items.filter((i) => i.kind === "security.alert")).toHaveLength(0);
  });

  /** Una credenziale letta da `userId` (con la sola copia di recupero) e la copia da passargli col kit. */
  async function recoveryCopyFor(userId: string) {
    const credentialId = await seedCredential({ readers: [userId], copiesFor: [] });
    return [{ credentialId, wrappedKey: envelope(), keyVersion: await keyVersionOf(credentialId) }];
  }

  it("anche col kit nessuno conferma «a vuoto»: senza copie → 403 nothing_to_confirm", async () => {
    const target = await key((await person("vuota")).id, "pending");
    const res = await req("POST", `/api/vault/recovery/confirm/${target}`, admin.session, {
      ...(await proofFor(admin)),
      copies: [],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "nothing_to_confirm" });
    expect((await keyRow(target)).status).toBe("pending");
  });

  describe("prova non valida → 403 recovery_proof_invalid e nulla cambia", () => {
    async function expectRefused(who: Person, personKeyId: string, body: Record<string, unknown>) {
      const eventsBefore = (await recoveryEvents([who.id])).length;
      const res = await req("POST", `/api/vault/recovery/confirm/${personKeyId}`, who.session, { copies: [], ...body });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "recovery_proof_invalid" });
      expect((await keyRow(personKeyId)).status).toBe("pending");
      expect(await recoveryEvents([who.id])).toHaveLength(eventsBefore);
    }

    it("sfida inesistente, segreto sbagliato, prova aperta con un ALTRO kit", async () => {
      const target = await key((await person("bersaglio")).id, "pending");
      await expectRefused(admin, target, { challengeId: randomUUID(), proof: Buffer.alloc(32).toString("base64url") });
      const { challengeId } = await proofFor(admin);
      await expectRefused(admin, target, { challengeId, proof: Buffer.alloc(32, 7).toString("base64url") });
      await expectRefused(admin, target, { challengeId, proof: "corta" });
      // Un kit qualsiasi (non quello dell'istanza) non apre la sfida.
      const res = await req("POST", "/api/vault/recovery/challenge", admin.session);
      const other = await parseRecoveryKit((await generateRecoveryKit()).kitText);
      await expect(openRecoveryChallenge(res.json().wrapped, other, res.json().challengeId)).rejects.toThrow();
      // Senza prova: il corpo non valida.
      const missing = await req("POST", `/api/vault/recovery/confirm/${target}`, admin.session, { copies: [] });
      expect(missing.statusCode).toBe(400);
      expect((await keyRow(target)).status).toBe("pending");
    });

    it("scaduta", async () => {
      const target = await key((await person("scaduta")).id, "pending");
      const proof = await proofFor(admin);
      await testDb.db
        .update(vaultRecoveryChallenges)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(vaultRecoveryChallenges.id, proof.challengeId));
      await expectRefused(admin, target, proof);
    });

    it("già usata (uso singolo per conferma)", async () => {
      const firstPerson = await person("primo", "developer");
      const first = await key(firstPerson.id, "pending");
      const second = await key((await person("secondo")).id, "pending");
      const proof = await proofFor(admin);
      const copies = await recoveryCopyFor(firstPerson.id);
      expect((await req("POST", `/api/vault/recovery/confirm/${first}`, admin.session, { ...proof, copies })).statusCode).toBe(200);
      await expectRefused(admin, second, proof);
    });

    it("di un'altra sessione, o di un altro full admin", async () => {
      const targetPerson = await person("altra-sessione", "developer");
      const target = await key(targetPerson.id, "pending");
      const copies = await recoveryCopyFor(targetPerson.id);
      const proof = await proofFor(admin);
      const otherSession = { ...admin, session: { cookie: await fullSessionCookie(app, admin.id) } };
      await expectRefused(otherSession, target, proof);
      await expectRefused(admin2, target, proof);
      // La stessa prova, nella sessione giusta, vale ancora: i rifiuti non l'hanno consumata.
      expect((await req("POST", `/api/vault/recovery/confirm/${target}`, admin.session, { ...proof, copies })).statusCode).toBe(200);
    });

    it("login rubato: un full admin senza kit si crea una chiave e prova a confermarsela col recupero → 403", async () => {
      const thief = await person("ladro");
      await testDb.db.update(users).set({ role: "admin" }).where(eq(users.id, thief.id));
      const [passkey] = await testDb.db
        .insert(userPasskeys)
        .values({ userId: thief.id, credentialId: randomBytes(16).toString("base64url"), publicKey: "pk", name: "P" })
        .returning({ id: userPasskeys.id });
      const created = await req("POST", "/api/vault/keys", thief.session, {
        publicKey: publicJwk(),
        seals: [{ passkeyId: passkey!.id, sealedPrivateKey: envelope() }],
        device: "Firefox su Linux",
      });
      expect(created.statusCode).toBe(201);
      const ownKey = created.json().id as string;
      expect(created.json().status).toBe("pending");
      // Può chiedere una sfida, ma senza il kit non sa aprirla.
      const challenge = await req("POST", "/api/vault/recovery/challenge", thief.session);
      expect(challenge.statusCode).toBe(201);
      await expectRefused(thief, ownKey, {
        challengeId: challenge.json().challengeId,
        proof: randomBytes(32).toString("base64url"),
      });
      // Né l'elenco col kit.
      const list = await req("POST", "/api/vault/recovery/pending", thief.session, {
        challengeId: challenge.json().challengeId,
        proof: randomBytes(32).toString("base64url"),
      });
      expect(list.statusCode).toBe(403);
    });
  });

  it("col kit un full admin conferma anche la PROPRIA chiave (unica uscita di chi ha perso le passkey)", async () => {
    const ownKey = await key(admin2.id, "pending");
    const res = await req("POST", `/api/vault/recovery/confirm/${ownKey}`, admin2.session, {
      ...(await proofFor(admin2)),
      copies: await recoveryCopyFor(admin2.id),
    });
    expect(res.statusCode).toBe(200);
    expect((await keyRow(ownKey)).status).toBe("confirmed");
  });
});
