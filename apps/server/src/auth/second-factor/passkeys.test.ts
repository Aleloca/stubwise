import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessions, userPasskeys, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { createSession } from "../session.js";
import { SoftAuthenticator } from "../../test/webauthn.js";
import {
  authenticationOptions,
  finishAuthentication,
  finishRegistration,
  passkeyRp,
  registrationOptions,
} from "./passkeys.js";

const RP = passkeyRp("https://stubwise.example.com");

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

async function newUser(): Promise<{ id: string; email: string; sessionId: string }> {
  const email = `pk-${randomBytes(4).toString("hex")}@example.com`;
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  const { id: sessionId } = await createSession(db, row!.id, { stage: "full" });
  return { id: row!.id, email, sessionId };
}

async function challengeOf(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ c: sessions.webauthnChallenge })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row?.c ?? null;
}

/** Utente con una passkey registrata dalla registrazione VERA. */
async function userWithPasskey() {
  const user = await newUser();
  const authenticator = new SoftAuthenticator(RP);
  const options = await registrationOptions(db, user.sessionId, user, RP);
  const created = await finishRegistration(
    db,
    user.sessionId,
    user.id,
    "Portatile",
    authenticator.register(options),
    RP,
  );
  if (!created) throw new Error("registrazione di preparazione fallita");
  return { ...user, authenticator, passkeyId: created.id };
}

describe("passkeyRp", () => {
  it("rpID = hostname, origin = origin dell'URL pubblico (porta compresa)", () => {
    expect(passkeyRp("https://stubwise.example.com")).toEqual({
      rpID: "stubwise.example.com",
      rpName: "Stubwise",
      origin: "https://stubwise.example.com",
    });
    expect(passkeyRp("http://localhost:5173")).toEqual({
      rpID: "localhost",
      rpName: "Stubwise",
      origin: "http://localhost:5173",
    });
  });
});

describe("registrazione", () => {
  it("salva la passkey (chiave pubblica, contatore, nome) e consuma la challenge", async () => {
    const user = await newUser();
    const authenticator = new SoftAuthenticator(RP);
    const options = await registrationOptions(db, user.sessionId, user, RP);
    expect(options.rp).toEqual({ id: RP.rpID, name: "Stubwise" });
    expect(await challengeOf(user.sessionId)).toBe(options.challenge);

    const created = await finishRegistration(
      db,
      user.sessionId,
      user.id,
      "  Telefono  ",
      authenticator.register(options),
      RP,
    );
    expect(created).not.toBeNull();
    const [row] = await db.select().from(userPasskeys).where(eq(userPasskeys.id, created!.id));
    expect(row).toMatchObject({
      userId: user.id,
      credentialId: authenticator.credentialId,
      publicKey: authenticator.publicKey,
      counter: 0,
      transports: ["internal"],
      name: "Telefono",
    });
    expect(await challengeOf(user.sessionId)).toBeNull();
  });

  it("le opzioni escludono le passkey già registrate", async () => {
    const user = await userWithPasskey();
    const options = await registrationOptions(db, user.sessionId, user, RP);
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([user.authenticator.credentialId]);
  });

  it("challenge riusata: la seconda registrazione è rifiutata", async () => {
    const user = await newUser();
    const options = await registrationOptions(db, user.sessionId, user, RP);
    const first = new SoftAuthenticator(RP);
    expect(
      await finishRegistration(db, user.sessionId, user.id, "a", first.register(options), RP),
    ).not.toBeNull();
    const second = new SoftAuthenticator(RP);
    expect(
      await finishRegistration(db, user.sessionId, user.id, "b", second.register(options), RP),
    ).toBeNull();
  });

  it("origin diversa: rifiutata, e la challenge è comunque consumata", async () => {
    const user = await newUser();
    const options = await registrationOptions(db, user.sessionId, user, RP);
    const authenticator = new SoftAuthenticator(RP);
    expect(
      await finishRegistration(
        db,
        user.sessionId,
        user.id,
        "x",
        authenticator.register(options, { origin: "https://evil.example.com" }),
        RP,
      ),
    ).toBeNull();
    expect(await challengeOf(user.sessionId)).toBeNull();
    expect(await db.select().from(userPasskeys).where(eq(userPasskeys.userId, user.id))).toEqual(
      [],
    );
  });
});

