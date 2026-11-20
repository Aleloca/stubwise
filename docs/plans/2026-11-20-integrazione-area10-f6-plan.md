# Integrazione area 10, F6 — le bozze nei campi (`fillField`): piano

> Design: `docs/plans/2026-11-19-integrazione-area10-design.md`, «F6 — le
> bozze nei campi» (D-4 = a, D-10 = a). Specifica: il prototipo
> (`apps/desktop/.impeccable/shape/claude-drafts.md`, `FieldRef` in
> `data/model.ts`, `layout/claudePanel/fillable.ts` e `pageActions.ts`).
> Invarianti: `docs/invariants/claude-actions.md` («Una bozza di Claude in un
> campo non si salva da sola»), CLAUDE.md («Verso l'app mobile, solo cambi
> ADDITIVI»). Branch: `feat/area10-f6` da `feat/area10-f5`.

## Prima del codice

- **[DECIDE] F6-1 — come Claude trova la PR delle note di rilascio.** Il
  campo «Release notes» sta nel pannello della PR (`ReleaseNotesField`,
  `PrPanel.tsx`), e la sua rotta è
  `PUT /api/repositories/:repositoryId/pulls/:prNumber/release-notes`.
  Oggi Claude non ha nessuna lettura di una PR: `read_release` dà il
  rilascio (dopo il merge) senza `repositoryId`. Il bersaglio di una bozza
  delle note è quindi `{ repositoryId, prNumber }`.
  - **(a) — consigliata.** Un tool di lettura nuovo, `read_pull_request_notes
    { repositoryId, prNumber }`, sulla rotta che c'è
    (`GET …/release-notes`: `canEdit`, la bozza del server e le task della
    PR). Va nell'allowlist del token, con il titolo e i testi della PR dentro
    `untrusted_content`, e porta il suo golden ostile (D-12). Claude lo usa
    quando la pagina aperta è la PR (il contesto della conversazione la
    nomina) o dopo `read_release`, che aggiunge `repositoryId` alla sua
    proiezione. Si vede così: «scrivi le note di questa PR» funziona dal
    pannello della PR.
  - (b) In F6 solo la descrizione della task. Le note di rilascio vanno nel
    registro dei rimandi. Claude, se gliele chiedono, dice che si scrivono
    a mano (o con la bozza della pagina).
  - (c) Il bersaglio solo dal contesto della pagina, senza nessuna lettura:
    Claude scrive le note senza sapere quali task ci sono nella PR. Il
    testo verrebbe inventato: da scartare.
- **Ruling (tetto del testo)**: il design dice 20 000 per la descrizione, ma
  il campo vero ne accetta 100 000 (`taskPatchSchema`). Il tetto di
  `fillField` è quello della ROTTA del campo: 100 000 per la descrizione,
  20 000 per le note. Se sbagliato costa una costante.
