---
title: Fase 9 — Posta e Calendario che si guardano volentieri
date: 2026-09-10
stubwise:
  project: stubwise
---

# Fase 9 — Posta e Calendario che si guardano volentieri

## 1. Da dove nasce

Il maintainer ha guardato le pagine Posta e Calendario appena deployate (fase
7b) e ha detto che «sono veramente brutte», portando come riferimento cinque
schermate di un altro prodotto: posta a tre colonne con riquadro di lettura,
calendario a griglia settimanale con fasce orarie, pannello di dettaglio
laterale con i partecipanti e il loro stato, mini-calendario per saltare le
date.

Il riferimento è giusto ma va letto bene. **Quelle schermate sono belle per la
struttura, non per il colore**: tre colonne, una griglia vera, un pannello che
scorre da destra. Il loro linguaggio visivo — fondo chiaro, schede bianche,
pastelli, accenti blu — è l'opposto di quello di Stubwise, che è dichiarato in
`apps/web/src/styles.css`: dark-first, «strumento da sala controllo», inchiostro
quasi nero a cast freddo, bordi hairline, **un solo accento ambra**, IBM Plex
Sans e Mono.

**Decisione del maintainer (10 set 2026): si prende la struttura, nel tema
scuro.** Due pagine chiare dentro un'app scura sembrerebbero un errore, e
riscrivere il linguaggio visivo di tutta l'app — inbox, ticket, backlog,
progetti, roadmap, coda di rilascio, impostazioni, più i colori dell'app
mobile — è un progetto più grande della fase 8.

## 2. Il vero problema non era estetico

Verificato prima di disegnare qualunque cosa:

**Il calendario oggi non è un calendario.** `apps/worker/src/google/poller.ts:1072`
scarta ogni evento che non combacia con le regole di routing di un progetto
(`if (!routeEvent(event, ctx.routes).inScope) continue;`). In produzione ci sono
1553 righe, **tutte e sole** occorrenze di due o tre serie ricorrenti. Disegnare
una griglia settimanale su quei dati produrrebbe una settimana **vuota**: la
settimana vera dell'utente non è nel database.

**Tre cose del pannello di dettaglio non ci sono.** I partecipanti sono
normalizzati a `string[]` (`packages/google/src/calendar.ts:28`, `:111`): il
`responseStatus` che Google manda viene **scartato**, quindi niente
«Accettato/Rifiutato». `htmlLink` sopravvive nel tipo (`calendar.ts:30`, `:115`)
ma **non è una colonna** di `calendar_events`: oggi si costruisce solo un link
al giorno.

**Sulla posta, tre assenze sono scelte deliberate, non buchi.** Le cartelle
Inviata/Bozze non esistono perché si ingerisce solo posta in arrivo ammessa; il
corpo HTML è stato **tolto apposta** nella fase 7b (renderlo con
`dangerouslySetInnerHTML` sarebbe un XSS sul contenuto di un'email, cioè testo
scritto da chiunque); rispondere richiede lo scope `gmail.send`, un consenso
nuovo, ed è fuori perimetro.

## 3. Il calendario diventa un calendario

**Si ingerisce tutto ciò che cade nella finestra dei 60 giorni**, non solo ciò
che combacia con una regola.

È la stessa distinzione della fase 6c, applicata al calendario: **ciò che si
VEDE** e **ciò che PRODUCE proposte** sono due domande diverse. Un appuntamento
fuori perimetro si vede nella griglia e non fa nient'altro: nessuna proposta,
nessuna analisi, nessun costo di AI.

### ⚠️ L'invariante di questa fase, e il modo in cui può andare male

`poller.ts:1072` oggi fa **due lavori in uno**: decide cosa si scrive E, di
conseguenza, cosa può diventare una proposta. Togliendolo dall'ingestione senza
metterlo in proposta, **ogni appuntamento personale diventa una proposta di
milestone** — il dentista, la cena, il compleanno.

Sarebbe l'incidente del 9 settembre 2026 (730 notifiche da una serie
ricorrente) moltiplicato per la vita privata di chi ha collegato la casella. Il
filtro non si sposta «in un secondo momento»: si sposta **nello stesso commit**,
e serve un test che parta da un evento fuori perimetro e verifichi che sia
**scritto** e **mai proposto**.

Le due condizioni finali sono quindi:
- **ingestione**: dentro la finestra dei 60 giorni (la difesa aggiunta nella
  7b, che resta);
- **proposta**: `inScope` — più tutto ciò che la 7b ha aggiunto (serie
  configurata e accesa, anticipo, progetto fissato).

### Il dettaglio dell'evento

