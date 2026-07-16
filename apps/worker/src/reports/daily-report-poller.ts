import {
  activityCommits,
  activityDayRollups,
  activityDevSummaries,
  activityRecountJobs,
  activityReports,
  decrypt,
  gitAccounts,
  gitAuthorsSeen,
  gitIdentities,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { and, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { AgentRunner, AgentRunResult } from "../agent/runner.js";
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

/** Turni massimi del run del riassunto di progetto: solo testo, nessun tool. */
const PROJECT_SUMMARY_MAX_TURNS = 3;

/** Turni massimi del run del riassunto per-sviluppatore: solo testo, nessun tool. */
const DEV_SUMMARY_MAX_TURNS = 3;

/**
 * Tetto di caratteri sul contenuto aggregato (subject + descrizione) dei commit
 * passato al prompt del RIASSUNTO di progetto. Con centinaia di commit (giorno
 * intenso o backfill manuale) l'elenco completo può eccedere il context del
 * modello o far scadere il timeout: il run fallisce e `summary` resta null
 * proprio quando un resoconto servirebbe di più. Meglio un elenco troncato con
 * marcatore esplicito che nessun riassunto. */
export const SUMMARY_INPUT_MAX_CHARS = 80_000;

/**
 * Testo utile da un run dell'agente: l'output trimmato se il processo è uscito
 * con exit 0 e ha prodotto qualcosa, altrimenti null. `runner.run` RISOLVE anche
 * su exit non-zero (è un risultato, non un errore): un exit ≠ 0 → nessun testo
 * (niente descrizioni da un output parziale). Condiviso dal loop per-commit e
 * dal blocco del riassunto. */
function textFromRun(result: AgentRunResult): string | null {
  if (result.exitCode !== 0) return null;
  const out = result.output.trim();
  return out.length > 0 ? out : null;
}

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

/** Accumula l'elenco "N. subject / descrizione" dei commit finché resta entro il
 * budget SUMMARY_INPUT_MAX_CHARS, poi si ferma e segnala il troncamento con un
 * marcatore esplicito. ORDINE: si mantiene quello originale (cronologico, dal git
 * log) — un resoconto narrativo segue meglio la sequenza reale del lavoro, e il
 * cap è una salvaguardia contro giornate/backfill enormi, non un criterio di
 * "importanza" (non si riordina per dimensione). Almeno UN commit è sempre
 * incluso, anche se da solo eccede il budget, così l'elenco non è mai vuoto.
 * Condiviso dal riassunto di progetto e da quello per-sviluppatore. */
function cappedCommitList(
  commits: { subject: string; description: string | null | undefined }[],
): string {
  const lines: string[] = [];
  let used = 0;
  let included = 0;
  for (const c of commits) {
    const item = `${included + 1}. ${c.subject}${c.description ? `\n   ${c.description.replace(/\n/g, "\n   ")}` : ""}`;
    if (included > 0 && used + item.length > SUMMARY_INPUT_MAX_CHARS) break;
    lines.push(item);
    used += item.length + 1; // +1 per il "\n" del join
    included++;
  }
  const omitted = commits.length - included;
  return (
    lines.join("\n") +
    (omitted > 0 ? `\n\n[elenco troncato per lunghezza: ${omitted} commit non inclusi]` : "")
  );
}

/** Prompt per il riassunto narrativo di un PROGETTO in un giorno, aggregando le
 * descrizioni GIÀ generate dei suoi commit (niente run per-commit qui). Narrativo
 * esteso, markdown, italiano, tecnico (per i dev).
 * PROMPT INJECTION: subject/descrizioni sono input NON FIDATO; contenuto per
 * costruzione (permissionMode "plan", cwd = mirror bare, nessun working tree). */
function buildProjectSummaryPrompt(
  projectName: string | undefined,
  commits: { subject: string; description: string | null | undefined }[],
): string {
  const items = cappedCommitList(commits);
  return [
    `Sei un assistente tecnico che redige il resoconto giornaliero di un progetto software.`,
    projectName ? `Progetto: ${projectName}.` : ``,
    `Di seguito i commit della giornata con la relativa descrizione tecnica:`,
    items,
    ``,
    `Scrivi in ITALIANO un resoconto NARRATIVO ESTESO di cosa è stato fatto sul progetto`,
    `nella giornata: ripercorri il lavoro raggruppando per temi/aree dove sensato, con`,
    `dettaglio tecnico (è per sviluppatori). Usa markdown. Rispondi SOLO col resoconto.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Prompt per il riassunto narrativo di UNO SVILUPPATORE in un giorno, aggregando
 * le descrizioni GIÀ generate dei suoi commit su TUTTI i progetti (cross-progetto,
 * niente run per-commit qui). Narrativo esteso, markdown, italiano, tecnico.
 * PROMPT INJECTION: subject/descrizioni sono input NON FIDATO; contenuto per
 * costruzione (permissionMode "plan", cwd = tmp dir, nessun working tree). */
function buildDevSummaryPrompt(
  commits: { subject: string; description: string | null | undefined }[],
): string {
  const items = cappedCommitList(commits);
  return [
    `Sei un assistente tecnico che redige il resoconto giornaliero di UNO SVILUPPATORE.`,
    `Di seguito i commit di questa persona nella giornata, su vari progetti, con la`,
    `relativa descrizione tecnica:`,
    items,
    ``,
    `Scrivi in ITALIANO un resoconto NARRATIVO ESTESO di cosa ha fatto questa persona`,
    `nella giornata: ripercorri il lavoro raggruppando per temi/aree/progetti dove`,
    `sensato, con dettaglio tecnico (è per sviluppatori). Usa markdown. Rispondi SOLO`,
    `col resoconto.`,
  ].join("\n");
}

/**
 * Genera UN report per un progetto (dentro il serializer). Ritorna true se ha
 * prodotto un report `done`, false se ha saltato (report del giorno già presente)
 * o fallito. Best-effort: non lancia mai verso il chiamante.
 */
async function generateForProject(
  deps: PollDailyReportsDeps,
  projectRow: { id: string; name?: string; aiProviderId: string | null },
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

  // Invalidazione del rollup dev-summary del giorno: si arriva qui solo quando il
  // report è `running` (insert fresco o reclaim di un orfano/queued), cioè lo si
  // sta (ri)generando. (Ri)generare cambia i suoi commit, quindi il riassunto
  // per-SVILUPPATORE del giorno — che li aggrega cross-progetto — diventa stale.
  // Cancellando la riga di gating (activity_day_rollups) e i dev-summary del
  // giorno, la fase di rollup li rifà quando TUTTI i report del giorno tornano
  // `done`. Best-effort: un fallimento qui non deve bloccare la generazione (nel
  // caso peggiore il rollup resta col vecchio contenuto fino al prossimo trigger).
  try {
    await db.delete(activityDayRollups).where(eq(activityDayRollups.date, date));
    await db.delete(activityDevSummaries).where(eq(activityDevSummaries.date, date));
  } catch (err) {
    console.error(
      `[stubwise-worker] daily-report: invalidazione del rollup dev-summary per ${date} fallita (${errText(err)})`,
    );
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
    // Ogni commit porta l'email dell'autore già in lowercase, calcolata UNA volta
    // (serve sia a git_authors_seen sia alla riga persistita).
    const mirrorProjects: MirrorProject[] = [];
    const repoCommits: {
      mirrorProject: MirrorProject;
      repositoryId: string;
      commits: { commit: RangeCommit; emailLower: string }[];
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
      const prepared = nonMerge.map((commit) => ({
        commit,
        emailLower: commit.authorEmail.toLowerCase(),
      }));
      for (const { commit, emailLower } of prepared) {
        // Ultimo nome non vuoto visto per l'email; non regredire a null.
        if (commit.authorName) authorsSeen.set(emailLower, commit.authorName);
        else if (!authorsSeen.has(emailLower)) authorsSeen.set(emailLower, null);
      }
      repoCommits.push({ mirrorProject, repositoryId: repository.id, commits: prepared });
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
    // Osservabilità: senza cap una giornata intensa (o un backfill manuale) può
    // far girare molti run e tenere il serializer del progetto occupato a lungo.
    // Loggare il volume rende visibile una generazione corposa (vs. fix affamati
    // in silenzio). Solo log, nessun limite.
    if (totalCommits > 0) {
      console.error(
        `[stubwise-worker] daily-report: descrizione di ${totalCommits} commit per il progetto ${projectRow.id} (${date})`,
      );
    }
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
      for (const { commit: c, emailLower } of commits) {
        let aiDescription: string | null = null;
        // Descrizione solo se c'è un provider e un cwd valido: altrimenti nemmeno
        // si recupera il diff (git show sprecato) e restano i dati grezzi.
        if (provider && cwd) {
          // Diff best-effort: un getCommitDiff fallito → diff vuoto, si procede
          // (la descrizione verrà saltata, i dati grezzi restano). skipFetch: il
          // mirror è GIÀ montato+fetchato da getCommitsInRange (fase c) e/o
          // ensureMirror per il cwd; gli sha sono immutabili, quindi si legge dal
          // mirror senza rifare un fetch per commit (evita N+1 fetch sul serializer).
          let diff = "";
          try {
            const res = await deps.mirrors.getCommitDiff(mirrorProject, c.sha, { skipFetch: true });
            // Diff troncato (commit enorme oltre MAX_DIFF_CHARS): segnalalo così
            // l'agente sa che il contenuto è parziale e non lo descrive come completo.
            diff = res.truncated ? `${res.diff}\n\n[diff troncato per lunghezza]` : res.diff;
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
              aiDescription = textFromRun(result);
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
          authorEmail: emailLower,
          authorName: c.authorName || null,
          committedAt: new Date(c.date),
          subject: c.subject,
          additions: c.additions,
          deletions: c.deletions,
          aiDescription,
        });
      }
    }

    // (e-bis) RIASSUNTO NARRATIVO DEL PROGETTO: un run agente che aggrega le
    // descrizioni GIÀ generate (in `rows`) in un resoconto della giornata. Non
    // rifà i run per-commit: passa solo subject + aiDescription al prompt.
    // Best-effort come tutto il resto: no provider/cwd, 0 commit o run che
    // lancia/exit≠0 → summary null, il report resta comunque `done`.
    let summary: string | null = null;
    if (provider && cwd && rows.length > 0) {
      try {
        const result = await deps.runner.run({
          cwd,
          prompt: buildProjectSummaryPrompt(
            projectRow.name,
            rows.map((r) => ({ subject: r.subject, description: r.aiDescription })),
          ),
          ...(deps.model !== undefined ? { model: deps.model } : {}),
          permissionMode: "plan",
          maxTurns: PROJECT_SUMMARY_MAX_TURNS,
          timeoutMs: deps.agentTimeoutMs,
          provider,
        });
        // Run crashato (exit ≠ 0): nessun riassunto da un output parziale.
        if (result.exitCode === 0) {
          const out = result.output.trim();
          summary = out.length > 0 ? out : null;
        }
      } catch (err) {
        // Best-effort: un run fallito (timeout, limite, spawn) → summary null.
        console.error(
          `[stubwise-worker] daily-report: riassunto del progetto ${projectRow.id} (${date}) fallito (${errText(err)})`,
        );
      }
    }

    // (f+g) Persisti le righe (una per commit) e chiudi il report → done in UNA
    // transazione: o si vede il report done con TUTTE le sue righe (e il summary),
    // o si resta nel tentativo precedente (nessuno stato intermedio "done senza
    // righe" o "righe senza done").
    await db.transaction(async (tx) => {
      if (rows.length > 0) {
        // Insert singolo: activityCommits ha ~10 colonne, quindi il tetto dei
        // 65_535 parametri per statement di Postgres si tocca solo oltre ~6.5k
        // righe (commit in un giorno). Nessun chunk necessario per un singolo
        // giorno; se un domani i backfill superassero quel volume, spezzare qui.
        await tx.insert(activityCommits).values(rows);
      }
      await tx
        .update(activityReports)
        .set({ status: "done", finishedAt: now, summary })
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
 * FASE DI ROLLUP dei riassunti PER-SVILUPPATORE (cross-progetto), gated per
 * giorno. Per ogni `date` con TUTTI i suoi report `done` e SENZA riga in
 * activity_day_rollups: carica i commit del giorno, li raggruppa per dev (membro
 * risolto via git_identities — unisce le sue N email — oppure email se non
 * associato), per ogni gruppo un run agente sulle descrizioni dei suoi commit
 * (una riga in activity_dev_summaries), infine marca il giorno in
 * activity_day_rollups.
 *
 * NON tocca git: usa le descrizioni GIÀ in DB, quindi NON serve né il serializer
 * per-progetto né un mirror. Il runner richiede comunque un cwd valido: si usa una
 * tmp dir (nessun montaggio/fetch). Best-effort a ogni livello — l'intera fase,
 * ogni giorno e ogni gruppo sono isolati in try/catch: un fallimento lascia il
 * giorno senza (parte del) rollup, ritentato al tick successivo se il rollup NON è
 * stato marcato.
 *
 * PROVIDER MANCANTE: se un giorno HA commit ma non c'è un provider utilizzabile, il
 * rollup NON viene marcato (nessun dev-summary generabile) → si ritenta al tick
 * successivo, quando il provider torna. Un giorno SENZA commit (0 gruppi) viene
 * marcato comunque, senza generare nulla, così non resta "pending" all'infinito.
 */
async function rollupDevSummaries(deps: PollDailyReportsDeps): Promise<void> {
  const { db } = deps;
  try {
    // Giorni con TUTTI i report `done` (group-by + having bool_and) MENO quelli già
    // rollupati. Due query semplici invece di un NOT EXISTS annidato.
    // LIMITAZIONE NOTA: un giorno con anche UN SOLO report non `done` (incluso un
    // `failed` non recuperabile) non entra tra i candidati → non viene mai
    // rollupato e resta `developersSummaryPending`. Recovery: rigenerare/risolvere
    // quel report (portarlo a `done` o rimuoverlo) sblocca il giorno.
    const allDone = await db
      .select({ date: activityReports.date })
      .from(activityReports)
      .groupBy(activityReports.date)
      .having(sql`bool_and(${activityReports.status} = 'done')`);
    const rolled = await db.select({ date: activityDayRollups.date }).from(activityDayRollups);
    const rolledSet = new Set(rolled.map((r) => r.date));
    const candidates = allDone.map((r) => r.date).filter((d) => !rolledSet.has(d));

    for (const date of candidates) {
      try {
        // (a) Tutti i commit del giorno (cross-progetto). Il provider NON dipende dal
        // progetto (il rollup è cross-progetto): si risolve dalla chain globale più
        // sotto, quindi qui non serve l'aiProviderId dei progetti.
        const dayCommits = await db
          .select({
            authorEmail: activityCommits.authorEmail,
            subject: activityCommits.subject,
            aiDescription: activityCommits.aiDescription,
          })
          .from(activityCommits)
          .innerJoin(activityReports, eq(activityCommits.reportId, activityReports.id))
          .where(eq(activityReports.date, date));

        // (b) Mappa email git (lowercase) → membro, per risolvere gli autori.
        const identities = await db
          .select({ email: gitIdentities.email, userId: gitIdentities.userId })
          .from(gitIdentities);
        const emailToUser = new Map(identities.map((i) => [i.email.toLowerCase(), i.userId]));

        // (c) Raggruppa per chiave dev: membro risolto (`user:<id>`, unisce le sue
        // N email) o email non risolta (`email:<lower>`). Ogni gruppo porta i suoi
        // commit cross-progetto (subject + descrizione).
        interface DevGroup {
          userId: string | null;
          gitEmail: string | null;
          commits: { subject: string; description: string | null }[];
        }
        const groups = new Map<string, DevGroup>();
        for (const c of dayCommits) {
          const emailLower = c.authorEmail.toLowerCase();
          const userId = emailToUser.get(emailLower) ?? null;
          const key = userId ? `user:${userId}` : `email:${emailLower}`;
          let group = groups.get(key);
          if (!group) {
            group = { userId, gitEmail: userId ? null : emailLower, commits: [] };
            groups.set(key, group);
          }
          group.commits.push({ subject: c.subject, description: c.aiDescription });
        }
        const groupList = [...groups.values()];

        // (d) Provider: risolto dalla CHAIN GLOBALE (default), NON dal pin di un
        // progetto arbitrario del giorno. Il dev-summary è cross-progetto: un pin
        // rotto (non risolvibile) di un progetto non deve bloccare il rollup finché
        // la chain offre un provider valido. Se ci sono gruppi da riassumere ma la
        // chain è vuota (nessun provider), NON marcare il rollup: si ritenta al tick
        // successivo, quando il provider torna. Un giorno senza gruppi (0 commit)
        // prosegue e viene marcato senza generare nulla.
        const provider = await resolveProvider(deps, null);
        if (!provider && groupList.length > 0) continue;

        // (e) Crash-consistency: se un tick precedente è crashato DOPO alcuni insert
        // in activity_dev_summaries ma PRIMA di marcare activity_day_rollups, il
        // giorno è di nuovo candidato. Carica le chiavi già presenti e salta i
        // gruppi già fatti, così un retry non rilancia i run AI sui dev completati
        // (l'onConflictDoNothing resta come rete di sicurezza a valle).
        const existingSummaries = await db
          .select({
            userId: activityDevSummaries.userId,
            gitEmail: activityDevSummaries.gitEmail,
          })
          .from(activityDevSummaries)
          .where(eq(activityDevSummaries.date, date));
        const doneUserIds = new Set(
          existingSummaries.map((s) => s.userId).filter((v): v is string => v !== null),
        );
        const doneEmails = new Set(
          existingSummaries.map((s) => s.gitEmail).filter((v): v is string => v !== null),
        );

        if (groupList.length > 0) {
          console.error(
            `[stubwise-worker] daily-report: rollup di ${groupList.length} sviluppatori per il giorno ${date}`,
          );
        }

        // (f) Un run per gruppo; cwd = tmp dir (il rollup non tocca git). Best-effort:
        // un run fallito o con exit ≠ 0 → quel dev senza summary (la UI mostrerà un
        // placeholder), gli altri procedono.
        const cwd = tmpdir();
        for (const group of groupList) {
          if (!provider) break; // difensivo: groupList>0 senza provider è già uscito.
          // Salta i gruppi già presenti in DB (retry dopo crash parziale): il loro
          // summary resta quello pre-esistente, niente nuovo run.
          const alreadyDone = group.userId
            ? doneUserIds.has(group.userId)
            : group.gitEmail !== null && doneEmails.has(group.gitEmail);
          if (alreadyDone) continue;
          let summary: string | null = null;
          try {
            const result = await deps.runner.run({
              cwd,
              prompt: buildDevSummaryPrompt(group.commits),
              ...(deps.model !== undefined ? { model: deps.model } : {}),
              permissionMode: "plan",
              maxTurns: DEV_SUMMARY_MAX_TURNS,
              timeoutMs: deps.agentTimeoutMs,
              provider,
            });
            summary = textFromRun(result);
          } catch (err) {
            console.error(
              `[stubwise-worker] daily-report: riassunto dello sviluppatore ${group.userId ?? group.gitEmail} (${date}) fallito (${errText(err)})`,
            );
          }
          if (summary) {
            try {
              await db
                .insert(activityDevSummaries)
                .values({
                  date,
                  userId: group.userId,
                  gitEmail: group.userId ? null : group.gitEmail,
                  summary,
                })
                // Difesa contro doppioni sulle unique parziali (date,userId)/(date,email).
                .onConflictDoNothing();
            } catch (err) {
              console.error(
                `[stubwise-worker] daily-report: insert del dev-summary ${group.userId ?? group.gitEmail} (${date}) fallito (${errText(err)})`,
              );
            }
          }
        }

        // (g) Marca il giorno come rollupato (anche con 0 gruppi) così non resta
        // pending all'infinito. onConflictDoNothing: idempotente sul date PK.
        await db.insert(activityDayRollups).values({ date }).onConflictDoNothing();
      } catch (err) {
        console.error(
          `[stubwise-worker] daily-report: rollup dev-summary del giorno ${date} fallito: ${errText(err)}`,
        );
      }
    }
  } catch (err) {
    console.error(
      `[stubwise-worker] daily-report: fase di rollup dev-summary fallita: ${errText(err)}`,
    );
  }
}

/**
 * Ricontrolla UN progetto (dentro il serializer): ricalcola `stale_commit_count`
 * dei suoi report `done` entro la retention confrontando i commit REALI del mirror
 * (git-only, nessun agente) con gli sha già registrati in `activity_commits`.
 * RICALCOLO PIENO (non incrementale) → idempotente: un report senza commit
 * mancanti torna a 0. Se un repo è irraggiungibile o le credenziali non sono
 * decifrabili, l'errore PROPAGA (lo gestisce il chiamante): meglio non aggiornare
 * nulla che scrivere un conteggio da una vista parziale del git (falserebbe lo
 * stale a 0, nascondendo commit mancanti). Un progetto SENZA report done entro la
 * retention è un no-op.
 */
async function recountProject(
  deps: PollDailyReportsDeps,
  projectId: string,
  since: Date,
  until: Date,
  cutoffDate: string,
): Promise<void> {
  const { db } = deps;

  // (b) Solo i report `done` entro la retention: gli altri stati (queued/running/
  // failed) si stanno generando o sono falliti, non hanno un conteggio stabile da
  // ricontrollare. Nessun report done → niente da fare.
  const doneReports = await db
    .select({ id: activityReports.id, date: activityReports.date })
    .from(activityReports)
    .where(
      and(
        eq(activityReports.projectId, projectId),
        eq(activityReports.status, "done"),
        gte(activityReports.date, cutoffDate),
      ),
    );
  if (doneReports.length === 0) return;

  // (c) Repo del progetto + credenziali. (d) Commit REALI recenti di ogni repo,
  // raggruppati per giorno UTC della committer date, merge esclusi.
  const repoRows = await db
    .select({ repository: repositories, account: gitAccounts })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(eq(repositories.projectId, projectId));

  const expectedByDay = new Map<string, Set<string>>();
  for (const { repository, account } of repoRows) {
    const credentials = credentialsSchema.parse(
      JSON.parse(decrypt(account.encryptedCredentials, deps.encryptionKey)),
    );
    const mirrorProject: MirrorProject = {
      provider: repository.provider,
      repoUrl: repository.repoUrl,
      defaultBranch: repository.defaultBranch,
      credentials,
    };
    // getCommitsInRange fa un fetch del mirror: il recount DEVE vedere i commit
    // nuovi (pushati dopo la generazione). Il serializer per-progetto evita la
    // collisione col `fetch --prune` di un altro job dello stesso progetto.
    const commits = await deps.mirrors.getCommitsInRange(mirrorProject, since, until);
    for (const c of commits) {
      if (c.isMerge) continue; // i merge non sono lavoro: non contano come mancanti.
      const day = new Date(c.date).toISOString().slice(0, 10); // YYYY-MM-DD UTC della committer date.
      let set = expectedByDay.get(day);
      if (!set) {
        set = new Set();
        expectedByDay.set(day, set);
      }
      set.add(c.sha);
    }
  }

  // (e) Sha già registrati per ogni report done → Map<reportId, Set<sha>>.
  const shaByReport = new Map<string, Set<string>>();
  const registered = await db
    .select({ reportId: activityCommits.reportId, sha: activityCommits.sha })
    .from(activityCommits)
    .where(
      inArray(
        activityCommits.reportId,
        doneReports.map((r) => r.id),
      ),
    );
  for (const row of registered) {
    let set = shaByReport.get(row.reportId);
    if (!set) {
      set = new Set();
      shaByReport.set(row.reportId, set);
    }
    set.add(row.sha);
  }

  // (f) Per ogni report done: mancanti = |commit del suo giorno NON in activity_commits|.
  // UPDATE pieno → idempotente (0 se non manca nulla).
  const empty: Set<string> = new Set();
  for (const report of doneReports) {
    const expected = expectedByDay.get(report.date) ?? empty;
    const present = shaByReport.get(report.id) ?? empty;
    let missing = 0;
    for (const sha of expected) if (!present.has(sha)) missing++;
    await db
      .update(activityReports)
      .set({ staleCommitCount: missing })
      .where(eq(activityReports.id, report.id));
  }
}

/**
 * FASE DI RECOUNT (rilevamento commit mancanti). Il webhook accoda in
 * `activity_recount_jobs` (debounce, un pending per progetto) a ogni push su un
 * repo di un progetto con report abilitato. Qui si reclamano i job scaduti e, per
 * ogni progetto, si ricalcola `stale_commit_count` dei suoi report done entro la
 * retention confrontando i commit reali del mirror con quelli già registrati.
 *
 * GIT-ONLY (nessun agente): confronta sha. Best-effort a ogni livello — l'intera
 * fase e ogni progetto sono in try/catch isolati: un progetto in errore (git
 * irraggiungibile, credenziali illeggibili) non blocca gli altri né le altre fasi
 * del tick. Il job è già stato reclamato (DELETE): un fallimento lo perde per
 * questo tick, ma il prossimo push lo riaccoda.
 */
async function recountStaleReports(deps: PollDailyReportsDeps, now: Date): Promise<void> {
  const { db } = deps;

  // (1) CLAIM: rimuove e restituisce in un colpo solo i job scaduti (debounce,
  // pattern di pr_review_jobs / doc_auto_update_jobs). Atomico → niente doppio
  // processing tra tick.
  let claimed: { projectId: string }[];
  try {
    claimed = await db
      .delete(activityRecountJobs)
      .where(lte(activityRecountJobs.notBefore, sql`now()`))
      .returning({ projectId: activityRecountJobs.projectId });
  } catch (err) {
    console.error(`[stubwise-worker] daily-report: claim dei recount job fallito: ${errText(err)}`);
    return;
  }
  if (claimed.length === 0) return; // niente scaduto: no-op.

  // Cutoff della retention (giorno UTC di `now - retentionDays`, mezzanotte UTC).
  // `since` = quel giorno; `until` = domani mezzanotte UTC (per includere oggi).
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = new Date(todayMs - deps.retentionDays * 24 * 60 * 60 * 1000);
  const until = new Date(todayMs + 24 * 60 * 60 * 1000);
  const cutoffDate = since.toISOString().slice(0, 10);

  for (const { projectId } of claimed) {
    try {
      // Serializzato per-progetto (tocca il mirror, come fix/doc/review): evita la
      // collisione col fetch di un altro job dello stesso progetto.
      await deps.serializer.run(projectId, () =>
        recountProject(deps, projectId, since, until, cutoffDate),
      );
    } catch (err) {
      // Best-effort: un progetto in errore non blocca gli altri.
      console.error(
        `[stubwise-worker] daily-report: recount del progetto ${projectId} fallito: ${errText(err)}`,
      );
    }
  }
}

/**
 * Esegue UN giro:
 *  1. GENERAZIONE MANUALE: raccoglie i report accodati (status='queued', creati
 *     dall'endpoint di richiesta manuale su una data scelta) e li genera sulla
 *     LORO data — indipendentemente dal flag `dailyReportEnabled` del progetto
 *     (sono stati richiesti esplicitamente).
 *  1-bis. RECOUNT: reclama i recount job scaduti e ricalcola stale_commit_count
 *     dei report done dei progetti toccati (git-only, best-effort).
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
        name: projects.name,
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
            { id: q.projectId, name: q.name, aiProviderId: q.aiProviderId },
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

  // (1-bis) FASE DI RECOUNT: reclama i recount job scaduti e ricalcola
  // `stale_commit_count` dei report done dei progetti toccati (git-only,
  // best-effort). Fuori dal gate notturno: gira a ogni tick, indipendente dalla
  // generazione.
  await recountStaleReports(deps, now);

  try {
    const enabledProjects = await deps.db
      .select({ id: projects.id, name: projects.name, aiProviderId: projects.aiProviderId })
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

  // (2) FASE DI ROLLUP dev-summary (cross-progetto): dopo che TUTTI i report di un
  // giorno sono `done`, genera i riassunti per-sviluppatore del giorno e lo marca.
  // Best-effort, non tocca git (usa le descrizioni già in DB). Gira dopo il gate
  // notturno (che porta a `done` gli ultimi report del giorno) e prima della
  // retention.
  await rollupDevSummaries(deps);

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
