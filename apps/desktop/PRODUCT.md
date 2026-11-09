# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

App desktop Electron per macOS e Windows: l'interfaccia è web (Chromium) dentro
una finestra nativa. Il web (`apps/web`) e l'app mobile (`apps/mobile`) restano
come sono e NON sono un riferimento per questa app.

## Stack

delegated: React + TypeScript + Vite dentro Electron — lo stesso linguaggio del
resto del monorepo, così i pezzi del prototipo possono diventare l'app vera.
La fase attuale è un **prototipo cliccabile con dati finti** (nessun DB, nessuna
API): transizioni fra pagine e stati reali, contenuti realistici. Il prototipo
è la specifica dell'app completa: ogni pagina va definita fino in fondo, nessun
dubbio lasciato a chi la svilupperà.

## Users

Tutti i reparti di un'azienda, non solo gli sviluppatori: commerciale,
marketing, assistenza clienti, sviluppo, amministrazione. Molti non hanno mai
aperto un terminale. Lavorano su circa 50 progetti attivi in contemporanea;
c'è chi li segue tutti e chi una decina. Ci passano la giornata.

## Product Purpose

Stubwise diventa il centro nevralgico di tutti i progetti di un'azienda —
prodotti interni e commesse per clienti — e copre il progetto per intero
(PM, marketing, commerciale, assistenza, sviluppo), non solo la parte IT.
Ogni cosa da fare su un progetto è una task visibile, con assegnatario e stato.
Sostituisce Jira (board, epiche, sprint, filtri — apprezzati, ma costosi) e
Slack (chat interna con storico che resta vostro). Successo: l'azienda lavora
e comunica dentro Stubwise, e i dati di progetto stanno tutti lì.

## Positioning

Ciò che Jira + Slack non possono dire: il lavoro, le conversazioni, i
documenti (anche generati automaticamente dai repository collegati), la posta
e il calendario stanno nello stesso posto, e l'AI ci lavora sopra. Il worker
fa già lavorare Claude Code sul VPS: l'AI diventa un collega a cui assegnare
task di qualunque reparto, e le comunicazioni in arrivo (email, eventi di
sistemi esterni) diventano task da sole.

## Operating Context

- Due livelli di navigazione: la vista generale (le mie task di tutti i
  progetti, riassunti, timeline) e la vista di un progetto, in cui l'app intera
  si concentra su quel progetto, come in Jira. Il passaggio fra progetti è
  frequente e deve essere immediato.
- Le automazioni sono parte del lavoro quotidiano: un evento (es. un contratto
  chiuso in Audin o HubSpot, arrivato via webhook) passa dall'analisi AI e fa
  nascere task assegnate per reparto o lavoro affidato a Claude Code. Le
  regole le crea il team, non solo gli sviluppatori.
- Contratti e trattative NON vivono in Stubwise: restano nei sistemi esterni
  (Audin, HubSpot…) e arrivano come eventi.
- Ognuno collega la propria posta e il proprio calendario.

## Capabilities and Constraints

Aree dell'app (tutte da definire al dettaglio, nessuna abbozzata):
home «il mio lavoro»; inbox (decisioni, domande di Claude, proposte da
email/eventi, notifiche); vista progetto (panoramica, board, backlog/epiche/
sprint, elenco task con filtri, documenti e drive, chat); chat (canali di
progetto, generali, messaggi diretti, con allegati di task/file/pagine del
progetto); posta e calendario; automazioni (sorgenti esterne + costruttore
evento → condizioni → azioni); Claude al lavoro (sessioni dal vivo); persone,
reparti e impostazioni; cambio progetto rapido da ovunque.

**Parità con il web, obbligatoria.** Ogni funzionalità presente oggi in
`apps/web` entra nel prototipo, ridisegnata e ricollocata dove ha senso nella
nuova struttura — non trasposta così com'è. Fra le altre: ticket con la
pipeline dell'agente (piano e approvazione, domande `ask_user`, PR, correzioni
post-PR, adozione PR), backlog e sessioni di refinement, sessioni degli agenti
dal vivo, Docs generati con ricerca e chat RAG, polso/brief/registro decisioni/
timeline del progetto, posta e calendario con le proposte, coda di rilascio e
ambienti, monitoraggio dei server, widget customer service, report giornalieri,
grafo, plugin e skill, account e quota dei provider, modelli e consumi, ruoli e
permessi, secondo fattore, token e integrazione Claude Code. L'inventario
completo, schermata per schermata, si ricava dal codice di `apps/web` prima di
definire ogni area.

Terminologia: «progetto» = prodotto interno o commessa di un cliente.

Decisioni aperte, da non inventare:
- cosa fa concretamente l'AI su ogni tipo di task non tecnica (si decide caso
  per caso, quando le task arrivano);
- il drive di progetto è un concetto nuovo: oggi Stubwise non ha uno spazio
  file per progetto.

Prodotto per la propria azienda E distribuibile ad altre (self-hosted): niente
reparti, nomi o flussi cablati su una sola organizzazione.

Lingue: inglese di default, italiano come seconda lingua. Testi pensati per la
traduzione: lunghezze diverse non rompono il layout.

## Brand Commitments

- Nome: **Stubwise**.
- Logo attuale: monogramma «S_» (ambra `#f5a623` su fondo scuro `#0f1318`,
  angoli arrotondati) — `apps/web/public/favicon.svg`,
  `apps/web/public/icon-1024x1024.svg`. Si tiene.
- Tutto il resto dell'identità (colori, caratteri, componenti) si ridefinisce.
- Anti-riferimento esplicito: l'estetica «terminale» di web e mobile attuali
  e il loro accumulo senza struttura (voci difficili da distinguere, funzioni
  aggiunte dove c'era posto).

## Evidence on Hand

Nessun dato reale nel prototipo: dati finti scritti a mano, realistici per
un'azienda con ~50 progetti e più reparti, etichettati come finti. Non vanno
inventati clienti reali, prezzi o metriche presentati come veri.

## Product Principles

1. **Ogni cosa ha un posto pensato.** Una funzione nuova entra in una struttura
   decisa, mai «dove c'è spazio».
2. **Chiaro a chiunque.** Ogni elemento dice da solo cosa fa; si legge bene; si
   capisce sempre dove trovare un'informazione.
3. **Il mio lavoro prima, il progetto quando serve.** La porta d'ingresso è ciò
   che aspetta me in tutti i progetti; il progetto è un fuoco in cui si entra.
4. **L'AI è un collega.** Claude si assegna, ha uno stato visibile, e chiede
   quando deve decidere — come una persona del team.
5. **Professionale e curato.** Transizioni semplici e pulite fra pagine e stati
   che spiegano cosa è successo e mostrano il pensiero dietro.
