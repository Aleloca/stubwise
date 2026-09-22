# Piano — Righe dei ticket nella pagina progetto (22 set 2026)

Design: `docs/plans/2026-09-22-project-ticket-rows-design.md`.

Perimetro: **app mobile + gli schemi condivisi + le tre query del polso**.
Il web riceve i campi nuovi e non li legge (design §6): non si tocca.

---

## Task 1 — I tre campi negli schemi del polso

`packages/shared/src/schemas/project.ts`. Aggiungere a **tutti e cinque** gli
item del polso — `pulseWaitingForYouItemSchema`,
`pulseWaitingForOthersItemSchema`, `pulseRunningItemSchema`,
`pulseStalledItemSchema`, `pulseWaitingForMergeItemSchema` — i campi:

```ts
priority: ticketPrioritySchema.optional(),
type: ticketTypeSchema.optional(),
createdAt: z.iso.datetime().optional(),
```

importando i due enum da `./ticket.js`.

⚠️ **`.optional()`, mai obbligatorio, e il motivo va nel docblock** — non
basta il campo: questi stanno DENTRO gli elementi di un array, quindi un
campo obbligatorio che il server non manda non degrada una riga, fa fallire
il parse dell'intero polso e **svuota la schermata Progetti su ogni
telefono**. Design §4. Scrivere quel ragionamento una volta sopra il primo
dei cinque, e rimandarci dagli altri quattro.

Non `.default(...)`: per una priorità non esiste un neutro onesto (§4).

**Test** (`packages/shared/src/schemas/project.test.ts`, accanto a quello
che già parsa un polso senza `stalled`): parsare un polso i cui item NON
hanno nessuno dei tre campi, e verificare che il parse riesca **e** che gli
altri secchi restino leggibili. Un test che guarda solo l'item toccato non
coglierebbe il guasto vero, che è a livello dell'intera risposta.

---

## Task 2 — Le tre query del polso

`packages/notifications/src/project-pulse-summary.ts`. Aggiungere
`priority: tickets.priority`, `type: tickets.type`,
`createdAt: tickets.createdAt` alle tre select che già leggono `tickets`:

1. `jobRows` (`innerJoin(tickets, …)`) → `waitingForYou`,
   `waitingForOthers`, `running`;
2. la select dei ticket non chiusi (già con `status`/`updatedAt`) →
   `stalled`;
3. la select delle PR aperte (`innerJoin(tickets, …)`) → `waitingForMerge`.

Poi riportarli nelle voci costruite da ciascuna. **Nessuna query nuova,
nessun join nuovo** (design §2): se serve un join, fermarsi e dirlo — vuol
dire che la premessa del design è sbagliata.

⚠️ `createdAt` è un `timestamptz`: va serializzato ISO come le altre date
del modulo (`stalledSince` è il precedente nello stesso file).

**Test** (`project-pulse-summary.test.ts`): su un ticket fermo con priorità
`urgent` e tipo `bug`, il polso li riporta. Un caso per **ciascuno** dei
cinque secchi, non solo per `stalled`: sono cinque punti di costruzione
diversi e dimenticarne uno non fa rumore.

---

## Task 3 — Le parole del tipo

`apps/mobile/src/lib/ticket-labels.ts` + `apps/mobile/src/i18n/{it,en}.json`.

Aggiungere `ticketTypeLabel(type, t)` accanto a `ticketStatusLabel` e
`ticketPriorityLabel`, con lo stesso trattamento di `UNKNOWN`
(`isUnknown` → una parola, mai il valore grezzo) e cinque chiavi nuove per
`bug`/`feature`/`task`/`feedback`/`review`.

La **priorità non ha chiavi nuove**: si riusa `ticketPriorityLabel`, che
già punta a `mobile.inbox.pulse.priority.*` — il docblock di quel file
spiega perché non si ricopiano (design §5).

`parity.test.ts` esige che it ed en abbiano le stesse chiavi.

---

## Task 4 — «aperto 2 mesi»

`apps/mobile/src/lib/format.ts`. Nuova `openedSince(iso, now?)` che
restituisce un **discriminante** (come le sue vicine, non una stringa già
composta: l'unità è testo utente e la interpola il componente), con un
bucket `months` oltre i ~60 giorni.

⚠️ **Non estendere `relativeTimeCompact`**: la usa l'inbox, e ogni card più
vecchia di due mesi cambierebbe testo su una superficie che nessuno ha
chiesto di toccare (design §5.1). Il docblock dica perché sono due, come fa
già `searchMailTime`.

Chiavi i18n nuove per le unità («aperto {{count}} g fa», «aperto {{count}}
mesi»), e una forma per «oggi».

**Test** (`format.test.ts`): il confine giorni→mesi, una data futura
(orologi sfasati: mai un numero negativo — è la guardia che le altre
funzioni del modulo hanno già) e una data illeggibile.

---

## Task 5 — La riga

`apps/mobile/src/components/projects/ProjectGroup.tsx` +
`apps/mobile/src/screens/projects/ProjectDetailScreen.tsx`.

`ProjectGroupRowProps` prende un campo nuovo e **opzionale** — la riga
grigia di testa — così le righe che non sono un ticket (la voce
«backlog pronto») restano com'erano, senza un ramo speciale.

Layout esatto: design §3. Riga grigia mono sopra
(`#numero · priorità · tipo · aperto …`), titolo sotto, `trailing` dove è
sempre stato. I pezzi assenti si omettono **con il loro separatore**: una
riga `#27 · · bug` è peggio di `#27 · bug`.

⚠️ **Le due date non perdono mai la loro parola** (design §3.1): l'età dice
«aperto», il fermo dice i giorni con il motivo. È il difetto corretto sul
web il 21 settembre (`ticket-row.test.tsx`), e togliere la parola per far
stare tutto su una riga lo riapre.

Il `numberOfLines={1}` del titolo resta: il titolo non deve diventare due
righe ora che sopra ce n'è un'altra.

**Test** (`ProjectDetailScreen.test.tsx`): un ticket fermo con tutti e tre i
campi rende `#27`, la priorità e il tipo; **e un ticket SENZA i tre campi
rende comunque la riga**, con il numero e il titolo. Il secondo è il caso
del server più vecchio e vale quanto il primo.

⚠️ Nei test dell'app `render` **va atteso** (`await render(...)`): senza,
`screen` resta vuoto e sembra un guasto d'ambiente (CLAUDE.md).

---

## Task 6 — Verifica

`pnpm --filter @stubwise/shared... build` **prima** di credere a un rosso
locale su notifications o mobile: i test leggono `dist`, non i sorgenti.

Poi `pnpm typecheck`, `pnpm test`, `pnpm lint` dalla radice — la CI fallisce
su lint anche con typecheck e test verdi.

Il maintainer verifica una cosa sola sul telefono (design §7).
