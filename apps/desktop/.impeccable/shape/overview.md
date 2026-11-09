# Shape brief — Overview di progetto + Tutti i progetti

Superfici: `#/p/<CODE>/overview` (atterraggio di ogni progetto) e
`#/projects` (portafoglio, dal binario). Piano: Task 13 e 14. Spec: area 2
§7–8 e «Ferme». Mondo: «Catalogo numerato», modalità **Operate** con un
tratto di **Read** (il brief). **[ASSUNZIONE]** = da confermare.

## 1. Lavoro e pubblico

- Overview: chi apre un progetto mai visto da due settimane — lead,
  commerciale che segue una commessa, sviluppatore di passaggio. Vuole
  capire in **dieci secondi** a che punto è, cosa è aperto, cosa è fermo,
  da quanto e perché (maintainer).
- Tutti i progetti: chi segue molti progetti (fino a ~50), per scegliere
  dove entrare, fissare/sganciare, crearne uno, vedere cosa è fermo ovunque.

## 2. Esito e prova

- Overview — successo: le tre risposte si leggono senza scorrere a 1440×900;
  ogni numero è un link all'elenco filtrato.
- Portafoglio — successo: ciò che aspetta me è in cima; un progetto si
  trova per codice o nome in un tasto.
- Verità: «ferma» porta il **motivo vero** («Waiting for Elena's decision ·
  4 days», «Blocked by AUD-12», «Nobody touched it for 9 days»), mai
  «nessuna attività» generico. Il brief è **narrativa generata** e si dice;
  il registro decisioni è **fatto**, mai scritto dall'AI.

## 3. Direzione scelta — Overview

- **Tesi**: un **resoconto dall'alto in basso** nell'ordine delle tre
  domande, una colonna sola; i numeri sono testo grande tabellare, non
  tessere. Le ferme salgono in cima solo se esistono.
- **Sequenza**: h1 «Overview» → riga di polso in prosa (`Waiting on you ·
  Claude working · 3 stalled · next: Launch, Nov 14`) → **Stalled** (se
  c'è) → **Where it stands** (traguardi con barra di avanzamento, «Closed in
  the last 2 weeks: 14», brief) → **What's open** (per famiglia e per
  persona) → **Timeline** → **Decision log**.
- **Momento focale**: la prima ferma, la più vecchia, con giorni in cifre
  tabellari a sinistra e motivo in chiaro.

```
┌─Overview──────────────────────────────────────────────────────────────┐
│ Waiting on you · Claude working · 3 stalled · next: Launch · Nov 14   │
│ Stalled  3                                                            │
│  12d ▌AUD-77 Onboarding mail   Waiting for the client · "PO pending"  │
│   4d ▌AUD-88 Invoice export    Waiting for Elena's decision           │
│ ───────────────────────────────────────────────────────────────────── │
│ Where it stands                                                       │
│  Launch 2.0    Nov 14  ▬▬▬▬▬▬▬░░░░  2 without estimate     [Manage]   │
│  Closed in the last 2 weeks  14 → list                                │
│  Weekly brief · generated text · Oct 20  "Export work moved to…"  ›   │
│ ───────────────────────────────────────────────────────────────────── │
│ What's open   To do 30 · In progress 12 · by person: Paolo 7 Elena 5… │
│ Timeline  [All types ▾]   W43 ── AUD-91 closed · Decision recorded …  │
│ Decision log                              [Record a decision]         │
└───────────────────────────────────────────────────────────────────────┘
```

## 3b. Direzione scelta — Tutti i progetti

- **Tesi**: il **catalogo dei progetti**: una lista lunga a righe, codice a
  sinistra in cifre tabellari, nome sempre accanto, riga di polso in prosa
  breve. Niente striscia del reparto (regola: i progetti non ne hanno).
- **Sequenza**: h1 «All projects» con conteggio, «New project» (con
  `projects.create`) → schede `Projects · Stalled · Activity` → filtri
  (Internal/Client, Department, Client, Pinned, testo) → gruppi «Waiting on
  you» poi «All projects» (alfabetico).
- Riga 44px: codice · nome (ellissi) · cliente · modello · polso · pin.

