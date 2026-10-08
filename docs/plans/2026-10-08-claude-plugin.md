# Plugin Claude Code «stubwise» — piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** skill, comandi e server MCP di Stubwise distribuiti come plugin Claude Code `stubwise` da un marketplace nel repo, con il server MCP che avvisa quando il plugin è vecchio, assente o affiancato da una copia a mano.

**Architecture:** marketplace `.claude-plugin/marketplace.json` alla radice, plugin in `plugins/stubwise/` come pacchetto privato del workspace (`@stubwise/claude-plugin`) versionato da Changesets. Uno script lanciato subito dopo `changeset version` copia la versione del pacchetto in `plugin.json`, nell'`env` del `.mcp.json` del plugin e in una costante di `@stubwise/mcp`; un test fallisce se le quattro divergono. Il server MCP calcola gli avvisi all'avvio e li aggiunge una volta sola alla prima risposta di un tool.

**Tech Stack:** Claude Code 2.1.294 (plugin/marketplace), Changesets 2.31, pnpm workspace, TypeScript + Vitest (`@stubwise/mcp`), Node ≥ 22 (script `.mjs`), Starlight (guida).

Design: `docs/plans/2026-10-08-claude-plugin-design.md`.

---

## 0. Correzioni alle premesse del design (verificate l'8 ott 2026)

Verifiche fatte con un marketplace locale di prova (`stubwise-probe`, installato, provato con `claude -p` e rimosso), la documentazione ufficiale (code.claude.com/docs, pagine *Install and manage plugins*, *Plugin loading reference*, *Plugin manifest reference*, *Plugin commands reference*, *Marketplace reference*, *Settings reference*) e il codice di `@changesets/config@3.1.4`.

**Confermato:**

- Struttura: `.claude-plugin/plugin.json`, `skills/<nome>/SKILL.md`, `commands/*.md`, `.mcp.json` alla radice del plugin. `claude plugin details` mostra skill, comandi (come skill) e il server MCP.
- Namespace: i comandi compaiono come `/<nome plugin>:<file>` (provato: `/stubwise-probe:init`, `:run`, `:start`), quindi con il plugin chiamato `stubwise` restano `/stubwise:init`, `/stubwise:run`, `/stubwise:start`. La skill diventa `stubwise:stubwise`.
- `${VAR}` d'ambiente nel `.mcp.json` del plugin si espandono, anche da `env` dei settings (provato con `--settings`), e un valore fisso nell'`env` (`STUBWISE_PLUGIN_VERSION`) arriva al processo così com'è. Arriva anche `CLAUDE_PLUGIN_ROOT`.
- Changesets: i pacchetti privati sono **già versionati** in questo repo (default del codice `privatePackages = { version: true, tag: false }`; ne sono la prova i CHANGELOG di `apps/mobile`, `packages/notifications`…), e `changeset publish` non li pubblica. Nessuna modifica a `.changeset/config.json`. ⚠️ La pagina ufficiale `config-file-options.md` dice il contrario («by default… will not version»): vale il codice.

**Corretto:**

