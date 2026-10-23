import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  credentialAccessLog,
  credentialKeyCopies,
  credentialReaders,
  credentials,
  projectMembers,
  projects,
  vaultPersonKeys,
  vaultSettings,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import {
  addMember,
  createUserWithPat,
  createUserWithSession,
  fullSessionCookie,
  seedUsers,
} from "../test/fixtures.js";

/**
 * Credenziali della cassaforte (Task 6 del piano): elenco, creazione,
 * password, mostra/copia, registro. Il server non vede crittografia vera:
 * password cifrate e copie della chiave sono buste opache, qui stringhe con
 * la forma realistica (`{ v: 1, ... }` in base64url).
 */

let testDb: TestDb;
let app: FastifyInstance;

type Headers = Record<string, string>;
interface Person {
  id: string;
  session: Headers;
  pat?: Headers;
  keyId?: string;
}

let admin: Person;
let lead: Person;
let dev: Person;
let outsider: Person;
let leaver: Person;
let stranger: Person;
let projectId: string;
let otherProjectId: string;
/** La chiave pubblica di recupero attuale (quella per cui si cifra la copia `recovery`). */
let recoveryKey = "chiave-di-recupero-non-ancora-attivata";

function publicJwk(): string {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
}

/** Una busta cifrata finta (forma di `@stubwise/vault-crypto`): per il server è opaca. */
function envelope(tag = "x"): string {
  return JSON.stringify({
    v: 1,
    iv: randomBytes(12).toString("base64url"),
    ct: randomBytes(32).toString("base64url"),
    tag,
  });
}

