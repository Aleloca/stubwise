# Area 8 — «Clienti in attesa» dalla posta delle caselle (piano)

*15 nov 2026, 72 (server) per 46; renderer 94. Branch del piano
`docs/area8-waiting-plan` da `feat/area8-f4b`; il codice su un branch
`feat/area8-waiting` dalla stessa base.*

La voce del registro dei rimandi (area 8, «Clienti in attesa», *M* del 14 nov
2026) è il punto di partenza: il blocco della Home resta, ma legato alle EMAIL
delle caselle, non al widget; la versione Support esce dalla F3. Le tre
decisioni del maintainer valgono già: **soglia 24 ore**, **automazioni fuori**,
**una fetta a sé con la cattura della posta inviata**.

Prima di toccare il codice: `docs/invariants/mail-calendar.md` (in
particolare «`mailbox_owner` non include MAI gli admin», «Il cancello
dell'ammissione si allarga col THREAD», «La potatura … legata al THREAD», «Il
poller Google non usa il serializer di progetto», «Nessuna scrittura verso
Google senza un gesto»).

## La definizione (approvata, M)

Un cliente aspetta ME quando un thread delle MIE caselle:

- **(a)** è **ammesso** — almeno un messaggio del thread con `admitted = true`
  — e ATTRIBUITO a un progetto che vedo (`project_id`/`scope_project_ids` di
  un suo messaggio ammesso, la stessa visibilità di `GET /me/mail/threads`);
- **(b)** ha l'**ultimo messaggio** (per `received_at`, CONTESTO compreso) da
  un indirizzo **ESTERNO**: né la mia casella né un'altra casella collegata
  dell'istanza (`google_accounts.email`, attiva);
- **(c)** quell'ultimo messaggio è di più di **24 ore** fa;
- **(d)** **nessun nostro messaggio dopo**: né un messaggio catturato da una
  casella dell'istanza (la mia, o un collega in copia, che sta nella MIA
  casella col suo indirizzo), né un `mail_outgoing` `sent` sullo stesso
  thread (`coalesce(gmail_thread_id, thread_id)`) dopo quel messaggio;
- **(e)** non è rumore: il `signal` dell'ultimo messaggio ammesso classificato
  ≠ `none`, OPPURE la sua importanza è `high`.

Cosa NON è: un thread che aspetta NOI dal cliente (l'ultimo messaggio è
nostro) — lo dicono già le automazioni in `waiting_event` con `replyTo`, che
restano nel loro blocco *(M)*; un invio trattenuto (`mail_outgoing` `queued`
o `sending`): finché non è `sent` il cliente aspetta ancora, ed è giusto.

## Il prerequisito: la posta inviata nel primo giro e nel resync

Com'è oggi (mappa di `apps/worker/src/google/poller.ts`, `sync.ts`):

- **Giro incrementale** (History API, `messageAdded`): la posta inviata DALLA
  casella arriva, e si conserva SOLO su un thread già noto (o se l'ha
  inviata Stubwise), come contesto (`admitted = false`, `status = 'ignored'`,
  mai classificata) — poller.ts:1061-1088, test poller.test.ts:4042-4060.
  Per (d) è già quello che serve.
- **Thread nuovo ammesso**: `ingestThreadContext` (poller.ts:889-938) tira
  dentro TUTTO il thread come contesto, risposte nostre comprese. Anche qui
  (d) è coperto.
- **Primo giro e resync** (history scaduta, 404): UNA query,
  `GMAIL_RESYNC_QUERY = "newer_than:7d -from:me"` (sync.ts:46), tetto 200. La
  posta inviata NON c'è. Il buco: una risposta mandata da Gmail su un thread
  NOTO mentre la history era scaduta (worker fermo, casella disabilitata a
  lungo, history oltre la sua finestra) non entra mai → (d) dà un **falso
  positivo**: «il cliente aspetta» mentre gli abbiamo già risposto.

**Come cambia il poller (W1)**, senza toccare le invarianti:

- Nel primo giro e nel resync, DOPO la query di sempre, una seconda lista
  `newer_than:7d from:me` (stesso tetto, stessa paginazione), e ogni
  messaggio passa dalla STESSA regola del ramo History per la posta inviata:
  si conserva solo su un thread già noto (o inviato da Stubwise), come
  contesto `admitted = false`, `status = 'ignored'`. Il codice è UNO: la
  decisione «posta inviata: conservare o no» si estrae dal ramo History in
  una funzione e la chiamano entrambi.
- Ordine: prima i ricevuti (che possono ammettere un thread nuovo e tirarne
  dentro il contesto), poi gli inviati: un thread diventato noto in questo
  stesso giro prende anche le risposte.
- **Invarianti che restano vere, e perché**:
  - `admitted = false` non diventa mai una card: gli inviati entrano come
    contesto e `ignored`, non si classificano (né proposte né notifiche); il
    blocco «Clienti in attesa» NON è una card e li usa solo per dire «abbiamo
    già risposto» (condizione d), mai per far nascere una riga.
  - Il cancello dell'ammissione NON si allarga: un inviato non ammette mai un
    thread (su un thread non noto si scarta, come oggi).
  - La potatura per thread: gli inviati sono contesto, potati col loro thread
    al secondo passo (nessuna regola nuova).
  - Il poller resta per-casella, senza serializer di progetto, e non scrive
    su Google (è una lettura).
  - Proposte spente: la cattura vale lo stesso (si LEGGE), come il resto
    dell'ingestione.
- **Limite accettato**: oltre 200 inviati in 7 giorni durante un buco, i più
  vecchi restano fuori (lo stesso tetto della lista dei ricevuti).
