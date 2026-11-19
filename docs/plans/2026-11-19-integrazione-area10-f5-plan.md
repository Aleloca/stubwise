# Integrazione area 10, F5 — `member.added`: piano

> Design: `docs/plans/2026-11-19-integrazione-area10-design.md`, «F5 —
> `member.added`» (D-11 = b, maintainer). Specifica: il prototipo,
> allineato da 94 su `feat/area10-prototipo` (3490f2988, in
> `registerAlertTypes`). Invarianti: CLAUDE.md («I campi che un client legge
> su una card… si DERIVANO A LETTURA», «Migrazioni Drizzle — il batch gira
> in UNA transazione», la regola di rollback dei kind nuovi), `change-log.md`.
> Branch: `feat/area10-f5` da `feat/integrazione-area10`. F5 non dipende da
> F2–F4.

## Prima del codice

- **Nessuna [DECIDE]**: chi lo riceve l'ha deciso il maintainer (D-11 = b).
- **La migrazione**: il primo numero libero quando si scrive, con un
  `when` crescente. Contiene una sola riga, in uno statement a sé:
  `ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'member.added';`.
  Il valore non si usa in nessun'altra migrazione dello stesso batch. È la
  forma della 0179 e della 0181.
- **Fatti del codice che contano**:
  - gli ingressi in un progetto passano da DUE punti di
    `apps/server/src/services/roles.ts`:
    - `putProjectMember` (a mano e `addMember` di Claude) scrive
      `member.added` nel registro quando `!before`;
    - l'invito accettato scrive `member.added` con `params.via: "invite"`.
    Le notifiche si pubblicano lì, nella stessa transazione;
  - un cambio di ruolo (`member.role_changed`) non pubblica. Nemmeno un
    reparto di F8: dà permessi, non fa entrare nessuno;
  - **il catalogo degli avvisi** (`packages/shared/src/alerts/catalog.ts`)
    ha i gruppi in un elenco chiuso (`AlertGroup`, `ALERT_GROUPS`) e i motivi
    obbligatori in un tipo (`MandatoryReason`). `catalogRecipients`
    (`packages/notifications/src/alert-recipients.ts`) mette insieme
    obbligatori e iscritti, ma NON esclude chi ha agito: per questo kind
    serve, ed è una regola nuova del calcolo, non del produttore;
  - `recordChange` restituisce `void`. Per legare la card alla voce del
    registro deve restituire l'id. Il cambio è additivo: i chiamanti di
    oggi lo ignorano;
  - «Undone by»: il registro ha già `undo_of_action_id` e `undoneEntry`
    derivato a lettura (`services/change-log-read.ts`, F7). La card lo
    deriva con la stessa regola, in UNA query per pagina, come
    `sourceProposalIdsByNotification` (`services/inbox.ts`);
  - 94 ha allineato il prototipo: il gruppo `members` dopo `tasks`, il
    motivo `added`, e «mai a chi ha agito» sull'attore della notifica.

## Regole di lavoro (le solite)

Come F1. In più: `pnpm --filter @stubwise/shared build` e `… notifications
build` dopo ogni modifica a quei pacchetti, prima dei test del server (la
trappola del `dist/` stantio delle mutazioni cross-package). Nel giro
anche `load-isolated.test.ts`, `catalog.test.ts` degli avvisi e i test
dell'inbox.

## Task 1 — il kind, il catalogo e il calcolo dei destinatari

**File**: la migrazione, `meta/_journal.json`; shared
`schemas/notification.ts` (il kind), `alerts/catalog.ts` (gruppo, motivo,
riga); notifications `alert-recipients.ts` (l'esclusione dell'attore),
`format.ts` (testo, icona, chiave i18n); i18n (le frasi, en e it). Test:
`migration-<n>.test.ts`, `alerts/catalog.test.ts`,
`alert-recipients.test.ts`, il test del parse in shared.

1. **RED**:
   - la migrazione aggiunge il valore e una notifica `member.added` si
     inserisce;
   - nel catalogo, `member.added` sta nel gruppo `members`, subito dopo
     `tasks` in `ALERT_GROUPS`, con `subscribe: { perm:
     "project.members.manage" }`, `defaultOn: { perm:
     "project.members.manage" }`, `defaultPhone: false` e `mandatory:
     ["added"]`;
   - `catalogRecipients` con un `actorUserId`: chi ha agito non c'è MAI,
     né come iscritto né come obbligatorio (aggiungere sé stessi non
     avvisa nessuno se si è anche gestori);
   - la persona aggiunta c'è anche con l'iscrizione spenta;
   - un gestore con l'iscrizione spenta non c'è;
   - un gestore senza riga d'iscrizione c'è (default acceso);
   - un membro senza `project.members.manage` non c'è;
   - una inbox con `kind: "member.added"` letta da un `readerSchema`
     vecchio dà `UNKNOWN`.
2. **GREEN**: il kind; `AlertGroup` più `members`; `MandatoryReason` più
   `added`; la riga del catalogo; in `CatalogRecipientsContext` un campo
   `exclude?: readonly string[]`, applicato a obbligatori e iscritti; la
   formattazione:
   - per la persona aggiunta: «You've been added to {project} as {role}»;
   - per i gestori: «{actor} added {person} to {project} as {role}»;
   - quando l'attore è Claude per conto di qualcuno, il nome è quello della
     persona, con «via Claude» come le card di oggi.
3. **Mutazioni**:
   - non applicare `exclude` agli obbligatori: il test «aggiungere sé
     stessi» diventa rosso;
   - `defaultOn: "off"`: il test del gestore senza riga diventa rosso.
