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

Scrittura: `create_ticket`, `convert_backlog_to_ticket`, `set_ticket_status`.
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

### 2. Avvio di un piano con backlog esistente

Quando l'utente decide di implementare una voce di backlog già presente:

1. `convert_backlog_to_ticket` con l'`id` della voce → ottieni il ticket.
2. `set_ticket_status` a `in_progress`.
3. Scrivi il riferimento al ticket (`ticket` + URL) nel frontmatter del piano.
4. A implementazione finita → `set_ticket_status` a `in_review`.

### 3. Avvio di un piano SENZA backlog

Quando c'è un piano ma nessuna voce di backlog:

1. `create_ticket` con `type: task` e `body` = il piano → ottieni il ticket.
2. `set_ticket_status` a `in_progress`.
3. Riferimento al ticket nel frontmatter del piano.
4. A implementazione finita → `in_review`.

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

Per un **ticket** con un `implementationPlan` salvato, quando dall'interfaccia di
Stubwise si lancia **"Run AI"** la pipeline di fix eseguirà **direttamente quel
piano**, saltando la fase di pianificazione dell'agente. Quindi, se hai già un
piano solido, salvarlo sul ticket con `set_plan` significa consegnarlo alla
pipeline pronto per l'esecuzione.

(Comportamento previsto: potrebbe non essere ancora attivo sull'istanza al
momento in cui leggi, ma è la direzione — salva pure il piano sul ticket.)

### 9. Eliminare design o piano

Su richiesta esplicita dell'utente:

- **`delete_design({ target, id })`** — rimuove il design e **ripristina
  l'origine** (`originContent`) come corpo principale della voce/ticket. Attenzione:
  ripristina la richiesta ORIGINALE catturata al primo `set_design`, scartando
  eventuali edit manuali del corpo (PATCH / refresh-document) fatti mentre il
  design era attivo — è voluto ("elimina design → torna all'origine").
- **`delete_plan({ target, id })`** — azzera il piano di implementazione (non
  tocca design né corpo).
