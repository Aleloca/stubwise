# Righe dei ticket nella pagina progetto (22 set 2026)

## §1 — Cosa dice oggi una riga, misurato

Nel dettaglio progetto dell'app ogni ticket è **una riga con il solo titolo**
più un testo mono a destra (`ProjectGroup`, `apps/mobile/src/components/
projects/ProjectGroup.tsx`: `title` + `trailing`). Sui dati veri:

```
FERMO · 4
  Error: write EPIPE                    19 g · da preparare
  ReferenceError in checkout            17 g · lavorato, poi fermo
```

Non si può dire «guarda il #27» — il numero non c'è. Non si sa quale
guardare per prima — la priorità non c'è. Non si sa se è un guasto o una
richiesta — il tipo non c'è.

**Il confronto che il maintainer ha portato** è la riga dei risultati di
ricerca (`GlobalSearchSheet.tsx`, `TicketRow`), rifatta il 16 settembre:

```
#27   in review · Wilco
Error: write EPIPE
…estratto con l'evidenziazione…
```

Due righe: una grigia di identificazione, una di titolo. È la forma che
questo design porta nella pagina progetto, con una differenza — lì il
progetto serviva (i risultati vengono da progetti diversi), qui no: sei già
dentro quel progetto, e ripeterlo su ogni riga sarebbe la stessa ridondanza
che il 21 settembre abbiamo tolto dal titolo del corpo.

## §2 — Cosa costa, campo per campo (verificato, non stimato)

| campo | dov'è oggi | costo |
|---|---|---|
| `ticketNumber` | **già in tutti e cinque gli schemi** del polso | **zero**: si rende e basta |
| `priority` | assente dagli schemi | 1 riga per query × 3 query |
| `type` | assente dagli schemi | idem |
| `createdAt` | assente dagli schemi | idem |

Le tre query che producono voci con un ticket
(`packages/notifications/src/project-pulse-summary.ts`) **leggono già la
tabella `tickets`**, o con un `innerJoin` o direttamente:

- `jobRows` (`innerJoin(tickets, …)`) → alimenta `waitingForYou`,
  `waitingForOthers`, `running`;
- `openTicketRows` (`from(tickets)`, già con `status` e `updatedAt`) →
  alimenta `stalled`;
- `prRows` (`innerJoin(tickets, …)`) → alimenta `waitingForMerge`.

Nessuna query nuova, nessun join nuovo, nessun round-trip in più: tre
colonne in più su select che quelle righe le stanno già leggendo.

**`ticketNumber` che c'è e non si vede è il dato interessante di questa
sezione**: è nello schema dal giorno in cui il polso è nato
(fase 4, 6 settembre) e nessuna riga dell'app l'ha mai reso. Sul **web** invece si vede già
(`apps/web/src/routes/projects/index.tsx`, `ProjectStalledBlock`:
`<span>#{item.ticketNumber}</span>`). L'app era indietro rispetto ai dati
che riceveva, non rispetto al server.

## §3 — La forma approvata

Due righe per ticket, come la card di ricerca. **Nessuna riga in più
rispetto a oggi**: la riga grigia prende il posto dello spazio vuoto sopra
il titolo, il testo mono a destra resta esattamente dov'è.

```
ASPETTA QUALCUNO · 2
┌──────────────────────────────────────┐
│ #31 · alta · feature · aperto 8 g fa │
│ Export CSV clienti        RISPONDI › │
├──────────────────────────────────────┤
│ #33 · media · bug · aperto 3 g fa    │
│ Timeout su login             MERGE › │
└──────────────────────────────────────┘

FERMO · 2
┌──────────────────────────────────────┐
│ #27 · urgente · bug · aperto 2 mesi  │
│ Error: write EPIPE              19 g │
│                         da preparare │
└──────────────────────────────────────┘
```

### ⚠️ §3.1 — Due date sulla stessa riga: perché non si confondono

È il rischio vero di questo design, ed è **lo stesso difetto corretto sul
web il 21 settembre**: `ticket-row.tsx` mostrava `createdAt` — l'ETÀ — dove
chi guarda leggeva «ultima attività». Non un'informazione mancante: una che
si scambia per quella che serve.

Qui le due date convivono per scelta del maintainer, e la difesa è duplice:

1. **righe diverse** — l'età sta nella riga grigia in alto, il tempo di
   fermo nel mono a destra del titolo, dove è sempre stato;
2. **parole diverse, sempre presenti** — l'età dice *«aperto …»*, il fermo
   dice *«… fermo»* / *«… g · motivo»*. Nessuna delle due è un numero nudo.

Leggere male richiederebbe di ignorare l'etichetta. Un numero senza parola —
`#27 · urgente · bug · 2 mesi` — riaprirebbe esattamente il difetto: chi
tocca queste righe non tolga la parola per far stare tutto su una riga.

### §3.2 — Cosa NON entra nella riga

