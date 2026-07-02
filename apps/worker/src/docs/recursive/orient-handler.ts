import {
  decrypt,
  docGenerationJobs,
  docGenerations,
  docNodes,
  gitAccounts,
  repositories,
  type Db,
} from "@stubwise/db";
import {
  buildOrientPrompt,
  parseOrientPlan,
  slugForNode,
  type ChildSpec as EngineChildSpec,
  type OrientPlan,
} from "@stubwise/docs-engine";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AgentRunner } from "../../agent/runner.js";
import { MirrorManager, type MirrorProject } from "../../git/mirrors.js";
import type { ResolvedProvider } from "../../providers/chain.js";
import { isLimitError } from "../../providers/limit.js";
import { openGenerationWorktree, type GenerationWorktree } from "../generation-worktree.js";
import { completeDocJob, failDocJob, holdDocJob, touchDocJob, type DocJob } from "../queue.js";
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
 * IL TRIGGER VIENE CHIUSO QUI (decoupling, C2). Il compito del trigger è SOLO avviare
 * la generazione: appena il DAG è seminato lo marchiamo `succeeded` (con `generationId`
 * collegato). NON lo teniamo `running` per tutto il DAG — lo stato "generazione in corso"
 * vive su `doc_generations` (running → succeeded/failed alla finalizzazione M6), unica
 * fonte di verità. Tenerlo `running` a lungo lo esporrebbe a `requeueStaleDocJobs`, che
 * su una generazione lunga lo riaccoderebbe → seconda generazione/fallimento post-riavvio.
 * Durante l'orientamento battiamo comunque l'heartbeat (touchDocJob). Su fallimento
 * (output invalido dopo retry, piano vuoto, errore di setup) la generazione è `failed` E
 * il trigger è `failed`. Se il repository ha già una generazione `running` (guard DB), il
 * trigger è `succeeded`-skip senza avviarne una seconda.
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
   * Provider BLOCCATO della generazione (se l'utente ne ha scelto uno): viene
   * SEMINATO su `doc_generations.pinned_provider_id`, così i job-nodo del DAG lo
   * rileggono e si blindano sullo stesso provider (niente fallback su chain[0]).
   * undefined = nessun pin (comportamento attuale: catena di failover).
   */
  pinnedProviderId?: string;
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

export type OrientationOutcome = "seeded" | "failed" | "skipped" | "held";

/**
 * GUARDIA DB nuova-generazione (sopravvive al riavvio del worker): true se il repository
 * ha GIÀ una generazione `running` nel DB. È la difesa AUTORITATIVA contro l'avvio di
 * una SECONDA generazione concorrente sullo stesso repository (due worktree concorrenti
 * sullo stesso mirror → corruzione del ref checked-out). A differenza del guard
 * in-processo del registro (`activeRepositoryIds`, che si azzera al riavvio), questa lettura
 * del DB persiste tra i riavvii: se un riavvio ha perso il worktree ma `doc_generations`
 * ha ancora una riga `running`, un nuovo trigger NON parte (la vecchia generazione sarà
 * fatta fallire dal fail-on-restart del dispatch quando i suoi nodi vengono reclamati).
 * Le `paused` NON servono qui: in-processo il registro copre già il repository/progetto
 * per tutta la pausa; dopo un riavvio la paused è comunque destinata al fail-on-restart.
 */
async function hasRunningGeneration(db: Db, repositoryId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: docGenerations.id })
    .from(docGenerations)
    .where(and(eq(docGenerations.repositoryId, repositoryId), eq(docGenerations.status, "running")))
    .limit(1);
  return row !== undefined;
}

