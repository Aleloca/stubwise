import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  credentialKeyCopies,
  credentialReaders,
  credentials,
  projectMembers,
  roles,
  users,
  vaultPersonKeys,
  vaultSettings,
  type Db,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  canReadNow,
  currentPersonKey,
  effectiveReaderUserIds,
  pendingFor,
  purgeStaleCopies,
  recipientsFor,
  VaultNotActiveError,
} from "./readers.js";

let testDb: TestDb;
let db: Db;

/** Gli unici full admin del file: uno con chiave confermata, uno senza chiave. */
let adminWithKey: string;
let adminKeyId: string;
let adminWithoutKey: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  adminWithKey = await newUser("admin");
  adminKeyId = await newKey(adminWithKey, "confirmed");
  adminWithoutKey = await newUser("admin");
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

async function newUser(role: "admin" | "member" = "member"): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `vault-${randomUUID()}@example.com`, passwordHash: "x", role })
    .returning({ id: users.id });
  return row!.id;
}

async function roleId(presetKey: string): Promise<string> {
  const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, presetKey));
  return row!.id;
}

async function member(projectId: string, userId: string, presetKey: string): Promise<void> {
  const id = await roleId(presetKey);
  await db
    .insert(projectMembers)
    .values({ projectId, userId, roleId: id })
    .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { roleId: id } });
}

async function newProject(): Promise<string> {
  return (await seedRepository(db)).projectId;
}

async function newCredential(projectId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(credentials).values({ id, projectId, service: "Hetzner", passwordCiphertext: "c" });
  return id;
}

async function newKey(userId: string, status: "pending" | "confirmed"): Promise<string> {
  const [row] = await db
    .insert(vaultPersonKeys)
    .values({ userId, publicKey: `pub-${userId}`, status })
    .returning({ id: vaultPersonKeys.id });
  return row!.id;
}

async function copy(credentialId: string, recipientId: string): Promise<void> {
  await db.insert(credentialKeyCopies).values({ credentialId, recipientId, wrappedKey: "w" });
}

async function copiesOf(credentialId: string): Promise<string[]> {
  const rows = await db
    .select({ r: credentialKeyCopies.recipientId })
    .from(credentialKeyCopies)
    .where(eq(credentialKeyCopies.credentialId, credentialId));
  return rows.map((row) => row.r).sort();
}

const sorted = (ids: string[]) => [...ids].sort();

describe("effectiveReaderUserIds", () => {
  it("lettori diretti e via ruolo, solo se membri; i full admin sempre", async () => {
    const projectId = await newProject();
    const credentialId = await newCredential(projectId);
    const direct = await newUser();
    const directNotMember = await newUser();
    const developer = await newUser();
    const legacy = await newUser();
    await member(projectId, direct, "viewer");
    await member(projectId, developer, "developer");
    await member(projectId, legacy, "legacy_member");
    await db.insert(credentialReaders).values([
      { credentialId, userId: direct },
      { credentialId, userId: directNotMember },
      { credentialId, roleId: await roleId("developer") },
    ]);

    expect(sorted(await effectiveReaderUserIds(db, credentialId))).toEqual(
      sorted([adminWithKey, adminWithoutKey, direct, developer]),
    );
  });

  it("un membro che perde il ruolo invitato, o esce dal progetto, smette di leggere", async () => {
    const projectId = await newProject();
    const credentialId = await newCredential(projectId);
    const developer = await newUser();
    const leaver = await newUser();
    await member(projectId, developer, "developer");
    await member(projectId, leaver, "viewer");
    await db.insert(credentialReaders).values([
      { credentialId, roleId: await roleId("developer") },
      { credentialId, userId: leaver },
    ]);
    expect(await effectiveReaderUserIds(db, credentialId)).toEqual(
      expect.arrayContaining([developer, leaver]),
    );

    await member(projectId, developer, "viewer");
    await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, leaver)));

    expect(sorted(await effectiveReaderUserIds(db, credentialId))).toEqual(
      sorted([adminWithKey, adminWithoutKey]),
    );
  });

  it("l'invito a un ruolo vale solo per i membri di QUEL progetto", async () => {
    const projectId = await newProject();
    const other = await newProject();
    const credentialId = await newCredential(projectId);
    const developerElsewhere = await newUser();
    await member(other, developerElsewhere, "developer");
    await db.insert(credentialReaders).values({ credentialId, roleId: await roleId("developer") });
    expect(await effectiveReaderUserIds(db, credentialId)).not.toContain(developerElsewhere);
  });

  it("una credenziale inesistente non ha lettori, nemmeno i full admin", async () => {
    expect(await effectiveReaderUserIds(db, randomUUID())).toEqual([]);
  });
});

