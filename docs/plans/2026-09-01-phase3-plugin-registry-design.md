---
title: Fase 3 — Registro plugin/skill
date: 2026-09-01
status: validato (brainstorming)
program: 2026-08-31-stubwise-nerve-center-program-design.md
stubwise:
  project: stubwise
  backlogItem: bf9c532a-0327-43c1-aa78-dc6db00e4faf # https://stubwise.thecove.it/backlog/bf9c532a-0327-43c1-aa78-dc6db00e4faf
  ticket: d4710fa7-fe76-4fbc-8010-451638ea2d5d # https://stubwise.thecove.it/tickets/d4710fa7-fe76-4fbc-8010-451638ea2d5d
---

# Fase 3 — Registro plugin/skill

Quarta fase del programma "centro nevralgico". Un registro d'istanza di plugin
Claude Code (repo git pubblico + ref pinnato a commit) materializzati su un
volume del worker, abilitati per progetto con toggle sulle singole skill e sugli
hook, passati ai run con `--plugin-dir`; un plugin base Stubwise bundlato
nell'immagine che inietta il "contratto della run" via hook SessionStart; smoke
run automatico e scenari golden manuali.

## 1. Stato di partenza (fatti verificati)

### CLI (claude 2.1.252, prove in `-p`)

- `--plugin-dir <path|zip>` è ripetibile, session-scoped, ortogonale ai
  settings; **funziona in `-p`** (verificato con controllo negativo): le skill
  del plugin compaiono namespaced col `name` di `plugin.json`
  (`superpowers:brainstorming`). Carica skill, commands, agents, hooks e
  l'eventuale `.mcp.json` del plugin.
- **Gli hook di plugin scattano in `-p` senza approvazione**, coi permessi del
  processo CLI; il SessionStart di superpowers inietta ~1,4k token (l'intero
  `using-superpowers/SKILL.md`) a ogni run, oltre a ~1,2k always-on.
- **Nessuna disabilitazione nativa per singola skill di plugin**:
  `skillOverrides` è cortocircuitato per `source === "plugin"` (verificato in
  entrambe le direzioni); la deny rule `Skill(<plugin>:<skill>)` in
  `--disallowedTools` blocca l'esecuzione ma lascia la skill in elenco.
- `claude plugin details` è solo testo e solo per plugin installati nel
  registro del CLI; `claude plugin validate <path> --strict` valida una
  directory; `claude plugin list --json` non include l'inventario.
- `--setting-sources` (`user,project,local`, default tutti in `-p`): `""` toglie
  plugin utente, `.claude/skills` e `.mcp.json` della cwd. Flag non
  documentato `--plugin-dir-no-mcp` esiste ma non lo usiamo.
- Anatomia plugin: `.claude-plugin/plugin.json`, `skills/<n>/SKILL.md`
  (frontmatter name/description), `commands/*.md`, `agents/*.md`,
  `hooks/hooks.json` (`{hooks: {Evento: [{matcher, hooks:[{type:"command",
  command}]}]}}`, `${CLAUDE_PLUGIN_ROOT}`), opzionale `.mcp.json`. Pinning
  nativo: cartella-versione + `gitCommitSha` + `.git` nel plugin.

### Repo

- Runner (`apps/worker/src/agent/{runner,claude-cli}.ts`): opzioni
  `mcpConfig` (file temporaneo fuori dalla cwd + `--strict-mcp-config`),
  `allowedTools`, `permissionMode`, `resumeSessionId`; **nessun**
  `--plugin-dir`/`--setting-sources`/`--disallowedTools`. Env allowlist
  (`claude-cli.ts:80-176`). 27 call site; quelli del fix in `pipeline/fix.ts`
  (plan :1259, plan resume :1199, execute :1469, repair :1618) con "opt"
  precalcolate (`providerOpt`, `askUserOpt`, `planAllowedToolsOpt`).
- **Nei run multi-repo la cwd è la parent dir** (`withProjectWorktrees`): il
  `.claude/` dei repo target non viene caricato oggi (documentato in
  `graph/setup-pr.ts`). `--setting-sources ""` non toglie quindi nulla.
