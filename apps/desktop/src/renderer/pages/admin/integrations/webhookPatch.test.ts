import { describe, expect, it } from "vitest";
import type { WebhookEventId, WebhookView } from "../../../data/queries";
import { editBlockOf, patchOf } from "./webhookPatch";

// Review F3, I2: la modifica di un webhook manda SOLO i campi cambiati, così
// non tocca ciò che il client non conosce (eventi nuovi del server, un formato
// nuovo); e un webhook con un formato sconosciuto non si modifica da qui.

const w: WebhookView = {
  id: "w1",
  name: "Webhook",
  url: "https://hooks.slack.com/x",
  format: "slack",
  enabled: true,
  events: ["ticket.created", "job.failed"],
  secretSet: true,
  secretRotatedAt: null,
  createdAt: "2026-11-01T09:00:00.000Z",
  lastTest: null,
};

describe("la patch di un webhook", () => {
  it("niente di cambiato: patch vuota; un campo cambiato: solo lui", () => {
    const same = {
      name: "Webhook",
      url: "https://hooks.slack.com/x",
      format: "slack" as const,
      enabled: true,
      events: ["job.failed", "ticket.created"] as WebhookEventId[],
    };
    expect(patchOf(w, same)).toEqual({});
    expect(patchOf(w, { ...same, name: " Slack #ops " })).toEqual({ name: "Slack #ops" });
    expect(patchOf(w, { ...same, enabled: false })).toEqual({ enabled: false });
    expect(patchOf(w, { ...same, events: ["job.failed"] as WebhookEventId[] })).toEqual({
      events: ["job.failed"],
    });
    expect(patchOf(w, { ...same, url: " https://new.test/h " })).toEqual({
      url: "https://new.test/h",
    });
  });

  it("un formato sconosciuto blocca la modifica; eventi sconosciuti bloccano solo gli eventi", () => {
    expect(editBlockOf(w)).toEqual({ form: false, events: false });
    expect(editBlockOf({ ...w, formatUnknown: true })).toEqual({ form: true, events: true });
    expect(editBlockOf({ ...w, unknownEvents: true })).toEqual({ form: false, events: true });
  });
});
