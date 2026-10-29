import type { AppNotification } from "../../types";
import { SERVER_ANALYSES, SERVER_TASK_CODE } from "./analysis";
import { SRV2_DISK_EPISODE, SRV3_SILENT_EPISODE } from "./episodes";

// Gli avvisi dei server (area 8b), kind locali: come quelli dell'8a non
// portano destinatari fissi (`recipientIds: []`), li calcola la lettura
// dal catalogo, dove li registra `data/servers/alertTypes.ts` (Task 5).
// L'allarme e il rientro di memoria di SRV-1 restano le righe
// `monitor.alert` / `monitor.recovered` di `notifications.ts`.
//
// I link portano al dettaglio del server nella sezione Servers del progetto
// (`#/p/<CODE>/servers/SRV-<n>`); quello della diagnosi apre la task.

// [kind, codice progetto, codice oggetto, titolo, corpo, quando, link, letta]
type Row = [string, string, string, string, string, string, string, boolean];

const diagnosis = SERVER_ANALYSES[0]!;

// prettier-ignore
const ROWS: Row[] = [
  ["server.diagnosis_ready", "ACQ", "SRV-1", "Diagnosis ready", `Claude looked into acq-prod-01 with read-only access: ${SERVER_TASK_CODE} Memory leak in the nightly import worker.`, diagnosis.endedAt!, `#/p/ACQ/tasks?task=${SERVER_TASK_CODE}`, false],
  ["server.trouble", "STW", "SRV-2", "Server in trouble", "db-stw-01: disk at 93% (alert at 90%) and the check “Replica port” is down. Claude can't look into it: no SSH access.", SRV2_DISK_EPISODE.startedAt, "#/p/STW/servers/SRV-2", false],
  ["server.down", "AUD", "SRV-3", "Server not responding", "aud-app-01: the agent stopped reporting.", SRV3_SILENT_EPISODE.startedAt, "#/p/AUD/servers/SRV-3", true],
  ["server.recovered", "AUD", "SRV-3", "Server back to normal", "aud-app-01 is reporting again, after 22 minutes.", SRV3_SILENT_EPISODE.recoveredAt!, "#/p/AUD/servers/SRV-3", true],
];

export const SERVER_ALERT_NOTIFICATIONS: AppNotification[] = ROWS.map(
  ([kind, code, objectCode, title, body, createdAt, link, read], i) => ({
    id: `n-a8b-${i + 1}`,
    kind,
    projectId: `prj-${code.toLowerCase()}`,
    objectCode,
    departmentId: null,
    recipientIds: [],
    title,
    body,
    createdAt,
    read,
    archived: false,
    snoozedUntil: null,
    link,
  }),
);
