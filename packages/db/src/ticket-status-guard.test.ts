import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Blocco T. In R0 questo file vietava anche l'SQL GREZZO sulla colonna enum
// `tickets.status` (il compilatore non vede i template). Dalla 0245 (R3) la
// colonna non esiste più, e la guardia vera è il database: un lettore o uno
// scrittore nuovo fallisce con 42703 (`migration-0245.test.ts`, «la guardia
// del blocco T»). Resta il controllo che il database NON fa: una chiave
// `status` in una scrittura drizzle dei ticket, che drizzle scarta in silenzio.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Le scritture drizzle sui ticket che portano ancora una chiave `status`: il
 * compilatore NON le vede quando l'oggetto arriva da uno spread o da una
 * callback (`Array.from(…, () => ({ status }))`), e drizzle la scarta in
 * silenzio: il ticket nasce nello stato di default. È successo due volte (un
 * test del polso arrivato da main, un test dei consumi in R0). Si guarda la
 * parte `.values(…)`/`.set(…)` di ogni `insert(tickets)`/`update(tickets)`,
 * fino al `;`, senza il `.returning(…)` (lì `status: ticketStatusSql` è la
 * lettura giusta).
 */
export function staleStatusWrites(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\.(insert|update)\(\s*tickets\s*\)/g)) {
    let depth = 0;
    let j = m.index + m[0].length;
    for (; j < source.length; j++) {
      const c = source[j]!;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === ";" && depth <= 0) break;
    }
    const statement = source.slice(m.index, j).split(/\.returning\(/)[0]!;
    if (/(?<![\w.$"'])status\s*[:,}]|\{\s*status\b/.test(statement.replace(/\bstatus(Id|_id)\b/g, ""))) {
      out.push(statement.slice(0, 120).replace(/\s+/g, " "));
    }
  }
  return out;
}

function allSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return ["node_modules", "dist"].includes(e.name) ? [] : allSources(p);
    return /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

describe("guardia: nessuna scrittura drizzle dei ticket con una chiave `status`", () => {
  it("il rilevatore: la chiave in ogni forma, mai `statusId` né il `returning`", () => {
    expect(staleStatusWrites("db.insert(tickets).values({ projectId, status: \"open\" });")).toHaveLength(1);
    expect(staleStatusWrites("db.insert(tickets).values(Array.from({ length: 2 }, () => ({ projectId, status })));")).toHaveLength(1);
    expect(staleStatusWrites("db.update(tickets).set({ status, updatedAt }).where(x);")).toHaveLength(1);
    expect(staleStatusWrites("db.update(tickets).set({ statusId: s }).where(x).returning({ status: ticketStatusSql });")).toEqual([]);
    expect(staleStatusWrites("db.insert(tickets).values({ ...roleInsert(p, \"open\") });")).toEqual([]);
    expect(staleStatusWrites("db.update(aiJobs).set({ status: \"queued\" });")).toEqual([]);
  });

  it("in tutto il codice di app e package, test compresi", () => {
    const found = ["apps", "packages"].flatMap((top) =>
      readdirSync(join(ROOT, top)).flatMap((pkg) => {
        const dir = join(ROOT, top, pkg, "src");
        try {
          return allSources(dir)
            // I casi del rilevatore qui sopra sono esempi, non scritture.
            .filter((f) => f !== fileURLToPath(import.meta.url))
            .flatMap((f) => staleStatusWrites(readFileSync(f, "utf8")).map((w) => `${relative(ROOT, f)}: ${w}`));
        } catch {
          return [];
        }
      }),
    );
    expect(found).toEqual([]);
  });
});
