import { INSTANCE_PERMISSIONS, PROJECT_PERMISSIONS } from "@stubwise/shared";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEPARTMENTS } from "../seed/departments";
import { PEOPLE } from "../seed/people";
import { PROJECTS } from "../seed/projects";
import { can, canInDepartment, viewerFor, type Permission } from "../viewer";

/**
 * Il generatore del fixture di parità (area 9a, Task 1). È stato lanciato UNA
 * volta, sulla `can()` di prima che gli accessi diventassero stato del livello
 * dati (commit del fixture, prima del cambio di `viewer.ts`): il fixture è la
 * fotografia di cosa ognuno poteva fare nelle aree 2–8, e `parity.test.ts` lo
 * confronta con la `can()` nuova.
 *
 * Non si rilancia per «sistemare» una differenza: rilanciato adesso
 * fotograferebbe la `can()` nuova, e il confronto non proverebbe più niente.
 * Per rigenerarlo apposta: `PARITY_WRITE=1 pnpm --filter @stubwise/desktop
 * test -- parity.generate`.
 */

/** Tutti i permessi che `can()` conosce, più i tre d'istanza nuovi dell'area 9a. */
const PARITY_PERMISSIONS: readonly string[] = [
  ...INSTANCE_PERMISSIONS,
  "claude.public.view",
  "people.activity.view",
  "chat.general.create",
  "chat.general.manage",
  "automations.manage",
  "servers.ssh.manage",
  "departments.manage",
  "instance.status.view",
  "changelog.view",
  ...PROJECT_PERMISSIONS,
  "planning.others",
  "chat.channels.create",
  "chat.channels.manage",
  "drive.upload",
  "drive.manage",
  "drive.history",
  "support.reply",
  "servers.operate",
  "department.home.manage",
];

/** Una riga per (persona, permesso): un bit per «nessun progetto» e poi uno per progetto, in esadecimale. */
function bitsToHex(bits: boolean[]): string {
  let out = "";
  for (let i = 0; i < bits.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) n = n * 2 + (bits[i + k] ? 1 : 0);
    out += n.toString(16);
  }
  return out;
}

function snapshot() {
  const projects = PROJECTS.map((p) => p.id);
  const canRows: Record<string, Record<string, string>> = {};
  const deptRows: Record<string, string> = {};
  for (const person of PEOPLE) {
    const viewer = viewerFor(person.id);
    const rows: Record<string, string> = {};
    for (const perm of PARITY_PERMISSIONS) {
      const bits = [
        can(viewer, perm as Permission),
        ...projects.map((id) => can(viewer, perm as Permission, id)),
      ];
      rows[perm] = bitsToHex(bits);
    }
    canRows[person.id] = rows;
    deptRows[person.id] = DEPARTMENTS.map((d) =>
      canInDepartment(viewer, "department.home.manage", d.id) ? "1" : "0",
    ).join("");
  }
  return { projects, canRows, deptRows };
}

function render(): string {
  const { projects, canRows, deptRows } = snapshot();
  const q = (s: string) => JSON.stringify(s);
  const lines: string[] = [
    "// GENERATO da `parity.generate.test.ts` sulla `can()` di prima dell'area 9a:",
    "// non si modifica a mano. Vedi il docblock del generatore.",
    "",
    "/** I progetti, nell'ordine dei bit: il primo bit di ogni riga è «nessun progetto». */",
    "export const PARITY_PROJECT_IDS: readonly string[] = [",
    ...projects.map((id) => `  ${q(id)},`),
    "];",
    "",
    "/** I permessi fotografati: tutti quelli che `can()` conosceva, più i tre d'istanza nuovi dell'area 9a. */",
    "export const PARITY_PERMISSIONS: readonly string[] = [",
    ...PARITY_PERMISSIONS.map((p) => `  ${q(p)},`),
    "];",
    "",
    "/** I reparti, nell'ordine di `PARITY_DEPARTMENT_HOME`. */",
    "export const PARITY_DEPARTMENT_IDS: readonly string[] = [",
    ...DEPARTMENTS.map((d) => `  ${q(d.id)},`),
    "];",
    "",
    "/** persona → permesso → bit (esadecimale) di `can(viewer, perm, projectId?)`. */",
    "export const PARITY_CAN: Readonly<Record<string, Readonly<Record<string, string>>>> = {",
  ];
  for (const [personId, rows] of Object.entries(canRows)) {
    lines.push(`  ${q(personId)}: {`);
    for (const [perm, hex] of Object.entries(rows)) lines.push(`    ${q(perm)}: ${q(hex)},`);
    lines.push("  },");
  }
  lines.push("};", "");
  lines.push(
    '/** persona → un carattere per reparto: `canInDepartment(viewer, "department.home.manage", d)`. */',
    "export const PARITY_DEPARTMENT_HOME: Readonly<Record<string, string>> = {",
  );
  for (const [personId, bits] of Object.entries(deptRows))
    lines.push(`  ${q(personId)}: ${q(bits)},`);
  lines.push("};", "");
  return lines.join("\n");
}

describe("generatore del fixture di parità", () => {
  it("è deterministico", () => {
    expect(render()).toBe(render());
  });

  it.runIf(process.env.PARITY_WRITE === "1")("scrive parity.fixture.ts", () => {
    const target = resolve(process.cwd(), "src/renderer/data/access/parity.fixture.ts");
    writeFileSync(target, render());
  });
});
