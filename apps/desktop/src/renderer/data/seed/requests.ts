import type { ProjectRequest, RequestStatus, RequestSuggestions } from "../types";
import { daysFromToday } from "./dates";
import { SUPPORT_CONVERSATIONS } from "./support/conversations";

// [id, codice progetto, titolo, richiedenti, stato, urgenza, simile a, fusa in, task nate, giorni fa]
type Row = [
  string,
  string,
  string,
  string[],
  RequestStatus,
  ProjectRequest["urgency"],
  string | null,
  string | null,
  string[],
  number,
];

// prettier-ignore
const ROWS: Row[] = [
  ["req-aud-1", "AUD", "Export the call history", ["p-matteo", "p-elena"], "converted", "high", null, null, ["t-aud-5"], 12],
  ["req-aud-2", "AUD", "Callback reminders by email", ["p-alessia"], "ready", "medium", null, null, [], 6],
  ["req-stw-1", "STW", "Show who moved a task to another week", ["p-davide"], "new", "medium", null, null, [], 2],
  ["req-stw-2", "STW", "Move tasks on a board with the keyboard", ["p-sara", "p-davide", "p-giulia"], "converted", "high", null, null, ["t-stw-3"], 15],
  ["req-stw-3", "STW", "Drag and drop on the board", ["p-giulia"], "archived", "medium", "req-stw-2", "req-stw-2", [], 14],
  ["req-stw-4", "STW", "Quiet hours for notifications", ["p-elena"], "refining", "low", null, null, [], 5],
  ["req-mkx-1", "MKX", "A brief for the spring campaign", ["p-matteo"], "converted", "high", null, null, ["t-mkx-1"], 30],
  ["req-mkx-2", "MKX", "Landing page for the showroom event", ["p-francesca", "p-matteo"], "new", "high", null, null, [], 1],
  ["req-mkx-3", "MKX", "Short video for the kitchens line", ["p-elena"], "ready", "medium", null, null, [], 8],
  ["req-mkx-4", "MKX", "Event page for the showroom", ["p-matteo"], "archived", "medium", "req-mkx-2", "req-mkx-2", [], 1],
  ["req-mkx-5", "MKX", "Print flyers for the fair", ["p-paolo"], "archived", "low", null, null, [], 40],
  ["req-olv-1", "OLV", "New photos of the olive grove on the homepage", ["p-giulia"], "new", "medium", null, null, [], 3],
  ["req-cbv-1", "CBV", "Gift-box option in the store", ["p-elena"], "refining", "high", null, null, [], 4],
  ["req-acq-1", "ACQ", "Pay the larger bills in instalments", [], "new", "medium", null, null, [], 4],
  ["req-acq-2", "ACQ", "Consumption history of the town buildings as a spreadsheet", [], "new", "low", null, null, [], 2],
];

// Le richieste nate da una conversazione di Support (area 8a): nessun
// richiedente del team (è un cliente), il testo è il desiderio riscritto dal
// triage. Una richiesta non nasce MAI da un'email.
const FROM_SUPPORT: Record<string, { conversationId: string; description: string }> =
  Object.fromEntries(
    SUPPORT_CONVERSATIONS.filter((c) => c.requestId !== null).map((c) => [
      c.requestId!,
      { conversationId: c.id, description: c.rewrittenWish! },
    ]),
  );

// Stima e rischio, dove il team li ha già dati (le altre restano «No estimate» / «Not assessed»).
const META: Record<string, Pick<ProjectRequest, "size" | "risk" | "riskNote">> = {
  "req-aud-1": { size: "M", risk: "low", riskNote: null },
  "req-aud-2": { size: "S", risk: "medium", riskNote: "Depends on the sending limits of the mail provider." },
  "req-stw-2": { size: "L", risk: "medium", riskNote: "Keyboard dragging must work with screen readers too." },
  "req-stw-4": { size: "S", risk: null, riskNote: null },
  "req-mkx-2": { size: "M", risk: "high", riskNote: "The showroom date is fixed: no room to slip." },
  "req-mkx-3": { size: "L", risk: "low", riskNote: null },
  "req-cbv-1": { size: "XS", risk: "low", riskNote: null },
};

// Design e piano scritti nei refine del seed (`cv-refine-stw-4` è ancora al
// lavoro sul piano, `cv-refine-aud-2` è chiuso): coerenti con le righe del flusso.
const WRITTEN: Record<string, Pick<ProjectRequest, "design" | "plan">> = {
  "req-stw-4": {
    design: [
      "- Quiet hours **per person**, from 20:00 to 08:00 by default, in the person's timezone.",
      "- During quiet hours notifications still reach the inbox; only the **push** waits.",
      "- At the end of the quiet hours, one summary push instead of one per notification.",
      "- A direct mention skips the quiet hours.",
    ].join("\n"),
    plan: null,
  },
  "req-aud-2": {
    design: [
      "- Callback reminders by email for the **operator**, not only the workspace owner.",
      "- Opt-in, one setting per person.",
      "- Respects the sending limits of the mail provider.",
    ].join("\n"),
    plan: [
      "1. Add the *Email reminders* setting to the operator profile.",
      "2. Send the reminder from the existing callback job when the setting is on.",
      "3. Count the reminders against the provider's daily limit.",
      "4. Tests for opt-in, opt-out and the limit.",
    ].join("\n"),
  },
};

// Le proposte dell'intake (AI) sui metadati: solo i campi che cambierebbero,
// col perché. Restano proposte finché qualcuno con `backlog.edit` non le
// accetta o le scarta.
const SUGGESTIONS: Record<string, RequestSuggestions> = {
  "req-stw-1": {
    urgency: "low",
    size: "S",
    risk: "low",
    reason:
      "Only the task activity and the week view change, and nobody else asked for it in the last two weeks.",
  },
  "req-mkx-2": {
    size: "L",
    riskNote: "The showroom date is fixed and the page needs the booking form: no room to slip.",
    reason:
      "The event page needs a booking form and a map, not only text and photos: more than a medium page.",
  },
};

/** Richieste dei progetti, in ogni stato; due fuse in un'altra dello stesso progetto. */
export const REQUESTS: ProjectRequest[] = ROWS.map(
  ([id, code, title, requesterIds, status, urgency, similarToId, mergedIntoId, taskIds, days]) => ({
    id,
    // Il numero dell'id è l'ordine di creazione nel progetto: «req-stw-3» → STW-R3.
    code: `${code}-R${id.split("-").at(-1)}`,
    projectId: `prj-${code.toLowerCase()}`,
    title,
    description:
      FROM_SUPPORT[id]?.description ?? `${title}. Asked by the team; details in the conversation.`,
    requesterIds,
    status,
    urgency,
    size: META[id]?.size ?? null,
    risk: META[id]?.risk ?? null,
    riskNote: META[id]?.riskNote ?? null,
    design: WRITTEN[id]?.design ?? null,
    plan: WRITTEN[id]?.plan ?? null,
    similarToId,
    mergedIntoId,
    taskIds,
    createdAt: `${daysFromToday(-days)}T11:00:00Z`,
    suggestions: SUGGESTIONS[id] ?? null,
    ...(FROM_SUPPORT[id]
      ? { origin: { kind: "support" as const, conversationId: FROM_SUPPORT[id].conversationId } }
      : {}),
  }),
);
