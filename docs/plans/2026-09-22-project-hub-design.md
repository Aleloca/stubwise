# L'hub del progetto sull'app (22 set 2026)

## §1 — Cosa mostra oggi il dettaglio progetto, misurato

Sull'app: il **polso** (cinque secchi di ticket), il conteggio delle voci di
backlog pronte, il **brief settimanale** e il **report di ieri**. Basta —
`ProjectDetailScreen.tsx` finisce lì.

Sul **web** lo stesso progetto ha undici blocchi: impostazioni (con i cinque
interruttori), segui/non segui, repository, chiave d'integrazione, widget,
regole della posta, server di monitoraggio, ambienti, plugin, milestone con
il rimando alla roadmap, e l'eliminazione.

**Quello che manca all'app non è solo "il resto del web"**: mancano anche
cose che sul web non stanno nel progetto ma in una pagina globale filtrabile
— l'elenco dei ticket (`/tickets?projectId=`), il backlog (`/backlog`), la
posta in arrivo (`/inbox`), le documentazioni. Un operatore che vuole sapere
«a che punto è questo progetto» oggi, dall'app, vede quattro cose su una
dozzina.

## §2 — Le nove aree, e cosa costa ciascuna (verificato leggendo il codice)

| area | rotta server | nel client dell'app | schermata dove atterrare |
|---|---|---|---|
| ticket | `GET /api/tickets?projectId=` | ✅ `tickets.list({projectId})` | ❌ **nessun elenco ticket nell'app** |
| backlog | `GET /api/backlog?projectId=` | ✅ `backlog.list({projectId})` | ⚠️ il tab BLG non sa filtrare |
| inbox | `GET /api/inbox?projectId=` | ✅ `inbox.list({projectId})` | ⚠️ il tab INB non sa filtrare |
| documentazioni | `GET …/doc-spaces` | ✅ `docs.projectSpaces(id)` | ✅ tab DOC |
| repository | dentro `GET /api/projects/:id` | ✅ `projects.get` | ❌ **nessuna schermata repository** |
| monitor | `GET /api/servers?projectId=` | ❌ **nessun gruppo `servers`** | ❌ nessuna |
| milestone / roadmap | `GET …/milestones` | ✅ `projects.milestones(id)` | ❌ nessuna |
| impostazioni | `PATCH /api/projects/:id` | ❌ **nessun `patch`** | ❌ nessuna |
| brief / report / decisioni | ✅ | ✅ | ✅ già nel dettaglio |

**La notizia buona**: ticket, backlog e inbox si filtrano **già** per
progetto — `projectId` è nei filtri che l'app usa da sempre. Nessun lavoro
server per tre aree su nove.

**Le due lacune del client**: i server di monitoraggio e la modifica delle
impostazioni. Per i primi c'è un ostacolo in più, sotto (§6).

### ⚠️ §2.1 — I conteggi NON sono gratis, e l'anteprima li promette

`ticketPageSchema` e `backlogPageSchema` sono `{ items, nextCursor }`:
**nessun totale**. Una riga «TICKET · 14 aperti» oggi non è ottenibile senza
scaricare tutte le pagine — che è esattamente ciò che una schermata di
sintesi non deve fare.

Va quindi aggiunto un `total` a entrambe le risposte, `.optional()` come ogni
campo nuovo che l'app legge (CLAUDE.md), calcolato con un `count(*)` sulla
stessa `where` della lista. Costo: una query in più per ogni lista, anche sul
web, che oggi non lo chiede. È il prezzo onesto della forma approvata; senza,
l'alternativa è un'anteprima che mostra tre righe e non sa dire «di quante».

## §3 — La forma approvata

Una pagina che scorre. In cima resta il **polso**, che è l'unica parte che
dice *cosa fare adesso*; sotto, una sezione per area con conteggio, le prime
due o tre righe vere e «vedi tutte ›».

