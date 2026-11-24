import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealWebhooks, type WebhooksApi } from "./webhooks";

// Area 9, F3: i webhook in uscita sulle rotte di 72 (`/api/settings/webhooks`).

const W = "40000000-0000-4000-8000-000000000001";
const view = (over: Record<string, unknown> = {}) => ({
  id: W,
  name: "Webhook",
  url: "https://hooks.slack.com/services/T/B/x",
  format: "slack",
  enabled: true,
  events: ["ticket.created", "job.failed"],
  secretSet: true,
  secretRotatedAt: "2026-11-18T09:00:00.000Z",
  createdAt: "2026-11-01T09:00:00.000Z",
  ...over,
});

// `ApiError(status, message, code)`: il messaggio porta il campo della validazione.
const refusing =
  (status: number, code: string, message = code) =>
  async () => {
    throw new ApiError(status, message, code);
  };

function fakeApi(over: Partial<WebhooksApi> = {}) {
  const calls: string[] = [];
  const api: WebhooksApi = {
    list: async () => [view()],
    create: async (input) => {
      calls.push(`create ${JSON.stringify(input)}`);
      return {
        ...view({ id: "40000000-0000-4000-8000-000000000002", name: input.name }),
        secret: "whsec_new",
      };
    },
    update: async (id, patch) => {
      calls.push(`update ${id} ${JSON.stringify(patch)}`);
      return view(patch);
    },
    rotateSecret: async () => ({
      ...view({ secretRotatedAt: "2026-11-18T12:00:00.000Z" }),
      secret: "whsec_rot",
    }),
    remove: async (id) => {
      calls.push(`remove ${id}`);
    },
    test: async () => ({ ok: true, status: 200, error: null }),
    preview: async (format) => ({
      format,
      event: "ticket.created",
      body:
        format === "slack"
          ? { text: "*New task* in ACQ" }
          : format === "discord"
            ? { content: "**New task** in ACQ" }
            : { event: "ticket.created", project: "ACQ" },
    }),
    ...over,
  };
  return { api, calls };
}

