# Integrazione area 10, F7 — S0 e i suggerimenti: piano

> Design: `docs/plans/2026-11-19-integrazione-area10-design.md`, «F7 — S0 e
> i suggerimenti» (D-1 = a, D-5 = a). Specifica: il prototipo
> (`domain/claude/intents/general.ts` `CAPABILITIES`,
> `pages/claude/conversation/CapabilitiesList.tsx`,
> `data/claude/suggestions.ts` e `suggestionKey.ts`; shape
> `claude-scenarios.md` §3.5 e `claude-suggestions.md`). Invarianti:
> `docs/invariants/claude-actions.md` («Gli eventi strutturati… li scrive il
> SERVER, non il modello», con le tre cose di un tipo di evento nuovo),
> `permissions.md` («Il client legge i permessi calcolati dal server»).
> Branch: `feat/area10-f7` da `feat/area10-f6` (da `feat/area10-f5` se F6
> non è ancora pronta: F7 non usa niente di F6 salvo la riga delle note, vedi
> F7-2).

## Prima del codice

- **[DECIDE] F7-1 — le capacità della doc di prodotto.** Il prototipo
  elenca 13 capacità: le nove dell'area 10 e cinque `product*` dell'area 11
  (11b). L'area 11 non è integrata.
  - **(a) — consigliata.** L'elenco del server ha solo le capacità che il
    server sa fare. Le `product*` arrivano con l'area 11, e il renderer
    salta quelle che non riceve. Si vede così: chi chiede «cosa sai fare?»
    non vede promesse che Claude non mantiene.
  - (b) Il server le manda tutte e 13, e il renderer le mostra. Claude
    elencherebbe cose che poi rifiuta.
- **[DECIDE] F7-2 — la riga «write the release notes» sulla PR.** Dipende da
  F6-1. Con F6-1 = (a) la riga c'è, coi criteri del prototipo. Con (b) non
  c'è, e la PR resta senza riga finché non arrivano le note. Lo dico qui
  perché si vede: è una delle quattro righe.
- **Ruling (cinque pagine → quattro)**: la shape elenca cinque pagine, ma la
  riga della conversazione di supporto («write the reply») è fuori per la
  premessa del maintainer del 14 nov 2026 (il design, F6 «Fuori»). Le
  pagine sono quindi PR, Automations, Overview e Usage. Se sbagliato costa
  un caso della rotta.
- **Le nove capacità e la regola che le accende** (le firme vere di chi
  chiede, mai il ruolo). La regola sta in UN modulo del server
  (`services/claude-capabilities.ts`), sulle `access` delle voci di
  `SERVER_CATALOG`, così una capacità c'è solo se la sua azione passerebbe:
  - `automation`: `automations.manage` in almeno un progetto
    (`createAutomation`);
  - `stalled`: sempre (Claude legge ciò che la persona vede);
  - `spend`: `usage.view` o `project.usage.view` in almeno un progetto (la
    regola di `/api/ai-usage/summary`);
  - `archive`: il permesso di `archiveProject` in almeno un progetto;
  - `addMember`: `project.members.manage` in almeno un progetto;
  - `releaseNotes`: `release.merge` o `tickets.edit` in almeno un progetto
    (con F6-1 = (a); altrimenti mai);
  - `mailBody`: una casella Google collegata di chi chiede (`fillMailBody`);
  - `taskDescription`: `tickets.edit` in almeno un progetto.
  Sono otto, e il «nove» del design conta la voce delle note: con F6-1 =
  (b) restano sette.
