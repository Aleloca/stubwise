# Shape brief — Togliere design e piano da task e richieste

> Stato: **decisa**, 27 nov 2026 (94; decisioni in fondo), per il ritiro del web
> vecchio (inventario `docs/plans/2026-11-27-ritiro-web-inventario.md`, r.88-89).
> Le rotte ci sono: `DELETE /api/tickets/:id/design|plan` e
> `DELETE /api/backlog/:id/design|plan`.

## Cosa c'è oggi nel prototipo

- **Richiesta** (`RequestDetail`): le sezioni DESIGN e PLAN compaiono quando
  ci sono, in sola lettura (r.527-541). Le scrive il refine con Claude.
- **Task**: design e piano non ci sono affatto, né nel modello (`Task`) né
  nella pagina. Il piano di un run si legge nella conversazione di Claude
  (`PlanCard`). Però il server tiene `tickets.design` e `tickets.plan`, che si
  scrivono con l'MCP (`set_design`, `set_plan`) e con la conversione da
  richiesta. Il run li usa: con un piano salvato, Claude non pianifica da sé.
  Nel web vecchio stanno sulla pagina del ticket, ciascuno col suo «Remove».

**Cosa fa il server** (letto dalle rotte): il design non si aggiunge, ma
**sostituisce** il corpo, cioè la descrizione della task o il documento della
richiesta, e tiene da parte l'originale. «Remove design» rimette il testo
originale. Il piano invece è un campo a sé. Il dialogo deve dirlo, perché
togliere il design cambia la descrizione che si legge.

## Direzione proposta

- **Richiesta:** un «⋯» nell'intestazione di DESIGN e di PLAN, con
  «Remove design…» e «Remove plan…». Lo vede solo chi ha `backlog.edit`.
  Il dialogo dice la conseguenza in una riga: «The description goes back
  to the original text. A refine with Claude can write the design again.». Poi **Remove** e **Cancel**.
  Dopo, la sezione sparisce e compare il toast «Design removed».
- **Task** **[DP 2]:** due sezioni DESIGN e PLAN, chiuse di default, sotto la
  descrizione. Compaiono solo quando ci sono. Hanno lo stesso «⋯ Remove…».
  Per il piano, la riga del dialogo dice: «The next run plans on its own,
  and the plan goes to approval again.».

## Decisioni (27 nov 2026)

- **DP-Q1** (46): «Remove» nel «⋯» dell'intestazione della sezione, con il
  dialogo che dice la conseguenza; sulla richiesta con `backlog.edit`.
- **DP-Q2** (maintainer): sulla task le sezioni DESIGN e PLAN, chiuse di
  default, in lettura e con lo stesso Remove.
- **DP-Q3** (46): sulla task con `tickets.edit`, come la rotta.

## Le domande com'erano

Ognuna ha la mia raccomandazione per prima.

- **DP-Q1. Sulla richiesta:** «Remove» nel «⋯» dell'intestazione della
  sezione, con un dialogo di conferma.
  - *Alternativa:* un bottone sempre visibile.
- **DP-Q2. Sulla task, dove il prototipo non mostra design e piano:**
  - *Raccomandato:* aggiungere le due sezioni (lettura + Remove), perché il
    server le tiene, il run le usa e il web vecchio le mostra. La nuova app lo
    sostituisce, quindi senza queste sezioni un piano salvato sarebbe
    invisibile.
  - *Alternativa:* solo «Remove» nel «⋯» della task, senza mostrarle.
    Sconsigliato: si toglierebbe qualcosa che non si vede.
- **DP-Q3. Chi sulla task:**
  - *Raccomandato:* chi può modificare la task, cioè gli stessi permessi del
    server sulla rotta, letti dal livello dati.
