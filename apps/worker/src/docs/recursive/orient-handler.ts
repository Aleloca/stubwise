import {
  decrypt,
  docGenerationJobs,
  docGenerations,
  docNodes,
  gitAccounts,
  projects,
  type Db,
} from "@stubwise/db";
import {
  buildOrientPrompt,
  parseOrientPlan,
  slugForNode,
  type ChildSpec as EngineChildSpec,
  type OrientPlan,
} from "@stubwise/docs-engine";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AgentRunner } from "../../agent/runner.js";
import { MirrorManager, type MirrorProject } from "../../git/mirrors.js";
import type { ResolvedProvider } from "../../providers/chain.js";
import { openGenerationWorktree, type GenerationWorktree } from "../generation-worktree.js";
import { failDocJob, touchDocJob, type DocJob } from "../queue.js";
import { createWorktreeReader } from "../reader.js";
import type { GenerationWorktreeRegistry } from "./registry.js";

/**
 * ORIENTAMENTO — primo handler del motore documentazione ricorsivo (M5.2).
 *
 * È il consumatore del trigger (`doc_generation_jobs`): carica progetto/account/
 * credenziali ESATTAMENTE come `runDocGenerationJob` (helper condiviso
 * `loadGenerationContext`), crea la riga `doc_generations` `running`, apre il
 * worktree CONDIVISO della generazione (vivo per tutto il DAG), perlustra il repo
 * (survey compatto via il reader), esegue l'agente di orientamento (read-only,
 * `permissionMode:"plan"`), parsa+valida il piano con retry-poi-fallback, e SEMINA
 * le radici del DAG: due nodi radice (`technical` "Architecture Overview" +
 * `functional` "Capability Map", `awaiting_children`, depth 0) e i loro figli di 1°
 * livello (`pending`, depth 1) dalle due child-list del piano.
 *
 * IL TRIGGER NON VIENE CHIUSO QUI. L'orientamento lascia il trigger in stato
 * `running` (lo stato attivo del doc-job): la generazione è in corso e il trigger
 * verrà finalizzato (completeDocJob/failDocJob) dalla FINALIZZAZIONE (M6), quando la
 * radice raggiunge `done`. Qui colleghiamo solo `generationId` al trigger e battiamo
 * l'heartbeat (touchDocJob) durante l'orientamento. Su fallimento dell'orientamento
 * (output invalido dopo retry, errore di setup) la generazione è `failed` E il
 * trigger è `failed` subito: non c'è un DAG da far avanzare, quindi non ha senso
 * lasciarlo `running`.
 */

/** Forma attesa delle credenziali git decifrate (mirror di pipeline.ts). */
const credentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

export interface RunOrientationDeps {
  db: Db;
  mirrors: MirrorManager;
  runner: AgentRunner;
  /** Chiave AES-256 per decifrare le credenziali dell'account git. */
  encryptionKey: Buffer;
  /** Modello AI dell'agente di orientamento (DOC_GENERATION_MODEL). */
  model: string;
  /** Timeout (ms) del run dell'agente di orientamento (DOC_AGENT_TIMEOUT_MS). */
  agentTimeoutMs: number;
  /** Turni massimi del run dell'agente di orientamento. */
  maxTurns: number;
  /** Credenziale AI risolta dalla catena (prima voce); undefined = auth storica. */
  provider?: ResolvedProvider;
  /**
   * Registro IN-PROCESSO dei worktree di generazione (M7): su successo
   * (`seeded`) l'orientamento vi REGISTRA l'handle del worktree appena aperto,
   * così i job-nodo successivi del DAG ne ottengono la `dir` (il worktree resta
   * vivo per tutta la generazione). Su fallimento NON registra (il worktree è
   * chiuso qui). Iniettabile: i test di solo-orientamento possono ometterlo
   * (un registro fittizio è comunque accettato).
   */
  registry?: GenerationWorktreeRegistry;
}

export type OrientationOutcome = "seeded" | "failed";

