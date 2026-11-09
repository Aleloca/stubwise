# Shape brief — Refine di una richiesta come conversazione

Superficie: `pages/requests/RefineView.tsx`, aperta da «Refine with Claude»
nel pannello della richiesta (`?request=<id>` in `#/p/<CODE>/requests`).
Piano: Task 8. Spec: area 3 §3 («Refine di una richiesta»), «Regole di
fondo» (prodotti della pipeline come righe già eseguite). Mondo: «Catalogo
numerato», modalità **Operate**. Flusso e casella: `conversation.md`.
**[ASSUNZIONE]** = da confermare.

## 1. Lavoro e pubblico

- Chi ha `backlog.edit` nel progetto (lead, PM, sviluppatore senior) che
  trasforma una richiesta grezza in qualcosa di stimabile e pronto a
  diventare task: ragiona con Claude, che scrive design, piano e metadati.
- Chi vede la sessione senza poter scrivere (altri membri con il permesso
  di vederla): legge com'è nata la stima.
- Stato d'animo: lavoro concentrato di 10–40 minuti, avanti e indietro tra
  la conversazione e il risultato che prende forma.

## 2. Esito e prova

- Azione primaria: arrivare a una richiesta con urgenza, taglia, rischio,
  design e piano compilati, poi «Close the session» (e, fuori da qui,
  «Turn into task»).
- Successo: ogni cosa che Claude scrive si **vede cambiare** nella
  richiesta a lato nel momento in cui avviene, e la riga nel flusso dice
  cosa è cambiato.
- Verità: il piano scritto nel refine **non è approvato** (invariante);
  la sessione è in sola lettura sul codice per costruzione; scrive solo
  chi ha `backlog.edit`.

## 3. Direzione scelta

- **Tesi**: la richiesta **diventa il lato** della propria conversazione.
  L'area di lavoro di Requests passa dall'elenco alla conversazione di
  refine; il pannello agganciato a destra resta la richiesta, ma in
  variante «refine»: campi che si aggiornano dal vivo, design e piano
  leggibili.
- **Sequenza (area di lavoro)**: riga di ritorno «← Requests» → h1 «Refine
  STW-R4» con il titolo della richiesta su una riga sotto (16px) → riga
  meta «Refinement · started by Giulia Ferri · 14 min» e a destra «Close
  the session» → la conversazione.
- **Lato (pannello 360–640px)**: testata richiesta (codice, titolo, stato
  «Being refined») → campi Urgency · Size · Risk → sezioni DESIGN e PLAN
  (markdown, chiuse a 8 righe con «Show all») → Requested by.
