import { describe, expect, it } from "vitest";
import { ticketSourceSchema } from "./ticket.js";
import {
  widgetChatMessageBodySchema,
  widgetConversationCreateBodySchema,
  widgetSettingsSchema,
  widgetTicketConfirmBodySchema,
  normalizeWidgetOrigin,
  widgetAdminSchema,
  widgetUpsertBodySchema,
} from "./widget.js";

describe("widget schemas", () => {
  it("accetta la source widget", () => {
    expect(ticketSourceSchema.parse("widget")).toBe("widget");
  });

  it("valida la creazione conversazione", () => {
    const parsed = widgetConversationCreateBodySchema.parse({
      user: { id: "u_42", email: "a@b.it", name: "Mario" },
    });
    expect(parsed.user.id).toBe("u_42");
    expect(widgetConversationCreateBodySchema.parse({ user: { id: "x" } }).user.email).toBeUndefined();
  });

  it("limita il messaggio a 2000 caratteri e richiede userId", () => {
    expect(() =>
      widgetChatMessageBodySchema.parse({ content: "a".repeat(2001), userId: "u_1" }),
    ).toThrow();
    // userId obbligatorio: assente → invalido.
    expect(() => widgetChatMessageBodySchema.parse({ content: "ciao" })).toThrow();
    const parsed = widgetChatMessageBodySchema.parse({ content: "ciao", userId: "u_1" });
    expect(parsed.content).toBe("ciao");
    expect(parsed.userId).toBe("u_1");
  });

  it("limita i tipi ticket confermabili e richiede userId", () => {
    expect(() =>
      widgetTicketConfirmBodySchema.parse({ title: "t", body: "b", type: "task", userId: "u_1" }),
    ).toThrow();
    // userId obbligatorio: assente → invalido (come chat/storico).
    expect(() =>
      widgetTicketConfirmBodySchema.parse({ title: "t", body: "b", type: "bug" }),
    ).toThrow();
    const parsed = widgetTicketConfirmBodySchema.parse({
      title: "t",
      body: "b",
      type: "bug",
      userId: "u_1",
    });
    expect(parsed.type).toBe("bug");
    expect(parsed.userId).toBe("u_1");
  });

  it("widget settings con default", () => {
    const s = widgetSettingsSchema.parse({});
    expect(s.enabled).toBe(false);
    expect(s.enabledRepositoryIds).toEqual([]);
    expect(s.language).toBe("it");
  });

  it("widget settings rifiuta accentColor e repo id non validi", () => {
    expect(() => widgetSettingsSchema.parse({ accentColor: "#fff" })).toThrow();
    expect(() => widgetSettingsSchema.parse({ enabledRepositoryIds: ["non-uuid"] })).toThrow();
  });

  it("widget upsert richiede il nome e accetta cap nullable", () => {
    const parsed = widgetUpsertBodySchema.parse({ name: "Webapp" });
    expect(parsed.name).toBe("Webapp");
    expect(parsed.dailyMessageCap).toBeNull();
    expect(parsed.dailyTicketCap).toBeNull();
    expect(parsed.enabled).toBe(false); // eredita i default di widgetSettingsSchema
    expect(() => widgetUpsertBodySchema.parse({})).toThrow(); // name mancante
    expect(() => widgetUpsertBodySchema.parse({ name: "x", dailyMessageCap: 0 })).toThrow(); // min 1
    expect(widgetUpsertBodySchema.parse({ name: "x", dailyMessageCap: 500 }).dailyMessageCap).toBe(
      500,
    );
  });

  it("instructions: default \"\", round-trip, > 4000 → throw", () => {
    // Default: stringa vuota (nessuna istruzione aggiuntiva).
    expect(widgetUpsertBodySchema.parse({ name: "x" }).instructions).toBe("");
    // Round-trip di un testo libero.
    const parsed = widgetUpsertBodySchema.parse({
      name: "x",
      instructions: "Sii sintetico e suggerisci il piano Pro.",
    });
    expect(parsed.instructions).toBe("Sii sintetico e suggerisci il piano Pro.");
    // Oltre il cap di 4000 caratteri → throw.
    expect(() =>
      widgetUpsertBodySchema.parse({ name: "x", instructions: "a".repeat(4001) }),
    ).toThrow();
    // Esattamente 4000 → ok.
    expect(
      widgetUpsertBodySchema.parse({ name: "x", instructions: "a".repeat(4000) }).instructions,
    ).toHaveLength(4000);
  });

  it("repositoryFilters valida paths e slugs", () => {
    expect(widgetUpsertBodySchema.parse({ name: "x" }).repositoryFilters).toEqual({});
    const repoId = "0b7e5b7e-0000-4000-8000-000000000001";
    const ok = widgetUpsertBodySchema.parse({
      name: "x",
      repositoryFilters: { [repoId]: { paths: ["apps/webapp"], slugs: ["faq"] } },
    });
    expect(ok.repositoryFilters[repoId]).toEqual({
      paths: ["apps/webapp"],
      slugs: ["faq"],
      kinds: [],
    });
    expect(() =>
      widgetUpsertBodySchema.parse({ name: "x", repositoryFilters: { nope: { paths: [], slugs: [] } } }),
    ).toThrow();
    expect(() =>
      widgetUpsertBodySchema.parse({
        name: "x",
        repositoryFilters: { [repoId]: { paths: ["../secrets"], slugs: [] } },
      }),
    ).toThrow();
    expect(() =>
      widgetUpsertBodySchema.parse({
        name: "x",
        repositoryFilters: { [repoId]: { paths: ["/apps/"], slugs: [] } },
      }),
    ).toThrow();
    expect(() =>
      widgetUpsertBodySchema.parse({
        name: "x",
        repositoryFilters: { [repoId]: { paths: [""], slugs: [] } },
      }),
    ).toThrow();
    // Segmento vuoto in mezzo (a//b): non normalizzato, rifiutato.
    expect(() =>
      widgetUpsertBodySchema.parse({
        name: "x",
        repositoryFilters: { [repoId]: { paths: ["apps//webapp"], slugs: [] } },
      }),
    ).toThrow();
  });

  it("repositoryFilters: kinds default [], round-trip e kind invalido throw", () => {
    const repoId = "0b7e5b7e-0000-4000-8000-000000000001";
    // kinds omesso (forma vecchia {paths,slugs}) → default [].
    const legacy = widgetUpsertBodySchema.parse({
      name: "x",
      repositoryFilters: { [repoId]: { paths: ["apps/webapp"], slugs: [] } },
    });
    expect(legacy.repositoryFilters[repoId]!.kinds).toEqual([]);

    // Round-trip con kinds validi.
    const ok = widgetUpsertBodySchema.parse({
      name: "x",
      repositoryFilters: {
        [repoId]: { paths: [], slugs: [], kinds: ["functional", "manual"] },
      },
    });
    expect(ok.repositoryFilters[repoId]).toEqual({
      paths: [],
      slugs: [],
      kinds: ["functional", "manual"],
    });

    // Kind inesistente → throw.
    expect(() =>
      widgetUpsertBodySchema.parse({
        name: "x",
        repositoryFilters: { [repoId]: { paths: [], slugs: [], kinds: ["nope"] } },
      }),
    ).toThrow();
  });
});

