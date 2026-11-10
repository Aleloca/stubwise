# Integrazione area 2 — prove a mano (10 nov 2026)

Le prove che i test automatici non fanno: il giro vero sul Mac, il mouse e la
tastiera, l'aspetto delle pagine, il server vero con dati veri. Raccolgono le
sezioni «Da provare a mano» delle quattro fette
(`integration-slice{1,2,3,4}.md`), messe in ordine per superficie.

Ogni prova dice cosa fare e cosa deve succedere. Se qualcosa non torna, basta
annotare la prova e cosa si è visto: il resto lo ricostruiamo noi.

## Preparare l'istanza di prova

1. **Il codice di questo branch** (`feat/integrazione-area2-fetta4`, che
   contiene le fette 1–4) su un'istanza di prova, non in produzione.
2. **Server e caddy di questo branch**: `docker compose up -d --build server`,
   aspettare che il server sia healthy (applica le migrazioni fino alla
   0121), poi `docker compose up -d --build caddy`. Caddy serve l'app nuova su
   `/app` accanto al web vecchio.
3. **L'app desktop**: sul Mac, `pnpm --filter @stubwise/desktop package:mac`.
   Il `.dmg` è in `apps/desktop/release/`. Non è firmato: al primo avvio
   tasto destro sull'app → «Apri».
4. **Due account** nella stessa istanza, membri dello stesso progetto:
   - **A**, Project Lead del progetto (e responsabile della Home del suo reparto);
   - **B**, Developer dello stesso progetto, nello stesso reparto.
   Utile anche un terzo account full admin, per le prove dei reparti.
5. **Lo storage S3 per gli allegati**: dal web vecchio, nelle impostazioni
   dell'istanza (Integrazioni → archiviazione). Senza, gli allegati
   rispondono «storage non configurato».
6. **Un po' di dati**:
   - qualche task con taglia e scadenza;
   - un paio di traguardi;
   - una richiesta di backlog creata dal web vecchio con urgenza «urgent»;
   - il brief settimanale e i daily report accesi su un progetto.

## Ingresso e login

**Web (`/app`)**
- Apri `<istanza>/app` senza sessione → la pagina di login. Entra con
  password e codice dell'app di autenticazione → atterri sulla **Home**.
- Con un account senza secondo fattore → al login ti chiede di configurarlo
  (QR, chiave, primo codice, codici di riserva una volta sola) → poi dentro.
- Un codice di riserva al posto del codice dell'app → entra, e il codice usato
  non vale più.
- Esci dal profilo → torni al login; il web vecchio sulla stessa istanza resta
  utilizzabile.

**Desktop (dmg)**
- Primo avvio → ti chiede l'indirizzo dell'istanza → «Sign in with your
  browser» → si apre il browser su `/app/#/desktop-login` → login → «Allow» →
  l'app torna in primo piano già dentro, sulla Home.
- Chiudi e riapri l'app → sei ancora dentro, senza rifare il login.
- Cambia la password dal web → l'app desktop ti chiede di rientrare.
- Guarda con calma l'aspetto delle pagine nuove: indirizzo dell'istanza e
  attesa, la conferma «Allow», la configurazione del secondo fattore.

## Tasks

- Apri un progetto → atterri sull'**Overview**; vai su Tasks → l'elenco
  coincide con quello del web vecchio.
- Filtri (stato, reparto, assegnatario, taglia, periodo, ferma) → l'indirizzo
  li conserva; ricaricando la pagina restano.
- Board: trascina una task in un'altra colonna → cambia stato subito; il web
  vecchio la mostra nello stato nuovo.
- Seleziona più task → azione in blocco (stato o assegnatario) → cambiano
  tutte; con B su una task che non può modificare → nessuna cambia.
- Timeline: le task in vista con i traguardi alla loro data.
- New task con titolo, reparto, taglia, settimana → compare in elenco e nel
  web vecchio.

## Dettaglio della task

- Apri una task → testata e campi: modifica stato, priorità, assegnatario,
  taglia, scadenza, settimana → il web vecchio vede le modifiche.
- Un link a una task che B non può vedere → «not found», senza dettagli.
- Commenti: scrivi, rispondi, modifica, elimina → il web vecchio vede lo stesso.
- Task collegate: aggiungi e togli; dall'altra task si vede il legame inverso.
- Allegati: carica un file vero, poi toglilo (serve S3).
- «Segui» e la ferma a mano («Mark as stalled» e «Not stalled»).
- Chiedi una decisione a B → B la trova in «Da decidere» e nell'inbox, la
  risponde → A vede la risposta nel feed.
- Il feed della task: cambi di stato, settimana, reparto e taglia, con i nomi
  delle persone. Una persona o un traguardo eliminati si leggono come
  «someone» / «a deleted milestone», mai come un codice.
- La sezione Claude: dice lo stato e le PR, con «Open in web»; niente azioni.

## Planning e La mia settimana

- Planning di progetto con A: trascina una task dalla vasca a B in questa
  settimana col **mouse**, poi un'altra con la **tastiera** («P», frecce,
  Invio) → la cella si aggiorna; B riceve l'avviso, che apre la task.
