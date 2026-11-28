import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// La pagina A SÉ della cassaforte (revisione della fase 2, I-2): nel suo
// documento non entra codice dell'app (chat, posta, riquadro di Claude, il
// livello dati, il router, l'intelaiatura). Gli import ammessi sono un elenco
// chiuso; il bundle lo controlla poi `check-vault-target.mjs … vault`.

const DIR = join(process.cwd(), "src/renderer/vaultPage");
const ALLOWED = [
  /^react$/,
  /^react-dom\/client$/,
  /^react-i18next$/,
  /^i18next$/,
  /^@stubwise\/shared$/,
  /^\.\/[\w.]+$/,
  /^\.\.\/data\/backend\/real\/vaultBrowser\/(boot|client|setup|unlock|webauthn)$/,
  /^\.\.\/csp-init$/,
  /^\.\.\/i18n\/locales\/(en|it)\.json$/,
  /^\.\.\/i18n\/storageKey$/,
  /^\.\.\/styles\/index\.css$/,
];

const sources = readdirSync(DIR).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));

describe("la pagina a sé importa solo ciò che le serve", () => {
  it.each(sources)("%s", (file) => {
    const code = readFileSync(join(DIR, file), "utf8");
    const specifiers = [...code.matchAll(/^\s*import\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm)].map((m) => m[1]!);
    expect(specifiers.filter((s) => !ALLOWED.some((re) => re.test(s)))).toEqual([]);
  });

  it("le pagine ci sono tutte (il test non passa su una cartella vuota)", () => {
    expect(sources).toEqual(expect.arrayContaining(["App.tsx", "api.ts", "main.tsx", "SetupPage.tsx", "RecoverPage.tsx", "PairPage.tsx", "PasskeysPage.tsx"]));
  });
});
