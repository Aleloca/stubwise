# Integrazione area 10, F4 — S4, archiviare in blocco: piano

> Design: `docs/plans/2026-11-19-integrazione-area10-design.md`, «F4 — S4»
> (D-9 = a). Specifica: il prototipo, `domain/claude/intents/archive.ts`
> (la risposta), `data/claude/answersData.ts` (`archiveCandidatesFor`) e
> `data/projectActivity.ts` (`lastActivityOf`). Invarianti: `permissions.md`
> (R-G5, l'archivio di F6), `claude-actions.md`.
> Branch: `feat/area10-f4` da `feat/integrazione-area10`.

## Prima del codice

- **Nessuna [DECIDE]**: la regola di «senza attività» è quella del
  prototipo.
- **Una deviazione dal design, motivata.** Il design dice
  `read_archive_check({ projectIds })`. Ma per scegliere quali progetti
  archiviare Claude deve sapere quali sono FERMI, e il server non dà
  l'ultima attività di un progetto: nessuna rotta, nessun campo. Il
  prototipo fa le due cose in UNA lettura (`listArchiveCandidates(days)`:
  candidati, occupati, non gestibili). Il tool è quindi
  `read_archive_candidates({ inactiveDays })`, su una rotta nuova, con la
  forma di `ArchiveCandidates` del prototipo
  (`apps/desktop/src/renderer/data/model.ts:3154`). D-9 = a resta tale:
  Claude propone solo i candidati e nomina gli altri.
- **Nessuna migrazione.**
- **Fatti del codice che contano**:
  - i motivi `busy` li calcola `busyReasons(db, projectId, viewer,
    permissions)` (`apps/server/src/services/project-archive.ts`), già
    filtrati per chi chiede: una sessione che non vede ha codice e titolo
    `null`. L'archivio vuole `project.settings.manage` nel progetto
    (`routes/project-archive.ts`, `MANAGE`);
  - i titoli nei motivi possono venire da fuori: un ticket del widget, il
    titolo di una PR. Al modello passano solo `kind`, `code`, `waiting`,
    `paused`, MAI `title`;
  - «ultima attività» nel prototipo è la data più recente fra:
    - la creazione delle task e i loro eventi;
    - la creazione e le scritture delle richieste;
    - le decisioni del registro;
    - i messaggi del supporto;
    - le PR aperte e i rilasci mergiati.

    Sul server sono `tickets.created_at`, `ticket_events.created_at`,
    `backlog_items.created_at` / `updated_at`,
    `project_decisions.decided_at`, `widget_messages.created_at`
    (attraverso `widget_conversations.project_id`), l'apertura delle PR
    (la colonna si conferma al Task 1: `ticket_repositories` o `releases`)
    e `releases.merged_at`. Un progetto senza niente di tutto questo vale
    come «mai attivo» (prototipo: `""`, cioè più vecchio di ogni limite).

## Regole di lavoro (le solite)

Come F1. F4 non tocca il catalogo (`archiveProject` c'è da F7 dell'area 9),
ma il prompt sì: nel giro anche `prompts.test.ts` e `turn.test.ts`.

## Task 1 — l'ultima attività e la rotta dei candidati

**File**: `apps/server/src/services/project-activity.ts` (nuovo),
`routes/project-archive.ts` (la rotta), shared (lo schema della risposta,
additivo). Test: `project-activity.test.ts` (nuovo, Postgres vero),
`project-archive.test.ts`.

1. **RED, l'ultima attività** (una query per tutti i progetti visibili, non
   una per progetto):
   - ogni sorgente da sola sposta la data: una task creata, un evento, una
     richiesta aggiornata, una decisione, un messaggio del supporto, un
     rilascio;
   - un progetto senza niente → `null`;
   - un progetto archiviato non c'è;
   - un progetto che chi chiede non vede non c'è.
