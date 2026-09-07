import { randomBytes } from "node:crypto";
import { decrypt, googleAccounts, googleWorkspaces, oauthStates } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { loadGoogleAccountCredentials } from "@stubwise/google/credentials";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { signState } from "../services/google-oauth.js";
import { seedUsers } from "../test/fixtures.js";

/**
 * FLUSSO OAUTH E CASELLE GOOGLE PER UTENTE (Fase 6, Task 5).
 *
 * Quattro cose che questi test presidiano, e nessuna è verificabile guardando
 * solo lo status code:
 *
 * 1. **Lo `state` regge da solo.** Il callback è pubblico: manomettere la firma,
 *    rigiocare un nonce già speso o presentarne uno scaduto deve fallire PRIMA
 *    di qualunque chiamata a Google — e il fake `fetch` lo dimostra restando a
 *    zero chiamate.
 * 2. **Un rifiuto non lascia tracce.** Su `domain_mismatch` non deve esistere
 *    nessuna riga in `google_accounts`: si guarda il DB, non la risposta.
 * 3. **Il refresh token è cifrato e decifrabile SOLO con la chiave d'istanza.**
 *    Si legge la colonna grezza e si prova a decifrarla con un'altra chiave.
 * 4. **`user_id` è nel WHERE di ogni rotta.** Un altro utente prende 404, e la
 *    riga resta dov'era.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const PUBLIC_URL = "https://stubwise.example.com";
const CLIENT_SECRET = "GOCSPX-segreto-dell-app-oauth";
const REFRESH_TOKEN = "1//refresh-token-molto-segreto";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const FULL_SCOPES = `openid email ${GMAIL_SCOPE} ${CALENDAR_SCOPE}`;

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let adminId: string;
let memberId: string;

// ---------------------------------------------------------------------------
// Fake di Google: nessun test tocca la rete, e ogni chiamata è registrata.
// ---------------------------------------------------------------------------

interface GoogleCall {
  url: string;
  form: Record<string, string>;
}

/** Chiamate viste dal fake, nell'ordine: i test ci asseriscono sopra. */
let calls: GoogleCall[] = [];
/** Risposta del token endpoint per il prossimo scambio (mutata dai test). */
let tokenResponse: Record<string, unknown>;
/** Risposta di `userinfo` per il prossimo scambio. */
let userinfoResponse: Record<string, unknown>;
/** Se valorizzato, il token endpoint risponde con questo status e questo body. */
let tokenFailure: { status: number; body: unknown } | null = null;
/** Se valorizzato, la revoca fallisce così (per il test del best-effort). */
let revokeFailure: { status: number; body: unknown } | null = null;

const googleFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
  calls.push({ url, form });

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  if (url.startsWith("https://oauth2.googleapis.com/revoke")) {
    if (revokeFailure) return json(revokeFailure.status, revokeFailure.body);
    return new Response(null, { status: 200 });
  }
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    if (tokenFailure) return json(tokenFailure.status, tokenFailure.body);
    return json(200, tokenResponse);
  }
  if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) {
    return json(200, userinfoResponse);
  }
  throw new Error(`URL Google non prevista dal fake: ${url}`);
};

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: PUBLIC_URL,
    googleFetch,
    // Tetto alzato per non far scattare il rate limit del callback mentre i
    // test lo esercitano decine di volte dallo stesso "IP". Che il tetto ci sia
    // davvero è verificato a parte, con un'app costruita apposta.
    authRateLimit: { max: 1000, timeWindow: "1 minute" },
  });
  ({ adminCookie, memberCookie, adminId, memberId } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  await testDb.db.delete(googleAccounts);
  await testDb.db.delete(oauthStates);
  await testDb.db.delete(googleWorkspaces);
  calls = [];
  tokenFailure = null;
  revokeFailure = null;
  tokenResponse = {
    access_token: "ya29.access",
    expires_in: 3599,
    refresh_token: REFRESH_TOKEN,
    scope: FULL_SCOPES,
    token_type: "Bearer",
  };
  userinfoResponse = {
    sub: "115000000000000000001",
    email: "Mario.Rossi@Acme.com",
    email_verified: true,
    hd: "acme.com",
    name: "Mario Rossi",
  };
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function createWorkspace(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/settings/google-workspaces",
    headers: { cookie: adminCookie },
    payload: {
      name: "Acme",
      domains: ["acme.com"],
      clientId: "123.apps.googleusercontent.com",
      clientSecret: CLIENT_SECRET,
      ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(`creazione Workspace: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

/** Avvia il flusso e restituisce lo `state` estratto dalla URL di consenso. */
async function connect(workspaceId: string, cookie = memberCookie) {
  const res = await app.inject({
    method: "POST",
    url: "/api/me/google/connect",
    headers: { cookie },
    payload: { workspaceId },
  });
  return res;
}

async function stateFor(workspaceId: string, cookie = memberCookie): Promise<string> {
  const res = await connect(workspaceId, cookie);
  if (res.statusCode !== 200) throw new Error(`connect: ${res.statusCode} ${res.body}`);
  const url = new URL((res.json() as { authorizeUrl: string }).authorizeUrl);
  const state = url.searchParams.get("state");
  if (!state) throw new Error("state assente nella URL di consenso");
  return state;
}

function callback(state: string, code = "code-di-google") {
  return app.inject({
    method: "GET",
    url: `/api/me/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  });
}

/** L'esito letto dal `Location` del redirect. */
function outcomeOf(res: { headers: Record<string, unknown> }): string {
  const location = String(res.headers.location ?? "");
  return new URL(location, PUBLIC_URL).searchParams.get("google") ?? "";
}

async function accountRows() {
  return testDb.db.select().from(googleAccounts);
}

// ---------------------------------------------------------------------------
// GET /workspaces
// ---------------------------------------------------------------------------

describe("GET /api/me/google/workspaces", () => {
  it("elenca i Workspace a un operatore NON admin, col flag del segreto e senza clientId", async () => {
    const workspaceId = await createWorkspace();
    const res = await app.inject({
      method: "GET",
      url: "/api/me/google/workspaces",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Record<string, unknown>[];
    expect(list).toEqual([
      { id: workspaceId, name: "Acme", domains: ["acme.com"], clientSecretSet: true },
    ]);
  });

  it("un Workspace senza segreto resta in elenco ma marcato inutilizzabile", async () => {
    const workspaceId = await createWorkspace();
    await app.inject({
      method: "PATCH",
      url: `/api/settings/google-workspaces/${workspaceId}`,
      headers: { cookie: adminCookie },
      payload: { clientSecret: "" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/me/google/workspaces",
      headers: { cookie: memberCookie },
    });
    expect((res.json() as { clientSecretSet: boolean }[])[0]!.clientSecretSet).toBe(false);
  });

  it("401 senza sessione", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me/google/workspaces" });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /connect
// ---------------------------------------------------------------------------

describe("POST /api/me/google/connect", () => {
  it("compone la URL di consenso con offline+consent, gli scope di sola lettura e l'hd del Workspace", async () => {
    const workspaceId = await createWorkspace({ domains: ["acme.com", "sub.acme.com"] });
    const res = await connect(workspaceId);
    expect(res.statusCode).toBe(200);

    const url = new URL((res.json() as { authorizeUrl: string }).authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("hd")).toBe("acme.com");
    expect(url.searchParams.get("redirect_uri")).toBe(`${PUBLIC_URL}/api/me/google/callback`);
    expect(url.searchParams.get("scope")).toBe(FULL_SCOPES);
  });

  it("scrive una riga monouso in oauth_states, non ancora consumata e con scadenza a 10 minuti", async () => {
    const workspaceId = await createWorkspace();
    const before = Date.now();
    await connect(workspaceId);

    const [row] = await testDb.db.select().from(oauthStates);
    expect(row).toBeDefined();
    expect(row!.userId).toBe(memberId);
    expect(row!.workspaceId).toBe(workspaceId);
    expect(row!.consumedAt).toBeNull();
    const ttl = row!.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000 + 5_000);
  });

  it("404 su un Workspace inesistente, senza scrivere state", async () => {
    const res = await connect("2f4bd0f0-9c2a-4a1c-9f13-8b4d9a1e0000");
    expect(res.statusCode).toBe(404);
    expect(await testDb.db.select().from(oauthStates)).toHaveLength(0);
  });

  it("409 se il Workspace ha il client secret azzerato: meglio fermarsi prima del consenso", async () => {
    const workspaceId = await createWorkspace();
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/settings/google-workspaces/${workspaceId}`,
      headers: { cookie: adminCookie },
      payload: { clientSecret: "" },
    });
    expect(patched.statusCode).toBe(200);

    const res = await connect(workspaceId);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("workspace_secret_missing");
    expect(await testDb.db.select().from(oauthStates)).toHaveLength(0);
  });

  it("401 senza sessione", async () => {
    const workspaceId = await createWorkspace();
    const res = await app.inject({
      method: "POST",
      url: "/api/me/google/connect",
      payload: { workspaceId },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /callback — le tre difese dello state
// ---------------------------------------------------------------------------

describe("GET /api/me/google/callback — state non spendibile", () => {
  it("400 su firma manomessa, e senza aver chiamato Google", async () => {
    const workspaceId = await createWorkspace();
    const state = await stateFor(workspaceId);
    // Si altera l'ULTIMO carattere della firma: il payload resta identico, così
    // il test fallisce solo se la firma non viene verificata davvero.
    const tampered = state.slice(0, -1) + (state.endsWith("A") ? "B" : "A");

    const res = await callback(tampered);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("invalid_state");
    expect(calls).toHaveLength(0);
    expect(await accountRows()).toHaveLength(0);
  });

  it("400 su payload riscritto con un altro userId (la firma non torna)", async () => {
    const workspaceId = await createWorkspace();
    const state = await stateFor(workspaceId);
    const [body, signature] = state.split(".");
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as {
      userId: string;
    };
    payload.userId = adminId;
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;

    const res = await callback(forged);
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("400 al SECONDO uso dello stesso state: il nonce è monouso", async () => {
    const workspaceId = await createWorkspace();
    const state = await stateFor(workspaceId);

    const first = await callback(state);
    expect(first.statusCode).toBe(302);
    expect(outcomeOf(first)).toBe("ok");

    const replay = await callback(state);
    expect(replay.statusCode).toBe(400);
    expect((replay.json() as { code: string }).code).toBe("invalid_state");
    // Nessuna chiamata a Google in più rispetto al primo giro (token+userinfo).
    expect(calls).toHaveLength(2);
    expect(await accountRows()).toHaveLength(1);
  });

  it("400 su state scaduto: la firma è nostra ma la finestra è chiusa", async () => {
    const workspaceId = await createWorkspace();
    // Lo state emesso da `connect` non serve: si rifirma quello stesso nonce con
    // un `exp` passato, dopo aver spostato indietro anche `expires_at` nel DB.
    // È la situazione di chi torna sul callback dopo un'ora.
    await stateFor(workspaceId);
    const [row] = await testDb.db.select().from(oauthStates);
    const expired = Date.now() - 60_000;
    await testDb.db
      .update(oauthStates)
      .set({ expiresAt: new Date(expired) })
      .where(eq(oauthStates.id, row!.id));
    const staleState = signState(
      { userId: memberId, workspaceId, nonce: row!.nonce, exp: expired },
      ENCRYPTION_KEY,
    );

    const res = await callback(staleState);
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("400 su un nonce firmato che non ha mai avuto una riga", async () => {
    const workspaceId = await createWorkspace();
    const orphan = signState(
      { userId: memberId, workspaceId, nonce: "nonce-mai-emesso", exp: Date.now() + 60_000 },
      ENCRYPTION_KEY,
    );
    const res = await callback(orphan);
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("400 su uno state firmato con un'ALTRA chiave", async () => {
    const workspaceId = await createWorkspace();
    const state = await stateFor(workspaceId);
    const [body] = state.split(".");
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    const res = await callback(signState(payload, OTHER_KEY));
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("il callback ha il rate limit del login: oltre il tetto risponde 429", async () => {
    // App a sé, con il tetto basso: quella condivisa dagli altri test ha il
    // tetto alto apposta, e verificare qui che il limite ESISTE è l'unico modo
    // di accorgersi se un domani sparisse `config.rateLimit` dalla rotta.
    const limited = buildApp({
      db: testDb.db,
      sessionSecret: SESSION_SECRET,
      encryptionKey: ENCRYPTION_KEY.toString("base64"),
      publicUrl: PUBLIC_URL,
      googleFetch,
      authRateLimit: { max: 2, timeWindow: "1 minute" },
    });
    try {
      const call = () => limited.inject({ method: "GET", url: "/api/me/google/callback" });
      expect((await call()).statusCode).toBe(400);
      expect((await call()).statusCode).toBe(400);
      expect((await call()).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it("400 se mancano code o state", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me/google/callback?state=abc" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("invalid_callback");
  });
});

// ---------------------------------------------------------------------------
// GET /callback — i rifiuti di prodotto (dominio, refresh token, scope,
// email non verificata) e il catch-all "error"
// ---------------------------------------------------------------------------

describe("GET /api/me/google/callback — rifiuti", () => {
  it("domain_mismatch: dominio fuori dal Workspace, redirect e NESSUNA riga scritta", async () => {
    const workspaceId = await createWorkspace({ domains: ["acme.com"] });
    userinfoResponse = { ...userinfoResponse, email: "mario@altro.example", hd: "altro.example" };
    const state = await stateFor(workspaceId);

    const res = await callback(state);
    expect(res.statusCode).toBe(302);
    expect(outcomeOf(res)).toBe("domain_mismatch");
    expect(await accountRows()).toHaveLength(0);
  });

  it("no_refresh_token: Google non lo rimanda (consenso già dato e mai revocato)", async () => {
    const workspaceId = await createWorkspace();
    tokenResponse = { ...tokenResponse, refresh_token: undefined };
    const state = await stateFor(workspaceId);

    const res = await callback(state);
    expect(res.statusCode).toBe(302);
    expect(outcomeOf(res)).toBe("no_refresh_token");
    expect(await accountRows()).toHaveLength(0);
  });

  it("insufficient_scope: manca calendar.readonly fra quelli concessi", async () => {
    const workspaceId = await createWorkspace();
    tokenResponse = { ...tokenResponse, scope: `openid email ${GMAIL_SCOPE}` };
    const state = await stateFor(workspaceId);

    const res = await callback(state);
    expect(res.statusCode).toBe(302);
    expect(outcomeOf(res)).toBe("insufficient_scope");
    expect(await accountRows()).toHaveLength(0);
  });

  it("error generico se Google rifiuta lo scambio del code", async () => {
    const workspaceId = await createWorkspace();
    tokenFailure = { status: 400, body: { error: "invalid_grant" } };
    const state = await stateFor(workspaceId);

    const res = await callback(state);
    expect(res.statusCode).toBe(302);
    expect(outcomeOf(res)).toBe("error");
    expect(await accountRows()).toHaveLength(0);
  });

  it("email_not_verified: Google non garantisce l'indirizzo, redirect e NESSUNA riga scritta", async () => {
    const workspaceId = await createWorkspace();
    userinfoResponse = { ...userinfoResponse, email_verified: false };
    const state = await stateFor(workspaceId);

    const res = await callback(state);
    expect(res.statusCode).toBe(302);
    expect(outcomeOf(res)).toBe("email_not_verified");
    expect(await accountRows()).toHaveLength(0);
  });

  it("error se l'utente rifiuta il consenso su Google (?error=access_denied)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/me/google/callback?error=access_denied",
    });
    expect(res.statusCode).toBe(302);
    expect(outcomeOf(res)).toBe("error");
    expect(calls).toHaveLength(0);
  });

  // Anche quando il rifiuto arriva DOPO il consumo del nonce, lo state resta
  // speso: riprovare richiede un nuovo giro dalla pagina Account, non un
  // refresh del browser sulla URL di callback.
  it("un rifiuto consuma comunque lo state: il retry sulla stessa URL è 400", async () => {
    const workspaceId = await createWorkspace();
    userinfoResponse = { ...userinfoResponse, email: "mario@altro.example" };
    const state = await stateFor(workspaceId);
    expect(outcomeOf(await callback(state))).toBe("domain_mismatch");
    expect((await callback(state)).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /callback — successo
// ---------------------------------------------------------------------------

describe("GET /api/me/google/callback — successo", () => {
  it("scrive la casella con il refresh token cifrato, gli scope e connected_at", async () => {
    const workspaceId = await createWorkspace();
    const state = await stateFor(workspaceId);

    const res = await callback(state);
    expect(res.statusCode).toBe(302);
    expect(outcomeOf(res)).toBe("ok");

    const [row] = await accountRows();
    expect(row).toBeDefined();
    expect(row!.userId).toBe(memberId);
    expect(row!.workspaceId).toBe(workspaceId);
    // L'email è normalizzata lowercase da `fetchUserinfo`: è la chiave unique.
    expect(row!.email).toBe("mario.rossi@acme.com");
    expect(row!.googleSub).toBe("115000000000000000001");
    expect(row!.scopes).toEqual(["openid", "email", GMAIL_SCOPE, CALENDAR_SCOPE]);
    expect(row!.connectedAt).toBeInstanceOf(Date);
    expect(row!.disabledAt).toBeNull();
    // Già dovuta al primo tick del poller.
    expect(row!.nextSyncAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("il refresh token è cifrato at rest e decifrabile SOLO con la chiave d'istanza", async () => {
    const workspaceId = await createWorkspace();
    await callback(await stateFor(workspaceId));

    const [row] = await accountRows();
    expect(row!.refreshTokenEncrypted).not.toContain(REFRESH_TOKEN);
    expect(decrypt(row!.refreshTokenEncrypted, ENCRYPTION_KEY)).toBe(REFRESH_TOKEN);
    expect(() => decrypt(row!.refreshTokenEncrypted, OTHER_KEY)).toThrow();
  });

  it("manda a Google il code e il redirect_uri registrato, con la credenziale del Workspace", async () => {
    const workspaceId = await createWorkspace();
    await callback(await stateFor(workspaceId), "code-abc");

    const token = calls.find((call) => call.url.includes("/token"));
    expect(token).toBeDefined();
    expect(token!.form).toMatchObject({
      grant_type: "authorization_code",
      code: "code-abc",
      client_id: "123.apps.googleusercontent.com",
      client_secret: CLIENT_SECRET,
      redirect_uri: `${PUBLIC_URL}/api/me/google/callback`,
    });
  });

  it("il ricollegamento RIATTIVA la casella disabilitata invece di violare l'unique", async () => {
    const workspaceId = await createWorkspace();
    await callback(await stateFor(workspaceId));
    const [first] = await accountRows();

    // La casella viene disabilitata (come farebbe il poller su invalid_grant) e
    // l'utente spegne le proposte: il ricollegamento deve rianimare la prima
    // cosa e NON toccare la seconda, che è una sua preferenza.
    await testDb.db
      .update(googleAccounts)
      .set({
        disabledAt: new Date(),
        disabledReason: "invalid_grant",
        syncAttempts: 7,
        proposalsEnabled: false,
      })
      .where(eq(googleAccounts.id, first!.id));

    tokenResponse = { ...tokenResponse, refresh_token: "1//refresh-token-nuovo" };
    const res = await callback(await stateFor(workspaceId));
    expect(outcomeOf(res)).toBe("ok");

    const rows = await accountRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first!.id);
    expect(rows[0]!.disabledAt).toBeNull();
    expect(rows[0]!.disabledReason).toBeNull();
    expect(rows[0]!.syncAttempts).toBe(0);
    expect(decrypt(rows[0]!.refreshTokenEncrypted, ENCRYPTION_KEY)).toBe("1//refresh-token-nuovo");
    expect(rows[0]!.proposalsEnabled).toBe(false);
  });

  it("loadGoogleAccountCredentials rimette insieme token e credenziali dell'app OAuth", async () => {
    const workspaceId = await createWorkspace();
    await callback(await stateFor(workspaceId));
    const [row] = await accountRows();

    const credentials = await loadGoogleAccountCredentials(testDb.db, ENCRYPTION_KEY, row!.id);
    expect(credentials).toMatchObject({
      accountId: row!.id,
      userId: memberId,
      email: "mario.rossi@acme.com",
      refreshToken: REFRESH_TOKEN,
      clientId: "123.apps.googleusercontent.com",
      clientSecret: CLIENT_SECRET,
    });
    // Con la chiave sbagliata non si ottiene un token sbagliato: si ottiene null.
    expect(await loadGoogleAccountCredentials(testDb.db, OTHER_KEY, row!.id)).toBeNull();
    expect(
      await loadGoogleAccountCredentials(
        testDb.db,
        ENCRYPTION_KEY,
        "2f4bd0f0-9c2a-4a1c-9f13-8b4d9a1e0000",
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /callback — titolarità: nessun trasferimento silenzioso della casella
// ---------------------------------------------------------------------------

describe("GET /api/me/google/callback — titolarità della casella", () => {
  it("mailbox_owned_by_other: un secondo utente non può rubare una casella già collegata, e la riga di A resta ESATTAMENTE invariata", async () => {
    const workspaceId = await createWorkspace();
    // A (member) collega la casella.
    await callback(await stateFor(workspaceId, memberCookie));
    const [before] = await accountRows();
    expect(before!.userId).toBe(memberId);

    // B (admin) prova a collegare la STESSA email: il consenso di B su Google è
    // reale (il fake risponde comunque con `userinfoResponse`), ma la riga
    // esiste già per un altro utente.
    calls = [];
    tokenResponse = { ...tokenResponse, refresh_token: "1//refresh-token-tentativo-di-B" };
    const res = await callback(await stateFor(workspaceId, adminCookie));
    expect(res.statusCode).toBe(302);
    expect(outcomeOf(res)).toBe("mailbox_owned_by_other");

    // Lo scambio del code con Google È avvenuto (serve l'userinfo per sapere che
    // l'email combacia), ma NESSUNA scrittura: la riga di A è la stessa, non solo
    // "ancora presente".
    const rows = await accountRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(before);
  });

  it("lo STESSO utente può ricollegare la propria casella: riattivazione regolare, non `mailbox_owned_by_other`", async () => {
    const workspaceId = await createWorkspace();
    await callback(await stateFor(workspaceId, memberCookie));
    const [first] = await accountRows();

    tokenResponse = { ...tokenResponse, refresh_token: "1//refresh-token-nuovo-stesso-utente" };
    const res = await callback(await stateFor(workspaceId, memberCookie));
    expect(outcomeOf(res)).toBe("ok");

    const rows = await accountRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first!.id);
    expect(decrypt(rows[0]!.refreshTokenEncrypted, ENCRYPTION_KEY)).toBe(
      "1//refresh-token-nuovo-stesso-utente",
    );
  });
});

// ---------------------------------------------------------------------------
// Lettura, toggle, scollegamento — e il filtro per userId
// ---------------------------------------------------------------------------

describe("caselle dell'utente", () => {
  async function connectedAccountId(): Promise<string> {
    const workspaceId = await createWorkspace();
    await callback(await stateFor(workspaceId));
    const [row] = await accountRows();
    return row!.id;
  }

  it("GET /accounts elenca le MIE caselle, senza nessun campo che somigli a un token", async () => {
    await connectedAccountId();

    const res = await app.inject({
      method: "GET",
      url: "/api/me/google/accounts",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      email: "mario.rossi@acme.com",
      workspaceName: "Acme",
      proposalsEnabled: true,
      lastSyncAt: null,
      disabledAt: null,
      disabledReason: null,
    });
    expect(JSON.stringify(list[0])).not.toContain(REFRESH_TOKEN);
    expect(Object.keys(list[0]!).join(" ")).not.toMatch(/token|secret/i);

    // L'altro utente non vede la casella di nessuno.
    const other = await app.inject({
      method: "GET",
      url: "/api/me/google/accounts",
      headers: { cookie: adminCookie },
    });
    expect(other.json()).toEqual([]);
  });

  it("PATCH cambia solo proposalsEnabled", async () => {
    const id = await connectedAccountId();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/me/google/accounts/${id}`,
      headers: { cookie: memberCookie },
      payload: { proposalsEnabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { proposalsEnabled: boolean }).proposalsEnabled).toBe(false);

    const [row] = await accountRows();
    expect(row!.proposalsEnabled).toBe(false);
  });

  it("PATCH di un altro utente: 404 e la riga resta invariata", async () => {
    const id = await connectedAccountId();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/me/google/accounts/${id}`,
      headers: { cookie: adminCookie },
      payload: { proposalsEnabled: false },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("google_account_not_found");

    const [row] = await accountRows();
    expect(row!.proposalsEnabled).toBe(true);
  });

  it("DELETE revoca su Google e cancella la riga", async () => {
    const id = await connectedAccountId();
    calls = [];

    const res = await app.inject({
      method: "DELETE",
      url: `/api/me/google/accounts/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(204);

    const revoke = calls.find((call) => call.url.includes("/revoke"));
    expect(revoke).toBeDefined();
    // Si revoca il REFRESH token (revocarne uno revoca l'intero grant).
    expect(revoke!.form.token).toBe(REFRESH_TOKEN);
    expect(await accountRows()).toHaveLength(0);
  });

  it("DELETE cancella comunque se la revoca fallisce: best-effort", async () => {
    const id = await connectedAccountId();
    revokeFailure = { status: 400, body: { error: "invalid_token" } };

    const res = await app.inject({
      method: "DELETE",
      url: `/api/me/google/accounts/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(204);
    expect(await accountRows()).toHaveLength(0);
  });

  it("DELETE di un altro utente: 404, nessuna revoca e la riga resta", async () => {
    const id = await connectedAccountId();
    calls = [];

    const res = await app.inject({
      method: "DELETE",
      url: `/api/me/google/accounts/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
    expect(await accountRows()).toHaveLength(1);
  });

  it("tutte le rotte delle caselle vogliono una sessione", async () => {
    const id = await connectedAccountId();
    for (const [method, url] of [
      ["GET", "/api/me/google/accounts"],
      ["PATCH", `/api/me/google/accounts/${id}`],
      ["DELETE", `/api/me/google/accounts/${id}`],
    ] as const) {
      const res = await app.inject({ method, url, payload: { proposalsEnabled: false } });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
