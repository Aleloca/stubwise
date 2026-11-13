import type * as Fake from "../../api";
import { openMilestones } from "../../../domain/due";
import { calendar } from "./calendar";
import { session } from "./client";
import { today } from "./clock";
import { mail } from "./mail";
import { getMeetingSummary, meetingTasksOf } from "./meetings";
import { projectPulse } from "./overview";
import { listProjects } from "./projects";
import { listMilestones, listProjectStatuses } from "./statuses";
import { listStalled, listTasks } from "./tasks";
import type {
  CalendarEventView,
  MeetingPrep,
  MeetingSummary,
  MeetingTask,
  RecentMeeting,
  Task,
} from "../../types";

// La scheda di preparazione nella build app (area 6, F5), composta nel
// CLIENT *(O, 46)*: niente `/prep` sul server. Le letture sono quelle che
// esistono già, tutte filtrate dal server per chi guarda — nessuna allarga
// cosa vede —, in PARALLELO, con al più 3 riunioni passate (ognuna col suo
// riassunto e le sue task). La regola di quando c'è è quella del prototipo
// (`data/calendar/prep.ts`): un evento futuro, con un progetto di cui chi
// guarda è membro. I limiti sono gli stessi del prototipo (lì li dicono
// `PREP_*`; importarli porterebbe il seme nella build app).

const PREP_MAIL = 5;
const PREP_MEETINGS = 3;
const PREP_DUE = 3;
const PREP_MILESTONES = 2;

type Api = typeof Fake;

/** Le letture di cui la scheda è fatta, iniettate (le vere in `getMeetingPrep`, finte nei test). */
export interface PrepReads {
  me: string;
  now: string;
  today: string;
  getEvent: (id: string) => Promise<CalendarEventView>;
  listProjects: () => Promise<{ id: string; memberIds: string[] }[]>;
  projectPulse: Api["projectPulse"];
  listMailThreads: (filters: { projectId: string }) => ReturnType<Api["mail"]["listMailThreads"]>;
  listTasks: (criteria: { projectIds: string[] }) => Promise<Task[]>;
  listStalled: (criteria: { projectIds: string[] }) => ReturnType<Api["listStalled"]>;
  listMilestones: Api["listMilestones"];
  listProjectStatuses: Api["listProjectStatuses"];
  /** Gli eventi che vedo nella finestra letta, fino ad adesso. */
  listEvents: () => Promise<CalendarEventView[]>;
  getMeetingSummary: (eventId: string) => Promise<Pick<MeetingSummary, "summary" | "doc"> | null>;
  meetingTasksOf: (
    eventId: string,
  ) => Promise<{ tasks: MeetingTask[]; proposedTasks: number } | null>;
}

/** La scheda per chi guarda; `null` se l'evento è passato, senza progetto o se non è membro. */
export async function composeMeetingPrep(
  eventId: string,
  r: PrepReads,
): Promise<MeetingPrep | null> {
  const e = await r.getEvent(eventId);
  const at = Date.parse(r.now);
  if (Date.parse(e.endsAt) <= at || e.projectId === null) return null;
  const projectId = e.projectId;
  const project = (await r.listProjects()).find((p) => p.id === projectId);
  if (!project || !project.memberIds.includes(r.me)) return null;

  const [pulse, mail, tasks, stalled, milestones, statuses, events] = await Promise.all([
    r.projectPulse(projectId),
    r.listMailThreads({ projectId }),
    r.listTasks({ projectIds: [projectId] }),
    r.listStalled({ projectIds: [projectId] }),
    r.listMilestones(projectId),
    r.listProjectStatuses(projectId),
    r.listEvents(),
  ]);
  if (!pulse) return null;

  const familyOf = new Map(statuses.map((s) => [s.id, s.family]));
  const open = tasks.filter(
    (t) => t.projectId === projectId && familyOf.get(t.statusId) !== "closed",
  );
  const past = events
    .filter((x) => x.id !== eventId && x.projectId === projectId && Date.parse(x.endsAt) <= at)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt) || a.id.localeCompare(b.id))
    .slice(0, PREP_MEETINGS);
  const recentMeetings = await Promise.all(
    past.map(async (x): Promise<RecentMeeting> => {
      const [summary, born] = await Promise.all([
        r.getMeetingSummary(x.id),
        r.meetingTasksOf(x.id),
      ]);
      return {
        eventId: x.id,
        title: x.title,
        at: x.startsAt,
        // Chi non c'era: niente riassunto né stato del Doc (il server non li dà).
        summary: summary?.summary ?? null,
        doc: summary?.doc ?? null,
        // Gli eventi della lista sono quelli che vedo: si aprono.
        canOpen: true,
        tasks: born?.tasks ?? [],
        proposedTasks: born?.proposedTasks ?? 0,
      };
    }),
  );

  return {
    eventId,
    projectId,
    pulse,
    recentMail: mail.slice(0, PREP_MAIL),
    recentMeetings,
    status: {
      inProgress: pulse.open.active,
      // La regola di `isOverdue`, con l'«oggi» della lettura (iniettato: la stessa
      // data per tutta la scheda, e i test non dipendono dall'orologio).
      late: open.filter(
        (t) => !!t.dueDate && t.dueDate < r.today && familyOf.get(t.statusId) !== "closed",
      ).length,
      stalled,
      nextDueDates: open
        .filter((t) => t.dueDate !== null && t.dueDate >= r.today)
        .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || a.code.localeCompare(b.code))
        .slice(0, PREP_DUE),
      milestones: openMilestones(milestones.filter((m) => m.projectId === projectId)).slice(
        0,
        PREP_MILESTONES,
      ),
    },
  };
}

/**
 * La scheda con le letture VERE della build app, agganciata al namespace del
 * calendario (F5a) con un rinvio; la chiede una pagina solo con `hasPrep`.
 */
export const getMeetingPrep: Api["calendar"]["getMeetingPrep"] = async (eventId) => {
  const window = calendar.calendarWindow();
  const now = new Date().toISOString();
  return composeMeetingPrep(eventId, {
    me: session.personId ?? "",
    now,
    today: today(),
    getEvent: (id) => calendar.getEvent(id),
    listProjects,
    projectPulse,
    listMailThreads: (filters) => mail.listMailThreads(filters),
    listTasks: (criteria) => listTasks(criteria),
    listStalled: (criteria) => listStalled(criteria),
    listMilestones,
    listProjectStatuses,
    listEvents: () => calendar.listEvents({ from: window.from, to: now }),
    getMeetingSummary,
    meetingTasksOf,
  });
};
