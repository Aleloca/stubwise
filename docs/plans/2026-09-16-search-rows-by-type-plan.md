# Piano — Righe di ricerca per tipologia (16 set 2026)

Design: `2026-09-16-search-rows-by-type-design.md`. Sette task, in ordine: il
dato prima di chi lo legge, l'app per ultima.

Ogni task si chiude con `pnpm typecheck` e i test del package toccato; il
lavoro intero si chiude con `pnpm test` + **`pnpm lint` dalla radice** (la CI
fallisce su lint anche con typecheck e test verdi).

---

## Task 1 — La colonna `cc_addresses`

`packages/db/drizzle/0079_email_cc.sql` **(la 0078 è già presa dal batch
calendario+ricerca del 15 settembre — verificare il numero libero prima di
scrivere)** e la voce corrispondente in `packages/db/src/schema.ts`.

```sql
alter table email_messages add column cc_addresses text[];
```

**Nullable, senza default**, ed è il punto del task: `null` significa «riga
scritta prima di questa modifica, non lo sappiamo», `{}` significa «lo
sappiamo, non c'era nessuno in copia». Il Task 6 si appoggia interamente a
questa distinzione — senza, ri-scaricherebbe da Gmail a ogni lancio tutte le
email che legittimamente non avevano copia. Il docblock nello schema drizzle
lo dica, accanto a `toAddresses`, o il prossimo che passa la «uniforma».

Additiva, nessun `ALTER TYPE`, un solo batch, nessun backfill nella
migrazione.

## Task 2 — Il worker scrive il `cc`

`buildEmailMessageInsert` (`apps/worker/src/google/sync.ts`) aggiunge
`ccAddresses: parseAddressList(message.headers["cc"])` accanto a
`toAddresses`, e `EmailMessageInsert` il campo corrispondente.

**Nessuna chiamata nuova a Gmail**: l'header `Cc` è già in
`DEFAULT_METADATA_HEADERS` e arriva nella stessa risposta — `messageToRouting`
lo parsa già per l'ammissione della fase 6c, poche righe sopra. Questo task
smette di buttarlo via, non lo va a prendere.

Test in `apps/worker/src/google/sync.test.ts`: un messaggio con `Cc` popola la
colonna; un messaggio **senza** header `Cc` dà `[]` e non `null` — è la riga
che distingue «guardato, nessuno» da «mai guardato», e se si rompe il Task 6
ricomincia a chiamare Google per sempre.

## Task 3 — I due campi nello schema condiviso

`searchMailHitSchema` (`packages/shared/src/schemas/search.ts`):

```ts
  /** Destinatari del messaggio che ha combaciato. NON FIDATO. */
  to: z.array(z.string()).default([]),
  /** In copia. `[]` anche quando il server non lo sa: chi legge non distingue. */
  cc: z.array(z.string()).default([]),
```

**`.default([])` e mai obbligatori** — CLAUDE.md, «solo cambi additivi»: l'app
si aggiorna dagli store, e un'app nuova contro un server più vecchio deve
reggere l'assenza. Il `null` in colonna si appiattisce a `[]` qui: la
distinzione serve al Task 6, non a chi legge.

Test in `packages/shared/src/schemas/search.test.ts`: una risposta **senza**
`to` né `cc` parsa e dà due array vuoti. La fixture va lasciata senza quei
campi apposta — è la prova che la difesa c'è, non una svista.

## Task 4 — Il server li seleziona

`apps/server/src/routes/search.ts`, la `selectDistinctOn` della corsia posta:
aggiungere `toAddresses: emailMessages.toAddresses` e
`ccAddresses: emailMessages.ccAddresses`, e mapparli in `to`/`cc`
nella costruzione della risposta (`cc: r.ccAddresses ?? []`).

**Non si tocca il `where`**: `to` e `cc` NON entrano nella ricerca full-text.
Cercare un indirizzo trova già le email di quella persona dal mittente e
dall'oggetto; allargare il `MAIL_TSV` cambierebbe cosa la ricerca trova, che è
un'altra decisione e non questa.

**Non si tocca il filtro di privatezza**: la corsia resta ristretta a
`google_accounts.user_id`, e nessun ruolo scavalca — nemmeno un admin
(audience `mailbox_owner`, fase 6). Il test esistente che lo fissa deve restare
verde senza modifiche; se qualcuno lo deve toccare, ha sbagliato qualcosa.

Test in `apps/server/src/routes/search.test.ts`: un messaggio con due in copia
torna `cc` con due voci; un messaggio scritto prima della colonna (`null`)
torna `[]`, non `null`.