describe("currentPersonKey", () => {
  it("restituisce l'unica chiave viva, null se restano solo superate o rifiutate", async () => {
    const userId = await newUser();
    expect(await currentPersonKey(db, userId)).toBeNull();
    const keyId = await newKey(userId, "pending");
    expect(await currentPersonKey(db, userId)).toEqual({
      id: keyId,
      publicKey: `pub-${userId}`,
      status: "pending",
    });
    await db.update(vaultPersonKeys).set({ status: "superseded" }).where(eq(vaultPersonKeys.id, keyId));
    await db.insert(vaultPersonKeys).values({ userId, publicKey: "x", status: "rejected" });
    expect(await currentPersonKey(db, userId)).toBeNull();
  });
});

describe("canReadNow e pendingFor", () => {
  it("lettore con chiave confermata e copia: legge; pending o senza copia: in attesa", async () => {
    const projectId = await newProject();
    const credentialId = await newCredential(projectId);
    const ready = await newUser();
    const pending = await newUser();
    const noCopy = await newUser();
    const noKey = await newUser();
    for (const u of [ready, pending, noCopy, noKey]) {
      await member(projectId, u, "viewer");
      await db.insert(credentialReaders).values({ credentialId, userId: u });
    }
    const readyKey = await newKey(ready, "confirmed");
    const pendingKey = await newKey(pending, "pending");
    const noCopyKey = await newKey(noCopy, "confirmed");
    await copy(credentialId, readyKey);
    // Una copia per una chiave ancora pending non basta a leggere.
    await copy(credentialId, pendingKey);
    await copy(credentialId, adminKeyId);

    expect(await canReadNow(db, ready, credentialId)).toBe(true);
    expect(await canReadNow(db, adminWithKey, credentialId)).toBe(true);
    expect(await canReadNow(db, pending, credentialId)).toBe(false);
    expect(await canReadNow(db, noCopy, credentialId)).toBe(false);
    expect(await canReadNow(db, noKey, credentialId)).toBe(false);
    expect(await canReadNow(db, adminWithoutKey, credentialId)).toBe(false);

    const waiting = await pendingFor(db, credentialId);
    expect(waiting.map((p) => p.userId).sort()).toEqual(sorted([pending, noCopy]));
    expect(waiting.find((p) => p.userId === pending)).toMatchObject({
      personKeyId: pendingKey,
      status: "pending",
    });
    expect(waiting.find((p) => p.userId === noCopy)).toMatchObject({
      personKeyId: noCopyKey,
      status: "confirmed",
    });
  });

  it("Review Focus 1: chi perde il ruolo non legge più, anche con la copia ancora in DB", async () => {
    const projectId = await newProject();
    const credentialId = await newCredential(projectId);
    const developer = await newUser();
    await member(projectId, developer, "developer");
    await db.insert(credentialReaders).values({ credentialId, roleId: await roleId("developer") });
    const keyId = await newKey(developer, "confirmed");
    await copy(credentialId, keyId);
    expect(await canReadNow(db, developer, credentialId)).toBe(true);

    await member(projectId, developer, "viewer");

    expect(await copiesOf(credentialId)).toEqual([keyId]);
    expect(await canReadNow(db, developer, credentialId)).toBe(false);
  });
});