/** Contesto di generazione: progetto + MirrorProject pronti, riga generation creata. */
interface GenerationContext {
  projectId: string;
  mirrorProject: MirrorProject;
  generationId: string;
  trigger: DocGenerationTrigger;
}

type DocGenerationTrigger = typeof docGenerationJobs.$inferSelect["trigger"];

/**
 * Carica progetto + account git, decifra le credenziali, costruisce il
 * MirrorProject, crea la riga `doc_generations` `running` e la collega al trigger.
 * È l'esatta sequenza di `runDocGenerationJob` (pipeline.ts), estratta per riuso tra
 * il vecchio motore e i nuovi handler del DAG. Su ogni fallimento chiude il trigger
 * come `failed` e ritorna `null` (il chiamante restituisce "failed").
 */
async function loadGenerationContext(
  db: Db,
  encryptionKey: Buffer,
  model: string,
  job: DocJob,
): Promise<GenerationContext | null> {
  const [row] = await db
    .select({ project: projects, account: gitAccounts })
    .from(projects)
    .innerJoin(gitAccounts, eq(projects.gitAccountId, gitAccounts.id))
    .where(eq(projects.id, job.projectId));
  if (!row) {
    await failDocJob(db, job.id, {
      log: `[docs] progetto ${job.projectId} o account git collegato non trovato`,
      error: "progetto del job non trovato",
    });
    return null;
  }
  const { project, account } = row;

  let credentials: z.infer<typeof credentialsSchema>;
  try {
    credentials = credentialsSchema.parse(
      JSON.parse(decrypt(account.encryptedCredentials, encryptionKey)),
    );
  } catch {
    await failDocJob(db, job.id, {
      log: "[docs] impossibile decifrare le credenziali dell'account git (ENCRYPTION_KEY errata o payload non valido)",
      error: "credenziali dell'account git non decifrabili",
    });
    return null;
  }

  const mirrorProject: MirrorProject = {
    provider: project.provider,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    credentials,
  };

  const [generation] = await db
    .insert(docGenerations)
    .values({
      projectId: project.id,
      status: "running",
      trigger: job.trigger,
      model,
      startedAt: sql`now()`,
    })
    .returning();
  if (!generation) {
    await failDocJob(db, job.id, {
      log: "[docs] insert della generazione non ha restituito la riga",
      error: "insert doc_generations fallito",
    });
    return null;
  }

  await db
    .update(docGenerationJobs)
    .set({ generationId: generation.id })
    .where(eq(docGenerationJobs.id, job.id));

  return {
    projectId: project.id,
    mirrorProject,
    generationId: generation.id,
    trigger: job.trigger,
  };
}

/** Manifest top-level di interesse per il survey (compatto, framework-aware). */
const SURVEY_MANIFESTS = [
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "vite.config.ts",
  "nuxt.config.ts",
  "docker-compose.yml",
  "compose.yaml",
] as const;

/** Tetto per il contenuto di un manifest nel survey: niente file enorme nel prompt. */
const MANIFEST_MAX_CHARS = 4_000;

/**
 * Costruisce un SURVEY compatto del repo per l'orientamento: l'elenco delle entry
 * TOP-LEVEL (cartelle + file di radice, dedotte da `git ls-files`) + il contenuto di
 * pochi manifest chiave presenti (package.json, config di framework, manifest di
 * altri linguaggi). È volutamente conciso: l'agente esplora oltre da sé (read-only)
 * nel worktree. Best-effort sui manifest: uno illeggibile (troppo grande, sparito)
 * viene saltato.
 */
async function buildRepoSurvey(reader: ReturnType<typeof createWorktreeReader>): Promise<string> {
  const files = await reader.list();
  const paths = files.map((f) => f.path);

  // Entry top-level: il primo segmento di ogni path (cartella o file di radice).
  const topLevel = new Set<string>();
  for (const p of paths) {
    const slash = p.indexOf("/");
    topLevel.add(slash === -1 ? p : `${p.slice(0, slash)}/`);
  }
  const entries = [...topLevel].sort();

  const sections: string[] = [
    "TOP-LEVEL ENTRIES:",
    entries.length > 0 ? entries.map((e) => `- ${e}`).join("\n") : "(repository vuoto)",
  ];

  const rootFiles = new Set(paths.filter((p) => !p.includes("/")));
  for (const manifest of SURVEY_MANIFESTS) {
    if (!rootFiles.has(manifest)) continue;
    try {
      const content = (await reader.read(manifest)).slice(0, MANIFEST_MAX_CHARS);
      sections.push(`\n--- ${manifest} ---\n${content.trim()}`);
    } catch {
      // Manifest illeggibile (oversize/sparito): saltato, il survey resta valido.
    }
  }

  return sections.join("\n");
}

