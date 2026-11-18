import { createHmac } from "node:crypto";
import { OUTGOING_WEBHOOK_EVENTS } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { isPersonalWebhookAudience } from "./dispatch.js";
import type { NotificationKind } from "./format.js";
import { sampleEventFor, webhookSignature } from "./webhooks.js";

/**
 * Area 9, F3: le regole pure dei webhook in uscita. La guardia sulle audience
 * personali in `publishNotification` è una difesa in più: la protezione
 * VERA è che il catalogo non contenga nessun kind personale, e questo test lo
 * fissa (un evento nuovo che ne includesse uno lo fa fallire).
 */
describe("webhook in uscita, regole pure", () => {
  it("nessun evento del catalogo copre un kind d'audience personale", () => {
    const personal = OUTGOING_WEBHOOK_EVENTS.flatMap((e) => e.kinds.filter((k) => isPersonalWebhookAudience(k as NotificationKind)).map((k) => `${e.id}:${k}`));
    expect(personal).toEqual([]);
  });

  it("la firma è l'HMAC-SHA256 di «<t>.<body>» col segreto, nella forma t=…,v1=…", () => {
    const expected = createHmac("sha256", "s3").update("1700000000.{\"a\":1}").digest("hex");
    expect(webhookSignature("s3", "{\"a\":1}", 1_700_000_000)).toBe(`t=1700000000,v1=${expected}`);
  });

  it("ogni evento vivo del catalogo ha un evento d'esempio per l'anteprima", () => {
    const missing = OUTGOING_WEBHOOK_EVENTS.filter((e) => e.kinds.length > 0 && !sampleEventFor(e.id, "https://x.test"));
    expect(missing.map((e) => e.id)).toEqual([]);
  });
});
