# Integrazione area 6 «Posta e Calendario», fetta 3b: il Calendario con TUTTI gli eventi — parità col prototipo (12 nov 2026)

Decisione del maintainer *(M)*: «Tutti, come il prototipo». Piano di 72:
`docs/plans/2026-11-12-integrazione-area6-fetta3b-plan.md` (le forme per il
renderer sono additive). Il worker salva tutti gli eventi della finestra del
calendario principale di ogni casella, tranne `workingLocation` e
`birthday` *(O, 46)*; solo i candidati diventano proposte. Qui il renderer.

## Renderer (stubwise-94)

Il livello dati è `data/backend/real/calendar.ts` e
`data/backend/real/mailProposalView.ts`; la griglia è
`pages/calendar/EventBlock.tsx`. Ogni campo nuovo ha il suo default per un
server di prima, con un test la cui fixture NON lo porta.

| Voce del prototipo | Build app | Test |
|---|---|---|
| Tutti gli eventi nella griglia | `range` con `fields: "summary"`: la lista LEGGERA (senza le cancellate; descrizione, invitati, conferenza e promemoria dal dettaglio, `event(id)`); la mia risposta dalla riga (`myResponse`), il numero degli invitati (`attendeeCount`) per «N guests» nella vista Giorno | `real/calendar.test.ts` («F3b, dal server (task 6)»), `pages/calendar/EventBlock.test.tsx` |
| Un evento personale | `recognized: false`: «No project», nessun «Suggested by Stubwise», salvo un progetto messo a mano | `real/calendar.test.ts` («F3b: il calendario con TUTTI gli eventi») |
| Chi ha deciso il progetto | `projectBy`: le regole e il modello sono un suggerimento, `manual` è «Set manually»; `null` con un progetto (righe di prima) resta un suggerimento | idem |
| Fuori ufficio, concentrazione, libero | `eventType` e `transparency`: a parola sul blocco, nella riga d'elenco e nel nome accessibile; «Free» anche col contorno tratteggiato. Un tipo sconosciuto non dice niente | `pages/calendar/EventBlock.test.tsx` |
| Le serie | `recognized` anche sulle serie: prima quelle di lavoro, poi per titolo | `real/calendar.test.ts` |
| Le proposte del calendario in «Da decidere» | nella lista della Posta (`/api/me/mail/proposals`, col flag acceso) con `kind: "calendar"`, `messageId` null e l'origine in `calendarOrigin` (`eventId`, `title`, `startsAt`, `allDay`): sorgente `calendar` e la riga d'origine del prototipo; le azioni `create_milestone`, `create_backlog_item` e `acknowledge_reminder` («Visto»); senza `kind` (server di prima) è della posta | `real/mailProposalView.test.ts`, `real/mailProposalsShared.test.ts` |

Il server finto risponde come quello vero (`calendarRangeRoute` in
`real/fakeServer.ts`, condiviso dai test del Calendario e della Home): con
`fields=summary` toglie i campi pesanti e calcola `myResponse` e
`attendeeCount` come `toCalendarItem`.

### Differenze dichiarate

- **Un evento cancellato su Google** lo toglie il server (`fields=summary`):
  il campo `status` della riga è lo stato di Stubwise, non quello di Google,
  quindi il client non lo vede da sé.
- **Passare o spostare una proposta del calendario** non si può (`canHand` e
  `canReassign` falsi, `invalid_selection`): come nel prototipo, che non le
  offre.
- **Un evento con invitati di più progetti** (flag acceso) per ora non
  diventa una proposta *(O, 72)*.