Due campi nuovi, entrambi già mandati da Google e oggi buttati: lo stato di
risposta di ogni partecipante, e il link diretto all'evento.

Il pannello di dettaglio è anche **il posto giusto per la configurazione della
serie** introdotta nella 7b: si accende una serie stando davanti
all'appuntamento che si sta guardando, non in un elenco separato.

## 4. La posta resta un flusso di segnali

**Decisione del maintainer: l'ingestione non cambia.** La pagina Posta continua
a mostrare i soli messaggi **ammessi** — in produzione 33 su quattro caselle.
Il marketing, le newsletter e la posta automatica restano fuori, come li lascia
fuori `admit()`.

Ne segue una conseguenza di disegno da non ignorare: **la lista sarà sempre
corta**, per costruzione. La colonna centrale va disegnata per venti righe, non
per duemila: niente scroll infinito che non scorre mai, niente densità pensata
per un client di posta.

### Il corpo dell'email si vede formattato, in sicurezza

Non «rimettendo `bodyHtml`». Nel modo in cui lo fanno i client veri:

1. **Sanificazione lato server**: via ogni `<script>`, ogni attributo handler,
   ogni `javascript:`, ogni `<iframe>`, `<object>`, `<embed>`, `<form>`.
   Allowlist di tag e attributi, non denylist — una denylist si aggira.
2. **Resa in un `<iframe sandbox>`** senza `allow-scripts` e senza
   `allow-same-origin`: anche se la sanificazione avesse un buco, il contenuto
   non ha un'origine da cui fare danni.
3. **Immagini remote bloccate di default**, con un comando «mostra immagini».
   Non è solo prudenza: è ciò che impedisce ai **pixel di tracciamento** di
   dire al mittente quando e quante volte hai aperto la sua email.

**L'HTML non si conserva.** Si rilegge da Gmail su richiesta con
`getMessageFull` — la strada già aperta dalla 7b — e si sanifica per quella
risposta. Così non esiste in nessun punto del database una copia di HTML scritto
da un estraneo, e la potatura a 90 giorni non cambia comportamento.

## 5. La struttura

**Posta**, tre colonne: a sinistra le caselle e i filtri che esistono già
(progetto, stato, segnale); al centro la lista (mittente, oggetto, anteprima,
data, badge di progetto e segnale); a destra la lettura — intestazione, corpo
sanificato, e le azioni che ci sono già (riproponi, apri su Gmail, mostra
l'originale).

**Calendario**: in alto Giorno / Settimana / Mese con oggi e le frecce; a
sinistra l'elenco delle caselle con il proprio colore e un mini-calendario per
saltare le date; al centro la griglia con le fasce orarie; a destra il pannello
di dettaglio che scorre.

Tutto nel tema esistente. L'accento ambra resta **uno**: i colori per casella
si ottengono variando luminosità e saturazione dentro la palette
dell'inchiostro, non introducendo cinque tinte nuove.

## 6. Migrazione e rollback

**Migrazione 0075**, additiva: `html_link` su `calendar_events`, e i
partecipanti che passano da `text[]` a una forma che porta anche lo stato di
risposta. Quest'ultima è una **migrazione con dati** (1553 righe in produzione):
va scritta col backfill e con il `NOT NULL` dopo, come la 0074 — che è il
modello da imitare.

⚠️ `attendees` è letto da `eventToRouting`
(`apps/worker/src/google/calendar.ts:169-177`), che lo usa come `toAddresses`
per l'attribuzione: chi cambia la forma cambia anche quel lettore, **nello
stesso commit**. Alla fine deve esserci **una sola** fonte di verità, non una
colonna nuova accanto a una vecchia.

**Rollback**: nessun kind di notifica nuovo, nessun valore nuovo in un enum
esistente. Ma attenzione a una cosa che le fasi precedenti non avevano: dopo
questa fase il database contiene **tutti** gli appuntamenti della finestra.
Tornare indietro sull'ingestione non cancella ciò che è già stato scritto — e
quelle righe, per un binario che non ha il filtro in proposta, sarebbero
proponibili. Chi scende di immagine sul worker deve saperlo.

## 7. Cosa NON entra

- **Rispondere o scrivere email**: serve `gmail.send`, un consenso nuovo da
  ogni utente, ed è fuori perimetro dichiarato dalla 7b.
- **Cartelle Inviata / Bozze / Archivio**: non si ingerisce posta in uscita.
- **Cambiare il linguaggio visivo dell'app** (§1), né un tema chiaro accanto a
  quello scuro.
- **Il calendario multi-progetto**: resta uno-a-uno.
- **L'app mobile**: le sue viste non cambiano in questa fase.
