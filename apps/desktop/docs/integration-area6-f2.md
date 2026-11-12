# Integrazione area 6 «Posta e Calendario», fetta 2: la classificazione nuova e la proposta condivisa — parità col prototipo (12 nov 2026)

Cosa della classificazione e delle proposte della Posta del prototipo
(`data/mail/{reads,proposals,visibility}.ts`, `pages/mail/`) arriva sul
server vero. Design: `docs/plans/2026-11-12-integrazione-area6-design.md`
(D3, D4); piano: `docs/plans/2026-11-12-integrazione-area6-fetta2-plan.md`
(§4, le forme per il renderer); invarianti: `docs/invariants/mail-calendar.md`.
Le rotte, gli schemi (`@stubwise/shared` `schemas/mail-proposals.ts`, le
righe e i messaggi di `schemas/google.ts`) e i metodi di `client.mail` sono
di stubwise-72; qui il renderer.

## Renderer (stubwise-94)

Accese nella build app, oltre alla F1 (`docs/integration-area6-f1.md`):
`mail-importance`, `mail-proposal-edit`, `mail-contributors`. Resta spento
`mail-write` (scrivere, F3). Il livello dati è
`data/backend/real/{mail,mailProposals,mailProposalView,mailKeys}.ts`.

| Voce del prototipo | Build app | Test |
|---|---|---|
| Importanza e scadenza di una conversazione, «in analisi», «fallita», i progetti, l'estratto | i campi delle righe di `threads()`; i progetti per id (per nome solo da un server di prima) | `real/mailClassify.test.ts` |
| Filtri per importanza e progetto | `threads({ importance, project })`, riguardati qui per un server di prima | idem |
| «Importanti» e il blocco Home «Posta importante» | `threads({ important: true })`: un messaggio alto non letto | idem, `real/mailPage.test.tsx`, `real/homePage.test.tsx` |
| La classificazione di un messaggio (progetti, importanza, scadenza, progetti incerti) | `classification` dei messaggi di `thread()`; da un server di prima resta la regola della F1 | `real/mailClassify.test.ts` |
| Le proposte accanto all'email e in «Da decidere» | `client.mail.proposals({ message, status })` e `proposal(id)`, convertite in `mailProposalView.ts`: le azioni coi nomi e gli argomenti del prototipo, permessi, incaricati fuori dal progetto, condivisione e origine dal server | `real/mailProposalView.test.ts`, `real/mailProposalsShared.test.ts` |
| Conferma, anche parziale, coi campi cambiati | `confirmProposal(id, { indices, edits })`; tutto o niente, l'esito coi codici nati | idem, `real/mailPage.test.tsx` |
| L'incaricato fuori dal progetto come Contributor | `confirmProposalWithMembers` (la riconferma, le regole di Membri: `escalation`, `target_above`) | `real/mailProposalsShared.test.ts` |
| Ignora, Passa al progetto, Sposta, «Quale progetto?» | `ignoreProposal`, `handProposal`, `reassignProposal`, `chooseProposalProject` | idem, `real/mailPage.test.tsx` |
| La proposta condivisa: «Confermata da X», «Also for …» | `decidedBy`, `sharedWith`; chi decide dopo ha `already_handled` con chi | `real/mailProposalsShared.test.ts` |
| L'interruttore delle proposte per casella | spegne solo la classificazione della propria posta (decisione B del maintainer); la frase accanto lo dice | `pages/preferences/Personal.test.tsx` |

### Differenze dichiarate

- **Le proposte di prima** (classificazione vecchia, una per casella) si
  leggono e si decidono dalla stessa rotta, conferma parziale compresa, ma
  i campi non si modificano: la scheda lo dice («This proposal can't be
  edited. Confirm it as it is.»). Con `editable` dal server, «Edit» si
  nasconderà lì.
- **Lo smistamento di prima** (`email_triage`) resta sull'inbox e nella Posta
  non compare.
- **Una decisione da registrare** non porta il titolo: la scheda dice la
  frase del server.
- **Chi riceve una proposta passata** senza esserne destinatario la vede e la
  decide (`proposals({ status: "handed" })`), ma non gli nasce una card
  nell'inbox (registro di stubwise-72).
