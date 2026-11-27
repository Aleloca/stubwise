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
});