- Planning con B: le righe degli altri sono in sola lettura; B può prendere
  per sé una task non assegnata.
- Planning trasversale (`/planning`) per reparto → stesse regole. B, senza
  permesso di pianificare per altri in nessun progetto, viene riportato alla Home.
- Prova a mettere una task in una settimana passata dal menu «Plan» → il
  rifiuto dice perché, senza «Try again».
- La mia settimana (`/home?view=week`): metti una task in un giorno, poi
  toglila dal giorno, ricarica → resta dove l'hai messa.
- **Slittamento**: una task aperta pianificata la settimana scorsa → compare
  nella corrente col segno dello slittamento (×1). Lasciala aperta un'altra
  settimana → ×2.
- **Cambio di giorno**: tieni l'app aperta oltre la mezzanotte (anche dopo lo
  stop del Mac) → «In ritardo» e «Oggi» si aggiornano senza ricaricare; il
  lunedì la settimana corrente è la nuova.

## Home e filtri

- La Home mostra la Home del reparto: «Da decidere», «La mia settimana» e i
  blocchi dell'area 2; mai posta, calendario, automazioni o rilasci.
- «Customize» → aggiungi un blocco, nascondine uno, riordina col mouse e con
  la tastiera → salva → resta così. «Ripristina» → torna quella del reparto.
- Con A (responsabile della Home del reparto) → «Customize» propone anche la
  Home del reparto → cambiala → B, senza Home personale, la vede.
- Con B, che ha una Home personale → la riga «La Home del reparto è cambiata
  · Vedi le novità» → ti mostra i blocchi nuovi; la riga sparisce.
- Nella Home di reparto un filtro privato non si può mettere.
- Dalla pagina Reparti (full admin): dai ad A la gestione della Home → in A
  compare subito «Customize → reparto», senza riavviare.
- Tasks → «Save as filter» → privato o pubblico → lo trovi in «All filters»;
  modificalo ed eliminalo.
- Fissa un filtro nella colonna, poi toglilo.
- Metti un filtro come blocco della Home → elimina il filtro → il blocco resta
  e dice «non disponibile», con «Remove block».
- «Da decidere» → «Turn into task» su una richiesta → la task nasce collegata
  e la richiesta esce dall'elenco.

## Requests

- Requests del progetto → l'elenco coi codici `R<n>`, come il backlog del web
  vecchio. La richiesta «urgent» del web vecchio si legge «Urgent».
- Nuova richiesta su qualcosa che esiste già → dopo un'attesa visibile «Unita
  a R…» e si apre quella. Una richiesta davvero nuova resta nuova.
- «Fondi in…» → attesa della riscrittura → la destinazione ha il testo
  riscritto. Con il modello spento → errore, «Try again», niente cambiato.
- Metadati (urgenza, taglia, rischio e nota) e descrizione → il web vecchio
  li vede. Suggerimenti dell'intake → «Accetta» e «Scarta».
- Archivia, Riapri, Ripristina.
- Trasforma in task dal dettaglio → la richiesta diventa trasformata ed esce
  dagli elenchi da trasformare.
- «Rifinisci con Claude» c'è ma è spento (area 3).

## Overview

- Traguardi: crea, modifica, chiudi, riapri, elimina → le task del traguardo
  eliminato restano, senza traguardo.
- Registro decisioni: registra una decisione a mano, poi una che la
  «supera» → la prima si legge superata. Un ciclo di «superata da» non si
  può fare.
- Il brief settimanale c'è, etichettato come testo generato.
- Cronologia: «Show earlier» scorre le settimane e, oltre le quattro,
  carica la storia più vecchia; i traguardi futuri stanno in cima.
- Cosa è aperto e cosa è fermo: i numeri coincidono con Tasks.

## Tutti i progetti

- Il portafoglio col polso di ogni progetto (aperte, ferme, «aspetta te»,
  prossimo traguardo); fissa e sgancia un progetto.
- Le ferme di tutti i progetti, dalla più vecchia.
- L'attività per giorno, con «Show earlier» oltre le quattro settimane.
- Nuovo progetto con un codice già usato → l'errore sotto il codice, niente
  creato. Con il modello «Client» e un cliente → gli stati del modello e il
  modulo Docs; con «Software» → i quattro moduli.
- I progetti che c'erano già → Software, con i quattro moduli.

## Compatibilità con il web vecchio e il mobile

- **Web vecchio**:
  - liste, dettaglio dei ticket, backlog, traguardi e inbox funzionano come prima;
  - le viste salvate del web vecchio ci sono ancora (i filtri dell'app sono a parte);
  - una task creata o spostata dall'app ha lo stato giusto anche nel web.
- **App mobile**:
  - l'inbox si apre anche con gli avvisi nuovi della pianificazione (`planning.changed`, `task.assigned`);
  - liste e dettaglio funzionano come prima;
  - una richiesta creata dall'app nuova compare nel backlog.
- **Avvisi**: un avviso dell'app nuova (decisione chiesta, task spostata) arriva
  anche sul telefono e nel web vecchio.
