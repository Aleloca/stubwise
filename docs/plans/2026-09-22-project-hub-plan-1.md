# Piano — Hub del progetto, TAPPA 1 (22 set 2026)

Design: `docs/plans/2026-09-22-project-hub-design.md`.

Perimetro di questa tappa (design §9.1): **l'impalcatura a sezioni, i
conteggi, e le tre aree del LAVORO** — ticket, backlog, inbox — con le loro
tre schermate. Repository, documentazioni, roadmap, monitor e impostazioni
sono le tappe 2 e 3: **non si iniziano qui**, nemmeno «già che ci siamo».

---

## Task 1 — Il totale nelle pagine di ticket e backlog

`packages/shared/src/schemas/{ticket,backlog}.ts` + le due rotte di lista in
`apps/server/src/routes/`.

`ticketPageSchema` e `backlogPageSchema` sono oggi `{ items, nextCursor }`:
aggiungere `total: z.number().int().optional()`, calcolato con un `count(*)`
sulla **stessa `where`** della lista (non un secondo criterio: due filtri che
divergono darebbero un numero che non corrisponde alle righe).

⚠️ `.optional()` e non obbligatorio, per la regola di sempre (CLAUDE.md,
«solo cambi additivi»): un'app nuova che parla con un server più vecchio non
lo riceve, e la sezione deve degradare mostrando le righe senza il numero —
mai una schermata rotta. Test che parsa una pagina **senza** `total`.

⚠️ Sul **web** quel campo non lo legge nessuno, e va bene; ma `lib/api.ts` fa
un cast e non un parse, quindi se un domani lo leggesse serve `?? null` nel
punto di lettura (design §2.1).

---

## Task 2 — L'impalcatura: una sezione, riusata da tutte

`apps/mobile/src/components/projects/HubSection.tsx` (nuovo).

Una sezione dell'hub: etichetta con conteggio, corpo (le righe di anteprima),
e l'azione «vedi tutte ›». Prende uno stato esplicito — in attesa, errore,
vuota, piena — perché **ogni sezione carica per conto suo** (design §4) e
deve saper mostrare il proprio guasto senza portare giù la pagina.

⚠️ **Nessun `Suspense` che sospenda l'hub** e nessun caricamento «quando
entra in vista»: sei richieste piccole e indipendenti, `useQuery` non
suspense, come fa già il web per le sezioni secondarie. Il precedente di
`BriefRow` (fetch al primo tocco) **non** si applica qui: una sezione che
carica solo al tocco non dà la panoramica che la schermata esiste per dare.

La sezione vuota **si mostra**, con una riga che dice che non c'è niente: un
progetto senza backlog deve poterlo dire, altrimenti chi guarda non sa se è
vuoto o non è arrivato.

---

## Task 3 — Le tre schermate nuove e la navigazione

`apps/mobile/src/app/navigation.tsx` — tre rotte nuove in
`ProjectsStackParamList`: `Tickets`, `ProjectBacklog`, `ProjectInbox`, ognuna
con `{ projectId: string; projectName: string }`.

`projectName` viaggia come parametro (non si rilegge dal server): serve alla
riga «‹ STUBWISE» e all'header, ed è già in mano a chi naviga — stessa scelta
di `backLabel` del 21 settembre.

L'indietro torna all'hub, la barra in basso resta su PRJ (design §5).

---

## Task 4 — Ticket del progetto

Sezione nell'hub (le prime 2 righe, con la riga ricca di ieri —
`ticketHeading`) e schermata `Tickets` con i filtri di stato in cima:
APERTI / IN CORSO / TUTTI.

**È l'unica delle tre senza niente da riusare**: un elenco ticket non esiste
in nessun punto dell'app (verificato: lo stack Projects ha solo `List`,
`Detail`, `Ticket`). Schermata nuova vera.

Le righe riusano `ticketHeading` (`lib/ticket-labels.ts`) — `#numero ·
priorità · tipo · aperto …` — così l'elenco e l'hub dicono la stessa cosa
nello stesso modo.

---

## Task 5 — Backlog del progetto

⚠️ **La lista NON si riscrive** (design §5). `BacklogListCard` esiste già ma
è dichiarata **dentro** `BacklogScreen.tsx` e non esportata: va estratta in
`components/backlog/BacklogListCard.tsx` e importata da entrambe le
schermate. Estrarre, non copiare: due card che divergono sono il difetto che
questo repo insegue ovunque.

Se l'estrazione risultasse contorta (la card dipende da stato locale della
schermata), **fermati e dillo** invece di copiarla: la risposta giusta è
renderla estraibile.

Nell'hub la sezione mostra la ripartizione per stato («3 pronte · 2 in
analisi · 1 nuova»), non le prime righe: di un backlog interessa *quanto è
maturo*, non quali sono le prime tre voci in ordine di data.

---

## Task 6 — Inbox del progetto

Stessa forma del Task 5, più semplice: `InboxCard` è **già** un componente a
sé in `components/inbox/`. La schermata nuova monta quello con
`inbox.list({ projectId, status: "pending" })`.

Nell'hub, le prime due notifiche da gestire.

⚠️ L'inbox è PER UTENTE: il filtro di progetto non allarga niente — mostra le
notifiche **del viewer** su quel progetto. Non va presentata come «le
notifiche del progetto», che suggerirebbe di vedere anche quelle altrui.

---

## Task 7 — L'hub, montato

`apps/mobile/src/screens/projects/ProjectDetailScreen.tsx`: il polso resta in
cima dov'è, le tre sezioni nuove sotto, poi brief e report in fondo dove sono
già. Ordine e testi: design §3.

⚠️ Il polso **non si tocca**: è l'unica parte che dice cosa fare adesso, ed è
appena stato arricchito. Le sezioni nuove gli stanno sotto, non al posto suo.

---

## Task 8 — Verifica

`pnpm --filter @stubwise/shared... build` prima di credere a un rosso locale
(i test leggono `dist`). Poi `pnpm typecheck`, `pnpm test`, `pnpm lint` dalla
radice.

⚠️ Aggiungendo `total` alle due pagine, **completa ogni fixture dei test**
dell'app e del web che costruisce una `TicketPage`/`BacklogPage` — ma
lasciane **almeno una senza**, apposta, con un commento che dice che è il
caso del server più vecchio (CLAUDE.md: la fixture incompleta è la prova che
la difesa c'è).

⚠️ Se aggiungi una chiamata nuova a una schermata, **aggiungi il metodo al
doppio del client PRIMA di scrivere il test**: un doppio parziale non fa
fallire niente, e il test passa senza aver esercitato nulla.

Il maintainer verifica una cosa sola (design §10).