describe("uso di una passkey", () => {
  it("firma valida: vera, aggiorna contatore e ultimo uso, consuma la challenge", async () => {
    const user = await userWithPasskey();
    const options = await authenticationOptions(db, user.sessionId, user.id, RP);
    expect(options.rpId).toBe(RP.rpID);
    expect(options.allowCredentials?.map((c) => c.id)).toEqual([user.authenticator.credentialId]);
    expect(await challengeOf(user.sessionId)).toBe(options.challenge);

    expect(
      await finishAuthentication(
        db,
        user.sessionId,
        user.id,
        user.authenticator.assert(options),
        RP,
      ),
    ).toBe(true);
    const [row] = await db.select().from(userPasskeys).where(eq(userPasskeys.id, user.passkeyId));
    expect(row!.counter).toBe(1);
    expect(row!.lastUsedAt).toBeInstanceOf(Date);
    expect(await challengeOf(user.sessionId)).toBeNull();
  });

  it("challenge riusata: la seconda firma con la stessa challenge è rifiutata", async () => {
    const user = await userWithPasskey();
    const options = await authenticationOptions(db, user.sessionId, user.id, RP);
    const ok = user.authenticator.assert(options);
    expect(await finishAuthentication(db, user.sessionId, user.id, ok, RP)).toBe(true);
    // Anche con un contatore più alto e una firma nuova, la challenge è andata.
    const again = user.authenticator.assert(options);
    expect(await finishAuthentication(db, user.sessionId, user.id, again, RP)).toBe(false);
  });

  it("origin diversa: rifiutata, e la challenge è comunque consumata", async () => {
    const user = await userWithPasskey();
    const options = await authenticationOptions(db, user.sessionId, user.id, RP);
    const wrong = user.authenticator.assert(options, { origin: "https://evil.example.com" });
    expect(await finishAuthentication(db, user.sessionId, user.id, wrong, RP)).toBe(false);
    expect(await challengeOf(user.sessionId)).toBeNull();
    // La firma giusta dopo non trova più la challenge.
    const right = user.authenticator.assert(options);
    expect(await finishAuthentication(db, user.sessionId, user.id, right, RP)).toBe(false);
  });

  it("rpID diverso: rifiutato", async () => {
    const user = await userWithPasskey();
    const options = await authenticationOptions(db, user.sessionId, user.id, RP);
    const wrong = user.authenticator.assert(options, { rpID: "evil.example.com" });
    expect(await finishAuthentication(db, user.sessionId, user.id, wrong, RP)).toBe(false);
  });

  it("passkey di un altro utente: rifiutata anche se la firma è valida", async () => {
    const owner = await userWithPasskey();
    const other = await newUser();
    const options = await authenticationOptions(db, other.sessionId, other.id, RP);
    // L'altro utente non ha passkey: niente da offrire al browser.
    expect(options.allowCredentials).toEqual([]);
    const response = owner.authenticator.assert(options);
    expect(await finishAuthentication(db, other.sessionId, other.id, response, RP)).toBe(false);
    const [row] = await db.select().from(userPasskeys).where(eq(userPasskeys.id, owner.passkeyId));
    expect(row!.counter).toBe(0);
    expect(row!.lastUsedAt).toBeNull();
  });

  it("contatore che non sale (autenticatore clonato): rifiutato", async () => {
    const user = await userWithPasskey();
    const first = await authenticationOptions(db, user.sessionId, user.id, RP);
    expect(
      await finishAuthentication(db, user.sessionId, user.id, user.authenticator.assert(first), RP),
    ).toBe(true);
    user.authenticator.counter = 0; // il prossimo assert firma col contatore 1, già visto
    const second = await authenticationOptions(db, user.sessionId, user.id, RP);
    expect(
      await finishAuthentication(
        db,
        user.sessionId,
        user.id,
        user.authenticator.assert(second),
        RP,
      ),
    ).toBe(false);
  });

  it("nessuna challenge in corso: rifiutata", async () => {
    const user = await userWithPasskey();
    const response = user.authenticator.assert({ challenge: "mai-emessa" });
    expect(await finishAuthentication(db, user.sessionId, user.id, response, RP)).toBe(false);
  });

  it("risposta malformata: falsa, non un'eccezione", async () => {
    const user = await userWithPasskey();
    await authenticationOptions(db, user.sessionId, user.id, RP);
    const response = {
      id: user.authenticator.credentialId,
      rawId: user.authenticator.credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON: "x", authenticatorData: "y", signature: "z" },
    } as const;
    expect(await finishAuthentication(db, user.sessionId, user.id, response, RP)).toBe(false);
  });
});