function req(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, headers: Headers, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function confirmedKey(userId: string): Promise<string> {
  const [row] = await testDb.db
    .insert(vaultPersonKeys)
    .values({ userId, publicKey: publicJwk(), status: "confirmed", confirmedAt: new Date() })
    .returning({ id: vaultPersonKeys.id });
  return row!.id;
}

async function newProject(slug: string): Promise<string> {
  const [row] = await testDb.db
    .insert(projects)
    .values({ name: slug, slug, ingestionKey: `${slug}-key` })
    .returning({ id: projects.id });
  return row!.id;
}

/** Le copie esatte per l'insieme dei destinatari di una risposta `recipients`. */
function copiesFor(recipients: { people: { personKeyId: string }[] }) {
  return [
    ...recipients.people.map((p) => ({ recipientId: p.personKeyId, wrappedKey: envelope() })),
    { recipientId: "recovery", wrappedKey: envelope() },
  ];
}

function createBody(id: string, copies: { recipientId: string; wrappedKey: string }[], service = "Hetzner") {
  return {
    id,
    service,
    label: "Account principale",
    url: "https://console.hetzner.cloud",
    username: "ops@example.com",
    notes: "Non cifrate",
    passwordCiphertext: envelope("password"),
    copies,
    recoveryPublicKey: recoveryKey,
  };
}

/** Inserisce una credenziale direttamente, coi lettori e le copie indicati. */
async function seedCredential(opts: {
  project: string;
  createdBy: string;
  readers?: string[];
  copiesFor?: string[];
  service?: string;
}): Promise<string> {
  const id = randomUUID();
  await testDb.db.insert(credentials).values({
    id,
    projectId: opts.project,
    service: opts.service ?? "Seed",
    passwordCiphertext: envelope("password"),
    createdByUserId: opts.createdBy,
    updatedByUserId: opts.createdBy,
  });
  for (const userId of opts.readers ?? []) {
    await testDb.db.insert(credentialReaders).values({ credentialId: id, userId, createdByUserId: opts.createdBy });
  }
  for (const recipientId of [...(opts.copiesFor ?? []), "recovery"]) {
    await testDb.db.insert(credentialKeyCopies).values({ credentialId: id, recipientId, wrappedKey: envelope() });
  }
  return id;
}

async function logRows(credentialId: string) {
  return testDb.db.select().from(credentialAccessLog).where(eq(credentialAccessLog.credentialId, credentialId));
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
  admin = { id: seeded.adminId, session: { cookie: seeded.adminCookie } };

  projectId = await newProject("cassaforte");
  otherProjectId = await newProject("altro");

  async function withPat(email: string, preset?: string, project = projectId): Promise<Person> {
    const user = await createUserWithPat(app, email);
    if (preset) await addMember(app, project, user.id, preset);
    return { id: user.id, pat: user.headers, session: { cookie: await fullSessionCookie(app, user.id) } };
  }
  lead = await withPat("lead@example.com", "project_lead");
  dev = await withPat("dev@example.com", "developer");
  await addMember(app, otherProjectId, dev.id, "developer");
  outsider = await withPat("outsider@example.com", "developer");
  leaver = await withPat("leaver@example.com", "developer");
  const s = await createUserWithSession(app, "stranger@example.com");
  stranger = { id: s.id, session: s.headers };
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

/** I test girano in ordine: prima della cassaforte attiva, poi dopo. */
describe("credenziali della cassaforte", () => {
  it("cassaforte non attivata: destinatari e creazione → 409 vault_not_active", async () => {
    const recipients = await req("GET", `/api/projects/${projectId}/credentials/recipients`, lead.pat!);
    expect(recipients.statusCode).toBe(409);
    expect(recipients.json()).toMatchObject({ code: "vault_not_active" });

    const created = await req(
      "POST",
      `/api/projects/${projectId}/credentials`,
      lead.pat!,
      createBody(randomUUID(), [{ recipientId: "recovery", wrappedKey: envelope() }]),
    );
    expect(created.statusCode).toBe(409);
    expect(created.json()).toMatchObject({ code: "vault_not_active" });
    expect(await testDb.db.select().from(credentials)).toHaveLength(0);
  });

  it("attivazione e chiavi confermate (direttamente in DB)", async () => {
    recoveryKey = publicJwk();
    await testDb.db
      .insert(vaultSettings)
      .values({ id: 1, recoveryPublicKey: recoveryKey, activatedByUserId: admin.id });
    admin.keyId = await confirmedKey(admin.id);
    lead.keyId = await confirmedKey(lead.id);
    dev.keyId = await confirmedKey(dev.id);
    outsider.keyId = await confirmedKey(outsider.id);
    leaver.keyId = await confirmedKey(leaver.id);
  });

  it("destinatari di una credenziale nuova: creatore e full admin con chiave confermata, più il recupero (PAT ammesso)", async () => {
    const res = await req("GET", `/api/projects/${projectId}/credentials/recipients`, lead.pat!);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.people.map((p: { personKeyId: string }) => p.personKeyId).sort()).toEqual(
      [admin.keyId, lead.keyId].sort(),
    );
    expect(typeof body.recoveryPublicKey).toBe("string");
  });

  it("destinatari: senza credentials.create → 403; progetto invisibile → 404", async () => {
    expect((await req("GET", `/api/projects/${projectId}/credentials/recipients`, dev.pat!)).statusCode).toBe(403);
    const hidden = await req("GET", `/api/projects/${projectId}/credentials/recipients`, stranger.session);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ code: "not_found" });
  });

  let credentialId: string;

  it("creazione via PAT con le copie ESATTE → 201, creatore lettore diretto, copie scritte", async () => {
    const recipients = (await req("GET", `/api/projects/${projectId}/credentials/recipients`, lead.pat!)).json();
    credentialId = randomUUID();
    const res = await req("POST", `/api/projects/${projectId}/credentials`, lead.pat!, createBody(credentialId, copiesFor(recipients)));
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain("passwordCiphertext");
    expect(res.body).not.toContain("wrappedKey");
    expect(res.json()).toMatchObject({
      id: credentialId,
      projectId,
      service: "Hetzner",
      label: "Account principale",
      access: "read",
      canEdit: true,
      canShare: true,
      createdByUserId: lead.id,
    });
    const readers = await testDb.db.select().from(credentialReaders).where(eq(credentialReaders.credentialId, credentialId));
    expect(readers).toEqual([expect.objectContaining({ userId: lead.id, roleId: null })]);
    const copies = await testDb.db
      .select({ recipientId: credentialKeyCopies.recipientId })
      .from(credentialKeyCopies)
      .where(eq(credentialKeyCopies.credentialId, credentialId));
    expect(copies.map((c) => c.recipientId).sort()).toEqual([admin.keyId!, lead.keyId!, "recovery"].sort());
  });

  it("creazione con un id già usato → 409 credential_exists, nulla cambia", async () => {
    const recipients = (await req("GET", `/api/projects/${projectId}/credentials/recipients`, lead.pat!)).json();
    const res = await req("POST", `/api/projects/${projectId}/credentials`, lead.pat!, createBody(credentialId, copiesFor(recipients), "Altro"));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "credential_exists" });
    const [row] = await testDb.db.select().from(credentials).where(eq(credentials.id, credentialId));
    expect(row!.service).toBe("Hetzner");
  });

  describe("Review Focus 2: destinatari non aggiornati → 409 recipients_changed, nessuna riga", () => {
    async function attempt(copies: { recipientId: string; wrappedKey: string }[]) {
      const id = randomUUID();
      const res = await req("POST", `/api/projects/${projectId}/credentials`, lead.pat!, createBody(id, copies));
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.code).toBe("recipients_changed");
      // I destinatari attuali, per riprovare senza un'altra lettura.
      expect(body.recipients.people.map((p: { personKeyId: string }) => p.personKeyId).sort()).toEqual(
        [admin.keyId, lead.keyId].sort(),
      );
      expect(await testDb.db.select().from(credentials).where(eq(credentials.id, id))).toHaveLength(0);
      expect(await testDb.db.select().from(credentialReaders).where(eq(credentialReaders.credentialId, id))).toHaveLength(0);
      expect(await testDb.db.select().from(credentialKeyCopies).where(eq(credentialKeyCopies.credentialId, id))).toHaveLength(0);
    }

    it("un destinatario in meno (l'admin, come se fosse arrivato dopo la lettura)", async () => {
      await attempt([
        { recipientId: lead.keyId!, wrappedKey: envelope() },
        { recipientId: "recovery", wrappedKey: envelope() },
      ]);
    });

    it("un destinatario in più (chi non legge)", async () => {
      await attempt([
        { recipientId: admin.keyId!, wrappedKey: envelope() },
        { recipientId: lead.keyId!, wrappedKey: envelope() },
        { recipientId: dev.keyId!, wrappedKey: envelope() },
        { recipientId: "recovery", wrappedKey: envelope() },
      ]);
    });

    it("senza la copia di recupero, o con un doppione", async () => {
      await attempt([
        { recipientId: admin.keyId!, wrappedKey: envelope() },
        { recipientId: lead.keyId!, wrappedKey: envelope() },
      ]);
      await attempt([
        { recipientId: admin.keyId!, wrappedKey: envelope() },
        { recipientId: lead.keyId!, wrappedKey: envelope() },
        { recipientId: lead.keyId!, wrappedKey: envelope() },
        { recipientId: "recovery", wrappedKey: envelope() },
      ]);
    });
  });

  it("la creazione aspetta una rigenerazione del kit in corso (vault_settings FOR UPDATE) e vede la chiave nuova", async () => {
    const recipients = (await req("GET", `/api/projects/${projectId}/credentials/recipients`, lead.pat!)).json();
    const id = randomUUID();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    // Come `POST /api/vault/recovery-key`: blocca la riga e cambia la chiave di recupero.
    const rotated = publicJwk();
    const rotation = testDb.db.transaction(async (tx) => {
      await tx.select().from(vaultSettings).for("update");
      locked();
      await held;
      await tx.update(vaultSettings).set({ recoveryPublicKey: rotated }).where(eq(vaultSettings.id, 1));
    });
    await isLocked;
    let settled = false;
    const creation = req(
      "POST",
      `/api/projects/${projectId}/credentials`,
      lead.pat!,
      createBody(id, copiesFor(recipients)),
    ).then((res) => {
      settled = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    release();
    await rotation;
    const res = await creation;
    // Le copie erano per la chiave di recupero VECCHIA: 409, e la risposta porta quella nuova.
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "recipients_changed", recipients: { recoveryPublicKey: rotated } });
    expect(await testDb.db.select().from(credentials).where(eq(credentials.id, id))).toHaveLength(0);
    recoveryKey = rotated;
  });

  it("una copia `recovery` per una chiave di recupero che non è quella attuale → 409, nessuna riga", async () => {
    const recipients = (await req("GET", `/api/projects/${projectId}/credentials/recipients`, lead.pat!)).json();
    const id = randomUUID();
    const res = await req("POST", `/api/projects/${projectId}/credentials`, lead.pat!, {
      ...createBody(id, copiesFor(recipients)),
      recoveryPublicKey: publicJwk(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "recipients_changed", recipients: { recoveryPublicKey: recoveryKey } });
    expect(await testDb.db.select().from(credentials).where(eq(credentials.id, id))).toHaveLength(0);
  });

  it("creazione: senza credentials.create → 403; progetto invisibile → 404; nessuna riga", async () => {
    const id = randomUUID();
    const body = createBody(id, [{ recipientId: "recovery", wrappedKey: envelope() }]);
    expect((await req("POST", `/api/projects/${projectId}/credentials`, dev.pat!, body)).statusCode).toBe(403);
    expect((await req("POST", `/api/projects/${projectId}/credentials`, stranger.session, body)).statusCode).toBe(404);
    expect(await testDb.db.select().from(credentials).where(eq(credentials.id, id))).toHaveLength(0);
  });

  it("elenco: chi non legge e non gestisce non vede nulla; chi gestisce vede tutto senza cifrati", async () => {
    const devList = await req("GET", `/api/projects/${projectId}/credentials`, dev.session);
    expect(devList.statusCode).toBe(200);
    expect(devList.json()).toEqual({ items: [] });

    const leadList = await req("GET", `/api/projects/${projectId}/credentials`, lead.pat!);
    expect(leadList.statusCode).toBe(200);
    expect(leadList.json().items).toEqual([expect.objectContaining({ id: credentialId, access: "read" })]);
    expect(leadList.body).not.toContain("passwordCiphertext");
    expect(leadList.body).not.toContain("wrappedKey");

    expect((await req("GET", `/api/projects/${projectId}/credentials`, stranger.session)).statusCode).toBe(404);
  });

  it("elenco: chi gestisce senza leggere la vede come `manage`", async () => {
    const id = await seedCredential({ project: projectId, createdBy: admin.id, copiesFor: [admin.keyId!] });
    const items = (await req("GET", `/api/projects/${projectId}/credentials`, lead.pat!)).json().items;
    expect(items).toContainEqual(expect.objectContaining({ id, access: "manage", canEdit: true, canShare: false }));
    await testDb.db.delete(credentials).where(eq(credentials.id, id));
  });

  let devReadable: string;
  let devPending: string;

  it("elenco: un lettore con la copia → read; senza copia → pending (canEdit solo se creatore)", async () => {
    devReadable = await seedCredential({
      project: projectId,
      createdBy: lead.id,
      readers: [dev.id],
      copiesFor: [admin.keyId!, dev.keyId!],
      service: "Aruba",
    });
    devPending = await seedCredential({
      project: projectId,
      createdBy: dev.id,
      readers: [dev.id],
      copiesFor: [admin.keyId!],
      service: "Brevo",
    });
    const items = (await req("GET", `/api/projects/${projectId}/credentials`, dev.session)).json().items;
    expect(items).toEqual([
      expect.objectContaining({ id: devReadable, access: "read", canEdit: false, canShare: false }),
      expect.objectContaining({ id: devPending, access: "pending", canEdit: true, canShare: false }),
    ]);
  });

  it("«le mie»: lette o in attesa, su tutti i progetti visibili", async () => {
    const elsewhere = await seedCredential({
      project: otherProjectId,
      createdBy: admin.id,
      readers: [dev.id],
      copiesFor: [dev.keyId!],
      service: "Cloudflare",
    });
    const res = await req("GET", "/api/vault/credentials", dev.pat!);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("passwordCiphertext");
    const items = res.json().items as { id: string; access: string; projectId: string }[];
    expect(items.map((i) => [i.id, i.access])).toEqual([
      [devReadable, "read"],
      [devPending, "pending"],
      [elsewhere, "read"],
    ]);
    // Chi non legge nulla: elenco vuoto.
    expect((await req("GET", "/api/vault/credentials", outsider.session)).json()).toEqual({ items: [] });
  });

  describe("mostra/copia (reveal)", () => {
    it("un lettore → 200 con password cifrata e la SUA copia, più una riga di registro", async () => {
      const res = await req("POST", `/api/credentials/${devReadable}/reveal`, dev.session, { action: "copy" });
      expect(res.statusCode).toBe(200);
      const [copy] = await testDb.db
        .select({ wrappedKey: credentialKeyCopies.wrappedKey })
        .from(credentialKeyCopies)
        .where(and(eq(credentialKeyCopies.credentialId, devReadable), eq(credentialKeyCopies.recipientId, dev.keyId!)));
      const [cred] = await testDb.db.select().from(credentials).where(eq(credentials.id, devReadable));
      expect(res.json()).toEqual({
        passwordCiphertext: cred!.passwordCiphertext,
        wrappedKey: copy!.wrappedKey,
        personKeyId: dev.keyId,
      });
      expect(await logRows(devReadable)).toEqual([
        expect.objectContaining({
          projectId,
          userId: dev.id,
          userEmail: "dev@example.com",
          action: "copy",
          credentialSnapshot: "Aruba",
        }),
      ]);
    });

    it("un PAT, anche di un lettore → 403 session_required, nessuna riga", async () => {
      const before = (await logRows(devReadable)).length;
      const res = await req("POST", `/api/credentials/${devReadable}/reveal`, dev.pat!, { action: "show" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "session_required" });
      expect(await logRows(devReadable)).toHaveLength(before);
    });

    it("un membro che non legge, uno in attesa, un estraneo → 404 not_found, nessuna riga", async () => {
      for (const [who, id] of [
        [outsider, devReadable],
        [dev, devPending],
        [stranger, devReadable],
      ] as const) {
        const before = (await logRows(id)).length;
        const res = await req("POST", `/api/credentials/${id}/reveal`, who.session, { action: "show" });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ code: "not_found" });
        expect(await logRows(id)).toHaveLength(before);
      }
      const unknown = await req("POST", `/api/credentials/${randomUUID()}/reveal`, dev.session, { action: "show" });
      expect(unknown.statusCode).toBe(404);
    });

    it("Review Focus 1: un lettore tolto dal progetto → 404 anche con la copia in DB, che poi si cancella", async () => {
      const id = await seedCredential({
        project: projectId,
        createdBy: lead.id,
        readers: [leaver.id],
        copiesFor: [leaver.keyId!],
      });
      expect((await req("POST", `/api/credentials/${id}/reveal`, leaver.session, { action: "show" })).statusCode).toBe(200);
      await testDb.db
        .delete(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, leaver.id)));
      const before = (await logRows(id)).length;
      const res = await req("POST", `/api/credentials/${id}/reveal`, leaver.session, { action: "show" });
      expect(res.statusCode).toBe(404);
      expect(await logRows(id)).toHaveLength(before);

      // L'elenco del progetto (prima operazione sulla cassaforte) pota la copia rimasta.
      await req("GET", `/api/projects/${projectId}/credentials`, lead.pat!);
      const left = await testDb.db
        .select()
        .from(credentialKeyCopies)
        .where(and(eq(credentialKeyCopies.credentialId, id), eq(credentialKeyCopies.recipientId, leaver.keyId!)));
      expect(left).toHaveLength(0);
    });
  });

  describe("modifica, password, eliminazione", () => {
    it("PATCH dei campi in chiaro: il creatore (senza credentials.edit) sì, un lettore qualsiasi no", async () => {
      const ok = await req("PATCH", `/api/credentials/${devPending}`, dev.pat!, { label: "Sola lettura", notes: null });
      expect(ok.statusCode).toBe(200);
      expect(ok.body).not.toContain("passwordCiphertext");
      expect(ok.json()).toMatchObject({ id: devPending, service: "Brevo", label: "Sola lettura", notes: null });
      const [row] = await testDb.db.select().from(credentials).where(eq(credentials.id, devPending));
      expect(row!.updatedByUserId).toBe(dev.id);

      const no = await req("PATCH", `/api/credentials/${devReadable}`, dev.pat!, { label: "x" });
      expect(no.statusCode).toBe(403);
      // Chi non la vede (non lettore, non gestore) → 404 come una risorsa invisibile.
      expect((await req("PATCH", `/api/credentials/${devReadable}`, outsider.pat!, { label: "x" })).statusCode).toBe(404);
    });

    it("destinatari di una credenziale esistente: credentials.edit o creatore", async () => {
      const res = await req("GET", `/api/credentials/${devReadable}/recipients`, lead.pat!);
      expect(res.statusCode).toBe(200);
      expect(res.json().people.map((p: { personKeyId: string }) => p.personKeyId).sort()).toEqual(
        [admin.keyId, dev.keyId].sort(),
      );
      expect((await req("GET", `/api/credentials/${devReadable}/recipients`, dev.pat!)).statusCode).toBe(403);
      expect((await req("GET", `/api/credentials/${devPending}/recipients`, dev.pat!)).statusCode).toBe(200);
    });

    it("PUT password sostituisce TUTTE le copie; con destinatari vecchi → 409 e nulla cambia", async () => {
      const [before] = await testDb.db.select().from(credentials).where(eq(credentials.id, devReadable));
      const stale = await req("PUT", `/api/credentials/${devReadable}/password`, lead.pat!, {
        passwordCiphertext: envelope("nuova"),
        copies: [{ recipientId: "recovery", wrappedKey: envelope() }],
        recoveryPublicKey: recoveryKey,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("recipients_changed");
      const [unchanged] = await testDb.db.select().from(credentials).where(eq(credentials.id, devReadable));
      expect(unchanged!.passwordCiphertext).toBe(before!.passwordCiphertext);

      const recipients = (await req("GET", `/api/credentials/${devReadable}/recipients`, lead.pat!)).json();
      const copies = copiesFor(recipients);
      const passwordCiphertext = envelope("nuova");
      const res = await req("PUT", `/api/credentials/${devReadable}/password`, lead.pat!, {
        passwordCiphertext,
        copies,
        recoveryPublicKey: recoveryKey,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("passwordCiphertext");
      const after = await testDb.db
        .select({ recipientId: credentialKeyCopies.recipientId, wrappedKey: credentialKeyCopies.wrappedKey })
        .from(credentialKeyCopies)
        .where(eq(credentialKeyCopies.credentialId, devReadable));
      expect(after.sort((a, b) => a.recipientId.localeCompare(b.recipientId))).toEqual(
        copies.sort((a, b) => a.recipientId.localeCompare(b.recipientId)),
      );
      const [row] = await testDb.db.select().from(credentials).where(eq(credentials.id, devReadable));
      expect(row!.passwordCiphertext).toBe(passwordCiphertext);
      expect(row!.updatedByUserId).toBe(lead.id);

      // Un lettore senza credentials.edit né creatore → 403.
      expect(
        (await req("PUT", `/api/credentials/${devReadable}/password`, dev.pat!, { passwordCiphertext, copies, recoveryPublicKey: recoveryKey }))
          .statusCode,
      ).toBe(403);
    });

    it("registro: credentials.edit/share o full admin; un developer no", async () => {
      const res = await req("GET", `/api/projects/${projectId}/credentials/log`, lead.pat!);
      expect(res.statusCode).toBe(200);
      expect(res.json().items[0]).toMatchObject({ credentialId: expect.any(String), userEmail: expect.any(String) });
      expect((await req("GET", `/api/projects/${projectId}/credentials/log`, admin.session)).statusCode).toBe(200);
      expect((await req("GET", `/api/projects/${projectId}/credentials/log`, dev.pat!)).statusCode).toBe(403);
      expect((await req("GET", `/api/projects/${projectId}/credentials/log`, stranger.session)).statusCode).toBe(404);
    });

    it("DELETE: un lettore qualsiasi no; credentials.edit sì, e il registro resta con la fotografia", async () => {
      expect((await req("DELETE", `/api/credentials/${devReadable}`, dev.pat!)).statusCode).toBe(403);
      const res = await req("DELETE", `/api/credentials/${devReadable}`, lead.pat!);
      expect(res.statusCode).toBe(204);
      expect(await testDb.db.select().from(credentials).where(eq(credentials.id, devReadable))).toHaveLength(0);
      const log = await testDb.db.select().from(credentialAccessLog).where(eq(credentialAccessLog.credentialSnapshot, "Aruba"));
      expect(log).toEqual([expect.objectContaining({ credentialId: null, userEmail: "dev@example.com" })]);
      expect((await req("DELETE", `/api/credentials/${devReadable}`, lead.pat!)).statusCode).toBe(404);
    });
  });
});
