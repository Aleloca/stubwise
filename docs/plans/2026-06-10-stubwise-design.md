# Stubwise — Design

**Data**: 2026-06-10
**Stato**: validato

## Cos'è

Stubwise è un sistema di ticketing self-hostable (open-source, MIT) con una pipeline AI integrata: ogni ticket viene analizzato automaticamente da Claude Code, che — quando il ticket è azionabile — apre una pull request con il fix e un report dettagliato del processo di indagine, della causa radice e della soluzione.

I ticket arrivano da tre fonti:
1. **Errori automatici** catturati dall'SDK nelle app in produzione (stile Sentry)
2. **Feedback degli utenti finali** inviato via SDK
3. **Ticket manuali** creati dal team via UI o API

L'AI è un layer opzionale: senza configurazione AI, Stubwise resta un issue tracker completo con board Kanban. Questo è importante per l'adozione open-source.

## Decisioni chiave

| Decisione | Scelta | Motivo |
|---|---|---|
| Scope PM | Issue tracker essenziale + board Kanban | Il valore differenziante è l'automazione AI, non replicare Jira |
| Trigger AI | Tutto automatico su ogni ticket nuovo | Con triage economico + dedup per fingerprint a monte per non sprecare quota |
| Accesso ai repo | Mirror bare sul VPS + worktree effimero per job | Veloce, sempre aggiornato, job isolati, niente working copy condivise |
| Git provider | Astrazione `GitProvider`; v1: Bitbucket Cloud + GitHub | I repo dell'utente sono soprattutto su Bitbucket; l'open-source richiede estendibilità |
| Stack | Monorepo TypeScript (pnpm workspaces) | Coerente con l'ecosistema dei progetti (tutti JS/TS), tipi condivisi end-to-end |
| Database | Solo PostgreSQL (coda job inclusa) | Un pezzo in meno da self-hostare; volume job basso per definizione |
| AI runtime | Claude Code CLI headless (`claude -p`) sul VPS | Sfrutta l'abbonamento MAX; fallback su `ANTHROPIC_API_KEY` |
| Licenza | MIT | Massima adozione e contribuzioni |

## Architettura

Monorepo pnpm workspaces:

- **`apps/server`** — API server Fastify: API REST per UI e SDK, ingestion eventi, webhook dai git provider, autenticazione.
- **`apps/web`** — Frontend React (Vite): lista ticket, board Kanban, dettaglio ticket con timeline attività AI, gestione progetti e impostazioni.
- **`apps/worker`** — Processo separato che esegue i job AI: preleva dalla coda (Postgres), prepara il worktree dal mirror, lancia Claude Code headless, pusha il branch, apre la PR.
- **`apps/docs`** — Sito documentazione Starlight (Astro), pubblicato su GitHub Pages e servito anche nell'istanza self-hosted su `/docs`.
- **`packages/sdk`** — `@stubwise/sdk` npm, entry point `browser` e `node`.
- **`packages/shared`** — Tipi e schemi Zod condivisi tra server, worker, web e SDK.

**Deploy**: Docker Compose con Postgres, server, worker, Caddy (statici web + docs, reverse proxy, HTTPS automatico). Il worker monta il volume dei mirror git e ha il binario `claude` installato; autenticazione una tantum con `docker compose exec worker claude login` (token persistito in volume).

## Modello dati

- **User** — email + password (hash), ruolo `admin`/`member`. Niente multi-tenancy: un'istanza = un team. Inviti via link.
- **Project** — un progetto = un repository: nome, slug, provider (`bitbucket`/`github`), URL repo, credenziali cifrate, branch di default, **ingestion key** pubblica (stile DSN Sentry).
- **Ticket** — titolo, descrizione markdown, tipo (`bug`/`feature`/`task`/`feedback`), priorità, stato, assegnatario, label, origine (`manual`/`sdk_error`/`sdk_feedback`/`api`); per i ticket da SDK: payload tecnico (stack trace, browser, URL, release, breadcrumbs).
- **ErrorGroup** — fingerprinting stile Sentry (hash di stack trace normalizzato + tipo errore). Eventi identici si accorpano: il primo crea il ticket, i successivi incrementano il contatore di occorrenze. È ciò che rende sostenibile il "tutto automatico": mille crash uguali = un ticket = un job AI.
- **Comment** — commenti umani e dell'AI (l'AI documenta lì il suo processo).
- **AIJob** — esecuzione AI: ticket, stato (`queued`/`triaging`/`fixing`/`pr_opened`/`failed`/`skipped`), log completo, link PR, durata.

**Ciclo di vita ticket**: `open → triaged → in_progress → in_review → done`, più `closed` per scartati/duplicati. La board Kanban mostra gli stati come colonne. Il merge della PR (webhook provider) sposta il ticket in `done`.

## SDK e ingestion

```ts
import { init, captureFeedback, createTicket } from '@stubwise/sdk/browser'

init({
  dsn: 'https://INGESTION_KEY@stubwise.example.com/p/shop',
  release: '1.4.2',
  environment: 'production',
})
```

