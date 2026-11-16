import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversation, fetchConfig, fetchMessages, fetchMyRequest, fetchMyRequests, sendMessage, type WidgetApiBase } from "./api.js";
import { createIdentitySource } from "./identity.js";

/**
 * Area 8, «L'API per i siti»: il token d'identità che il SITO firma per il
 * suo cliente. Il widget lo manda in `Authorization` sulle rotte della
 * conversazione e sulle letture (mai sulla config); a un 401
 * `invalid_identity` chiede un token NUOVO una volta sola e riprova.
 */

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
function respond(...responses: [number, unknown][]): void {
  const queue = [...responses];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      const [status, body] = queue.shift() ?? [200, {}];
      return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    }),
  );
}
const auth = (c: Call) => (c.init.headers as Record<string, string>)["authorization"];
const dsn = { origin: "https://app.example.com", slug: "acme", key: "pub" };
afterEach(() => {
  calls = [];
  vi.unstubAllGlobals();
});

describe("il token d'identità del widget", () => {
  it("una stringa va in Authorization su conversazioni e messaggi, MAI sulla config", async () => {
    const base: WidgetApiBase = { ...dsn, identity: createIdentitySource("tok-1") };
    respond([200, { enabled: false }], [200, { conversationId: "c" }], [200, { messages: [] }]);
    await fetchConfig(base);
    await createConversation(base, { id: "anna" });
    await fetchMessages(base, "c", "anna");
    expect(auth(calls[0]!)).toBeUndefined();
    expect(auth(calls[1]!)).toBe("Bearer tok-1");
    expect(auth(calls[2]!)).toBe("Bearer tok-1");
  });

  it("una funzione si chiama una volta (cache); a un 401 invalid_identity se ne chiede uno NUOVO, una sola volta, e si riprova", async () => {
    let n = 0;
    const provider = vi.fn(async () => `tok-${++n}`);
    const base: WidgetApiBase = { ...dsn, identity: createIdentitySource(provider) };
    respond([200, { conversationId: "c" }], [401, { code: "invalid_identity" }], [200, { messages: [] }]);
    await createConversation(base, { id: "anna" });
    await fetchMessages(base, "c", "anna");
    expect(provider).toHaveBeenCalledTimes(2);
    expect(calls.map(auth)).toEqual(["Bearer tok-1", "Bearer tok-1", "Bearer tok-2"]);
  });

  it("un secondo 401 dopo il rinnovo non si riprova più: l'errore arriva", async () => {
    const base: WidgetApiBase = { ...dsn, identity: createIdentitySource(async () => "tok") };
    respond([401, { code: "invalid_identity" }], [401, { code: "invalid_identity" }]);
    await expect(createConversation(base, { id: "anna" })).rejects.toMatchObject({ status: 401, code: "invalid_identity" });
    expect(calls).toHaveLength(2);
  });

  it("un altro 401 (identity_mismatch) non rinnova il token", async () => {
    const provider = vi.fn(async () => "tok");
    const base: WidgetApiBase = { ...dsn, identity: createIdentitySource(provider) };
    respond([401, { code: "identity_mismatch" }]);
    await expect(createConversation(base, { id: "bruno" })).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it("lo stream dei messaggi porta il token", async () => {
    const base: WidgetApiBase = { ...dsn, identity: createIdentitySource("tok") };
    respond([200, {}]);
    await sendMessage(base, "c", { content: "ciao", userId: "anna" });
    expect(auth(calls[0]!)).toBe("Bearer tok");
  });

  it("senza identità nessun header (il widget di prima)", async () => {
    respond([200, { conversationId: "c" }]);
    await createConversation(dsn, { id: "anna" });
    expect(auth(calls[0]!)).toBeUndefined();
  });

  it("le letture per il sito: elenco e dettaglio col token, il codice nel percorso", async () => {
    const base: WidgetApiBase = { ...dsn, identity: createIdentitySource("tok") };
    respond([200, { items: [], total: 0 }], [200, { code: "ACME-S1", messages: [] }]);
    expect(await fetchMyRequests(base)).toEqual({ items: [], total: 0 });
    await fetchMyRequest(base, "ACME-S1");
    expect(calls.map((c) => c.url)).toEqual(["https://app.example.com/widget/acme/me/requests", "https://app.example.com/widget/acme/me/requests/ACME-S1"]);
    expect(calls.map(auth)).toEqual(["Bearer tok", "Bearer tok"]);
  });
});
