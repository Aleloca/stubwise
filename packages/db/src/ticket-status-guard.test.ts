import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Blocco T, R0: nessuno legge o scrive la colonna enum `tickets.status`. Il
// compilatore copre drizzle (la colonna non è più nello schema); questo test
// copre l'SQL GREZZO, che il compilatore non vede: ogni template che nomina
// `tickets` e usa una colonna `status` (non `status_id`) è un lettore o uno
// scrittore dell'enum. Lo status si legge con `ticketStatusSql` /
// `stubwise_ticket_status(...)`, il ruolo si scrive con `roleUpdate`.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCANNED = [
  "apps/server/src",
  "apps/server/scripts",
  "apps/worker/src",
  "apps/worker/scripts",
  "packages/notifications/src",
  "packages/db/src",
  "packages/mcp/src",
];

/**
 * Gli usi DICHIARATI, per file e frammento: il riallineamento dell'enum quando
 * uno stato cambia famiglia (tiene la colonna coerente per un rollback del
 * server; va via con R3, insieme alla colonna), e i testi che non sono SQL.
 */
const ALLOWED: { file: string; snippet: string }[] = [
  { file: "apps/server/src/routes/project-statuses.ts", snippet: `set "status" = s."legacy_status"` },
  // Non è SQL: il testo del prompt di triage, che nomina i ticket e il loro status.
  { file: "apps/worker/src/pipeline/prompts.ts", snippet: "[status] title" },
];

/** Toglie i commenti `//` e `/* … *\/` lasciando intatti i template. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/**
 * Gli usi della colonna enum di `tickets` dentro un template SQL. In un
 * template che nomina `tickets`, conta ogni `status` NUDO (non `status_id`,
 * non `ticket_status`), quotato o no, salvo che lo qualifichi un alias che NON
 * è di `tickets` (`j.status` su `ai_jobs j`). Le interpolazioni `${…}` non
 * sono SQL: si tolgono, tenendo solo il nome di una tabella usata come
 * qualificatore (`${tickets}.status`).
 */
export function enumUses(template: string): string[] {
  const sqlText = template.replace(/\$\{\s*(\w+)\s*\}(?=\s*\.)/g, "$1").replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "$$X");
  if (!/\btickets\b/.test(sqlText)) return [];
  // `x.status` conta solo se `x` è `tickets` o un suo alias (`tickets t`, `"tickets" as tk`).
  const aliases = new Set(["tickets", ...[...sqlText.matchAll(/"?tickets"?\s+(?:as\s+)?"?(\w+)"?/gi)].map((m) => m[1]!.toLowerCase())]);
  const uses = [...sqlText.matchAll(/(?:"?(\w+)"?\s*\.\s*)?(?<![\w$])"?status"?(?![\w])/gi)];
  return uses
    .filter((m) => m[1] === undefined || aliases.has(m[1].toLowerCase()))
    .map((m) => m[0])
    .filter((u, i, all) => all.indexOf(u) === i);
}

/** I template SQL di un sorgente: i template letterali e le stringhe di `sql.raw(…)`. */
function templates(source: string): string[] {
  const code = stripComments(source);
  const literals = [...code.matchAll(/`((?:[^`\\]|\\.)*)`/gs)].map((m) => m[1]!);
  const raws = [...code.matchAll(/sql\.raw\(\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1/g)].map((m) => m[2]!);
  return [...literals, ...raws].map((t) => t.replace(/\bas "status"/g, ""));
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return ["node_modules", "dist", "fixtures"].includes(e.name) ? [] : files(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$|\.d\.ts$/.test(e.name) ? [p] : [];
  });
}

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

describe("guardia: nessun SQL grezzo sulla colonna enum dei ticket", () => {
  it("il rilevatore: trova lettori e scrittori, ignora status_id, l'alias del derivato e le altre tabelle", () => {
    expect(enumUses(`update tickets set status = 'done' where id = $1`)).not.toEqual([]);
    expect(enumUses(`select t."status" from "tickets" t`)).not.toEqual([]);
    expect(enumUses(`select id from tickets t where t.status in ('open')`)).not.toEqual([]);
    expect(enumUses(`update "tickets" set "status_id" = $1 where "status_id" = $2`)).toEqual([]);
    expect(enumUses(`select stubwise_ticket_status("status_id", "triaged_at") from tickets`)).toEqual([]);
    expect(enumUses(`select j.id from ai_jobs j where j.status = 'queued'`)).toEqual([]);
    expect(enumUses(`select j.id from ai_jobs j join tickets t on t.id = j.ticket_id where j.status = 'queued'`)).toEqual([]);
    expect(enumUses(`select j.id from ai_jobs j join tickets t on t.id = j.ticket_id where t.status = 'done'`)).not.toEqual([]);
    // I casi della revisione: `status` nudo in ogni posizione.
    expect(enumUses(`select id, status from tickets`)).not.toEqual([]);
    expect(enumUses(`update tickets set title = $1 returning id, status`)).not.toEqual([]);
    expect(enumUses(`insert into tickets (id, status) values ($1, $2)`)).not.toEqual([]);
    expect(enumUses(`select status::text from tickets`)).not.toEqual([]);
    expect(enumUses(`select count(*) from tickets group by status`)).not.toEqual([]);
    expect(enumUses(`select \${tickets}.status from \${tickets}`)).not.toEqual([]);
    expect(templates(`sql.raw("select id from tickets where status = 'done'")`).flatMap(enumUses)).not.toEqual([]);
    // E quelli che non sono la colonna: un'interpolazione, `ticket_status`, un'altra tabella.
    expect(enumUses(`update tickets set status_id = \${status} where id = $1`)).toEqual([]);
    expect(enumUses(`select $1::"ticket_status" from tickets`)).toEqual([]);
    expect(enumUses(`select \${aiJobs}.status from \${aiJobs} join tickets on tickets.id = \${aiJobs}.ticket_id`)).toEqual([]);
  });

  it("nel sorgente di server, worker, notifiche, db e mcp, solo gli usi dichiarati", () => {
    const found: string[] = [];
    for (const root of SCANNED) {
      for (const file of files(join(ROOT, root))) {
        const rel = relative(ROOT, file);
        for (const t of templates(readFileSync(file, "utf8"))) {
          const uses = enumUses(t);
          if (uses.length === 0) continue;
          if (ALLOWED.some((a) => a.file === rel && t.includes(a.snippet))) continue;
          found.push(`${rel}: ${uses.join(" | ")}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
