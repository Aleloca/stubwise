import { describe, expect, it } from "vitest";

// I segreti mostrati una volta (area 9a) e quelli scritti da chi amministra
// (area 9b) stanno solo in `admin/secrets.ts`. Lo importano solo le
// scritture d'amministrazione, delle preferenze, dell'ingresso e
// dell'istanza (`data/admin/*`, `data/me/*`, `data/auth/*`,
// `data/instance/*`); nessuna
// lettura (`data/queries/*`, il registro delle modifiche) e nessuna pagina
// lo raggiunge, nemmeno di riflesso attraverso un altro modulo. Stessa forma
// del test delle chiavi private dei server (`architecture.test.ts`).
// Limite: il risolutore segue solo gli import relativi.

const SOURCES = import.meta.glob(["../**/*.{ts,tsx}", "!**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Tutti i percorsi relativi a `src/renderer` (Vite scrive quelli di `data/` come `./…`). */
const norm = (path: string): string =>
  path.startsWith("./") ? `data/${path.slice(2)}` : path.replace(/^\.\.\//, "");
const FILES = new Map(Object.entries(SOURCES).map(([p, s]) => [norm(p), s]));

const SECRETS = "data/admin/secrets.ts";
const IMPORT_RE = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

/** I moduli che `path` importa direttamente. */
function importsOf(path: string): string[] {
  const dir = path.split("/").slice(0, -1);
  return [...FILES.get(path)!.matchAll(IMPORT_RE)].flatMap(([, spec]) => {
    const parts = [...dir];
    for (const seg of spec!.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    const base = parts.join("/");
    const hit = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => FILES.has(p));
    return hit ? [hit] : [];
  });
}

/** Tutto ciò che `start` raggiunge per import, se stesso compreso. */
function reachable(start: string): Set<string> {
  const seen = new Set<string>();
  const todo = [start];
  while (todo.length) {
    const p = todo.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    todo.push(...importsOf(p));
  }
  return seen;
}

const ALLOWED = ["data/admin/", "data/me/", "data/auth/", "data/instance/"];

describe("segreti mostrati una volta", () => {
  it("trova i sorgenti", () => {
    expect(FILES.size).toBeGreaterThan(100);
    expect(FILES.has(SECRETS)).toBe(true);
  });

  it("secrets.ts lo importano solo data/admin, data/me, data/auth e data/instance", () => {
    const importers = [...FILES.keys()].filter((p) => importsOf(p).includes(SECRETS));
    // Il risolutore funziona: la riconferma lo importa.
    expect(importers).toContain("data/auth/reauth.ts");
    expect(importers.filter((p) => !ALLOWED.some((dir) => p.startsWith(dir)))).toEqual([]);
  });

  it("né le query né le pagine lo importano", () => {
    const surfaces = [...FILES.keys()].filter(
      (p) => p === "data/queries.ts" || p.startsWith("data/queries/") || p.startsWith("pages/"),
    );
    expect(surfaces.length).toBeGreaterThan(20);
    expect(surfaces.filter((p) => importsOf(p).includes(SECRETS))).toEqual([]);
  });

  it("le letture del registro delle modifiche non lo raggiungono", () => {
    // Query e pagine passano da `api.ts`, che espone anche le scritture (e
    // quindi raggiunge i segreti): il confine vero sono le letture. Il
    // risolutore funziona: da `auth/index.ts` ci si arriva.
    expect(reachable("data/auth/index.ts").has(SECRETS)).toBe(true);
    const reads = [...FILES.keys()].filter((p) => p.startsWith("data/changelog/"));
    expect(reads.length).toBeGreaterThan(3);
    expect(reads.filter((p) => reachable(p).has(SECRETS))).toEqual([]);
  });

  it("l'aiuto dei test non lo usa il codice dell'app", () => {
    const users = [...FILES.entries()]
      .filter(([p, s]) => /__secretValuesForTest/.test(s) && p !== SECRETS)
      .map(([p]) => p);
    expect(users).toEqual([]);
  });
});
