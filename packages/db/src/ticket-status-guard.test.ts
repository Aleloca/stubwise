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
const SCANNED = ["apps/server/src", "apps/worker/src", "packages/notifications/src", "packages/db/src", "packages/mcp/src"];

/**
 * Gli usi DICHIARATI, per file e frammento: il riallineamento dell'enum quando
 * uno stato cambia famiglia (tiene la colonna coerente per un rollback del
 * server; va via con R3, insieme alla colonna).
 */
const ALLOWED: { file: string; snippet: string }[] = [
  { file: "apps/server/src/routes/project-statuses.ts", snippet: `set "status" = s."legacy_status"` },
];

/** Toglie i commenti `//` e `/* … *\/` lasciando intatti i template. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** Gli usi della colonna enum di `tickets` dentro un template SQL. */
export function enumUses(template: string): string[] {
  if (!/\btickets\b/.test(template)) return [];
  // `x.status` conta solo se `x` è `tickets` o un suo alias (`tickets t`, `"tickets" as tk`).
  const aliases = new Set(["tickets", ...[...template.matchAll(/"?tickets"?\s+(?:as\s+)?"?(\w+)"?/gi)].map((m) => m[1]!.toLowerCase())]);
  const uses = template.match(/(?:"?\w+"?\.)?"status"(?!_)|\b\w+\."?status\b"?(?!_|Id)|(?<![\w."])status\s*(?:=|<>|!=|\bin\b|\bnot in\b|\bis\b)/gi) ?? [];
  return uses
    .filter((u) => {
      const q = /^"?(\w+)"?\./.exec(u);
      return q === null || aliases.has(q[1]!.toLowerCase());
    })
    .filter((u, i, all) => all.indexOf(u) === i);
}

function templates(source: string): string[] {
  return [...stripComments(source).matchAll(/`((?:[^`\\]|\\.)*)`/gs)].map((m) => m[1]!).map((t) => t.replace(/\bas "status"/g, ""));
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return ["node_modules", "dist", "fixtures"].includes(e.name) ? [] : files(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$|\.d\.ts$/.test(e.name) ? [p] : [];
  });
}

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
