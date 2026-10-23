import type { ProjectRequest, RequestStatus } from "../types";
import { daysFromToday } from "./dates";

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
];

/** Richieste dei progetti, in ogni stato; due fuse in un'altra dello stesso progetto. */
export const REQUESTS: ProjectRequest[] = ROWS.map(
  ([id, code, title, requesterIds, status, urgency, similarToId, mergedIntoId, taskIds, days]) => ({
    id,
    projectId: `prj-${code.toLowerCase()}`,
    title,
    description: `${title}. Asked by the team; details in the conversation.`,
    requesterIds,
    status,
    urgency,
    similarToId,
    mergedIntoId,
    taskIds,
    createdAt: `${daysFromToday(-days)}T11:00:00Z`,
  }),
);
