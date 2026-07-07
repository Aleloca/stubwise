import { docNodes, type Db } from "@stubwise/db";
import {
  buildSynthesizePrompt,
  parseSynthesisOutput,
  type ChildSummary,
} from "@stubwise/docs-engine";
import { and, asc, eq, sql } from "drizzle-orm";
import type { AgentRunner } from "../../agent/runner.js";
import type { ResolvedProvider } from "../../providers/chain.js";
import { isLimitError } from "../../providers/limit.js";
import { completeNode, touchNode, type DocNode } from "../nodes.js";
import { loadBriefContext } from "./brief-context.js";

/**
 * SYNTHESIZE HANDLER — esegue la FASE di sintesi di un nodo-ramo (M5.4).
 *
 * Un nodo arriva qui quando tutti i suoi figli sono chiusi (il join lo ha portato a
 * `ready_to_synthesize` e `claimNextNode` lo ha reclamato come `synthesizing`).
 * L'handler:
 *  - raccoglie i figli `done` (titolo + un RIASSUNTO breve del loro body, per l'indice);
 *  - costruisce `buildSynthesizePrompt` (intro = il body dell'explore del nodo) ed esegue
 *    l'agente, `parseSynthesisOutput` con UN retry su output invalido;
 *  - su output valido scrive l'OVERVIEW nel body del nodo, poi `completeNode` (→ `done`,
 *    il join avanza sul padre);
 *  - su output ancora invalido NON fallisce: i figli sono già documentati e non vanno
 *    persi. FALLBACK a un overview minimale generato qui (l'intro dell'explore + un
 *    indice dei figli con i loro riassunti), poi `completeNode`. Documento questa scelta:
 *    failNode lascerebbe il padre senza la pagina-indice e i figli orfani in UI; un
 *    overview semplice è sempre meglio di una pagina mancante.
 *
 * WORKTREE: stessa scelta dell'explore handler — `deps.worktreeDir` è iniettato (il
 * worktree CONDIVISO della generazione, tenuto vivo dal loop di dispatch). La sintesi
 * lavora sui RIASSUNTI dei figli, non ha codice da leggere, ma esegue comunque
 * nell'cwd del worktree per coerenza (read-only).
 *
 * COSTO + HEARTBEAT: il costo del run è aggregato e ritornato (sommato nella
 * generazione alla M6); ogni run batte l'heartbeat (`touchNode`).
 */

export interface RunSynthesizeDeps {
  db: Db;
  runner: AgentRunner;
  /** Directory del worktree CONDIVISO della generazione (cwd read-only dell'agente). */
  worktreeDir: string;
  /** Modello AI dell'agente di sintesi (DOC_GENERATION_MODEL). */
  model: string;
  /** Timeout (ms) del run dell'agente (DOC_AGENT_TIMEOUT_MS). */
  agentTimeoutMs: number;
  /** Turni massimi del run dell'agente. */
  maxTurns: number;
  /** Credenziale AI risolta dalla catena (prima voce); undefined = auth storica. */
  provider?: ResolvedProvider;
}

export type SynthesizeOutcome = "synthesized" | "fallback" | "limit";

/** Costo aggregato + esito di una sintesi (il costo è sommato nella generazione alla M6). */
export interface SynthesizeResult {
  outcome: SynthesizeOutcome;
  costUsd: number;
}

/** Lunghezza del riassunto estratto dal body di un figlio per l'indice (prompt bounded). */
const CHILD_SUMMARY_CHARS = 400;

/**
 * Estrae un riassunto breve dal body markdown di un figlio: il primo paragrafo di
 * prosa (saltando heading vuoti / righe `###`), troncato. Best-effort: un body vuoto
 * o tutto-heading degrada a stringa vuota (il prompt lo segna "(no summary)").
 */
function summarizeBody(body: string): string {
  for (const rawBlock of body.split(/\n\s*\n/)) {
    const block = rawBlock.trim();
    if (block === "") continue;
    // Salta i blocchi che sono SOLO heading (righe che iniziano con `#`).
    const prose = block
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join(" ")
      .trim();
    if (prose !== "") return prose.slice(0, CHILD_SUMMARY_CHARS);
  }
  return "";
}

/** Raccoglie i figli `done` del nodo (per position), con titolo + riassunto per l'indice. */
async function loadDoneChildren(db: Db, nodeId: string): Promise<ChildSummary[]> {
  const children = await db
    .select({ title: docNodes.title, body: docNodes.body })
    .from(docNodes)
    .where(and(eq(docNodes.parentId, nodeId), eq(docNodes.status, "done")))
    .orderBy(asc(docNodes.position));
  return children.map((c) => ({ title: c.title, summary: summarizeBody(c.body ?? "") }));
}

/**
 * Esegue l'agente di sintesi e ne parsa l'output, con UN retry su output invalido
 * prima del fallback. Ritorna il body valido + il costo aggregato, oppure
 * `{limit: true}` (run al limite di rate/usage del provider), oppure `null` col
 * solo costo (entrambi i tentativi invalidi → il chiamante usa il fallback). Ogni run
 * batte l'heartbeat al termine.
 */