/** Titolo della radice tecnica del DAG (decomposizione del codice). */
const TECHNICAL_ROOT_TITLE = "Architecture Overview";
/** Titolo della radice funzionale del DAG (capability in linguaggio non tecnico). */
const FUNCTIONAL_ROOT_TITLE = "Capability Map";

/**
 * Esegue l'agente di orientamento e ne parsa il piano, con UN retry su output
 * invalido (mancano i marcatori) prima del fallback. Ritorna il piano valido + il
 * costo aggregato dei run, oppure `null` (entrambi i tentativi invalidi). Ogni run è
 * read-only (`permissionMode:"plan"`) e batte l'heartbeat al termine.
 */
async function runOrientAgent(
  deps: RunOrientationDeps,
  job: DocJob,
  dir: string,
  prompt: string,
): Promise<{ plan: OrientPlan; costUsd: number } | null> {
  const providerOpt = deps.provider !== undefined ? { provider: deps.provider } : {};
  let costUsd = 0;
  // Un tentativo iniziale + un retry: due chance di un output ben formato.
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await deps.runner.run({
      cwd: dir,
      prompt,
      model: deps.model,
      permissionMode: "plan",
      maxTurns: deps.maxTurns,
      timeoutMs: deps.agentTimeoutMs,
      ...providerOpt,
    });
    costUsd += result.usage?.totalCostUsd ?? 0;
    await touchDocJob(deps.db, job.id);
    const plan = parseOrientPlan(result.output);
    if (plan) return { plan, costUsd };
    // Output invalido: si ritenta una volta (best-effort, poi fallback).
  }
  return null;
}

/**
 * Semina il DAG dalle due child-list del piano, in UNA transazione: due nodi radice
 * (technical + functional, depth 0) e i loro figli di 1° livello (depth 1, `pending`).
 * Le radici partono `awaiting_children` con `pendingChildren` = numero dei loro figli
 * (il contatore del join). Una radice SENZA figli è un caso degenere (l'orientamento
 * non ha trovato nulla da decomporre per quell'albero): la portiamo direttamente a
 * `done` con un body vuoto e `pendingChildren=0`, così il join sull'altra radice/la
 * finalizzazione non resta in attesa di un ramo che non avanzerà mai. Gli slug sono
 * generati con `slugForNode` su un set CONDIVISO tra tutti i nodi della generazione
 * (radici + figli), così non collidono.
 */
