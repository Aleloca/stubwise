---
"@stubwise/shared": minor
---

Nuovo `ticketActivityEntrySchema`: il feed di attività di un ticket
(`GET /api/tickets/:id/activity`) letto dai client. È dichiarato **piatto e
permissivo** — `kind` ed `eventKind` sono stringhe aperte, i campi delle singole
varianti sono opzionali — invece della `discriminatedUnion` del server: quelle
non sono attraversabili da `readerSchema`, e una variante nuova aggiunta domani
farebbe fallire il parse dell'intero feed su un'app già installata. Lo usa
l'app mobile per datare i passi "piano approvato" e "PR e review" della storia
del lavoro, che nessun campo di `AiJob` sa dire.
