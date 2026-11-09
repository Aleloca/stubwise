# Shape brief — Tasks (elenco, board, timeline), dettaglio, filtro salvato

Superficie: `#/p/<CODE>/tasks` (con `view`, `group`, `filters`),
pannello `?task=<CODE-n>` su ogni rotta, `#/filters/<id>`, `#/filters`.
Piano: Task 6, 7, 8. Spec: area 2 §3–4. Mondo: «Catalogo numerato»,
modalità **Operate**, densità compatta. **[ASSUNZIONE]** = da confermare.

## 1. Lavoro e pubblico

- Chi arriva: membri del progetto di ogni reparto; chi pianifica e chi
  esegue. Ci passano molto tempo: scorrere, raggruppare, cambiare stato,
  aprire la prossima.
- Il filtro salvato porta la stessa pagina fuori dal progetto: «tutte le
  mie aperte», «chiuse questo mese», trasversali.

## 2. Esito e prova

- Azione primaria: trovare la task giusta e cambiarne stato/assegnatario
  senza uscire dalla vista; aprire il dettaglio e passare alla successiva
  con J/K.
- Successo: con 150 task il raggruppamento e i filtri rispondono subito; la
  stessa task ha la stessa forma in elenco, carta e pannello.
- Verità: codice `<CODE>-n` sempre accanto al titolo; stato scritto col suo
  nome + segno della famiglia (forma, non colore); «ferma» col motivo vero.

## 3. Direzione scelta

- **Tesi**: una pagina, tre proiezioni dello stesso insieme filtrato. La
  testata (h1, barra delle viste, barra dei filtri) **non si muove** fra
  Elenco, Board e Timeline: cambia solo il corpo. La vista sta nell'URL.
- **Sequenza**: h1 «Tasks» con conteggio → riga di comando: segmentato
  `List · Board · Timeline`, «Group by», «Save as filter», «New task»
  (primario) → `FilterBar` a chip → corpo.
- **Momento focale**: la riga selezionata che apre il pannello affiancato e
  J/K che scorrono restando nel pannello.
- Conseguenza: `TaskRow`, carta e testata del pannello condividono lo
  stesso ordine (striscia · codice · titolo · stato · persona · taglia ·
  scadenza · ferma).

```
┌rail┬column──────┬─Tasks 142──────────────────────────┬─AUD-88──────────┐
│    │ AUD        │ [List|Board|Timeline] Group:Status │ AUD-88  ✕       │
│    │ Audin 2.0  │ Save as filter          [New task] │ Invoice export  │
│    │ Overview   │ Status:open ▾ Assignee ▾ + Filter  │ ◐ In review     │
│    │ Tasks    ● │ ─ IN PROGRESS 12 ───────────────── │ Paolo · S · Oct │
│    │ Planning   │ ▌AUD-88 Invoice export ◐ PG S Oct24│ ─ STALLED ───── │
│    │ Requests   │ ▌AUD-91 Price list sync  ◐ ◌Claude │ Waiting for     │
│    │ …          │ ▌AUD-77 Onboarding mail ◐ EM M !4d │ Elena's decision│
│    │            │ ─ TO DO 30 ─────────────────────── │ · 4 days        │
│    │            │ ▌AUD-95 Fix PDF footer ○ — XS      │ ─ DECISIONS ─── │
└────┴────────────┴────────────────────────────────────┴─────────────────┘
```

## 4. Ambito e confini

- Dentro: tre viste, raggruppamento, ordinamento, selezione multipla e
  `BulkBar`, board con corsie e trascinamento, timeline, `NewTaskDialog`,
  pannello completo (sezioni dello spec §3), «Ask for a decision»,
  `SaveFilterDialog`, `FilterPage`, `AllFiltersPage`.
- Fuori: contenuto di Claude oltre lo stato e «Open session» (area 3);
  configurazione dei workflow; campi personalizzati.
- Anti-obiettivi: carte grosse con avatar e copertine; colore come unico
  segno di stato; una pagina diversa per il filtro salvato.

## 5. Stati e intervalli

- Volumi: progetto 0–~300 task (AUD ~150); stati 3–8 per progetto, nomi fino
  a ~22 caratteri («In approvazione», «Attesa cliente»); titoli fino a ~120
  caratteri, una riga con ellissi e `title` intero.
- Vuoto progetto: «No tasks yet» + «New task» se `tickets.create`, altrimenti
  «Only people who can create tasks in <project> can add one». Vuoto da
  filtro: «No tasks match these filters» + «Clear filters».
