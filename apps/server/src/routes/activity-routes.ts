import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  activityCommits,
  activityDayRollups,
  activityDevSummaries,
  activityReports,
  gitIdentities,
  projects,
  users,
} from "@stubwise/db";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Lettura dei report di attività (daily standup asincrono) persistiti dal poller
 * notturno. Visibile a TUTTI i membri (requireAuth, non solo admin): è la fonte
 * della sezione SPA "Attività". Per una data restituisce ENTRAMBE le viste,
 * aggregando in memoria le righe `activity_commits` (una per commit) del giorno:
 *
 *   - `projects`: per-progetto — un elemento per report del giorno (anche quelli
 *     queued/running SENZA commit: servono a mostrare "in generazione"), con
 *     header di conteggi e la lista dei suoi commit (ognuno con l'autore risolto
 *     a membro).
 *   - `developers`: per-dev — i commit di TUTTI i progetti del giorno,
 *     raggruppati per membro risolto (email git → membro via git_identities) o,
 *     se non risolto, per email git grezza. Un membro con più email git è unito
 *     sotto lo stesso resolvedUser.id. Vuoto durante la generazione (nessun
 *     commit ancora persistito).
 *
 * Montato sotto /api/activity: il path interno è "/", quindi GET /api/activity.
 * Poche query, nessun N+1: una per i report+project, una per i commit di quei
 * report, una per la mappa email→membro.
 *
 * I commit sono ordinati per `committedAt` ASCENDENTE (cronologico) in entrambe
 * le viste.
 */

const resolvedUserSchema = z
  .object({ id: z.uuid(), email: z.string(), avatarUrl: z.string().nullable() })
  .nullable();

const projectSchema = z.object({ id: z.uuid(), name: z.string(), slug: z.string() });

/** Commit nella vista per-progetto: include l'autore (nome + membro risolto). */
const projectCommitSchema = z.object({
  sha: z.string(),
  authorEmail: z.string(),
  authorName: z.string().nullable(),
  resolvedUser: resolvedUserSchema,
  committedAt: z.string(),
  subject: z.string(),
  additions: z.number(),
  deletions: z.number(),
  aiDescription: z.string().nullable(),
});

/** Commit nella vista per-dev: l'autore è implicito (già raggruppato). */
const developerCommitSchema = z.object({
  sha: z.string(),
  committedAt: z.string(),
  subject: z.string(),
  additions: z.number(),
  deletions: z.number(),
  aiDescription: z.string().nullable(),
});

const projectViewSchema = z.object({
  project: projectSchema,
  status: z.string(),
  header: z.object({
    commitCount: z.number(),
    additions: z.number(),
    deletions: z.number(),
    authorCount: z.number(),
  }),
  // Riassunto narrativo del progetto per la giornata (markdown). Null se non
  // ancora generato o se il run di sintesi è fallito.
  summary: z.string().nullable(),
  // Commit del giorno presenti nel repo ma ASSENTI da questo report (pushati
  // dopo la generazione), dal campo `stale_commit_count` del report. > 0 → il
  // report è potenzialmente incompleto: la UI lo segnala e offre "rigenera".
  staleCommitCount: z.number(),
  commits: z.array(projectCommitSchema),
});

const developerViewSchema = z.object({
  resolvedUser: resolvedUserSchema,
  gitEmail: z.string().nullable(),
  authorName: z.string().nullable(),
  header: z.object({
    commitCount: z.number(),
    additions: z.number(),
    deletions: z.number(),
    projectCount: z.number(),
  }),
  // Riassunto narrativo per-sviluppatore della giornata (markdown). Null se il
  // rollup non è ancora avvenuto o non c'è una riga per questo gruppo.
  summary: z.string().nullable(),
  byProject: z.array(
    z.object({
      project: projectSchema,
      commits: z.array(developerCommitSchema),
    }),
  ),
});

const responseSchema = z.object({
  date: z.string(),
  projects: z.array(projectViewSchema),
  developers: z.array(developerViewSchema),
  // True quando i riassunti-per-sviluppatore del giorno sono attesi ma non
  // ancora generati (tutti i report done, ci sono commit, ma manca il rollup):
  // la UI mostra "in generazione". False altrimenti.
  developersSummaryPending: z.boolean(),
  // Somma di `staleCommitCount` su TUTTI i report del giorno: totale dei commit
  // del giorno non ancora inclusi in alcun report. > 0 → banner "N commit non
  // ancora nei report" nella UI. 0 nel giorno senza report.
  staleCommitTotal: z.number(),
});

/** Membro Stubwise nella forma esposta come `resolvedUser`. */
type ResolvedUser = { id: string; email: string; avatarUrl: string | null };

/** Riferimento a progetto ripetuto nelle due viste. */
type ProjectRef = { id: string; name: string; slug: string };