describe("i webhook in uscita dal server (area 9, F3)", () => {
  // Rimandi, lotto 5, voce 6 (72, 5323ab351): l'ultima prova la ricorda il
  // server (`lastTest`, tolta a un cambio di URL o formato); la vista la legge.
  it("l'elenco e la pagina di uno; l'ultima prova è quella del server", async () => {
    const w = createRealWebhooks(fakeApi().api);
    const [one] = await w.listWebhooks();
    expect(one).toMatchObject({ id: W, name: "Webhook", secretSet: true, lastTest: null });
    expect(JSON.stringify(one)).not.toContain('secret":"');
    // La prova dice il suo esito, ma la vista non se lo inventa: lo rilegge.
    expect(await w.testWebhook(W)).toEqual({ ok: true, outcome: "ok" });
    expect((await w.getWebhook(W)).lastTest).toBeNull();
    const tested = createRealWebhooks(
      fakeApi({
        list: async () => [
          view({ lastTest: { at: "2026-11-24T09:00:00.000Z", outcome: "unreachable", status: null } }),
        ],
      }).api,
    );
    expect((await tested.getWebhook(W)).lastTest).toEqual({
      at: "2026-11-24T09:00:00.000Z",
      outcome: "unreachable",
      status: null,
    });
    // Revisione del lotto 5, M-5 (72, ee472a680): l'errore della destinazione
    // col codice; una riga di prima, senza `status`, lo ha null.
    const failed = createRealWebhooks(
      fakeApi({
        list: async () => [
          view({
            lastTest: { at: "2026-11-24T09:00:00.000Z", outcome: "destination_error", status: 502 },
          }),
        ],
      }).api,
    );
    expect((await failed.getWebhook(W)).lastTest).toEqual({
      at: "2026-11-24T09:00:00.000Z",
      outcome: "destination_error",
      status: 502,
    });
    const before = createRealWebhooks(
      fakeApi({
        list: async () => [
          view({ lastTest: { at: "2026-11-24T09:00:00.000Z", outcome: "invalid_credentials" } }),
        ],
      }).api,
    );
    expect((await before.getWebhook(W)).lastTest?.status).toBeNull();
    // L'esito subito dopo la prova: 401/403 credenziali, un altro codice
    // errore della destinazione, nessuna risposta irraggiungibile.
    for (const [status, outcome] of [
      [401, "invalid_credentials"],
      [403, "invalid_credentials"],
      [500, "destination_error"],
      [null, "unreachable"],
    ] as const) {
      const w2 = createRealWebhooks(
        fakeApi({ test: async () => ({ ok: false, status, error: "x" }) }).api,
      );
      expect(await w2.testWebhook(W)).toEqual({ ok: true, outcome });
    }
    // Un esito che il client non conosce (server più nuovo): «non ancora provata».
    const unknown = createRealWebhooks(
      fakeApi({
        list: async () => [view({ lastTest: { at: "2026-11-24T09:00:00.000Z", outcome: "__unknown__" } })],
      }).api,
    );
    expect((await unknown.getWebhook(W)).lastTest).toBeNull();
    await expect(w.getWebhook("nope")).rejects.toThrow("not_found");
  });

  it("un formato o eventi che il client non conosce si segnano nella vista (review F3, I2)", async () => {
    const w = createRealWebhooks(
      fakeApi({
        list: async () => [view({ format: "__unknown__", events: ["job.failed", "__unknown__"] })],
      }).api,
    );
    const [one] = await w.listWebhooks();
    expect(one).toMatchObject({ formatUnknown: true, unknownEvents: true, events: ["job.failed"] });
    const [plain] = await createRealWebhooks(fakeApi().api).listWebhooks();
    expect(plain).toMatchObject({ formatUnknown: false, unknownEvents: false });
  });

  it("creare: la vista e il segreto UNA volta; i rifiuti nelle parole del prototipo", async () => {
    const { api, calls } = fakeApi();
    const r = await createRealWebhooks(api).createWebhook({
      name: "Ops",
      url: "https://ops.example.test/h",
      format: "generic",
      enabled: true,
      events: ["job.failed"],
    });
    expect(r).toMatchObject({ ok: true, secret: "whsec_new", webhook: { name: "Ops" } });
    expect(calls[0]).toBe(
      'create {"name":"Ops","url":"https://ops.example.test/h","format":"generic","enabled":true,"events":["job.failed"]}',
    );
    const full = createRealWebhooks(fakeApi({ create: refusing(409, "webhook_limit") }).api);
    expect(
      await full.createWebhook({ name: "X", url: "https://x.test", format: "slack", events: [] }),
    ).toEqual({
      ok: false,
      error: "invalid",
      reason: "webhook_limit",
    });
    const http = createRealWebhooks(
      fakeApi({ create: refusing(400, "FST_ERR_VALIDATION", "body/url must match pattern") }).api,
    );
    expect(
      await http.createWebhook({ name: "X", url: "http://x.test", format: "slack", events: [] }),
    ).toMatchObject({
      reason: "url",
    });
    const name = createRealWebhooks(
      fakeApi({
        create: refusing(
          400,
          "FST_ERR_VALIDATION",
          "body/name must NOT have fewer than 1 characters",
        ),
      }).api,
    );
    expect(
      await name.createWebhook({ name: "", url: "https://x.test", format: "slack", events: [] }),
    ).toMatchObject({ reason: "name" });
    const reauth = createRealWebhooks(fakeApi({ create: refusing(403, "reauth_required") }).api);
    expect(
      await reauth.createWebhook({ name: "X", url: "https://x.test", format: "slack", events: [] }),
    ).toEqual({
      ok: false,
      error: "reauth_required",
    });
  });

  it("modificare manda la patch; rigenerare dà il segreto nuovo e la data; eliminare", async () => {
    const { api, calls } = fakeApi();
    const w = createRealWebhooks(api);
    expect(await w.updateWebhook(W, { enabled: false })).toEqual({ ok: true });
    expect(await w.regenerateWebhookSecret(W)).toEqual({
      ok: true,
      secret: "whsec_rot",
      secretRotatedAt: "2026-11-18T12:00:00.000Z",
    });
    expect(await w.deleteWebhook(W)).toEqual({ ok: true });
    expect(calls).toEqual([`update ${W} {"enabled":false}`, `remove ${W}`]);
  });

  it("la prova: un errore dell'indirizzo, uno di rete; l'anteprima come testo, il JSON indentato", async () => {
    const answered = createRealWebhooks(
      fakeApi({ test: async () => ({ ok: false, status: 401, error: "Unauthorized" }) }).api,
    );
    expect(await answered.testWebhook(W)).toEqual({ ok: true, outcome: "invalid_credentials" });
    const down = createRealWebhooks(
      fakeApi({ test: async () => ({ ok: false, status: null, error: "ECONNREFUSED" }) }).api,
    );
    expect(await down.testWebhook(W)).toEqual({ ok: true, outcome: "unreachable" });
    const w = createRealWebhooks(fakeApi().api);
    expect(await w.previewWebhook("ticket.created", "slack")).toBe("*New task* in ACQ");
    expect(await w.previewWebhook("ticket.created", "discord")).toBe("**New task** in ACQ");
    expect(JSON.parse(await w.previewWebhook("ticket.created", "generic"))).toEqual({
      event: "ticket.created",
      project: "ACQ",
    });
  });
});