/** Contesto di generazione: repository + MirrorProject pronti, riga generation creata. */
interface GenerationContext {
  repositoryId: string;
  /** Progetto (gruppo) del repository: usato per la mutua esclusione fix↔generazione
   * per-progetto (registry.activeProjectIds). */
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
  pinnedProviderId: string | null,
): Promise<GenerationContext | null> {
  const [row] = await db
    .select({ project: repositories, account: gitAccounts })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(eq(repositories.id, job.repositoryId));
  if (!row) {
    await failDocJob(db, job.id, {
      log: `[docs] repository ${job.repositoryId} o account git collegato non trovato`,
      error: "repository del job non trovato",
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
      repositoryId: project.id,
      status: "running",
      trigger: job.trigger,
      model,
      // Provider bloccato della generazione: i job-nodo lo rileggono da qui per
      // blindarsi sullo stesso provider (null = nessun pin, catena di failover).
      pinnedProviderId,
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
    repositoryId: project.id,
    projectId: project.projectId,
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
 * costo aggregato dei run, `{limit: true}` se il run ha toccato il LIMITE di
 * rate/usage del provider (rilevato PRIMA del parse e senza consumare il retry:
 * ogni tentativo in più sarebbe un run bruciato contro lo stesso limite), oppure
 * `null` (entrambi i tentativi invalidi). Ogni run è read-only
 * (`permissionMode:"plan"`) e batte l'heartbeat al termine.
 */
async function runOrientAgent(
  deps: RunOrientationDeps,
  job: DocJob,
  dir: string,
  prompt: string,
): Promise<{ plan: OrientPlan; costUsd: number } | { limit: true; costUsd: number } | null> {
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
    // Limite del provider: esce SUBITO (niente retry — tornerebbe un altro
    // output degradato) e lascia la classificazione al chiamante.
    if (isLimitError(result)) return { limit: true, costUsd };
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
      repositoryId: ctx.repositoryId,
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
      repositoryId: ctx.repositoryId,
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
 * docblock del modulo). Ritorna:
 *  - "seeded": DAG seminato, generazione `running`, TRIGGER `succeeded` (il suo compito
 *    — avviare la generazione — è concluso; la vita della generazione vive su
 *    `doc_generations`, non sul trigger);
 *  - "failed": generazione + trigger `failed` (orientamento invalido, piano vuoto, errore);
 *  - "skipped": il repository ha già una generazione `running` (guard DB) → trigger
 *    `succeeded`-skip, nessuna seconda generazione avviata;
 *  - "held": run al LIMITE di rate/usage del provider → generazione `failed` (con
 *    messaggio esplicito) e trigger `held` con held_reason "limit": il resume poller
 *    lo riaccoderà al reset del limite e il nuovo run creerà una generazione fresca.
 * Il worktree di generazione viene CHIUSO qui SOLO su fallimento; su successo resta
 * APERTO per i job-nodo del DAG e sarà chiuso dalla finalizzazione.
 */
export async function runOrientation(
  deps: RunOrientationDeps,
  job: DocJob,
): Promise<OrientationOutcome> {
  const { db, mirrors } = deps;

  // GUARDIA DB (autoritativa, sopravvive al riavvio): se il repository ha già una
  // generazione `running`, NON ne avvio una seconda (eviterebbe due worktree concorrenti
  // sullo stesso mirror). Chiudo il trigger `succeeded` con un log chiaro (skip pulito):
  // il trigger ha fatto il suo dovere — non c'è nulla da fare perché una generazione è
  // già in corso. NB: il guard in-processo del registro (handler.ts) resta come difesa
  // in profondità; questo è il check autoritativo.
  if (await hasRunningGeneration(db, job.repositoryId)) {
    await completeDocJob(db, job.id, {
      log: "[docs] una generazione è già in corso (doc_generations running) per questo repository: trigger ignorato senza avviarne una seconda",
    });
    console.error(
      `[stubwise-worker] trigger doc-generation per il repository ${job.repositoryId} ignorato: generazione già running (guard DB)`,
    );
    return "skipped";
  }

  const ctx = await loadGenerationContext(
    db,
    deps.encryptionKey,
    deps.model,
    job,
    deps.pinnedProviderId ?? null,
  );
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
    // LIMITE del provider durante l'orientamento: il DAG non esiste ancora,
    // quindi la "pausa" della generazione non è definita qui (nessun nodo da
    // riprendere). Il trigger va HELD con held_reason "limit" (il resume poller
    // lo riaccoderà al reset del limite) e la generazione FALLISCE con un
    // messaggio esplicito: alla ripresa il job riaccodato ne crea una FRESCA
    // (si perde solo questo run di orientamento). NB: NON si usa
    // failOrientation, che chiuderebbe anche il trigger `failed` — qui le due
    // transizioni sono deliberatamente diverse (generazione failed, job held).
    if (orient && "limit" in orient) {
      await worktree.close();
      await db
        .update(docGenerations)
        .set({
          status: "failed",
          error:
            "provider AI al limite di rate/usage durante l'orientamento: la generazione verrà ritentata automaticamente al reset del limite",
          cost: orient.costUsd.toFixed(6),
          finishedAt: sql`now()`,
        })
        .where(eq(docGenerations.id, ctx.generationId));
      await holdDocJob(db, job.id, {
        reason:
          "provider AI al limite di rate/usage durante l'orientamento: generazione sospesa, verrà ritentata al reset del limite",
        heldReason: "limit",
      });
      return "held";
    }
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

    // PIANO VUOTO (C1): se ENTRAMBI gli alberi non hanno figli, il DAG non avrebbe
    // alcun nodo claimabile — entrambe le radici partirebbero `done` con zero figli e la
    // finalizzazione (innescata dal dispatch di un nodo) non scatterebbe MAI → generazione
    // bloccata `running` + worktree leaked. Lo trattiamo come FALLIMENTO dell'orientamento
    // (l'agente non ha trovato NULLA da documentare): generazione + trigger `failed`,
    // worktree chiuso. Se almeno un albero ha figli si procede normalmente (l'altro
    // albero vuoto → radice `done` è il caso degenere già gestito da seedRoot, e la
    // finalizzazione scatta quando l'albero non-vuoto si chiude).
    if (orient.plan.technical.length === 0 && orient.plan.functional.length === 0) {
      await worktree.close();
      await failOrientation(
        db,
        ctx.generationId,
        job.id,
        "piano di orientamento vuoto: nessuna unità tecnica né capability funzionale da documentare",
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
    // explore/synthesize e ne traccia la mutua esclusione col fix (activeRepositoryIds per
    // la guardia nuova-generazione; activeProjectIds per l'esclusione dei fix di progetto).
    deps.registry?.register(ctx.generationId, ctx.repositoryId, ctx.projectId, worktree);

    // TRIGGER `succeeded` ORA (C2): seminato il DAG, il compito del trigger è finito.
    // La vita della generazione (running → succeeded/failed) vive su `doc_generations`,
    // unica fonte di verità: NON teniamo il trigger `running` per tutto il DAG, altrimenti
    // su una generazione lunga `requeueStaleDocJobs` lo riaccoderebbe → seconda
    // generazione/fallimento post-riavvio. La finalizzazione (M6) NON tocca più il trigger.
    await completeDocJob(db, job.id, {
      log: "[docs] orientamento completato: DAG seminato, generazione in corso (trigger concluso; lo stato vive su doc_generations)",
      generationId: ctx.generationId,
    });
    return "seeded";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (worktree) await worktree.close().catch(() => {});
    await failOrientation(db, ctx.generationId, job.id, message);
    return "failed";
  }
}
