import type { CalendarEvent, CalendarSeries } from "../../types";
import { daysFromToday } from "../dates";
import { EV_AUD_REVIEW_YESTERDAY } from "../mail/meetings";
import { event, guest, on, organizer, outsider } from "./helpers";

// Le serie ricorrenti: una riga per data, come Google le restituisce. La
// revisione settimanale di AUD è ACCESA (progetto AUD, promemoria il giorno
// prima); lo standup di STW è spento, come ogni serie non configurata. Le
// date vanno oltre la finestra letta (`now − 30 → now + 60` giorni) da
// entrambe le parti: le letture le tagliano. La revisione del budget non ha
// nessuna data dentro la finestra, e resta comunque fra le serie.

export const SERIES_IDS = {
  audReview: "ser-aud-weekly-review",
  stwStandup: "ser-stw-standup",
  budget: "ser-budget-quarterly",
} as const;

export const CALENDAR_SERIES: CalendarSeries[] = [
  {
    id: SERIES_IDS.audReview,
    title: "AUD weekly review",
    rule: "RRULE:FREQ=WEEKLY;BYDAY=TH",
    projectId: "prj-aud",
    enabled: true,
    action: "remind",
    leadDays: 1,
    auto: false,
  },
  {
    id: SERIES_IDS.stwStandup,
    title: "STW standup",
    rule: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    projectId: null,
    enabled: false,
    action: "milestone",
    leadDays: 1,
    auto: false,
  },
  {
    id: SERIES_IDS.budget,
    title: "Quarterly budget review",
    rule: "RRULE:FREQ=MONTHLY;INTERVAL=3",
    projectId: null,
    enabled: false,
    action: "milestone",
    leadDays: 1,
    auto: false,
  },
];

const weekday = (days: number) => new Date(`${daysFromToday(days)}T00:00:00Z`).getUTCDay();

/** Gli scarti in giorni da oggi, da `from` a `to` compresi, che cadono nei giorni `weekdays` (0 = dom). */
function offsets(from: number, to: number, weekdays: number[]): number[] {
  const out: number[] = [];
  for (let d = from; d <= to; d++) if (weekdays.includes(weekday(d))) out.push(d);
  return out;
}

/** La revisione di AUD, ogni giovedì 15:30–16:30 (ieri compreso), da settembre a gennaio. */
const AUD_REVIEWS: CalendarEvent[] = offsets(-50, 90, [4]).map((d) =>
  event({
    id: d === -1 ? EV_AUD_REVIEW_YESTERDAY : `ev-aud-review-${daysFromToday(d)}`,
    calendarPersonIds: ["p-giulia", "p-matteo", "p-laura"],
    title: "AUD weekly review",
    description: "Weekly status with the Audin team: progress, risks, next steps.",
    startsAt: on(d, "15:30"),
    endsAt: on(d, "16:30"),
    meetUrl: "https://meet.google.com/aud-wkly-rvw",
    attendees: [organizer("p-matteo"), guest("p-giulia"), guest("p-laura"), guest("p-marco")],
    seriesId: SERIES_IDS.audReview,
    projectId: "prj-aud",
  }),
);

/** Lo standup di STW, ogni giorno feriale 09:00–09:15. */
const STW_STANDUPS: CalendarEvent[] = offsets(-35, 70, [1, 2, 3, 4, 5]).map((d) =>
  event({
    id: `ev-stw-standup-${daysFromToday(d)}`,
    calendarPersonIds: ["p-giulia", "p-laura"],
    title: "STW standup",
    startsAt: on(d, "09:00"),
    endsAt: on(d, "09:15"),
    meetUrl: "https://meet.google.com/stw-stnd-upp",
    attendees: [
      organizer("p-laura"),
      guest("p-giulia"),
      guest("p-marco"),
      guest("p-simone", "tentative"),
    ],
    seriesId: SERIES_IDS.stwStandup,
    projectId: "prj-stw",
  }),
);

/** La revisione del budget, ogni tre mesi: luglio, poi gennaio e aprile (fuori finestra). */
const BUDGET_REVIEWS: CalendarEvent[] = [-100, 84, 174].map((d) =>
  event({
    id: `ev-budget-review-${daysFromToday(d)}`,
    calendarPersonIds: ["p-giulia"],
    title: "Quarterly budget review",
    startsAt: on(d, "10:00"),
    endsAt: on(d, "11:30"),
    location: "Meeting room 2",
    attendees: [
      organizer("p-giulia"),
      guest("p-roberta"),
      outsider("Studio Bassi", "conti@studiobassi.example"),
    ],
    seriesId: SERIES_IDS.budget,
  }),
);

export const SERIES_EVENTS: CalendarEvent[] = [...AUD_REVIEWS, ...STW_STANDUPS, ...BUDGET_REVIEWS];
