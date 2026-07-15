import { asc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { activityCommits, activityReports, gitIdentities, projects, users } from "@stubwise/db";
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
});

/** Membro Stubwise nella forma esposta come `resolvedUser`. */
type ResolvedUser = { id: string; email: string; avatarUrl: string | null };

/** Riferimento a progetto ripetuto nelle due viste. */
type ProjectRef = { id: string; name: string; slug: string };

/** Data calendario UTC (YYYY-MM-DD): stesso formato del campo `date` del report. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
      if (!DATE_RE.test(date)) {
        return apiError(reply, 400, "invalid_date", "date must be in YYYY-MM-DD format");
      }
      // Il formato è corretto ma potrebbe essere una data impossibile (es.
      // 2026-13-40, 2026-02-30): la colonna Postgres `date` la rifiuterebbe →
      // 500. Verifichiamo che sia una data di calendario REALE ricostruendola.
      const parsed = new Date(`${date}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        return apiError(reply, 400, "invalid_date", "Invalid date");
      }

      // 1) Report del giorno + progetto (join). Ordine stabile per nome progetto.
      const reportRows = await app.db
        .select({
          reportId: activityReports.id,
          status: activityReports.status,
          projectId: projects.id,
          projectName: projects.name,
          projectSlug: projects.slug,
        })
        .from(activityReports)
        .innerJoin(projects, eq(activityReports.projectId, projects.id))
        .where(eq(activityReports.date, date))
        .orderBy(asc(projects.name));

      if (reportRows.length === 0) {
        return reply.code(200).send({ date, projects: [], developers: [] });
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
      const identityRows = await app.db
        .select({
          email: gitIdentities.email,
          id: users.id,
          userEmail: users.email,
          avatarUrl: users.slackAvatarUrl,
        })
        .from(gitIdentities)
        .innerJoin(users, eq(gitIdentities.userId, users.id));
      const userByEmail = new Map<string, ResolvedUser>();
      for (const row of identityRows) {
        userByEmail.set(row.email.toLowerCase(), {
          id: row.id,
          email: row.userEmail,
          avatarUrl: row.avatarUrl,
        });
      }

      const resolve = (gitEmail: string): ResolvedUser | null =>
        userByEmail.get(gitEmail.toLowerCase()) ?? null;

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
          commits: commits.map((c) => ({
            sha: c.sha,
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
        .sort((a, b) => b.header.commitCount - a.header.commitCount);

      return reply.code(200).send({ date, projects: projectViews, developers: developerViews });
    },
  );

  // Accoda la generazione manuale dei report per una data: inserisce un
  // `activity_reports` in stato `queued` per OGNI progetto con
  // `dailyReportEnabled=true`. Il worker (poller) raccoglie i `queued` e li
  // genera. Solo admin: accoda lavoro che consuma run AI. `queued` nella
  // risposta = quanti report NUOVI sono stati accodati; i giorni già presenti
  // (generati o già in coda) non vengono toccati né duplicati grazie
  // all'onConflictDoNothing sull'unique (project_id, date).
  app.post(
    "/generate",
    {
      preHandler: requireAdmin,
      schema: {
        body: z.object({ date: z.string() }),
        response: { 200: z.object({ queued: z.number() }), 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { date } = request.body;
      // Stessa validazione di GET: formato + data di calendario REALE (evita
      // che la colonna Postgres `date` rifiuti es. 2026-13-40 → 500).
      if (!DATE_RE.test(date)) {
        return apiError(reply, 400, "invalid_date", "date must be in YYYY-MM-DD format");
      }
      const parsed = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        return apiError(reply, 400, "invalid_date", "Invalid date");
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

      const rows = enabled.map((p) => ({ projectId: p.id, date, status: "queued" as const }));
      const inserted = await app.db
        .insert(activityReports)
        .values(rows)
        .onConflictDoNothing({ target: [activityReports.projectId, activityReports.date] })
        .returning({ id: activityReports.id });

      return reply.code(200).send({ queued: inserted.length });
    },
  );
}