- **Fatti del codice che contano**:
  - `pageAction` è già un'«azione del renderer». In
    `claude-actions/proposals.ts` è validata e basta: va da sola, nella Chat
    (`chat_mention`) è rifiutata, dopo un contenuto non fidato diventa una
    scheda B, e altrimenti nasce `confirmed` A senza gruppo (nessuna
    scrittura, nessun «Annulla» del server). Alla conferma di una B il server
    la chiude e basta. `fillField` segue la STESSA strada. Il predicato
    `a.fn === "pageAction"` (cinque punti) diventa
    `RENDERER_FNS.has(a.fn)`, con `RENDERER_FNS = {pageAction, fillField}`
    in shared;
  - la differenza con `pageAction`: prima di nascere `fillField` controlla
    che chi chiede possa scrivere QUEL campo (il design: «se non può, non
    diventa una scheda»). Il controllo è un servizio, non una rotta
    (`services/claude-field-access.ts`, `canFillField`), e usa le regole
    delle rotte vere:
    - la descrizione: `tickets.edit` nel progetto della task, che deve
      essere visibile. È `onTicket("tickets.edit")` di `updateTask`; una
      task invisibile risponde `not_found`, come la rotta;
    - le note: `release.merge` o `tickets.edit`, come
      `putPrReleaseNotes` (`services/pr-release-notes.ts`, `scopeOf`).
    Se non può, rifiuto `forbidden` col permesso che manca: il modello lo
    riceve come per le altre voci, e il prompt gli dice di dirlo;
  - `claude-actions-class.test.ts` salta `pageAction` (nessuna voce nel
    catalogo del server). Salterà `RENDERER_FNS`. Il test del «mai» e
    `claude-actions-effects.test.ts` restano: `fillField` non entra in
    `SERVER_CATALOG`, quindi non può scrivere per costruzione;
  - un client vecchio legge una `fn` ignota come `UNKNOWN` (`readerSchema`
    sull'enum). È il motivo di D-10 = a, e il test di parse lo fissa;
  - il worker: `chat-mcp/server.ts` elenca le `fn` proponibili (riga
    `"pageAction"`) e `prompts.ts` ha le regole del catalogo. Lì entrano
    `fillField` e la regola «una bozza nel campo, la salva la persona».

## Regole di lavoro (le solite)

Come F5. Nel giro anche `claude-actions-effects.test.ts`,
`claude-actions-class.test.ts`, `claude-actions-never.test.ts`,
`claude-actions.test.ts` (i percorsi della pagina) e `load-isolated.test.ts`.

## Task 1 — la voce e il percorso del renderer (shared, server)

**File**:
- shared `schemas/claude-actions.ts`: `fillField` in `CLAUDE_ACTION_FNS`,
  classe dichiarata A, gli argomenti, `RENDERER_FNS`;
- server `claude-actions/proposals.ts` (i cinque punti) e il nuovo
  `services/claude-field-access.ts`.

**Gli argomenti**, `.strict()`, senza unioni (un client li legge, D-10):
`{ field: "task.description" | "release.notes", taskId?, repositoryId?,
prNumber?, text }`, con un `refine` che vuole `taskId` per la descrizione e
`repositoryId`+`prNumber` per le note, e `text` da 1 al tetto del campo.

**Test** (`claude-actions-fill-field.test.ts`, nuovo):
- chi può: la proposta nasce `confirmed` A, `executed` al modello, nessuna
  riga scritta nella task o nelle note (le leggo prima e dopo);
- chi non può (`tickets.edit` assente): `forbidden`, nessuna proposta;
- una task invisibile: `not_found`, come la rotta;
- le note con `release.merge` sì, senza né `release.merge` né
  `tickets.edit` no;
- dopo un contenuto non fidato: una scheda B; la conferma la chiude senza
  scrivere;
- nella Chat: rifiutata;
- insieme a un'altra azione: rifiutata («renderer actions go alone»);
- in shared: il parse di una proposta con `fillField` da un lettore il cui
  enum non la conosce dà `UNKNOWN` (`readerSchema`), e il resto della
  proposta passa.

Mutazioni: togliere il controllo di `canFillField`; far passare `fillField`
da `executeGroup`.

## Task 2 — il worker

**File**: `chat-mcp/server.ts` (la `fn`), `claude-chat/prompts.ts` (la
regola `FIELD_DRAFT_RULE`): «for a task description or release notes, write
the draft with fillField; it goes into the field of the open page and the
person saves it; never say it is saved». Con (a) di F6-1 anche il tool
`read_pull_request_notes` in `bridge.ts`, nell'allowlist di shared, e
`repositoryId` nella proiezione di `read_release`.

**Test**: `prompts.test.ts`, `bridge.test.ts` (la proiezione, i testi della
PR dentro `untrusted_content`), `chat-tool-token.test.ts` (la rotta
nell'allowlist e nessun'altra).

## Task 3 — i golden e i documenti

1. `chat-s6-field`: «scrivi la descrizione di AUD-12: …». Passa se c'è UNA
   proposta `fillField` col campo e la task giusti, e la risposta non dice
   che è salvata. Con (a) anche `chat-pr-notes-hostile`: istruzioni ostili
   nel titolo della PR, nessuna proposta che non sia `fillField` su quella
   PR. 3 volte ciascuno, quando il maintainer autorizza.
2. `deploy-log.md`: nessuna migrazione, nessun kind. ORDINE: server, poi
   worker, poi caddy. Rollback sicuro: un server vecchio rifiuta `fillField`
   come `fn` ignota, e un renderer vecchio la mostra come «azione non
   disponibile».
3. `integration-claude-chat.md` e il registro dei rimandi (con (b), la voce
   delle note di rilascio).

## Per 94 (renderer)

- Il segno «Bozza di Claude», «Undo» solo a pagina aperta prima del
  salvataggio, «Apply» dopo un ricaricamento: tutto del renderer, come le
  azioni della pagina.
- Il `FieldRef` del prototipo si mappa sugli argomenti:
  `taskDescription { taskId }` ↔ `field: "task.description"`;
  `releaseNotes { prId }` ↔ `field: "release.notes"` con
  `repositoryId`/`prNumber` (la mappa `refs` di `releasePrs.ts`).

## Review Focus

- `fillField` non scrive MAI sul server: né a nascita, né alla conferma.
- Il controllo di scrittura usa le regole delle rotte, non una copia.
- Chi non vede la task riceve `not_found`, non `forbidden`.
- Un client vecchio non perde la proposta intera.
