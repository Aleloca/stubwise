# Le mail tenute fuori — piano

Design: `2026-09-25-mail-rejections-design.md` (leggilo prima, §1 per §1).
Branch `feature/mail-rejections`, worktree `.worktrees/mail-rejections`.
Un commit per task. TDD: ogni test va visto FALLIRE prima di scrivere il
codice che lo fa passare.

## Task 1 — Tabella `email_rejections` (packages/db)

- `packages/db/src/schema.ts`: tabella come da design §2, accanto a
  `emailMessages`. Migrazione generata `0080_*.sql`: controlla a mano che sia
  un solo `CREATE TABLE` + indici + CHECK, niente `ALTER TYPE`.
- Test (stile `mail-admission-schema.test.ts`): l'unique rifiuta il doppione;
  il CHECK rifiuta un `reason` fuori elenco; `sender_domain` accetta `null`;
  il CASCADE dalla casella.

## Task 2 — Schema di risposta (packages/shared)

- `mailRejectionReasonSchema` e `mailRejectionsSchema` in
  `packages/shared/src/schemas/google.ts` (forma §4), esportati.
- Test: parse di una risposta completa; `readerSchema` porta un motivo ignoto
  a `UNKNOWN` senza far fallire il parse.

## Task 3 — Il worker scrive gli scarti (apps/worker)

In `apps/worker/src/google/poller.ts`:
1. `senderDomain(from)` pura (dopo l'ultima `@`, trim, minuscolo; niente `@` → `null`), con test.
2. Ramo `!admission.admitted` di `syncGmail`: insert `onConflictDoNothing`;
   try/catch → `logger.info` e si prosegue (design §3, fail-open).
3. Dopo l'insert di un messaggio AMMESSO: `delete` da `email_rejections` per
   `(account_id, gmail_message_id)`.
4. `pruneOldRejections(db, 30)` accanto a `pruneOldEmails` (costante
   `REJECTIONS_RETENTION_DAYS = 30`).

Test in `poller.test.ts` col client Gmail finto già in uso:
- automatica / etichetta esclusa / nessuna regola → una riga ciascuna, col
  motivo e il dominio giusti; nessun `getMessageFull` per loro (già oggi);
- **stesso messaggio riletto due volte → UNA riga** (il motivo di tutto);
- posta in uscita → nessuna riga;
- scartata e poi, con le regole cambiate, ammessa → la riga sparisce;
- insert che lancia (db finto o tabella rinominata nel test) → il tick
  prosegue e i messaggi ammessi entrano comunque;
- potatura: 31 giorni via, 29 restano.

## Task 4 — La rotta (apps/server)

`GET /api/me/mail/rejections` in `apps/server/src/routes/me-mail.ts`, prima
delle rotte parametriche, con commento come le altre. Aggregazione in SQL
(`group by account, reason, sender_domain`), poi top 10 per motivo +
`otherDomains` in TS.

Test in `me-mail.test.ts`:
- **negativo `mailbox_owner`**: righe di un altro utente (anche admin che
  chiede) non compaiono; il proprietario le vede;
- `days` fuori 1..30 → 400; default 7; una riga di 8 giorni fa esclusa col
  default e inclusa con `days=10`;
- ordinamenti; 12 domini → 10 + `otherDomains` giusto; dominio `null`;
- casella senza scarti non compare; nessuno scarto → `total: 0, accounts: []`.

## Task 5 — Client (packages/api-client)

`mail.rejections(days?: number)` in `endpoints/mail.ts`, con lo schema del
Task 2. Test accanto a quelli di `summary`.

## Task 6 — L'app (apps/mobile)

⚠️ Prima di ogni test: aggiungi `rejections` al DOPPIO del client
(`makeClient()`) in `MbxScreen.test.tsx`, o i test passano senza provare
niente (CLAUDE.md, «terza trappola»). Poi fai fallire apposta il primo test
che passa al primo colpo.

- Query key sotto lo STESSO prefisso della lista conversazioni (verifica
  quale usa `MbxScreen`), così pull-to-refresh e invalidazioni esistenti la
  prendono.
- `MbxScreen`: la riga in fondo (§5), anche nello stato vuoto; nascosta se
  totale 0, in caricamento o in errore. `testID="mbx-rejections-row"`.
- Schermata `apps/mobile/src/screens/mbx/MailRejectionsScreen.tsx` +
  rotta in `apps/mobile/src/app/navigation.tsx` accanto a `ThreadDetail`,
  con `ScreenHeader` e back, `usePullToRefresh`.
- i18n `mobile.mbx.rejections.*` in **it.json e en.json** (parità testata);
  l'inglese è quello che il maintainer vede.

Test: riga visibile con il totale; nascosta con totale 0 e con la rotta in
errore (e la lista resta); visibile nello stato vuoto; tap → naviga.
Schermata: gruppi per motivo con spiegazione, domini, «+N others», motivo
ignoto → «Other», intestazione casella solo con più caselle.

## Task 7 — CLAUDE.md

Voce di deploy «Le mail tenute fuori (25 set 2026)» nella sezione Deploy:
server + worker, migrazione 0080 additiva, fail-open del worker, rollback
innocuo, `mailbox_owner` senza eccezioni per gli admin. Breve.

## Verifica finale

`pnpm lint`, `pnpm typecheck`, test di db/shared/worker/server/api-client/mobile.
