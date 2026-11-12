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
| Le proposte di una conversazione | `proposals({ thread, account })`: solo quelle dei suoi messaggi (review della F2, punto 9) | `real/mailProposalsShared.test.ts`, `real/mailPage.test.tsx` |
| La firma di Gmail *(M)* | `signature` e `signatureStatus` della bozza: sotto il campo, in sola lettura (la aggiunge il server all'invio, mai nel corpo); senza il permesso per leggerla lo dice. Si legge con `gmail.modify`, nessuno scope nuovo | `real/mailDrafts.test.ts`, `real/mailCompose.test.tsx` |
| La bozza di Claude dal riquadro (`fillMailBody`, sempre B) | la scheda la conferma sul server, che scrive SOLO il corpo nella bozza Gmail di chi conferma; se Gmail non la salva (`effectFailure: "mail_not_saved"`, `?? null` per un server di prima) la scheda non dice «Done» ma «Not saved to Gmail», con «Copy the text» (`args.text`); «Riprova» è nel registro | `real/claudeChatActionsPage.test.tsx` |
| La bozza di Claude in streaming | `POST /api/me/mail/drafts/claude` (SSE): dal main sul desktop, col fetch e il cookie sul web; il testo a pezzi, le task citate, «Ferma»; resta una proposta, non salva né spedisce | `real/mailClaudeDraft.test.ts`, `src/main/apiStream.test.ts`, `real/mailCompose.test.tsx` |

### Differenze dichiarate

- **Un'email nuova appena inviata** non ha conversazione finché Gmail non
  gliela dà (dopo i 10 s): si resta sull'elenco col suo «Annulla», e la
  conversazione arriva al giro del poller *(O)*.
- **«Annulla» con un'altra bozza nella stessa conversazione** ferma l'invio
  lo stesso (mai un'email che parte dopo «Annulla»): il testo torna **non
  salvato** (`unsaved`) e il compositore lo riapre con la riga «Not saved:
  this conversation already has another draft. Saving replaces it.», senza
  salvarlo da sé (né scrivendo, né chiudendo); «Save» lo scrive sopra
  l'altra bozza (`overwrite`), «Discard» chiude, e la copia resta fra le
  bozze di Gmail coi suoi allegati (detti per nome). «Send» è spento finché
  non si decide. Vale anche per «Edit» di un invio fallito. Il prototipo
  unisce le due bozze; l'unione resta un rimando del server.
- **Un allegato rimasto fuori dai limiti** all'«Annulla» si dice per nome,
  senza dimensione.
- **I file di Google Drive come link** sono della F5; **lo slot «Scrivigli
  anche per email»** di Support (area 8) non c'è.
