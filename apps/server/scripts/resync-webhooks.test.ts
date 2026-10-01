import { randomBytes } from "node:crypto";
import { encrypt, gitAccounts, repositories } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { GitProviderError } from "@stubwise/git";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRequestTimeout, resyncWebhooks, summaryLines, type ProviderFor } from "./resync-webhooks.js";

/**
 * Passo manuale del deploy del ciclo di correzione (30 set 2026): i webhook
 * già registrati non conoscono "Request changes". Lo script chiede a ogni
 * provider di aggiornarli; l'idempotenza è di `ensureWebhook` (aggiorna quello
 * con lo stesso URL), quindi qui si verifica COSA gli si passa.
 */

let testDb: TestDb;
const KEY = randomBytes(32);
const PUBLIC_URL = "https://stubwise.example.com";
const quietLogger = { info: () => {}, warn: () => {} };

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

const ensureWebhook = vi.fn();
const providerFor: ProviderFor = () => ({ ensureWebhook });

beforeEach(async () => {
  ensureWebhook.mockReset();
  ensureWebhook.mockResolvedValue({ created: false, updated: true, id: "h1", detail: "ok" });
  // Ogni test parte senza repository: lo script li prende TUTTI.
  await testDb.db.delete(repositories);
});

const CONFIGURED_AT = new Date("2026-09-01T10:00:00Z");

/** Di default il repository ha GIÀ un webhook configurato: lo script riallinea, non crea. */
async function seedRepo(opts: { secret?: string; provider?: "github" | "bitbucket"; configured?: boolean } = {}) {
  const provider = opts.provider ?? "github";
  const { repositoryId } = await seedRepository(testDb.db, { provider });
  const [account] = await testDb.db
    .insert(gitAccounts)
    .values({
      name: `Account ${randomBytes(3).toString("hex")}`,
      provider,
      encryptedCredentials: encrypt(JSON.stringify({ username: "bot", token: "tok" }), KEY),
    })
    .returning();
  const [repo] = await testDb.db
    .update(repositories)
    .set({
      gitAccountId: account!.id,
      webhookSecret: opts.secret ?? "a".repeat(32),
      webhookConfiguredAt: opts.configured === false ? null : CONFIGURED_AT,
    })
    .where(eq(repositories.id, repositoryId))
    .returning();
  return repo!;
}

/** Un fetch che non deve MAI essere chiamato davvero: i test non parlano con la rete. */
const noNetwork = vi.fn(async () => {
  throw new Error("rete non consentita nei test");
});

function run(
  dryRun = false,
  publicUrl = PUBLIC_URL,
  extra: { includeUnconfigured?: boolean; fetchImpl?: typeof noNetwork; requestTimeoutMs?: number } = {},
) {
  return resyncWebhooks(testDb.db, {
    dryRun,
    encryptionKey: KEY,
    publicUrl,
    providerFor,
    logger: quietLogger,
    fetchImpl: extra.fetchImpl ?? noNetwork,
    includeUnconfigured: extra.includeUnconfigured,
    requestTimeoutMs: extra.requestTimeoutMs,
  });
}

