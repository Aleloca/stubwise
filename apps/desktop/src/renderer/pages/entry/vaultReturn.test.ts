import { describe, expect, it } from "vitest";
import { vaultReturn } from "./vaultReturn";

// Il ritorno dal login alla pagina a sé della cassaforte (revisione della
// fase 2, I-2): `next` in un elenco CHIUSO, mai un URL libero.

describe("vaultReturn", () => {
  it("le quattro pagine della cassaforte, e l'associazione solo con uno state valido", () => {
    expect(vaultReturn("vault-setup")).toBe("/app/vault/#/setup");
    expect(vaultReturn("vault-recover")).toBe("/app/vault/#/recover");
    expect(vaultReturn("vault-passkeys")).toBe("/app/vault/#/passkeys");
    expect(vaultReturn("vault-pair", "c3Rh-dGU_")).toBe("/app/vault/#/pair?state=c3Rh-dGU_");
    expect(vaultReturn("vault-pair")).toBeNull();
    expect(vaultReturn("vault-pair", "a/b?c")).toBeNull();
  });

  it("un URL, un percorso, o un valore fuori elenco: niente (si va alla Home)", () => {
    for (const next of [
      "https://evil.example/",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "/app/vault/#/setup",
      "vault-setup/../x",
      "toString",
      "__proto__",
      "",
      undefined,
    ])
      expect(vaultReturn(next), String(next)).toBeNull();
  });
});