async function runSynthesizeAgent(
  deps: RunSynthesizeDeps,
  node: DocNode,
  prompt: string,
): Promise<
  | { body: string; costUsd: number }
  | { body: null; costUsd: number }
  | { limit: true; costUsd: number }
> {
  const providerOpt = deps.provider !== undefined ? { provider: deps.provider } : {};
  let costUsd = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await deps.runner.run({
      cwd: deps.worktreeDir,
      prompt,
      model: deps.model,
      permissionMode: "plan",
      maxTurns: deps.maxTurns,
      timeoutMs: deps.agentTimeoutMs,
      ...providerOpt,
    });
    costUsd += result.usage?.totalCostUsd ?? 0;
    await touchNode(deps.db, node.id);
    // Limite di rate/usage del provider: NON è un output invalido — non
    // consuma il retry e non degrada al fallback. Il chiamante mette in pausa
    // l'intera generazione (i run al limite tornano output degradato: ogni
    // retry qui sarebbe un run bruciato).
    if (isLimitError(result)) return { limit: true, costUsd };
    const parsed = parseSynthesisOutput(result.output);
    if ("body" in parsed) return { body: parsed.body, costUsd };
    // Output invalido (`reason`): si ritenta una volta, poi fallback.
  }
  return { body: null, costUsd };
}

/**
 * Overview minimale di FALLBACK quando l'agente non produce un output valido:
 * l'intro dell'explore del nodo (se presente) + un indice dei figli con i loro
 * riassunti. Garantisce che la pagina-indice esista e linki i figli, così i figli
 * documentati non restano orfani in UI.
 */
function buildFallbackOverview(intro: string, children: ChildSummary[]): string {
  const lines: string[] = [];
  const trimmedIntro = intro.trim();
  if (trimmedIntro !== "") lines.push(trimmedIntro, "");
  for (const child of children) {
    lines.push(`### ${child.title}`);
    lines.push(child.summary.trim() !== "" ? child.summary.trim() : "Vedi la pagina dedicata.");
    lines.push("");
  }
  return lines.join("\n").trim();
}

/**
 * Esegue la sintesi del `node` (vedi docblock del modulo). Ritorna l'esito
 * (`synthesized`/`fallback`) + il costo aggregato. Il nodo dev'essere `synthesizing`
 * (reclamato): la scrittura del body e `completeNode` sono status-guarded su
 * `synthesizing`, quindi una ownership persa non sovrascrive né doppio-joina.
 */
export async function runSynthesize(
  deps: RunSynthesizeDeps,
  node: DocNode,
): Promise<SynthesizeResult> {
  const { db } = deps;
  const intro = node.body ?? "";

  const children = await loadDoneChildren(db, node.id);
  // Contesto del brief (glossario/attori/invarianti, senza segreti), cache per-processo.
  // Assente → undefined = prompt byte-identico a prima.
  const briefContext = await loadBriefContext(db, node.generationId);
  // Il DAG explore/synthesize opera SOLO sui due alberi interni (technical/functional);
  // i nodi `product` sono generati e chiusi dall'handler product dedicato e non
  // raggiungono questo path. Difesa in profondità: un tree fuori dai due alberi
  // ricade su "functional" per la scelta della variante di prompt.
  const tree = node.tree === "technical" ? "technical" : "functional";
  const prompt = buildSynthesizePrompt(
    {
      tree,
      title: node.title,
      intro,
      children,
    },
    briefContext,
  );

  const run = await runSynthesizeAgent(deps, node, prompt);
  // Run al limite del provider: NIENTE overview di fallback (nasconderebbe una pagina
  // degradata dietro un esito "done") e il nodo NON è completato — resta in
  // lavorazione, sarà il dispatcher a riaccodarlo e a mettere in pausa la generazione.
  if ("limit" in run) {
    return { outcome: "limit", costUsd: run.costUsd };
  }
  const body = run.body ?? buildFallbackOverview(intro, children);
  const outcome: SynthesizeOutcome = run.body ? "synthesized" : "fallback";
  if (run.body === null) {
    console.warn(
      `[docs] nodo ${node.id}: output di sintesi non valido dopo retry → overview di fallback ` +
        `(${children.length} figli linkati, non persi)`,
    );
  }

  // Scrive il body della sintesi (status-guarded su `synthesizing`), poi chiude il
  // nodo `done` e fa avanzare il join sul padre. completeNode è a sua volta guarded
  // su stati in lavorazione: ownership persa → niente scrittura/doppio-join.
  await writeSynthBody(db, node.id, body);
  await completeNode(db, node.id);
  return { outcome, costUsd: run.costUsd };
}

/**
 * Scrive il body della sintesi nel nodo, status-guarded su `synthesizing` (ownership):
 * se un altro worker ha ripreso il nodo nel frattempo, l'UPDATE non tocca righe. NON
 * riusa `writeExploreResult` (quello è guarded su `exploring`): la sintesi conserva i
 * `source_paths` già scritti dall'explore e tocca solo il body.
 */
async function writeSynthBody(db: Db, nodeId: string, body: string): Promise<boolean> {
  const updated = await db
    .update(docNodes)
    .set({ body, lastActivityAt: sql`now()` })
    .where(and(eq(docNodes.id, nodeId), eq(docNodes.status, "synthesizing")))
    .returning({ id: docNodes.id });
  return updated.length > 0;
}