1. **Una `${VAR}` NON impostata arriva LETTERALE** (`"${STUBWISE_TOKEN}"`), non vuota (provato). Con il `.mcp.json` di oggi un utente senza `STUBWISE_URL` riceve `"${STUBWISE_URL}"` e il server muore con «STUBWISE_URL non è un URL valido». Nel plugin si usa `${VAR:-}` (provato: arriva `""`), e `loadConfig` tratta comunque un valore `${…}` letterale come assente (difesa per i `.mcp.json` a mano).
2. **`/plugin update` non esiste dentro una sessione** (`update` non ha forma di sessione, *Plugin commands reference*). Avviso e guida usano il terminale: `claude plugin marketplace update stubwise` poi `claude plugin update stubwise@stubwise`, poi riavvio; in sessione l'equivalente documentato è `/plugin` → Marketplaces → stubwise → **Update marketplace** (aggiorna anche i plugin installati da lì).
3. **Aggiornamento automatico: ESISTE ed è documentato**, ma è spento di default per i marketplace di terze parti. Si accende da `/plugin` → Marketplaces → stubwise → **Enable auto-update**, oppure con `"autoUpdate": true` sulla voce `extraKnownMarketplaces.stubwise` dei settings. Gira dopo il primo messaggio di una sessione interattiva, con un ritardo casuale fino a 10', e rileva un aggiornamento solo se cambia la `version` del manifest (la nostra la alza Changesets). `DISABLE_AUTOUPDATER`/`DISABLE_UPDATES`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` lo spengono (salvo `FORCE_AUTOUPDATE_PLUGINS=1`). **Non provato da noi** (richiede la UI interattiva e un'attesa): la guida lo presenta come documentato, e l'avviso del server MCP resta la rete di sicurezza.
4. **`--sparse`** vale solo per sorgenti `github`/`git` (`sparsePaths` nella voce del marketplace); con un percorso locale non si applica e non c'è clone. Senza `--sparse` si clona il repo intero (non documentato se il clone è shallow). Non documentato se `/plugin marketplace add` **dentro una sessione** accetti `--sparse`: la guida usa il terminale per l'installazione e lo segnala. Provato a fine lavoro dal branch pubblicato (Task 12).
5. **L'avviso «plugin vecchio» funziona solo se `@stubwise/mcp` viene ripubblicato a ogni versione del plugin** (la costante è compilata dentro). Il controllo CI chiede quindi che il changeset che tocca il plugin nomini ANCHE `@stubwise/mcp`.
6. **I nomi dei tool cambiano** da `mcp__stubwise__*` a `mcp__plugin_stubwise_stubwise__*` (forma documentata `mcp__plugin_<plugin>_<server>__*`): chi ha regole di permesso per nome va avvisato in guida.
7. **La vecchia guida faceva copiare anche i comandi** in `~/.claude/commands/stubwise/`: quei file producono anch'essi `/stubwise:init`… e si scontrano col plugin. L'avviso «copia a mano» copre anche quella cartella (allargamento del §4).
8. **Chi ha configurato il server con `claude mcp add --scope user -e STUBWISE_TOKEN=…`** (il metodo principale della guida di oggi) non ha la variabile nell'ambiente: col plugin deve esportarla nella shell o metterla in `env` di `~/.claude/settings.json`. La guida lo dice.
9. `claude plugin validate --strict` del marketplace richiede una `description` (provato).

**Domande aperte per il maintainer** (non bloccanti):

- **A.** Auto-update: verificare dalla UI che il toggle «Enable auto-update» compaia per `stubwise` e che, alzata una versione, il plugin si aggiorni da solo.
- **B.** `/plugin marketplace add Aleloca/stubwise --sparse .claude-plugin plugins` dentro una sessione: accetta `--sparse`?
- **C.** `userConfig` del manifest (`sensitive: true`, nel portachiavi) permetterebbe di chiedere token e URL all'installazione invece di variabili d'ambiente. Non adottato (il design dice «stesse variabili di oggi», e cambierebbe la migrazione); da valutare come passo successivo.
- **D.** Per gli sviluppatori di QUESTO repo si potrebbe committare `.claude/settings.json` con `extraKnownMarketplaces.stubwise` (`autoUpdate: true`) ed `enabledPlugins`, così il plugin arriva da solo. Non fatto: tocca anche le sessioni della cartella di deploy.

---

## Decisioni di implementazione

- Pacchetto del plugin: `@stubwise/claude-plugin`, `private: true`, versione iniziale `0.0.0`; il changeset `minor` lo porta a `0.1.0` alla prima PR di versioning. Nessuna `dependencies` (Claude Code installerebbe pacchetti se trovasse anche un lockfile nel plugin).
- Fonte unica della versione: `plugins/stubwise/package.json`. Copie: `plugins/stubwise/.claude-plugin/plugin.json` (`version`), `plugins/stubwise/.mcp.json` (`env.STUBWISE_PLUGIN_VERSION`), `packages/mcp/src/plugin-version.ts` (`LATEST_PLUGIN_VERSION`, file generato e committato). La voce del marketplace NON porta `version` (vince il manifest).
- Script in `packages/mcp/scripts/` (`.mjs`, testati dalla vitest di `@stubwise/mcp`; non pubblicati: `files` è solo `dist`).
- Root: script `version-packages` = `changeset version && node packages/mcp/scripts/sync-plugin-version.mjs`; `release.yml` usa `version: pnpm version-packages`. Changesets non esegue gli script `version` dei pacchetti.
- CI: passo «Plugin Claude Code» nel job `check` (su PR e su main): controllo changeset (solo PR), test di parità, `claude plugin validate --strict` di plugin e marketplace (CLI fissato `@anthropic-ai/claude-code@2.1.294`). `plugins/` entra nel filtro dei pacchetti dei test (il passo dedicato copre il plugin, non serve rilanciare tutta la suite).
- Avvisi: testo in italiano come gli altri messaggi dei tool, prefisso «Nota Stubwise per l'utente», aggiunti come blocco di testo in più alla prima risposta (anche se è un errore; `isError` non cambia). Una volta per processo = una volta per sessione (stdio).