- Prompt: `buildFixPlanPrompt` "Rules" (`prompts.ts:621-626`: read-only,
  sezione decisioni obbligatoria), `buildFixExecutePrompt` "Rules"
  (`:718-721`: NON committare/pushare, `STUBWISE_REPORT.md` obbligatorio).
- Dockerfile worker: dist via `pnpm deploy` in `/app`; dir dei volumi create
  con `chown worker` PRIMA di `USER worker` (`/var/stubwise/mirrors`,
  `/graphs`, `/home/worker/.claude`); server MCP ask_user risolto relativo al
  modulo (`ask-user.ts:73-75`). Compose: volumi `mirrors`, `claude-config`,
  `graphs` (rw worker, `:ro` server).
- Git: `MirrorManager` è vincolato ai mirror di progetto e passa sempre
  l'auth; `runGit` è privata. Nessun helper di clone riusabile.
- Precedenti: `ai_providers` + credential tester (test asincrono richiesto
  dalla UI, `testStatus` pending/passed/failed, polling 2 s);
  `repo_graphs`+`graph_jobs` (materializzazione asincrona con coda, indice
  unico parziale attivo, `GRAPH_POLL_SECONDS`); sezione Server nella pagina
  progetto (non-suspense, degradabile). Ultima migrazione: 0065.

## 2. Perimetro

- **Run con plugin**: pianificazione ed esecuzione del fix (plan, continue,
  execute, self-repair), deep dive e sessione di analisi del backlog.
- **Esclusi**: triage, intake/stima, docs, review PR, daily report, test
  credenziali (formato stretto: token always-on e hook sono rumore).
- I run con plugin passano `--setting-sources ""` (set caricato = base +
  registro, deterministico) e già `--strict-mcp-config`.

## 3. Plugin base Stubwise

`apps/worker/plugins/stubwise-base/` copiato nell'immagine (`/app/plugins/
stubwise-base`, path risolto relativo al modulo come ask_user), passato **per
primo** in ogni run con plugin, mai filtrato.

- **`hooks/hooks.json` SessionStart** (matcher `startup|resume|compact`) →
  script che stampa `additionalContext` col **contratto della run**:
  worktree/branch/PR li
  gestisce Stubwise; niente commit/push; `STUBWISE_REPORT.md` è il body della
  PR; in pianificazione read-only con sezione "Decisioni e assunzioni"; le
  domande passano SOLO da `ask_user` (se presente); adattamenti espliciti:
  "`superpowers:brainstorming` → le sue domande via `ask_user`;
  `superpowers:using-git-worktrees`, `finishing-a-development-branch`,
  `dispatching-parallel-agents`, `subagent-driven-development` NON si
  applicano". Contratto breve (< 400 token). Le regole restano anche nei prompt
  (cintura e bretelle); lo snellimento dei prompt è una fase successiva.
  **Emendamento 1 set 2026 (approvato dall'utente, in implementazione)**: al
  matcher si aggiunge `compact`, che nel design validato non c'era. Motivo: i
  run di esecuzione lunghi auto-compattano, e dopo la compaction sia il prompt
  sia l'`additionalContext` originale sopravvivono solo diluiti nel riassunto —
  proprio nei run dove le skill di terze parti spingono di più a committare.
  `SessionStart` con source `compact` esiste per re-iniettare contesto; il
  costo è una re-iniezione da ~370 token per compaction, trascurabile rispetto
  al rischio che le regole su git sbiadiscano a metà di un run costoso.
  **Emendamento 1 set 2026 (revisione del Task 3)**: il contratto NON impone la
  forma del deliverable. Lo stesso hook entra anche nei run di backlog (deep
  dive, chat di raffinamento), dove il deliverable è l'analisi o la risposta:
  valgono sempre le regole su git e su `ask_user`, mentre forma e sezioni del
  deliverable le decide il prompt (nel contratto: "Read-only runs (planning,
  analysis)" e "your prompt decides the deliverable"). Per lo stesso motivo la
  skill `stubwise-conventions` non elenca nomi di sezione propri: deferisce a
  quelli che il prompt nomina (che sui run localizzati sono in italiano).
- **Skill** `stubwise-conventions` (una sola in v1): convenzioni di piano e
  report; delega a `writing-plans` se disponibile.

## 4. Registro: dati, materializzazione, inventario, aggiornamento, smoke

**Migrazione 0066**:
- `plugins`: `id`, `slug` (unique), `name`, `sourceUrl` (https pubblico),
  `sourceSubdir?`, `ref`, `resolvedSha?`, `status` `none|materializing|ready|
  failed`, `inventory` jsonb?, `error?`, `smokeStatus` `idle|pending|passed|
  failed`, `smokeError?`, `materializedAt?`, `createdAt`, `updatedAt`.
- `plugin_jobs`: `id`, `pluginId` (cascade), `kind` `materialize|smoke`,
  `status` `queued|running|done|failed`, `attempts`, `error`, `claimedAt`,
  `createdAt`; unique parziale `(plugin_id, kind) WHERE status IN
  ('queued','running')`.
- `project_plugins`: PK `(projectId, pluginId)` (cascade), `enabled`,
  `disabledSkills text[]`, `disabledHooks text[]` (chiave `<Evento>#<indice>`),
  `createdAt`, `updatedAt`.

