---
stubwise:
  project: stubwise
  backlogItem: 9091d1d0-4481-4807-8678-2eb2e482525b # https://stubwise.thecove.it/backlog/9091d1d0-4481-4807-8678-2eb2e482525b
  ticket: 1 # https://stubwise.thecove.it/tickets/20782021-7e5b-488c-8ddf-3a9850111731
---

# Intake guidato del widget: domande di chiarimento prima del ticket

Data: 2026-08-06
Stato: design validato

## Problema

Oggi il prompt della chat widget (`apps/server/src/routes/widget-chat.ts`,
`buildWidgetSystemPrompt`) istruisce l'LLM a "rispondere utilmente e poi
APPENDERE la proposta di ticket": di fatto la proposta viene emessa già al
primo turno in cui l'LLM riconosce un bug/feedback/feature. Non esiste alcun
meccanismo di follow-up, quindi i ticket entrano in piattaforma con il minimo
contesto (il riassuntino della proposta + trascrizione grezza degli ultimi 10
messaggi). Tutto il flusso a valle — intake backlog con dedup embedding, deep
dive, eventuale fix AI — lavora peggio con input vaghi.

## Soluzione scelta

**Prompt + sintesi strutturata**, sempre attiva e adattiva. Nessuna macchina a
stati, nessuna migrazione, nessun toggle: cambia solo il prompt di sistema
della chat widget (più una costante). Il giro sentinel → card di conferma →
endpoint ticket resta identico.

Alternative scartate:

- *Solo prompt minimale* (domande sì, ma body invariato): il valore delle
  domande resterebbe sepolto nella trascrizione, il ticket non sarebbe più
  "pulito".
- *Flusso strutturato con slot-filling* (stato intake su
  `widget_conversations`, nuovi sentinel, UI dedicata): massimo controllo, ma
  molto più codice per un guadagno incerto rispetto al prompt.
- *Toggle o livello per-widget*: YAGNI; il comportamento è adattivo di suo e
  gli admin hanno già il campo `instructions` per-widget per modulare.

## 1. Comportamento conversazionale (solo prompt)

Il blocco "TICKET PROPOSAL" di `buildWidgetSystemPrompt` viene riscritto in un
blocco "GUIDED INTAKE" con queste regole:

1. Quando l'utente segnala un bug, dà feedback o chiede una feature non
   coperta dalla documentazione, l'LLM NON emette subito la proposta: prima fa
   **una domanda di chiarimento per turno, massimo 3 in totale**, scegliendo in
   base a cosa manca:
   - *bug* → cosa stava facendo / passi, cosa si aspettava vs cosa è successo,
     da quando/dove succede;
   - *feature/feedback* → quale problema sta cercando di risolvere, in che
     contesto, cosa fa oggi in mancanza della feature.
2. **Salta le domande** (proposta subito) se il primo messaggio è già
   completo, oppure se l'utente mostra fretta o insofferenza ("apri e basta",
   risposte secche): l'attrito non deve mai bloccare la segnalazione.
3. **Stop anticipato**: appena l'LLM ritiene di avere il quadro, propone — non
   deve consumare tutte e 3 le domande per principio.
4. Le domande restano nel tono attuale del widget (non tecnico, lingua
   configurata) e non chiedono mai dati sensibili (password, token).

Invariati: sentinel `<<<TICKET_PROPOSAL … TICKET_PROPOSAL>>>`, parsing
streaming-safe (`safeForwardLength`/`extractProposal`), card di conferma,
endpoint di creazione. La history passata all'LLM (ultime 10 coppie,
`WIDGET_HISTORY_PAIRS`) copre i 3 scambi di domande.

## 2. Sintesi strutturata nella proposta

Il sentinel resta `{title, body, type}` (nessuna modifica a schema o parsing):
cambia cosa l'LLM scrive dentro `body`. Al momento della proposta, il prompt
gli chiede di sintetizzare **tutta la conversazione** (non solo l'ultimo
messaggio) in markdown strutturato per tipo, nella lingua del widget:

- **bug** → `**Problema:**`, `**Passi per riprodurre:**`, `**Atteso:**`,
  `**Osservato:**`, più `**Contesto:**` se sono emersi dettagli (browser,
  pagina, da quando);
- **feature** → `**Esigenza:**`, `**Caso d'uso:**`, `**Soluzione proposta:**`
  (se l'utente ne ha suggerita una);
- **feedback** → `**Feedback:**`, `**Contesto:**`.

Regola esplicita: **ometti le sezioni per cui non è emerso nulla, non
inventare mai** — un body corto e vero batte un template compilato a fantasia.

La card di conferma resta com'è: l'utente vede il markdown strutturato nel
textarea e può correggerlo prima dell'invio (title/body editabili, type no).

Lato server, `composeWidgetTicketBody` resta identico nella struttura
(Segnalato da / Segnalazione / Trascrizione), con un solo ritocco:
`WIDGET_TICKET_TRANSCRIPT_MESSAGES` passa da 10 a **20**, perché con 3 scambi
di domande la finestra attuale rischia di tagliare l'inizio della
conversazione. La trascrizione grezza resta nel ticket: è il materiale di
verifica per chi legge e per l'intake backlog.

A valle nessun cambiamento: l'intake backlog (dedup embedding, agente) legge
il body del ticket e beneficia gratis del testo più pulito.

## Test e deploy

- Aggiornare i test esistenti sul prompt del widget (asserzioni sulle nuove
  istruzioni) e su `composeWidgetTicketBody` per il nuovo limite; parsing e
  sentinel già coperti e invariati.
- Deploy: rebuild **solo `server`** (il frontend widget non cambia → niente
  rebuild caddy).