---

### Task 1: pacchetto del plugin, marketplace, workspace

**Files:**
- Create: `.claude-plugin/marketplace.json`, `plugins/stubwise/package.json`, `plugins/stubwise/.claude-plugin/plugin.json`, `plugins/stubwise/.mcp.json`
- Modify: `pnpm-workspace.yaml` (aggiunge `plugins/*`), `pnpm-lock.yaml` (via `pnpm install`)

marketplace.json: `name: "stubwise"`, `owner`, `description`, un plugin `{ "name": "stubwise", "source": "./plugins/stubwise", "description": … }`.
plugin.json: `name: "stubwise"`, `version: "0.0.0"`, `description`, `author`, `homepage` (guida), `repository`, `license: "MIT"`, `keywords`.
.mcp.json: server `stubwise`, `npx -y @stubwise/mcp`, env `STUBWISE_TOKEN: "${STUBWISE_TOKEN:-}"`, `STUBWISE_URL: "${STUBWISE_URL:-}"`, `STUBWISE_PLUGIN_VERSION: "0.0.0"`.

Verifica: `claude plugin validate --strict plugins/stubwise` e `claude plugin validate --strict .` → passed; `pnpm install` aggiorna il lockfile. Commit.

### Task 2: spostare skill e comandi

`git mv .claude/skills/stubwise plugins/stubwise/skills/stubwise`, `git mv .claude/commands/stubwise plugins/stubwise/commands` (i tre file). Nei testi: i riferimenti a `.claude/skills/stubwise` e alla copia a mano diventano il plugin. Validate di nuovo. Commit.

### Task 3: `.mcp.json` del repo

Togliere la voce `stubwise` (resta `graphify`). Commit.

### Task 4: costante e sincronizzazione della versione (TDD)

**Files:** Create `packages/mcp/scripts/plugin-version.mjs` (funzioni pure: `readPluginVersion(root)`, `syncPluginVersion(root)` che riscrive plugin.json, `.mcp.json` e `packages/mcp/src/plugin-version.ts` e ritorna i file cambiati), `packages/mcp/scripts/sync-plugin-version.mjs` (CLI), `packages/mcp/src/plugin-version.ts`; Test `packages/mcp/scripts/plugin-version.test.ts` (su una radice finta in tmp: dopo `syncPluginVersion` le tre copie valgono la versione del package.json; seconda esecuzione → nessun file cambiato), `packages/mcp/src/plugin-version.test.ts` (PARITÀ sul repo vero: package.json del plugin = plugin.json = env del .mcp.json = `LATEST_PLUGIN_VERSION`; nessuna `version` nella voce del marketplace).

Passi: test rosso → implementazione → verde → mutazione (cambiare a mano `plugin.json`) → parità rossa → ripristino. Root `package.json`: script `version-packages`. Commit.

### Task 5: avvisi del server MCP (TDD)

**Files:** Create `packages/mcp/src/notices.ts`, `packages/mcp/src/notices.test.ts`; Modify `packages/mcp/src/tools/types.ts` (campo opzionale `notice?: SessionNotice`), `tools/read.ts` e `tools/write.ts` (registrazione: `withNotice(def.handler(args, ctx), ctx.notice)`), `server.ts`, `index.ts`, `config.ts` (+ test: `${…}` letterale = assente).

