import { describe, expect, it } from "vitest";

// La chiave e le password della cassaforte nel browser stanno SOLO in memoria
// (design §5): in `vaultBrowser/` nessuna API che persista o che scriva in un
// log. Il controllo è sul sorgente, codice e commenti esclusi da una
// pulitura grossolana (le parole nei commenti non contano).

const SOURCES = import.meta.glob(["./*.ts", "!./*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FORBIDDEN: { re: RegExp; what: string }[] = [
  { re: /\blocalStorage\b/, what: "localStorage" },
  { re: /\bsessionStorage\b/, what: "sessionStorage" },
  { re: /\bindexedDB\b/, what: "IndexedDB" },
  { re: /\bserviceWorker\b/, what: "Service Worker" },
  { re: /\bcaches\s*\./, what: "Cache Storage" },
  { re: /\bdocument\s*\.\s*cookie\b/, what: "document.cookie" },
  { re: /\bconsole\s*\./, what: "un log" },
  { re: /\b(useQueryClient|setQueryData|QueryClient)\b/, what: "la cache delle query" },
];

/** Il sorgente senza commenti (riga e blocco): le parole nei commenti non contano. */
const codeOnly = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

export function forbiddenIn(source: string): string[] {
  const code = codeOnly(source);
  return FORBIDDEN.filter(({ re }) => re.test(code)).map(({ what }) => what);
}

describe("vaultBrowser/: solo in memoria", () => {
  it("trova i sorgenti", () => {
    expect(Object.keys(SOURCES)).toContain("./key.ts");
  });

  it("nessuna API che persista, nessun log", () => {
    const found = Object.entries(SOURCES).flatMap(([path, s]) => forbiddenIn(s).map((w) => `${path}: ${w}`));
    expect(found).toEqual([]);
  });

  it("il controllo vede il codice e ignora i commenti", () => {
    expect(forbiddenIn("localStorage.setItem('k', v);")).toEqual(["localStorage"]);
    expect(forbiddenIn("console.log(password);")).toEqual(["un log"]);
    expect(forbiddenIn("// mai in localStorage\nconst a = 1;")).toEqual([]);
    expect(forbiddenIn("/* sessionStorage */ const a = 1;")).toEqual([]);
  });
});
