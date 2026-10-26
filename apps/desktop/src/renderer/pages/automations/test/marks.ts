import type { RunLogEntry, SimulationView, Step } from "../../../data/types";

// I segni di percorso della prova (shape automation-test §5): dove si è,
// cosa è fatto, quali rami sono stati presi e quali no. Tutto dal registro
// della prova e dal cursore, coi percorsi CONCRETI (R-J5, giro compreso):
// `2/forEach[1]/0` è il passo 0 del giro 1. Funzioni pure.

export type Mark =
  /** Non ancora raggiunto. */
  | "pending"
  /** Il passo al cursore, pronto per «Next step». */
  | "current"
  /** Un blocco (ramo, ciclo) con il cursore dentro. */
  | "inside"
  | "done"
  /** Fermo: attesa, approvazione, scelta del progetto. */
  | "stopped"
  | "failed"
  | "skipped"
  /** Rifiutato nella prova. */
  | "rejected"
  /** In un ramo non preso. */
  | "notTaken";

const TERMINAL = new Set(["done", "failed", "cancelled"]);

export interface SimIndex {
  view: SimulationView;
  byPath: Map<string, RunLogEntry[]>;
}

export function indexLog(view: SimulationView): SimIndex {
  const byPath = new Map<string, RunLogEntry[]>();
  for (const e of view.log) {
    const list = byPath.get(e.path);
    if (list) list.push(e);
    else byPath.set(e.path, [e]);
  }
  return { view, byPath };
}

const isOpen = (ix: SimIndex) => !TERMINAL.has(ix.view.status);

/** Il segno della riga al percorso concreto `path`. */
export function markAt(ix: SimIndex, path: string): Mark {
  const { status, cursor } = ix.view;
  const entries = ix.byPath.get(path) ?? [];
  const last = entries.at(-1);
  if (cursor === path) {
    if (status === "failed") return "failed";
    if (status === "cancelled" && last?.outcome === "rejected") return "rejected";
    if (status.startsWith("waiting_")) return "stopped";
    if (status === "running" && ix.view.current?.path === path) return "current";
  }
  if (last) {
    switch (last.outcome) {
      case "failed":
        return "failed";
      case "rejected":
        return "rejected";
      case "skipped":
        return "skipped";
      case "limit":
        // Ripeti finché al limite prosegue (corsia «When the limit is reached»);
        // un «Per ogni» oltre i 50 giri fa fallire.
        return status === "failed" && cursor === path ? "failed" : "done";
      case "waiting":
        break;
      default:
        return "done";
    }
  }
  if (cursor !== null && isOpen(ix) && cursor.startsWith(`${path}/`)) return "inside";
  return "pending";
}

/** L'ultima riga del registro a quel percorso. */
export const lastEntry = (ix: SimIndex, path: string) => ix.byPath.get(path)?.at(-1);

/**
 * Una corsia è stata presa? `true` sì, `false` no (ramo non preso), `null`
 * non si sa ancora (il blocco non è stato raggiunto o è in corso).
 */
export function laneTaken(
  ix: SimIndex,
  block: Step,
  blockPath: string,
  seg: string,
): boolean | null {
  const entries = ix.byPath.get(blockPath) ?? [];
  const done = entries.filter((e) => e.outcome !== "waiting");
  const last = done.at(-1);
  switch (block.kind) {
    case "condition":
      return last ? last.output.ramo === seg : null;
    case "claude":
      if (!last || last.outcome !== "ok") return null;
      return last.output.uscita === seg;
    case "forEach": {
      if (roundsSeen(ix, blockPath, "forEach").length > 0) return true;
      return last ? false : null;
    }
    case "repeatUntil":
      if (seg === "onLimit") {
        if (done.some((e) => e.outcome === "limit")) return true;
        return last ? false : null;
      }
      if (roundsSeen(ix, blockPath, "repeat").length > 0) return true;
      return last ? false : null;
    default:
      return null;
  }
}

/** I giri visti di un ciclo (dal registro e dal cursore), in ordine. */
export function roundsSeen(ix: SimIndex, blockPath: string, seg: "forEach" | "repeat"): number[] {
  const re = new RegExp(`^${escape(blockPath)}/${seg}\\[(\\d+)\\](?:/|$)`);
  const out = new Set<number>();
  for (const p of ix.byPath.keys()) {
    const m = re.exec(p);
    if (m) out.add(Number(m[1]));
  }
  const c = ix.view.cursor ? re.exec(ix.view.cursor) : null;
  if (c) out.add(Number(c[1]));
  return [...out].sort((a, b) => a - b);
}

/** Il giro in corso del ciclo, se il cursore ci sta dentro e la prova non è finita. */
export function currentRound(
  ix: SimIndex,
  blockPath: string,
  seg: "forEach" | "repeat",
): number | null {
  const c = ix.view.cursor;
  if (!c || !isOpen(ix)) return null;
  const m = new RegExp(`^${escape(blockPath)}/${seg}\\[(\\d+)\\]/`).exec(c);
  return m ? Number(m[1]) : null;
}

/** Il giro da mostrare se chi prova non ne ha scelto uno: quello in corso, o l'ultimo visto. */
export function defaultRound(ix: SimIndex, blockPath: string, seg: "forEach" | "repeat"): number {
  return currentRound(ix, blockPath, seg) ?? roundsSeen(ix, blockPath, seg).at(-1) ?? 0;
}

/** Quanti giri ha un ciclo: gli elementi di un «Per ogni», i giri fatti di un «Ripeti finché». */
export function roundTotal(ix: SimIndex, block: Step, blockPath: string): number {
  if (block.kind === "forEach") {
    const items = ix.view.loopItems?.[blockPath];
    if (items) return items.length;
  }
  const seen = roundsSeen(ix, blockPath, block.kind === "forEach" ? "forEach" : "repeat");
  return seen.length;
}

/** Il segmento concreto della corsia di un ciclo al giro `round` (`forEach[3]`). */
export const roundSeg = (seg: string, round: number) =>
  seg === "forEach[0]" ? `forEach[${round}]` : seg === "repeat[0]" ? `repeat[${round}]` : seg;

/** Le righe sotto un percorso (lui compreso), in ordine di tempo. */
export function entriesUnder(ix: SimIndex, path: string): RunLogEntry[] {
  return ix.view.log.filter((e) => e.path === path || e.path.startsWith(`${path}/`));
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
