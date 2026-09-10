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

## 3. Il calendario mostra il lavoro, non la settimana

**Decisione del maintainer, cambiata in corsa (10 set 2026): l'ingestione NON
cambia.** Si continua a scrivere solo ciò che passa i filtri di routing
(`poller.ts:1072`); gli appuntamenti personali non entrano nel database di
Stubwise.

È la scelta più conservativa sulla riservatezza, e fa cadere il task più
pericoloso che questa fase avrebbe avuto: spostare `inScope` dall'ingestione
alla proposta. Quel filtro oggi fa due lavori in uno, e separarli senza sbagliare
avrebbe significato rischiare che ogni appuntamento personale diventasse una
proposta di milestone — l'incidente del 9 settembre moltiplicato per la vita
privata di chi ha collegato la casella. Non facendolo, quel rischio non esiste.

### Le due conseguenze, che vanno rese visibili e non subite

**(a) La griglia è sparsa per costruzione.** Mostra gli appuntamenti di lavoro
riconosciuti — oggi in produzione due o tre serie ricorrenti — non la settimana
dell'utente. Martedì sarà vuoto anche se ci sono state quattro riunioni.

Non è un difetto: è ciò che si è scelto di far vedere. Ma **una griglia vuota
deve spiegarsi da sola**, altrimenti chi la guarda pensa che sia rotta. Lo stato
vuoto non dice «nessun evento»: dice che qui si vedono solo gli appuntamenti che
combaciano con le regole dei progetti, e indica dove si cambiano quelle regole.

**(b) Non si può guardare indietro.** `calendarWindow`
(`apps/worker/src/google/calendar.ts:118`) è `now → now + 60 giorni`: `timeMin`
è **adesso**, nessuno sguardo all'indietro. Su una griglia con le frecce
avanti/indietro è un comportamento strano — si preme indietro e non c'è mai
niente, per sempre.

**Si sposta `timeMin` a `now - 30 giorni`.** Non tocca i filtri e non cambia
cosa è ammesso: cambia solo quanto passato si conserva, così la griglia ha un
«prima» da mostrare. Il tetto sui 60 giorni in avanti resta.

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
esistente, e — dopo il cambio di decisione del §3 — **nessun cambiamento a cosa
entra nel database** se non l'allungamento della finestra all'indietro. Un
binario precedente ignora `html_link` e legge i partecipanti nella forma
vecchia solo se la migrazione non è stata applicata; applicata, la forma nuova
è l'unica. Il caddy va sceso insieme al server, come sempre.

## 7. Cosa NON entra

- **Rispondere o scrivere email**: serve `gmail.send`, un consenso nuovo da
  ogni utente, ed è fuori perimetro dichiarato dalla 7b.
- **Cartelle Inviata / Bozze / Archivio**: non si ingerisce posta in uscita.
- **Cambiare il linguaggio visivo dell'app** (§1), né un tema chiaro accanto a
  quello scuro.
- **Il calendario multi-progetto**: resta uno-a-uno.
- **Ingerire gli appuntamenti fuori perimetro** (§3): scelta esplicita del
  maintainer, non un rinvio.
- **L'app mobile**: le sue viste non cambiano in questa fase.
