---
"@stubwise/shared": minor
---

Ciclo di correzione post-PR (review → correzione): tutto additivo, i campi
nuovi nelle risposte nascono `.default()`/`.optional()` per i client già
installati.

- `schemas/pr-correction.ts` (nuovo): `prCycleSchema` (stato del ciclo di una
  PR — `prCycleStateSchema`, giro e tetto, richiesta in coda, ultima richiesta,
  `canRequestCorrection`, `heldReason`, `canResume`, `heldJobId`),
  `prCorrectionTriggerSchema`, `requestCorrectionBodySchema` (nota
  facoltativa) e `requestCorrectionResponseSchema`, `prCommentSchema`
  (commento della PR, con `authorAssociation` opzionale),
  `prCycleEventSchema` e `prCycleStopReasonSchema` (il blocco `cycle` dell'evento
  di una review: giro, tetto, stop).
- `ticketRepositorySchema.cycle` (la voce PR del dettaglio ticket,
  `prCycleSchema`, `.nullable().default(null)`). `runAiBodySchema` (nuovo, il body di
  `POST /api/tickets/:id/run-ai`) con `resumeCorrectionJobId` opzionale: dice
  QUALE correzione ferma riprendere.
- `inboxItemSchema.reviewOutcome` (`inboxReviewOutcomeSchema`, nuovo enum,
  `.nullable().default(null)`) e `reviewOutcomeNeedsAttention`.
- `releaseQueueItemSchema.reviewStale` (`.default(false)`): il verdetto è su
  una head superata.
- `repositorySchema.reviewGitAccountId` (account revisore,
  `.nullable().default(null)`), `repositoryWarningSchema` e
  `repositorySaveResponseSchema` (avvisi non bloccanti del salvataggio).
- `projectSchema.prCorrectionMaxRounds` (`.default(3)`) e lo stesso campo,
  0..10, in `updateProjectSchema`.
- `STUBWISE_BRANCH_RE`/`stubwiseTicketNumber` (branch dei fix) e
  `prNumberFromUrl` (numero della PR dal suo URL).
- `gitProviderKindSchema` e `heldReasonSchema` spostati in
  `schemas/base-enums.ts` per rompere un import circolare, e ri-esportati dai
  moduli di prima: nessun import esistente cambia, nessuna forma cambia.
