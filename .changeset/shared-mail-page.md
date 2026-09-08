---
"@stubwise/shared": minor
---

Schemi della pagina Posta (fase 6, Task 12): `mailItemSchema`/`mailPageSchema`
(la lista UNIFICATA di messaggi Gmail ed eventi di calendario trattati, con
`source` a distinguerli), `mailItemStatusSchema` (stato normalizzato, uguale
per le due sorgenti), `mailSignalSchema`, `mailSummarySchema` (contatori) e
`mailReproposeResultSchema`. Alimentano `GET /api/me/mail`,
`GET /api/me/mail/summary` e `POST /api/me/mail/:source/:id/repropose`.