- **Momento focale**: il campo appena aggiornato da Claude, segnato per
  pochi secondi da «Updated by Claude · now» accanto (nessuna tinta
  colorata: testo + tinta d'inchiostro 6% che sfuma in 2s).

```
┌─work area──────────────────────────────────┬─STW-R4 ─────────────────┐
│ ← Requests                                 │ Quiet hours for         │
│ Refine STW-R4                              │ notifications           │
│ Quiet hours for notifications              │ ◌ Being refined         │
│ Refinement · Giulia Ferri · 14 min  [Close │ Urgency  ▂▄ Low         │
│                                  session]  │ Size     M  Updated by  │
│ (CL) Claude                                │          Claude · now   │
│ ▸ 3 actions · Read 2 docs pages            │ Risk     Low            │
│ Quiet hours touch the push relay and the   │ ─ DESIGN ────────────── │
│ inbox. I'd size it M: …                    │ Users pick a window per │
│ ✓ Updated the size of STW-R4 · M           │ day; push is held and   │
│ ✓ Updated the design of STW-R4 · See       │ delivered at the end…   │
│ ┌──────────────────────────────────────┐   │ Show all                │
│ │ Reply to Claude…            [Send]   │   │ ─ PLAN ─ Not approved ─ │
│ └──────────────────────────────────────┘   │ 1. Add quiet_hours …    │
└────────────────────────────────────────────┴─────────────────────────┘
```

## 4. Ambito e confini

- Dentro: avvio dal pannello («Refine with Claude», con `backlog.edit`;
  una richiesta con una sessione viva mostra invece «Open refinement»),
  vista con lato vivo, righe `design_updated` / `plan_updated` / metadati
  con «See» che porta il lato sulla sezione, «Close the session» con
  conferma, sola lettura per chi non ha `backlog.edit`.
- Fuori: «Turn into task» e unione (restano nel pannello normale della
  richiesta); approvazione del piano (non esiste nel refine).
- Anti-obiettivi: proposte da confermare per design/piano (sono prodotti
  del lavoro, righe già eseguite); un diff a colori; due copie della
  richiesta che divergono.

## 5. Stati e intervalli

- Avvio: «Refine with Claude» → la vista si apre con il primo turno di
  Claude in arrivo (legge la richiesta e le simili); nessun messaggio
  iniziale obbligatorio **[ASSUNZIONE]**.
- In corso: turni a domanda/risposta (sessione a turni): mentre Claude
  scrive la casella mostra **Stop**; fra un turno e l'altro **Send**.
- Messaggio non consegnato: motivo di oggi del refine («The turn was
  stopped before the agent read the message: send it again») + «Resend»;
  mai «undelivered» per tempismo (invariante).
- Chiusura: dialogo «Close the refinement? Claude stops and the request
  keeps what was written.» · «Cancel» · **Close session**. Dopo: flusso in
  sola lettura con la fase «Refinement · closed by Giulia Ferri», casella
  sostituita da «This refinement is closed.» + «Start a new one»
  (`backlog.edit`).
- Richiesta convertita o archiviata altrove mentre la sessione è viva: la
  sessione si chiude con il motivo «The request was turned into a task or
  archived» (`item_closed`), il lato mostra lo stato nuovo e il codice
  della task se c'è.
- Sola lettura (senza `backlog.edit`): nessun «Refine with Claude»; la
  sessione viva si apre con «Watch refinement» e la fascia «Only someone
  who can edit requests in STW can write here.»
- Lato: design e piano vuoti → «No design yet» / «No plan yet» in muted;
  piano sempre etichettato «Not approved» **[ASSUNZIONE sul testo]**.
- Caricamento: scheletro del flusso + campi del lato; errore del flusso
  locale, il lato resta.

## 6. Interazione e layout

- Rotta **[ASSUNZIONE]**: `#/p/<CODE>/requests?request=<id>&refine=1`; la
  colonna del progetto resta su «Requests». Esc nella vista non chiude
  (si perde il contesto): si esce con «← Requests», che lascia la sessione
  viva.
- Una riga `design_updated` / `plan_updated` / `size_updated`: nel flusso
  «✓ Updated the design of STW-R4 · See»; «See» scorre il lato alla
  sezione e la evidenzia 2s. Il lato si aggiorna nello stesso istante della
  riga (stesso evento), non con una ricarica.
- ≥1200: lato agganciato (larghezza del pannello, ridimensionabile
  320–640). Sotto: lato chiuso, bottone in testata «Request STW-R4» con
  «Updated» se è cambiato qualcosa da quando l'hai guardato; si apre
  sovrapposto 400px.
- La conversazione usa la variante pagina (colonna ≤ 720px); a 1024 con il
  lato sovrapposto la conversazione prende tutta l'area.
- Movimento: ingresso nella vista come un cambio di pagina (200ms);
  evidenziazione del campo che sfuma; nulla con movimento ridotto (resta
  solo «Updated by Claude · now»).

## 7. Vincoli e decisioni aperte

- Lock e scritture come oggi (`backlog-item-writes.ts`): il prototipo li
  rappresenta con le stesse funzioni del livello dati.
- «/» nel refine mostra le skill dei plugin abilitati nel progetto (il
  refine è nel perimetro plugin).
- **[ASSUNZIONE]** Una sola sessione di refine viva per richiesta; chi
  arriva mentre è viva la apre, non ne avvia un'altra.
