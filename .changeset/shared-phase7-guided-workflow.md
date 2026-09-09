---
"@stubwise/shared": minor
---

Fase 7 (workflow guidato web per non-tecnici): tutto additivo.

- `aiJobSchema.failureSummary` (nullable, optional): riassunto "in breve" di un
  job fallito.
- `ticketDetailSchema`: `planApprovedAt`, `planApprovedBy` (`handledBySchema`)
  e `planApprovalStale` — stato della pre-approvazione del piano.
- `backlogChatTurnPayloadSchema`: da payload singolo a unione discriminata fra
  "nuovo messaggio utente" (il ramo storico, invariato byte per byte per la
  retro-compatibilità dei job già in coda) e "risposta a una domanda
  dell'agente".
- `backlogItemDetailSchema.openQuestion`: la domanda a bottoni ancora aperta
  sulla voce, se c'è.
- `backlogQuestionSchema`/`backlogQuestionActionResultSchema`: forma pubblica
  di una domanda della chat del backlog e dell'esito di risposta/dismiss.
- `handledBySchema` estratto in un nuovo modulo (`schemas/actor.ts`), da cui
  `schemas/notification.ts` ora lo importa e ri-esporta — rompeva un import
  circolare, nessun cambio di forma.