**Volume `claude-plugins`** montato in `/plugins` (rw worker; il server NON lo
monta: legge `inventory` dal DB). Dir per plugin: `/plugins/<slug>/<sha>/`.

**Materializzazione** (poller worker `PLUGIN_POLL_SECONDS`, default 20;
helper git dedicato senza auth, `GIT_TERMINAL_PROMPT=0`): `git init` +
`fetch <url> <ref>` + `checkout <sha>` (sha risolto dal fetch), opzionale
`sourceSubdir` → la dir del plugin è la sottocartella; rimozione di `.git`;
`claude plugin validate <dir> --strict` (fallisce → `failed` con output);
**inventario** costruito dal worker: `plugin.json` (name, version,
description), `skills[]` (`name`, `description`, `bytes`), `commands[]`,
`agents[]`, `hooks[]` (`event`, `matcher`, `command`, chiave), `hasMcp`.
Al `ready`: `resolvedSha`, `inventory`, `materializedAt`; accodato il job
`smoke`.

**Aggiornamento** = azione "aggiorna a `<ref>`": job `materialize` in nuova
dir sha; al `ready` il registro punta al nuovo sha, la UI mostra il diff
dell'inventario (skill/hook aggiunti/rimossi/cambiati), le dir degli sha
vecchi vengono rimosse, le `disabledSkills`/`disabledHooks` dei progetti che
citano voci sparite vengono potate (log).

**Smoke run** (job `smoke`, pattern credential tester): run `haiku`, `maxTurns
1`, `--setting-sources ""`, `--plugin-dir` base + plugin integrale, prompt
"elenca i nomi delle skill disponibili"; `passed` se compaiono tutte le skill
dell'inventario col namespace atteso ed exit 0; altrimenti `failed` con
l'output. Riprovabile dalla UI. Abilitare un plugin con smoke `failed` è
consentito ma sconsigliato (badge).

## 5. Come i plugin entrano nei run

- Runner: `pluginDirs?: string[]` → `--plugin-dir` ripetuto;
  `disallowedTools?: string[]` → `--disallowedTools`; `settingSources?: ""`
  → `--setting-sources ""`. Nessun cambiamento per i run che non li passano.
- **Copia filtrata per run** (`apps/worker/src/plugins/materialize-run.ts`):
  per ogni plugin `ready` e abilitato sul progetto, copia nella dir temporanea
  del run (fuori dalla cwd) **senza** le dir delle skill spente, **senza** i
  gruppi di hook spenti (riscrivendo `hooks/hooks.json`), **senza `.mcp.json`**;
  le skill spente vanno anche in `disallowedTools` come `Skill(<plugin>:<skill>)`.
  Prima della copia il worker rilegge `plugin.json` e confronta lo sha/dir con
  il registro: mismatch → plugin saltato per quel run (log), il run procede.
- Ordine: base per primo, poi i plugin del progetto per `slug`.
- La copia sparisce con la dir del run; costo: centinaia di KB.

