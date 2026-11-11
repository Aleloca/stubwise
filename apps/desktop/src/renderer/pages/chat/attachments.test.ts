import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentRefusal } from "./attachments";

// La casella della Chat nella build app (fetta 4): il controllo prima del
// caricamento. Un file senza tipo (il sistema non lo sa dire) si giudica
// dall'estensione; l'ultima parola resta al server.

beforeEach(() => vi.stubEnv("VITE_STUBWISE_BUILD", "app"));
afterEach(() => vi.unstubAllEnvs());

describe("attachmentRefusal", () => {
  it("tipo ed estensione coerenti: entra; un eseguibile no", () => {
    expect(attachmentRefusal(new File(["x"], "spec.pdf", { type: "application/pdf" }))).toBeNull();
    expect(attachmentRefusal(new File(["x"], "setup.exe", { type: "application/x-msdownload" }))).toBe("type");
  });

  it("senza tipo: decide l'estensione", () => {
    expect(attachmentRefusal(new File(["x"], "notes.pdf", { type: "" }))).toBeNull();
    expect(attachmentRefusal(new File(["x"], "archive.zip", { type: "" }))).toBeNull();
    expect(attachmentRefusal(new File(["x"], "setup.exe", { type: "" }))).toBe("type");
    expect(attachmentRefusal(new File(["x"], "no-extension", { type: "" }))).toBe("type");
  });
});
