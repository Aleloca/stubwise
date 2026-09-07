# @stubwise/shared

## 0.3.0

### Minor Changes

- a019d4c: Nuovi schemi del registro decisioni di progetto: `projectDecisionSchema` (una
  decisione con origine, attore, contesto, conseguenze e l'eventuale decisione che
  l'ha superata), `decisionDraftSchema` per registrarne una a mano e
  `decisionPatchSchema` per correggerla o segnarla come superata. I testi delle
  decisioni automatiche vengono da template: il registro non è mai scritto dall'AI.
- 69cde34: Riassunti "in breve" negli schemi condivisi: `inboxItemSchema.summary`, `ticketDetailSchema.planSummary` e `aiJobSchema.planSummary`. Sono due o tre frasi in linguaggio non tecnico su cosa un piano cambia o su cosa fa una PR, generate dal worker e riempite dal server quando esistono. Tutti e tre i campi sono **opzionali**: le risposte restano valide per i client che non li conoscono (l'app mobile installata li scarta), e un riassunto assente non è mai `null` nella risposta d'inbox ma semplicemente non c'è.
- 62c859e: Le milestone hanno finalmente uno schema condiviso: `milestoneSchema`,
  `milestoneStatusSchema`, `milestoneCountsSchema`, `milestoneWithCountsSchema`,
  `milestoneDraftSchema` e la patch. Vivevano solo dentro la rotta del server,
  mentre la web app tipava il proprio client con interfacce scritte a mano — ed è
  così che la creazione dalla UI è potuta divergere dal body che il server
  esigeva senza che nulla se ne accorgesse. Novità di forma: `repositoryId` è
  **opzionale** in creazione (la milestone appartiene al progetto) e **non** fa
  parte della proiezione pubblica; `description` e `closedAt` sono nullable, e
  `closedAt` non è modificabile a mano — lo governa il passaggio di `status`.
- 62c859e: Timeline di progetto e review negli schemi condivisi: `projectTimelineSchema`
  (la forma di `GET /api/projects/:id/timeline`) con `projectTimelineKindSchema` e
  `projectTimelineEntrySchema`, e `prReviewSummarySchema` per le review esposte
  sulla roadmap. Si aggiunge inoltre il kind `project.brief` a
  `notificationKindSchema`: è un valore **nuovo di un enum chiuso**, quindi i
  client vecchi lo leggono grazie a `readerSchema` (che riporta l'ignoto come
  `UNKNOWN` e fa cadere la card sulla forma informativa), ma un **server** più
  vecchio dello schema non saprebbe serializzare un'inbox che lo contiene.
- 12aadb4: Nuovo `ticketActivityEntrySchema`: il feed di attività di un ticket
  (`GET /api/tickets/:id/activity`) letto dai client. È dichiarato **piatto e
  permissivo** — `kind` ed `eventKind` sono stringhe aperte, i campi delle singole
  varianti sono opzionali — invece della `discriminatedUnion` del server: quelle
  non sono attraversabili da `readerSchema`, e una variante nuova aggiunta domani
  farebbe fallire il parse dell'intero feed su un'app già installata. Lo usa
  l'app mobile per datare i passi "piano approvato" e "PR e review" della storia
  del lavoro, che nessun campo di `AiJob` sa dire.
- ab16d0e: Brief settimanale negli schemi condivisi: `projectBriefWeeklySchema` (la forma di
  `GET /api/projects/:id/briefs` e `GET /api/briefs/:id`) e il toggle
  `weeklyBriefEnabled` su progetto, in lettura e nel PATCH. Il nome porta
  `Weekly` per non confonderlo col _project brief_ della documentazione, che è
  un'altra cosa con lo stesso nome corto. `error` non fa parte della proiezione:
  il messaggio con cui una generazione è fallita può contenere path del worker e
  frammenti di prompt, e lo stato `failed` basta a una UI.

## 0.2.0

### Minor Changes

- 047ec90: Initial public release of `@stubwise/sdk` (browser + Node error capture and
  feedback) and `@stubwise/shared` (Zod domain schemas and types).
