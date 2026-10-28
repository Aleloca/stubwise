import type { AlertSubscription, AppNotification, MandatoryReason } from "../types";
import { daysFromToday } from "./dates";
import { TASKS } from "./tasks";

// Gli avvisi dell'area 8a: iscrizioni e notifiche dei kind nuovi.
//
// Iscrizioni: nessuna riga = il default del catalogo (Task 3). Il seme
// scrive solo quelle che se ne discostano: Matteo ha acceso «Nuova PR» su
// AUD; Giulia aveva acceso «Rilascio fallito» su AUD e l'ha spenta DOPO
// l'avviso di AUD-V3 (spegnere vale solo per il futuro: quello le resta);
// in fondo, chi ha acceso gli altri tipi spenti di default.
//
// Notifiche: i kind del catalogo non portano destinatari fissi
// (`recipientIds: []`): chi le riceve si calcola a lettura da iscrizioni,
// `mandatory` e permessi di adesso.

const at = (days: number, hm: string) => `${daysFromToday(-days)}T${hm}:00Z`;

export const ALERT_SUBSCRIPTIONS: AlertSubscription[] = [
  {
    personId: "p-matteo",
    projectId: "prj-aud",
    type: "pr.opened",
    history: [{ at: at(20, "10:00"), app: true, phone: false }],
  },
  {
    personId: "p-giulia",
    projectId: "prj-aud",
    type: "release.failed",
    history: [
      { at: at(30, "09:00"), app: true, phone: false },
      { at: at(2, "09:30"), app: false, phone: false },
    ],
  },
  // I tipi spenti di default (Task 3): senza chi li ha accesi, gli avvisi
  // del seme non arriverebbero a nessuno. Laura segue i rilasci di AUD,
  // Giulia le note di rilascio di STW, Matteo le task nuove di AUD.
  {
    personId: "p-laura",
    projectId: "prj-aud",
    type: "release.merged",
    history: [{ at: at(30, "09:00"), app: true, phone: false }],
  },
  {
    personId: "p-laura",
    projectId: "prj-aud",
    type: "release.succeeded",
    history: [{ at: at(30, "09:00"), app: true, phone: false }],
  },
  {
    personId: "p-giulia",
    projectId: "prj-stw",
    type: "docs.release_note",
    history: [{ at: at(20, "10:00"), app: true, phone: false }],
  },
  {
    personId: "p-matteo",
    projectId: "prj-aud",
    type: "task.created",
    history: [{ at: at(20, "10:00"), app: true, phone: false }],
  },
];

// [kind, codice progetto, codice oggetto, titolo, corpo, quando, link, obbligatori]
type Row = [
  kind: string,
  project: string,
  objectCode: string,
  title: string,
  body: string,
  createdAt: string,
  link: string,
  mandatory?: [personId: string, reason: MandatoryReason][],
];

// prettier-ignore
const ROWS: Row[] = [
  ["pr.opened", "AUD", "audin/audin-app#244", "New pull request", "Claude opened audin-app#244 for AUD-2: Onboarding checklist for new workspaces.", at(1, "13:30"), "#/p/AUD/releases"],
  ["pr.analysis_issues", "AUD", "audin/audin-app#246", "Problems in a pull request", "The analysis of audin-app#246 found 3 problems.", at(1, "15:10"), "#/p/AUD/releases", [["p-marco", "pr_author"]]],
  ["pr.corrected", "AUD", "audin/audin-app#246", "Claude fixed your pull request", "Claude pushed a fix on audin-app#246: the saved filter was applied before the tags were loaded.", at(1, "14:40"), "#/p/AUD/releases", [["p-marco", "pr_author"]]],
  ["release.merged", "AUD", "AUD-V3", "New release", "Laura Costa merged audin-app#241: Invoices with the VAT number.", at(3, "16:10"), "#/p/AUD/releases"],
  ["release.failed", "AUD", "AUD-V3", "Release failed", "AUD-V3 failed at “Run migrations” in Deploy to production.", at(3, "16:22"), "#/p/AUD/releases", [["p-laura", "merged"]]],
  ["release.succeeded", "AUD", "AUD-V1", "Release succeeded", "AUD-V1 is in production: Drop the legacy SMS module.", at(15, "12:41"), "#/p/AUD/releases"],
  ["docs.release_note", "STW", "STW", "New release notes", "Release notes 0.4.0 — Desktop preview.", at(5, "15:20"), "#/p/STW/docs"],
  ["task.created", "AUD", "AUD-10", "New task", "Store review notes for the mobile app.", at(8, "11:00"), "#/p/AUD/tasks"],
  ["support.request", "ACQ", "ACQ-S4", "New request from a customer", "Consumption history of the town buildings as a spreadsheet.", at(2, "11:00"), "#/p/ACQ/support"],
  ["support.customer_replied", "ACQ", "ACQ-S2", "The customer replied", "Lucia Benedetti: Any news? The yearly adjustment arrives next month.", at(0, "08:15"), "#/p/ACQ/support", [["p-laura", "follows_conversation"]]],
];

export const ALERT_NOTIFICATIONS: AppNotification[] = ROWS.map(
  ([kind, code, objectCode, title, body, createdAt, link, mandatory], i) => {
    const task = TASKS.find((t) => t.code === objectCode);
    const notification: AppNotification = {
      id: `n-a8-${i + 1}`,
      kind,
      projectId: `prj-${code.toLowerCase()}`,
      objectCode,
      departmentId: task?.departmentId ?? null,
      recipientIds: [],
      title,
      body,
      createdAt,
      read: false,
      archived: false,
      snoozedUntil: null,
      link,
    };
    if (mandatory)
      notification.mandatory = mandatory.map(([personId, reason]) => ({ personId, reason }));
    return notification;
  },
);
