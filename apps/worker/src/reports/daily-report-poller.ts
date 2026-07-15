import {
  activityReportEntries,
  activityReports,
  decrypt,
  gitAccounts,
  gitAuthorsSeen,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { eq, lt } from "drizzle-orm";
import { z } from "zod";
import type { AgentRunner } from "../agent/runner.js";
import type { MirrorManager, MirrorProject, RangeCommit } from "../git/mirrors.js";
import type { ProjectSerializer } from "../handler.js";
import {
  loadProviderById,
  loadProviderChain,
  type ResolvedProvider,
} from "../providers/chain.js";

/**
 * DAILY ACTIVITY REPORT poller — lo "standup" giornaliero automatico.
 *
 * Task SEPARATO dal loop dei job (pattern limit-resume / pr-review poller): su un
 * proprio intervallo, con un GATE a mezzanotte UTC (un solo report per progetto
 * per giorno, reso idempotente dall'unique (project_id, date)), per ogni progetto
 * con `dailyReportEnabled=true` legge i commit del GIORNO UTC PRECEDENTE da ogni
 * suo repo (getCommitsInRange, Task 2), li aggrega per email autore, registra gli
 * autori osservati (git_authors_seen), genera un riassunto AI per autore e
 * persiste tutto in activity_reports + activity_report_entries.
 *
 * IDEMPOTENZA: la creazione della riga activity_reports usa
 * `.onConflictDoNothing()` sull'unique (project_id, date): il primo tick del
 * giorno la crea, i successivi vedono il conflitto e SALTANO (non ci sono
 * doppioni né un secondo giro di run dell'agente). Il gate "un giorno per volta"
 * emerge da qui, non da un timer preciso a mezzanotte: il poller può girare
 * ogni N minuti e resta corretto.
 *
 * BEST-EFFORT (come gli altri poller): NON fa MAI crashare il worker — ogni
 * progetto è in try/catch isolato, l'intero tick a sua volta. Un run dell'agente
 * che lancia/va in errore per un autore lascia solo `aiSummary = null` per
 * quell'autore: i dati grezzi (conteggi, commit) si persistono comunque. Nessun
 * resume sul limite del provider (MVP): un limite = aiSummary null, si riprova il
 * giorno dopo. Gira nella CATENA PER-PROGETTO (serializer condiviso col fix, la
 * doc-generation e la review) per non sovrapporsi al `fetch --prune` del mirror
 * dello stesso progetto. Si ferma sull'AbortSignal del worker.
 */

/** Turni massimi del run di riassunto: bastano pochi (nessun tool, solo testo). */
const SUMMARY_MAX_TURNS = 4;

/** Forma attesa delle credenziali git decifrate (mirror di run-review.ts). */
const credentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

/**
 * Giorno UTC precedente a `now`, come finestra half-open [since, until) e stringa
 * `YYYY-MM-DD`. `until` = mezzanotte UTC di oggi (esclusa), `since` = mezzanotte
 * UTC di ieri (inclusa); `date` = il giorno di `since`, la chiave del report.
 */
export function previousUtcDay(now: Date): { since: Date; until: Date; date: string } {
  const untilMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const until = new Date(untilMs);
  const since = new Date(untilMs - 24 * 60 * 60 * 1000);
  const date = since.toISOString().slice(0, 10);
  return { since, until, date };
}

export interface PollDailyReportsDeps {
  db: Db;
  mirrors: Pick<MirrorManager, "getCommitsInRange" | "ensureMirror">;
  runner: AgentRunner;
  /** Chiave AES-256 per decifrare le credenziali git e i segreti dei provider AI. */
  encryptionKey: Buffer;
  /** Catena per-progetto CONDIVISA col fix/doc-generation/review (serializzazione). */
  serializer: ProjectSerializer;
  /** Massimo autori per progetto per cui GENERARE il riassunto AI (gli altri: null). */
  maxAuthorsPerProject: number;
  /** Giorni di retention dei report prima della pulizia. */
  retentionDays: number;
  /** Modello AI del riassunto (omesso = default del CLI). */
  model?: string;
  /** Timeout (ms) di ogni run di riassunto dell'agente. */
  agentTimeoutMs: number;
  /** "adesso" iniettabile nei test. Default new Date(). */
  now?: () => Date;
  /** Risolutore di UN provider AI per id (iniettabile nei test). Default: loadProviderById. */
  loadProviderByIdFn?: typeof loadProviderById;
  /** Caricatore della catena di provider AI (iniettabile nei test). Default: loadProviderChain. */
  loadProviderChainFn?: typeof loadProviderChain;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Accumulatore per-autore mentre si aggregano i commit di TUTTI i repo. */
interface AuthorAgg {
  authorName: string;
  commitCount: number;
  additions: number;
  deletions: number;
  repoIds: Set<string>;
  commits: { sha: string; subject: string; repoId: string }[];
}

/**
 * Risolve il provider AI del progetto: pinned (SOLO quello, niente fallback)
 * oppure chain[0]. Ritorna undefined se non c'è nulla di utilizzabile (pinned
 * non risolvibile o catena vuota) — in quel caso il report si genera comunque coi
 * dati grezzi, solo senza riassunti. A differenza della review qui un provider
 * mancante NON è un fallimento: il report resta valido.
 */
async function resolveProvider(
  deps: PollDailyReportsDeps,
  aiProviderId: string | null,
): Promise<ResolvedProvider | undefined> {
  if (aiProviderId) {
    const loadById = deps.loadProviderByIdFn ?? loadProviderById;
    return (await loadById(deps.db, deps.encryptionKey, aiProviderId)) ?? undefined;
  }
  const loadChain = deps.loadProviderChainFn ?? loadProviderChain;
  const chain = await loadChain(deps.db, deps.encryptionKey);
  return chain[0];
}

/** Prompt del riassunto: elenca i commit del giorno (subject + numstat) e chiede
 * 2-4 righe in italiano su cosa ha fatto l'autore. Read-only, nessun codice. */
function buildSummaryPrompt(agg: AuthorAgg, date: string): string {
  const lines = agg.commits
    .map((c) => `- ${c.subject}`)
    .join("\n");
  return [
    `Sei un assistente che redige lo standup giornaliero di un team di sviluppo.`,
    `Autore: ${agg.authorName || "(sconosciuto)"}. Giorno: ${date}.`,
    `Ha fatto ${agg.commitCount} commit (+${agg.additions}/-${agg.deletions} righe) su ${agg.repoIds.size} repository.`,
    `Messaggi dei commit:`,
    lines,
    ``,
    `Scrivi in ITALIANO un riassunto di 2-4 righe di cosa ha fatto questo autore nella giornata,`,
    `in linguaggio naturale e sintetico, senza elenchi puntati e senza ripetere gli sha.`,
    `Rispondi SOLO con il riassunto, senza preamboli.`,
  ].join("\n");
}

/**
 * Genera UN report per un progetto (dentro il serializer). Ritorna true se ha
 * prodotto un report `done`, false se ha saltato (report del giorno già presente)
 * o fallito. Best-effort: non lancia mai verso il chiamante.
 */
async function generateForProject(
  deps: PollDailyReportsDeps,
  projectRow: { id: string; aiProviderId: string | null },
  since: Date,
  until: Date,
  date: string,
  now: Date,
): Promise<boolean> {
  const { db } = deps;

  // (a) Idempotenza: crea la riga running SOLO se non esiste già per (progetto,
  // giorno). Conflitto → report già in corso/fatto oggi: SKIP silenzioso.
  let reportId: string;
  try {
    const inserted = await db
      .insert(activityReports)
      .values({ projectId: projectRow.id, date, status: "running" })
      .onConflictDoNothing({
        target: [activityReports.projectId, activityReports.date],
      })
      .returning({ id: activityReports.id });
    if (inserted.length === 0) return false; // già presente per questo giorno.
    reportId = inserted[0]!.id;
  } catch (err) {
    console.error(
      `[stubwise-worker] daily-report: creazione della riga per il progetto ${projectRow.id} (${date}) fallita: ${errText(err)}`,
    );
    return false;
  }

  try {
    // (b) Repo del progetto + account git per le credenziali.
    const repoRows = await db
      .select({ repository: repositories, account: gitAccounts })
      .from(repositories)
      .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
      .where(eq(repositories.projectId, projectRow.id));

    // (c) Commit del giorno di OGNI repo → (d) aggregazione per email autore.
    const byEmail = new Map<string, AuthorAgg>();
    const mirrorProjects: MirrorProject[] = [];
    for (const { repository, account } of repoRows) {
      let credentials: z.infer<typeof credentialsSchema>;
      try {
        credentials = credentialsSchema.parse(
          JSON.parse(decrypt(account.encryptedCredentials, deps.encryptionKey)),
        );
      } catch {
        console.error(
          `[stubwise-worker] daily-report: credenziali git del repository ${repository.id} non decifrabili, salto il repo`,
        );
        continue;
      }
      const mirrorProject: MirrorProject = {
        provider: repository.provider,
        repoUrl: repository.repoUrl,
        defaultBranch: repository.defaultBranch,
        credentials,
      };
      mirrorProjects.push(mirrorProject);

      let commits: RangeCommit[];
      try {
        commits = await deps.mirrors.getCommitsInRange(mirrorProject, since, until);
      } catch (err) {
        // Un repo irraggiungibile non azzera il report: si aggregano gli altri.
        console.error(
          `[stubwise-worker] daily-report: git log del repository ${repository.id} fallito (${errText(err)}), salto il repo`,
        );
        continue;
      }
      for (const c of commits) {
        if (c.isMerge) continue; // i merge non sono lavoro di un autore.
        const email = c.authorEmail.toLowerCase();
        let agg = byEmail.get(email);
        if (!agg) {
          agg = {
            authorName: "",
            commitCount: 0,
            additions: 0,
            deletions: 0,
            repoIds: new Set<string>(),
            commits: [],
          };
          byEmail.set(email, agg);
        }
        if (c.authorName) agg.authorName = c.authorName; // ultimo non vuoto visto.
        agg.commitCount++;
        agg.additions += c.additions;
        agg.deletions += c.deletions;
        agg.repoIds.add(repository.id);
        agg.commits.push({ sha: c.sha, subject: c.subject, repoId: repository.id });
      }
    }

    // (d) git_authors_seen: registra/aggiorna ogni autore osservato oggi.
    for (const [email, agg] of byEmail) {
      try {
        await db
          .insert(gitAuthorsSeen)
          .values({ email, authorName: agg.authorName || null, firstSeenAt: now, lastSeenAt: now })
          .onConflictDoUpdate({
            target: gitAuthorsSeen.email,
            set: { lastSeenAt: now, authorName: agg.authorName || null },
          });
      } catch (err) {
        console.error(
          `[stubwise-worker] daily-report: upsert di git_authors_seen per un autore fallito (${errText(err)})`,
        );
      }
    }

    // (e) Riassunto AI per autore, ordinati per commitCount desc: solo i primi
    // maxAuthorsPerProject; gli altri hanno aiSummary=null (nessun run speso).
    const ordered = [...byEmail.entries()].sort((a, b) => b[1].commitCount - a[1].commitCount);
    const provider = await resolveProvider(deps, projectRow.aiProviderId);

    // cwd del run: il riassunto NON richiede il checkout del codice (bastano i
    // subject + numstat già in mano), quindi NON si apre un worktree — sarebbe uno
    // spreco. Basta una directory valida: il mirror bare del primo repo (già
    // garantito da getCommitsInRange). Se non c'è (nessun repo/provider o mirror
    // non montabile) i riassunti si saltano e restano i dati grezzi.
    let cwd: string | undefined;
    if (provider && ordered.length > 0 && mirrorProjects.length > 0) {
      try {
        cwd = await deps.mirrors.ensureMirror(mirrorProjects[0]!);
      } catch (err) {
        console.error(
          `[stubwise-worker] daily-report: mirror per il cwd dei riassunti non montabile (${errText(err)}), procedo senza riassunti`,
        );
      }
    }

    let skippedByCap = 0;
    const entries: (typeof activityReportEntries.$inferInsert)[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const [email, agg] = ordered[i]!;
      let aiSummary: string | null = null;
      if (provider && cwd && i < deps.maxAuthorsPerProject) {
        try {
          const result = await deps.runner.run({
            cwd,
            prompt: buildSummaryPrompt(agg, date),
            ...(deps.model !== undefined ? { model: deps.model } : {}),
            permissionMode: "plan",
            maxTurns: SUMMARY_MAX_TURNS,
            timeoutMs: deps.agentTimeoutMs,
            provider,
          });
          // Run crashato (exit ≠ 0): nessun riassunto inventato da un output
          // parziale. runner.run RISOLVE anche su exit non-zero.
          if (result.exitCode === 0) {
            const out = result.output.trim();
            aiSummary = out.length > 0 ? out : null;
          }
        } catch (err) {
          // Best-effort: un run fallito (timeout, limite, spawn) → summary null.
          console.error(
            `[stubwise-worker] daily-report: riassunto per un autore del progetto ${projectRow.id} fallito (${errText(err)})`,
          );
        }
      } else if (provider && cwd && i >= deps.maxAuthorsPerProject) {
        skippedByCap++;
      }
      entries.push({
        reportId,
        gitEmail: email,
        authorName: agg.authorName || null,
        commitCount: agg.commitCount,
        additions: agg.additions,
        deletions: agg.deletions,
        repoIds: [...agg.repoIds],
        commits: agg.commits,
        aiSummary,
      });
    }
    if (skippedByCap > 0) {
      console.error(
        `[stubwise-worker] daily-report: progetto ${projectRow.id} (${date}): ${skippedByCap} autori oltre il cap di ${deps.maxAuthorsPerProject}, riassunto non generato`,
      );
    }

    // (f) Persisti le entry (una per autore).
    if (entries.length > 0) {
      await db.insert(activityReportEntries).values(entries);
    }

    // (g) Report → done.
    await db
      .update(activityReports)
      .set({ status: "done", finishedAt: now })
      .where(eq(activityReports.id, reportId));
    return true;
  } catch (err) {
    // (h) Errore non recuperabile: chiudi il report failed, MAI propagare.
    console.error(
      `[stubwise-worker] daily-report: report del progetto ${projectRow.id} (${date}) fallito: ${errText(err)}`,
    );
    try {
      await db
        .update(activityReports)
        .set({ status: "failed", error: errText(err), finishedAt: now })
        .where(eq(activityReports.id, reportId));
    } catch {
      // best-effort: se anche la chiusura fallisce non c'è altro da fare.
    }
    return false;
  }
}

/**
 * Esegue UN giro: per ogni progetto con dailyReportEnabled genera (idempotente)
 * il report del giorno UTC precedente, poi applica la retention. Ritorna il
 * numero di report `done` prodotti (utile ai test). Best-effort: non lancia mai.
 */
export async function pollDailyReportsOnce(deps: PollDailyReportsDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const { since, until, date } = previousUtcDay(now);

  let generated = 0;
  try {
    const enabledProjects = await deps.db
      .select({ id: projects.id, aiProviderId: projects.aiProviderId })
      .from(projects)
      .where(eq(projects.dailyReportEnabled, true));

    for (const project of enabledProjects) {
      try {
        const ok = await deps.serializer.run(project.id, () =>
          generateForProject(deps, project, since, until, date, now),
        );
        if (ok) generated++;
      } catch (err) {
        // Best-effort: un progetto fallito non blocca gli altri di questo giro.
        console.error(
          `[stubwise-worker] daily-report: progetto ${project.id} saltato: ${errText(err)}`,
        );
      }
    }
  } catch (err) {
    console.error(`[stubwise-worker] daily-report: selezione dei progetti fallita: ${errText(err)}`);
  }

  // Retention (una volta per tick, fuori dal loop): cancella i report più vecchi
  // di retentionDays. Cutoff = mezzanotte UTC di oggi meno retentionDays, come
  // stringa YYYY-MM-DD confrontata sulla colonna `date`. Best-effort.
  try {
    const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const cutoff = new Date(todayMs - deps.retentionDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    await deps.db.delete(activityReports).where(lt(activityReports.date, cutoff));
  } catch (err) {
    console.error(`[stubwise-worker] daily-report: retention fallita: ${errText(err)}`);
  }

  return generated;
}

export interface StartDailyReportPollerOptions extends PollDailyReportsDeps {
  /** Intervallo di poll in minuti. ≤ 0 = disabilitato (non avvia nulla). */
  intervalMinutes: number;
  signal: AbortSignal;
}

/**
 * Avvia il poller su un proprio setInterval, separato dal loop dei job. Ad ogni
 * tick genera (idempotente) i report del giorno precedente. Lo stop avviene
 * sull'AbortSignal del worker. Ritorna una funzione di stop idempotente.
 * intervalMinutes ≤ 0 = disabilitato.
 */
export function startDailyReportPoller(opts: StartDailyReportPollerOptions): () => void {
  if (opts.intervalMinutes <= 0) {
    return () => {};
  }
  const { intervalMinutes, signal, ...deps } = opts;
  let running = false;

  const tick = async (): Promise<void> => {
    // Evita sovrapposizioni se un giro è più lento dell'intervallo (i run
    // dell'agente per molti autori possono durare minuti).
    if (running) return;
    running = true;
    try {
      await pollDailyReportsOnce(deps);
    } catch (err) {
      // Difesa finale (pollDailyReportsOnce già non lancia): mai propagare.
      console.error(`[stubwise-worker] daily-report: tick fallito: ${errText(err)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMinutes * 60_000);
  // Non tenere vivo il processo solo per il poller.
  if (typeof timer.unref === "function") timer.unref();

  const stop = (): void => clearInterval(timer);
  signal.addEventListener("abort", stop, { once: true });
  return stop;
}
