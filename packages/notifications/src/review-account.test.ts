import { randomUUID } from "node:crypto";
import * as dbSchema from "@stubwise/db";
import { gitAccounts, repositories } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { GitProviderKind } from "@stubwise/shared";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  pickReviewAccount,
  resolveReviewAccount,
  resolveReviewAccounts,
  resolveReviewAccountsWithCredentials,
  resolveReviewAccountWithCredentials,
  REVIEW_ACCOUNT_VIEW_KEYS,
  reviewScopeKey,
} from "./review-account.js";

/**
 * Revisore EFFETTIVO di una repository (D1-D2 del piano
 * `docs/plans/2026-10-01-default-reviewer-and-scopes.md`): una regola sola,
 * che tutti i consumatori chiamano. `reviewScopeKey` è il gemello
 * TypeScript dell'indice `git_accounts_default_reviewer_scope_uq` (0082): il
 * blocco «allineamento» qui sotto lo verifica contro l'indice VERO, sugli
 * stessi casi di `packages/db/src/migration-0082.test.ts`.
 */

interface Acc {
  id: string;
  provider: GitProviderKind;
  workspace: string | null;
}

function acc(id: string, provider: GitProviderKind, workspace: string | null = null): Acc {
  return { id, provider, workspace };
}

describe("pickReviewAccount (regola pura, D2)", () => {
  it("1. l'esplicito vince sul predefinito", () => {
    const main = acc("main", "bitbucket", "ws1");
    const explicit = acc("exp", "bitbucket", "ws1");
    const def = acc("def", "bitbucket", "ws1");
    const r = pickReviewAccount({ main, explicit, defaults: [def] });
    expect(r.effective).toEqual({ account: explicit, source: "explicit" });
    expect(r.skippedDefault).toBeNull();
    // Il principale viaggia con la risoluzione: chi li vuole entrambi legge una volta.
    expect(r.main).toBe(main);
  });

  it("1b. con l'esplicito, un predefinito uguale al principale non è «saltato»: è irrilevante", () => {
    const main = acc("main", "bitbucket", "ws1");
    const explicit = acc("exp", "bitbucket", "ws1");
    const r = pickReviewAccount({ main, explicit, defaults: [{ ...main }] });
    expect(r.effective).toEqual({ account: explicit, source: "explicit" });
    expect(r.skippedDefault).toBeNull();
  });

  it("2. nessun esplicito, predefinito nello stesso workspace Bitbucket → default", () => {
    const main = acc("main", "bitbucket", "ws1");
    const def = acc("def", "bitbucket", "ws1");
    const r = pickReviewAccount({ main, explicit: null, defaults: [def] });
    expect(r.effective).toEqual({ account: def, source: "default" });
    expect(r.skippedDefault).toBeNull();
  });

  it("3. predefinito in un ALTRO workspace Bitbucket → nessuno", () => {
    const main = acc("main", "bitbucket", "ws1");
    const r = pickReviewAccount({ main, explicit: null, defaults: [acc("def", "bitbucket", "ws2")] });
    expect(r).toEqual({ main, effective: null, skippedDefault: null });
  });

  it("3b. fra più predefiniti sceglie quello del SUO ambito", () => {
    const main = acc("main", "bitbucket", "ws2");
    const ws1 = acc("d1", "bitbucket", "ws1");
    const ws2 = acc("d2", "bitbucket", "ws2");
    const gh = acc("d3", "github");
    const r = pickReviewAccount({ main, explicit: null, defaults: [ws1, gh, ws2] });
    expect(r.effective).toEqual({ account: ws2, source: "default" });
  });

  it("4. predefinito GitHub, principale GitHub con workspace valorizzato diverso → default (D1)", () => {
    const main = acc("main", "github", "acme");
    const def = acc("def", "github", null);
    const r = pickReviewAccount({ main, explicit: null, defaults: [def] });
    expect(r.effective).toEqual({ account: def, source: "default" });
  });

  it("5. predefinito = principale → nessun effettivo, skippedDefault = lui", () => {
    const main = acc("main", "bitbucket", "ws1");
    // Un oggetto DIVERSO con lo stesso id: il confronto è sull'id, non sul riferimento.
    const def = { ...main };
    const r = pickReviewAccount({ main, explicit: null, defaults: [def] });
    expect(r.effective).toBeNull();
    expect(r.skippedDefault).toBe(def);
  });

  it("6. predefinito di un altro provider → nessuno", () => {
    const main = acc("main", "bitbucket", null);
    const r = pickReviewAccount({ main, explicit: null, defaults: [acc("def", "github", null)] });
    expect(r).toEqual({ main, effective: null, skippedDefault: null });
  });

  it("1c. esplicito con lo STESSO id del principale (il CHECK lo vieta, la regola lo riverifica) → nessun effettivo", () => {
    const main = acc("main", "bitbucket", "ws1");
    const r = pickReviewAccount({ main, explicit: { ...main }, defaults: [] });
    expect(r).toEqual({ main, effective: null, skippedDefault: null });
  });

  it("1d. esplicito = principale, con un predefinito valido nello stesso ambito → l'effettivo è il predefinito", () => {
    const main = acc("main", "bitbucket", "ws1");
    const def = acc("def", "bitbucket", "ws1");
    const r = pickReviewAccount({ main, explicit: { ...main }, defaults: [def] });
    expect(r.effective).toEqual({ account: def, source: "default" });
    expect(r.skippedDefault).toBeNull();
  });

  it("nessun predefinito, nessun esplicito → nessuno", () => {
    const main = acc("main", "github");
    const r = pickReviewAccount({ main, explicit: null, defaults: [] });
    expect(r).toEqual({ main, effective: null, skippedDefault: null });
  });
});

