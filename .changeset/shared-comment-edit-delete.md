---
"@stubwise/shared": minor
---

Commenti modificati e cancellati: `ticketCommentSchema` guadagna `editedAt`,
`deletedAt`, `deletedBy`, `canEdit`, `canDelete` e `inDecisionLog`, e
`commentReplyToSchema` guadagna `deleted`. Tutti additivi con default: un
server che non li manda dà un commento mai modificato né eliminato, che chi
guarda non può toccare.
