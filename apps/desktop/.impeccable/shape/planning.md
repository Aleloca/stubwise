# Shape brief — Planning (di progetto e trasversale)

Superficie: `#/p/<CODE>/planning` e `#/planning` (trasversale, nella
colonna della Home per chi ha `planning.others` in almeno un progetto).
Piano: Task 11. Spec: area 2 §5. Mondo: «Catalogo numerato», modalità
**Operate**. **[ASSUNZIONE]** = da confermare.

## 1. Lavoro e pubblico

- Chi arriva: chi pianifica (Project Lead, responsabile di reparto) il
  lunedì o il venerdì; e ogni membro per sistemare **le proprie** task.
- Bisogno (maintainer): vedere in un colpo solo le task aperte, quanto è
  carica ogni persona e cosa è già nella settimana.

## 2. Esito e prova

- Azione primaria: trascinare una task da «To plan» su una persona in una
  settimana (= assegna + pianifica), o fra settimane (= ripianifica).
- Successo: in una passata si svuota «To plan» senza sovraccaricare
  nessuno; chi è spostato riceve una notifica che dice cosa e chi.
- Verità: il carico è in **taglie**, barra senza numero, con «+N no
  estimate»; conta anche il carico **in tutti i progetti**, perché una
  persona lavora su più progetti. Nessun limite fisso: giudica chi pianifica.

## 3. Direzione scelta

- **Tesi**: una **matrice persone × settimane** a destra, alimentata da
  una **vasca** a sinistra. Righe = persone (Claude compreso, ultima),
  colonne = settimane. Ogni cella mostra prima la barra del carico, poi le
  task. Niente card grandi: righe-task compatte (striscia, codice, titolo).
- **Sequenza**: h1 «Planning» → riga «W43 · Oct 19–23» con «‹ · This week ·
  ›» → a sinistra «To plan N» con `FilterBar` e «Group by» → a destra la
  matrice.
- **Momento focale**: il drop su una cella, con la barra di carico della
  persona che si allunga sotto il cursore **prima** del rilascio
  (anteprima), così la scelta si fa guardando il carico.
- Conseguenza: intestazione di riga persona = `PersonChip` + «12 open here
  · 31 everywhere · 2 slipped»; barra di carico con due toni: questo
  progetto (ink pieno) e altri progetti (ink al 30%) **[ASSUNZIONE: due
  segmenti nella stessa barra, senza colore nuovo]**.

```
┌rail┬column─────┬─Planning ──────────────────────────────────────────────┐
│    │ MKX       │ W43 · Oct 19–23  ‹ This week ›                         │
│    │ …         │ TO PLAN 9  [Filter ▾]   │ PERSON       W43    W44   W45│
│    │ Planning● │ Group: Department       │ GF Giulia    ▬▬▬░   ▬░    ─  │
│    │           │ MARKETING               │ 6 here·14 all▌MKX-21 ▌MKX-30   │
│    │           │ ▌MKX-33 Shoot brief  M  │ 1 slipped    ▌MKX-14↻2         │
│    │           │ ▌MKX-35 Stand copy  —   │ EM Elena     ▬▬▬▬▬▬ +1 no est  │
│    │           │ SALES                   │ 3 here·22 all▌MKX-18 …         │
│    │           │ ▌MKX-40 Price sheet S ↻1│ ◌ Claude     ▬      ─     ─    │
└────┴───────────┴─────────────────────────┴───────────────────────────────┘
```

## 4. Ambito e confini

- Dentro: vasca «To plan» (aperte senza settimana o slittate), matrice per
  3 settimane da quella corrente + «Later →», trascinamento mouse e
  tastiera (`PlanMenu`), sola lettura delle righe altrui senza
  `planning.others`, vista trasversale con selettore di reparto e permesso
  valutato per task, notifiche a chi viene spostato.
- Fuori: giorni (sono personali, vivono in My week), ferie e assenze
  (decisione aperta dello spec), capacità fissa, sprint.
- Anti-obiettivi: numeri di ore o punti; nascondere le task senza stima;
  far credere di poter muovere ciò che non si può.

## 5. Stati e intervalli

- Persone per progetto: 1–15 (+ Claude); trasversale per reparto: 3–10.
- Task per cella: 0–12; oltre 4 la cella mostra 4 righe e «+N more» che
  espande la riga della persona **[ASSUNZIONE: tetto 4]**.
- «To plan»: 0 → «Everything open is planned» (calmo, non festoso);
  tipico 5–30; slittate con «↻N» (Slipped ×N) in testa al gruppo.
- Carico: barra relativa al **massimo della vista** (la persona più carica
  riempie la cella), non a una capacità; «+N no estimate» accanto se N>0.
- Senza `planning.others`: righe altrui con lucchetto discreto e `title`
  «You can only plan your own tasks here»; la propria riga resta viva; la
  vasca trascina solo verso la propria riga.
- Trasversale: task di progetti senza permesso in sola lettura, tooltip
  «You can't plan tasks in <project>»; reparto senza persone → vuoto con
  la frase.
- Caricamento: scheletro di 6 righe × 3 celle; errore con «Retry» al posto
  della matrice, vasca indipendente. Rollback del drop con toast «Couldn't
  move MKX-33 · Try again».

## 6. Interazione e layout

- Vasca fissa 280px con filetto a destra, scorre da sola; matrice scorre in
  verticale con intestazione delle settimane e colonna persone fisse
  (sticky). Colonna persone 168px.
- **1024×680**: area 720px → vasca 280 + persone 168 = restano ~270px:
  la matrice mostra **una settimana** alla volta con «‹ ›» e «Later →».
  **[ASSUNZIONE]** In alternativa la vasca si chiude in una linguetta
  «To plan 9» e la matrice mostra 2 settimane: preferisco la vasca sempre
  visibile, perché è la fonte del trascinamento. Da 1280 due settimane, da
  1440 tre.
- Pannello di dettaglio: in Planning si apre **sempre sovrapposto**, anche
  ≥1200, per non stringere la matrice **[ASSUNZIONE]**; Esc torna alla
  stessa cella col fuoco.
- Tastiera: frecce/J-K nella vasca; Enter apre il dettaglio; «P» o il menu
  della riga apre `PlanMenu` (persona → settimana, con la barra di carico di
  ogni persona nel menu); nella matrice frecce fra celle.
- Drop: la cella bersaglio si tinge d'ink al 6%, la barra mostra
  l'anteprima; al rilascio la task appare nella cella (150ms) ed esce dalla
  vasca; toast «MKX-33 planned for Giulia · W44 · Undo».
- Settimane a cavallo d'anno in ordine cronologico (W53 → 2027-W01).

## 7. Vincoli e decisioni aperte

- Accessibilità: matrice come `grid` con intestazioni di riga/colonna;
  annuncio live «MKX-33 moved to Elena, week 44».
- Italiano: «Da pianificare», nomi di persona lunghi con ellissi; settimana
  sempre «W43» + intervallo date nel formato della lingua.
- **[ASSUNZIONE]** Claude appare sempre come ultima riga e il suo carico è
  in taglie come gli altri.
- **[ASSUNZIONE]** trascinare **fuori** da una cella verso la vasca toglie
  la settimana (non l'assegnatario).
