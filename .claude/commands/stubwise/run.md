---
description: Esegue un piano SU Stubwise — assicura il ticket, carica design e piano, lo mette in in_progress e lancia run_ticket (l'implementazione la fa il worker, non questa sessione).
---

Stai per **far eseguire un piano a Stubwise**: il lavoro sul codice lo farà il
worker sul server, non questa sessione. Prima di lanciare l'esecuzione,
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

Questo passo è **decisivo** qui: il worker eseguirà il piano che trova SUL
ticket, quindi un piano non caricato (o vecchio) significa un run sbagliato.

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

## 4. Lancia l'esecuzione sul worker

Chiama **`run_ticket({ id })`** (senza `mode`: così il worker esegue
DIRETTAMENTE il piano appena salvato, saltando triage e pianificazione).

Riporta all'utente l'esito con il link al ticket. Due casi:

- **`queued`** → il job è accodato, il worker lo prenderà in carico a breve.
  Dillo e passa la mano: l'avanzamento si segue dal ticket in Stubwise.
- **in attesa di approvazione del piano** → il job esiste ma **un maintainer
  deve approvare il piano** prima che parta l'esecuzione (succede quando il tuo
  utente è un operatore). Dopo l'approvazione **l'esecuzione parte da sola**:
  non rilanciare `run_ticket`. Comunica all'utente che serve l'approvazione di
  un maintainer (dalla web app o da Slack) e fermati.

Non esiste un tool MCP per approvare o rifiutare un piano: in questo caso il tuo
compito finisce qui.

C'è un terzo esito, che arriva **più tardi** e non dal tool: se il run include
una **pianificazione** (nessun piano salvato sul ticket, o `mode: "ai_plan"`),
l'agente può fermarsi e **fare una domanda** — 2–4 opzioni, a volte con una
consigliata, a volte con la possibilità di rispondere a parole. Il job resta
vivo in attesa e la domanda compare **nell'inbox di Stubwise, in DM Slack e
sulla pagina del ticket**; rispondono chi ha lanciato il run e i maintainer.
Data la risposta la pianificazione **riprende da sola**: come per
l'approvazione, **non rilanciare `run_ticket`** (lo rifiuterebbe con un 409) e
non c'è un tool MCP per rispondere. Se l'utente ti chiede a che punto è e il
ticket è fermo su una domanda, digli che serve una risposta da una di quelle tre
superfici e fermati.

Non riportare tu il ticket a `in_review`: quando apre la PR lo fa la pipeline.

---

**NON implementare in locale in questa sessione**: il lavoro lo fa il worker.
Se l'utente voleva implementare qui, il comando giusto è **`/stubwise:start`**.

Altre note:

- **`mode: "ai_plan"`** non è "usa il piano come base": **AZZERA il piano** per
  quel run e fa ripianificare l'agente da zero (triage + pianificazione). Usalo
  solo come scelta deliberata dell'utente ("ripianifica tu"), mai come default.
- **409 "C'è già un job in corso"** → non è un errore da ritentare: c'è già un
  job in volo su quel ticket. Attendi che finisca (o, se è in attesa di
  approvazione del piano o di una risposta a una domanda dell'AI, che un umano
  decida) e riferiscilo all'utente, senza rilanciare.
- Anche con `queued`, un run avviato da un **operatore** senza piano salvato si
  fermerà comunque sul gate di approvazione dopo la pianificazione: non
  promettere che arriverà una PR senza altri passaggi.

Se un tool segnala che il repo NON è collegato a un progetto (nessuno slug
risolto), fermati e suggerisci `/stubwise:init` invece di inventare uno slug.
