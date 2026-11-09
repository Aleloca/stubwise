# Shape brief — Sezione «Claude» nel dettaglio della task

Superficie: `pages/task/ClaudeSection.tsx` (sostituisce il segnaposto) e
`pages/task/WorkStory.tsx`, nel pannello `?task=<CODE-n>` (360–640px,
agganciato da 1200, sovrapposto 400px sotto). Piano: Task 7. Spec: area 3
§3, «Regole di fondo». Mondo: «Catalogo numerato», modalità **Operate**.
Componenti delle schede: `conversation.md`. **[ASSUNZIONE]** = da
confermare.

## 1. Lavoro e pubblico

- Chi apre una task affidata a Claude: il richiedente (vuole sapere a che
  punto è), chi ha `plans.approve` (deve approvare o rispondere), il
  revisore (PR, correzioni), un collega di passaggio.
- Non è il posto per seguire la sessione riga per riga: è il **riassunto
  operativo** del lavoro di Claude su quella task, con le decisioni
  risolvibili sul posto e un passaggio netto alla sessione intera.

## 2. Esito e prova

- Azione primaria: dipende dallo stato, ed è sempre **una** in evidenza —
  rispondere, approvare, avviare, rilanciare, riprendere la correzione,
  chiedere modifiche.
- Successo: in tre secondi si legge stato, cosa ha detto Claude per ultimo
  e cosa serve da me; rispondere qui chiude la stessa domanda nella
  conversazione e in «Decide» della Home (un solo esito).
- Verità: i permessi di oggi, invariati (`runs.start`,
  `corrections.request`, `plans.approve`, richiedente per le domande);
  la storia del lavoro afferma solo ciò che i dati dimostrano.

## 3. Direzione scelta

