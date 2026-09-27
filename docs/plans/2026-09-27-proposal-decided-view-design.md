# Una proposta decisa mostra la decisione — design

27 set 2026. Il maintainer conferma una proposta di posta dall'app e il
contenuto della pagina sparisce, sostituito da «This proposal has already been
decided. There is nothing left to choose.». Sembra che l'abbia decisa
qualcun altro. Vuole invece che la pagina mostri la decisione presa: subito
dopo il tap, e ogni volta che la riapre. Decisione sua: **sempre, anche
riaprendola dalle gestite e sul web**.

## §1 — Premesse (verificate su `main` 3a9d7662)

- Dopo la conferma il server marca la notifica gestita e il payload non porta
  più le scelte. `GoogleProposalScreen` (app) cade allora nel ramo senza
  opzioni e mostra `mobile.inbox.google.alreadyDecided`
  (`GoogleProposalScreen.tsx:~355`).
- L'item di inbox porta già `handledAt` e `handledBy`
  (`packages/shared/src/schemas/notification.ts:598-599`): CHI e QUANDO ci
  sono.
- QUALI opzioni sono state scelte **non si conserva da nessuna parte**.
  `markSourceOutcome` (`apps/server/src/services/google-proposal.ts:410-432`)
  scrive solo l'esito dell'azione (per esempio `{type:"backlog_item",
  jobId}`), sulla riga che possiede la proposta: `email_proposals`,
  `email_messages` per lo smistamento, `calendar_events`. Le etichette
  viaggiano solo nella nota Slack di `mirrorDecision`.
- `readGoogle` (`apps/server/src/services/inbox.ts:930`) deriva già un campo
  a lettura, `sourceProposalId`, con un caricamento a lotti
  (`sourceProposalIdsByNotification`, :1169). È il modello da seguire.

## §2 — Salvare cosa è stato scelto (server)

`markSourceOutcome` riceve gli indici scelti e li scrive **dentro l'esito che
già scrive**: `outcome.chosenIndices: number[]`, per la scelta singola
(`[i]`) e per quella multipla. Vale per tutte e tre le sorgenti (posta,
smistamento, calendario). È un campo in più in un jsonb: nessuna migrazione.
Il vocabolario degli esiti (`closed-reason.ts`) guarda `type` e non cambia.
Anche lo stato `failed` (`markSourceFailed`) salva gli indici, per dire
«cosa si è provato a fare».

## §3 — Derivarla a lettura (server)

`InboxGoogle` guadagna `decision`, **nullable con default null**:

```ts
decision: {
  status: "actioned" | "ignored" | "failed",
  chosen: string[],         // le etichette delle opzioni scelte, dall'evento
  error: string | null,     // solo per failed
} | null
```

- Le etichette si prendono da `event.options[chosenIndices]`. L'evento è
  persistito e immutabile, quindi l'indice punta sempre alla stessa etichetta.
- Un nuovo caricatore a lotti, sul modello di
  `sourceProposalIdsByNotification`, legge `status`/`outcome`/`error` della
  riga che possiede ciascuna notifica gestita, nelle tre tabelle, con UNA
  query per tabella e per pagina. Solo per le notifiche gestite.
- **Proposte decise prima di questo cambio**: niente `chosenIndices`
  nell'esito, quindi `chosen: []`. Lo `status` c'è lo stesso. I client
  mostrano solo chi e quando.
- Mai scritto nell'evento: è l'invariante «derivati a lettura».

## §4 — I client

- **App** (`GoogleProposalScreen`): quando la proposta è gestita, al posto di
  «already decided» compare un blocco:
  - «✓ Decided by you · now», oppure «Decided by <nome o email> · 2h ago»;
    «you» se `handledBy` è l'utente corrente, e il tempo relativo da
    `handledAt`;
  - sotto, l'elenco delle etichette scelte;
  - «Nothing to do» per `ignored` senza scelte;
  - per `failed`: «Couldn't be completed», con l'errore breve e un rimando a
    «Riproponi» sul messaggio;
  - senza `decision`, o con `chosen` vuoto, solo la riga chi/quando.

  La fonte (l'estratto letto dal modello) resta sopra: è il contesto della
  decisione. Il blocco compare anche SUBITO dopo il tap, perché la schermata
  rilegge la notifica. Nessuno stato locale da tenere allineato.
- **Web** (`inbox-item.tsx`): la card gestita mostra lo stesso blocco. Il
  campo si legge con `?? null`, perché il web fa un cast e non un parse.
- i18n it e en per tutte le frasi. Il testo generico «already decided» resta
  solo come ripiego quando non c'è nemmeno `handledBy`.

## §5 — Rilascio

Rebuild **server + caddy**; l'app si aggiorna a parte. Il worker non
c'entra. Nessuna migrazione, nessun kind né valore di enum nuovo.

Rollback innocuo: senza il campo, l'app lo legge `null` dal `.default` e il
web dal `?? null`, e tornano alla riga chi/quando. Gli indici già scritti
negli esiti restano, innocui.