describe("reviewScopeKey (D1)", () => {
  it("su Bitbucket il workspace conta, e NULL vale come ''", () => {
    expect(reviewScopeKey(acc("a", "bitbucket", "ws1"))).not.toBe(
      reviewScopeKey(acc("b", "bitbucket", "ws2")),
    );
    expect(reviewScopeKey(acc("a", "bitbucket", null))).toBe(reviewScopeKey(acc("b", "bitbucket", "")));
  });

  it("su GitHub il workspace non conta", () => {
    expect(reviewScopeKey(acc("a", "github", "acme"))).toBe(reviewScopeKey(acc("b", "github", null)));
  });

  it("provider diversi sono ambiti diversi, anche con lo stesso workspace", () => {
    expect(reviewScopeKey(acc("a", "github", "ws1"))).not.toBe(reviewScopeKey(acc("b", "bitbucket", "ws1")));
  });
});

describe("con il database", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  afterEach(async () => {
    // Ogni caso parte senza predefiniti: l'indice è unico per ambito.
    await testDb.db.update(gitAccounts).set({ isDefaultReviewer: false });
  });

  async function insertAccount(provider: GitProviderKind, workspace: string | null, isDefault: boolean) {
    const [row] = await testDb.db
      .insert(gitAccounts)
      .values({
        name: `acc-${randomUUID()}`,
        provider,
        encryptedCredentials: "blob",
        workspace,
        isDefaultReviewer: isDefault,
      })
      .returning();
    return row!;
  }

  async function insertRepository(mainId: string, explicitId: string | null = null): Promise<string> {
    const [main] = await testDb.db.select().from(gitAccounts).where(eq(gitAccounts.id, mainId));
    const { projectId } = await seedRepository(testDb.db);
    const [row] = await testDb.db
      .insert(repositories)
      .values({
        projectId,
        name: "r",
        slug: `r-${randomUUID()}`,
        provider: main!.provider,
        gitAccountId: mainId,
        reviewGitAccountId: explicitId,
        repoUrl: "https://example.com/r.git",
        defaultBranch: "main",
      })
      .returning();
    return row!.id;
  }

  /**
   * 7. Allineamento con l'indice della 0082, sugli STESSI casi di
   * `migration-0082.test.ts` (più i bordi della COALESCE e del provider):
   * l'indice rifiuta due predefiniti ⟺ `reviewScopeKey` li mette nello stesso
   * ambito. Non è una copia della CASE: chiede al Postgres vero.
   */
  const pairs: Array<{ name: string; a: [GitProviderKind, string | null]; b: [GitProviderKind, string | null] }> = [
    { name: "Bitbucket, stesso workspace", a: ["bitbucket", "ws1"], b: ["bitbucket", "ws1"] },
    { name: "Bitbucket, workspace diversi", a: ["bitbucket", "ws1"], b: ["bitbucket", "ws2"] },
    { name: "Bitbucket, workspace entrambi NULL", a: ["bitbucket", null], b: ["bitbucket", null] },
    { name: "Bitbucket, NULL e ''", a: ["bitbucket", null], b: ["bitbucket", ""] },
    { name: "GitHub, workspace NULL e 'acme'", a: ["github", null], b: ["github", "acme"] },
    { name: "GitHub, workspace 'a' e 'b'", a: ["github", "a"], b: ["github", "b"] },
    { name: "un GitHub e un Bitbucket", a: ["github", null], b: ["bitbucket", null] },
    { name: "GitHub e Bitbucket con lo stesso workspace", a: ["github", "ws1"], b: ["bitbucket", "ws1"] },
  ];

  for (const pair of pairs) {
    it(`7. indice e reviewScopeKey d'accordo: ${pair.name}`, async () => {
      const a = await insertAccount(pair.a[0], pair.a[1], true);
      let indexRejects = false;
      try {
        await insertAccount(pair.b[0], pair.b[1], true);
      } catch (err) {
        const cause = (err as { cause?: unknown }).cause ?? err;
        if ((cause as { code?: string }).code !== "23505") throw err;
        indexRejects = true;
      }
      const sameScope =
        reviewScopeKey({ provider: pair.a[0], workspace: pair.a[1] }) ===
        reviewScopeKey({ provider: pair.b[0], workspace: pair.b[1] });
      expect(sameScope).toBe(indexRejects);

      // E la proprietà che serve davvero: un principale dell'ambito di `a`
      // trova AL PIÙ un predefinito — `a` — qualunque cosa l'indice abbia
      // ammesso accanto.
      const main = await insertAccount(pair.a[0], pair.a[1], false);
      const repoId = await insertRepository(main.id);
      const r = await resolveReviewAccount(testDb.db, repoId);
      expect(r?.effective?.account.id).toBe(a.id);
    });
  }

  it("8. tre repository di ambiti diversi: una mappa corretta, in DUE query", async () => {
    const ghMain = await insertAccount("github", null, false);
    const ghDef = await insertAccount("github", "irrilevante", true);
    const bbMain = await insertAccount("bitbucket", "ws1", false);
    const bbDef = await insertAccount("bitbucket", "ws1", true);
    const bbOtherMain = await insertAccount("bitbucket", "ws-senza", false);
    const explicit = await insertAccount("bitbucket", "ws-senza", false);
    const selfMain = await insertAccount("bitbucket", "ws-self", true);

    const repoGh = await insertRepository(ghMain.id);
    const repoBb = await insertRepository(bbMain.id);
    const repoExplicit = await insertRepository(bbOtherMain.id, explicit.id);
    const repoSelf = await insertRepository(selfMain.id);

    // Un client con un logger, sulla STESSA connessione: conta le query vere.
    let queries = 0;
    const counted = drizzle(testDb.client, {
      schema: dbSchema,
      logger: { logQuery: () => void queries++ },
    });
    const map = await resolveReviewAccounts(counted, [repoGh, repoBb, repoExplicit, repoSelf]);
    expect(queries).toBe(2);

    expect(map.size).toBe(4);
    expect(map.get(repoGh)?.effective?.account.id).toBe(ghDef.id);
    expect(map.get(repoGh)?.effective?.source).toBe("default");
    expect(map.get(repoBb)?.effective?.account.id).toBe(bbDef.id);
    expect(map.get(repoExplicit)?.effective?.account.id).toBe(explicit.id);
    expect(map.get(repoExplicit)?.effective?.source).toBe("explicit");
    expect(map.get(repoSelf)?.effective).toBeNull();
    expect(map.get(repoSelf)?.skippedDefault?.id).toBe(selfMain.id);
    // La variante di default NON porta il blob delle credenziali (8c, 8d).
    expect(map.get(repoBb)?.effective?.account).not.toHaveProperty("encryptedCredentials");
  });

  it("8c. la versione di default è una PROIEZIONE: mai il blob delle credenziali", async () => {
    const main = await insertAccount("bitbucket", "ws-proj", false);
    const explicit = await insertAccount("bitbucket", "ws-proj", false);
    const selfDef = await insertAccount("bitbucket", "ws-proj-self", true);
    const repoExplicit = await insertRepository(main.id, explicit.id);
    const repoSelf = await insertRepository(selfDef.id);
    const def = await insertAccount("bitbucket", "ws-proj", true);
    const repoDefault = await insertRepository(main.id);

    const expected = ["id", "isDefaultReviewer", "name", "provider", "providerUserId", "workspace"];
    expect([...REVIEW_ACCOUNT_VIEW_KEYS].sort()).toEqual(expected);
    const map = await resolveReviewAccounts(testDb.db, [repoExplicit, repoSelf, repoDefault]);
    // Ogni oggetto account che la funzione restituisce — esplicito, predefinito
    // effettivo, predefinito saltato — ha ESATTAMENTE quelle chiavi.
    const returned = [
      map.get(repoExplicit)?.effective?.account,
      map.get(repoDefault)?.effective?.account,
      map.get(repoSelf)?.skippedDefault,
      map.get(repoDefault)?.main,
    ];
    for (const account of returned) {
      expect(account).toBeDefined();
      expect(Object.keys(account!).sort()).toEqual(expected);
    }
    expect(map.get(repoDefault)?.effective?.account.id).toBe(def.id);
    expect(map.get(repoDefault)?.effective?.account).toEqual({
      id: def.id,
      name: def.name,
      provider: "bitbucket",
      workspace: "ws-proj",
      providerUserId: null,
      isDefaultReviewer: true,
    });
    const single = await resolveReviewAccount(testDb.db, repoDefault);
    expect(Object.keys(single!.effective!.account).sort()).toEqual(expected);
    // E per il compilatore: chi riceve la proiezione non può leggere il blob.
    // @ts-expect-error — la proiezione non ha `encryptedCredentials`.
    void single!.effective!.account.encryptedCredentials;
  });

  it("8d. «WithCredentials» (solo per chi si autentica): righe intere, blob compreso, stessa regola", async () => {
    const main = await insertAccount("bitbucket", "ws-cred", false);
    const def = await insertAccount("bitbucket", "ws-cred", true);
    const explicit = await insertAccount("bitbucket", "ws-cred-x", false);
    const otherMain = await insertAccount("bitbucket", "ws-cred-x", false);
    const repoDefault = await insertRepository(main.id);
    const repoExplicit = await insertRepository(otherMain.id, explicit.id);

    const map = await resolveReviewAccountsWithCredentials(testDb.db, [repoDefault, repoExplicit]);
    expect(map.get(repoDefault)?.effective).toMatchObject({ source: "default", account: { id: def.id } });
    expect(map.get(repoDefault)?.effective?.account.encryptedCredentials).toBe("blob");
    expect(map.get(repoExplicit)?.effective).toMatchObject({ source: "explicit", account: { id: explicit.id } });
    expect(map.get(repoExplicit)?.effective?.account.encryptedCredentials).toBe("blob");
    // Il principale arriva con la risoluzione, credenziali comprese: il
    // webhook non lo rilegge per id.
    expect(map.get(repoDefault)?.main).toMatchObject({ id: main.id, encryptedCredentials: "blob" });
    const single = await resolveReviewAccountWithCredentials(testDb.db, repoDefault);
    expect(single?.effective?.account.encryptedCredentials).toBe("blob");
    expect(single?.main.id).toBe(main.id);
    expect(await resolveReviewAccountWithCredentials(testDb.db, randomUUID())).toBeNull();
  });

  it("8f. WithCredentials legge SOLO i predefiniti degli ambiti dei principali richiesti", async () => {
    const main = await insertAccount("bitbucket", "ws-filtro", false);
    const inScope = await insertAccount("bitbucket", "ws-filtro", true);
    const otherWorkspace = await insertAccount("bitbucket", "ws-filtro-altro", true);
    const nullWorkspace = await insertAccount("bitbucket", null, true);
    const github = await insertAccount("github", null, true);
    const repoId = await insertRepository(main.id);

    // Si cattura la query dei predefiniti così com'è stata eseguita, e la si
    // riesegue sul Postgres vero: conta cosa CARICA, non solo cosa sceglie
    // (la scelta sarebbe giusta anche caricandoli tutti).
    const captured: { query: string; params: unknown[] }[] = [];
    const counted = drizzle(testDb.client, {
      schema: dbSchema,
      logger: { logQuery: (query, params) => void captured.push({ query, params }) },
    });
    const map = await resolveReviewAccountsWithCredentials(counted, [repoId]);
    expect(map.get(repoId)?.effective?.account.id).toBe(inScope.id);
    expect(captured).toHaveLength(2);
    const defaultsQuery = captured.find((q) => !q.query.includes('"main_account"'));
    expect(defaultsQuery).toBeDefined();
    const loaded = await testDb.client.unsafe(defaultsQuery!.query, defaultsQuery!.params as never[]);
    const ids = loaded.map((row) => String(row.id));
    expect(ids).toEqual([inScope.id]);
    expect(ids).not.toContain(otherWorkspace.id);
    expect(ids).not.toContain(nullWorkspace.id);
    expect(ids).not.toContain(github.id);
  });

  it("8g. il filtro per ambito non perde il predefinito di NESSUNA delle repository richieste", async () => {
    const bbMain = await insertAccount("bitbucket", "ws-multi", false);
    const bbDef = await insertAccount("bitbucket", "ws-multi", true);
    const bbNullMain = await insertAccount("bitbucket", null, false);
    const bbNullDef = await insertAccount("bitbucket", "", true);
    const ghMain = await insertAccount("github", "acme", false);
    const ghDef = await insertAccount("github", null, true);
    const ids = [
      await insertRepository(bbMain.id),
      await insertRepository(bbNullMain.id),
      await insertRepository(ghMain.id),
    ];
    for (const resolve of [resolveReviewAccounts, resolveReviewAccountsWithCredentials]) {
      const map = await resolve(testDb.db, ids);
      expect(ids.map((id) => map.get(id)?.effective?.account.id)).toEqual([bbDef.id, bbNullDef.id, ghDef.id]);
    }
  });

  it("8e. WithCredentials: anche lei in DUE query", async () => {
    const main = await insertAccount("github", null, false);
    const repoId = await insertRepository(main.id);
    let queries = 0;
    const counted = drizzle(testDb.client, {
      schema: dbSchema,
      logger: { logQuery: () => void queries++ },
    });
    await resolveReviewAccountsWithCredentials(counted, [repoId]);
    expect(queries).toBe(2);
  });

  it("8b. lista vuota → mappa vuota, nessuna query", async () => {
    let queries = 0;
    const counted = drizzle(testDb.client, {
      schema: dbSchema,
      logger: { logQuery: () => void queries++ },
    });
    expect((await resolveReviewAccounts(counted, [])).size).toBe(0);
    expect(queries).toBe(0);
  });

  it("9. repository inesistente → assente dalla mappa, e resolveReviewAccount null", async () => {
    const missing = randomUUID();
    const map = await resolveReviewAccounts(testDb.db, [missing]);
    expect(map.has(missing)).toBe(false);
    expect(await resolveReviewAccount(testDb.db, missing)).toBeNull();
  });

  it("il predefinito lo legge dal flag in colonna, non da altro", async () => {
    const main = await insertAccount("github", null, false);
    const def = await insertAccount("github", null, false);
    const repoId = await insertRepository(main.id);
    expect((await resolveReviewAccount(testDb.db, repoId))?.effective).toBeNull();
    await testDb.db.execute(sql`update git_accounts set is_default_reviewer = true where id = ${def.id}`);
    expect((await resolveReviewAccount(testDb.db, repoId))?.effective?.account.id).toBe(def.id);
  });
});
