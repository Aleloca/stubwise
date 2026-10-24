import type { DecisionLogEntry, DecisionSource } from "../types";
import { daysFromToday } from "./dates";

// Il registro decisioni dei progetti di riferimento. Sono FATTI, mai testo
// dell'AI: le voci automatiche (risposta a una domanda di Claude, revisione
// di un piano, proposta del polso accettata) hanno il testo che il writer
// compone dal suo template — la domanda e l'opzione scelta, «Plan approved» /
// «Plan rejected» con le indicazioni di chi ha deciso —; le voci `manual` le
// ha scritte una persona. Il brief settimanale, che è narrativa generata,
// vive in `briefs.ts`, non qui.

// [codice, n, sorgente, task (numero nel progetto) | null, titolo, decisione, contesto | null, chi, giorni fa, superata da (n) | null]
type Row = [
  string,
  number,
  DecisionSource,
  number | null,
  string,
  string,
  string | null,
  string,
  number,
  number | null,
];

// prettier-ignore
const ROWS: Row[] = [
  ["AUD", 1, "manual", 1, "Three pricing tiers at launch", "Starter, Team and Business; no free plan at launch.", "A free plan would need support we don't have before the spring.", "p-matteo", 14, null],
  ["AUD", 2, "plan_review", 8, "Plan for AUD-8: approved", "Plan approved. Store callbacks in UTC and convert on display.", null, "p-laura", 6, null],
  ["AUD", 3, "ask_user", 5, "Which columns go into the call history export?", "Date, contact, duration and outcome; no recordings.", "Asked by Claude while planning AUD-5.", "p-stefano", 5, null],
  ["AUD", 4, "pulse", 10, "Restart from the telephony contract renewal", "Accepted: renew the contract before the launch.", "The project had no work in progress for a week.", "p-matteo", 9, null],
  ["AUD", 5, "manual", null, "The mobile app waits until after the launch", "No mobile work before the public launch; the milestone stays without a date.", null, "p-laura", 3, null],
  ["STW", 1, "manual", null, "Tasks are the only unit of work", "Tickets, backlog items and activities become tasks with a department.", "Every department should see its work in the same place.", "p-laura", 20, null],
  ["STW", 2, "manual", 4, "Stalled reasons say why, not \"no activity\"", "Each stalled task shows its real reason: a decision, a question, a blocker, nobody assigned.", null, "p-giulia", 12, null],
  ["STW", 3, "plan_review", 1, "Plan for STW-1: rejected with instructions", "Plan rejected: keep the viewer in the query keys, don't clear the cache on switch.", null, "p-laura", 11, 4],
  ["STW", 4, "plan_review", 1, "Plan for STW-1: approved", "Plan approved. The person is part of every query key.", null, "p-laura", 10, null],
  ["STW", 5, "ask_user", 3, "Does dragging a card change the planned week?", "No: dragging changes the status only; the week changes from Planning.", "Asked by Claude while planning STW-3.", "p-simone", 4, null],
  ["STW", 6, "email", null, "Self-hosted customers get the desktop app later", "Confirmed from the mail thread with the hosting partner: desktop ships to our instance first.", null, "p-laura", 2, null],
  ["MKX", 1, "manual", 1, "One campaign line for kitchens and living", "A single spring line; separate creatives come later if the budget allows.", "The client asked to keep the message simple for the dealers.", "p-giulia", 18, 3],
  ["MKX", 2, "manual", 3, "Print stays in the media plan", "Keep the trade press: dealers read it more than social.", null, "p-paolo", 8, null],
  ["MKX", 3, "manual", 1, "Kitchens and living get separate creatives", "Two creative lines after all; the media plan keeps one budget.", "Mix Cucine changed its mind at the review meeting.", "p-giulia", 6, null],
  ["MKX", 4, "pulse", 9, "Restart from the showroom newsletter", "Accepted: plan the newsletter for the showroom week.", null, "p-giulia", 4, null],
];

export const DECISION_LOG: DecisionLogEntry[] = ROWS.map(
  ([code, n, source, task, title, decision, context, by, days, supersededBy]) => {
    const c = code.toLowerCase();
    return {
      id: `dl-${c}-${n}`,
      projectId: `prj-${c}`,
      source,
      taskId: task === null ? null : `t-${c}-${task}`,
      title,
      context,
      decision,
      decidedById: by,
      decidedAt: `${daysFromToday(-days)}T15:00:00Z`,
      supersededById: supersededBy === null ? null : `dl-${c}-${supersededBy}`,
    };
  },
);
