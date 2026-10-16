import {
  activityCommits,
  activityDayRollups,
  activityDevSummaries,
  activityRecountJobs,
  activityReports,
  commitSummaries,
  decrypt,
  gitAccounts,
  gitAuthorsSeen,
  gitIdentities,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { and, eq, gte, inArray, isNotNull, lt, lte, ne, sql } from "drizzle-orm";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { AgentRunner, AgentRunSession } from "../agent/runner.js";
import { runAgentTextRaw, textFromRun } from "../agent/text.js";
import { dailyReportSession, sessionOption } from "../sessions/owners.js";
import type { CommitWithFiles, MirrorManager, MirrorProject, RangeCommit } from "../git/mirrors.js";
import type { ProjectSerializer } from "../handler.js";
import { summarizeCommit, type CommitSummaryOutcome } from "../nightly/commit-summary.js";
import { isNoise } from "../nightly/noise.js";
import { QuotaWaitLog } from "../providers/quota-wait.js";
import {
  isQuotaWait,
  limitTextOfRun,
  runWithProviders,
  selectProviders,
  type EmptyReason,
  type SelectDeps,
} from "../providers/select.js";

/**
 * DAILY ACTIVITY REPORT poller — lo "standup" giornaliero.
 *
 * Task SEPARATO dal loop dei job (pattern limit-resume / pr-review poller), su un
 * proprio intervallo. È l'UNICO consumatore delle righe `activity_reports`
 * `queued`: le inserisce il giro notturno (`nightly/`, il giorno UTC precedente
 * dei progetti con `dailyReportEnabled`) e la rigenerazione manuale (una data
 * scelta). Il poller non decide più QUALE giorno generare: niente gate
 * notturno qui dentro, e un giorno passato non si rigenera mai da solo. Unica
 * eccezione, i progetti SENZA repository (il giro accoda per repository e non li
 * vede): per loro il poller accoda il report vuoto del giorno precedente.
 *
 * Per ogni riga `queued` legge i commit di QUEL giorno UTC da ogni repo del
 * progetto (getCommitsInRange), esclude i merge, registra gli autori osservati
 * (git_authors_seen) e persiste una riga per commit in activity_commits. La
 * descrizione di un commit è il suo RIASSUNTO (`commit_summaries`): quello già
 * scritto dal giro notturno, oppure uno nuovo scritto ora con `summarizeCommit`
 * (un solo modo di riassumere, `COMMIT_SUMMARY_MODEL`). Il riassunto del
 * progetto e quelli per sviluppatore restano run del report (`DAILY_REPORT_MODEL`).
 *
 * IDEMPOTENZA + RECOVERY: la riga è unica per (project_id, date). Una riga
 * `done` si SALTA; una ≠ `done` è un ORFANO (worker killato tra il 'running' e il
 * 'done', o un tentativo 'failed') e si RECLAIMA in-place. Il poller è un solo
 * processo e i suoi tick non si sovrappongono (guard `running` in
 * startDailyReportPoller), quindi una riga ≠ 'done' vista all'inizio del turno è
 * sempre orfana, mai una viva.
 *
 * BEST-EFFORT (come gli altri poller): NON fa MAI crashare il worker — ogni
 * report è in try/catch isolato, l'intero tick a sua volta. Un riassunto non
 * scritto lascia solo `aiDescription = null` per quel commit: i dati grezzi
 * (sha, autore, subject, numstat) si persistono comunque. Ogni run sceglie
 * l'account (providers/select.ts, classe `background`): un account al limite
 * passa al successivo; NESSUN account disponibile rimette il report `queued`
 * (mai `failed`, mai `done`) con le descrizioni già fatte, e la fase «queued» lo
 * riprende al tick dopo, per qualunque data entro la retention — limite noto
 * accettato (A-9): finché il report del giorno non è `done` il digest di quel
 * giorno aspetta.
 *
 * SERIALIZER: solo il lavoro GIT (fetch del mirror, elenco dei commit, file dei
 * commit da riassumere) gira nella CATENA PER-PROGETTO, per non sovrapporsi al
 * `fetch --prune` del mirror dello stesso progetto; i run dell'agente girano
 * fuori (il diff di un riassunto si legge con `skipFetch`, come nel giro
 * notturno). Uno stesso commit riassunto insieme dal giro e dal poller fa due
 * run e una sola riga (`ON CONFLICT DO NOTHING`): accettato. Si ferma
 * sull'AbortSignal del worker.
 */

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
  mirrors: Pick<
    MirrorManager,
    "getCommitsInRange" | "getCommitRefsInRange" | "getCommitWithFiles" | "getCommitDiff"
  >;
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
  /** Modello AI del riassunto del progetto e per sviluppatore (DAILY_REPORT_MODEL; omesso = default del CLI). */
  model?: string;
  /** Modello del riassunto di un commit (COMMIT_SUMMARY_MODEL): lo stesso del giro notturno. */
  commitSummaryModel: string;
  /** Tetto del diff nel prompt del riassunto di un commit (COMMIT_DIFF_MAX_CHARS). */
  commitDiffMaxChars: number;
  /** Timeout (ms) di ogni run dell'agente del report (riassunti dei commit compresi). */
  agentTimeoutMs: number;
  /** "adesso" iniettabile nei test. Default new Date(). */
  now?: () => Date;
  /** Scelta dell'account (providers/select.ts), la stessa di tutto il worker. */
  select: SelectDeps;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Nessun account AI disponibile (quota) per un run del report: interrompe la
 * generazione, che torna `queued` con le descrizioni già fatte (riusate al
 * reclaim). Non è un fallimento del report.
 */
class DailyReportQuotaWait extends Error {
  constructor(readonly reason: EmptyReason | "all_limited_now") {
    super(`nessun account AI disponibile (${reason})`);
    this.name = "DailyReportQuotaWait";
  }
}

/** Report (e giorni di rollup) in attesa di un account: si logga solo all'ingresso nell'attesa. */
const quotaWaits = new QuotaWaitLog();

/**
 * UN run di solo testo del report, sull'account scelto da providers/select.ts
 * (classe `background`: il report è lavoro di sfondo). Testo utile o null
 * (exit ≠ 0, nessun output, auth storica al limite, motivo di configurazione:
 * best-effort come prima). Nessun account disponibile per quota → lancia
 * {@link DailyReportQuotaWait}.
 */
async function runReportText(
  deps: PollDailyReportsDeps,
  projectId: string | null,
  opts: { cwd: string; prompt: string; maxTurns: number; session?: AgentRunSession },
): Promise<string | null> {
  const run = await runWithProviders(
    deps.select,
    { projectId, workClass: "background" },
    (provider) =>
      runAgentTextRaw(deps.runner, {
        cwd: opts.cwd,
        prompt: opts.prompt,
        ...(deps.model !== undefined ? { model: deps.model } : {}),
        maxTurns: opts.maxTurns,
        timeoutMs: deps.agentTimeoutMs,
        ...(provider !== undefined ? { provider } : {}),
        ...(opts.session !== undefined ? { session: opts.session } : {}),
      }),
    limitTextOfRun,
  );
  if (run.kind === "done") return textFromRun(run.value);
  if (run.kind === "unavailable" && isQuotaWait(run.reason)) throw new DailyReportQuotaWait(run.reason);
  return null;
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

/** Un commit del giorno com'è uscito dalla fase git. */
interface GatheredCommit {
  commit: RangeCommit;
  /** Email dell'autore già in lowercase (git_authors_seen e riga persistita). */
  emailLower: string;
  /** Riassunto già in `commit_summaries`, o null. */
  summary: string | null;
  /** Il commit coi suoi file, solo se va riassunto ora (nessun riassunto né descrizione riusabile, e un account). */
  withFiles: CommitWithFiles | null;
}

/**
 * Fase git del report, DENTRO il serializer del progetto: repository del
 * progetto, commit non-merge del giorno di ognuno (`getCommitsInRange` fa il
 * fetch), riassunti già salvati e, per i commit da riassumere, il dettaglio per
 * file (`getCommitWithFiles` con `skipFetch`: il mirror è appena stato
 * aggiornato). NESSUN cap sul numero di commit. Un repository con credenziali
 * rotte o irraggiungibile si salta, gli altri proseguono.
 */
async function gatherCommits(
  deps: PollDailyReportsDeps,
  projectId: string,
  since: Date,
  until: Date,
  aiEnabled: boolean,
  reusable: Map<string, string>,
): Promise<{
  authorsSeen: Map<string, string | null>;
  repoCommits: { mirrorProject: MirrorProject; repositoryId: string; commits: GatheredCommit[] }[];
}> {
  const { db } = deps;
  const repoRows = await db
    .select({ repository: repositories, account: gitAccounts })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(eq(repositories.projectId, projectId));

  // Autori osservati (email lowercase → ultimo nome non vuoto, o null): serve a
  // git_authors_seen. Un commit basta a "vedere" un autore.
  const authorsSeen = new Map<string, string | null>();
  const repoCommits: { mirrorProject: MirrorProject; repositoryId: string; commits: GatheredCommit[] }[] = [];
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

    // Riassunti già scritti (dal giro notturno o da un report precedente).
    const saved = new Map<string, string>();
    if (nonMerge.length > 0) {
      const found = await db
        .select({ sha: commitSummaries.sha, summary: commitSummaries.summary })
        .from(commitSummaries)
        .where(
          and(
            eq(commitSummaries.repositoryId, repository.id),
            inArray(
              commitSummaries.sha,
              nonMerge.map((c) => c.sha),
            ),
          ),
        );
      for (const row of found) saved.set(row.sha, row.summary);
    }

    const prepared: GatheredCommit[] = [];
    for (const commit of nonMerge) {
      const emailLower = commit.authorEmail.toLowerCase();
      // Ultimo nome non vuoto visto per l'email; non regredire a null.
      if (commit.authorName) authorsSeen.set(emailLower, commit.authorName);
      else if (!authorsSeen.has(emailLower)) authorsSeen.set(emailLower, null);

      const summary = saved.get(commit.sha) ?? null;
      let withFiles: CommitWithFiles | null = null;
      if (aiEnabled && summary === null && !reusable.has(commit.sha)) {
        try {
          withFiles = await deps.mirrors.getCommitWithFiles(mirrorProject, commit.sha, {
            skipFetch: true,
          });
        } catch (err) {
          console.error(
            `[stubwise-worker] daily-report: file del commit ${commit.sha} (repo ${repository.id}) non leggibili (${errText(err)}), riassunto saltato`,
          );
        }
      }
      prepared.push({ commit, emailLower, summary, withFiles });
    }
    repoCommits.push({ mirrorProject, repositoryId: repository.id, commits: prepared });
  }
  return { authorsSeen, repoCommits };
}

/**
 * Riassume UN commit con `summarizeCommit` (lo stesso del giro notturno, sul
 * modello dei riassunti) e ne ritorna il testo salvato, FUORI dal serializer.
 * Nessun account per quota (anche l'auth del container al limite) → lancia
 * {@link DailyReportQuotaWait}; ogni altro esito (configurazione, output non
 * valido, diff illeggibile, errore) → null, best-effort come prima.
 */
async function summarizeForReport(
  deps: PollDailyReportsDeps,
  repo: { repositoryId: string; projectId: string; project: MirrorProject },
  commit: CommitWithFiles,
  sessionOpt: { session?: AgentRunSession },
): Promise<string | null> {
  const log = (m: string): void => console.error(m);
  let outcome: CommitSummaryOutcome;
  try {
    outcome = await summarizeCommit(
      {
        db: deps.db,
        mirrors: deps.mirrors,
        runner: deps.runner,
        select: deps.select,
        model: deps.commitSummaryModel,
        diffMaxChars: deps.commitDiffMaxChars,
        log,
        timeoutMs: deps.agentTimeoutMs,
        ...sessionOpt,
      },
      repo,
      commit,
    );
  } catch (err) {
    log(
      `[stubwise-worker] daily-report: riassunto del commit ${commit.sha} del progetto ${repo.projectId} fallito (${errText(err)})`,
    );
    return null;
  }
  if (outcome.status === "unavailable") {
    if (isQuotaWait(outcome.reason)) throw new DailyReportQuotaWait(outcome.reason);
    log(
      `[stubwise-worker] daily-report: riassunto del commit ${commit.sha} del progetto ${repo.projectId} saltato (${outcome.reason})`,
    );
    return null;
  }
  if (outcome.status === "failed") {
    log(
      `[stubwise-worker] daily-report: riassunto del commit ${commit.sha} del progetto ${repo.projectId} fallito (${outcome.error})`,
    );
    return null;
  }
  const [row] = await deps.db
    .select({ summary: commitSummaries.summary })
    .from(commitSummaries)
    .where(and(eq(commitSummaries.repositoryId, repo.repositoryId), eq(commitSummaries.sha, commit.sha)))
    .limit(1);
  return row?.summary ?? null;
}

/**
 * Genera UN report per un progetto, FUORI dal serializer: solo la fase git
 * ({@link gatherCommits}) ci entra. Ritorna true se ha prodotto un report `done`,
 * false se ha saltato (report del giorno già presente), aspetta un account o è
 * fallito. Best-effort: non lancia mai verso il chiamante.
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
  //    tentativo fallito): il poller è l'unico che genera e i suoi tick non si
  //    sovrappongono, quindi si RECLAIMA in-place — activity_commits parziali
  //    del tentativo precedente cancellate, status→'running', error/finishedAt
  //    azzerati — e si rigenera. Senza questo, una riga 'running' orfana
  //    verrebbe saltata per sempre (giorno perso, spinner UI bloccato).
  // RIGENERAZIONE INCREMENTALE: descrizioni AI già generate riutilizzabili per sha.
  // Popolata SOLO nel ramo reclaim, dalle activity_commits del tentativo
  // precedente. Viene DOPO il riassunto salvato in `commit_summaries` (che vince)
  // e serve ai commit che non ne hanno uno (report di prima dei riassunti, o
  // descritti in un tentativo precedente): un sha presente qui non si riassume.
  const reusable = new Map<string, string>();
  const waitKey = `${projectRow.id}:${date}`;

  // (0) Report del giorno già `done` → skip, senza nemmeno una scelta.
  // (0-bis) Account AI (providers/select.ts, classe `background`), scelto PRIMA
  // del reclaim: un tick a vuoto (nessun account per quota) non tocca le righe
  // salvate, non fa lavoro git e non invalida il rollup — rimette solo il
  // report `queued`. Nessun provider
  // abilitato o configurazione rotta → solo dati grezzi, come prima. Ogni run
  // poi rifà la sua scelta (gli account marcati al limite nel frattempo non si
  // riprovano). Un errore della scelta si rilancia DOPO il claim, così il
  // report si chiude `failed` come ogni errore interno.
  let aiEnabled = false;
  let configReason: string | null = null;
  let selectionError: unknown = null;
  try {
    const [current] = await db
      .select({ status: activityReports.status })
      .from(activityReports)
      .where(and(eq(activityReports.projectId, projectRow.id), eq(activityReports.date, date)));
    if (current?.status === "done") return false;
    try {
      const selection = await (deps.select.selectProvidersFn ?? selectProviders)(deps.select, {
        projectId: projectRow.id,
        workClass: "background",
      });
      if (selection.candidates.length > 0) {
        aiEnabled = true;
      } else if (!selection.legacyAuth) {
        const reason = selection.emptyReason ?? "all_limited";
        if (isQuotaWait(reason)) {
          await db
            .insert(activityReports)
            .values({ projectId: projectRow.id, date, status: "queued" })
            .onConflictDoNothing({ target: [activityReports.projectId, activityReports.date] });
          await db
            .update(activityReports)
            .set({ status: "queued", error: null, finishedAt: null })
            .where(
              and(
                eq(activityReports.projectId, projectRow.id),
                eq(activityReports.date, date),
                ne(activityReports.status, "done"),
              ),
            );
          if (quotaWaits.enter(waitKey)) {
            console.error(
              `[stubwise-worker] daily-report: report del progetto ${projectRow.id} (${date}) in attesa di un account AI (${reason})`,
            );
          }
          return false;
        }
        configReason = reason;
      }
    } catch (err) {
      selectionError = err;
    }
  } catch (err) {
    console.error(
      `[stubwise-worker] daily-report: stato del report del progetto ${projectRow.id} (${date}) non leggibile: ${errText(err)}`,
    );
    return false;
  }

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
      // Orfano/fallito: reclaim inline e rigenera. PRIMA di cancellare, cattura le
      // descrizioni AI già generate (SOLO le non-null: un commit senza descrizione
      // — run fallito la volta prima — va ritentato) per riusarle nel loop.
      const previous = await db
        .select({ sha: activityCommits.sha, aiDescription: activityCommits.aiDescription })
        .from(activityCommits)
        .where(
          and(
            eq(activityCommits.reportId, existing.id),
            isNotNull(activityCommits.aiDescription),
          ),
        );
      for (const row of previous) {
        // il != null è solo per il narrowing TS: la query filtra già isNotNull.
        if (row.aiDescription != null) reusable.set(row.sha, row.aiDescription);
      }
      // Le activity_commits del tentativo precedente NON si cancellano qui: le
      // sostituiscono le transazioni finali (done: tutte; attesa di un
      // account: solo quelle rifatte), così un'attesa a metà non perde mai
      // descrizioni già salvate.
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

  // Righe dei commit (una per commit non-merge), dichiarate fuori dal try: se
  // manca un account a metà, quelle già descritte si salvano col report
  // `queued` e il reclaim le riusa.
  const rows: (typeof activityCommits.$inferInsert)[] = [];
  try {
    if (selectionError !== null) throw selectionError;

    // (b+c) LAVORO GIT, nella CATENA PER-PROGETTO: il `getCommitsInRange` fa il
    // fetch del mirror, e il fetch (`--prune`) dello stesso progetto lo fanno
    // anche fix, generazione Docs, review e giro notturno. Dentro ci stanno
    // solo git e le letture che servono a decidere: i run dell'agente (i
    // riassunti dei commit e quello del progetto) girano FUORI, così un giorno
    // con molti commit da riassumere non tiene fermo il progetto per minuti.
    const gathered = await deps.serializer.run(projectRow.id, () =>
      gatherCommits(deps, projectRow.id, since, until, aiEnabled, reusable),
    );

    // (d) git_authors_seen: registra/aggiorna ogni autore osservato oggi.
    for (const [email, name] of gathered.authorsSeen) {
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

    const toSummarize = gathered.repoCommits.reduce(
      (n, r) => n + r.commits.filter((c) => c.withFiles !== null).length,
      0,
    );
    // Osservabilità: un giorno intenso (o un backfill manuale) può chiedere molti
    // riassunti. Solo log, nessun limite.
    if (toSummarize > 0) {
      console.error(
        `[stubwise-worker] daily-report: riassunto di ${toSummarize} commit per il progetto ${projectRow.id} (${date})`,
      );
    }
    const totalCommits = gathered.repoCommits.reduce((n, r) => n + r.commits.length, 0);
    // Account: deciso in (0-bis), prima del reclaim.
    if (configReason !== null && totalCommits > 0) {
      console.error(
        `[stubwise-worker] daily-report: nessun provider AI utilizzabile per il progetto ${projectRow.id} (${configReason}), report senza descrizioni nuove`,
      );
    }

    // Sessione del report (progetto, giorno): riassunti dei commit e riassunto
    // del progetto ci scrivono dentro. Creata al PRIMO run che parte davvero (un
    // giorno tutto già riassunto, o di solo rumore, non lascia una sessione
    // vuota), una volta sola. Solo col runner in streaming, fail-open.
    let reportSession: Promise<{ session?: AgentRunSession }> | null = null;
    const sessionForRun = () =>
      (reportSession ??= sessionOption(deps.runner, () =>
        dailyReportSession(db, { id: projectRow.id, name: projectRow.name ?? "progetto" }, date),
      ));

    // (e) Una riga per commit non-merge: dati grezzi SEMPRE persistiti. La
    // descrizione è il RIASSUNTO del commit (`commit_summaries`, un solo modo di
    // riassumere: lo stesso del giro notturno). Nell'ordine: il riassunto già
    // salvato (letto anche senza account: costa zero); la descrizione di un
    // tentativo precedente di questo report (reclaim); il riassunto scritto ora
    // da `summarizeCommit` (solo con un account, `aiEnabled`). Un riassunto non
    // scritto (output non valido, diff illeggibile, configurazione) lascia la
    // descrizione null; nessun account per quota rimette il report in coda.
    for (const { mirrorProject, repositoryId, commits } of gathered.repoCommits) {
      for (const { commit: c, emailLower, summary: saved, withFiles } of commits) {
        let aiDescription: string | null = saved ?? reusable.get(c.sha) ?? null;
        if (aiDescription === null && withFiles !== null) {
          aiDescription = await summarizeForReport(
            deps,
            { repositoryId, projectId: projectRow.id, project: mirrorProject },
            withFiles,
            // Un commit di solo rumore ha un riassunto deterministico, senza run:
            // nessuna sessione da aprire per lui.
            withFiles.files.every((f) => isNoise(f.path)) ? {} : await sessionForRun(),
          );
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
    // descrizioni (in `rows`) in un resoconto della giornata, su DAILY_REPORT_MODEL.
    // Best-effort come tutto il resto: nessun account, 0 commit o run che
    // lancia/exit≠0 → summary null, il report resta comunque `done`. cwd: una
    // tmp dir (il prompt contiene già tutto, nessun accesso al codice).
    let summary: string | null = null;
    if (aiEnabled && rows.length > 0) {
      try {
        // Run crashato (exit ≠ 0): nessun riassunto da un output parziale.
        summary = await runReportText(deps, projectRow.id, {
          cwd: tmpdir(),
          prompt: buildProjectSummaryPrompt(
            projectRow.name,
            rows.map((r) => ({ subject: r.subject, description: r.aiDescription })),
          ),
          maxTurns: PROJECT_SUMMARY_MAX_TURNS,
          ...(await sessionForRun()),
        });
      } catch (err) {
        if (err instanceof DailyReportQuotaWait) throw err;
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
      // Le righe del tentativo precedente (riusate per sha dove servivano)
      // lasciano il posto a quelle di questo giro, nella stessa transazione.
      await tx.delete(activityCommits).where(eq(activityCommits.reportId, reportId));
      if (rows.length > 0) {
        // Insert singolo: activityCommits ha ~10 colonne, quindi il tetto dei
        // 65_535 parametri per statement di Postgres si tocca solo oltre ~6.5k
        // righe (commit in un giorno). Nessun chunk necessario per un singolo
        // giorno; se un domani i backfill superassero quel volume, spezzare qui.
        await tx.insert(activityCommits).values(rows);
      }
      // staleCommitCount: 0 — la (ri)generazione legge l'INTERA finestra
      // [since, until) del giorno (getCommitsInRange fresco) e reinserisce tutti i
      // commit, quindi post-generazione i mancanti sono 0 (valore autoritativo). Lo
      // stale è scritto solo dal recount (accodato da un push): senza azzerarlo qui,
      // dopo un "Rigenera" manuale il badge "N commit mancanti" resterebbe visibile
      // finché non arriva un push. Innocuo per la generazione fresca/notturna: era
      // già 0.
      await tx
        .update(activityReports)
        .set({ status: "done", finishedAt: now, summary, staleCommitCount: 0 })
        .where(eq(activityReports.id, reportId));
    });
    quotaWaits.leave(waitKey);
    return true;
  } catch (err) {
    if (err instanceof DailyReportQuotaWait) {
      // Nessun account AI disponibile: il report torna `queued` (mai `failed`,
      // mai `done`) con le righe già descritte, che il reclaim del tick dopo
      // riusa per sha. Una riga di log all'INGRESSO nell'attesa.
      // Solo le righe RIFATTE in questo giro sostituiscono le vecchie dello
      // stesso sha: quelle di commit non ancora raggiunti restano com'erano,
      // con le loro descrizioni.
      try {
        await db.transaction(async (tx) => {
          if (rows.length > 0) {
            await tx.delete(activityCommits).where(
              and(
                eq(activityCommits.reportId, reportId),
                inArray(
                  activityCommits.sha,
                  rows.map((r) => r.sha),
                ),
              ),
            );
            await tx.insert(activityCommits).values(rows);
          }
          await tx
            .update(activityReports)
            .set({ status: "queued", error: null, finishedAt: null })
            .where(eq(activityReports.id, reportId));
        });
      } catch (txErr) {
        console.error(
          `[stubwise-worker] daily-report: report del progetto ${projectRow.id} (${date}) non rimesso in coda: ${errText(txErr)}`,
        );
      }
      if (quotaWaits.enter(waitKey)) {
        console.error(
          `[stubwise-worker] daily-report: report del progetto ${projectRow.id} (${date}) in attesa di un account AI (${err.reason})`,
        );
      }
      return false;
    }
    quotaWaits.leave(waitKey);
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
        // Account: scelta senza progetto (cross-progetto), classe `background`.
        // Nessun provider abilitato, configurazione rotta o nessun account per
        // quota → il giorno NON si marca e si ritenta al tick dopo (come prima
        // senza provider); la quota si logga una volta per attesa.
        if (groupList.length > 0) {
          const selection = await (deps.select.selectProvidersFn ?? selectProviders)(deps.select, {
            projectId: null,
            workClass: "background",
          });
          if (selection.candidates.length === 0) {
            const reason = selection.emptyReason;
            if (reason !== null && isQuotaWait(reason) && quotaWaits.enter(`rollup:${date}`)) {
              console.error(
                `[stubwise-worker] daily-report: rollup del giorno ${date} in attesa di un account AI (${reason})`,
              );
            }
            continue;
          }
        }

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
        let waiting = false;
        for (const group of groupList) {
          // Salta i gruppi già presenti in DB (retry dopo crash parziale): il loro
          // summary resta quello pre-esistente, niente nuovo run.
          const alreadyDone = group.userId
            ? doneUserIds.has(group.userId)
            : group.gitEmail !== null && doneEmails.has(group.gitEmail);
          if (alreadyDone) continue;
          let summary: string | null = null;
          try {
            summary = await runReportText(deps, null, {
              cwd,
              prompt: buildDevSummaryPrompt(group.commits),
              maxTurns: DEV_SUMMARY_MAX_TURNS,
            });
          } catch (err) {
            if (err instanceof DailyReportQuotaWait) {
              // Account finiti a metà: i dev già fatti restano (il retry li
              // salta), il giorno non si marca.
              waiting = true;
              if (quotaWaits.enter(`rollup:${date}`)) {
                console.error(
                  `[stubwise-worker] daily-report: rollup del giorno ${date} in attesa di un account AI (${err.reason})`,
                );
              }
              break;
            }
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

        if (waiting) continue;
        quotaWaits.leave(`rollup:${date}`);
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
    .select({
      id: activityReports.id,
      date: activityReports.date,
      staleCommitCount: activityReports.staleCommitCount,
    })
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
    // getCommitRefsInRange fa un fetch del mirror: il recount DEVE vedere i
    // commit nuovi (pushati dopo la generazione). Il serializer per-progetto
    // evita la collisione col `fetch --prune` di un altro job dello stesso
    // progetto. Variante LEGGERA (senza --numstat): al recount servono solo
    // sha/date/isMerge, non il diff per-commit dell'intera finestra di retention.
    const commits = await deps.mirrors.getCommitRefsInRange(mirrorProject, since, until);
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
  // Calcolo pieno → idempotente (0 se non manca nulla). UPDATE SOLO quando il
  // valore cambia: al recount la stragrande maggioranza dei report resta a 0
  // (nessun commit mancante nuovo), e riscrivere lo stesso conteggio a ogni push
  // produrrebbe scritture morte (WAL/autovacuum) su fino a ~90 report per job.
  const empty: Set<string> = new Set();
  for (const report of doneReports) {
    const expected = expectedByDay.get(report.date) ?? empty;
    const present = shaByReport.get(report.id) ?? empty;
    let missing = 0;
    for (const sha of expected) if (!present.has(sha)) missing++;
    if (missing === report.staleCommitCount) continue; // invariato → niente scrittura.
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
 *  0. RECOVERY degli orfani `running` → `queued`.
 *  0-bis. PROGETTI SENZA REPOSITORY con `dailyReportEnabled`: accoda (se manca)
 *     il report del giorno UTC precedente, che sarà vuoto. Il giro notturno
 *     accoda il daily report per repository e questi non li vedrebbe mai.
 *  1. REPORT ACCODATI (`queued`): li inseriscono il giro notturno (il giorno
 *     precedente dei progetti abilitati) e la rigenerazione manuale (una data
 *     scelta, anche per un progetto disabilitato); si generano sulla LORO data,
 *     entro la retention. Il poller non crea più da sé il giorno precedente dei
 *     progetti con repository: niente gate notturno qui (lo tiene il giro).
 *  1-bis. RECOUNT: reclama i recount job scaduti e ricalcola stale_commit_count
 *     dei report done dei progetti toccati (git-only, best-effort).
 *  2. ROLLUP per sviluppatore.
 *  3. RETENTION.
 * Ritorna il numero di report `done` prodotti (utile ai test). Best-effort: non
 * lancia mai.
 */
export async function pollDailyReportsOnce(deps: PollDailyReportsDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const { date: yesterday } = previousUtcDay(now);

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
  // activity_commits parziali le sostituisce il reclaim in generateForProject).
  // Senza questo, la fase queued (filtra status='queued') non lo ripescherebbe
  // e resterebbe `running` per sempre.
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

  // (0-bis) Progetti abilitati SENZA repository: il loro report (vuoto) del
  // giorno precedente lo accoda il poller, perché il giro notturno accoda per
  // repository. Un report già presente (qualunque stato) non si tocca, e solo
  // il giorno precedente: un giorno passato non si rigenera da solo.
  try {
    const repoless = await deps.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.dailyReportEnabled, true),
          sql`not exists (select 1 from ${repositories} where ${repositories.projectId} = ${projects.id})`,
        ),
      );
    if (repoless.length > 0) {
      await deps.db
        .insert(activityReports)
        .values(repoless.map((p) => ({ projectId: p.id, date: yesterday, status: "queued" as const })))
        .onConflictDoNothing({ target: [activityReports.projectId, activityReports.date] });
    }
  } catch (err) {
    console.error(
      `[stubwise-worker] daily-report: report dei progetti senza repository non accodati: ${errText(err)}`,
    );
  }

  // (1) Report accodati (giro notturno o richiesta manuale): coppie (progetto, data) in stato 'queued'.
  // Il reclaim dentro generateForProject vede la riga 'queued' (≠ 'done') → la
  // porta a 'running' e genera. Ogni coppia è isolata in try/catch; solo la sua
  // fase git passa dal serializer del progetto. L'unique (project_id, date) e il
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
        const ok = await generateForProject(
          deps,
          { id: q.projectId, name: q.name, aiProviderId: q.aiProviderId },
          win.since,
          win.until,
          win.date,
          now,
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
  // best-effort). Gira a ogni tick, indipendente dalla generazione.
  await recountStaleReports(deps, now);

  // (2) FASE DI ROLLUP dev-summary (cross-progetto): dopo che TUTTI i report di un
  // giorno sono `done`, genera i riassunti per-sviluppatore del giorno e lo marca.
  // Best-effort, non tocca git (usa le descrizioni già in DB). Gira dopo la fase
  // queued (che porta a `done` gli ultimi report del giorno) e prima della
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
 * tick genera (idempotente) i report accodati. Lo stop avviene
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
