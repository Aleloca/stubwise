import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { credentials, projects } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

/**
 * ⚠️ INVARIANTE DELLA CASSAFORTE, VERIFICATA — **le credenziali non escono
 * dal loro perimetro.**
 *
 * Il server non decifra mai niente, ma i campi in chiaro (servizio, utente,
 * URL, note) e le buste cifrate sono comunque dati sensibili: se una gamba
 * della ricerca, un indice di embedding, un prompt dell'agente, una card
 * d'inbox o un webhook li leggessero, la cassaforte avrebbe una porta
 * laterale che nessun permesso copre. Il test la verifica su due piani:
 *
 *  - **sul sorgente**: nessun modulo fuori da un elenco CHIUSO nomina le
 *    tabelle della cassaforte né importa `apps/server/src/vault`; in più, un
 *    elenco ESPLICITO di aree (worker, MCP, embedding, ricerca, chat/grafo,
 *    Slack, notifiche, webhook...) che non devono mai farlo — se una di
 *    queste cartelle sparisce o cambia nome il test lo dice, invece di
 *    passare a vuoto;
 *  - **a runtime**: una credenziale esistente non compare in
 *    `GET /api/search` né nella cronologia, e un errore di validazione di una
 *    rotta della cassaforte non rimanda indietro i valori del corpo.
 *
 * Chi aggiunge un lettore delle credenziali lo aggiunge all'elenco dei
 * permessi qui sotto SOLO se è davvero parte della cassaforte. Altrimenti la
 * riga giusta da cambiare non è il test: è la scelta.
 */

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = resolve(here, "..");
const repoRoot = resolve(serverSrc, "../../..");

/** Le tabelle (nomi Drizzle) della cassaforte, tranne `credentials` (generico, sotto). */
const VAULT_TABLE_IDENTIFIERS = [
  "vaultSettings",
  "vaultPersonKeys",
  "vaultPersonKeySeals",
  "vaultRecoveryChallenges",
  "credentialReaders",
  "credentialKeyCopies",
  "credentialAccessLog",
] as const;
const VAULT_SQL_NAMES = [
  "vault_settings",
  "vault_person_keys",
  "vault_person_key_seals",
  "vault_recovery_challenges",
  "credential_readers",
  "credential_key_copies",
  "credential_access_log",
] as const;

