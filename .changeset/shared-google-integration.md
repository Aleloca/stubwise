---
"@stubwise/shared": minor
---

Schemi dell'integrazione Google (fase 6, Task 1/4/5/6/10): registro dei
Google Workspace (`googleWorkspaceSchema`/`googleWorkspaceDraftSchema`/
`googleWorkspacePatchSchema`, con `clientSecret` write-only e
`clientSecretSet`), caselle per utente (`googleAccountSchema`, senza
segreti), regole di routing della posta per progetto
(`emailRouteSchema`/`emailRoutesPutSchema`), il nuovo kind di notifica
`google.proposal` su `notificationKindSchema` (proposta nata da un'email o
un evento di calendario, blocco opzionale `inboxItemSchema.google` con
mittente/oggetto/segnale/azioni) e il nuovo valore `email` su
`decisionSourceSchema` (conferma di una proposta registrata nel registro
decisioni). Sono il contratto condiviso fra server (valida ed espone), SPA
(disegna Impostazioni → Google, Account → Caselle Google, la sezione Mail
del progetto e la card della proposta) e worker (poller delle caselle,
dal Task 7).