```
‹ PROGETTI           Stubwise            ⌕
───────────────────────────────────────────
 ● 2 aspettano te

ASPETTA QUALCUNO · 2                 vedi ›
 #31 · alta · richiesta
 Export CSV clienti          RISPONDI ›

FERMO · 8                            vedi ›
 #27 · urgente · guasto
 Error: write EPIPE               19 g

TICKET · 14 aperti                   vedi ›
 #33 · media · guasto · aperto 3 g fa
 #35 · bassa · attività · aperto 1 g fa

BACKLOG · 6                          vedi ›
 3 pronte · 2 in analisi · 1 nuova

INBOX · 4 da gestire                 vedi ›
 Domanda dell'agente su #27
 PR #38 pronta al merge

REPOSITORY · 3                       vedi ›
DOCUMENTAZIONE · 3 spazi             vedi ›
MONITOR · 2 server · 3 controlli giù vedi ›
ROADMAP · 4 milestone                vedi ›

IMPOSTAZIONI                         apri ›
Brief settimanale                        ›
Report di ieri                           ›
```

**L'ordine non è alfabetico né storico**: scende da *cosa devi fare* (polso)
a *cosa c'è da fare* (ticket, backlog, inbox) a *di cosa è fatto* (repository,
documentazione, monitor, roadmap) a *com'è configurato* (impostazioni). Chi
apre l'hub dieci volte al giorno trova in alto la risposta che cerca nove
volte su dieci.

## §4 — Sei richieste all'apertura, e perché va bene così

L'hub apre con: `projects.get` (nome, impostazioni, repository — una sola
chiamata per tre sezioni), poi ticket, backlog, inbox, documentazioni,
monitor e milestone. Il polso è **già in cache** (lo ha caricato la lista dei
progetti da cui si arriva).

Tutte con `limit` basso (2-3 righe) e **ognuna indipendente**: è il pattern
già usato dal web per le sezioni secondarie (`ProjectServersSection` usa
`useQuery`, non suspense, e gestisce da sé attesa ed errore). Conseguenza
voluta: **una sezione che fallisce mostra il suo errore e le altre restano
utilizzabili** — l'hub non è mai una schermata bianca perché il monitor non
risponde.

⚠️ **Niente `Suspense` che sospenda l'intera pagina** e niente
caricamento «quando la sezione entra in vista»: la prima trasformerebbe il
guasto di un'area nel guasto di tutte, la seconda è un meccanismo che questa
app non ha in nessun punto e costerebbe più di quanto rende con sei richieste
piccole.

Il precedente da NON copiare qui è `BriefRow`/`ReportRow`, che caricano al
primo tocco: per loro va bene (sono documenti lunghi, e nessuno li apre a
ogni visita), ma una sezione che carica solo al tocco non dà la panoramica
che questa schermata esiste per dare.

## §5 — Dove atterra «vedi tutte»

**Dentro il progetto**, sempre: ogni area apre una schermata dello stack
`Projects`, e l'indietro torna all'hub. La barra in basso non si sposta, e la
riga «‹ STUBWISE» dice da dove si viene — la stessa che abbiamo messo il 21
settembre sui ticket.

Cinque schermate nuove: **ticket**, **backlog**, **inbox**, **repository**,
**monitor** del progetto. Documentazioni e roadmap hanno già dove atterrare
(il tab DOC e le milestone).

⚠️ **Le liste NON si riscrivono.** Backlog e inbox hanno già la loro lista
nei tab BLG e INB: le schermate nuove montano **quegli stessi componenti**
con il progetto già filtrato. Due liste che fanno la stessa cosa in due posti
divergono — è il difetto che questo repo insegue ovunque (due regole scritte
in due lingue), e qui si eviterebbe per un motivo debole («era più veloce»).
Se un componente non è estraibile senza contorsioni, va detto nel piano: la
risposta giusta è renderlo estraibile, non copiarlo.

Per i **ticket** non c'è niente da riusare — l'elenco non esiste in nessun
punto dell'app — quindi è una schermata nuova vera, con i filtri di stato in
cima (APERTI / IN CORSO / TUTTI) e la riga ricca di ieri.

## §6 — Il monitor: cruscotto pieno, e lo schema che va spostato

Decisione del maintainer: **cruscotto completo**, come sul web — CPU col
grafico, memoria, disco, versione dell'agente, conteggio dei controlli. Non
il semaforo: qui il monitor lo guarda chi amministra le macchine, e avere
tutto sul telefono evita di aprire il portatile.