const NAMES_VAULT = new RegExp(
  [...VAULT_TABLE_IDENTIFIERS.map((n) => `\\b${n}\\b`), ...VAULT_SQL_NAMES.map((n) => `\\b${n}\\b`)].join("|"),
);
/** `credentials` è una parola comune (credenziali Google, git...): si cerca come import dal db o come tabella SQL. */
const IMPORTS_CREDENTIALS_TABLE = /import\s*(?:type\s*)?\{[^}]*\bcredentials\b[^}]*\}\s*from\s*["']@stubwise\/db(?:\/[^"']*)?["']/;
const SQL_CREDENTIALS_TABLE = /\b(?:from|join|into|update)\s+"?credentials"?\b/i;
const IMPORTS_VAULT_MODULE = /from\s*["'](?:\.{1,2}\/)+(?:[\w.-]+\/)*vault\/[^"']*["']|from\s*["']\.\/vault(?:\/[^"']*)?["']/;
const IMPORTS_VAULT_PACKAGE = /from\s*["']@stubwise\/vault-crypto["']/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

const isTest = (f: string): boolean => /\.test\.tsx?$/.test(f) || f.includes("/test/");

function namesVaultData(source: string): boolean {
  return NAMES_VAULT.test(source) || IMPORTS_CREDENTIALS_TABLE.test(source) || SQL_CREDENTIALS_TABLE.test(source);
}

/**
 * Le aree che NON devono mai toccare la cassaforte, una per una (percorsi
 * dalla radice del repo). Includono i test: un test di quelle aree che
 * leggesse le tabelle sarebbe comunque un lettore.
 */
const FORBIDDEN_AREAS = [
  "apps/worker/src",
  "packages/mcp/src",
  "packages/embeddings/src",
  "packages/docs-engine/src",
  "packages/notifications/src",
  "packages/google/src",
  "packages/sdk/src",
  "packages/agent/src",
  "packages/git/src",
  "packages/widget/src",
  "apps/server/src/graph-chat",
  "apps/server/src/slack",
  "apps/server/src/ingest",
  "apps/server/src/backlog",
  "apps/server/src/services",
  "apps/server/src/storage",
  "apps/server/src/scripts",
] as const;

/** I file della ricerca, della chat RAG, delle notifiche e dei webhook dentro `routes/`. */
const FORBIDDEN_ROUTE_FILES = [
  "search.ts",
  "docs-rag.ts",
  "docs-retrieval.ts",
  "docs-chat.ts",
  "docs-chat-core.ts",
  "backlog-rag.ts",
  "chat-llm.ts",
  "repo-graph.ts",
  "inbox.ts",
  "inbound.ts",
  "project-docs.ts",
  "briefs.ts",
  "activity-routes.ts",
] as const;

/** Chi può NOMINARE le tabelle della cassaforte: elenco chiuso (relativo a `apps/server/src`). */
const ALLOWED_TABLE_NAMERS = ["routes/vault.ts", "routes/credentials.ts"];
/** Chi può IMPORTARE `apps/server/src/vault`: le rotte della cassaforte e il montaggio in `app.ts`. */
const ALLOWED_VAULT_IMPORTERS = ["routes/vault.ts", "routes/credentials.ts"];

describe("la cassaforte resta isolata — sul sorgente", () => {
  it("le aree vietate esistono ancora, e nessuna nomina le tabelle o i moduli della cassaforte", () => {
    for (const area of FORBIDDEN_AREAS) {
      const dir = join(repoRoot, area);
      const files = walk(dir);
      // Un'area sparita o rinominata non deve far passare il test a vuoto.
      expect(files.length, `${area} non esiste più o è vuota: aggiorna l'elenco`).toBeGreaterThan(0);
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        const rel = relative(repoRoot, file);
        expect(namesVaultData(source), `${rel} nomina le tabelle della cassaforte`).toBe(false);
        expect(IMPORTS_VAULT_MODULE.test(source), `${rel} importa il modulo vault del server`).toBe(false);
        expect(IMPORTS_VAULT_PACKAGE.test(source), `${rel} importa @stubwise/vault-crypto`).toBe(false);
      }
    }
  });

  it("le rotte di ricerca, chat, notifiche e webhook non toccano la cassaforte", () => {
    for (const name of FORBIDDEN_ROUTE_FILES) {
      const file = join(serverSrc, "routes", name);
      const source = readFileSync(file, "utf8"); // lancia se il file è sparito: aggiorna l'elenco
      expect(namesVaultData(source), `routes/${name} nomina le tabelle della cassaforte`).toBe(false);
      expect(IMPORTS_VAULT_MODULE.test(source), `routes/${name} importa il modulo vault`).toBe(false);
    }
  });

  it("nel server solo l'elenco chiuso nomina le tabelle o importa il modulo vault", () => {
    const offendersTables: string[] = [];
    const offendersImports: string[] = [];
    for (const file of walk(serverSrc)) {
      if (isTest(file)) continue;
      const rel = relative(serverSrc, file);
      if (rel.startsWith("vault/")) continue; // il modulo stesso
      const source = readFileSync(file, "utf8");
      if (namesVaultData(source) && !ALLOWED_TABLE_NAMERS.includes(rel)) offendersTables.push(rel);
      if (IMPORTS_VAULT_MODULE.test(source) && !ALLOWED_VAULT_IMPORTERS.includes(rel)) offendersImports.push(rel);
    }
    expect(offendersTables, "file fuori elenco che nominano le tabelle della cassaforte").toEqual([]);
    expect(offendersImports, "file fuori elenco che importano apps/server/src/vault").toEqual([]);
  });

  it("l'elenco degli importatori è davvero usato (non è un elenco di comodo)", () => {
    for (const rel of ALLOWED_VAULT_IMPORTERS) {
      expect(IMPORTS_VAULT_MODULE.test(readFileSync(join(serverSrc, rel), "utf8")), rel).toBe(true);
    }
    // `app.ts` monta le rotte ma non importa il modulo: se un giorno lo facesse, va deciso qui.
    expect(IMPORTS_VAULT_MODULE.test(readFileSync(join(serverSrc, "app.ts"), "utf8"))).toBe(false);
  });

  it("@stubwise/vault-crypto lo importano solo il modulo vault e le passkey (PRF_INPUT)", () => {
    const allowed = new Set(["auth/second-factor/passkeys.ts"]);
    const offenders: string[] = [];
    for (const file of walk(serverSrc)) {
      if (isTest(file)) continue;
      const rel = relative(serverSrc, file);
      if (rel.startsWith("vault/")) continue;
      if (IMPORTS_VAULT_PACKAGE.test(readFileSync(file, "utf8")) && !allowed.has(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;

describe("la cassaforte resta isolata — a runtime", () => {
  beforeAll(async () => {
    testDb = await startTestDb();
    app = buildApp({
      db: testDb.db,
      sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
      encryptionKey: randomBytes(32).toString("base64"),
      authRateLimit: { max: 1000, timeWindow: "1 minute" },
    });
    ({ adminCookie, adminId } = await seedUsers(app));
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await testDb.stop();
  });

  it("una credenziale esistente non compare nella ricerca né nella cronologia", async () => {
    const token = `Zvaultmarker${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const [project] = await testDb.db
      .insert(projects)
      .values({ name: "Cassaforte", slug: `cassaforte-${randomUUID().slice(0, 8)}`, ingestionKey: randomUUID() })
      .returning({ id: projects.id });
    await testDb.db.insert(credentials).values({
      id: randomUUID(),
      projectId: project!.id,
      service: `Servizio ${token}`,
      label: `Etichetta ${token}`,
      url: `https://${token.toLowerCase()}.example.com`,
      username: `utente-${token}`,
      notes: `Note ${token}`,
      passwordCiphertext: JSON.stringify({ v: 1, iv: "aaaa", ct: "bbbb", tag: "cccc" }),
      createdByUserId: adminId,
      updatedByUserId: adminId,
    });

    for (const q of [token, `Servizio ${token}`, token.toLowerCase()]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/search?q=${encodeURIComponent(q)}`,
        headers: { cookie: adminCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(token);
      expect(res.body.toLowerCase()).not.toContain(token.toLowerCase());
    }

    const history = await app.inject({
      method: "GET",
      url: "/api/search/history",
      headers: { cookie: adminCookie },
    });
    expect(history.statusCode).toBe(200);
    expect(history.body.toLowerCase()).not.toContain(token.toLowerCase());
  });

  it("un errore di validazione di una rotta della cassaforte non rimanda i valori del corpo", async () => {
    const [project] = await testDb.db
      .insert(projects)
      .values({ name: "Errori", slug: `errori-${randomUUID().slice(0, 8)}`, ingestionKey: randomUUID() })
      .returning({ id: projects.id });
    const secret = `Zsegreto${randomUUID().replace(/-/g, "")}`;

    // `copies` ha il tipo sbagliato: la validazione fallisce con gli altri campi pieni di valori riconoscibili.
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project!.id}/credentials`,
      headers: { cookie: adminCookie },
      payload: {
        id: randomUUID(),
        service: `servizio-${secret}`,
        username: `utente-${secret}`,
        notes: `note-${secret}`,
        passwordCiphertext: `password-${secret}`,
        recoveryPublicKey: `chiave-${secret}`,
        copies: `copie-${secret}`,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(secret);

    // Un corpo con un campo di tipo sbagliato che È il segreto (il caso più insidioso).
    const res2 = await app.inject({
      method: "POST",
      url: `/api/projects/${project!.id}/credentials`,
      headers: { cookie: adminCookie },
      payload: { id: secret, service: secret, passwordCiphertext: secret, copies: secret },
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.body).not.toContain(secret);
  });
});