- *Test* (poller.test.ts, accanto a 381/4042): resync con la history scaduta
  → la risposta mia su un thread noto entra come contesto `ignored`; su un
  thread non noto NO; il primo giro chiede ENTRAMBE le query, nell'ordine;
  proposte spente → si cattura lo stesso; nessun inviato diventa mai
  `admitted = true` né `email_proposals`.

## La lettura (W2): `GET /api/me/waiting-customers`

- **Chi**: chi ha una casella collegata, nessun permesso (è la SUA posta:
  `config.access: { kind: "user" }` e la WHERE su `google_accounts.user_id =
  me` — mai le caselle dei colleghi, mai agli admin per ruolo, la regola
  `mailbox_owner`). Senza caselle: lista vuota.
- **La query**, accanto a quella di `GET /me/mail/threads`
  (`apps/server/src/routes/me-mail.ts:1252-1438`, che raggruppa già per
  `(thread_id, account_id)` con l'ultimo mittente), con le condizioni (a)–(e):
  - ultimo messaggio del thread per `received_at` su TUTTI i messaggi
    (contesto compreso), il suo `from_address` NON in `google_accounts.email`
    (caselle attive dell'istanza);
  - `received_at < now() - 24h`;
  - nessun `mail_outgoing` `sent` sullo stesso thread con `sent_at` dopo (e
    nessun messaggio successivo da una casella dell'istanza: lo dice già
    «l'ultimo è esterno»);
  - almeno un messaggio ammesso, attribuito a un progetto visibile (la
    `visibleScopeSql` di me-mail.ts:207-240);
  - (e) dal messaggio ammesso classificato più recente: `signal <> 'none'` o
    `importance = 'high'`.
  - Ordine: dall'attesa più vecchia; al più 20; `total` per il «+N».
- **La riga** (`waitingCustomerSchema` in `@stubwise/shared`, campi
  additivi con default): `threadId`, `accountId`, `accountEmail`,
  `customer: { name, email }`, `subject`, `project: { id, code, name }`,
  `waitingSince` (l'ultimo messaggio), `signal`, `importance`. Il clic apre
  il thread nella Posta (`/mail/threads/:threadId`, come oggi).
- **Indici**: la query usa `(account_id, thread_id)` e `received_at`; se
  l'EXPLAIN su un dataset realistico lo chiede, un indice parziale nella
  migrazione della fetta (numero libero al momento), altrimenti nessuna
  migrazione.
- *Test* (tutti con un DB vero, server): una riga per un thread che aspetta;
  NEGATIVI — meno di 24 h; l'ultimo è mio; l'ultimo è di un COLLEGA con
  casella collegata; un `mail_outgoing` `sent` dopo; un invio `queued` NON
  conta (aspetta ancora); thread di solo contesto (nessun ammesso); progetto
  non visibile; rumore (`signal = none`, importanza normale); la casella di un
  collega non compare a me, nemmeno se sono full admin; ordine e tetto 20.

## Il client e le forme (W3)

- `client.mail.waitingCustomers()` → `{ items, total }` in `packages/api-client`
  (gruppo `mail`, che già serve `/api/me/mail`), con readerSchema; test di
  parse di una risposta senza i campi facoltativi.
- Nessun cambio a una risposta esistente.

## Il renderer (94)

- R1. Il blocco «Clienti in attesa» della Home sulla rotta nuova: nel
  CATALOGO della Home, mai nelle Home di default ([A 17]); la versione Support
  del prototipo (dalle conversazioni del widget) esce, come deciso.
- R2. Le righe: cliente, oggetto, progetto, «aspetta da N ore/giorni», il
  segnale; il clic apre il thread nella Posta; vuoto = «nessuno ti aspetta».
- R3. La parità: prototipo e app con la stessa definizione (a)–(e).

## Fuori dalla fetta

- Qualunque notifica o automazione su «un cliente aspetta» *(M: automazioni
  fuori)*; il blocco legge, non avvisa.
- I thread che aspettano un collega (la sua casella): mai.
- La posta inviata oltre i 7 giorni del resync, e oltre il tetto di 200.

## Ordine, deploy, rollback

- **ORDINE**: **worker** (W1: la cattura degli inviati al resync) e
  **server** (W2) indipendenti; **caddy** col renderer. Nessuna env.
- Migrazione solo se serve l'indice (sopra). Il blocco funziona anche senza
  W1 deployato, con i falsi positivi del resync (le risposte di un buco).
- **Rollback**: il worker di prima non cattura gli inviati al resync (le
  righe già catturate restano contesto, innocue); il server di prima non ha
  la rotta (il blocco mostra l'errore come ogni blocco della Home).

## Le domande al maintainer

- **[DECIDE] W-1 — «Non mi aspetta più»: si può togliere una riga a mano?**
  Un thread in cui il cliente ha scritto «grazie, tutto a posto» resta
  «in attesa» per sempre finché non rispondiamo (la definizione non lo
  distingue).
  - **a (consigliata)**: no, nella v1. La riga sparisce rispondendo (anche
    da Gmail, ora che la risposta si cattura) o quando il thread si archivia
    nella Posta; il segnale (e) già toglie il rumore. Niente stato nuovo.
  - b: «Non aspetta» sulla riga, che la nasconde FINCHÉ non arriva un
    messaggio nuovo del cliente (una tabella piccola per utente e thread;
    personale, `mailbox_owner`).
- **[DECIDE] W-2 — Il collega in copia che ha risposto.** Se un collega con
  una casella collegata risponde e io sono in copia, la sua risposta sta
  nella MIA casella col suo indirizzo: per (b) l'ultimo messaggio NON è
  esterno, quindi il thread non mi aspetta più.
  - **a (consigliata)**: sì, è giusto così — ha risposto «noi».
  - b: conta solo la MIA risposta (il thread mi aspetta finché non rispondo
    io, anche se ha risposto un collega).
