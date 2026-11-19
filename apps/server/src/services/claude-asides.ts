import { projects, tickets, type Db } from "@stubwise/db";
import type { AgentSessionEvent } from "@stubwise/shared";
import { inArray } from "drizzle-orm";
import { isAllProjects, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";

/** Come lo scrive il worker (`apps/worker/src/claude-chat/aside.ts`): solo id, numeri, date e chiavi. */
interface StoredAside {
  rows?: { projectId?: unknown; count?: unknown; oldest?: { ticketId?: unknown; stalledSince?: unknown; reason?: unknown } }[];
  hypothesis?: { ticketId?: unknown; key?: unknown } | null;
}

/** La riga che legge chi guarda: i codici e lo stato DI ADESSO, solo se vede il progetto. */
export interface AsideRowView {
  projectId: string;
  projectCode: string;
  count: number;
  ticketId: string;
  taskCode: string;
  stalledSince: string;
  reason: string;
  closed: boolean;
}

/**
 * Area 10, F3 (S2, D-3 = a): gli eventi `aside` si ARRICCHISCONO a lettura,
 * per chi guarda (`docs/invariants/claude-actions.md`, «Gli eventi strutturati
 * li scrive il server»). Una riga di un progetto che chi guarda non vede
 * sparisce (R-G5: in una pubblica il lettore non membro non la vede), e
 * l'ipotesi con lei; una task chiusa nel frattempo resta, segnata `closed`. UNA
 * query per i progetti e una per le task, per tutta la pagina.
 */
export async function enrichAsides(db: Db, viewer: Pick<SessionUser, "id" | "instancePermissions">, events: AgentSessionEvent[]): Promise<AgentSessionEvent[]> {
  const asides = events.filter((e) => e.type === "aside");
  if (asides.length === 0) return events;
  const stored = (e: AgentSessionEvent) => e.data as StoredAside;
  const projectIds = new Set<string>();
  const ticketIds = new Set<string>();
  for (const e of asides) {
    for (const r of stored(e).rows ?? []) {
      if (typeof r.projectId === "string") projectIds.add(r.projectId);
      if (typeof r.oldest?.ticketId === "string") ticketIds.add(r.oldest.ticketId);
    }
  }
  const visible = await visibleProjectIds(db, viewer);
  const sees = (id: string) => (isAllProjects(visible) ? true : visible.includes(id));
  const codes = new Map(
    projectIds.size > 0
      ? (await db.select({ id: projects.id, code: projects.code, archivedAt: projects.archivedAt }).from(projects).where(inArray(projects.id, [...projectIds])))
          .filter((p) => p.archivedAt === null && sees(p.id))
          .map((p) => [p.id, p.code])
      : [],
  );
  const taskRows = new Map(
    ticketIds.size > 0
      ? (await db.select({ id: tickets.id, number: tickets.number, status: tickets.status }).from(tickets).where(inArray(tickets.id, [...ticketIds]))).map((t) => [t.id, t])
      : [],
  );
  return events.map((e) => {
    if (e.type !== "aside") return e;
    const data = stored(e);
    const rows: AsideRowView[] = (data.rows ?? []).flatMap((r) => {
      const projectId = typeof r.projectId === "string" ? r.projectId : "";
      const ticketId = typeof r.oldest?.ticketId === "string" ? r.oldest.ticketId : "";
      const code = codes.get(projectId);
      const task = taskRows.get(ticketId);
      if (code === undefined || task === undefined) return [];
      return [
        {
          projectId,
          projectCode: code,
          count: typeof r.count === "number" ? r.count : 0,
          ticketId,
          taskCode: `${code}-${task.number}`,
          stalledSince: typeof r.oldest?.stalledSince === "string" ? r.oldest.stalledSince : "",
          reason: typeof r.oldest?.reason === "string" ? r.oldest.reason : "",
          closed: task.status === "done" || task.status === "closed",
        },
      ];
    });
    const h = data.hypothesis;
    const hRow = h && typeof h.ticketId === "string" ? rows.find((r) => r.ticketId === h.ticketId) : undefined;
    return {
      ...e,
      data: { rows, hypothesis: hRow && h?.key === "out_of_plan" ? { ticketId: hRow.ticketId, taskCode: hRow.taskCode, key: "out_of_plan" } : null },
    };
  });
}
