/**
 * «Annulla il lavoro» vale per UN tentativo (review dell'area 3, punto 1, 10
 * nov 2026). `ai_jobs.cancel_requested_at`/`_by_user_id` dicono che chi
 * guardava ha chiesto di fermare il tentativo IN CORSO; ogni transizione che
 * fa ripartire il job — riciclo e forzatura di `startRun`, approvazione o
 * rifiuto del piano, risposta a una domanda, ripresa dopo un limite, ritorno
 * in coda di un job stantio — scrive questo stesso oggetto nella sua UPDATE.
 * Senza, il job ripartito porterebbe la richiesta di prima e il worker lo
 * annullerebbe al claim (`checkCancelNow`): la task non si rilancerebbe più.
 * Il worker, come difesa, onora la colonna solo se è successiva a
 * `started_at` del tentativo.
 */
export const CANCEL_REQUEST_CLEARED = { cancelRequestedAt: null, cancelRequestedByUserId: null } as const;
