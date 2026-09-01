---
name: stubwise
description: Usa quando lavori con backlog, ticket o piani/documenti di design collegati a Stubwise. Da attivare quando scrivi un doc di design/piano (es. in docs/plans/), quando avvii o completi l'implementazione di un piano, quando l'utente chiede "cosa c'è in backlog", quando emerge lavoro collaterale da annotare, o in generale per creare/consultare/aggiornare backlog item e ticket tramite i tool MCP Stubwise.
---

# Stubwise: backlog e ticket da Claude Code

Questa skill descrive COME e QUANDO usare i tool MCP `stubwise` per tenere
sincronizzati backlog e ticket con il lavoro di design e implementazione.

## Tool MCP disponibili

Lettura: `list_projects`, `list_backlog`, `get_backlog_item`, `list_tickets`,
`get_ticket`. `get_backlog_item`/`get_ticket` mostrano anche
`implementationPlan` (il piano salvato) e `originContent` (il corpo/feedback
originale, se il design ha sostituito il corpo principale).

Scrittura: `create_ticket`, `convert_backlog_to_ticket`, `set_ticket_status`,
`run_ticket` (avvia l'esecuzione del ticket sul worker Stubwise, vedi § "Locale
o Stubwise?" e § 8).
Per creare una voce di backlog ci sono DUE tool distinti (vedi § "Portare
contenuto in una voce di backlog"): `create_backlog_from_design` (design GIÀ
pronto, salvato verbatim) e `create_backlog_item` (feedback/idea grezza, che
l'intake AI RIASSUME). Su voci/ticket ESISTENTI: `set_design`, `delete_design`,
`set_plan`, `delete_plan` — tutti con firma `{ target: "backlog" | "ticket", id,
content? }` (`content` obbligatorio solo nei `set_*`).

Il progetto di default è quello collegato al repo (`.stubwise.json`). Se un tool
ti dice che il repo NON è collegato (nessun progetto risolto), NON inventare uno
slug: suggerisci all'utente di lanciare il comando **`/stubwise:init`** per
collegare la repo.

## Frontmatter di riferimento

Quando un doc/piano è collegato a Stubwise, registra i riferimenti nel suo
frontmatter YAML, così restano tracciabili:

```yaml
stubwise:
  project: <slug>
  backlogItem: <id>   # + URL della voce di backlog
  ticket: <number>    # + URL del ticket
```

Compila solo i campi pertinenti al flusso in corso.

## Semantica degli stati del ticket

- `in_progress`: impostalo AUTOMATICAMENTE quando avvii l'implementazione di un
  piano/ticket.
- `in_review`: impostalo AUTOMATICAMENTE quando l'implementazione è finita
  (codice pronto per la review / PR aperta).
- `done`: SOLO on-demand. Non chiuderlo mai da solo: aspetta che l'utente
  confermi il rilascio (es. "ho rilasciato il ticket X", "chiudi il ticket").

## Portare contenuto in una voce di backlog

Ci sono TRE modi, e scegliere quello giusto è importante: usare lo strumento
sbagliato APPIATTISCE un design curato.

1. **Hai un design GIÀ completo** (un doc di design/piano finito, tipicamente in
   `docs/plans/`) → **`create_backlog_from_design`**. Salva il design VERBATIM
   come corpo della nuova voce e usa l'AI SOLO per stimare i metadati (urgenza,
   tipo, ecc.). È il DEFAULT quando parti da un documento pronto. **NON** usare
   `create_backlog_item` per un design pronto: il suo intake lo RIASSUMEREBBE,
   perdendo struttura e dettagli.
2. **Hai un feedback o un'idea grezza** (poche righe, non ancora strutturate) →
   **`create_backlog_item`**. Un intake AI asincrono la SINTETIZZA in un
   documento conciso: **NON conserva il testo verbatim**, ed è voluto (serve a
   dare forma a input grezzi).
3. **Vuoi arricchire una voce/ticket che ESISTE già** → **`set_design`** (o
   **`set_plan`** per il piano). Vedi § "Caricare il design definitivo su una
   voce/ticket ESISTENTE" e § "Salvare / rigenerare il piano". Se stai lavorando
   su qualcosa che esiste, NON creare un doppione con i tool di creazione.

## Locale o Stubwise?

Un piano può essere eseguito in DUE posti diversi. Capire quale vuole l'utente è
il primo bivio, e i due comandi non sono intercambiabili:

- **`/stubwise:start`** → **implemento io, in questa sessione**. Sincronizza
  Stubwise (ticket + design + piano + `in_progress`) e poi scrivo il codice qui.
- **`/stubwise:run`** → **esegue il worker di Stubwise** (sul server). Stessa
  sincronizzazione, poi `run_ticket({ id })`: il worker lavora sul repo
  collegato e alla fine apre una PR. In questa sessione NON si scrive codice.

Trigger tipici per `run`: "fallo fare a Stubwise", "esegui sul VPS", "lancia il
run", "manda in esecuzione", "accodalo al worker". Nel dubbio, chiedi.

Cosa sapere sul run (dettagli in § 8):

- Con un piano salvato (`set_plan`) il worker esegue **direttamente quel piano**.
- **Ruoli**: un `admin` (maintainer) fa partire il job subito (`queued`); un
  `member` (operatore) passa sempre da un **gate di approvazione** — con piano
  salvato il job nasce in attesa di approvazione, senza piano parte `queued` ma
  si ferma sul gate a pianificazione finita. Quindi `queued` NON garantisce che
  arrivi una PR senza altri passaggi.
- Dopo un esito "in attesa di approvazione del piano" **non rilanciare
  `run_ticket`**: approvato il piano, l'esecuzione riparte da sola. Non esiste
  un tool MCP per approvare/rifiutare: lo fa un maintainer da web app o Slack.
- **Domande dell'agente**: un run che PIANIFICA (nessun piano salvato, oppure
  `mode: "ai_plan"`) può fermarsi con una **domanda a scelta multipla**. Si
  risponde dall'**inbox** di Stubwise, dal **DM Slack** o dalla **pagina del
  ticket**; possono farlo chi ha lanciato il run e i maintainer. Alla risposta la
  pianificazione **riprende da sola**: come per l'approvazione, **non rilanciare
  `run_ticket`** e non esiste un tool MCP per rispondere.