## Task 5 — Le quattro righe nell'app

`apps/mobile/src/components/GlobalSearchSheet.tsx`. Il `Row` generico sparisce
a favore di `MailRow`, `TicketRow`, `DocRow`, `ProjectRow` — ognuna con la sua
forma, §3 del design. Gli `testID` esistenti NON cambiano
(`global-search-mail-<threadId>`, `global-search-ticket-<id>`, …): ci sono
sopra i test della navigazione, ed è la parte che non deve muoversi.

Le tre regole di resa del §3.1, ognuna con il suo test:

1. **`accountEmail` esce dagli elenchi `a:`/`cc:`.** Se dopo il filtro non
   resta nessuno, la riga di destinatari **non compare** — non una riga vuota,
   non un `a: —`. Funzione pura, testabile da sola.
2. **Parte locale più `+N`**: `m.misseri +2`, non tre indirizzi interi.
3. **Data relativa vicino, assoluta lontano** (`17:45` oggi, `10/09 17:45`
   oltre): **riusare la funzione che la lista MBX usa già**, non scriverne una
   seconda. Se non è estratta, estrarla adesso e farla usare a entrambe.

⚠️ `subject`, `from`, `to` e `cc` sono testo **non fidato** (lo scrive chi
manda l'email) e lo `snippet` contiene il markup `<mark>` di `ts_headline`:
si rendono con le stesse cautele di oggi, nessun `dangerouslySetInnerHTML`
equivalente, nessuna nuova strada di rendering.

⚠️ In questo repo **`render` di RNTL va `await`ato**, o `screen` resta vuoto e
il test sembra rotto per l'ambiente. E le spie su moduli condivisi vanno
azzerate in `beforeEach`: ci sono già stati test che passavano da soli e
fallivano in gruppo.

## Task 6 — Il recupero delle 163 righe storiche

`apps/server/scripts/backfill-email-cc.ts`, sulla forma di
`backfill-ticket-done-events.ts` accanto (fase 5): stesso stile, stesso
`--dry-run`, stessa emissione in `dist/scripts/` dal build del server
(`tsconfig.scripts-build.json`) — in prod si lancia col `node` compilato
dentro il container, non con `pnpm`, perché l'immagine è un `pnpm deploy
--prod` e non contiene né `tsx` né pnpm.

Cosa fa: per ogni riga `email_messages` con **`cc_addresses is null`**,
raggruppata per casella, una lettura `format=metadata` da Gmail con i token
OAuth di quella casella, e scrive `cc_addresses`.

**I tre paletti del §4.1, ognuno con un test:**

1. **Tocca SOLO `cc_addresses`.** Il test asserisce che `text_excerpt`,
   `status`, `outcome` e le righe di `email_proposals` sono identici prima e
   dopo — non solo che lo script è andato a buon fine. Una proposta aperta non
   deve accorgersi che questo script è passato.
2. **Un 404 da Gmail non ferma il resto**: quella riga resta `null` e lo
   script prosegue, con una riga di log. Un messaggio cancellato da Gmail è il
   caso normale, non un errore.
3. **Non fa partire niente**: nessun `ai_jobs`, nessun `backlog_jobs`, nessuna
   notifica. Il test li conta a zero dopo l'esecuzione, come fa già
   `poller.test.ts` per il percorso automatico del calendario.

Più l'idempotenza vera: **due esecuzioni di fila, e la seconda non chiama
Google nemmeno una volta** (il `fetch` iniettato conta zero chiamate). È la
proprietà per cui il Task 1 ha scelto `nullable`.

## Task 7 — CLAUDE.md

Voce di deploy per questo giro, sotto le altre, con: rebuild **server + worker
+ caddy insieme**, migrazione 0079 additiva, nessuna env nuova, nessun kind di
notifica nuovo (quindi nessuna trappola del 500 su `/api/inbox` delle fasi
2/5/6), e il **passo manuale post-deploy**: il recupero del Task 6, prima con
`--dry-run`.

E una riga nella sezione invarianti sul perché `cc_addresses` è nullable
mentre `to_addresses` non lo è — è la prima cosa che qualcuno vorrà
«uniformare».

---

## Fuori perimetro, e non per dimenticanza

- **La palette web** (`apps/web/src/components/global-search-palette.tsx`) non
  si tocca: riceve i due campi nuovi nella risposta e li ignora, che è ciò che
  deve fare un client che non li usa.
- **I repository restano invisibili nell'app**: c'è un test che lo fissa e
  deve restare verde.
- **`MAIL_TSV` non cambia**: `to`/`cc` si mostrano, non si cercano.
