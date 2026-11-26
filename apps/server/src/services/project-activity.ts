import { projects, type Db } from "@stubwise/db";
import type { ArchiveCandidates, ProjectPermission } from "@stubwise/shared";
import { and, asc, inArray, isNull, sql } from "drizzle-orm";
import { isAllProjects, projectPermissionsMap, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { busyReasons } from "./project-archive.js";

/**
 * Area 10, F4 (S4): l'ULTIMA ATTIVITÀ di un progetto, come `lastActivityOf`
 * del prototipo (`apps/desktop/src/renderer/data/projectActivity.ts`): la più
 * recente fra la creazione delle task e i loro eventi (le PR aperte, le
 * consegne, i commenti passano da lì), la creazione e le scritture delle
 * richieste, le decisioni del registro, i messaggi del supporto e i rilasci
 * mergiati. UNA query per tutti i progetti; un progetto senza niente vale
 * `null` («mai attivo», più vecchio di ogni limite).
 */
export async function lastActivityByProject(db: Db, projectIds: readonly string[]): Promise<Map<string, Date | null>> {
  if (projectIds.length === 0) return new Map();
  const rows = (await db.execute<{ id: string; at: string | null }>(sql`
    select p.id, greatest(
      (select max(t.created_at) from tickets t where t.project_id = p.id),
      (select max(e.created_at) from ticket_events e join tickets t on t.id = e.ticket_id where t.project_id = p.id),
      (select max(greatest(b.created_at, b.updated_at)) from backlog_items b where b.project_id = p.id),
      (select max(d.decided_at) from project_decisions d where d.project_id = p.id),
      (select max(m.created_at) from widget_messages m join widget_conversations c on c.id = m.conversation_id where c.project_id = p.id),
      (select max(r.merged_at) from releases r where r.project_id = p.id)
    )::text as at
    from projects p
    where p.id in (${sql.join(projectIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `)) as unknown as { id: string; at: string | null }[];
  return new Map(rows.map((r) => [r.id, r.at === null ? null : new Date(r.at)]));
}

/**
 * I progetti da archiviare per CHI CHIEDE (S4, la forma di
 * `ArchiveCandidates` del prototipo): fermi da più di `inactiveDays` giorni,
 * dal più vecchio, poi per codice. Senza `project.settings.manage` vanno in
 * `notManageable` (sono visibili: R-G5 regge); coi motivi `busy` di F6 in
 * `busy`; gli altri sono candidati. I progetti che chi chiede non vede sono
 * fuori dalla WHERE, prima di tutto.
 */
/**
 * Review di F3–F8 (M7): quanti progetti fermi si esaminano (i motivi `busy`
 * costano qualche query per progetto). I più fermi prima; quelli oltre il
 * tetto si contano in `more`, e Claude lo dice.
 */
export const ARCHIVE_CANDIDATES_SCAN_MAX = 50;

export async function archiveCandidates(
  db: Db,
  viewer: Pick<SessionUser, "id" | "email" | "role" | "instancePermissions">,
  inactiveDays: number,
  scanMax = ARCHIVE_CANDIDATES_SCAN_MAX,
): Promise<ArchiveCandidates> {
  const visible = await visibleProjectIds(db, viewer);
  const open = await db
    .select({ id: projects.id, code: projects.code, name: projects.name })
    .from(projects)
    .where(and(isNull(projects.archivedAt), isAllProjects(visible) ? undefined : inArray(projects.id, visible.length > 0 ? [...visible] : ["00000000-0000-0000-0000-000000000000"])))
    .orderBy(asc(projects.code));
  const last = await lastActivityByProject(db, open.map((p) => p.id));
  const limit = Date.now() - inactiveDays * 86_400_000;
  const quiet = open
    .map((p) => ({ ...p, last: last.get(p.id) ?? null }))
    .filter((p) => p.last === null || p.last.getTime() < limit)
    .sort((a, b) => (a.last?.getTime() ?? 0) - (b.last?.getTime() ?? 0) || a.code.localeCompare(b.code));
  const perms = await projectPermissionsMap(db, viewer);
  const out: ArchiveCandidates = { candidates: [], busy: [], notManageable: 0, notManageableCodes: [], more: Math.max(0, quiet.length - scanMax) };
  for (const p of quiet.slice(0, scanMax)) {
    const held = new Set<ProjectPermission>(perms[p.id] ?? []);
    if (!held.has("project.settings.manage")) {
      out.notManageable++;
      out.notManageableCodes.push(p.code);
      continue;
    }
    const reasons = await busyReasons(db, p.id, viewer, held);
    if (reasons.length > 0) {
      out.busy.push({ code: p.code, reasons });
      continue;
    }
    out.candidates.push({ projectId: p.id, code: p.code, name: p.name, lastActivity: p.last?.toISOString() ?? null });
  }
  return out;
}
