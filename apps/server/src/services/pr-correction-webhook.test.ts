import { describe, expect, it } from "vitest";
import { createDeliveryDedupe, droppedRequestNoticeBody, isDroppedRequestNotice } from "./pr-correction-webhook.js";

describe("createDeliveryDedupe", () => {
  it("un id si prende una volta sola dentro la finestra", () => {
    const dedupe = createDeliveryDedupe(5 * 60_000, () => 0);
    expect(dedupe.claim("d1")).toBe(true);
    expect(dedupe.claim("d1")).toBe(false);
    expect(dedupe.claim("d2")).toBe(true);
  });

  it("release libera l'id: il ritentativo dopo un errore passa", () => {
    const dedupe = createDeliveryDedupe(5 * 60_000, () => 0);
    expect(dedupe.claim("d1")).toBe(true);
    dedupe.release("d1");
    expect(dedupe.claim("d1")).toBe(true);
  });

  it("oltre la finestra lo stesso id torna nuovo", () => {
    let now = 0;
    const dedupe = createDeliveryDedupe(1_000, () => now);
    expect(dedupe.claim("d1")).toBe(true);
    now = 999;
    expect(dedupe.claim("d1")).toBe(false);
    now = 1_000;
    expect(dedupe.claim("d1")).toBe(true);
  });
});

describe("isDroppedRequestNotice", () => {
  const body = droppedRequestNoticeBody("en", {
    reason: "identity_unresolved",
    prNumber: 42,
    login: "mario-rossi",
    provider: "github",
    accountName: "Account GitHub",
  });

  it("prima riga uguale al titolo di QUELLA PR → true", () => {
    expect(isDroppedRequestNotice(body, 42, "en", "identity_unresolved")).toBe(true);
  });

  it("stesso avviso, numero di PR diverso → false (anche se è un prefisso: #4 vs #42)", () => {
    expect(isDroppedRequestNotice(body, 43, "en", "identity_unresolved")).toBe(false);
    expect(isDroppedRequestNotice(body, 4, "en", "identity_unresolved")).toBe(false);
  });

  it("un altro commento di sistema → false", () => {
    expect(isDroppedRequestNotice("PR merged: https://github.com/acme/repo/pull/42 — ticket closed automatically", 42, "en", "identity_unresolved")).toBe(false);
  });

  it("il titolo in coda a un testo diverso → false: conta solo la PRIMA riga", () => {
    const title = body.split("\n")[0]!;
    expect(isDroppedRequestNotice(`Nota a mano\n${title}`, 42, "en", "identity_unresolved")).toBe(false);
  });

  it("lingua diversa da quella in cui è stato scritto → false (si riavvisa una volta, per eccesso)", () => {
    expect(isDroppedRequestNotice(body, 42, "it", "identity_unresolved")).toBe(false);
  });

  it("il login sta in una riga successiva, mai nella prima", () => {
    const [first, ...rest] = body.split("\n");
    expect(first).not.toContain("mario-rossi");
    expect(rest.join("\n")).toContain("mario-rossi");
  });
});

describe("isDroppedRequestNotice — un dedup per motivo", () => {
  const identity = droppedRequestNoticeBody("en", {
    reason: "identity_unresolved",
    prNumber: 42,
    login: "mario-rossi",
    provider: "github",
    accountName: "Account GitHub",
  });
  const untrusted = droppedRequestNoticeBody("en", {
    reason: "untrusted_author",
    prNumber: 42,
    login: "sconosciuto",
    provider: "github",
  });

  it("ogni avviso si riconosce col SUO motivo, mai con l'altro", () => {
    expect(isDroppedRequestNotice(untrusted, 42, "en", "untrusted_author")).toBe(true);
    expect(isDroppedRequestNotice(untrusted, 42, "en", "identity_unresolved")).toBe(false);
    expect(isDroppedRequestNotice(identity, 42, "en", "untrusted_author")).toBe(false);
  });

  it("l'avviso per permesso non nomina credenziali né scope, e il login sta dopo la prima riga", () => {
    const [first, ...rest] = untrusted.split("\n");
    expect(first).not.toContain("sconosciuto");
    expect(rest.join("\n")).toContain("sconosciuto");
    expect(untrusted).not.toContain("read:user:bitbucket");
    expect(untrusted).toContain('"Apply corrections"');
  });
});