## 6. Sicurezza

Solo admin su registro e abilitazioni; solo `https://` pubblici (niente
credenziali); pin a sha, mai `pull` implicito; hook **mostrati col comando** e
spegnibili uno per uno; `.mcp.json` dei plugin ignorato per costruzione; il
canale MCP resta `--mcp-config` + `--strict-mcp-config`; validazione
`--strict` obbligatoria; env del child CLI invariata (allowlist senza segreti).
**Raccomandazioni per plugin noti** (`apps/worker/src/plugins/recommendations.ts`,
chiave = `plugin.json.name`): per `superpowers` preset che spegne
`using-git-worktrees`, `finishing-a-development-branch`,
`dispatching-parallel-agents`, `subagent-driven-development`; la UI le propone
come preset all'abilitazione (non le impone). Costo mostrato in KB per
skill/hook (niente stima token).

## 7. Superfici

- **Impostazioni → Plugin** (admin, voce nuova in `SETTINGS_NAV`, pattern
  sezione provider AI): lista con badge (`materializing` polling 2 s, `ready`,
  `failed`+errore, smoke), form "Aggiungi" (URL, ref, subdir), inventario
  espandibile (skill con descrizione e KB; comandi; agenti; hook con evento e
  comando; `.mcp.json` "presente, ignorato"), azioni **Aggiorna a ref…** (diff
  al `ready`), **Riprova smoke**, **Rimuovi** (409 se abilitato su qualche
  progetto).
- **Pagina progetto → sezione "Plugin"** (admin; pattern sezione Server): per
  ogni plugin `ready` interruttore "abilitato" + checkbox skill e hook;
  "Applica preset consigliato" se esistono raccomandazioni; salvataggio
  immediato con PUT dell'insieme completo.
- API (tutte `requireAdmin`): `GET/POST /api/plugins`, `GET /api/plugins/:id`,
  `POST /:id/update {ref}`, `POST /:id/smoke`, `DELETE /:id`;
  `GET/PUT /api/projects/:id/plugins`. Schemi in `packages/shared`.

## 8. Scenari golden (manuali)

`pnpm --filter @stubwise/worker golden` (`apps/worker/scripts/golden/`), su un
repo fixture locale, col CLI reale: (1) plan-only con superpowers → sezione
decisioni presente, nessun file toccato, nessun tentativo di worktree/branch
(dai tool usati nel log); (2) bivio materiale → `ask_user` chiamato (file
scritto), nessuna domanda in chiaro; (3) execute → nessun `git commit/push`,
`STUBWISE_REPORT.md` prodotto. Output JSON per scenario. Documentato in
CLAUDE.md come passo manuale quando si aggiorna un plugin o un prompt. Non in
CI.

## 9. Test automatici

Parser dell'inventario su fixture (anomalie incluse); materializzazione (git a
sha, dir per sha, rimozione `.git`, validate fallito → `failed`, aggiornamento
e potatura); copia filtrata (skill/hook/`.mcp.json` esclusi; deny rule);
runner (flag nuovi); smoke job con runner fake; servizi/rotte CRUD e
abilitazioni (409 su rimozione); poller; UI (lista, inventario, preset,
sezione progetto). Nessun test lancia il CLI vero.

## 10. Config, deploy, rollback

`PLUGIN_POLL_SECONDS` (20, 0 = off). Migrazione 0066; volume `claude-plugins`
(Dockerfile: `mkdir -p /plugins && chown worker` prima di `USER`; `ENV
PLUGINS_DIR=/plugins`; compose: `claude-plugins:/plugins` sul worker);
rebuild server+worker+caddy insieme; nessun passo manuale. Rollback:
`PLUGIN_POLL_SECONDS=0` ferma le materializzazioni; senza plugin `ready` le
abilitazioni non hanno effetto; i run con plugin degradano a "nessun plugin"
se la dir manca.

## 11. Fuori scopo (v2+)

Repo privati/credenziali; marketplace remoti; plugin con `.mcp.json` caricati;
stima token; snellimento dei prompt in favore del contratto; plugin nei run di
review/docs; golden in CI.