- **lo stato del ticket** (`open`/`in_review`/…): il secchio lo dice già, e
  meglio — «fermo» e «in corso» sono fatti derivati dai job, lo stato è una
  dichiarazione di qualcuno. Nella ricerca lo stato c'è perché lì non
  esistono secchi. Qui sarebbe una seconda risposta, a volte in disaccordo
  con la prima (è il caso del ticket #25: `in_progress` con zero job).
- **l'estratto del corpo**: nella ricerca è il *perché* quel risultato è
  uscito per quella query. Qui non c'è una query, e sarebbe testo che
  allunga ogni riga senza rispondere a niente.
- **l'assegnatario**: non è nel polso, e non c'è evidenza che serva qui —
  si aggiunge il giorno in cui qualcuno lo chiede, restando additivo.

## §4 — ⚠️ L'invariante additiva, nel punto in cui morde davvero

CLAUDE.md, «Verso l'app mobile, solo cambi ADDITIVI»: ogni campo nuovo in
una risposta che l'app legge nasce `.default()`/`.optional()`/`.nullable()`,
mai obbligatorio, perché **un'app nuova può parlare con un server più
vecchio** (un rollback, o un'istanza self-hosted non aggiornata).

**Qui il danno del campo obbligatorio è massimo, e va scritto per esteso
perché non è ovvio**: i tre campi nuovi stanno DENTRO gli elementi di un
array (`pulseStalledItemSchema` è dentro `stalled: z.array(...)`). Se
`priority` fosse obbligatorio, un server che non lo manda non farebbe
degradare *una riga*: farebbe fallire il parse dell'elemento, quindi
dell'array, quindi dell'intero `projectPulseSummarySchema` —
**la schermata Progetti resterebbe vuota su ogni telefono**. La stessa
famiglia del guasto che `stalled: z.array(...).default([])` documenta già
nel suo docblock, un livello più in dentro.

I tre campi nascono dunque:

```ts
priority: ticketPrioritySchema.optional(),
type: ticketTypeSchema.optional(),
createdAt: z.iso.datetime().optional(),
```

e ogni schema toccato arriva con un test che **parsa una risposta senza quei
campi** (`packages/shared/src/schemas/project.test.ts`, dove il test gemello
per `stalled` esiste già).

`.optional()` e non `.default(...)`: per una priorità non esiste un valore
neutro onesto — `"medium"` inventato da uno schema sarebbe un'affermazione
falsa su un ticket che potrebbe essere urgente. L'assenza si rende come
assenza: la riga mostra i pezzi che ha (`#27 · bug`), mai un segnaposto.

## §5 — Le parole

- **priorità**: le chiavi esistono già (`mobile.inbox.pulse.priority.{low,
  medium,high,urgent}`) e il punto che decide quale usare è
  `apps/mobile/src/lib/ticket-labels.ts` (`ticketPriorityLabel`), scritto il
  21 settembre proprio per non ricopiare le stesse parole sotto un prefisso
  nuovo. Si riusa quello.
- **tipo**: **non esiste** nell'app, in nessun catalogo — verificato sui due
  file i18n, non assunto. Nasce qui: `ticketTypeLabel` accanto agli altri
  due in `ticket-labels.ts`, con cinque chiavi nuove
  (`bug`/`feature`/`task`/`feedback`/`review`) e lo stesso trattamento di
  `UNKNOWN` (`readerSchema` apre gli enum: un tipo che questa build non
  conosce si dice «sconosciuto», non si stampa grezzo).
- **età**: *«aperto 8 g fa»*, *«aperto 2 mesi»*.

### §5.1 — «aperto 2 mesi»: una funzione nuova, e perché non si estende quella che c'è

`relativeTimeCompact` (`apps/mobile/src/lib/format.ts`) si ferma ai giorni:
un ticket di due mesi leggerebbe «63 g». Estenderla con un bucket «mesi»
sarebbe la scorciatoia sbagliata — **la usa l'inbox**, e ogni card più
vecchia di due mesi cambierebbe testo su una superficie che nessuno ha
chiesto di toccare.

Nasce quindi `openedSince` nello stesso modulo, con lo stesso contratto
delle sue vicine (ritorna un discriminante, non una stringa già composta:
l'unità è testo utente e la interpola il componente) e lo stesso docblock
che dice perché sono due — è esattamente il precedente di `searchMailTime`,
scritta nuova il 16 settembre per non piegare `relativeTimeCompact` alla
riga di ricerca.

## §6 — Il web non si tocca, e non è un'incoerenza

I tre campi nuovi arrivano anche al web, che semplicemente non li legge. Va
bene: la richiesta è sull'app, e il web ha già `#numero` sui fermi più
l'elenco ticket completo con filtri, che l'app non ha.

⚠️ Se un domani il web li leggesse, valgono i `?? …` nel punto di lettura:
`apps/web/src/lib/api.ts` fa un **cast**, non un parse, quindi l'`.optional()`
non è una protezione lì — un `undefined` dove il codice chiama un metodo fa
smontare il sottoalbero React, non degradare una riga (CLAUDE.md, la
sottosezione sul web). Non è un lavoro di questo design, è la nota per chi
lo farà.

## §7 — Cosa verifica il maintainer, alla fine

Una cosa sola, sul telefono: aprire un progetto con ticket fermi e vedere
che ogni riga porta `#numero · priorità · tipo · aperto …` sopra il titolo,
e che i giorni di fermo sono ancora quelli di prima, a destra.
