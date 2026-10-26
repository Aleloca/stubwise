import { isOverdue, openMilestones } from "../../domain/due";
import { rowsFor } from "../mail/reads";
import { bornFrom, proposedFrom, summaryFor } from "../mail/transcripts";
import { TODAY } from "../seed/dates";
import {
  copy,
  familyOf,
  gate,
  now,
  pulseOf,
  stalledTasks,
  state,
  visibleTasks,
} from "../store";
import type { CalendarEvent, MeetingPrep, RecentMeeting } from "../types";
import { prepAvailable, readableEvent } from "./reads";
import { canReadEvent, inWindow } from "./visibility";

// La scheda di preparazione (area 6, shape meeting-prep.md): dentro il
// dettaglio di un evento FUTURO o IN CORSO con un progetto di cui chi guarda
// è membro, tre voci con un tetto — email recenti, riunioni precedenti,
// stato del progetto. È composta da dati, mai generata: l'unico testo
// generato è il riassunto già scritto dalla trascrizione, e lo vede solo chi
// c'era. Le email sono quelle che vede chi guarda (due persone alla stessa
// riunione vedono schede diverse); lo stato è quello dell'Overview, con le
// stesse funzioni (`pulseOf`, `stalledTasks`, `isOverdue`, `openMilestones`).

export const PREP_MAIL = 5;
export const PREP_MEETINGS = 3;
export const PREP_DUE = 3;
export const PREP_MILESTONES = 2;

/**
 * Le riunioni passate del progetto, dalla più recente. Ne fa parte quella
 * che chi guarda vede, e quella che non vede ma da cui è nata una task che
 * vede: di questa sa titolo, data e cose da fare, mai riassunto né evento
 * [A 2].
 */
function recentMeetings(me: string, e: CalendarEvent, projectId: string): RecentMeeting[] {
  const at = Date.parse(now());
  const past = state.calendarEvents
    .filter(
      (x) =>
        x.id !== e.id && x.projectId === projectId && inWindow(x) && Date.parse(x.endsAt) <= at,
    )
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt) || a.id.localeCompare(b.id));
  const out: RecentMeeting[] = [];
  for (const x of past) {
    if (out.length === PREP_MEETINGS) break;
    const canOpen = canReadEvent(me, x);
    const tasks = bornFrom(me, x.id);
    const proposedTasks = proposedFrom(me, x.id);
    if (!canOpen && tasks.length === 0) continue;
    const summary = summaryFor(me, x.id);
    out.push({
      eventId: x.id,
      title: x.title,
      at: x.startsAt,
      summary: summary?.summary ?? null,
      doc: summary?.doc ?? null,
      canOpen,
      tasks,
      proposedTasks,
    });
  }
  return out;
}

/** La scheda per `me`; `null` se l'evento è passato, senza progetto o se non è membro. */
export function prepFor(me: string, e: CalendarEvent): MeetingPrep | null {
  if (!prepAvailable(me, e)) return null;
  const projectId = e.projectId!;
  const project = state.projectsById.get(projectId)!;
  const pulse = pulseOf(me, project);
  const open = visibleTasks(me).filter(
    (t) => t.projectId === projectId && familyOf(t) !== "closed",
  );
  return {
    eventId: e.id,
    projectId,
    pulse,
    recentMail: rowsFor(me, { projectId }).slice(0, PREP_MAIL),
    recentMeetings: recentMeetings(me, e, projectId),
    status: {
      inProgress: pulse.open.active,
      late: open.filter((t) => isOverdue(t.dueDate, familyOf(t))).length,
      stalled: stalledTasks(me, { projectIds: [projectId] }),
      nextDueDates: open
        .filter((t) => t.dueDate !== null && t.dueDate >= TODAY)
        .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || a.code.localeCompare(b.code))
        .slice(0, PREP_DUE)
        .map(copy),
      milestones: openMilestones(state.milestones.filter((m) => m.projectId === projectId))
        .slice(0, PREP_MILESTONES)
        .map(copy),
    },
  };
}

/**
 * La scheda di preparazione di un evento. Un evento che chi guarda non legge
 * è `not_found` (come `getEvent`); passato, senza progetto o di un progetto
 * di cui non è membro → `null`: il pannello ha solo i dettagli (al posto
 * della scheda, per un evento passato, «Meeting summary» e «Tasks from this
 * meeting»: `getMeetingSummary`, `tasksBornFrom`).
 */
export async function getMeetingPrep(eventId: string): Promise<MeetingPrep | null> {
  const me = await gate("calendar.getMeetingPrep");
  return prepFor(me, readableEvent(me, eventId));
}
