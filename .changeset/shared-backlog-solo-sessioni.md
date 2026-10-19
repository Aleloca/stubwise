---
"@stubwise/shared": major
---

Backlog: restano solo le sessioni di refinement. Rimossi gli schemi e i tipi della chat della voce, della sessione di analisi sul codice (modalità CODE), delle domande a bottoni del backlog e del deep dive: `backlogDeepDivePayloadSchema`, `backlogChatTurn*PayloadSchema`, `backlogCodeSessionStatusSchema`, `startCodeSessionSchema`, `backlogMessageRoleSchema`, `backlogMessageSchema`, `backlogCodeSessionSchema`, `backlogQuestionSchema`, `backlogQuestionActionResultSchema`, `backlogChatAcceptedSchema` (e i tipi omonimi). `backlogJobKindSchema` vale ora `intake`, `estimate`; il dettaglio della voce perde `messages`, `deepDivePending`, `codeSession`, `pendingTurn` e `openQuestion`. Sessioni degli agenti: tolte le etichette di segmento `deep_dive` e `chat_turn`, `backlog_item` non è più fra i tipi su cui si interviene, e le domande di sessione hanno solo `source: "agent"` (via `backlogItemId` e `dismissed`). Polso: tolto `hasAnalysis` dalle proposte.
