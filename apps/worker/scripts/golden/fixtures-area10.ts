/**
 * Area 10, F3 (S2): le task ferme di AUD nella forma di `GET /api/tasks/stalled`
 * (`{ task, stall }`, le soglie del progetto), per il golden `chat-s2-stalled`.
 * Stanno qui e non in `run.ts` perché `run.ts` lancia `main()` all'import, e il
 * test d'accordo col ponte (`fixtures-area10.test.ts`) le deve leggere: il primo
 * giro del golden era rosso perché alla fixture mancava `projectId` e il ponte
 * scartava le righe.
 */
export const STALLED_PROJECT_ID = "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01";

const task = (id: string, number: number, title: string, plannedWeek: string | null) => ({
  id,
  projectId: STALLED_PROJECT_ID,
  number,
  code: `AUD-${number}`,
  title,
  status: { name: "In corso", family: "active" },
  plannedWeek,
});

export const STALLED_TASKS = [
  { task: task("8a9b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d", 7, "Import contatti", null), stall: { reason: { kind: "idle" }, since: "2026-10-30T09:00:00.000Z", days: 21 } },
  { task: task("9b0c1d2e-3f4a-4b5c-9d7e-8f9a0b1c2d3e", 9, "Report mensile", "2026-11-16"), stall: { reason: { kind: "unassigned" }, since: "2026-11-10T09:00:00.000Z", days: 10 } },
];
