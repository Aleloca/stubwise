# Integrazione area 6 «Posta e Calendario», fetta 5a: le riunioni registrate — parità col prototipo (13 nov 2026)

Cosa delle riunioni registrate del prototipo (`data/mail/transcripts.ts`,
`data/calendar/prep.ts`, `pages/mail/MessageView.tsx`,
`pages/calendar/{MeetingSummary,MeetingPrep}.tsx`) arriva sul server vero.
Piano: `docs/plans/2026-11-12-integrazione-area6-fetta5-plan.md` (bozza di 94,
con le «Correzioni di 72», 22ea1cdd su `feat/area6-f5`); le rotte e gli
schemi sono di stubwise-72, qui il renderer. Decisioni: D9 = a
(`drive.readonly`), la visibilità M, Q1–Q3 *(M)*, la scheda composta nel
client *(O, 46)*, Q-A = a e Q-B = 1 *(O, 46, 13 nov 2026)*. Il Drive Google
(riferimenti, cartelle, allegati come link) è la F5b: il suo codice è già su
questo ramo, dietro il flag `google` SPENTO (Q-B = 1).

⚠️ Il ramo `feat/area6-f5-renderer` accende `meeting-notes` nella build app:
va unito INSIEME (o dopo) il server della F5a, altrimenti le letture delle
riunioni rispondono 404 e la Posta non riconosce l'email di Gemini.

## Renderer (stubwise-94)

Il livello dati è `data/backend/real/{meetings,meetingPrep,mailProposalView}.ts`,
agganciato ai namespace veri `mail` (le quattro letture delle riunioni) e
`calendar` (`getMeetingPrep`, con un rinvio: `meetingPrep.ts` legge da
`calendar` e `mail`).

| Voce del prototipo | Build app | Test |
|---|---|---|
| L'email di Gemini sul messaggio («Recorded meeting», riassunto, evento) | `kind: "transcript"` e `meeting` derivati dal server sulla conversazione; a chi non c'era (`visible` falso) niente titolo, riassunto né link, qualunque cosa arrivi | `real/meetings.test.ts` |
| «Open the transcript» (un avviso nel prototipo) | apre il Google Doc (`docUrl`, solo `https://docs.google.com/document/d/…`), nel messaggio e nel dettaglio dell'evento; il testo intero non arriva mai al client | `real/meetings.test.ts`, `pages/mail/Mail.test.tsx`, `pages/calendar/MeetingSummary.test.tsx` |
| Il Doc che non si legge | `docReason`: `scope_missing` («reconnect your Google account»), `deleted`, `not_shared` (la frase di prima); `too_long` col riassunto «covers only its first part» | `pages/mail/Mail.test.tsx` |
| «Meeting summary» e «Tasks from this meeting» di una riunione passata | `GET /api/me/calendar/events/:id/summary` e `/tasks`; 404 a chi non è invitato (nessun riassunto, come se non esistesse); task solo ai membri (R-I21) | `real/meetings.test.ts` |
| Le proposte della riunione | le condivise della F2 con `kind: "meeting"` e `meetingOrigin` (la sorgente del prototipo `transcript`); la prima decisione chiude per tutti (Q1) | `real/mailProposalView.test.ts` |
| L'invitato SENZA l'email di Gemini (Q1, Q-A = a) | `meetingOrigin.threadId` null (calcolato dal server per chi guarda): «Open the meeting» va all'evento se `eventId` è suo, altrimenti apre il riassunto per nota in un pannello (`GET /api/me/meetings/:noteId` e `/tasks`); la conversazione non si legge mai | `real/meetings.test.ts`, `pages/home/blocks/MailBlocks.test.tsx`, `pages/ComingSoon.test.tsx` |
| La scheda di preparazione | composta nel client (O, 46) dalle letture già filtrate dal server, al più 3 riunioni passate, in parallelo; la chiede una pagina solo con `hasPrep` | `real/meetingPrep.test.ts` |

### Differenze dichiarate

- Il riassunto nel dettaglio dell'evento non dice `too_long`: `MeetingSummary`
  di 72 non porta `docReason` (il messaggio sì). Nel registro dei rimandi.
- Nel pannello per nota le richieste nate non hanno il link al progetto
  (`projectCode: null`); e le task `kind: "request"` non escono ancora dal
  server (rimando di 72).
- Nel prototipo la nota è l'email di Gemini (`messageId` della trascrizione),
  e un invitato è destinatario delle proposte della riunione anche senza
  l'email (`isProposalRecipient`, la decisione M portata nella specifica).
- Lo schema del client scarta i campi nuovi finché 72 non li aggiunge: i test
  della mappatura sono sulle funzioni pure (`meetingOfMessage`,
  `proposalViewOf`).
