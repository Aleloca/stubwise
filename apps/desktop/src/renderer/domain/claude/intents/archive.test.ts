import { describe, expect, it } from "vitest";
import i18n from "../../../i18n";
import { busyLine } from "./archive";

// F6, L-5: una generazione dei Docs in corso o in pausa rende il progetto
// `busy`; Claude lo dice nella proposta d'archiviazione.

describe("busyLine: i Docs in generazione", () => {
  const t = i18n.getFixedT("en") as unknown as Parameters<typeof busyLine>[0];

  it("in corso e in pausa, col nome del repository", () => {
    expect(
      busyLine(t, "ACQ", { kind: "doc_generation", repository: "portale", paused: false }),
    ).toBe("**ACQ** is generating the Docs of **portale**: it can be archived when that ends");
    expect(
      busyLine(t, "ACQ", { kind: "doc_generation", repository: "portale", paused: true }),
    ).toBe(
      "**ACQ** has the Docs of **portale** paused on the usage limit: it can be archived when they finish",
    );
  });
});