- Con `/stubwise:run` gli stati successivi NON li gestisci tu: è la pipeline a
  portare il ticket in `in_review` quando apre la PR.

## I flussi

### 1. Design/piano → nuova voce di backlog

Dopo aver scritto un documento di design o di piano (tipicamente in
`docs/plans/`) e NON c'è ancora una voce/ticket a cui collegarlo, crea una voce
di backlog con **`create_backlog_from_design`** (percorso 1 qui sopra):

- `title` = titolo del piano.
- `design` = contenuto del documento (markdown) — salvato **verbatim**.

Ritorna **id** e URL: scrivi il riferimento (`backlogItem` + URL) nel
frontmatter del doc. I metadati (urgenza/tipo) vengono stimati dall'AI, il corpo
resta il tuo testo.

> Usa `create_backlog_item` (invece di `create_backlog_from_design`) SOLO quando
> l'input è grezzo/non strutturato (feedback, appunto). È **asincrono**: se
> ritorna un **id** referenzialo nel frontmatter; se ritorna **"accodata / in
> corso"** (pending) NON è un errore — committa comunque il doc e aggiungi il
> riferimento più tardi (ritrovi la voce con `list_backlog`; se è stata unita a
> una simile, l'id restituito è quello canonico).

### 2. Avvio esecuzione di un piano — con backlog esistente

Quando l'utente ti chiede di **implementare / eseguire un piano** che nasce da una
voce di backlog, PRIMA di scrivere codice esegui SEMPRE questa checklist (oppure
lancia il comando **`/stubwise:start`**, che la esegue per te; se l'esecuzione la
deve fare il worker Stubwise, il comando è **`/stubwise:run`**):

1. **Assicura design e piano SULLA VOCE prima del convert.** Se hai un design doc
   finalizzato in locale, caricalo con
   `set_design({ target: "backlog", id, content: <markdown del design> })`; se hai
   un piano di implementazione, `set_plan({ target: "backlog", id, content })`.
   ⚠️ Questo passo è quello che spesso viene dimenticato: `convert` porta sul
   ticket ciò che è GIÀ sulla voce, quindi senza `set_design`/`set_plan` prima, il
   ticket eredita il documento VECCHIO della voce, non il tuo design/piano finale.
2. **Converti** la voce in ticket: `convert_backlog_to_ticket({ id })` → ottieni il
   ticket (che eredita il design come corpo e il piano nel campo dedicato).
3. **`set_ticket_status({ id, status: "in_progress" })`**.
4. Scrivi il riferimento al ticket (`ticket` + URL) nel frontmatter del piano.
5. A implementazione finita → `set_ticket_status` a `in_review`.

### 3. Avvio esecuzione di un piano — senza backlog

Quando c'è un piano ma nessuna voce/ticket a cui è collegato (stessa checklist,
via `/stubwise:start` — o `/stubwise:run` se esegue il worker):

