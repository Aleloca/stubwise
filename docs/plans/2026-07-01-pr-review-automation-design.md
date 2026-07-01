# PR Review — automazione di review delle pull request

Data: 2026-07-01 · Stato: design validato

## Obiettivo

Ad ogni PR aperta (o aggiornata) su un repository collegato, un agente AI fa
un'analisi critica del contenuto e suggerisce o meno l'approvazione. Gira anche
sulle PR aperte da Stubwise stesso, come secondo occhio sulla pipeline di fix.

## Flusso e trigger

- **Webhook esistente** `POST /webhooks/git/:projectSlug`: si estende
  `parseWebhook` in `packages/git` con i kind `pr_opened` e `pr_updated`.
  - GitHub: action `opened` e `synchronize` dell'evento `pull_request`
    (già ricevuto, oggi scartato).
  - Bitbucket: eventi `pullrequest:created` e `pullrequest:updated`, da
    aggiungere a `ensureWebhook` (riallineare i webhook già configurati).
- **Coda con debounce** (~90s): upsert in `pr_review_jobs` con chiave
  (repository, numero PR); push ravvicinati collassano in un solo job. Claim
  del worker via `DELETE ... RETURNING` a debounce scaduto. Push durante una
  review in corso ⇒ nuova review sulla head aggiornata.
- **Nessun filtro sull'autore**: le PR `stubwise/ticket-N` sono incluse.
- **Anti-loop**: il commento sulla PR non genera `synchronize`; le
  `automation_rules` del nuovo tipo `review` nascono con `auto_fix = false`,
  quindi il ticket REVIEW non innesca la pipeline di fix.

## Modello dati e impostazioni

- **Nuovo tipo ticket `review`**: esteso `ticketTypeSchema` in
  `@stubwise/shared`, enum Postgres via migrazione, riga `automation_rules`
  seedata con `auto_fix = false`. Badge dedicato + i18n; compare nella tabella
  di `/settings/automation` come gli altri tipi.
- **`pr_reviews`** (storico, una riga per review eseguita): `id`,
  `repository_id`, `pr_number`, `pr_url`, `pr_title`, `head_sha`, `ticket_id`
  (ticket esistente per PR nostre, o ticket REVIEW creato), `verdict`
  (`approve` | `request_changes`), `summary` (markdown), `status`
  (`running`/`completed`/`failed`), `error`, `provider_id`,
  `last_activity_at`, timestamps. Costi tracciati via `agent_runs`.
- **`pr_review_jobs`** (coda debounce): `repository_id`, `pr_number`,
  `head_sha`, `pr_title`, `pr_source_branch`, `debounce_until`,
  unique (repository_id, pr_number).
- **Impostazioni** in `instance_settings`: `pr_review_enabled` (default
  false), `pr_review_max_cost_usd` (nullable; superato il cap la review viene
  interrotta e marcata `failed` con motivo esplicito). Esposte in
  `GET/PUT /api/settings/automation`, sezione "PR REVIEW" nella pagina
  esistente.

## Esecuzione nel worker

- Claim nella catena di priorità del loop, dopo i fix; esecuzione DENTRO il
  `ProjectSerializer` condiviso (tocca i mirror git).
- Riga `pr_reviews` in `running`; worktree del solo repo interessato alla
  `head_sha` via `MirrorManager` (fetch `pull/N/head` su GitHub, source branch
  su Bitbucket); diff verso il merge-base col branch di destinazione.
- **Agente read-only**: singola fase `ClaudeCliRunner` in permission-mode
  `plan` (niente scritture né test). Prompt: titolo/descrizione PR, diff,
  istruzione di navigare il codebase valutando correttezza, regressioni,
  sicurezza, coerenza con le convenzioni. Output JSON: `verdict` + `summary`
  markdown con rilievi puntuali (file:riga). Provider chain con failover,
  `recordAgentRun`; `ProviderLimitError` ⇒ job riaccodato con ritardo.

## Pubblicazione (tre destinazioni)

1. **Commento sulla PR**: nuovo `postPrComment` in `packages/git` (identità
   del `git_account`). Commento "sticky" con marker HTML: le re-review
   aggiornano lo stesso commento.
2. **Commento sul ticket** (`comments`, `authorType: ai`): PR nostra ⇒ ticket
   esistente (lookup `ticket_repositories`); PR esterna ⇒ creazione ticket
   `review` (titolo = titolo PR, body = link + contesto) + commento con
   l'analisi. Ogni re-review = nuovo commento (storico sul ticket).
3. **Notifica** `review.completed`: nuovo `NotificationKind` + toggle in
   `notification_settings`, verdetto in evidenza, best-effort post-commit
   (Slack/Discord/generic via webhook esistente).

**Auto-chiusura**: il ramo webhook di PR chiusa (oggi limitato ai branch
`stubwise/*`) viene esteso: se esiste un ticket `review` per quella PR, lo
chiude con evento in timeline.

## UI web

- `/settings/automation`: sezione "PR REVIEW" (toggle + max cost), stesso
  pattern di save unico.
- Badge e filtro per il tipo `review` ovunque compaiano i tipi ticket.
- La review appare come commento AI nel dettaglio ticket (sistema commenti
  esistente); opzionale un chip col verdetto accanto al link PR.

## Gestione errori

- Fallimento agente ⇒ `status = failed` + `error`; nessun retry automatico
  (push successivo o trigger manuale ri-accodano).
- Heartbeat `last_activity_at` e recovery stale coerenti con
  `WORKER_STALE_MINUTES` (la review è più corta di un fix: invariante attuale
  sufficiente).
- PR chiusa prima dell'esecuzione ⇒ il claim verifica lo stato via API e
  scarta il job.
- `postPrComment` che fallisce (es. permessi token) NON fa fallire la review:
  risultato sul ticket + warning nel log.

## Test

- Unit: `parseWebhook` per i nuovi kind (fixture GitHub/Bitbucket); parsing
  output JSON dell'agente; logica commento sticky.
- Integrazione server (testcontainers): webhook ⇒ upsert `pr_review_jobs`
  con gate sul toggle.
- Integrazione worker: claim/debounce/serializer; branching ticket esistente
  vs ticket nuovo.
- E2E Playwright: solo sezione settings.

## Decisioni chiave (con motivazione)

- Impostazioni a livello istanza (non per-repo): coerente con le regole
  auto-fix; il filtro naturale per-repo è la configurazione del webhook.
- Trigger su apertura + ogni push con debounce: review sempre aggiornata.
- Checkout completo read-only (non solo diff): l'agente vede il contesto;
  niente esecuzione test (ridondante con la CI del repo).
- Review nel sistema di ticketing (commento su ticket esistente / ticket
  `review` per PR esterne) invece di una pagina dedicata.
