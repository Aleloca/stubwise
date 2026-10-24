# Area 4 — parità con il web (25 ott 2026)

Il web non ha una chat: questa area chiude le voci **Slack** dell'inventario
(`web-inventory.md`: Team, Settings → Account, Settings → Slack, Settings →
Notifications, «Integrations that create tickets») e non porta altro. Percorsi
relativi a `src/renderer/`. Stessa regola delle aree 2 e 3: ogni test citato
esercita davvero quella voce; dove una voce è **assente per scelta** (la
Chat sostituisce Slack del tutto, design «Slack si spegne») non c'è niente da
testare e lo si scrive («nessun test: non c'è»); «area N» = voce assegnata a
un'area successiva; ciò che non ha un posto sta in «Buchi», non è stato
costruito.

## Slack → «sostituite dalla Chat»

| Voce dell'inventario | Cosa la sostituisce | Dove | Test |
|---|---|---|---|
| Impostazioni Slack (`/settings/slack`: signing secret, bot token, URL del comando, badge) | niente: la Chat è dentro l'app, non c'è un'app Slack da configurare | — (nessuna pagina `slack` nelle impostazioni: `pages/settings/` ha solo progetto e stati) | nessun test: non c'è |
| Identità Slack di un membro (collega/scollega, selettore dei membri Slack, «Configure Slack in Settings») | il membro **è** la persona della Chat: menzioni, DM e canali usano la stessa identità dell'app | `pages/chat/PeoplePicker.tsx`, `data/chat/*` (le persone sono quelle del modello) | nessun test: non c'è; il selettore persone è coperto da `pages/chat/ChannelSettings.test.tsx` («Laura crea un privato in AUD con un membro del progetto, e ci arriva») |
| DM Slack (toggle «Slack DM» delle notifiche; bottoni approva/rilancia/snooze nel DM) | messaggi diretti e gruppi della Chat; le notifiche delle **menzioni dirette** (R-G6: `@persona`, mai `@canale`/`@reparto`) | `pages/chat/NewDmDialog.tsx`, `data/chat/writes.ts`, `data/seed/chat/notifications.ts` (seed) | `pages/chat/ChannelSettings.test.tsx` («al più 8 persone compresa chi scrive; con le stesse persone riapre la conversazione», «un gruppo nuovo con il primo messaggio…», «i DM altrui: assenti dalla colonna e irraggiungibili dall'indirizzo»), `data/chat/signals.test.ts` («chat: R-G6 — solo le menzioni dirette avvisano») |
| «Invita da Slack» (Team → inviti) | niente: gli utenti dell'app sono già le persone della Chat, non c'è un elenco di membri Slack da cui invitare | — | nessun test: non c'è |
| Comando slash `/docs` (domanda sulla documentazione in Slack) | **@Claude** in un thread: la risposta cita pagine, task e file, e le proposte si confermano sul posto (R-G1) | `pages/chat/ThreadPanel.tsx`, `pages/chat/ClaudeReply.tsx`, `data/chat/claude.ts` | `pages/chat/ThreadPanel.test.tsx` (««@Claude» scritto nel canale: per chi l'ha chiamato il pannello si apre da solo su quel thread», «scrivendo «@Claude» compare l'avviso: agirà come te…», «la risposta di Claude arriva dal vivo, «called by» chi l'ha chiamata; Stop solo per lei»), `data/chat/claude.test.ts` |
| Domande dell'agente nei DM Slack (`job.awaiting_input` → messaggio con le opzioni) | «Da decidere» in Home (area 3) **e** la domanda di @Claude a chi l'ha chiamato nel thread (R-G4): rispondere in un posto chiude l'altro | `pages/home/blocks/ChatDecisionItems.tsx`, `DecideBlock.tsx`, `pages/chat/ThreadPanel.tsx`, `data/chat/claude.ts` (risposta alla domanda) | `pages/chat/ThreadPanel.test.tsx` («la domanda di Claude: risponde solo chi ha chiamato, e la risposta continua (R-G4)», «chi non ha chiamato legge la domanda e «Waiting for …»…»), `pages/home/blocks/DecideBlock.test.tsx` («@Claude: la domanda al chiamante è anche qui; rispondere qui la chiude nel thread», «@Claude: rispondere nel thread la toglie da qui»), `data/chat/claude.test.ts` («@Claude: la domanda a chi chiama (R-G4)») |
| Ticket con sorgente «slack» (badge `Slack`, filtro per sorgente) | resta **dato storico leggibile**, nessuna nuova entrata da Slack | `tasks-ui/SourceMark.tsx`, `data/model.ts` (`TaskSource`) | nessun test nuovo in quest'area |

## Webhook in uscita → area 9

«Outgoing webhook» (formati Slack, Discord, JSON generico; eventi; invio di
prova) di Settings → Notifications **non è chat**: è un'integrazione verso
l'esterno e resta alle impostazioni di progetto → **area 9**. Nessun lavoro in
quest'area, nessun test.

## Voci nuove dell'area, senza equivalente web

Canali (aperti e privati, per progetto e dell'azienda), DM e gruppi, thread
(«Threads»), «Mentions», sfoglia i canali, reazioni, modifica/eliminazione,
ricerca nella Chat e nella palette ⌘K, impostazioni del canale. Le coprono i
test accanto ai componenti: `ChannelView.test.tsx`, `ThreadPanel.test.tsx`,
`ChatColumn.test.tsx`, `ChannelSettings.test.tsx`, `ChatSearch.test.tsx`,
`flow.test.ts`, `search.test.ts` (tutti in `pages/chat/`) e `data/chat/*.test.ts`.

## Buchi

Non costruiti:

1. **Stato «quota esaurita» di @Claude nei thread** (ruling R-G4). Il
   prototipo non ha un modello di quota per le chiamate dalla Chat, quindi un
   thread non può mai mostrare «Claude non può rispondere: quota esaurita» e
   la risposta di Claude fallisce solo per i motivi già modellati (codici di
   errore in `data/chat/claude.ts`, testo in i18n). Costo: nessuno nel
   prototipo; va costruito con il modello di quota.

## Riassegnate

1. **Webhook in uscita** (Settings → Notifications) → **area 9**.
2. **Team → inviti e identità** in generale (ruolo, identità git/Bitbucket,
   reset password e 2FA, inviti con permessi) → non sono voci Slack; restano
   all'area che possiede Team. Di Slack sparisce solo il collegamento.
