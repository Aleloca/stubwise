# Piano — Una card chiusa deve dire PERCHÉ (21 set 2026)

Design: `2026-09-21-closed-proposal-reason-design.md`. ⚠️ **Il Task 3 è
cambiato il 21 set**: non è «solo client» — vedi §1/§2 del design, riscritti.
Nessuna migrazione e nessuna rotta nuova, ma **un campo nuovo** in
`mailThreadMessageSchema`.

I Task 1, 2 e 4 (funzione pura, etichette, test) sono **già fatti** e reggono
invariati: commit `c4d84e6e`.

Chiusura: `pnpm typecheck`, `pnpm test`, **`pnpm lint` dalla radice**.

## Task 1 — La funzione pura, in `@stubwise/shared`

`closedReasonKey(outcome): string | null` — da `outcome.type` alla chiave
i18n, `null` per un tipo sconosciuto o per `outcome` assente.

Sta in `shared` e non in una delle due UI perché la usano **entrambe**: è lo
stesso ragionamento di `searchSnippetSegments` (18 set), dove la regola viveva
solo nel web ed è per quello che all'app mancava.

⚠️ **Non un `Record` esaustivo, ma una mappa con ripiego.** In produzione
esistono 29 righe con `bulk_closed_automated`/`bulk_closed_stale_routing`,
esiti che **nessun codice produce** (scritti a mano chiudendo l'arretrato del
17 settembre): un tipo sconosciuto deve dare `null`, mai lanciare. Il test usa
proprio quei due valori, perché sono il caso vero.

Copre: `reassigned_to`, `reassign_failed`, `reassign_no_signal`,
`superseded_in_thread`, `declined`, `triage_dismissed`. Non gli esiti delle
card eseguite (design §4).

## Task 2 — Le etichette i18n

In `packages/i18n` (it/en), forma «Ignorata · <perché>»:

- `reassigned_to` → «spostata su {project}», e **senza nome** se il progetto
  non si risolve: mai un UUID a schermo;
- `reassign_failed` → «riattribuzione non riuscita» — l'unico che segnala un
  guasto;
- `reassign_no_signal` → «su quel progetto non c'era nulla da proporre»;
- `superseded_in_thread` → «superata da un messaggio successivo»;
- `declined` → «invito rifiutato»;
- `triage_dismissed` → «nessun progetto scelto».

## Task 3 — L'esito nella conversazione (RISCRITTO)

**Server.** `mailThreadMessageSchema` guadagna, accanto a `proposalIds` e
`reproposals`, l'esito di ciascuna proposta nata da quel messaggio: id,
progetto (nome, non solo l'id) e tipo di esito. Additivo, `.default([])`, col
test che parsa una risposta senza.

⚠️ **Lo decide il SERVER, non il client.** È la stessa regola già scritta nel
docblock di `reproposals`: un client che deducesse l'esito da `status`
produrrebbe una seconda copia della regola, e la copia sbagliata starebbe
dalla parte che non possiamo aggiornare (l'app sui telefoni).

**Client.** Sotto ogni messaggio, una riga per proposta: l'etichetta del Task
2, il nome del progetto quando serve distinguere, e il bottone «Riproponi»
dove già compare. `reassign_failed` si distingue a vista: è l'unico che
segnala un guasto.

⚠️ Sul web `lib/api.ts` fa un **cast**, non un `parse`: `outcome` può arrivare
`undefined` anche se lo schema dice `.default(null)`. Difesa nel punto di
lettura, e fixture del test lasciata **senza** il campo apposta.

## Task 4 — I test

1. Ogni tipo mappato dà la sua etichetta.
2. ⚠️ **`bulk_closed_automated` dà `null` e la UI mostra lo stato nudo** — il
   caso vero dei dati di produzione, non uno inventato.
3. `outcome` assente o `undefined`: nessuna etichetta, nessun errore.
4. `reassigned_to` **senza** un progetto risolvibile: etichetta senza nome,
   mai l'UUID.
5. Una card ANDATA A BUON FINE resta «Eseguita»: questo batch non la tocca.
