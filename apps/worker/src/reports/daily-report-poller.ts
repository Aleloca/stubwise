import {
  activityCommits,
  activityReports,
  decrypt,
  gitAccounts,
  gitAuthorsSeen,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";
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
 * suo repo (getCommitsInRange, Task 2), esclude i merge, registra gli autori
 * osservati (git_authors_seen), genera per OGNI commit una descrizione tecnica
 * AI (dal suo diff) e persiste una riga per commit in activity_reports +
 * activity_commits.
 *
 * IDEMPOTENZA + RECOVERY: la creazione della riga activity_reports usa
 * `.onConflictDoNothing()` sull'unique (project_id, date). Il primo tick del
 * giorno la crea; sul conflitto si guarda lo stato della riga esistente: se
 * `done` si SALTA (nessun doppione né un secondo giro di run), altrimenti la
 * riga è un ORFANO (worker killato tra l'insert 'running' e il 'done', o un
 * tentativo 'failed'): la si RECLAIMA in-place (activity_commits parziali
 * cancellate, status→'running') e si rigenera. Il serializer per-progetto garantisce che
 * non esistano DUE generazioni concorrenti dello stesso progetto, quindi una
 * riga ≠ 'done' vista all'inizio del turno è sempre orfana, mai una viva. Il
 * gate "un giorno per volta" emerge da qui, non da un timer preciso a
 * mezzanotte: il poller può girare ogni N minuti e resta corretto.
 *
 * BEST-EFFORT (come gli altri poller): NON fa MAI crashare il worker — ogni
 * progetto è in try/catch isolato, l'intero tick a sua volta. Un run dell'agente
 * che lancia/va in errore per un commit lascia solo `aiDescription = null` per
 * quel commit: i dati grezzi (sha, autore, subject, numstat) si persistono
 * comunque. Nessun resume sul limite del provider (MVP): un limite =
 * aiDescription null, si riprova il giorno dopo. Gira nella CATENA PER-PROGETTO
 * (serializer condiviso col fix, la doc-generation e la review) per non
 * sovrapporsi al `fetch --prune` del mirror dello stesso progetto. Si ferma
 * sull'AbortSignal del worker.
 */

/** Turni massimi del run di descrizione: bastano pochi (nessun tool, solo testo). */
const COMMIT_DESC_MAX_TURNS = 3;

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

/** Finestra half-open [since, until) del giorno UTC `dateStr` (YYYY-MM-DD).
 * Usata dalla generazione MANUALE (report accodati 'queued' su una data scelta):
 * a differenza di `previousUtcDay`, la data è arbitraria e non derivata da now. */
export function utcDayWindow(dateStr: string): { since: Date; until: Date; date: string } {
  const since = new Date(`${dateStr}T00:00:00.000Z`);
  const until = new Date(since.getTime() + 24 * 60 * 60 * 1000);
  return { since, until, date: dateStr };
}

export interface PollDailyReportsDeps {
  db: Db;
  mirrors: Pick<MirrorManager, "getCommitsInRange" | "ensureMirror" | "getCommitDiff">;
  runner: AgentRunner;
  /** Chiave AES-256 per decifrare le credenziali git e i segreti dei provider AI. */
  encryptionKey: Buffer;
  /** Catena per-progetto CONDIVISA col fix/doc-generation/review (serializzazione). */
  serializer: ProjectSerializer;
  /**
   * @deprecated Non più usato dal modello PER-COMMIT: ora si genera una
   * descrizione per OGNI commit non-merge, senza cap per-autore. Il campo (e la
   * env `DAILY_REPORT_MAX_AUTHORS_PER_PROJECT`) restano per non rompere la config
   * esistente, ma il poller non li legge più.
   */
  maxAuthorsPerProject: number;
  /** Giorni di retention dei report prima della pulizia. */
  retentionDays: number;
  /** Modello AI della descrizione (omesso = default del CLI). */
  model?: string;
  /** Timeout (ms) di ogni run di descrizione dell'agente. */
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

/** Prompt per la descrizione tecnica di UN commit, dal suo diff. Dettaglio
 * ADATTIVO: commit piccolo → 1 frase; commit grosso → paragrafo (file/funzioni,
 * approccio, effetti). Output markdown, tecnico (per i dev).
 * PROMPT INJECTION: subject e diff sono input NON FIDATO (chi pusha controlla il
 * contenuto). Contenuto per costruzione: permissionMode "plan" (read-only) e cwd
 * = mirror BARE (nessun working tree). Caso peggiore: descrizione fuorviante
 * salvata, non un'azione. */
function buildCommitDescriptionPrompt(commit: RangeCommit, diff: string): string {
  return [
    `Sei un assistente tecnico che documenta i commit di un team di sviluppo per uno standup.`,
    `Commit: ${commit.subject}`,
    `Modifiche: +${commit.additions}/-${commit.deletions} righe.`,
    ``,
    `Diff del commit:`,
    "```diff",
    diff,
    "```",
    ``,
    `Scrivi in ITALIANO una descrizione TECNICA di cosa fa questo commit, adattando la lunghezza`,
    `all'ampiezza del cambiamento: per un commit piccolo basta UNA frase; per un commit corposo`,
    `scrivi un breve paragrafo che indichi i file/componenti toccati, l'approccio e gli effetti.`,
    `Vai pure sul tecnico (è per sviluppatori). Usa markdown se utile (es. \`nomi\` di codice).`,
    `Rispondi SOLO con la descrizione, senza preamboli né lo sha.`,
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

  // (a) Claim idempotente con recovery degli orfani. Prova a creare la riga
  // running per (progetto, giorno). Se il conflitto scatta la riga esiste già:
  //  - status 'done' → report del giorno già completato: SKIP silenzioso;
  //  - status 'running'/'failed' → ORFANO (worker killato prima del 'done', o
  //    tentativo fallito): il serializer per-progetto esclude una generazione
  //    viva concorrente, quindi si RECLAIMA in-place — activity_commits parziali
  //    del tentativo precedente cancellate, status→'running', error/finishedAt
  //    azzerati — e si rigenera. Senza questo, una riga 'running' orfana
  //    verrebbe saltata per sempre (giorno perso, spinner UI bloccato).
  let reportId: string;
  try {
    const inserted = await db
      .insert(activityReports)
      .values({ projectId: projectRow.id, date, status: "running" })
      .onConflictDoNothing({
        target: [activityReports.projectId, activityReports.date],
      })
      .returning({ id: activityReports.id });
    if (inserted.length > 0) {
      reportId = inserted[0]!.id;
    } else {
      const [existing] = await db
        .select({ id: activityReports.id, status: activityReports.status })
        .from(activityReports)
        .where(
          and(
            eq(activityReports.projectId, projectRow.id),
            eq(activityReports.date, date),
          ),
        );
      if (!existing || existing.status === "done") return false; // già completato.
      // Orfano/fallito: reclaim inline e rigenera. Cancella le activity_commits
      // parziali del tentativo precedente (una riga per commit).
      await db
        .delete(activityCommits)
        .where(eq(activityCommits.reportId, existing.id));
      await db
        .update(activityReports)
        .set({ status: "running", error: null, finishedAt: null })
        .where(eq(activityReports.id, existing.id));
      reportId = existing.id;
    }
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

    // (c) Commit NON-MERGE del giorno di OGNI repo, raccolti con il loro repo (per
    // poterne recuperare il diff dal mirror corretto). NESSUN cap sul numero.
    const mirrorProjects: MirrorProject[] = [];
    const repoCommits: {
      mirrorProject: MirrorProject;
      repositoryId: string;
      commits: RangeCommit[];
    }[] = [];
    // Autori osservati (email lowercase → ultimo nome non vuoto, o null): serve a
    // git_authors_seen. Un commit basta a "vedere" un autore.
    const authorsSeen = new Map<string, string | null>();
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
        // Un repo irraggiungibile non azzera il report: si processano gli altri.
        console.error(
          `[stubwise-worker] daily-report: git log del repository ${repository.id} fallito (${errText(err)}), salto il repo`,
        );
        continue;
      }
      const nonMerge = commits.filter((c) => !c.isMerge); // i merge non sono lavoro.
      for (const c of nonMerge) {
        const email = c.authorEmail.toLowerCase();
        // Ultimo nome non vuoto visto per l'email; non regredire a null.
        if (c.authorName) authorsSeen.set(email, c.authorName);
        else if (!authorsSeen.has(email)) authorsSeen.set(email, null);
      }
      repoCommits.push({ mirrorProject, repositoryId: repository.id, commits: nonMerge });
    }

    // (d) git_authors_seen: registra/aggiorna ogni autore osservato oggi.
    for (const [email, name] of authorsSeen) {
      try {
        await db
          .insert(gitAuthorsSeen)
          .values({ email, authorName: name, firstSeenAt: now, lastSeenAt: now })
          .onConflictDoUpdate({
            target: gitAuthorsSeen.email,
            // Non regredire il nome a null: se questo giro non ha un nome per
            // l'autore, tieni quello già registrato.
            set: {
              lastSeenAt: now,
              authorName: sql`coalesce(${name}, ${gitAuthorsSeen.authorName})`,
            },
          });
      } catch (err) {
        console.error(
          `[stubwise-worker] daily-report: upsert di git_authors_seen per un autore fallito (${errText(err)})`,
        );
      }
    }

    // (e) Provider AI + cwd del run. La descrizione NON richiede il checkout del
    // codice (il diff è già inline nel prompt), quindi NON si apre un worktree:
    // basta una directory valida come cwd, il mirror bare del primo repo. Se non
    // c'è provider o il mirror non è montabile, le descrizioni si saltano e
    // restano i dati grezzi (aiDescription null per tutti i commit).
    const totalCommits = repoCommits.reduce((n, r) => n + r.commits.length, 0);
    const provider = await resolveProvider(deps, projectRow.aiProviderId);
    let cwd: string | undefined;
    if (provider && totalCommits > 0 && mirrorProjects.length > 0) {
      try {
        cwd = await deps.mirrors.ensureMirror(mirrorProjects[0]!);
      } catch (err) {
        console.error(
          `[stubwise-worker] daily-report: mirror per il cwd delle descrizioni non montabile (${errText(err)}), procedo senza descrizioni`,
        );
      }
    }

    // NOTA sul serializer: l'intera generazione — inclusa questa fase AI, la più
    // lenta (un run dell'agente per COMMIT, potenzialmente minuti in totale) —
    // gira DENTRO il serializer per-progetto e blocca gli altri job dello STESSO
    // progetto per tutta la durata. È un solo report al giorno e gli altri
    // progetti procedono in parallelo (serializer per-progetto, non globale):
    // trade-off accettato per non ragionare sulla concorrenza col `fetch --prune`
    // del mirror (stessa invariante di fix/doc-generation/review).
    //
    // Una riga per commit non-merge: dati grezzi SEMPRE persistiti, aiDescription
    // best-effort (diff non recuperabile o run fallito → null).
    const rows: (typeof activityCommits.$inferInsert)[] = [];
    for (const { mirrorProject, repositoryId, commits } of repoCommits) {
      for (const c of commits) {
        let aiDescription: string | null = null;
        // Descrizione solo se c'è un provider e un cwd valido: altrimenti nemmeno
        // si recupera il diff (git show sprecato) e restano i dati grezzi.
        if (provider && cwd) {
          // Diff best-effort: un getCommitDiff fallito → diff vuoto, si procede
          // (la descrizione verrà saltata, i dati grezzi restano).
          let diff = "";
          try {
            ({ diff } = await deps.mirrors.getCommitDiff(mirrorProject, c.sha));
          } catch (err) {
            console.error(
              `[stubwise-worker] daily-report: diff del commit ${c.sha} (repo ${repositoryId}) non recuperabile (${errText(err)}), descrizione saltata`,
            );
          }
          if (diff.length > 0) {
            try {
              const result = await deps.runner.run({
                cwd,
                prompt: buildCommitDescriptionPrompt(c, diff),
                ...(deps.model !== undefined ? { model: deps.model } : {}),
                permissionMode: "plan",
                maxTurns: COMMIT_DESC_MAX_TURNS,
                timeoutMs: deps.agentTimeoutMs,
                provider,
              });
              // Run crashato (exit ≠ 0): nessuna descrizione da un output
              // parziale. runner.run RISOLVE anche su exit non-zero.
              if (result.exitCode === 0) {
                const out = result.output.trim();
                aiDescription = out.length > 0 ? out : null;
              }
            } catch (err) {
              // Best-effort: un run fallito (timeout, limite, spawn) → null.
              console.error(
                `[stubwise-worker] daily-report: descrizione del commit ${c.sha} del progetto ${projectRow.id} fallita (${errText(err)})`,
              );
            }
          }
        }

        rows.push({
          reportId,
          repoId: repositoryId,
          sha: c.sha,
          authorEmail: c.authorEmail.toLowerCase(),
          authorName: c.authorName || null,
          committedAt: new Date(c.date),
          subject: c.subject,
          additions: c.additions,
          deletions: c.deletions,
          aiDescription,
        });
      }
    }

    // (f+g) Persisti le righe (una per commit) e chiudi il report → done in UNA
    // transazione: o si vede il report done con TUTTE le sue righe, o si resta nel
    // tentativo precedente (nessuno stato intermedio "done senza righe" o "righe
    // senza done").
    await db.transaction(async (tx) => {
      if (rows.length > 0) {
        await tx.insert(activityCommits).values(rows);
      }
      await tx
        .update(activityReports)
        .set({ status: "done", finishedAt: now })
        .where(eq(activityReports.id, reportId));
    });
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
 * Esegue UN giro:
 *  1. GENERAZIONE MANUALE: raccoglie i report accodati (status='queued', creati
 *     dall'endpoint di richiesta manuale su una data scelta) e li genera sulla
 *     LORO data — indipendentemente dal flag `dailyReportEnabled` del progetto
 *     (sono stati richiesti esplicitamente).
 *  2. GATE NOTTURNO: per ogni progetto con dailyReportEnabled genera
 *     (idempotente) il report del giorno UTC precedente.
 *  3. RETENTION.
 * Ritorna il numero di report `done` prodotti (queued + notturni, utile ai
 * test). Best-effort: non lancia mai.
 *
 * NIENTE DOPPIA GENERAZIONE nello stesso tick: la fase queued gira PRIMA del gate
 * notturno, quindi se un 'queued' è per ieri e coincide col gate notturno di un
 * progetto abilitato, la fase queued lo porta a 'done' e il gate notturno lo
 * salta (onConflictDoNothing → riga esistente 'done' → skip). Il serializer
 * per-progetto serializza comunque le due fasi dello stesso progetto.
 */
export async function pollDailyReportsOnce(deps: PollDailyReportsDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const { since, until, date } = previousUtcDay(now);

  // Cutoff della retention (giorno UTC di `now - retentionDays`, come stringa
  // YYYY-MM-DD confrontata sulla colonna `date`). Calcolato una volta: serve sia
  // alla fase queued (per NON generare i report oltre la retention) sia al blocco
  // retention in coda al tick.
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = new Date(todayMs - deps.retentionDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  let generated = 0;

  // (0) RECOVERY ORFANI: il poller è single-process e i tick non si
  // sovrappongono (guard `running` in startDailyReportPoller), quindi un report
  // ancora `running` all'inizio del tick è orfano di un worker crashato a metà
  // generazione. Lo rimettiamo `queued` così la fase successiva lo rigenera (le
  // activity_commits parziali vengono ripulite dal reclaim in generateForProject). Senza
  // questo, un manuale orfano su una data arbitraria o un progetto disabilitato
  // — che né la fase queued (filtra status='queued') né il gate notturno (solo
  // ieri + progetto abilitato) ripescano — resterebbe `running` per sempre.
  // Best-effort.
  try {
    await deps.db
      .update(activityReports)
      .set({ status: "queued", error: null, finishedAt: null })
      .where(eq(activityReports.status, "running"));
  } catch (err) {
    console.error(
      `[stubwise-worker] daily-report: recovery degli orfani 'running' fallita: ${errText(err)}`,
    );
  }

  // (1) Report accodati manualmente: coppie (progetto, data) in stato 'queued'.
  // Il reclaim dentro generateForProject vede la riga 'queued' (≠ 'done') → la
  // porta a 'running' e genera. Ogni coppia è isolata in try/catch e
  // serializzata per-progetto come il resto. L'unique (project_id, date) e il
  // join 1:1 a projects rendono le righe già distinte: basta un select normale.
  // Filtro `date >= cutoff`: i queued oltre la retention non vengono generati
  // (spreco di run AI, verrebbero cancellati dalla retention nello stesso tick);
  // il rifiuto esplicito con messaggio all'utente è demandato all'endpoint.
  try {
    const queued = await deps.db
      .select({
        projectId: activityReports.projectId,
        date: activityReports.date,
        aiProviderId: projects.aiProviderId,
      })
      .from(activityReports)
      .innerJoin(projects, eq(activityReports.projectId, projects.id))
      .where(and(eq(activityReports.status, "queued"), gte(activityReports.date, cutoff)));

    for (const q of queued) {
      try {
        const win = utcDayWindow(q.date);
        const ok = await deps.serializer.run(q.projectId, () =>
          generateForProject(
            deps,
            { id: q.projectId, aiProviderId: q.aiProviderId },
            win.since,
            win.until,
            win.date,
            now,
          ),
        );
        if (ok) generated++;
      } catch (err) {
        // Best-effort: un report accodato fallito non blocca gli altri.
        console.error(
          `[stubwise-worker] daily-report: report accodato del progetto ${q.projectId} (${q.date}) saltato: ${errText(err)}`,
        );
      }
    }
  } catch (err) {
    console.error(
      `[stubwise-worker] daily-report: selezione dei report accodati fallita: ${errText(err)}`,
    );
  }

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
  // di retentionDays. `cutoff` è calcolato in testa al tick e condiviso con il
  // filtro della fase queued. Best-effort.
  try {
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