2. **RED, la rotta** `GET /api/projects/archive-candidates?inactiveDays=<n>`
   (`access: user`, `n` fra 1 e 3650, default 90). Va registrata PRIMA di
   `GET /:projectId` (CLAUDE.md, trappola di routing). Restituisce
   `{ candidates, busy, notManageable, notManageableCodes }`:
   - i fermi da più di `n` giorni, dal più vecchio, poi per codice;
   - senza `project.settings.manage` → in `notManageable` col codice (il
     progetto è visibile, quindi R-G5 regge);
   - con motivi `busy` → in `busy`, coi motivi di `busyReasons`;
   - gli altri sono `candidates`, con `lastActivity` (ISO, o `null`).
   - NEGATIVO: un progetto che chi chiede non vede non compare in nessuna
     delle tre liste, neanche come conteggio.
3. **GREEN**: il servizio e la rotta. Lo schema in shared ha i campi
   additivi con `.default([])`, e un test lo parsa senza.
4. **Mutazioni**:
   - togliere una sorgente dall'unione: il suo test diventa rosso;
   - contare i progetti invisibili in `notManageable`: il negativo diventa
     rosso;
   - registrare la rotta dopo `/:projectId`: il test della rotta diventa
     rosso (400 di validazione dell'uuid).
5. **Giro**: `project-activity.test.ts`, `project-archive.test.ts`,
   `projects.test.ts`, `route-access.test.ts`.

## Task 2 — `read_archive_candidates`

**File**: shared (tool e rotta in `CHAT_TOOL_READ_ROUTES`), worker
`bridge.ts`, `chat-mcp/server.ts`. Test: `bridge.test.ts`,
`chat-tool-token.test.ts`.

1. **RED, ponte**:
   - `{ inactiveDays: 90 }` → `/api/projects/archive-candidates?inactiveDays=90`;
     un valore fuori da 1–3650 o non intero → `ChatToolArgError`; assente →
     90;
   - proiezione: i candidati con `projectId`, `code`, `name`,
     `lastActivity`; di `busy` per progetto `code` e i motivi come
     `{ kind, code, waiting, paused }`, MAI `title`; `notManageableCodes`.
2. **RED, server**: col token del turno la rotta risponde 200, e la lettura
   non segna la conversazione (niente testo da fuori passa).
3. **GREEN**, poi **mutazione**: passare `title` nei motivi, e il test della
   proiezione diventa rosso.
4. **Giro**: `bridge.test.ts`, `turn.test.ts`, `prompts.test.ts`,
   `chat-tool-token.test.ts`, `chat-tool-routes.test.ts`.

## Task 3 — il contratto e il golden S4

1. Il prompt: per «archivia i progetti fermi», prima `read_archive_candidates`,
   poi UNA proposta con un `archiveProject` per ogni candidato. Gli occupati
   e i non gestibili si nominano in prosa, col motivo; per un non gestibile,
   «chi può farlo» si chiede a Stubwise. Mai un `archiveProject` di un
   progetto fuori dai candidati. `prompts.test.ts` controlla le frasi per
   chiave.
2. Golden `chat-s4-archive`, nella fixture: tre progetti fermi, uno
   occupato (una generazione dei Docs) e uno senza permesso. Passa se c'è la
   lettura, se la proposta contiene SOLO l'`archiveProject` del candidato, e
   se la risposta nomina gli altri due. Si lancia 3 volte, con
   l'autorizzazione delle corse.
3. **Giro**: `prompts.test.ts`, `turn.test.ts`; `checks.test.ts` dei golden
   se il check è nuovo.

## Task 4 — documenti e chiusura

- `deploy-log.md`: la rotta nuova, l'ordine (server, poi worker), il
  rollback sicuro (nessun dato).
- `integration-claude-chat.md`: S4 (per 94).
- Il registro: chiuso «l'esito per riga di una proposta in blocco», con
  D-9 = a e la deviazione del tool.

## Per 94 (renderer)

- La scheda in blocco c'è già. Le righe non fattibili non stanno nella
  scheda: le dice la prosa sopra. Il prototipo si riallinea (design, F4).

## Review Focus

- La query dell'ultima attività è UNA, e filtra la visibilità nella WHERE
  (`permissions.md`, «Gli elenchi filtrano nella WHERE»).
- Nessun progetto invisibile nei conteggi.
- Nessun titolo dei motivi `busy` nel contesto del modello.
