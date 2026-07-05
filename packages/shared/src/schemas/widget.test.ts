import { describe, expect, it } from "vitest";
import { ticketSourceSchema } from "./ticket.js";
import {
  widgetChatMessageBodySchema,
  widgetConversationCreateBodySchema,
  widgetSettingsSchema,
  widgetTicketConfirmBodySchema,
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

  it("repositoryFilters valida paths e slugs", () => {
    expect(widgetUpsertBodySchema.parse({ name: "x" }).repositoryFilters).toEqual({});
    const repoId = "0b7e5b7e-0000-4000-8000-000000000001";
    const ok = widgetUpsertBodySchema.parse({
      name: "x",
      repositoryFilters: { [repoId]: { paths: ["apps/webapp"], slugs: ["faq"] } },
    });
    expect(ok.repositoryFilters[repoId]).toEqual({ paths: ["apps/webapp"], slugs: ["faq"] });
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
  });
});