// Area 8, F3, S16: i siti ammessi del widget.
describe("i siti ammessi", () => {
  it("un'origine si normalizza come la manda il browser", () => {
    expect(normalizeWidgetOrigin("https://Shop.Example.com/")).toBe("https://shop.example.com");
    expect(normalizeWidgetOrigin(" https://a.com:443 ")).toBe("https://a.com");
    expect(normalizeWidgetOrigin("https://a.com:8443")).toBe("https://a.com:8443");
    expect(normalizeWidgetOrigin("http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("non è un'origine: percorso, query, frammento, credenziali, http fuori da localhost, schema diverso", () => {
    for (const bad of [
      "https://a.com/shop",
      "https://a.com/?x=1",
      "https://a.com/#x",
      "https://u:p@a.com",
      "http://a.com",
      "ftp://a.com",
      "a.com",
      "",
    ]) {
      expect(normalizeWidgetOrigin(bad), bad).toBeNull();
    }
  });

  it("il corpo: facoltativo, normalizzato, senza doppioni, al più 20, una voce cattiva rifiuta tutto", () => {
    const base = { name: "W" };
    expect(widgetUpsertBodySchema.parse(base).origins).toBeUndefined();
    expect(widgetUpsertBodySchema.parse({ ...base, origins: ["https://A.com/", "https://a.com"] }).origins).toEqual(["https://a.com"]);
    expect(widgetUpsertBodySchema.safeParse({ ...base, origins: ["https://a.com", "https://a.com/x"] }).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => `https://s${i}.com`);
    expect(widgetUpsertBodySchema.safeParse({ ...base, origins: many }).success).toBe(false);
  });

  it("la vista di un server più vecchio, senza `origins`: elenco vuoto", () => {
    const w = widgetAdminSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "W",
      key: "k",
      enabled: true,
      enabledRepositoryIds: [],
      repositoryFilters: {},
      title: "t",
      welcomeMessage: "w",
      instructions: "",
      accentColor: "#22c55e",
      language: "it",
      dailyMessageCap: null,
      dailyTicketCap: null,
      createdAt: "2026-11-14T10:00:00.000Z",
      conversationCount: 0,
    });
    expect(w.origins).toEqual([]);
  });
});
