# Integrazione area 6 «Posta e Calendario», fetta 1: la lettura che c'è e il cassetto Google — parità col prototipo (12 nov 2026)

Cosa della Posta, del Calendario e del cassetto Google del prototipo
(`data/{mail,calendar,drive}/`, `data/model.ts`) arriva sul server vero.
Design: `docs/plans/2026-11-12-integrazione-area6-design.md`; piano:
`docs/plans/2026-11-12-integrazione-area6-fetta1-plan.md`; invarianti:
`docs/invariants/mail-calendar.md`. Le rotte, gli schemi e i gruppi `google`,
`mail` e `calendar` dell'api-client sono di stubwise-72 (F1.1–F1.4); qui il
renderer.

## Renderer (stubwise-94)

Accesi nella build app (`data/integration.ts`): le destinazioni `mail` e
`calendar`; le funzioni `google-account` (il cassetto), `calendar`, `mail` e
`google-sync` («Aggiorna ora»). Restano spenti `google` (il Drive Google,
F5), `calendar-write` (scrivere sul calendario, F4), `meeting-notes`
(riassunto e task di una riunione, F5), `mail-write` (scrivere, F3),
`mail-importance` (importanza, scadenza, «Importanti» e il blocco «Posta
importante», F2) e `mail-proposal-edit` (i campi di una proposta, F2). Il
livello dati è `data/backend/real/{google,mail,mailProposals,calendar}.ts`.

| Voce del prototipo | Build app | Test |
|---|---|---|
| Il cassetto Google (`getGoogleAccount`, «Collega», «Ricollega», «Scollega») | `/api/me/google/accounts`; il cassetto mostra la casella da ricollegare, altrimenti la prima (B(a)); «Collega» chiede il Workspace solo se ce n'è più d'uno (A(a)), apre il consenso nel browser e rilegge le caselle ogni 3 s per 10 minuti; scaduta (`disabledAt`) o senza gli scope nuovi (`missingScopes`, con le funzioni che mancano e senza data) | `real/google.test.ts`, `pages/drive/GoogleAccountCard.app.test.tsx` |
| Caselle e calendari (`listMailboxes`, `listCalendars`) | una per casella; vecchia oltre 5′; scaduta solo se disattivata (una senza gli scope nuovi legge ancora) | `real/google.test.ts`, `real/calendar.test.ts` |
| «Proposte attive per questa casella» | `client.google.setProposals`; spegne solo le proposte | `real/google.test.ts` |
| «Aggiorna ora» (`syncMailbox`, `syncCalendar`) | `client.google.sync`; «in allineamento» finché `syncRequestedAt` non torna null, «non riuscita» se `lastSyncAt` non è avanzato; 429 e `already_queued` non sono errori; scaduta → «Ricollega»; il Calendario allinea ogni casella collegata | `real/googleSync.test.ts`, `real/calendarPage.test.tsx` |
| L'elenco per conversazione (`listMailThreads`) | `client.mail.threads` (tutte le pagine), casella e ricerca (`q`) al server, progetto per nome; una conversazione è della sua casella (`<uuid casella>_<thread Gmail>`) | `real/mailRead.test.ts` |
| La ricerca (⌘K, `searchMail`) | `threads({ q })`, da 2 caratteri, una riga per conversazione | idem |
| Una conversazione (`getMailThread`) | `client.mail.thread` con la casella; l'estratto, e dall'originale (`/original`, già sanificato) l'HTML nel frame isolato, le copie e gli allegati; se l'originale non si legge resta l'estratto; i messaggi di contesto | idem, `real/mailPage.test.tsx` |
| Letto / non letto (`markRead`, `markUnread`) | `unread` di Gmail; `client.mail.setRead` sulla conversazione intera; senza `gmail.modify` è `google_scope_missing` («Ricollega» nel cassetto) | `real/mailRead.test.ts`, `real/mailPage.test.tsx` |
| «Riproponi» (`reproposeMessage`) | dalla proposta fallita o dallo smistamento del messaggio (`reproposals` del server) | `real/mailRead.test.ts` |
| Le proposte accanto all'email (`listMailProposals`, `getMailProposal`) | le card `google.proposal` di `/api/inbox` della casella; ogni azione del modello con la frase del server; il messaggio le ritrova da `proposalIds` | `real/mailProposals.test.ts`, `real/mailPage.test.tsx` |
| Conferma, «Ignora», «Passa al progetto», «Sposta» | `inbox.answer` (`optionIndices` per tutte, `optionIndex` per una), l'opzione «non fare nulla», `hand_to_project`, l'opzione di spostamento col progetto; già decisa da altri è «non riuscita» col motivo | idem |
| «Da decidere» della Home (`listMailDecisions`) | le proposte aperte che posso confermare o passare | `real/mailProposals.test.ts` |
| Il Calendario (`listEvents`, `getEvent`) | `client.calendar.range` dentro la finestra letta (−30/+60 giorni), `client.calendar.event` per id; fuori finestra o non mio `not_found`; «Apri in Google Calendar» apre l'evento | `real/calendar.test.ts`, `real/calendarPage.test.tsx` |
| Le serie (`listSeries`, `configureSeries`) | `client.calendar.series` / `putSeries` (la configurazione intera); accesa senza progetto `choose_project_first` | `real/calendar.test.ts` |
| «Prossimi appuntamenti» della Home | `range` da adesso a fine di domani, senza i rifiutati *(O: il prototipo è la specifica)* | `real/calendar.test.ts`, `real/homePage.test.tsx` |

### Differenze dichiarate

- **Scrivere** (Posta e Calendario), **l'importanza** e i **campi di una
  proposta** sono nascosti (F2, F3, F4), come le altre parti non integrate.
- **Gli invitati** non hanno nome né persona: il server dà l'indirizzo e la
  risposta; io sono io sul mio indirizzo.
- **Una serie** non porta la sua regola: la colonna non la dice a parole.
- **L'elenco della Posta** non ha l'estratto dell'ultimo messaggio; **un
  allegato** non ha la dimensione e si apre da Gmail (come «Apri in Gmail»).
- **Una proposta** mostra la frase del server per ogni azione, non i suoi
  campi né l'estratto letto; non è condivisa fra i destinatari (una per
  casella, `mailbox_owner`); la scelta del progetto di un'email incerta non
  c'è (il worker non la produce più).
- **Il ritorno dal consenso Google** non torna all'app (`stubwise://`):
  il desktop rilegge le caselle (registro).
- **Più account nel cassetto** e **i testi del Drive Google**: con la F5.
