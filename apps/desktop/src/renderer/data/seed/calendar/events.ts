import { PEOPLE } from "../people";
import type { CalendarEvent } from "../../types";
import { day, event, guest, on, organizer, outsider } from "./helpers";

// Gli eventi singoli del seme (le serie in `series.ts`). Oggi è venerdì 23
// ottobre: Giulia ha la giornata piena — lo standup di STW (serie), tre
// riunioni di progetto, una personale, un invito senza risposta, un evento
// tutto il giorno. Più avanti: 12 eventi sovrapposti mercoledì 28, un rilascio
// a cavallo della mezzanotte, un evento che fallisce al primo salvataggio,
// uno con 40 invitati, e tre «scadenze» — futura (proposta), passata e
// rifiutata (nessuna proposta).

export const CALENDAR_CASES = {
  goLive: "ev-aud-go-live-sofia",
  lunch: "ev-lunch-anna",
  visualsReview: "ev-mkx-visuals-review",
  invite: "ev-olv-harvest-shoot",
  pressDay: "ev-mkx-press-day",
  midnight: "ev-aud-release-21",
  /** Fallisce sempre al PRIMO salvataggio («Non salvato · Riprova»). */
  saveFails: "ev-aud-dashboard-check",
  allHands: "ev-all-hands",
  deadline: "ev-mkx-visuals-deadline",
  pastDeadline: "ev-stw-beta-feedback",
  declinedDeadline: "ev-aud-billing-delivery",
} as const;

const C = CALENDAR_CASES;

const SOFIA = outsider("Sofia Marchi", "sofia.marchi@audin.example");

const TODAY_EVENTS: CalendarEvent[] = [
  event({
    id: C.goLive,
    calendarPersonIds: ["p-giulia", "p-matteo"],
    title: "AUD go-live plan with Sofia",
    description: "Walk through the revised go-live plan before sending it in writing.",
    startsAt: on(0, "11:00"),
    endsAt: on(0, "12:00"),
    meetUrl: "https://meet.google.com/aud-goli-vep",
    attendees: [organizer("p-giulia"), guest("p-matteo"), SOFIA],
    projectId: "prj-aud",
  }),
  event({
    id: C.lunch,
    calendarPersonIds: ["p-giulia"],
    title: "Lunch with Anna",
    startsAt: on(0, "12:30"),
    endsAt: on(0, "13:30"),
    location: "Trattoria da Rosa",
    attendees: [],
    reminders: [{ minutes: 30, method: "popup" }],
  }),
  event({
    id: C.visualsReview,
    calendarPersonIds: ["p-giulia", "p-matteo"],
    title: "MKX launch visuals review",
    startsAt: on(0, "14:00"),
    endsAt: on(0, "15:00"),
    meetUrl: "https://meet.google.com/mkx-vsls-rvw",
    attendees: [organizer("p-matteo"), guest("p-giulia"), guest("p-chiara")],
    projectId: "prj-mkx",
  }),
  event({
    id: C.invite,
    calendarPersonIds: ["p-giulia"],
    title: "OLV harvest photo shoot",
    description: "Planning the photo shoot at the mill for the new website.",
    startsAt: on(0, "16:00"),
    endsAt: on(0, "16:45"),
    location: "Oleificio Valdarno, Via del Frantoio 4",
    attendees: [
      outsider("Piero Valdarno", "piero@oleificiovaldarno.example", "accepted", true),
      guest("p-giulia", "needsAction"),
    ],
    projectId: "prj-olv",
  }),
  event({
    id: C.pressDay,
    calendarPersonIds: ["p-giulia", "p-matteo"],
    title: "MKX press day",
    startsAt: day(0),
    endsAt: day(1),
    allDay: true,
    attendees: [organizer("p-matteo"), guest("p-giulia")],
    projectId: "prj-mkx",
  }),
];

/** Mercoledì 28: 12 eventi che si sovrappongono fra le 10 e le 13. */
const OVERLAPPING: CalendarEvent[] = Array.from({ length: 12 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  const start = 10 * 60 + i * 10;
  const hm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return event({
    id: `ev-overlap-${n}`,
    calendarPersonIds: ["p-giulia", "p-matteo"],
    title: `Partner demo ${n}`,
    startsAt: on(5, hm(start)),
    endsAt: on(5, hm(start + 60)),
    attendees: [organizer("p-matteo"), guest("p-giulia", i % 3 === 2 ? "tentative" : "accepted")],
    projectId: i % 2 === 0 ? "prj-mkx" : null,
  });
});

const LATER: CalendarEvent[] = [
  event({
    id: C.midnight,
    calendarPersonIds: ["p-giulia", "p-laura"],
    title: "Release AUD 2.1",
    startsAt: on(6, "22:30"),
    endsAt: on(7, "01:00"),
    meetUrl: "https://meet.google.com/aud-rels-twn",
    attendees: [organizer("p-laura"), guest("p-giulia"), guest("p-marco")],
    projectId: "prj-aud",
  }),
  event({
    id: C.saveFails,
    calendarPersonIds: ["p-giulia"],
    title: "AUD dashboard check",
    startsAt: on(4, "10:00"),
    endsAt: on(4, "10:30"),
    meetUrl: "https://meet.google.com/aud-dash-chk",
    attendees: [organizer("p-giulia"), guest("p-alessia", "needsAction")],
    projectId: "prj-aud",
  }),
  event({
    id: C.allHands,
    calendarPersonIds: ["p-giulia", "p-matteo", "p-laura"],
    title: "Company all-hands",
    startsAt: on(10, "16:00"),
    endsAt: on(10, "17:00"),
    meetUrl: "https://meet.google.com/all-hnds-nov",
    // 40 invitati: le 25 persone del team e 15 collaboratori esterni.
    attendees: [
      organizer("p-roberta"),
      ...PEOPLE.filter((p) => !p.isClaude && p.id !== "p-roberta").map((p, i) =>
        guest(p.id, i % 5 === 4 ? "needsAction" : "accepted"),
      ),
      ...Array.from({ length: 15 }, (_, i) =>
        outsider(`Freelancer ${i + 1}`, `freelancer${i + 1}@collaborators.example`, "tentative"),
      ),
    ],
  }),
  // Le scadenze: solo quella futura e accettata propone un traguardo.
  event({
    id: C.deadline,
    calendarPersonIds: ["p-giulia", "p-matteo"],
    title: "Deadline: MKX launch visuals",
    startsAt: day(14),
    endsAt: day(15),
    allDay: true,
    attendees: [organizer("p-matteo"), guest("p-giulia")],
    projectId: "prj-mkx",
  }),
  event({
    id: C.pastDeadline,
    calendarPersonIds: ["p-giulia", "p-laura"],
    title: "Deadline: STW beta feedback",
    startsAt: day(-7),
    endsAt: day(-6),
    allDay: true,
    attendees: [organizer("p-laura"), guest("p-giulia")],
    projectId: "prj-stw",
  }),
  event({
    id: C.declinedDeadline,
    calendarPersonIds: ["p-giulia"],
    title: "Delivery: AUD billing export",
    startsAt: on(12, "10:00"),
    endsAt: on(12, "10:30"),
    attendees: [
      outsider("Audin finance", "finance@audin.example", "accepted", true),
      guest("p-giulia", "declined"),
    ],
    projectId: "prj-aud",
  }),
];

export const SINGLE_EVENTS: CalendarEvent[] = [...TODAY_EVENTS, ...OVERLAPPING, ...LATER];