- **Fatti del codice che contano**:
  - gli eventi strutturati li scrive il worker nella sessione (`aside`,
    `claude-chat/aside.ts`, F3), e il server li arricchisce a lettura in
    `listAgentSessionEvents`. `capabilities` fa lo stesso: il tool
    `show_capabilities` chiama una rotta del server col token del turno,
    `GET /api/claude/capabilities` (nell'allowlist), e il worker scrive
    l'evento con gli id che riceve. Il modello non sceglie gli id;
  - un tipo di evento nuovo vuole tre cose: la riscrittura del CHECK
    `agent_session_events_type_chk` (l'ultima è la 0199, con `aside`), il
    valore nello `z.enum` letto da `readerSchema`, e un test col tipo
    ignoto;
  - il budget del mese: `monthlyBudgetExhausted` (`services/agent-sessions.ts`);
  - il fermo dell'Overview: `stallsOf` (`services/task-view.ts`), la stessa
    regola di `read_stalled_work` (F3), così la riga non porta mai a
    «niente di fermo»;
  - la proposta del polso aperta: la card `project.pulse` di chi guarda,
    non gestita, su quel progetto.
- **La migrazione** (il primo numero libero, con `when` crescente): la
  riscrittura del CHECK con `capabilities`, e la tabella
  `claude_suggestion_dismissals (user_id uuid references users on delete
  cascade, kind text, object_id text not null default '', dismissed_at
  timestamptz default now(), primary key (user_id, kind, object_id))`.
  Nessun valore di enum: tutto nella stessa migrazione.

## Regole di lavoro (le solite)

Come F5. Nel giro anche i test delle sessioni (`agent-sessions*.test.ts`),
`claude-asides.test.ts`, `chat-tool-token.test.ts` e `load-isolated.test.ts`.

## Task 1 — le capacità (shared, db, server)

**File**: shared `schemas/claude-conversation.ts` (l'evento, gli id
`CLAUDE_CAPABILITY_IDS`, la rotta nell'allowlist); db la migrazione (solo il
CHECK; la tabella al Task 3); server `services/claude-capabilities.ts`, la
rotta in `routes/claude-conversations.ts` (letterale PRIMA di `/:id`).

**Test** (`claude-capabilities.test.ts`): due persone con permessi diversi
ricevono elenchi diversi, e ogni capacità ha il caso in cui manca; un full
admin le riceve tutte; nessun dato di un progetto (solo id). Shared: il
parse di un evento `capabilities` con un id ignoto (`UNKNOWN`, saltato) e di
un tipo di evento ignoto.

Mutazione: una capacità accesa dal ruolo invece che dalla `access` della
voce.

## Task 2 — il tool e l'evento (worker)

**File**: `bridge.ts` (`show_capabilities` → la rotta), `aside.ts` →
`writeCapabilities`, `chat-mcp/server.ts`, `prompts.ts` (`CAPABILITIES_RULE`:
«when the request is not something you can do, call show_capabilities
instead of inventing an action, and say it in one sentence»).

**Test**: `bridge.test.ts`, `prompts.test.ts`; golden `chat-s0-capabilities`:
«prenotami un volo per Milano» → nessuna proposta, una chiamata a
`show_capabilities`, la risposta non promette. 3 volte, quando autorizzate.

## Task 3 — i suggerimenti e «Not now» (db, server)

**File**: la tabella (nella migrazione del Task 1); server
`services/claude-suggestions.ts`, le rotte
`GET /api/claude/suggestions?page=pr|automations|overview|usage&objectId=…`
e `POST /api/claude/suggestions/dismiss { kind, objectId }`.

**La risposta**: `{ suggestionId, kind, params } | null`, col solo codice
dell'oggetto in `params`. Le regole, in ordine, per chi guarda:
1. budget del mese esaurito → null;
2. «Not now» salvato per (chi guarda, `kind`, oggetto) → null;
3. per pagina:
   - `pr` (`objectId` = `<repositoryId>:<prNumber>`): PR aperta e visibile,
     chi guarda può scrivere le note, le note sono vuote, la task della PR
     non aspetta nessuno (un piano in attesa d'approvazione, una domanda
     dell'agente aperta) → `releaseNotes`. Solo con F6-1 = (a);
   - `automations` (`objectId` = progetto): lo vede, ha
     `automations.manage`, e nel progetto non ci sono automazioni che vede
     → `buildAutomation { code }`;
   - `overview`: lo vede, nessuna proposta del polso aperta per lui, almeno
     una task ferma (`stallsOf`) → `whyStalled { code }`;
   - `usage`: la regola di `/api/ai-usage/summary` → `monthSpend`.
Un oggetto che non vede: null, mai 404 (la riga non è un oracolo).

**Test** (`claude-suggestions.test.ts`): per ogni regola del «mai se» un
caso negativo; «Not now» nasconde quella riga solo a chi l'ha scelto e solo
su quell'oggetto; nessuna riga a chi non ha il permesso dell'azione
suggerita; un oggetto invisibile dà null; togliere un utente toglie le sue
righe (CASCADE).

Mutazioni: togliere il budget; leggere «Not now» per pagina invece che per
oggetto.

## Task 4 — i documenti

`deploy-log.md`: una migrazione (CHECK più largo e una tabella). ORDINE:
server, poi worker, poi caddy. **Rollback NON sicuro finché esistono eventi
`capabilities`**, come per `aside` in F3: lo schema di risposta del server
vecchio non conosce il tipo, e la pagina degli eventi di quella conversazione
va in 500. Il server scende insieme al caddy, il worker con loro. La voce dà
le query: `select count(*) from agent_session_events where type =
'capabilities';` e `delete from agent_session_events where type =
'capabilities';` (spariscono gli elenchi da quelle conversazioni).
`integration-claude-chat.md`, il registro dei rimandi (le `product*`
all'area 11 con F7-1 = (a)), e `claude-suggestions` acceso.

## Per 94 (renderer)

- L'evento `capabilities { items: CapabilityId[] }`: gli id sono quelli del
  prototipo; le frasi restano del renderer.
- La riga: il renderer chiama la rotta per pagina e mostra ciò che arriva,
  senza `can()`. «Not now» chiama `dismiss` e nasconde la riga subito.

## Review Focus

- Una capacità, o una riga, c'è solo se l'azione passerebbe per chi guarda.
- Il modello non sceglie gli id dell'evento.
- «Not now» è per persona e per oggetto.
- La rotta dei suggerimenti non dice niente di un oggetto che chi guarda non
  vede.
