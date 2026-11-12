# Integrazione area 6 «Posta e Calendario», fetta 3: scrivere — parità col prototipo (12 nov 2026)

Cosa della scrittura della Posta del prototipo (`data/mail/{compose,send}.ts`,
`pages/mail/Composer.tsx` e vicini) arriva sul server vero. Design:
`docs/plans/2026-11-12-integrazione-area6-design.md` (D6: il server trattiene
l'invio 10 s; D7 = b: bozze di Gmail); piano:
`docs/plans/2026-11-12-integrazione-area6-fetta3-plan.md`. Le rotte, gli
schemi (`@stubwise/shared` `schemas/mail-compose.ts`) e i metodi di
`client.mail` sono di stubwise-72; qui il renderer e il main.

## Renderer e main (stubwise-94)

Accese nella build app: `mail-write` e `mail-claude-draft`. Il livello dati
è `data/backend/real/{mailDrafts,mailSend,mailClaudeDraft}.ts`; il main
carica gli allegati dal disco (`apiUpload.ts`) e regge lo stream della bozza
di Claude (`apiStream.ts`).

| Voce del prototipo | Build app | Test |
|---|---|---|
| Rispondi, Rispondi a tutti, Inoltra, Nuova (`getDraft`) | la bozza indirizzata dal SERVER (`draft()`), dalla casella della conversazione; l'email nuova dalla prima casella collegata; una bozza mai salvata ha l'id del suo posto | `real/mailDrafts.test.ts`, `real/mailCompose.test.tsx` |
| Le bozze (`listDrafts`, `saveDraft`, `discardDraft`, «Annulla» di Elimina) | bozze di Gmail; una cambiata su Gmail nel frattempo è `draft_changed`: il compositore lo dice, «Tieni la mia» (`overwrite`) o «Apri su Gmail» | idem |
| Gli allegati (dal disco, dal Drive, tolti) | riconciliati al salvataggio: un file dal disco si carica una volta (dal main sul desktop, XHR sul web), uno del Drive si allega dal Drive, quello tolto si toglie; i limiti (10, 25 MB) e gli errori del server | `real/mailDrafts.test.ts`, `src/main/apiUpload.test.ts` |
| I destinatari suggeriti | `recipients(q)` da 2 caratteri: il team, poi la propria posta | `real/mailDrafts.test.ts` |
| Invia, «Annulla» (5 s nel prototipo) | 10 s trattenuti dal server (D6); i controlli prima di accodare (destinatari, indirizzo, limiti, allegato, casella) dicono subito l'errore e la bozza resta | `real/mailSend.test.ts`, `real/mailCompose.test.tsx` |
| «Invio…», «Non inviato», «Riprova», «Elimina» | `delivery` del messaggio, solo per chi scrive; un invio fallito non si ritenta da solo | `real/mailSend.test.ts`, `real/mailRead.test.ts` |
| La bozza di Claude in streaming | `POST /api/me/mail/drafts/claude` (SSE): dal main sul desktop, col fetch e il cookie sul web; il testo a pezzi, le task citate, «Ferma»; resta una proposta, non salva né spedisce | `real/mailClaudeDraft.test.ts`, `src/main/apiStream.test.ts`, `real/mailCompose.test.tsx` |

### In arrivo

- **La firma di Gmail** *(M, decisione del maintainer)*: `signature` e
  `signatureStatus` (present, none, scope_missing) sulla bozza, aggiunta dal
  server nel messaggio. Il compositore la mostra sotto il campo, in sola
  lettura, e con `scope_missing` dice che si manda senza firma. Si legge con
  `gmail.modify` (`users.settings.sendAs.get`): niente scope nuovo, e senza
  `gmail.modify` rientra nel «Ricollega» di quello scope.
- **Le proposte di una conversazione** con il filtro `thread` + `account` su
  `/api/me/mail/proposals` (review della F2, punto 9): oggi la pagina della
  conversazione legge l'elenco intero.

### Differenze dichiarate

- **Un'email nuova appena inviata** non ha conversazione finché Gmail non
  gliela dà (dopo i 10 s): si resta sull'elenco col suo «Annulla», e la
  conversazione arriva al giro del poller *(O)*.
- **«Annulla» con un'altra bozza nella stessa conversazione** è rifiutato
  (`draft_slot_taken`): l'unione delle due bozze del prototipo è un rimando
  del server.
- **Un allegato rimasto fuori dai limiti** all'«Annulla» si dice per nome,
  senza dimensione.
- **I file di Google Drive come link** sono della F5; **lo slot «Scrivigli
  anche per email»** di Support (area 8) non c'è.
