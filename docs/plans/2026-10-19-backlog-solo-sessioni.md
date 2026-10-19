# Backlog: solo sessioni di refinement — dismissione di chat, modalità CODE e deep dive (19 ott 2026)

## Perché

Primo giro completo «backlog → merge» guidato dall'app (19 ott 2026). Il
maintainer si aspettava una sola strada per lavorare su una voce, la
**sessione di refinement** (`backlog_refine`, 14 ott 2026); nell'app c'erano
invece due bottoni («Refine in chat» e «Start session»). Il design del 14 ott
li aveva lasciati convivere; ora si decide di togliere tutto il resto.

## Decisioni (maintainer, 19 ott 2026)

1. **Via, ovunque, server compreso**: la chat della voce in modalità DOCS
   (RAG, `POST /api/backlog/:id/chat`, `backlog_chat_messages`), la modalità
   CODE / sessione di analisi (`backlog_code_sessions`, job `chat_turn`, rotte
   `code-session`), le **domande a bottoni** del backlog (`backlog_questions`:
   sono solo della chat CODE), il **deep dive** (job `deep_dive`, rotta, UI) e
   **«Aggiorna documento»** (`POST /:id/refresh-document`: riassume la chat,
   senza chat non ha input).
2. **Nessuna compatibilità con app vecchie**: l'app non è sugli store, l'unico
   utente è il maintainer, che la reinstalla col deploy. I campi spariscono
   dalle risposte senza segnaposto.
3. **Lo storico si cancella**: le tabelle `backlog_chat_messages`,
   `backlog_code_sessions`, `backlog_questions` vengono DROPpate (irreversibile).
4. **Enum `backlog_job_kind` ricreato** con i soli `intake`, `estimate`: la
   migrazione 0091 cancella prima i job `deep_dive`/`chat_turn` (anche
   `queued`/`running`), poi rinomina il tipo vecchio, crea il nuovo,
   `ALTER COLUMN kind TYPE … USING kind::text::backlog_job_kind`, droppa il
   vecchio. Anche `backlog_code_session_status` sparisce. `enum-parity.test.ts`
   deve restare verde (ordine Zod = ordine Postgres).
5. **`hasAnalysis` rimosso** dal payload del polso (notifiche/webhook), dal
   formato e dall'MCP; la guida lo dice.
6. **`new → refining` al PRIMO MESSAGGIO di una sessione di refinement**: in
   `startRefineSession` quando c'è `message`, e in `reopenRefineSessionIfClosed`
   / nel percorso del messaggio successivo (stesso lock della voce, ordine voce
   → sessione). Dopo la dismissione è l'unico passaggio automatico a
   `refining`.
7. **Pagina web della voce: due colonne** — documento a sinistra, a destra la
   card della sessione di refinement e lo stato (piano, ticket collegati), al
   posto della chat.

## Cosa resta

- `backlog_jobs` (intake, estimate); `agent_sessions` kind `backlog_item`
  (sessioni di stima e di merge dell'intake: diventa NON interattivo — fuori da
  `INTERVENABLE_SESSION_KINDS`).
- `chatLlm`, `streamChatResponse`, retrieval: li usano chat Docs, Slack, widget
  e il **merge** di due voci (`POST /:id/merge` resta, ma senza messaggi di
  chat né chiusura di domande).
- `BACKLOG_CHAT_TURN_MAX_TURNS`: la usa il **refinement** → rinominata
  `BACKLOG_REFINE_MAX_TURNS` (leggendo ancora la vecchia come ripiego, con
  avviso nel log), voce nel deploy-log.

## Trappole note

- `agent_sessions.active_segment_label` è testo libero: la 0091 mette a NULL i
  valori `deep_dive`/`chat_turn` prima di togliere quelle etichette da
  `agentSegmentLabelSchema` (altrimenti la serializzazione delle sessioni
  vecchie fallisce).
- Scritture automatiche nella chat da togliere: messaggio di sistema del merge
  dell'intake (`intake.ts`), messaggi ponte del merge di voci, messaggio di
  chiusura della sessione CODE nella conversione, risposte alle domande.
- `@stubwise/shared` è pubblicato: changeset (major per gli export rimossi).
- Il golden `refine-read-plan` esiste solo per chat CODE/deep dive: via, col
  suo paragrafo in `docs/invariants/backlog-refine.md`. `refine-read` e
  `refine-read-bash` restano.
- CLAUDE.md: perimetro plugin (togliere deep dive e chat di analisi),
  asimmetria `--setting-sources`, invariante `agent_sessions.backlog_item_id`.
  Anche `projects:plugins.settingSourcesWarning` nella UI web diventa stantio.

## Correzioni dallo stesso giro (stesso branch)

- Intake: titolo segnaposto dell'app letto come punto troncato — fatto.
- App: la voce catturata non compariva senza riaprire l'app — fatto.
- App, sessione dell'agente:
  - riquadro della voce troppo grande → riga compatta + `SheetModal`
    (invariante dei fogli nativi in `docs/invariants/mobile-app.md`);
  - markdown solo a fine turno e testo in cima che sparisce (coda di 2000
    caratteri, `transcript-text.ts`) → markdown anche dal vivo, ridisegno
    limitato (~500 ms), testo semplice solo oltre `LONG_TEXT_CHARS`;
  - autoscroll che non si ferma → `maintainVisibleContentPosition` quando
    l'utente non è in fondo, «nuovi messaggi» sul bottone ↓ (come
    `apps/web/src/lib/session-scroll.ts`).

## Ordine

1. Fondamenta: `packages/shared`, `packages/db` (schema + 0091 + test),
   `packages/i18n`.
2. In parallelo: server (+ decisione 6), worker (+ golden, config), web,
   app (dismissione + correzioni della sessione), guida e documenti.
3. `pnpm build && pnpm typecheck && pnpm lint && pnpm test`, deploy-log,
   changeset, PR.