- Caricamento: 8 righe scheletro / 4 colonne scheletro. Errore: «Couldn't
  load tasks» + «Retry» al posto del corpo, testata intatta.
- Board: colonna vuota resta visibile con «—» e accetta il drop; una
  colonna `closed` mostra le ultime 20 e «Show older». **[ASSUNZIONE]**
- Pannello: task invisibile/inesistente → «This task doesn't exist or you
  can't see it»; senza `tickets.edit` campi in sola lettura (testo, niente
  menu); senza `tickets.comment` niente composer né «Ask for a decision».
- Filtro: vuoto per chi guarda anche se pubblico con risultati per l'autore;
  i conteggi sono sempre di chi guarda.

## 6. Interazione e layout

- **Elenco**: righe 36px (compatta), gruppi con `heading-group` e conteggio,
  colonne a larghezza fissa a destra (stato 140, persona 120, taglia 32,
  scadenza 64) e titolo elastico. Clic seleziona e apre; ⌘/Ctrl+clic e
  Maiusc+clic selezionano senza aprire; con ≥1 selezionata compare la
  `BulkBar` in basso (solo con `tickets.edit`): «Status · Assignee · Week ·
  Milestone · Size · Clear». Stato e assegnatario modificabili in riga
  (menu), ottimistici con rollback + toast.
- **Board**: colonne 264px a scorrimento orizzontale, intestazione con nome
  stato (ellissi + `title`) e conteggio; carte su 3 righe (striscia+codice,
  titolo 2 righe, persona·taglia·ferma). Corsie opzionali per assegnatario o
  reparto con intestazione orizzontale fissa a sinistra. Tastiera: Space
  prende, frecce, Space lascia, Esc annulla, Enter apre.
- **Timeline**: asse a settimane (W41…W51, oggi = linea ink sottile),
  traguardi come linee verticali col nome in cima; barre dalla settimana
  pianificata alla scadenza, lunghezza esatta; punto se una data sola;
  sezione «No dates» sotto, come elenco. Etichetta della barra = codice +
  titolo dentro se ci sta, altrimenti a destra. Righe raggruppate come
  l'elenco.
- **1024×680**: area 720px. Elenco: cade prima la colonna scadenza nella
  persona (iniziali sole), poi la taglia resta; la barra comandi va su due
  righe (viste + New task / Group + Save). Board: ~2,5 colonne visibili.
  Timeline: 6 settimane visibili, scorre.
- **Pannello**: affiancato da 1200px, 360px di default, ridimensionabile
  320–640 dal bordo; sotto 1200 sovrapposto 400px con fuoco dentro e ritorno
  all'origine. A 1200 con pannello l'area scende a 536px: l'elenco mostra
  striscia, codice, titolo, stato (segno solo + nome nel tooltip), persona.
  Ordine sezioni: testata → Stalled → Decisions → Description → Claude →
  Origin request / Linked / Attachments → Activity. Sezioni vuote
  collassate a una riga («No linked tasks · Add»). J/K = task
  precedente/successiva nella vista; Esc chiude; ⌘C sul codice lo copia.
- Cambio stato in board/pannello: la carta scivola alla nuova colonna in
  200ms; nell'elenco la riga cambia gruppo con dissolvenza breve.
- **Filtro salvato**: stessa pagina; h1 = nome del filtro, sotto «Public ·
  by Giulia Ferri» o «Private», azioni «Edit · Pin to column · Add to Home ·
  Delete» (Delete solo autore o full admin). Multi-progetto: elenco con
  colonna progetto (codice), board per famiglie (To do · In progress ·
  Closed), timeline raggruppata per progetto **[ASSUNZIONE]**.
- **All filters**: due gruppi «Mine» e «Public», righe nome · autore ·
  vista · conteggio per chi guarda · pin.

## 7. Vincoli e decisioni aperte

- `@dnd-kit` per board e my-week/planning; annunci live per ogni drop.
- Testo ≥11px; stato mai solo colore; Claude = anello tratteggiato ink.
- **[ASSUNZIONE]** larghezza del pannello salvata per persona, non per vista.
- **[ASSUNZIONE]** «New task» apre un dialogo modale (non una riga inline),
  e dopo la creazione apre il pannello della task nuova.
- **[ASSUNZIONE]** la scelta di vista/raggruppamento per progetto non si
  ricorda fra sessioni se non salvata come filtro (vive solo nell'URL).