describe("recipientsFor", () => {
  it("cassaforte non attivata: VaultNotActiveError", async () => {
    const projectId = await newProject();
    await expect(recipientsFor(db, { projectId, creatorUserId: adminWithKey })).rejects.toBeInstanceOf(
      VaultNotActiveError,
    );
  });

  it("nuova credenziale: il creatore e i full admin con chiave confermata, più il recupero", async () => {
    await db.insert(vaultSettings).values({ recoveryPublicKey: "recovery-pub" }).onConflictDoNothing();
    const projectId = await newProject();
    const creator = await newUser();
    await member(projectId, creator, "project_lead");
    const creatorKey = await newKey(creator, "confirmed");

    const result = await recipientsFor(db, { projectId, creatorUserId: creator });
    expect(result.recoveryPublicKey).toBe("recovery-pub");
    expect(result.people.map((p) => p.personKeyId).sort()).toEqual(sorted([creatorKey, adminKeyId]));
    expect(result.people.find((p) => p.userId === creator)).toMatchObject({
      publicKey: `pub-${creator}`,
      status: "confirmed",
    });
    expect(result.people.every((p) => p.email.endsWith("@example.com"))).toBe(true);

    // Un creatore con la chiave ancora in attesa non è fra i destinatari.
    const newcomer = await newUser();
    await newKey(newcomer, "pending");
    const without = await recipientsFor(db, { projectId, creatorUserId: newcomer });
    expect(without.people.map((p) => p.userId)).toEqual([adminWithKey]);
  });

  it("credenziale esistente: i lettori effettivi con chiave confermata", async () => {
    await db.insert(vaultSettings).values({ recoveryPublicKey: "recovery-pub" }).onConflictDoNothing();
    const projectId = await newProject();
    const credentialId = await newCredential(projectId);
    const confirmed = await newUser();
    const pending = await newUser();
    const outsider = await newUser();
    for (const u of [confirmed, pending]) {
      await member(projectId, u, "viewer");
      await db.insert(credentialReaders).values({ credentialId, userId: u });
    }
    // Invitato ma non membro: non è un lettore effettivo.
    await db.insert(credentialReaders).values({ credentialId, userId: outsider });
    const confirmedKey = await newKey(confirmed, "confirmed");
    await newKey(pending, "pending");
    await newKey(outsider, "confirmed");

    const result = await recipientsFor(db, credentialId);
    expect(result.people.map((p) => p.personKeyId).sort()).toEqual(sorted([confirmedKey, adminKeyId]));
  });
});

describe("purgeStaleCopies", () => {
  it("cancella le copie di chi non legge più, lascia recupero, lettori e altri progetti", async () => {
    const projectId = await newProject();
    const otherProject = await newProject();
    const credentialId = await newCredential(projectId);
    const otherCredential = await newCredential(otherProject);
    const staying = await newUser();
    const demoted = await newUser();
    await member(projectId, staying, "viewer");
    await member(projectId, demoted, "developer");
    await db.insert(credentialReaders).values([
      { credentialId, userId: staying },
      { credentialId, roleId: await roleId("developer") },
    ]);
    const stayingKey = await newKey(staying, "confirmed");
    const demotedKey = await newKey(demoted, "confirmed");
    for (const r of [stayingKey, demotedKey, adminKeyId, "recovery"]) await copy(credentialId, r);
    // Nell'altro progetto `demoted` non è nemmeno membro: la sua copia lì non
    // si tocca, perché la purga è per progetto.
    await copy(otherCredential, demotedKey);

    expect(await purgeStaleCopies(db, projectId)).toBe(0);

    await member(projectId, demoted, "viewer");
    expect(await purgeStaleCopies(db, projectId)).toBe(1);
    expect(await copiesOf(credentialId)).toEqual(sorted([stayingKey, adminKeyId, "recovery"]));
    expect(await copiesOf(otherCredential)).toEqual([demotedKey]);
  });

  it("cancella le copie di una chiave superata, anche di un lettore", async () => {
    const projectId = await newProject();
    const credentialId = await newCredential(projectId);
    const reader = await newUser();
    await member(projectId, reader, "viewer");
    await db.insert(credentialReaders).values({ credentialId, userId: reader });
    const oldKey = await newKey(reader, "confirmed");
    await copy(credentialId, oldKey);
    await db.update(vaultPersonKeys).set({ status: "superseded" }).where(eq(vaultPersonKeys.id, oldKey));
    await newKey(reader, "pending");

    expect(await purgeStaleCopies(db, projectId)).toBe(1);
    expect(await copiesOf(credentialId)).toEqual([]);
  });
});
