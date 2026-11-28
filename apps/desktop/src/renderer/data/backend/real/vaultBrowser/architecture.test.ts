import { describe, expect, it } from "vitest";

// Le guardie sul sorgente della cassaforte nel browser (design §5, §14;
// revisione M-7), su `vaultBrowser/` con le sottocartelle e su `vault/web.ts`.
// Le parole nei commenti non contano: si guarda il codice.

const SOURCES = import.meta.glob(["./**/*.ts", "../vault/web.ts", "!./**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Solo il worker fa crittografia e tiene la chiave. */
const WORKER_ONLY = new Set(["./core.ts", "./worker.ts"]);

const EVERYWHERE: { re: RegExp; what: string }[] = [
  { re: /\blocalStorage\b/, what: "localStorage" },
  { re: /\bsessionStorage\b/, what: "sessionStorage" },
  { re: /\bindexedDB\b/, what: "IndexedDB" },
  { re: /\bserviceWorker\b/, what: "Service Worker" },
  { re: /\bcaches\s*\./, what: "Cache Storage" },
  { re: /\bdocument\s*\.\s*cookie\b/, what: "document.cookie" },
  { re: /\bconsole\s*\./, what: "un log" },
  { re: /\b(useQueryClient|setQueryData|QueryClient)\b/, what: "la cache delle query" },
  { re: /\b(window|parent|top|opener)\s*\??\.\s*postMessage\b/, what: "postMessage verso un'altra finestra" },
  { re: /\b(window|globalThis|self)\s*\.\s*[\w$]+\s*=(?!=)/, what: "un'assegnazione su window/globalThis/self" },
];

const PAGE_ONLY: { re: RegExp; what: string }[] = [
  { re: /\bcrypto\s*\.\s*subtle\b/, what: "crypto.subtle nella pagina" },
  {
    re: /\b(openPrivateKey|decryptPassword|unwrapItemKey|wrapItemKey|encryptPassword|encryptForInsert|sealPrivateKey|resealPrivateKey|openDeviceSeal)\b/,
    what: "la crittografia della cassaforte nella pagina",
  },
];

/** Il sorgente senza commenti (riga e blocco). */
const codeOnly = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

export function forbiddenIn(path: string, source: string): string[] {
  const code = codeOnly(source);
  const rules = WORKER_ONLY.has(path) ? EVERYWHERE : [...EVERYWHERE, ...PAGE_ONLY];
  return rules.filter(({ re }) => re.test(code)).map(({ what }) => what);
}

describe("la cassaforte nel browser: guardie sul sorgente", () => {
  it("trova i sorgenti, sottocartelle e vault/web.ts compresi", () => {
    const paths = Object.keys(SOURCES);
    expect(paths).toEqual(expect.arrayContaining(["./key.ts", "./core.ts", "./worker.ts", "../vault/web.ts"]));
  });

  it("nessuna API che persista, nessun log, niente postMessage fuori, nessuna assegnazione globale; la crittografia solo nel worker", () => {
    const found = Object.entries(SOURCES).flatMap(([path, s]) => forbiddenIn(path, s).map((w) => `${path}: ${w}`));
    expect(found).toEqual([]);
  });

  it("il controllo vede il codice e ignora i commenti", () => {
    expect(forbiddenIn("./x.ts", "localStorage.setItem('k', v);")).toEqual(["localStorage"]);
    expect(forbiddenIn("./x.ts", "window.postMessage(secret, '*');")).toEqual(["postMessage verso un'altra finestra"]);
    expect(forbiddenIn("./x.ts", "globalThis.leak = key;")).toEqual(["un'assegnazione su window/globalThis/self"]);
    expect(forbiddenIn("./x.ts", "if (window.x === 1) {}")).toEqual([]);
    expect(forbiddenIn("./x.ts", "await openPrivateKey(p, s, k);")).toEqual(["la crittografia della cassaforte nella pagina"]);
    expect(forbiddenIn("./core.ts", "await openPrivateKey(p, s, k);")).toEqual([]);
    expect(forbiddenIn("./x.ts", "// mai in localStorage\nconst a = 1;")).toEqual([]);
  });
});
