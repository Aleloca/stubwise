import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readerSchema } from "./reader.js";
import { createOutgoingWebhookSchema, OUTGOING_WEBHOOK_EVENT_IDS, OUTGOING_WEBHOOK_EVENTS, outgoingWebhookViewSchema, updateOutgoingWebhookSchema, webhookEventsOfKind } from "./outgoing-webhooks.js";

/** Area 9, F3, Task 2: il catalogo degli eventi dei webhook. */
describe("il catalogo dei webhook in uscita", () => {
  it("21 eventi unici, e il CHECK della 0188 ha ESATTAMENTE gli stessi", () => {
    expect(OUTGOING_WEBHOOK_EVENT_IDS).toHaveLength(21);
    expect(new Set(OUTGOING_WEBHOOK_EVENT_IDS).size).toBe(21);
    const sql = readFileSync(join(import.meta.dirname, "../../db/drizzle/0188_outgoing_webhooks.sql"), "utf8");
    const check = /CHECK \("events" <@ ARRAY\[([^\]]+)\]/.exec(sql)![1]!;
    const inCheck = [...check.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(inCheck.sort()).toEqual([...OUTGOING_WEBHOOK_EVENT_IDS].sort());
  });

  it("gli eventi della migrazione sono gli eventi «web» (i notify_* di oggi)", () => {
    const sql = readFileSync(join(import.meta.dirname, "../../db/drizzle/0188_outgoing_webhooks.sql"), "utf8");
    const migrated = [...sql.matchAll(/THEN '([^']+)' END/g)].map((m) => m[1]);
    expect(migrated.sort()).toEqual(OUTGOING_WEBHOOK_EVENTS.filter((e) => e.source === "web").map((e) => e.id).sort());
  });

  it("un kind trova il suo evento; uno personale o della posta nessuno", () => {
    expect(webhookEventsOfKind("monitor.recovered")).toEqual(["monitor"]);
    expect(webhookEventsOfKind("request.created")).toEqual(["ticket.created"]);
    expect(webhookEventsOfKind("google.proposal")).toEqual([]);
    expect(webhookEventsOfKind("security.alert")).toEqual([]);
    expect(webhookEventsOfKind("chat.mention")).toEqual([]);
  });

  it("la vista: mai il segreto, e un evento ignoto da un server più nuovo è __unknown__", () => {
    const parsed = readerSchema(outgoingWebhookViewSchema).parse({ id: "40000000-0000-4000-8000-000000000001", name: "W", url: "https://h.example.com", format: "generic", enabled: true, events: ["job.failed", "chat.new"], createdAt: "2026-11-18T10:00:00.000Z", secret: "s" });
    expect(parsed).not.toHaveProperty("secret");
    expect(parsed.events).toEqual(["job.failed", "__unknown__"]);
    expect(parsed).toMatchObject({ secretSet: false, secretRotatedAt: null });
  });

  it("una patch col solo nome resta col solo nome (nessun default che riaccende o svuota); la creazione ha i default", () => {
    expect(updateOutgoingWebhookSchema.parse({ name: "Solo nome" })).toEqual({ name: "Solo nome" });
    expect(createOutgoingWebhookSchema.parse({ name: "N", url: "https://h.example.com", format: "generic" })).toMatchObject({ enabled: true, events: [] });
  });
});