/** Data calendario UTC (YYYY-MM-DD): stesso formato del campo `date` del report. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True se `date` è una data di calendario reale in formato YYYY-MM-DD. Il regex
 * accetta il formato ma non le date impossibili (es. 2026-13-40, 2026-02-30):
 * le ricostruiamo per rifiutarle qui, evitando un 500 dalla colonna Postgres `date`.
 */
function isRealCalendarDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export async function activityRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        querystring: z.object({ date: z.string() }),
        response: { 200: responseSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { date } = request.query;
      if (!isRealCalendarDate(date)) {
        return apiError(reply, 400, "invalid_date", "date must be a real calendar date (YYYY-MM-DD)");
      }

      // 1) Report del giorno + progetto (join). Ordine stabile per nome progetto.
      const reportRows = await app.db
        .select({
          reportId: activityReports.id,
          status: activityReports.status,
          summary: activityReports.summary,
          staleCommitCount: activityReports.staleCommitCount,
          projectId: projects.id,
          projectName: projects.name,
          projectSlug: projects.slug,
        })
        .from(activityReports)
        .innerJoin(projects, eq(activityReports.projectId, projects.id))
        .where(eq(activityReports.date, date))
        .orderBy(asc(projects.name));

      if (reportRows.length === 0) {
        return reply.code(200).send({
          date,
          projects: [],
          developers: [],
          developersSummaryPending: false,
          staleCommitTotal: 0,
        });
      }

      const reportIds = reportRows.map((r) => r.reportId);

      // 2) Commit di quei report (una query, no N+1). Ordinati per committedAt
      // ASC: ordine cronologico stabile in entrambe le viste.
      const commitRows = await app.db
        .select({
          reportId: activityCommits.reportId,
          sha: activityCommits.sha,
          authorEmail: activityCommits.authorEmail,
          authorName: activityCommits.authorName,
          committedAt: activityCommits.committedAt,
          subject: activityCommits.subject,
          additions: activityCommits.additions,
          deletions: activityCommits.deletions,
          aiDescription: activityCommits.aiDescription,
        })
        .from(activityCommits)
        .where(inArray(activityCommits.reportId, reportIds))
        .orderBy(asc(activityCommits.committedAt));

      // 3) Mappa email(lowercase) → membro. Una sola query join git_identities+users.
      // Serve SOLO a risolvere i commit: se non ce ne sono (es. giorno con report
      // queued/running ma senza commit persistiti), saltiamo la query e usiamo una
      // mappa vuota. (Il caso "giorno senza report" ha già short-circuitato sopra.)
      const userByEmail = new Map<string, ResolvedUser>();
      if (commitRows.length > 0) {
        const identityRows = await app.db
          .select({
            email: gitIdentities.email,
            id: users.id,
            userEmail: users.email,
            avatarUrl: users.slackAvatarUrl,
          })
          .from(gitIdentities)
          .innerJoin(users, eq(gitIdentities.userId, users.id));
        for (const row of identityRows) {
          userByEmail.set(row.email.toLowerCase(), {
            id: row.id,
            email: row.userEmail,
            avatarUrl: row.avatarUrl,
          });
        }
      }

      const resolve = (gitEmail: string): ResolvedUser | null =>
        userByEmail.get(gitEmail.toLowerCase()) ?? null;

      // 4) Riassunti-per-sviluppatore del giorno (una query). Due mappe di lookup
      // per il gruppo dev: per membro risolto (userId) o per email git non
      // risolta (lowercase). Esattamente una delle due colonne è valorizzata.
      const summaryByUserId = new Map<string, string>();
      const summaryByEmail = new Map<string, string>();
      const devSummaryRows = await app.db
        .select({
          userId: activityDevSummaries.userId,
          gitEmail: activityDevSummaries.gitEmail,
          summary: activityDevSummaries.summary,
        })
        .from(activityDevSummaries)
        .where(eq(activityDevSummaries.date, date));
      for (const row of devSummaryRows) {
        if (row.userId) summaryByUserId.set(row.userId, row.summary);
        else if (row.gitEmail) summaryByEmail.set(row.gitEmail.toLowerCase(), row.summary);
      }

      // 5) Il rollup dev-summary del giorno è già avvenuto? (una query, limit 1).
      const rollupRows = await app.db
        .select({ date: activityDayRollups.date })
        .from(activityDayRollups)
        .where(eq(activityDayRollups.date, date))
        .limit(1);
      const hasRollup = rollupRows.length > 0;

      // I riassunti-per-dev sono ATTESI ma non ancora generati quando: tutti i
      // report del giorno sono `done`, c'è almeno un commit da riassumere, e il
      // rollup non è ancora stato registrato. (Senza commit non ci sono dev da
      // riassumere → non pending.)
      const allReportsDone = reportRows.every((r) => r.status === "done");
      const developersSummaryPending = allReportsDone && commitRows.length > 0 && !hasRollup;

      // Il progetto di un commit viene dal SUO report (non dal repoId): un report
      // è per (progetto, giorno). Mappe reportId → progetto per l'aggregazione.
      const projectByReport = new Map<string, ProjectRef>(
        reportRows.map((r) => [
          r.reportId,
          { id: r.projectId, name: r.projectName, slug: r.projectSlug },
        ]),
      );

      // Commit raggruppati per report, nell'ordine (già committedAt ASC) di query.
      const commitsByReport = new Map<string, typeof commitRows>();
      for (const commit of commitRows) {
        const list = commitsByReport.get(commit.reportId) ?? [];
        list.push(commit);
        commitsByReport.set(commit.reportId, list);
      }

      // Vista per-progetto: un elemento per report (anche senza commit → header a
      // zero, commits vuoti: la UI mostra lo status "in generazione").
      const projectViews = reportRows.map((report) => {
        const commits = commitsByReport.get(report.reportId) ?? [];
        const authors = new Set(commits.map((c) => c.authorEmail.toLowerCase()));
        return {
          project: { id: report.projectId, name: report.projectName, slug: report.projectSlug },
          status: report.status,
          header: {
            commitCount: commits.length,
            additions: commits.reduce((sum, c) => sum + c.additions, 0),
            deletions: commits.reduce((sum, c) => sum + c.deletions, 0),
            authorCount: authors.size,
          },
          summary: report.summary ?? null,
          staleCommitCount: report.staleCommitCount,
          commits: commits.map((c) => ({
            sha: c.sha,
            authorEmail: c.authorEmail,
            authorName: c.authorName,
            resolvedUser: resolve(c.authorEmail),
            committedAt: c.committedAt.toISOString(),
            subject: c.subject,
            additions: c.additions,
            deletions: c.deletions,
            aiDescription: c.aiDescription,
          })),
        };
      });

      // Vista per-dev: aggrega i commit su TUTTI i progetti del giorno. Chiave di
      // raggruppamento = resolvedUser.id (unisce le più email git dello stesso
      // membro) oppure, se non risolto, `email:<authorEmail lowercase>`.
      type DevAgg = {
        resolvedUser: ResolvedUser | null;
        gitEmail: string | null;
        authorName: string | null;
        commitCount: number;
        additions: number;
        deletions: number;
        byProject: Map<
          string,
          {
            project: ProjectRef;
            commits: {
              sha: string;
              committedAt: string;
              subject: string;
              additions: number;
              deletions: number;
              aiDescription: string | null;
            }[];
          }
        >;
      };
      const devs = new Map<string, DevAgg>();

      for (const commit of commitRows) {
        const project = projectByReport.get(commit.reportId);
        if (!project) continue; // difensivo: ogni commit ha un report nel set.
        const resolved = resolve(commit.authorEmail);
        const key = resolved ? `user:${resolved.id}` : `email:${commit.authorEmail.toLowerCase()}`;
        let dev = devs.get(key);
        if (!dev) {
          dev = {
            resolvedUser: resolved,
            gitEmail: resolved ? null : commit.authorEmail,
            // First-commit-wins: per un membro risolto con più identità git/nomi
            // diversi si mostra il nome del commit cronologicamente più vecchio
            // (i commit sono già in ordine committedAt ASC). Cosmetico: la UI usa
            // resolvedUser quando presente.
            authorName: commit.authorName,
            commitCount: 0,
            additions: 0,
            deletions: 0,
            byProject: new Map(),
          };
          devs.set(key, dev);
        }
        dev.commitCount += 1;
        dev.additions += commit.additions;
        dev.deletions += commit.deletions;
        // Più email git dello stesso membro possono committare allo STESSO
        // progetto: raggruppiamo per project.id così `byProject` ha una sola riga
        // per progetto (niente header duplicati nella UI).
        let bucket = dev.byProject.get(project.id);
        if (!bucket) {
          bucket = { project, commits: [] };
          dev.byProject.set(project.id, bucket);
        }
        bucket.commits.push({
          sha: commit.sha,
          committedAt: commit.committedAt.toISOString(),
          subject: commit.subject,
          additions: commit.additions,
          deletions: commit.deletions,
          aiDescription: commit.aiDescription,
        });
      }

      const developerViews = [...devs.values()]
        .map((dev) => ({
          resolvedUser: dev.resolvedUser,
          gitEmail: dev.gitEmail,
          authorName: dev.authorName,
          // Riassunto del gruppo: per membro risolto lookup per userId, per
          // autore non risolto per email git (lowercase). Null se manca la riga.
          summary: dev.resolvedUser
            ? (summaryByUserId.get(dev.resolvedUser.id) ?? null)
            : (dev.gitEmail ? (summaryByEmail.get(dev.gitEmail.toLowerCase()) ?? null) : null),
          header: {
            commitCount: dev.commitCount,
            additions: dev.additions,
            deletions: dev.deletions,
            projectCount: dev.byProject.size,
          },
          byProject: [...dev.byProject.values()].sort((a, b) =>
            a.project.name.localeCompare(b.project.name),
          ),
        }))
        // Ordine per commitCount DESC; a parità, tie-breaker stabile per email
        // (resolvedUser.email, poi gitEmail) così l'ordine è deterministico.
        .sort((a, b) => {
          if (b.header.commitCount !== a.header.commitCount) {
            return b.header.commitCount - a.header.commitCount;
          }
          const emailA = a.resolvedUser?.email ?? a.gitEmail ?? "";
          const emailB = b.resolvedUser?.email ?? b.gitEmail ?? "";
          return emailA.localeCompare(emailB);
        });

      // Totale dei commit del giorno non ancora inclusi in alcun report: somma
      // dello stale per-report. Alimenta il banner globale nella UI.
      const staleCommitTotal = reportRows.reduce((sum, r) => sum + r.staleCommitCount, 0);

      return reply.code(200).send({
        date,
        projects: projectViews,
        developers: developerViews,
        developersSummaryPending,
        staleCommitTotal,
      });
    },
  );

  // Accoda la generazione manuale dei report per una data: inserisce un
  // `activity_reports` in stato `queued` per OGNI progetto con
  // `dailyReportEnabled=true`. Il worker (poller) raccoglie i `queued` e li
  // genera. Solo admin: accoda lavoro che consuma run AI. `queued` nella
  // risposta = quanti report sono ORA in coda per effetto della chiamata.
  //
  // Senza `force` (default): i giorni già presenti (generati o già in coda) non
  // vengono toccati né duplicati grazie all'onConflictDoNothing sull'unique
  // (project_id, date); `queued` = solo i report NUOVI accodati.
  //
  // Con `force=true`: si RIGENERA anche il già-fatto. I report esistenti in
  // stato `done`/`failed` per (progetto abilitato, date) vengono rimessi
  // `queued` (e il loro `staleCommitCount` azzerato: sono in rigenerazione, un
  // conteggio stale sarebbe fuorviante e la generazione lo ricostruirà); quelli
  // già `queued`/`running` NON si toccano (si stanno già generando). I progetti
  // abilitati senza report vengono comunque accodati. `queued` = report nuovi +
  // report forzati (rimessi in coda).
  app.post(
    "/generate",
    {
      preHandler: requireAdmin,
      schema: {
        body: z.object({ date: z.string(), force: z.boolean().optional().default(false) }),
        response: { 200: z.object({ queued: z.number() }), 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { date, force } = request.body;
      // Stessa validazione di GET: formato + data di calendario REALE (evita
      // che la colonna Postgres `date` rifiuti es. 2026-13-40 → 500).
      if (!isRealCalendarDate(date)) {
        return apiError(reply, 400, "invalid_date", "date must be a real calendar date (YYYY-MM-DD)");
      }
      // Niente report per il futuro: non ci sono ancora commit da riassumere.
      const todayUtc = new Date().toISOString().slice(0, 10);
      if (date > todayUtc) {
        return apiError(
          reply,
          400,
          "date_in_future",
          "Cannot generate a report for a future date",
        );
      }

      const enabled = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.dailyReportEnabled, true));
      if (enabled.length === 0) {
        return reply.code(200).send({ queued: 0 });
      }

      const enabledIds = enabled.map((p) => p.id);

      // Accoda i progetti abilitati SENZA report per (progetto, date): comune a
      // force e non-force. L'onConflictDoNothing lascia intatti quelli già
      // presenti (qualunque stato), evitando doppioni sull'unique.
      const rows = enabledIds.map((id) => ({ projectId: id, date, status: "queued" as const }));
      const inserted = await app.db
        .insert(activityReports)
        .values(rows)
        .onConflictDoNothing({ target: [activityReports.projectId, activityReports.date] })
        .returning({ id: activityReports.id });

      if (!force) {
        return reply.code(200).send({ queued: inserted.length });
      }

      // force: rimetti in coda i report GIÀ generati (done) o falliti (failed) dei
      // progetti abilitati per questo giorno. Non tocca queued/running (già vivi).
      // Azzera lo stale: il report sta per essere rigenerato da zero.
      const forced = await app.db
        .update(activityReports)
        .set({ status: "queued", staleCommitCount: 0 })
        .where(
          and(
            eq(activityReports.date, date),
            inArray(activityReports.projectId, enabledIds),
            inArray(activityReports.status, ["done", "failed"]),
          ),
        )
        .returning({ id: activityReports.id });

      return reply.code(200).send({ queued: inserted.length + forced.length });
    },
  );
}
