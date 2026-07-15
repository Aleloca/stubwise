import { asc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { activityReportEntries, activityReports, gitIdentities, projects, users } from "@stubwise/db";
import { requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Lettura dei report di attività (daily standup asincrono) persistiti dal poller
 * notturno. Visibile a TUTTI i membri (requireAuth, non solo admin): è la fonte
 * della sezione SPA "Attività". Per una data restituisce ENTRAMBE le viste sugli
 * stessi `activity_report_entries`:
 *
 *   - `projects`: per-progetto — un elemento per report del giorno, con le sue
 *     entries (una per autore git).
 *   - `developers`: per-dev — le entries di TUTTI i progetti del giorno,
 *     raggruppate per membro risolto (email git → membro via git_identities) o,
 *     se non risolto, per email git grezza. Un membro con più email git è unito
 *     sotto lo stesso resolvedUser.id.
 *
 * Montato sotto /api/activity: il path interno è "/", quindi GET /api/activity.
 * Poche query, nessun N+1: una per i report+project, una per le entries di quei
 * report, una per la mappa email→membro.
 */

const commitSchema = z.object({ sha: z.string(), subject: z.string(), repoId: z.string() });

const resolvedUserSchema = z
  .object({ id: z.uuid(), email: z.string(), avatarUrl: z.string().nullable() })
  .nullable();

const entrySchema = z.object({
  gitEmail: z.string(),
  authorName: z.string().nullable(),
  resolvedUser: resolvedUserSchema,
  commitCount: z.number(),
  additions: z.number(),
  deletions: z.number(),
  commits: z.array(commitSchema),
  aiSummary: z.string().nullable(),
});

const projectViewSchema = z.object({
  project: z.object({ id: z.uuid(), name: z.string(), slug: z.string() }),
  date: z.string(),
  status: z.string(),
  entries: z.array(entrySchema),
});

const developerViewSchema = z.object({
  resolvedUser: resolvedUserSchema,
  gitEmail: z.string().nullable(),
  authorName: z.string().nullable(),
  totalCommits: z.number(),
  totalAdditions: z.number(),
  totalDeletions: z.number(),
  perProject: z.array(
    z.object({
      projectId: z.uuid(),
      projectName: z.string(),
      commitCount: z.number(),
      aiSummary: z.string().nullable(),
      commits: z.array(commitSchema),
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

      // 2) Entries di quei report (una query, no N+1).
      const entryRows = await app.db
        .select()
        .from(activityReportEntries)
        .where(inArray(activityReportEntries.reportId, reportIds));

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

      // Entries raggruppate per report, ordinate per id: ordine deterministico e
      // stabile (gli id sono UUID random, quindi NON cronologico) per un output
      // riproducibile.
      const entriesByReport = new Map<string, typeof entryRows>();
      for (const entry of entryRows) {
        const list = entriesByReport.get(entry.reportId) ?? [];
        list.push(entry);
        entriesByReport.set(entry.reportId, list);
      }
      for (const list of entriesByReport.values()) {
        list.sort((a, b) => a.id.localeCompare(b.id));
      }

      // Vista per-progetto.
      const projectViews = reportRows.map((report) => ({
        project: { id: report.projectId, name: report.projectName, slug: report.projectSlug },
        date,
        status: report.status,
        entries: (entriesByReport.get(report.reportId) ?? []).map((entry) => ({
          gitEmail: entry.gitEmail,
          authorName: entry.authorName,
          resolvedUser: resolve(entry.gitEmail),
          commitCount: entry.commitCount,
          additions: entry.additions,
          deletions: entry.deletions,
          commits: entry.commits,
          aiSummary: entry.aiSummary,
        })),
      }));

      // Vista per-dev: aggrega le entries su TUTTI i progetti del giorno. Chiave
      // di raggruppamento = resolvedUser.id (unisce le più email git dello stesso
      // membro) oppure, se non risolto, `email:<gitEmail lowercase>`.
      const projectNameById = new Map(reportRows.map((r) => [r.projectId, r.projectName]));
      const reportProjectId = new Map(reportRows.map((r) => [r.reportId, r.projectId]));

      type DevAgg = {
        resolvedUser: ResolvedUser | null;
        gitEmail: string | null;
        authorName: string | null;
        totalCommits: number;
        totalAdditions: number;
        totalDeletions: number;
        perProject: {
          projectId: string;
          projectName: string;
          commitCount: number;
          aiSummary: string | null;
          commits: { sha: string; subject: string; repoId: string }[];
        }[];
      };
      const devs = new Map<string, DevAgg>();

      for (const entry of entryRows) {
        const resolved = resolve(entry.gitEmail);
        const key = resolved ? `user:${resolved.id}` : `email:${entry.gitEmail.toLowerCase()}`;
        let dev = devs.get(key);
        if (!dev) {
          dev = {
            resolvedUser: resolved,
            gitEmail: resolved ? null : entry.gitEmail,
            authorName: entry.authorName,
            totalCommits: 0,
            totalAdditions: 0,
            totalDeletions: 0,
            perProject: [],
          };
          devs.set(key, dev);
        }
        dev.totalCommits += entry.commitCount;
        dev.totalAdditions += entry.additions;
        dev.totalDeletions += entry.deletions;
        const projectId = reportProjectId.get(entry.reportId)!;
        // Un dev può avere più email git che committano allo STESSO progetto nel
        // giorno: aggreghiamo per projectId così `perProject` ha una sola riga
        // per progetto (evita header duplicati nella UI).
        const existing = dev.perProject.find((p) => p.projectId === projectId);
        if (existing) {
          existing.commitCount += entry.commitCount;
          existing.commits = existing.commits.concat(entry.commits);
          if (entry.aiSummary) {
            existing.aiSummary =
              existing.aiSummary && existing.aiSummary !== entry.aiSummary
                ? `${existing.aiSummary}\n\n${entry.aiSummary}`
                : entry.aiSummary;
          }
        } else {
          dev.perProject.push({
            projectId,
            projectName: projectNameById.get(projectId) ?? "",
            commitCount: entry.commitCount,
            aiSummary: entry.aiSummary,
            commits: entry.commits,
          });
        }
      }

      const developerViews = [...devs.values()].sort((a, b) => b.totalCommits - a.totalCommits);

      return reply.code(200).send({ date, projects: projectViews, developers: developerViews });
    },
  );
}
