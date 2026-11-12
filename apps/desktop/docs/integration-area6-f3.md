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
| Le bozze (`listDrafts`, `saveDraft`, `discardDraft`, «Annulla» di Elimina) | bozze di Gmail, salvate IN FILA (mai due PUT insieme: «Send» aspetta un salvataggio da sé in volo); una cambiata su Gmail nel frattempo è `draft_changed`, anche scoperta da «Send»: il compositore lo dice, «Tieni la mia» (`overwrite`) o «Apri su Gmail»; una casella da ricollegare (`account_unavailable`) lo dice | idem, `pages/mail/Compose.test.tsx` («i salvataggi in fila») |
| Gli allegati (dal disco, dal Drive, tolti) | riconciliati al salvataggio: un file dal disco si carica una volta PER BOZZA (dal main sul desktop, XHR sul web), uno del Drive si allega dal Drive, quello tolto si toglie; i limiti (10, 25 MB, anche nel main per questo percorso) e gli errori del server e del main (`unsupported_type`); l'«Annulla» di Elimina ricarica i file dal disco sulla bozza rimessa e dice per nome quelli che non tornano | `real/mailDrafts.test.ts`, `src/main/apiUpload.test.ts` |
| I destinatari suggeriti | `recipients(q)` da 2 caratteri: il team, poi la propria posta | `real/mailDrafts.test.ts` |
| Invia, «Annulla» (5 s nel prototipo) | 10 s trattenuti dal server (D6): l'avviso e ⌘Z durano quanto resta di `undoUntil` (`undoWindowMs`), non i 5 s di un avviso qualunque; i controlli prima di accodare (destinatari, indirizzo, limiti, allegato, casella) dicono subito l'errore e la bozza resta; una bozza il cui ultimo invio è fallito non riparte: la casella resta con «This email hadn't gone out: use Retry or edit it.» e il fuoco va al messaggio fallito | `real/mailSend.test.ts`, `real/mailCompose.test.tsx` |
| «Invio…», «Non inviato», «Riprova», «Elimina» | `delivery` del messaggio, solo per chi scrive; un invio fallito non si ritenta da solo; «Riprova» trattiene di nuovo e mostra «Undo» solo se la finestra non è già passata (anche dopo un ricaricamento chiude la casella della conversazione giusta); un invio che Gmail ha mandato ma Stubwise non ha registrato (`sent_unrecorded`) è «Sent, status to verify», senza Riprova, Modifica né Elimina | `real/mailSend.test.ts`, `real/mailRead.test.ts`, `real/mailCompose.test.tsx` |
| Le proposte di una conversazione | `proposals({ thread, account })`: solo quelle dei suoi messaggi (review della F2, punto 9) | `real/mailProposalsShared.test.ts`, `real/mailPage.test.tsx` |
| La firma di Gmail *(M)* | `signature` e `signatureStatus` della bozza: sotto il campo, in sola lettura (la aggiunge il server all'invio, mai nel corpo); senza il permesso per leggerla lo dice. Si legge con `gmail.modify`, nessuno scope nuovo | `real/mailDrafts.test.ts`, `real/mailCompose.test.tsx` |
| La bozza di Claude dal riquadro (`fillMailBody`, sempre B) | la scheda la conferma sul server, che scrive SOLO il corpo nella bozza Gmail di chi conferma; se Gmail non la salva (`effectFailure: "mail_not_saved"`, `?? null` per un server di prima) la scheda non dice «Done» ma «Not saved to Gmail», con «Copy the text» (`args.text`); «Riprova» è nel registro | `real/claudeChatActionsPage.test.tsx` |
| La bozza di Claude in streaming | `POST /api/me/mail/drafts/claude` (SSE): dal main sul desktop, col fetch e il cookie sul web, con la modalità della casella (Inoltra, Rispondi a tutti) e l'indicazione al più 2000 caratteri (campo, main e server); il testo a pezzi, le task citate, «Ferma»; resta una proposta *(O, review F3)*: messo nel campo non rende la bozza da salvare finché la persona non lo tocca o non preme «Send» | `real/mailClaudeDraft.test.ts`, `src/main/apiStream.test.ts`, `real/mailCompose.test.tsx` |

### Differenze dichiarate

- **Un'email nuova appena inviata** non ha conversazione finché Gmail non
  gliela dà (dopo i 10 s): si resta sull'elenco col suo «Annulla», e la
  conversazione arriva al giro del poller *(O)*.
- **«Annulla» con un'altra bozza nella stessa conversazione** ferma l'invio
  lo stesso (mai un'email che parte dopo «Annulla»): il testo torna **non
  salvato** (`unsaved`) e il compositore lo riapre con la riga «Not saved:
  this conversation already has another draft. Saving replaces it.», senza
  salvarlo da sé (né scrivendo, né chiudendo); chiusa senza decidere (Esc,
  «Close», un'altra conversazione, un'altra persona) torna in attesa coi
  campi di quel momento, per persona, e «Reply» la riapre; «Save» lo scrive sopra
  l'altra bozza (`overwrite`), «Discard» chiude, e la copia resta fra le
  bozze di Gmail coi suoi allegati (detti per nome). «Send» è spento finché
  non si decide. Vale anche per «Edit» di un invio fallito. Il prototipo
  unisce le due bozze; l'unione resta un rimando del server.
- **Un allegato rimasto fuori dai limiti** all'«Annulla» si dice per nome,
  senza dimensione.
- **I file di Google Drive come link** sono della F5; **lo slot «Scrivigli
  anche per email»** di Support (area 8) non c'è.

### Review del renderer (12 nov 2026)

Nessun critico; le 12 voci (5 importanti, 7 minori) sono corrette sul ramo
`feat/area6-f3-renderer`, ognuna con un test rosso prima: la finestra di
«Annulla» del server (1, 2), gli allegati all'«Annulla» di Elimina (3), la
bozza non salvata che non si perde (4), il testo di Claude che non si salva da
sé (5), la modalità e il tetto dell'indicazione (6, 7), i salvataggi in fila
(8), `draft_changed` su «Send» (9), i codici non mappati e il «Riprova» dopo
un ricaricamento (10), il tetto di 25 MB nel main (11), `sent_unrecorded`
(12). In più, su decisione di 46, «Send» su un invio già fallito.
