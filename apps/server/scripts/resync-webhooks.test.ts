import { randomBytes } from "node:crypto";
import { encrypt, gitAccounts, repositories } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { GitProviderError } from "@stubwise/git";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resyncWebhooks, type ProviderFor } from "./resync-webhooks.js";

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

async function seedRepo(opts: { secret?: string; provider?: "github" | "bitbucket" } = {}) {
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
    .set({ gitAccountId: account!.id, webhookSecret: opts.secret ?? "a".repeat(32) })
    .where(eq(repositories.id, repositoryId))
    .returning();
  return repo!;
}

function run(dryRun = false, publicUrl = PUBLIC_URL) {
  return resyncWebhooks(testDb.db, { dryRun, encryptionKey: KEY, publicUrl, providerFor, logger: quietLogger });
}

describe("resyncWebhooks", () => {
  it("chiama ensureWebhook su ogni repository con URL, segreto e credenziali decifrate", async () => {
    const a = await seedRepo();
    const b = await seedRepo({ provider: "bitbucket" });

    const result = await run();

    expect(result).toEqual({ candidates: 2, created: 0, updated: 2, failed: 0 });
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
    expect(rows.every((r) => r.at !== null)).toBe(true);
  });

  it("--dry-run: nessuna chiamata, nessuna scrittura", async () => {
    await seedRepo();

    const result = await run(true);

    expect(result).toEqual({ candidates: 1, created: 0, updated: 0, failed: 0 });
    expect(ensureWebhook).not.toHaveBeenCalled();
    const [row] = await testDb.db.select({ at: repositories.webhookConfiguredAt }).from(repositories);
    expect(row!.at).toBeNull();
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

    expect(result).toEqual({ candidates: 2, created: 1, updated: 0, failed: 1 });
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
});