1. **Crea il ticket** con il design come corpo:
   `create_ticket({ type: "task", title, body: <design/piano> })` → ottieni il
   ticket. (In alternativa, se vuoi che resti anche nel backlog:
   `create_backlog_from_design` → poi `convert_backlog_to_ticket`.)
2. **Piano**: se il piano è separato dal corpo, salvalo con
   `set_plan({ target: "ticket", id, content })`.
3. **`set_ticket_status({ id, status: "in_progress" })`**.
4. Riferimento al ticket nel frontmatter del piano.
5. A implementazione finita → `in_review`.

> **Non saltare i passi 1–3.** Il feedback ricorrente è che, avviando un piano,
> a volte NON si crea/converte il ticket o NON si caricano design e piano. Quando
> l'utente dice "eseguiamo/implementiamo questo piano" (o simili), tratta questi
> passi come OBBLIGATORI prima di toccare il codice.

### 4. Consultazione del backlog

Alla domanda "cosa c'è in backlog?" (o simili):

1. `list_backlog` filtrando sugli stati aperti e ordinando/ragionando per
   urgenza (usa i filtri `status`, `urgency`, `q`, `limit`).
2. Riassumi le voci trovate e proponi cosa affrontare, con priorità.
3. Per il dettaglio di una voce usa `get_backlog_item`.

### 5. Nota al volo

Quando durante il lavoro emerge un'attività collaterale / un'idea da non
perdere, registrala nel backlog con **`create_backlog_item`** (stesso caveat
asincrono del flusso 1). Non serve interrompere il lavoro corrente: è una nota.

### 6. Caricare il design definitivo su una voce/ticket ESISTENTE

Quando hai finalizzato un documento di design partendo da una voce di backlog o
da un ticket già esistente (la sua richiesta iniziale / feedback), carica il
design con **`set_design`**:

```
set_design({ target: "backlog" | "ticket", id, content: <markdown del design> })
```

- **Sostituisce il corpo VERBATIM** della voce/ticket con il design doc, così
  non resta discordanza tra la richiesta iniziale e ciò che è stato deciso.
- L'**origine** (il vecchio corpo / feedback iniziale) NON va persa: viene
  preservata in `originContent`, consultabile con `get_backlog_item`/`get_ticket`.
- È il modo di "caricare il design definitivo" su qualcosa che esiste già, e
  **funziona anche su una voce appena creata** (es. per allineare il corpo a un
  design rifinito dopo).

Distinguo importante: i tool di CREAZIONE (`create_backlog_from_design` per un
design pronto, `create_backlog_item` per un input grezzo) fanno una voce NUOVA
(flusso 1); **`set_design` arricchisce una voce/ticket ESISTENTE** preservando
l'origine. Se stai lavorando su una voce/ticket già presente, usa `set_design`,
non creare un doppione.