async function seedDag(
  db: Db,
  ctx: GenerationContext,
  plan: OrientPlan,
): Promise<void> {
  const usedSlugs = new Set<string>();
  await db.transaction(async (tx) => {
    await seedRoot(tx, ctx, "technical", TECHNICAL_ROOT_TITLE, plan.technical, usedSlugs);
    await seedRoot(tx, ctx, "functional", FUNCTIONAL_ROOT_TITLE, plan.functional, usedSlugs);
  });
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Inserisce una radice (depth 0) e i suoi figli di 1° livello (depth 1). */
async function seedRoot(
  tx: Tx,
  ctx: GenerationContext,
  tree: "technical" | "functional",
  title: string,
  children: EngineChildSpec[],
  usedSlugs: Set<string>,
): Promise<void> {
  const rootSlug = slugForNode(title, usedSlugs);
  const hasChildren = children.length > 0;
  const [root] = await tx
    .insert(docNodes)
    .values({
      generationId: ctx.generationId,
      projectId: ctx.projectId,
      parentId: null,
      tree,
      // Radice con figli → attende il join; radice degenere senza figli → done.
      status: hasChildren ? ("awaiting_children" as const) : ("done" as const),
      pendingChildren: children.length,
      depth: 0,
      position: 0,
      title,
      slug: rootSlug,
      sourcePaths: [],
      ...(hasChildren ? {} : { finishedAt: sql`now()` }),
    })
    .returning({ id: docNodes.id });
  if (!root) throw new Error(`insert della radice ${tree} non ha restituito la riga`);
  if (!hasChildren) return;

  await tx.insert(docNodes).values(
    children.map((spec, index) => ({
      generationId: ctx.generationId,
      projectId: ctx.projectId,
      parentId: root.id,
      tree,
      status: "pending" as const,
      depth: 1,
      position: index,
      unitRef: spec.unitRef ?? null,
      title: spec.title,
      slug: slugForNode(spec.title, usedSlugs),
      sourcePaths: spec.sourcePaths ?? [],
    })),
  );
}

/** Marca la generazione `failed` e chiude il trigger `failed` (orientamento fallito). */
async function failOrientation(
  db: Db,
  generationId: string,
  jobId: string,
  message: string,
): Promise<void> {
  await db
    .update(docGenerations)
    .set({ status: "failed", error: message, finishedAt: sql`now()` })
    .where(eq(docGenerations.id, generationId));
  await failDocJob(db, jobId, { log: `[docs] orientamento fallito: ${message}`, error: message });
}

/**
 * Esegue l'orientamento per il trigger `job`: semina le radici del DAG (vedi
 * docblock del modulo). Ritorna "seeded" (DAG seminato, generazione `running`,
 * trigger `running` lasciato per la finalizzazione M6) o "failed" (generazione +
 * trigger `failed`). Il worktree di generazione viene CHIUSO qui SOLO su fallimento;
 * su successo resta APERTO per i job-nodo del DAG e sarà chiuso dalla finalizzazione.
 */
export async function runOrientation(
  deps: RunOrientationDeps,
  job: DocJob,
): Promise<OrientationOutcome> {
  const { db, mirrors } = deps;

  const ctx = await loadGenerationContext(db, deps.encryptionKey, deps.model, job);
  if (!ctx) return "failed";

  let worktree: GenerationWorktree | null = null;
  try {
    worktree = await openGenerationWorktree(mirrors, ctx.mirrorProject);
    await db
      .update(docGenerations)
      .set({ commitSha: worktree.commitSha })
      .where(eq(docGenerations.id, ctx.generationId));
    await touchDocJob(db, job.id);

    const reader = createWorktreeReader(worktree.dir);
    const survey = await buildRepoSurvey(reader);
    const prompt = buildOrientPrompt(survey);

    const orient = await runOrientAgent(deps, job, worktree.dir, prompt);
    if (!orient) {
      await worktree.close();
      await failOrientation(
        db,
        ctx.generationId,
        job.id,
        "output di orientamento non valido (marcatori mancanti) dopo retry",
      );
      return "failed";
    }

    // Costo dell'orientamento aggregato nella generazione (gli explore/synthesize
    // lo sommeranno alla finalizzazione, M6).
    await db
      .update(docGenerations)
      .set({ cost: orient.costUsd.toFixed(6) })
      .where(eq(docGenerations.id, ctx.generationId));

    await seedDag(db, ctx, orient.plan);

    // Il worktree resta APERTO: i job-nodo del DAG lo riusano (read-only). Lo
    // REGISTRO nel registro in-processo (M7) così il dispatch ne ricava la `dir` per
    // explore/synthesize e ne traccia la mutua esclusione col fix (activeProjectIds).
    // La generazione resta `running`; il trigger resta `running` (NON succeeded): sarà
    // finalizzato dalla M6 quando la radice raggiunge `done`. Heartbeat finale.
    deps.registry?.register(ctx.generationId, ctx.projectId, worktree);
    await touchDocJob(db, job.id);
    return "seeded";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (worktree) await worktree.close().catch(() => {});
    await failOrientation(db, ctx.generationId, job.id, message);
    return "failed";
  }
}