⚠️ **L'ostacolo non è la UI, è dove vive lo schema.** `serverViewSchema` è
dichiarato **dentro `apps/server/src/routes/servers.ts`**, non in
`packages/shared` — verificato leggendo il file, non assunto. L'app parsa
davvero le risposte (`readerSchema(schema).parse`), quindi senza lo schema in
`shared` non può leggere quella rotta affatto. Va spostato, e il web ha già
un terzo `ServerView` scritto a mano in `lib/api.ts`: **lo spostamento non
cambia nessuna risposta** (è la stessa forma), quindi è sicuro, ma chi lo fa
allinei anche il tipo del web invece di lasciarne tre.

Il dettaglio di un server (`GET /api/servers/:id`) porta in più lo snapshot
corrente — servizi scoperti, dischi per mount, l'istante del campione — e ha
lo stesso problema, con lo stesso rimedio.

## §7 — Le impostazioni: chi può cosa, e chi lo decide

I cinque interruttori del progetto (aggiornamento automatico dei documenti,
report giornaliero, backlog, pulse con la cadenza, brief settimanale) più
nome e descrizione.

**La regola è quella del web, e non si reinventa**: un admin modifica, un
operatore **vede in sola lettura** — con la stessa riga che spiega perché
(`projects:detail.readOnlyHint`). Il gate vero resta sul server, che arbitra
i permessi: l'app non deduce un permesso dal proprio ruolo per NASCONDERE
un'azione che il server poi permetterebbe, né viceversa.

⚠️ La copia di una regola di permessi dentro l'app è la parte che **non
possiamo aggiornare** (si aggiorna dagli store): vale qui la stessa lezione
di `canMerge` — dove una decisione di ruolo serve in lettura, la calcola il
server. Per le impostazioni il server già lo fa (risponde 403), quindi
l'app mostra il form solo quando il ruolo è admin e accetta che il rifiuto
finale venga da lì.

## §8 — Cosa NON entra nell'hub, e perché

- **I file d'ambiente dei repository** (`.env` cifrati, visibili nel
  dettaglio repository sul web). Sono segreti, e portarli su un telefono è
  una decisione di prodotto a sé — non un pezzo di «mostrare tutto». Il
  dettaglio repository dell'app mostra nome, URL, branch, stato del webhook e
  il rimando alla documentazione; i valori d'ambiente no.
- **L'eliminazione del progetto.** Un'azione irreversibile che cancella in
  cascata tutti i repository non va su una superficie dove si tocca per
  sbaglio. Resta sul web.
- **La chiave d'integrazione, i widget e i plugin.** Non sono esclusi per
  principio: sono configurazione che si fa una volta, da un computer, e
  nessuno dei tre ha una lettura utile «al volo». Se servono, entrano dopo —
  l'hub è additivo per costruzione.
- **Le regole della posta e gli ambienti.** Stessa ragione: si configurano
  una volta. La posta di un progetto, invece, si LEGGE — ma vive già nel tab
  MBX, che è per casella e non per progetto: unirle è un'altra domanda.

Questo elenco è la parte del design che invecchia più in fretta: chi ci
aggiunge un'area lo faccia togliendola da qui con una riga che dice perché,
non in silenzio.

## §9 — Consegna in tre tappe, ciascuna utile da sola

È troppo per una PR sola: nove aree, cinque schermate nuove, due lacune del
client e un campo nuovo su due risposte. Si spezza, e ogni tappa è
deployabile e verificabile:

1. **L'impalcatura più il lavoro** — la pagina a sezioni, i conteggi
   (`total` su ticket e backlog), le sezioni ticket / backlog / inbox con le
   loro tre schermate. È la tappa che cambia davvero come si usa l'app.
2. **Di cosa è fatto** — repository (con la schermata di dettaglio),
   documentazioni, roadmap.
3. **Monitor e impostazioni** — lo spostamento di `serverViewSchema` in
   `shared`, il gruppo `servers` nel client, il cruscotto, il form delle
   impostazioni.

Il monitor è ultimo non perché conti meno, ma perché è l'unico che richiede
di spostare uno schema fra package: se qualcosa deve slittare, slitti quello
che non blocca le altre due.

## §10 — Cosa verifica il maintainer

Alla fine di ogni tappa, una cosa sola sul telefono. Per la prima: aprire un
progetto e vedere, senza toccare niente, quanti ticket aperti ha, quante voci
di backlog e quante notifiche da gestire — e che «vedi tutte» sui ticket apra
un elenco che si può filtrare, con l'indietro che torna all'hub.