4. **Giro**: i test elencati, `publish.test.ts`, `format.test.ts`,
   `load-isolated.test.ts`.

## Task 2 — la pubblicazione negli ingressi

**File**: `apps/server/src/services/change-log.ts` (`recordChange`
restituisce l'id), `services/roles.ts` (i due punti d'ingresso). Test:
`project-members.notify.test.ts` (nuovo, Postgres vero),
`claude-actions-area9.test.ts` (l'`addMember` di Claude).

1. **RED**, sugli stessi dati: un progetto con due gestori (G1 e G2), una
   persona P e un membro M senza permesso.
   - G1 aggiunge P a mano → card a P (obbligatoria) e a G2 (iscritto); a G1
     no; a M no;
   - G1 aggiunge sé stesso (full admin) → nessuna card a G1, una a G2;
   - Claude per conto di G1 (`addMember`) → card a P e a G2, con l'attore
     G1 e il segno «via Claude»;
   - un invito accettato che dà il progetto → card ai gestori;
     all'invitato, che entra lui, no: «mai a chi ha agito» vale per chi
     accetta;
   - un cambio di ruolo → nessuna card;
   - aggiungere l'agente → nessuna card.
   - L'evento porta `changeLogEntryId`, ed è l'id della voce `member.added`
     della stessa transazione.
   - Se la transazione fallisce (l'escalation), non resta nessuna card.
2. **GREEN**: `recordChange` restituisce l'id; i due punti pubblicano con
   `publishNotification(tx, …)` nella transazione, con
   `mandatory: [{ userId, reason: "added" }]`, `projectId` ed
   `exclude: [actor.id]`.
3. **Mutazioni**:
   - pubblicare anche al cambio di ruolo: il suo test diventa rosso;
   - pubblicare fuori dalla transazione: il test del fallimento diventa
     rosso.
4. **Giro**: `project-members.notify.test.ts`,
   `project-members.permissions.test.ts`, `roles.test.ts` (route e
   service), `claude-actions-area9.test.ts`, `claude-actions-effects.test.ts`
   (`addMember` è nel catalogo: la prova a secco ora pubblica, e deve
   restare senza effetti fuori dalla transazione), `claude-actions-class.test.ts`
   (una C resta C: avvisa altri, ma la classe è già la più alta),
   `change-log.test.ts`, `invites.test.ts`.

## Task 3 — «Undone by» derivato a lettura

**File**: `apps/server/src/services/inbox.ts` (il loader per pagina e il
campo sulla card), shared `schemas/notification.ts` (il campo additivo
`undoneBy: { id, name } | null`, `.default(null)`). Test: `inbox.test.ts`.

1. **RED**:
   - una card `member.added` di un ingresso fatto da Claude e poi annullato
     con «Annulla» → `undoneBy` è chi ha annullato;
   - non annullato → `null`;
   - tolto a mano (non un «Annulla») → `null`: il testo dice «Undone by»,
     ed è vero solo per un annullamento;
   - **CARD VECCHIA**: un evento SENZA `changeLogEntryId` dà `undoneBy`
     `null` e non lancia;
   - il valore viene dal DB: un `undoneBy` scritto nel jsonb dell'evento
     viene SOVRASCRITTO dal derivato (la seconda asserzione, come quella di
     `sourceProposalId`);
   - UNA query per pagina: con dieci card le query non crescono.
2. **GREEN**: il loader legge le voci del registro con `undo_of_action_id`
   uguale all'azione della voce d'ingresso (la stessa regola di
   `undoneEntry`).
3. **Mutazioni**:
   - leggere `undoneBy` dal jsonb: il test della sovrascrittura diventa
     rosso;
   - contare anche una rimozione a mano: il test «a mano» diventa rosso.
4. **Giro**: `inbox.test.ts`, `change-log-read.test.ts`, `via-reads.test.ts`,
   `load-isolated.test.ts`, e il test del client che parsa una inbox senza
   il campo (`packages/api-client`).

## Task 4 — il golden S5 e i documenti

1. Il golden `chat-s5-member`: «aggiungi Bruno ad AUD come Developer».
   Passa se la proposta è `addMember` con Bruno e il ruolo giusto, la
   risposta dice che serve la riconferma (C) e non dice «fatto». Si lancia
   3 volte, quando il maintainer autorizza le corse. La notifica non si
   prova nel golden: la prova il test del Task 2.
2. `deploy-log.md`:
   - l'ordine: server (healthy, migrazione applicata), poi worker e caddy;
   - **rollback NON sicuro sul server finché esistono righe `member.added`**
     (500 su `/api/inbox`, CLAUDE.md). La voce dà la query che le conta e
     quella che le toglie prima della discesa:
     `delete from notifications where kind = 'member.added';`.
     Toglierle fa sparire le card dall'inbox di chi le aveva.
3. `integration-claude-chat.md` e il registro: chiusa la voce
   `member.added`.

## Per 94 (renderer)

- La riga del catalogo arriva da `@stubwise/shared`, con la stessa forma
  di `registerAlertTypes` del prototipo, che a quel punto la può togliere.
- La card: i due testi (alla persona aggiunta, ai gestori) e «Undone by
  {name}» da `undoneBy`, letto e non dedotto.

## Review Focus

- «Mai a chi ha agito» vale per OBBLIGATORI e iscritti.
- La card e la voce del registro nascono nella stessa transazione.
- `undoneBy` si deriva sempre, anche contro un jsonb che dice altro.
- Nessun avviso per un ingresso che non è un ingresso: ruolo, reparto,
  agente.
