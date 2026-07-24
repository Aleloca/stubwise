---
description: Avvia l'esecuzione di un piano su Stubwise — assicura il ticket, ci carica design e piano, e lo mette in in_progress.
---

Stai per **avviare l'esecuzione di un piano**. PRIMA di scrivere codice,
sincronizza Stubwise seguendo questi passi con i tool MCP `stubwise`. Non saltare
nessun passo.

## 1. Identifica il piano e il suo collegamento

- Individua il documento di design/piano che si sta per eseguire (di solito in
  `docs/plans/`). Se non è ovvio quale, **chiedi all'utente**.
- Se il design e il piano sono in due file separati, tienili distinti: il
  **design** alimenta `set_design` / il corpo del ticket, il **piano** alimenta
  `set_plan`.
- Leggi il frontmatter `stubwise:` del doc per capire se è già collegato a una
  voce di backlog (`backlogItem`) o a un ticket (`ticket`). Se non c'è
  collegamento, prova a trovarlo con `list_backlog` / `list_tickets`, oppure
  chiedi all'utente.

## 2. Assicura un ticket, con design e piano caricati

Tre casi:

- **Collegato a una voce di backlog** → carica PRIMA il design e il piano sulla
  voce, POI converti (così il ticket li eredita):
  1. `set_design({ target: "backlog", id, content: <markdown del design> })`
  2. `set_plan({ target: "backlog", id, content: <markdown del piano> })` (se hai un piano)
  3. `convert_backlog_to_ticket({ id })` → ottieni il ticket
  ⚠️ Senza i passi 1–2 prima del convert, il ticket eredita il documento VECCHIO
  della voce, non il tuo design/piano finale.
- **Collegato a un ticket esistente** →
  `set_design({ target: "ticket", id, content })` e
  `set_plan({ target: "ticket", id, content })`.
- **Nessun collegamento** →
  `create_ticket({ type: "task", title, body: <design> })`, poi
  `set_plan({ target: "ticket", id, content })` (se il piano è separato dal design).

## 3. Metti in in_progress e collega il doc

- `set_ticket_status({ id, status: "in_progress" })`.
- Scrivi il riferimento al ticket (`ticket:` + URL) nel frontmatter del doc e
  committa.

## 4. Procedi con l'implementazione

Ora implementa il piano. **Al termine** dell'implementazione (codice pronto / PR
aperta), riporta il ticket a `in_review` con `set_ticket_status`. Lascia `done`
all'utente (on-demand, solo dopo il rilascio).

---

Se un tool segnala che il repo NON è collegato a un progetto (nessuno slug
risolto), fermati e suggerisci `/stubwise:init` invece di inventare uno slug.