describe("resyncWebhooks", () => {
  it("chiama ensureWebhook su ogni repository con URL, segreto e credenziali decifrate", async () => {
    const a = await seedRepo();
    const b = await seedRepo({ provider: "bitbucket" });

    const result = await run();

    expect(result).toEqual({
      candidates: 2,
      created: 0,
      updated: 2,
      failed: 0,
      toCreate: [],
      skippedUnconfigured: 0,
    });
    for (const repo of [a, b]) {
      expect(ensureWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ repoUrl: repo.repoUrl, credentials: { username: "bot", token: "tok" } }),
        { url: `${PUBLIC_URL}/webhooks/git/${repo.slug}`, secret: repo.webhookSecret },
        expect.anything(),
      );
    }
    const rows = await testDb.db
      .select({ at: repositories.webhookConfiguredAt })
      .from(repositories)
      .where(inArray(repositories.id, [a.id, b.id]));
    expect(rows.every((r) => r.at !== null && r.at.getTime() > CONFIGURED_AT.getTime())).toBe(true);
  });

  it("--dry-run: nessuna chiamata, nessuna scrittura", async () => {
    await seedRepo();

    const result = await run(true);

    expect(result).toEqual({
      candidates: 1,
      created: 0,
      updated: 0,
      failed: 0,
      toCreate: [],
      skippedUnconfigured: 0,
    });
    expect(ensureWebhook).not.toHaveBeenCalled();
    const [row] = await testDb.db.select({ at: repositories.webhookConfiguredAt }).from(repositories);
    expect(row!.at).toEqual(CONFIGURED_AT);
  });

  it("un repository senza segreto (legacy) non si tocca: il webhook non sarebbe verificabile", async () => {
    await seedRepo({ secret: "" });

    const result = await run();

    expect(result.candidates).toBe(0);
    expect(ensureWebhook).not.toHaveBeenCalled();
  });

  it("un provider che rifiuta non ferma gli altri", async () => {
    await seedRepo();
    await seedRepo();
    ensureWebhook
      .mockRejectedValueOnce(new GitProviderError("Manca lo scope webhook", 403, ""))
      .mockResolvedValueOnce({ created: true, updated: false, id: "h2", detail: "ok" });

    const result = await run();

    expect(result).toMatchObject({ candidates: 2, created: 1, updated: 0, failed: 1 });
  });

  it("credenziali non decifrabili: quel repository fallisce, senza chiamare il provider", async () => {
    const repo = await seedRepo();
    await testDb.db
      .update(gitAccounts)
      .set({ encryptedCredentials: "blob-rotto" })
      .where(eq(gitAccounts.id, repo.gitAccountId));

    const result = await run();

    expect(result.failed).toBe(1);
    expect(ensureWebhook).not.toHaveBeenCalled();
  });

  it("lo slash finale di PUBLIC_URL non raddoppia", async () => {
    const repo = await seedRepo();

    await run(false, `${PUBLIC_URL}/`);

    expect(ensureWebhook.mock.calls[0]![1]).toMatchObject({ url: `${PUBLIC_URL}/webhooks/git/${repo.slug}` });
  });

  it("riallinea, non crea: un repository mai configurato resta fuori di default", async () => {
    const configured = await seedRepo();
    const never = await seedRepo({ configured: false });

    const result = await run();

    expect(result).toMatchObject({ candidates: 1, updated: 1, created: 0, toCreate: [], skippedUnconfigured: 1 });
    expect(ensureWebhook).toHaveBeenCalledTimes(1);
    expect(ensureWebhook.mock.calls[0]![1]).toMatchObject({ url: `${PUBLIC_URL}/webhooks/git/${configured.slug}` });
    const [row] = await testDb.db
      .select({ at: repositories.webhookConfiguredAt })
      .from(repositories)
      .where(eq(repositories.id, never.id));
    expect(row!.at).toBeNull();
  });

  it("--include-unconfigured prende anche i mai configurati", async () => {
    await seedRepo();
    const never = await seedRepo({ configured: false });
    // Per URL, non per ordine di chiamata: l'ordine è quello degli slug.
    ensureWebhook.mockImplementation(async (_p: unknown, h: { url: string }) =>
      h.url.endsWith(`/${never.slug}`)
        ? { created: true, updated: false, id: "h2", detail: "ok" }
        : { created: false, updated: true, id: "h1", detail: "ok" },
    );

    const result = await run(false, PUBLIC_URL, { includeUnconfigured: true });

    expect(result).toMatchObject({ candidates: 2, skippedUnconfigured: 0, toCreate: [never.slug] });
    expect(ensureWebhook).toHaveBeenCalledTimes(2);
    const urls = ensureWebhook.mock.calls.map((c) => (c[1] as { url: string }).url);
    expect(urls).toContain(`${PUBLIC_URL}/webhooks/git/${never.slug}`);
  });

  it("--dry-run elenca a parte quelli che verrebbero CREATI", async () => {
    const configured = await seedRepo();
    const never = await seedRepo({ configured: false });

    const result = await run(true, PUBLIC_URL, { includeUnconfigured: true });

    expect(result).toMatchObject({ candidates: 2, failed: 0, toCreate: [never.slug] });
    expect(result.toCreate).not.toContain(configured.slug);
    expect(ensureWebhook).not.toHaveBeenCalled();
  });

  it("--dry-run decifra comunque: una credenziale rotta emerge già in prova", async () => {
    const repo = await seedRepo();
    await testDb.db
      .update(gitAccounts)
      .set({ encryptedCredentials: "blob-rotto" })
      .where(eq(gitAccounts.id, repo.gitAccountId));

    const result = await run(true);

    expect(result.failed).toBe(1);
    expect(ensureWebhook).not.toHaveBeenCalled();
  });

  it("un mai configurato con credenziali non decifrabili non è «da creare»: è un fallito, contato a parte", async () => {
    const good = await seedRepo({ configured: false });
    const broken = await seedRepo({ configured: false });
    await testDb.db
      .update(gitAccounts)
      .set({ encryptedCredentials: "blob-rotto" })
      .where(eq(gitAccounts.id, broken.gitAccountId));

    ensureWebhook.mockResolvedValue({ created: true, updated: false, id: "h1", detail: "creato" });

    for (const dryRun of [true, false]) {
      const result = await run(dryRun, PUBLIC_URL, { includeUnconfigured: true });
      expect(result.toCreate).toEqual([good.slug]);
      expect(result.failed).toBe(1);
      if (dryRun) {
        // 2 candidati: 0 da riallineare, 1 da creare, 1 rotto — non -1.
        expect(summaryLines(result, true)[0]).toContain("0 da riallineare, 1 da creare, 1 con credenziali non decifrabili");
      }
    }
  });

  it("nel run vero un mai configurato rifiutato dal provider non compare fra i creati", async () => {
    await seedRepo({ configured: false });
    ensureWebhook.mockRejectedValueOnce(new GitProviderError("rifiutato", 403, ""));

    const result = await run(false, PUBLIC_URL, { includeUnconfigured: true });

    expect(result).toMatchObject({ failed: 1, toCreate: [] });
  });

  it("un mai configurato il cui hook esisteva già sul provider è «aggiornato», non «creato»", async () => {
    const created = await seedRepo({ configured: false });
    await seedRepo({ configured: false });
    ensureWebhook.mockImplementation(async (_p: unknown, h: { url: string }) =>
      h.url.endsWith(`/${created.slug}`)
        ? { created: true, updated: false, id: "h1", detail: "creato" }
        : { created: false, updated: true, id: "h2", detail: "aggiornato" },
    );

    const result = await run(false, PUBLIC_URL, { includeUnconfigured: true });

    expect(result).toMatchObject({ created: 1, updated: 1, failed: 0, toCreate: [created.slug] });
  });

  it("l'update di webhookConfiguredAt fallisce: il repository non è fra i creati, ed è un fallito", async () => {
    await seedRepo({ configured: false });
    ensureWebhook.mockResolvedValueOnce({ created: true, updated: false, id: "h1", detail: "creato" });
    const realUpdate = testDb.db.update.bind(testDb.db);
    const spy = vi.spyOn(testDb.db, "update").mockImplementation(((table: unknown) => {
      if (table === repositories) throw new Error("db giù");
      return realUpdate(table as typeof repositories);
    }) as typeof testDb.db.update);

    const result = await run(false, PUBLIC_URL, { includeUnconfigured: true });
    spy.mockRestore();

    expect(result).toMatchObject({ toCreate: [], created: 0, failed: 1 });
  });

  it("riepilogo: «verrebbero CREATI» solo in --dry-run, «creati» nel run vero", async () => {
    const result = {
      candidates: 2,
      created: 1,
      updated: 1,
      failed: 0,
      toCreate: ["repo-nuovo"],
      skippedUnconfigured: 0,
    };

    const dry = summaryLines(result, true).join("\n");
    const real = summaryLines(result, false).join("\n");

    expect(dry).toContain("verrebbero CREATI (mai configurati): repo-nuovo");
    expect(real).not.toContain("verrebbero");
    expect(real).toContain("creati (mai configurati): repo-nuovo");
  });

  it("un provider che non risponde: timeout, fallito, e lo script passa al successivo", async () => {
    await seedRepo();
    await seedRepo();
    // Un fetch che non risponde mai, se non quando il segnale lo interrompe.
    const hanging = vi.fn(
      (_input: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    // Il primo repository usa il fetch dato (e resta appeso), il secondo risponde.
    ensureWebhook
      .mockImplementationOnce(async (_p, _h, deps: { fetchImpl: (u: string) => Promise<Response> }) => {
        await deps.fetchImpl("https://api.example.test/hooks");
        return { created: false, updated: true, id: "h1", detail: "ok" };
      })
      .mockResolvedValueOnce({ created: false, updated: true, id: "h2", detail: "ok" });

    const result = await run(false, PUBLIC_URL, { fetchImpl: hanging, requestTimeoutMs: 30 });

    expect(hanging).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ candidates: 2, updated: 1, failed: 1 });
  });
});

describe("fetchWithRequestTimeout", () => {
  const hanging = (_input: string | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });

  it("un signal già presente resta valido: chi lo interrompe interrompe la richiesta", async () => {
    const controller = new AbortController();
    const pending = fetchWithRequestTimeout(hanging, 60_000)("https://api.example.test", {
      signal: controller.signal,
    });
    controller.abort(new Error("annullata dal chiamante"));
    await expect(pending).rejects.toThrow("annullata dal chiamante");
  });

  it("il timeout interrompe una richiesta che non risponde", async () => {
    await expect(fetchWithRequestTimeout(hanging, 20)("https://api.example.test")).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });
});