```
│ All projects 48                                       [New project]   │
│ [Projects | Stalled | Activity]  Internal·Client ▾ Dept ▾ Pinned  Search…  │
│ WAITING ON YOU                                                        │
│ MKX  Campagne primavera Mix Cucine  Mix Cucine Srl  Marketing  ● 2 stalled · Spring launch Nov 3  [pin]│
│ ALL PROJECTS                                                          │
│ AUD  Audin 2.0          —   Software   ◌ Claude working · 3 stalled  [pin]│
```

## 4. Ambito e confini

- Overview dentro: sezioni sopra, gestione traguardi (crea, modifica,
  chiudi, riapri, elimina con `tickets.edit`) da «Manage», brief completo
  in pannello, registro con «Record a decision» (`decisions.record`).
- Portafoglio dentro: elenco con filtri e ordine, schede Stalled
  (trasversale) e Activity (per data), fissa/sgancia, `NewProjectDialog`
  (nome, codice proposto 2–4 maiuscole modificabile e validato, tipo,
  cliente, modello) che atterra sull'Overview.
- Fuori: grafici di velocità, burndown, KPI; il brief non si rigenera da
  qui **[ASSUNZIONE]**.

## 5. Stati e intervalli

- Ferme: 0 (sezione assente, nessuna frase), tipico 1–6, massimo ~25 →
  mostra 5 e «Show all 25» (apre Tasks filtrato su «stalled»).
- Traguardi aperti 0–5 («No milestones · Add one» se si può); avanzamento
  = taglie chiuse/totali come barra senza numero + «N without estimate».
- Brief assente: «No brief yet · The first one arrives on Monday»
  **[ASSUNZIONE sul testo]**. Registro vuoto: «No decisions recorded yet».
- Timeline: 0–200 eventi; per settimana, filtro per tipo; 3 settimane
  caricate poi «Show earlier».
- Portafoglio: 1–~50 progetti visibili; Contributor ne vede pochi; filtri
  senza risultati → «No projects match» + «Clear filters». Nomi fino a ~50
  caratteri. Activity: 0–100 voci al giorno, raggruppate per data.
- Tutte le sezioni: scheletro della forma vera, errore locale con «Retry»
  (un errore del registro non abbatte le ferme). Progetto invisibile da URL:
  la stessa pagina di «non esiste».

## 6. Interazione e layout

- Overview: colonna di lettura fino a 960px. A 1440 **[ASSUNZIONE]**
  «What's open» va a due colonne interne (per famiglia | per persona);
  sotto 1280 si impila. A 1024×680 (720px) tutto in una colonna; la riga di
  polso va a capo.
- Clic su una ferma o una task → pannello `?task=` (affiancato ≥1200,
  sovrapposto sotto); clic su un numero → Tasks con filtro (`family`,
  `assignee`, `stalled`). Brief → pannello di lettura con «Generated text»
  in testa.
- Portafoglio: righe a tutta larghezza; sotto 1280 cadono prima modello,
  poi cliente (resta nel `title` della riga); il polso si accorcia
  («3 stalled» resta, il traguardo scompare per primo). Pin come bottone
  icona con nome accessibile «Pin AUD» / «Unpin AUD», ottimistico.
- Tastiera: J/K fra righe, Enter entra nel progetto (la colonna scorre sulla
  navigazione del progetto, 200ms), P fissa/sgancia.
- Nuovo progetto: dialogo; il codice si propone mentre si scrive il nome e
  smette di seguirlo appena lo si tocca; errore in linea «AUD is already
  used».

## 7. Vincoli e decisioni aperte

- Le soglie delle ferme (7/14 giorni) sono impostazioni del progetto: la
  frase «Nobody touched it for N days» usa la soglia del progetto.
- Testo del brief e voci del registro: nessuno stile che li confonda; il
  brief porta sempre l'etichetta «Generated text».
- **[ASSUNZIONE]** la riga di polso dell'Overview è la stessa formula della
  riga nel portafoglio (una sola funzione, due superfici).
- **[ASSUNZIONE]** scheda Stalled del portafoglio raggruppata per progetto,
  ordinata dalla più vecchia; Activity raggruppata per giorno.
- **[ASSUNZIONE]** il filtro «Department» mostra i progetti con almeno una
  task aperta di quel reparto.
