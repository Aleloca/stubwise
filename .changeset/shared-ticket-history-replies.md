---
"@stubwise/shared": minor
---

Storia del ticket e risposte ai commenti: `ticketHistorySchema` e
`ticketHistoryEventSchema` (`GET /api/tickets/:id/history`, forma piatta con
`kind` aperto, `fromStatus` e `total`), `commentReplyToSchema` e il campo
additivo `replyTo` (`.nullable().default(null)`) su `ticketCommentSchema`,
`plainExcerpt` per gli estratti di una riga. `stripMarkdown` (degli snippet di
ricerca) è ora esportata, col barrato corretto e il corsivo con `_` solo su
confine di parola.