- **Tesi**: la sezione resta **una sezione del pannello** come le altre
  (titolo `heading-group` CLAUDE, filetto), ma è l'unica che può contenere
  una scheda di decisione. Ordine interno fisso: stato → scheda aperta (se
  c'è) → ultimo messaggio → PR e correzioni → azioni → storia del lavoro.
- **Riga di stato**: avatar CL con l'anello (pulsa se «Working») + frase
  di stato 14px + tempo a destra («Working · editing `src/export.ts` ·
  now», «Waiting for your answer · 12 min», «Waiting for approval», «Paused
  · budget reached», «Done · PR opened», «Failed · tests didn't pass»).
- **Scheda aperta**: la stessa `QuestionCard` / `PlanCard` della
  conversazione in variante compatta (pannello), risolvibile qui. Il piano
  mostra solo «In brief» + «Read the full plan» (apre la sessione su quel
  punto).
- **Ultimo messaggio**: due righe dell'ultimo testo di Claude in ink-muted
  con ellissi, poi il link **«Open session»** (→ `#/claude/<id>`).
- **Momento focale**: la scheda aperta, con il punto «ti aspetta» nella
  riga di stato.

```
┌─ CLAUDE ────────────────────────────── [⋯] ┐
│ (CL) Waiting for your answer        12 min │
│ ┌ ● Claude asks ─────────────────────────┐ │
│ │ Which export format should be default? │ │
│ │ ▸ CSV (UTF-8)            Recommended   │ │
│ │   Keeps today's import scripts working │ │
│ │ ▸ XLSX                                 │ │
│ │ ▸ Other…                               │ │
│ └────────────────────────────────────────┘ │
│ "I found two export paths; before changing │
│  the default I need to know…"              │
│ Open session →                Follow here  │
│ PR #142 · audin/web · open                 │
│ Review: changes requested · Correction 1   │
│ [Request changes]                          │
│ ▸ Work story 7                             │
└────────────────────────────────────────────┘
```

## 4. Ambito e confini

- Dentro: stato, scheda aperta, ultimo messaggio, PR (anche multi-repo:
  una riga per repository), review e correzioni, azioni, storia del lavoro,
  «Follow here», «Open session», menu «⋯» con «Pre-approve the plan» /
  «Revoke pre-approval» (solo `plans.approve`).
- Fuori: il flusso completo (sta nella sessione); configurazione della
  review o del revisore (impostazioni di progetto).
- Anti-obiettivi: tre bottoni primari insieme; la storia del lavoro aperta
  di default che spinge giù il resto del pannello; testo «Opens when live
  sessions are available» (va rimosso).

## 5. Stati e intervalli

- `none`, Claude nel progetto: «Claude isn't on this task» + «Assign to
  Claude» (`tickets.edit`). Claude non nel progetto: la frase di oggi
  («Claude isn't a member of this project»), nessuna azione.
- Assegnata, mai avviata: «Ready to start» + **Start** (`runs.start`);
  senza permesso «Someone who can start runs in AUD can start it».
- `working`: stato + ultimo messaggio + «Follow here» / «Open session»;
  nessun primario.
- `awaiting_answer`: scheda domanda; chi non può rispondere la legge con la
  frase di chi può.
- `awaiting_approval`: scheda piano; senza `plans.approve` «Waiting for
  someone who can approve plans in AUD».
- `stopped` / fallita: motivo vero in una riga + **Relaunch with
  instructions** (campo che si apre nella sezione). Correzione ferma
  (`held`): **Resume correction**; ferma per budget senza `plans.approve`:
  «Needs someone who can approve plans in AUD».
- `done` con PR aperta: righe PR/review/correzioni + **Request changes**
  (`corrections.request`); PR mergiata: «Merged · Oct 22», nessuna azione.
- **PR e correzioni**: righe 32px — «PR #142 · audin/web · open» (link
  esterno), «Review: changes requested», «Correction 2 · sent · 3 min» o
  «Correction 2 · waiting» — numerate per PR come la storia di oggi.
- **Storia del lavoro**: chiusa di default, «▸ Work story 7»; aperta,
  elenco cronologico dal più vecchio (tempo tabellare · evento):
  «Run started», «Plan approved by Giulia Ferri», «PR #142 opened»,
  «Correction 1 requested by Marco Bellini». Solo eventi dimostrabili
  (stesse regole di `buildTicketHistory`). 0–~40 voci.
- Caricamento: due righe scheletro nella sezione; errore locale «Couldn't
  load Claude's work» + «Retry» (il resto del pannello vive).

## 6. Interazione e layout

- **Passaggio alla sessione — due vie** **[ASSUNZIONE]**:
  - **Open session** apre `#/claude/<id>` a pagina intera con la task come
    lato oggetto; «Indietro» torna alla vista di prima col pannello aperto.
  - **Follow here** trasforma il pannello nella conversazione compatta
    (larghezza del pannello, casella in fondo al pannello, testata «AUD-91 ·
    Claude session» con «← Task» e «Open full page»); le altre sezioni
    della task si nascondono finché non si torna. Utile per seguire mentre
    si guarda l'elenco a sinistra.
- Rispondere o approvare: la scheda si riduce alla riga d'esito (200ms), la
  riga di stato cambia, il punto «ti aspetta» sulla tessera si spegne;
  toast solo in caso d'errore («Already answered by Marco Bellini»).
- «Relaunch with instructions» e «Request changes»: campo nella sezione,
  invio con ⌘Enter, «Cancel»; dopo l'invio la riga di stato passa a
  «Working» e l'anello compare.
- Larghezza 360: bottoni della scheda a capo, opzioni a tutta larghezza;
  640: conseguenza delle opzioni accanto all'etichetta se ci sta.
- Posizione nel pannello: invariata (dopo Description). **[ASSUNZIONE]**
  quando la sezione ha una scheda aperta che aspetta *me*, il pannello si
  apre già scorso su di essa e la testata mostra «Claude is waiting on you
  ↓».

## 7. Vincoli e decisioni aperte

- Una sola fonte per la domanda e il piano: le schede leggono lo stesso
  evento della conversazione e di «Decide»; nessuna copia locale.
- Permessi dal livello dati; il client non deduce chi può approvare.
- Annunci: cambio di stato in `aria-live="polite"`.
- **[ASSUNZIONE]** «Assign to Claude» non avvia: avviare resta un clic
  separato (Start), come il gate di oggi.
