import {
  backlogChatMessages,
  backlogItems,
  decrypt,
  gitAccounts,
  repositories,
} from "@stubwise/db";
import { t } from "@stubwise/i18n";
import {
  backlogSuggestedSchema,
  type BacklogDeepDivePayload,
  type BacklogSuggested,
  type Language,
} from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AgentRunResult } from "../agent/runner.js";
import type { MirrorProject } from "../git/mirrors.js";
import { getContentLanguage } from "../settings.js";
import { MalformedBacklogPayloadError, type BacklogDeps, type BacklogJob } from "./poller.js";
import { buildDeepDivePrompt } from "./prompts.js";
import { loadProjectAiProviderId, resolveBacklogProvider } from "./provider.js";

/**
 * DEEP DIVE del backlog di discovery: approfondimento tecnico di una voce SUL
 * CODICE reale del repo collegato (pattern PR review).
 *
 * A differenza dell'intake — che ragiona sul solo testo del feedback in una dir
 * vuota — il deep dive monta un WORKTREE del mirror alla HEAD del default branch
 * ed esegue l'agente in `permissionMode: "plan"` (read-only): l'agente DEVE
 * leggere il codice per valutare fattibilità, punti di contatto e rischi di
 * regressione concreti. L'esito:
 *  - sostituisce (o appende) la sezione `## Analisi tecnica` nel documento;
 *  - salva i metadati `suggested` (sostituisce il precedente, mai applicati in
 *    automatico: l'umano li promuove dal raffinamento);
 *  - lascia un messaggio `system` nella chat della voce.
 * La voce NON cambia status.
 *
 * ERRORI: voce inesistente/archiviata → no-op (done, ritentare è inutile). Repo
 * inesistente o di un ALTRO progetto → fallimento PERMANENTE
 * (MalformedBacklogPayloadError: il payload punta a un repo non valido, il retry
 * non cambierebbe l'esito). Tutto il resto (mirror/worktree, agente, parse) →
 * throw normale: il poller riaccoda finché ci sono tentativi, poi failed.
 */

/** Intestazione (livello 2) della sezione tecnica gestita dal deep dive. */
const ANALYSIS_HEADING = "## Analisi tecnica";

/** Cap difensivo dell'analisi (~30k, mirror del cap document dell'intake). */
const deepDiveOutputSchema = z.object({
  analysis: z.string().min(1).max(30_000),
  suggested: backlogSuggestedSchema.optional(),
});
type DeepDiveOutput = z.infer<typeof deepDiveOutputSchema>;

/** Forma attesa delle credenziali git decifrate (mirror di run-review.ts). */
const credentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

/**
 * Estrae e parsa l'oggetto JSON dall'output dell'agente in modo DIFENSIVO (mirror
 * di parseAgentJson nell'intake): tollera un fence ```json … ``` e un pre/
 * postambolo attorno all'oggetto, poi valida contro `schema`. Null se non
 * parsabile/non conforme.
 */
function parseAgentJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Testo utile da un run: throw se exit ≠ 0 (runner.run RISOLVE anche su exit
 * non-zero → niente output da un run crashato). */
function outputOrThrow(result: AgentRunResult): string {
  if (result.exitCode !== 0) {
    throw new Error(`deep dive: agente uscito con exit ${result.exitCode}`);
  }
  return result.output;
}

/**
 * Sostituisce la sezione `## Analisi tecnica` del documento (dalla sua
 * intestazione fino alla prossima intestazione di livello 2 o alla fine) con
 * `analysis`; se la sezione non esiste, la appende in fondo. Funzione pura,
 * delimitatori chiari (l'intestazione fissa). Le intestazioni `###` (livello 3+)
 * interne alla sezione NON la chiudono: solo un altro `## ` la termina.
 */
export function upsertAnalysisSection(document: string, analysis: string): string {
  const section = `${ANALYSIS_HEADING}\n\n${analysis.trim()}`;
  const lines = document.split("\n");
  const startIdx = lines.findIndex((line) => line.trim() === ANALYSIS_HEADING);
  if (startIdx === -1) {
    const base = document.replace(/\s+$/, "");
    return base.length === 0 ? section : `${base}\n\n${section}`;
  }
  // Fine della sezione: la prossima intestazione di livello 2 (## ...), NON una
  // `###` (che non matcha `^##\s`). Assente → fine del documento.
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) {
      endIdx = i;
      break;
    }
  }
  const before = lines.slice(0, startIdx).join("\n").replace(/\s+$/, "");
  const after = lines.slice(endIdx).join("\n").replace(/^\s+/, "");
  const parts: string[] = [];
  if (before.length > 0) parts.push(before);
  parts.push(section);
  if (after.length > 0) parts.push(after);
  return parts.join("\n\n");
}

/** Contesto del repository scelto per il deep dive. */
interface DeepDiveContext {
  mirrorProject: MirrorProject;
  repositoryName: string;
}

/**
 * Carica il repository scelto + l'account git e ne decifra le credenziali. Il
 * repo DEVE appartenere al progetto del job: assente o di un altro progetto →
 * MalformedBacklogPayloadError (fallimento permanente, il payload è invalido).
 * Credenziali non decifrabili → throw normale (retry).
 */
