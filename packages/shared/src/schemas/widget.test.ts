import { describe, expect, it } from "vitest";
import { ticketSourceSchema } from "./ticket.js";
import {
  widgetChatMessageBodySchema,
  widgetConversationCreateBodySchema,
  widgetSettingsSchema,
  widgetTicketConfirmBodySchema,
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

  it("limita il messaggio a 2000 caratteri", () => {
    expect(() => widgetChatMessageBodySchema.parse({ content: "a".repeat(2001) })).toThrow();
    expect(widgetChatMessageBodySchema.parse({ content: "ciao" }).content).toBe("ciao");
  });

  it("limita i tipi ticket confermabili", () => {
    expect(() => widgetTicketConfirmBodySchema.parse({ title: "t", body: "b", type: "task" })).toThrow();
    expect(widgetTicketConfirmBodySchema.parse({ title: "t", body: "b", type: "bug" }).type).toBe("bug");
  });

  it("widget settings con default", () => {
    const s = widgetSettingsSchema.parse({});
    expect(s.enabled).toBe(false);
    expect(s.enabledRepositoryIds).toEqual([]);
    expect(s.language).toBe("it");
  });
});
