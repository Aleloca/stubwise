---
"@stubwise/shared": minor
---

Timeline di progetto e review negli schemi condivisi: `projectTimelineSchema`
(la forma di `GET /api/projects/:id/timeline`) con `projectTimelineKindSchema` e
`projectTimelineEntrySchema`, e `prReviewSummarySchema` per le review esposte
sulla roadmap. Si aggiunge inoltre il kind `project.brief` a
`notificationKindSchema`: è un valore **nuovo di un enum chiuso**, quindi i
client vecchi lo leggono grazie a `readerSchema` (che riporta l'ignoto come
`UNKNOWN` e fa cadere la card sulla forma informativa), ma un **server** più
vecchio dello schema non saprebbe serializzare un'inbox che lo contiene.