API:
```ts
export function compareVersions(a: string, b: string): number | null; // null = non confrontabili
export function normalizeEnvValue(v: string | undefined): string | undefined; // "", "${…}" → undefined
export interface NoticeInputs { pluginVersion: string | undefined; latest: string; manualCopies: string[] }
export function buildNotices(i: NoticeInputs): string[];
export function findManualCopies(claudeDir: string, exists?: (p: string) => boolean): string[];
export function claudeConfigDir(env, home): string; // CLAUDE_CONFIG_DIR o ~/.claude
export class SessionNotice { constructor(text: string | null); take(): string | null }
export function appendNotice(result: ToolResult, notice?: SessionNotice): ToolResult;
```
Test: plugin più vecchio → avviso con «x → y» e i due comandi esatti; uguale o più nuovo → nulla; versione assente → avviso d'installazione; versione non confrontabile → nulla (mai un falso allarme); copia a mano della skill e/o dei comandi → avviso con i percorsi; `SessionNotice.take()` restituisce il testo una sola volta; `appendNotice` aggiunge un blocco e non tocca `isError`; integrazione: due chiamate a un tool registrato su `McpServer` (via `buildServer` con notice) → l'avviso solo nella prima. Mutazioni: togliere il «una volta sola» → rosso; invertire il confronto → rosso. Commit.

### Task 6: controllo CI del changeset (TDD)

**Files:** Create `packages/mcp/scripts/plugin-changeset.mjs` (pura: `checkPluginChangeset({ changedFiles, changesets, pluginVersionChanged })` → `{ ok, message }`; `parseChangesetPackages(md)`), `packages/mcp/scripts/check-plugin-changeset.mjs` (CLI: `git diff --name-only BASE...HEAD`, legge i changeset aggiunti/modificati, confronta la `version` del package.json del plugin fra base e HEAD), test `packages/mcp/scripts/plugin-changeset.test.ts`.

Regola: se cambia un file in `plugins/stubwise/` (escluso `CHANGELOG.md`) serve (a) la versione del plugin alzata nella PR (la PR di versioning), oppure (b) un changeset della PR che nomini **sia** `@stubwise/claude-plugin` **sia** `@stubwise/mcp`. Test: niente plugin toccato → ok; plugin toccato senza changeset → ko; changeset col solo plugin → ko (dice di aggiungere mcp); entrambi → ok; versione alzata → ok; solo CHANGELOG → ok. Mutazione: togliere il requisito su mcp → rosso. Commit.

### Task 7: workflow

`ci.yml`: passo «Plugin Claude Code» dopo Build (controllo changeset solo su PR, test di parità, validate strict ×2 con `npx -y @anthropic-ai/claude-code@2.1.294`); `plugins/` nel filtro `^(apps|packages|plugins)/`. `release.yml`: `version: pnpm version-packages`. Commit.

### Task 8: changeset

`.changeset/claude-plugin.md`: `"@stubwise/claude-plugin": minor`, `"@stubwise/mcp": minor`. Commit.

### Task 9: guida utente

`apps/docs/src/content/docs/integrations/claude-code-mcp.md`: installazione col plugin (marketplace + install da terminale, alternativa in sessione), token via shell o `env` dei settings, aggiornamento (comandi, auto-update documentato, avviso del server), sezione «If you used the manual setup» (togliere la voce `stubwise` da `.mcp.json`/`claude mcp remove stubwise`, cancellare `~/.claude/skills/stubwise/` e `~/.claude/commands/stubwise/`, permessi per nome dei tool). Build della guida. Commit.

### Task 10: CLAUDE.md

Sezione «Integrazione Claude Code (MCP)»: il plugin, dove vive, come si rilascia (PR di versioning), avvisi, invarianti (versione in 4 punti, `${VAR:-}`, mcp nel changeset). Le voci delle fasi passate restano; si aggiunge una riga che dal plugin in poi «ricopiare la skill» = «mergiare la PR di versioning». Commit.

### Task 11: verifica complessiva

Dalla radice: `pnpm build`, `pnpm typecheck`, `pnpm lint`, test di `@stubwise/mcp`, build di `apps/docs`, validate strict ×2. Esiti catturati prima di eventuali pipe.

### Task 12: prova reale e PR

Marketplace dal path del worktree con nome di prova, install, `claude plugin details`; poi, pubblicato il branch, prova `--sparse` da GitHub (`Aleloca/stubwise#feat/claude-plugin`) con nome di prova. Pulizia: uninstall, marketplace remove, cache, verifica che `claude plugin list`/`marketplace list` e `~/.claude/settings.json` siano come prima. Push e PR.
