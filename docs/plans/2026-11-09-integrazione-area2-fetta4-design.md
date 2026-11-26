# Integrazione area 2, fetta 4 — Requests, Overview, traguardi, Tutti i progetti — design

Data: 9 nov 2026. Chiude l'area 2. Segue i design delle fette 1–3, validi in
tutto. Specifica: il prototipo — `docs/plans/2026-10-23-desktop-area2-task-design.md`
§6 (Requests), §7 (Overview), §8 (Tutti i progetti), `apps/desktop/docs/area2-parity.md`
(sezioni «Backlog → Requests» e «Projects»), `apps/desktop/.impeccable/shape/{overview,project-settings}.md`,
e `apps/desktop/src/renderer/pages/{requests,overview,projects}`.

## Cosa entra

- **Requests** (oggi Backlog) con il **codice R<n>** per progetto: elenco, filtri,
  dettaglio a pannello (richiedenti, simili, task nate, metadati: urgenza,
  taglia, rischio e nota), Nuova richiesta, Trasforma in task, Fondi in…,
  Archivia/Riapri, esporta in Markdown. «Rifinisci con Claude» resta «in
  arrivo» (area 3).
- **Overview**: a che punto è (traguardi con avanzamento in taglie, chiuse
  nelle ultime due settimane, brief settimanale etichettato come testo
  generato), cosa è aperto (per famiglia e persona, cliccabile), cosa è fermo
  (in cima, dal più vecchio), cronologia, registro decisioni (lettura,
  registrazione a mano, «superata da»).
- **Gestione dei traguardi** (crea, modifica, chiudi/riapri, elimina) dove la
  mette il prototipo.
- **Tutti i progetti**: portafoglio col polso, filtri, ferme trasversali,
  attività trasversale per giorno, fissa/sgancia, **Nuovo progetto** con
  codice, interno/commessa, cliente e modello (stati iniziali e moduli).
- **Moduli** dei progetti: le sezioni Docs, Releases, Support e Servers
  seguono i moduli accesi (restano comunque «in arrivo» finché la loro area non
  è integrata). Aprire un progetto torna ad atterrare sull'**Overview**.

## Decisioni del maintainer (9 nov 2026)

- **Intake mantenuto anche nell'app** (si discosta dal prototipo): una
  richiesta creata dall'app passa dall'intake come oggi e può essere fusa da
  sola in una esistente; l'app lo dice («Unita a R12», con il link), invece di
  mostrare una richiesta nuova. Il suggerimento «simile a» del prototipo resta
  per le voci non fuse.
- **«Fondi in…» con la riscrittura AI** (si discosta dal prototipo): la
  destinazione viene riscritta dal modello come oggi; l'app mostra l'attesa
  e, se il modello non risponde, un errore con «Riprova» senza aver cambiato
  nulla.
- **Progetti esistenti**: modello **Software** con **tutti e quattro i moduli**,
  interni (nessun cliente).
- **Cronologia a pagine**: le ultime quattro settimane più i traguardi futuri,
  con «Load older» che carica le quattro settimane prima finché c'è storia.

## Scelte dell'orchestratrice

- **Codici R<n>**: contatore per progetto (`projects.next_request_number`),
  le voci esistenti numerate per data di creazione, comprese fuse e
  archiviate; mai riusati.
- **Urgenza «urgent»** del server: l'app la mostra come la più alta del
  prototipo («high») con il segno di urgenza, senza perdere il dato; l'app non
  la scrive.
- **Sforzo E1–E5 della voce** → taglia XS–XL con la stessa mappa delle task.
- **Polso del portafoglio e «fermo»** come nel prototipo: le ferme delle task
  (`stallOf`), «aspetta te» comprese le richieste nuove dove posso creare task,
  il prossimo traguardo. Lo calcola il renderer con una funzione pura condivisa
  (`pulseOf` in `@stubwise/shared`) sui dati già letti; `/api/projects/pulse`
  resta per web vecchio e mobile, invariato.
- **Attività trasversale**: rotta nuova sulla cronologia di tutti i progetti
  visibili, a pagine come quella di progetto.
- **Regole pure in `@stubwise/shared`**: `templates` (stati e moduli per
  modello, usati anche dal server alla creazione), `projectCode` (proposta e
  validazione), `requests` (simili e candidati alla fusione), `decisionLog`
  (`wouldCycle`: il server rifiuta un ciclo di «superata da»),
  `requestNextStep`, `pulseOf`.
- **Permesso dei traguardi**: quello del prototipo; se diverge da
  `tickets.edit` di oggi si segue il prototipo e si annota.
- **Effetti di aree non integrate** (eventi di chat, automazioni, origine dalla
  documentazione di prodotto, task eliminate, archiviati, pausa della coda,
  interruttori di brief e report): spenti nella build app, come nelle fette
  precedenti.

## Verifica

Come le fette precedenti; tabella di parità `apps/desktop/docs/integration-slice4.md`.
