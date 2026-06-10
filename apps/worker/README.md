# @stubwise/worker

Il worker AI di Stubwise: legge i job dalla coda su Postgres (`ai_jobs`) ed
esegue la pipeline su ogni ticket aggredibile.

## Cosa fa

Per ogni job reclamato (`createHandler` in `src/handler.ts`):

1. **Triage** (`src/pipeline/triage.ts`) — fase economica (modello `haiku`,
   pochi turni). Decide se vale la pena spendere quota:
   - `fix` → il job avanza alla fase di fix;
   - `skip` → chiude il job con un commento AI sul ticket;
   - `duplicate` → chiude il ticket come duplicato di uno recente.
   Il triage **non tocca il repo**: ragiona solo su ticket + ticket recenti.
2. **Fix** (`src/pipeline/fix.ts`) — fase costosa. L'agente lavora in un
   worktree effimero (`src/git/mirrors.ts`) sul branch
   `stubwise/ticket-<numero>`: localizza il bug, scrive un test che lo
   dimostra (se il repo lo consente), applica il fix minimale, esegue i test,
   e scrive il report in `STUBWISE_REPORT.md`. Poi il **worker** (non
   l'agente) committa come `Stubwise AI <ai@stubwise>`, pusha il branch e
   apre la PR con il report come corpo, infine commenta il ticket e lo porta
   `in_review`.

L'agente è il CLI `claude` in modalità headless (`src/agent/claude-cli.ts`):
il prompt viaggia su stdin, l'env del child è una **allowlist esplicita**
(niente segreti del master), exit non-zero = nessuna PR.

I job dello **stesso progetto** vengono serializzati (catena di promise per
`projectId` nell'handler): due fix concorrenti sul medesimo mirror si
calpesterebbero i ref `stubwise/*` non ancora pushati (vedi il docblock di
`mirrors.ts`). Progetti diversi procedono in parallelo (`WORKER_CONCURRENCY`).

## Configurazione (variabili d'ambiente)

Validata da `src/config.ts`. Il worker **non** applica le migrazioni: assume
che lo schema esista già (le applica il server all'avvio).

| Variabile             | Obblig. | Default                  | Descrizione |
| --------------------- | ------- | ------------------------ | ----------- |
| `DATABASE_URL`        | sì      | —                        | Postgres (la stessa istanza del server). |
| `ENCRYPTION_KEY`      | sì      | —                        | Chiave AES-256 in base64, **la stessa del server**: decifra `projects.encrypted_credentials`. |
| `MIRRORS_DIR`         | no      | `/var/stubwise/mirrors`  | Directory dei mirror git persistenti (creata con mode 0700). |
| `WORKER_CONCURRENCY`  | no      | `2`                      | Job in volo contemporanei su progetti **diversi** (1–16). |
| `WORKER_STALE_MINUTES`| no      | `30`                     | Inattività oltre cui un job è orfano e torna in coda. Deve superare il timeout di fix + triage (verificato all'avvio). |

### Auth del CLI claude

Il worker shella sul CLI `claude` con un **env ristretto** (allowlist in
`src/agent/claude-cli.ts`): passano solo `PATH`, `HOME`, `LANG`, `LC_ALL`,
`TMPDIR`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME` e le variabili con prefisso
`ANTHROPIC_`/`CLAUDE_`. Tutto il resto (compresi `ENCRYPTION_KEY`,
`DATABASE_URL`, `SESSION_SECRET`) viene scartato.

**Conseguenza operativa:** l'autenticazione del CLI deve sopravvivere a questo
filtro. In pratica:

- auth via **API key**: imposta `ANTHROPIC_API_KEY` (passa per prefisso);
- auth via **abbonamento (login OAuth)**: le credenziali in `~/.claude.json`
  /`CLAUDE_CONFIG_DIR` sono raggiungibili perché `HOME`/`CLAUDE_CONFIG_DIR`
  sono in allowlist — assicurati che l'utente che esegue il worker abbia fatto
  `claude` + login una volta in quell'`HOME`.

Se l'auth vive in una variabile **fuori** dall'allowlist, l'agente partirà ma
risponderà `Not logged in · Please run /login` e il job fallirà (triage:
"output non valido"). Lo smoke test (`--local`) verifica questa condizione in
anticipo e **salta** invece di fallire (vedi sotto).

## Eseguire in locale

```bash
# build delle dipendenze workspace + watch del worker
pnpm --filter @stubwise/worker dev
```

Servono un Postgres con lo schema migrato (lo migra il server) e un `claude`
autenticato sul PATH. In produzione il worker gira come processo singolo
(l'assunzione di deployment di `MirrorManager` e della serializzazione
per-progetto è un solo processo worker).

## Smoke test della pipeline reale

Script manuale `scripts/smoke.ts` che esercita l'**intera pipeline sullo
stesso codice di produzione** (`createHandler`), scambiando solo ciò che ogni
modalità richiede. Non è un test automatico (niente vitest).

### `--local` (default)

Lo smoke più economico: **nessuna dipendenza esterna** oltre a Docker (per
Postgres) e a un `claude` autenticato.

```bash
pnpm --filter @stubwise/worker smoke -- --local
```

Cosa fa:

- crea un origin git **bare locale** in tmpdir con un piccolo progetto Node
  (`slugify.js`) che ha un **bug piantato** e un test reale (`node:test`) che
  lo dimostra;
- avvia un **Postgres effimero** via testcontainers (oppure usa
  `SMOKE_DATABASE_URL` se impostata), applica le migrazioni;
- inserisce progetto + ticket + job in coda;
- esegue la pipeline con il **`ClaudeCliRunner` reale** e un **provider PR
  finto** che cattura titolo/corpo della PR (nessuna rete verso GitHub);
- stampa a video: stato del repo (branch pushato sull'origin locale, commit,
  diff), la PR catturata (corpo = report dell'agente), e lo stato finale di
  job e ticket.

Se `claude` non è sul PATH **o non è autenticato per l'uso headless** (probe
con lo stesso env del runner), lo smoke **salta** con un messaggio chiaro ed
esce 0: la pipeline non si finge mai (o gira sul modello vero o si salta).

### `--remote`

Pipeline **completamente reale**: clone dal provider vero e apertura di una
**PR vera**. Guidata da env, da lanciare consapevolmente:

```bash
SMOKE_DATABASE_URL=postgres://… \
SMOKE_ENCRYPTION_KEY=<base64 32B, la stessa del server> \
SMOKE_PROJECT_SLUG=<slug di un progetto esistente nel DB> \
SMOKE_TICKET_NUMBER=<opz. numero di un ticket esistente> \
pnpm --filter @stubwise/worker smoke -- --remote
```

Se `SMOKE_TICKET_NUMBER` è assente, lo smoke crea un ticket di prova
(personalizzabile con `SMOKE_TICKET_TITLE`/`SMOKE_TICKET_BODY`). Usa il
provider reale (`getProvider`): apre una PR sul repo del progetto.

Flag comune: `--keep` non rimuove tmpdir/container a fine run.

## Prompt tuning notes

I prompt della pipeline vivono in `src/pipeline/prompts.ts`
(`buildTriagePrompt`, `buildFixPrompt`). Sono in **inglese** deliberatamente
(i modelli seguono meglio i vincoli sul formato di output); il report di fix è
richiesto in italiano. Annotare **qui** ogni aggiustamento emerso dai run
reali, con la data e il sintomo che l'ha motivato.

- _(2026-06)_ Smoke `--local` portato a termine come **harness**: testcontainers
  Postgres + fixture buggy + claim del job + invocazione del `ClaudeCliRunner`
  reale, tutto verificato. Nell'ambiente di sviluppo usato l'auth headless del
  CLI **non sopravvive all'allowlist dell'env del runner** (risposta
  `Not logged in`), quindi il run sul modello vero non è stato eseguito e lo
  smoke ha **saltato** (exit 0, come da contratto). **Nessun** aggiustamento al
  prompt è quindi ancora stato validato su un fix reale end-to-end: aggiornare
  questa sezione dopo il primo run con `claude` autenticato (vedi "Auth del CLI
  claude" sopra).
