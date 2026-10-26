import { stepAt } from "../../domain/automations/fields";
import type { AutomationFlow, RunLogEntry, Step } from "../../data/types";

// Il registro di un'esecuzione come albero (shape automations.md §6, «Log»):
// le righe sono in ordine di tempo, i percorsi (R-J5) dicono dove sta ogni
// passo — `2/forEach[1]/0/else/0` è il passo 0 del ramo «else» del passo 0
// del giro 1 del passo 2. Qui si ricostruisce la forma (giri, rami) per
// leggerlo come una storia; il percorso non si mostra mai, serve all'ancora.

export interface LogNode {
  /** Il percorso del passo (R-J5). */
  path: string;
  step: Step | null;
  /** Le righe di questo passo, in ordine di tempo. */
  entries: RunLogEntry[];
  /** I contenitori figli (giri, rami, uscite), nell'ordine in cui si sono aperti. */
  children: LogContainer[];
}

export interface LogContainer {
  /** Il segmento che lo apre: `then`, `else`, un'uscita, `forEach[i]`, `repeat[i]`, `onLimit`. */
  seg: string;
  path: string;
  nodes: LogNode[];
}

export interface LogTree {
  trigger: RunLogEntry[];
  nodes: LogNode[];
}

/** I giri si scrivono `forEach[0]` nel flusso: il passo è lo stesso per ogni giro. */
const flowPath = (path: string) => path.replace(/\[\d+\]/g, "[0]");

export function buildLogTree(log: RunLogEntry[], flow: AutomationFlow): LogTree {
  const tree: LogTree = { trigger: [], nodes: [] };
  const index = new Map<string, LogNode>();
  const containers = new Map<string, LogContainer>();
  const nodeAt = (list: LogNode[], path: string): LogNode => {
    let node = index.get(path);
    if (!node) {
      node = { path, step: stepAt(flow.steps, flowPath(path)), entries: [], children: [] };
      index.set(path, node);
      list.push(node);
    }
    return node;
  };
  for (const entry of log) {
    if (entry.path === "trigger" || entry.kind === "trigger") {
      tree.trigger.push(entry);
      continue;
    }
    const segs = entry.path.split("/");
    let list = tree.nodes;
    let path = "";
    let node: LogNode | null = null;
    for (let k = 0; k < segs.length; k += 2) {
      path = path === "" ? segs[k]! : `${path}/${segs[k]}`;
      node = nodeAt(list, path);
      const seg = segs[k + 1];
      if (seg === undefined) break;
      const cpath = `${path}/${seg}`;
      let c = containers.get(cpath);
      if (!c) {
        c = { seg, path: cpath, nodes: [] };
        containers.set(cpath, c);
        node.children.push(c);
      }
      list = c.nodes;
      path = cpath;
    }
    node!.entries.push(entry);
  }
  return tree;
}

/** Le righe con un esito da guardare: fallite, saltate, al limite, rifiutate. */
export const PROBLEM_OUTCOMES: ReadonlySet<RunLogEntry["outcome"]> = new Set([
  "failed",
  "skipped",
  "limit",
  "rejected",
]);

export const isProblem = (e: RunLogEntry) => PROBLEM_OUTCOMES.has(e.outcome);
export const created = (e: RunLogEntry) => e.outcome === "ok" && e.effects.length > 0;

/** Tutte le righe sotto un nodo (lui compreso). */
export function entriesUnder(node: LogNode): RunLogEntry[] {
  return [...node.entries, ...node.children.flatMap((c) => c.nodes.flatMap(entriesUnder))];
}

export const containerEntries = (c: LogContainer) => c.nodes.flatMap(entriesUnder);

/** Il numero del giro di un contenitore (`forEach[3]` → 3), o null. */
export function roundOf(seg: string): number | null {
  const m = /^(?:forEach|repeat)\[(\d+)\]$/.exec(seg);
  return m ? Number(m[1]) : null;
}

/** Quante righe ha il registro in tutto (per il conteggio della sezione). */
export const countEntries = (tree: LogTree) =>
  tree.trigger.length + tree.nodes.reduce((n, x) => n + entriesUnder(x).length, 0);

/**
 * Le chiavi dei gruppi (giri, cicli) che contengono il percorso: per aprirli
 * quando si arriva a una riga con `?entry=` o la si cerca.
 */
export function groupsContaining(path: string): string[] {
  const segs = path.split("/");
  const out: string[] = [];
  let acc = "";
  for (let k = 0; k < segs.length; k++) {
    acc = acc === "" ? segs[k]! : `${acc}/${segs[k]}`;
    if (k % 2 === 1) out.push(acc, acc.slice(0, acc.lastIndexOf("/")));
  }
  return out;
}

/**
 * Le differenze parola per parola fra due testi (il prima e il dopo di
 * un'approvazione con modifiche): `same`, `removed`, `added`.
 */
export function wordDiff(before: string, after: string) {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: { kind: "same" | "removed" | "added"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i++]! });
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: "removed", text: a[i++]! });
    else out.push({ kind: "added", text: b[j++]! });
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) out.push({ kind: "added", text: b[j++]! });
  return out;
}