async function loadDeepDiveContext(
  deps: BacklogDeps,
  repositoryId: string,
  projectId: string,
): Promise<DeepDiveContext> {
  const [row] = await deps.db
    .select({ repository: repositories, account: gitAccounts })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(eq(repositories.id, repositoryId));
  if (!row) {
    throw new MalformedBacklogPayloadError(`deep dive: repository ${repositoryId} inesistente`);
  }
  if (row.repository.projectId !== projectId) {
    throw new MalformedBacklogPayloadError(
      `deep dive: repository ${repositoryId} non appartiene al progetto del job`,
    );
  }
  let credentials: z.infer<typeof credentialsSchema>;
  try {
    credentials = credentialsSchema.parse(
      JSON.parse(decrypt(row.account.encryptedCredentials, deps.encryptionKey)),
    );
  } catch {
    throw new Error(`deep dive: credenziali git del repository ${repositoryId} non decifrabili`);
  }
  return {
    mirrorProject: {
      provider: row.repository.provider,
      repoUrl: row.repository.repoUrl,
      defaultBranch: row.repository.defaultBranch,
      credentials,
    },
    repositoryName: row.repository.name,
  };
}

/**
 * Applica l'esito del deep dive in una transazione: documento con la sezione
 * `## Analisi tecnica` aggiornata, `suggested` sostituito, messaggio `system`
 * nella chat. `suggested` senza alcun campo utile → null (nessun suggerimento).
 */
async function applyDeepDive(
  deps: BacklogDeps,
  itemId: string,
  currentDocument: string,
  output: DeepDiveOutput,
  repositoryName: string,
  lang: Language,
): Promise<void> {
  const suggested: BacklogSuggested | null =
    output.suggested && Object.keys(output.suggested).length > 0 ? output.suggested : null;
  const document = upsertAnalysisSection(currentDocument, output.analysis);
  await deps.db.transaction(async (tx) => {
    await tx.update(backlogItems).set({ document, suggested }).where(eq(backlogItems.id, itemId));
    await tx.insert(backlogChatMessages).values({
      itemId,
      role: "system",
      content: t(lang, "backlog.deepDiveDone", { repo: repositoryName }),
    });
  });
}

/**
 * Esegue il deep dive di un job del backlog (già reclamato). Vedi il commento di
 * modulo per il contratto di errori. La voce resta nello status corrente.
 */
export async function runDeepDive(
  deps: BacklogDeps,
  job: BacklogJob,
  payload: BacklogDeepDivePayload,
): Promise<void> {
  const { db } = deps;

  // 1. Voce: inesistente o archiviata → no-op (ritentare non cambia nulla).
  const [item] = await db
    .select({
      id: backlogItems.id,
      projectId: backlogItems.projectId,
      title: backlogItems.title,
      document: backlogItems.document,
      status: backlogItems.status,
      effort: backlogItems.effort,
      risk: backlogItems.risk,
      urgency: backlogItems.urgency,
    })
    .from(backlogItems)
    .where(eq(backlogItems.id, payload.itemId));
  if (!item || item.status === "archived") {
    deps.logger.warn(
      { jobId: job.id, itemId: payload.itemId },
      "[backlog] deep dive: voce inesistente o archiviata, no-op",
    );
    return;
  }

  // 2. Repository scelto (deve stare nel progetto del job) + credenziali git.
  const ctx = await loadDeepDiveContext(deps, payload.repositoryId, job.projectId);

  // 3. Lingua dei contenuti (messaggio system), risolta una volta per job.
  const lang = await getContentLanguage(db);

  // 4. Provider AI: pinned del progetto o chain[0]; undefined = auth del container.
  const aiProviderId = await loadProjectAiProviderId(db, job.projectId);
  const provider = await resolveBacklogProvider(deps, aiProviderId);

  // 5. Sha di HEAD del default branch + run read-only nel worktree (pattern PR
  //    review): l'agente esplora il codice reale in plan mode.
  const headSha = await deps.mirrors.resolveDefaultBranchHead(ctx.mirrorProject);
  const result = await deps.mirrors.withWorktreeAtSha(ctx.mirrorProject, headSha, (dir) =>
    deps.runner.run({
      cwd: dir,
      prompt: buildDeepDivePrompt({
        title: item.title,
        document: item.document,
        effort: item.effort,
        risk: item.risk,
        urgency: item.urgency,
      }),
      ...(deps.model !== undefined ? { model: deps.model } : {}),
      permissionMode: "plan",
      maxTurns: deps.deepDiveMaxTurns,
      timeoutMs: deps.agentTimeoutMs,
      ...(provider !== undefined ? { provider } : {}),
    }),
  );

  // 6. Parse difensivo: exit ≠ 0 o output non conforme → throw (retry).
  const parsed = parseAgentJson(outputOrThrow(result), deepDiveOutputSchema);
  if (!parsed) throw new Error("deep dive: output dell'agente non parsabile");

  // 7. Applica: documento + suggested + messaggio system (transazione).
  await applyDeepDive(deps, item.id, item.document, parsed, ctx.repositoryName, lang);
}
