import type { Person } from "../types";

const M = "dep-marketing";
const S = "dep-sales";
const C = "dep-support";
const D = "dep-development";
const A = "dep-administration";

// [id, nome, reparti, ruolo preset tipico]
const ROWS: [string, string, string[], string][] = [
  ["p-giulia", "Giulia Ferri", [M], "project_lead"],
  ["p-elena", "Elena Moretti", [M, S], "legacy_member"],
  ["p-paolo", "Paolo Gatti", [M], "legacy_member"],
  ["p-chiara", "Chiara Lombardi", [M], "contributor"],
  ["p-tommaso", "Tommaso Riva", [M], "contributor"],
  ["p-matteo", "Matteo Conti", [S], "project_lead"],
  ["p-francesca", "Francesca Greco", [S], "legacy_member"],
  ["p-luca", "Luca Bianchi", [S], "legacy_member"],
  ["p-valentina", "Valentina Serra", [S], "contributor"],
  ["p-andrea", "Andrea Fabbri", [S], "viewer"],
  ["p-sara", "Sara Montanari", [C], "contributor"],
  ["p-davide", "Davide Pellegrini", [C], "legacy_member"],
  ["p-marta", "Marta Villa", [C], "contributor"],
  ["p-nicola", "Nicola Orlando", [C], "legacy_member"],
  ["p-irene", "Irene Caruso", [C], "viewer"],
  ["p-marco", "Marco Bellini", [D], "developer"],
  ["p-federico", "Federico Sartori", [D], "developer"],
  ["p-alessia", "Alessia Neri", [D, C], "developer"],
  ["p-simone", "Simone Rossetti", [D], "developer"],
  ["p-laura", "Laura Costa", [D], "project_lead"],
  ["p-stefano", "Stefano Amato", [D], "developer"],
  ["p-roberta", "Roberta Fontana", [A], "admin"],
  ["p-giorgio", "Giorgio Barbieri", [A], "legacy_member"],
  ["p-silvia", "Silvia Longo", [A], "viewer"],
  ["p-enrico", "Enrico Palumbo", [A], "legacy_member"],
];

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export const CLAUDE_ID = "p-claude";

export const PEOPLE: Person[] = [
  ...ROWS.map(([id, name, departmentIds, presetRole]) => ({
    id,
    name,
    initials: initials(name),
    departmentIds,
    isClaude: false,
    presetRole,
  })),
  {
    id: CLAUDE_ID,
    name: "Claude",
    initials: "CL",
    departmentIds: [],
    isClaude: true,
    presetRole: "developer",
  },
];

/**
 * I reparti di ogni persona nel seme, congelati. `Person.departmentIds` di
 * `PEOPLE` segue lo stato degli accessi (lo riallinea lo store a ogni
 * scrittura: area 9a), quindi chi riparte dal seme — `access/seed.ts` — legge
 * da qui, non dalle persone.
 */
export const SEED_DEPARTMENT_IDS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(ROWS.map(([id, , departmentIds]) => [id, Object.freeze([...departmentIds])])),
);

/** Le persone del seme come oggetti: `restoreSeedPeople` rimette in `PEOPLE` proprio questi. */
const SEED_OBJECTS: readonly Person[] = [...PEOPLE];
/** Nome e iniziali del seme: l'area 9a li cambia (Account). */
const SEED_NAMES = new Map(PEOPLE.map((p) => [p.id, { name: p.name, initials: p.initials }]));

/**
 * Riporta `PEOPLE` al seme (area 9a): toglie le persone registrate o create
 * al primo avvio, rimette quelle tolte dall'istanza vuota (gli STESSI
 * oggetti, che altri moduli possono tenere) e ne ripristina nome, email,
 * foto e reparti. Lo chiama `resetStore` per primo: il seme degli accessi e
 * dei segreti legge `PEOPLE`.
 */
export function restoreSeedPeople(): void {
  PEOPLE.splice(0, PEOPLE.length, ...SEED_OBJECTS);
  for (const p of PEOPLE) {
    Object.assign(p, SEED_NAMES.get(p.id));
    delete p.email;
    delete p.photo;
    p.departmentIds = [...(SEED_DEPARTMENT_IDS[p.id] ?? [])];
  }
}