- **Cattura errori automatica**: browser (`window.onerror`, `unhandledrejection`), Node (`uncaughtException`, `unhandledRejection`, error handler per Express/Fastify). Ogni evento porta: stack trace, messaggio, URL/route, user agent, release, environment, **breadcrumbs** (ultime N azioni: click, navigazioni, fetch fallite) — contesto che finisce nel prompt di Claude.
- **Feedback utenti**: `captureFeedback({ message, email?, screenshot? })`, programmatica. Nessun widget UI precostruito nella v1 (YAGNI; eventuale package separato in futuro).
- **Ticket via API**: `createTicket({ title, body, type, priority })` per casi server-side.
- **Robustezza**: batching (invio a batch ogni pochi secondi), retry con coda in memoria. L'SDK non deve mai rompere o rallentare l'app ospite.

**Ingestion lato server**: `POST /ingest/:projectSlug` autenticato con la sola ingestion key (permette solo di creare eventi, mai di leggere). Pipeline: validazione Zod → rate limiting per chiave → fingerprinting → dedup su ErrorGroup → creazione ticket o incremento contatore → se ticket nuovo, enqueue job AI.

## Pipeline AI

Worker con concorrenza limitata (default 2 job paralleli). Due fasi:

**Fase 1 — Triage** (economica, `claude -p --model haiku`): riceve ticket + lista ticket recenti del progetto, risponde con giudizio strutturato: `fix` / `skip` (con motivo) / `duplicate_of: #N`. Skip e duplicati vengono commentati sul ticket e gestiti senza consumare quota sul fix.

**Fase 2 — Fix** (solo su `fix`): fetch sul mirror, worktree temporaneo, poi:

```
claude -p "<prompt>" --permission-mode acceptEdits --max-turns 80
```

Il prompt contiene titolo, descrizione, stack trace, breadcrumbs, release e istruzioni: riproduci/localizza il bug, scrivi un test che lo dimostra se possibile, implementa il fix minimale, esegui i test esistenti, scrivi un report con processo di indagine, causa radice, soluzione e motivazione.

**Chiusura job**: verifica diff presente + test passanti → push branch `stubwise/ticket-N` → PR via API provider (descrizione = report di Claude) → commento sul ticket con link e report → ticket in `in_review`. In caso di fallimento: job `failed` con log completo consultabile dalla UI, ticket resta al team.

**Flusso job**:

```
ticket nuovo → AIJob queued → triage (haiku)
  ├─ skip/duplicate → commento + chiusura/lascia al team
  └─ fix → fetch mirror → worktree → claude -p → diff + test ok?
       ├─ sì → push stubwise/ticket-N → PR → commento → in_review
       └─ no → failed (log in UI)
```

## Git provider e sicurezza

```ts
interface GitProvider {
  getCloneUrl(project): string
  openPullRequest(project, { branch, title, body }): Promise<{ url }>
  parseWebhook(req): PrMergedEvent | null
}
```

- v1: **Bitbucket Cloud** (app password / workspace token) e **GitHub** (fine-grained PAT; GitHub App in futuro). Credenziali per-progetto, cifrate a riposo (AES-256-GCM, chiave in env var), usate solo dal worker.
- **Esecuzione AI confinata**: worktree come unica directory di lavoro, `--permission-mode acceptEdits`, `--max-turns`, timeout duro a livello worker.
- **Push solo su branch `stubwise/*`**, mai sul default; branch protection sul provider come difesa finale.
- **Prompt injection**: il contenuto dei ticket da SDK è input utente non fidato; il prompt lo delimita esplicitamente come dato. Il confine di sicurezza vero è che ogni PR è rivista da un umano prima del merge.
- **Webhook** firmati/verificati, solo evento "PR merged → ticket done".
- L'ingestion key crea soltanto eventi; lettura e gestione richiedono sessione utente o API token personale.

## Documentazione

La documentazione è un deliverable di prima classe, scritta insieme al codice (ogni feature del piano include la sua pagina):

- **Guida self-hosting**: compose, .env, login Claude Code, backup, upgrade.
- **Guida SDK**: init, cattura errori, feedback, ticket via API.
- **Reference API REST**: auto-generata da OpenAPI (derivata dagli schemi Zod del server — mai fuori sync).
- **Guida pipeline AI**: funzionamento, configurazione, gestione quota/costi.
- **CONTRIBUTING**: setup sviluppo, convenzioni, come aggiungere un GitProvider.

## Testing

- **Unit/integration**: Vitest; copertura più fitta su fingerprinting, dedup e pipeline ingestion. Integration test API con Postgres effimero (testcontainers).
- **Worker AI**: interfaccia `AgentRunner` che astrae la CLI `claude`; nei test un runner finto produce un diff noto, così si testa tutta la meccanica mirror → worktree → branch → PR senza quota né dipendenza dal modello.
- **E2E**: Playwright sui flussi chiave (creare ticket, board, report AI).

## Fuori scope (v1)

- Sprint, epic, story point, workflow custom, campi custom
- Integrazioni esterne in ingresso (email, GitHub Issues, webhook terzi)
- Widget di feedback UI precostruito
- SDK per linguaggi diversi da JS/TS
- Multi-tenancy / organizzazioni
- Provider GitLab/Gitea (estensione futura via interfaccia `GitProvider`)
