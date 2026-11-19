import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealIntegration, type IntegrationApi } from "./projectIntegration";

// Area 9, F5: Progetto → Settings → Integration su
// `GET /api/projects/:id/integration` (72, a19c56d09): la chiave solo con le
// ultime 4, DSN, snippet e guida mascherati, i webhook git e chi può
// rigenerare, tutto dal server. La chiave intera esce solo dalla
// rigenerazione, una volta.

const VIEW = {
  ingestion: {
    last4: "4267",
    createdAt: "2026-10-02T09:00:00.000Z",
    createdBy: { id: "u1", name: "Laura Costa" },
    dsnBase: "https://stubwise.example.test/p/acquedotto",
  },
  inbound: { url: "https://stubwise.example.test/api/inbound/acquedotto/ticket" },
  gitWebhooks: [
    {
      repositoryId: "r1",
      slug: "portale-utenti",
      name: "portale-utenti",
      url: "https://stubwise.example.test/webhooks/github/portale-utenti",
      secretLast4: "9f0a",
      configured: true,
    },
  ],
  canRegenerateKey: true,
  canRegenerateWebhookSecret: false,
};

const refusing = (status: number, code: string) => async () => {
  throw new ApiError(status, code, code);
};

function fake(over: Partial<IntegrationApi> = {}) {
  const calls: string[] = [];
  const api: IntegrationApi = {
    integration: async () => VIEW,
    project: async () => ({ name: "Acquedotto", code: "ACQ" }),
    regenerateIngestionKey: async (id) => {
      calls.push(`key ${id}`);
      return { ingestionKey: "sk_full_key_abcd" };
    },
    regenerateWebhookSecret: async (slug) => {
      calls.push(`secret ${slug}`);
      return { mode: "manual", webhookSecret: "whsec_new" };
    },
    ...over,
  };
  return { api, calls };
}

describe("Integration dal server", () => {
  it("la lettura: mascherata, coi webhook e i permessi del server", async () => {
    const view = (await createRealIntegration(fake().api).getIntegration("p1"))!;
    expect(view.ingestion).toEqual({
      last4: "4267",
      createdAt: "2026-10-02T09:00:00.000Z",
      createdBy: { id: "u1", name: "Laura Costa" },
      maskedDsn: "https://••••4267@stubwise.example.test/p/acquedotto",
      maskedSnippet: expect.stringContaining(
        'dsn: "https://••••4267@stubwise.example.test/p/acquedotto"',
      ),
    });
    expect(view.inbound).toEqual({
      url: "https://stubwise.example.test/api/inbound/acquedotto/ticket",
      auth: "Bearer ••••4267",
    });
    expect(view.gitWebhooks).toEqual([
      {
        repositoryId: "r1",
        name: "portale-utenti",
        url: "https://stubwise.example.test/webhooks/github/portale-utenti",
        secretLast4: "9f0a",
        canRegenerate: false,
        state: "configured",
        provider: null,
      },
    ]);
    expect(view.canRegenerateKey).toBe(true);
    expect(view.guide).toContain("# Send Acquedotto's errors to Stubwise");
    expect(view.guide).toContain("the ingestion key is `••••4267`");
    expect(JSON.stringify(view)).not.toContain("sk_full_key");
  });

  it("un progetto che non si vede: null", async () => {
    const hidden = createRealIntegration(fake({ integration: refusing(404, "not_found") }).api);
    expect(await hidden.getIntegration("p1")).toBeNull();
  });

  it("la chiave nuova esce una volta, con DSN e snippet interi", async () => {
    const { api, calls } = fake();
    expect(await createRealIntegration(api).regenerateIngestionKey("p1")).toEqual({
      ok: true,
      key: "sk_full_key_abcd",
      dsn: "https://sk_full_key_abcd@stubwise.example.test/p/acquedotto",
      snippet: expect.stringContaining(
        'dsn: "https://sk_full_key_abcd@stubwise.example.test/p/acquedotto"',
      ),
    });
    expect(calls).toEqual(["key p1"]);
  });

  it("F5 review, M5: la rilettura dopo la rigenerazione che fallisce non perde la chiave (DSN vuoto)", async () => {
    const api = fake({
      integration: async () => {
        throw new Error("rete giù");
      },
    }).api;
    expect(await createRealIntegration(api).regenerateIngestionKey("p1")).toEqual({
      ok: true,
      key: "sk_full_key_abcd",
      dsn: "",
      snippet: expect.stringContaining('dsn: ""'),
    });
  });

  it("la chiave: riconferma e permesso col loro rifiuto", async () => {
    const reauth = createRealIntegration(
      fake({ regenerateIngestionKey: refusing(403, "reauth_required") }).api,
    );
    expect(await reauth.regenerateIngestionKey("p1")).toEqual({
      ok: false,
      error: "reauth_required",
    });
    const forbidden = createRealIntegration(
      fake({ regenerateIngestionKey: refusing(403, "forbidden") }).api,
    );
    expect(await forbidden.regenerateIngestionKey("p1")).toEqual({ ok: false, error: "forbidden" });
  });

  it("il segreto del webhook: per slug, dal repository della lettura", async () => {
    const { api, calls } = fake();
    const integration = createRealIntegration(api);
    await integration.getIntegration("p1");
    expect(await integration.regenerateWebhookSecret("r1")).toEqual({
      ok: true,
      secret: "whsec_new",
      mode: "manual",
    });
    expect(calls).toEqual(["secret portale-utenti"]);
    const failed = createRealIntegration(
      fake({ regenerateWebhookSecret: refusing(422, "webhook_scope_missing") }).api,
    );
    await failed.getIntegration("p1");
    expect(await failed.regenerateWebhookSecret("r1")).toEqual({
      ok: false,
      error: "invalid",
      reason: "webhook_scope_missing",
    });
  });

  it("un repository che la lettura non dà: not_found, senza chiamate", async () => {
    const { api, calls } = fake();
    const integration = createRealIntegration(api);
    await integration.getIntegration("p1");
    expect(await integration.regenerateWebhookSecret("rX")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(calls).toEqual([]);
  });
});
