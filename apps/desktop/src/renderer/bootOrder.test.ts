import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Revisione M-6: `@backend/vault-boot` è il PRIMO import di `main.tsx`, così
// nella build web le primitive della cassaforte si catturano prima di
// qualunque altro codice dell'app (design §2.4).

describe("l'ordine del boot", () => {
  it("il primo import di main.tsx è @backend/vault-boot", () => {
    const source = readFileSync(resolve(import.meta.dirname, "main.tsx"), "utf8");
    const first = /^\s*import\s+["']([^"']+)["']/m.exec(source.replace(/^\s*\/\/.*$/gm, ""));
    expect(first?.[1]).toBe("@backend/vault-boot");
  });

  // m-2 (seconda revisione della fase 2): anche la pagina a sé della cassaforte.
  it("il primo import di vaultPage/main.tsx è il boot della cassaforte (vaultBrowser/boot)", () => {
    const source = readFileSync(resolve(import.meta.dirname, "vaultPage/main.tsx"), "utf8");
    const first = /^\s*import\s+["']([^"']+)["']/m.exec(source.replace(/^\s*\/\/.*$/gm, ""));
    expect(first?.[1]).toBe("../data/backend/real/vaultBrowser/boot");
  });

  it("il primo import del boot della cassaforte è csp-init (Zod senza eval)", () => {
    const source = readFileSync(resolve(import.meta.dirname, "data/backend/real/vaultBrowser/boot.ts"), "utf8");
    const first = /^\s*import\s+["']([^"']+)["']/m.exec(source.replace(/^\s*\/\/.*$/gm, ""));
    expect(first?.[1]).toBe("../../../../csp-init");
  });
});