Ricorda comunque il riferimento nel frontmatter del doc locale (§ "Frontmatter
di riferimento"): il doc continua a referenziare la voce/ticket di origine.

### 7. Salvare / rigenerare il piano di implementazione

Dopo aver finalizzato un piano di implementazione, salvalo con **`set_plan`**:

```
set_plan({ target: "backlog" | "ticket", id, content: <markdown del piano> })
```

- Il piano finisce in un campo **DEDICATO** (`implementationPlan`), separato dal
  design: `set_plan` NON tocca il corpo/design né `originContent`.
- Per **rigenerare SOLO il piano** (es. hai ripreso la voce e il codice nel
  frattempo è cambiato) richiama `set_plan` con il nuovo contenuto: aggiorna il
  piano lasciando intatto il design.

### 8. Ticket con piano → esecuzione diretta della pipeline

Per un **ticket** con un `implementationPlan` salvato, la pipeline di fix esegue
**direttamente quel piano**, saltando triage e pianificazione dell'agente. Quindi
salvare un piano solido sul ticket con `set_plan` significa consegnarlo alla
pipeline pronto per l'esecuzione.

Il tool **`run_ticket({ id })`** avvia quell'esecuzione da qui (è lo stesso "Run
AI" della web app). Il comando **`/stubwise:run`** fa l'intera checklist:
assicura il ticket con design e piano, lo mette `in_progress` e poi chiama
`run_ticket`.

Esiti e semantica:

- **`queued`** → il worker prenderà in carico il job a breve. Riporta il link al
  ticket e passa la mano.
- **in attesa di approvazione del piano** → un maintainer deve approvare prima
  dell'esecuzione; dopo l'approvazione **l'esecuzione parte automaticamente**,
  quindi **non rilanciare `run_ticket`**. Non c'è un tool MCP per approvare o
  rifiutare: lo fa un maintainer dalla web app o da Slack.
- **in attesa di una domanda dell'AI** → durante la pianificazione l'agente può
  fermarsi e chiedere come procedere (2–4 opzioni, a volte con una consigliata e
  la possibilità di rispondere a parole). Il job resta vivo e la domanda arriva
  in **inbox**, in **DM Slack** e sulla **pagina del ticket**; rispondono chi ha
  lanciato il run e i maintainer. Data la risposta, il run **riprende da solo**:
  **non rilanciare `run_ticket`** e non c'è un tool MCP per rispondere. Succede
  solo nei run che pianificano (senza piano salvato, o con `mode: "ai_plan"`);
  in esecuzione diretta di un piano salvato nessuno può fare domande. Se il
  ticket resta fermo su una domanda, riferisci all'utente che serve una risposta
  e fermati.
- **409 "c'è già un job in corso"** → non ritentare: attendi che il job in volo
  finisca (o che il maintainer approvi il piano, o che qualcuno risponda alla
  domanda dell'AI) e dillo all'utente.
- **`mode: "ai_plan"`** → **AZZERA il piano** per quel run e fa ripianificare
  l'agente da zero. Non è "usa il piano come base": usalo solo se l'utente
  chiede esplicitamente una ri-pianificazione.

Dopo il lancio l'implementazione è del worker: **non scrivere codice in locale**
per quel ticket (se l'utente voleva farlo qui, il comando è `/stubwise:start`).

### 9. Eliminare design o piano

Su richiesta esplicita dell'utente:

- **`delete_design({ target, id })`** — rimuove il design e **ripristina
  l'origine** (`originContent`) come corpo principale della voce/ticket. Attenzione:
  ripristina la richiesta ORIGINALE catturata al primo `set_design`, scartando
  eventuali edit manuali del corpo (PATCH / refresh-document) fatti mentre il
  design era attivo — è voluto ("elimina design → torna all'origine").
- **`delete_plan({ target, id })`** — azzera il piano di implementazione (non
  tocca design né corpo).
