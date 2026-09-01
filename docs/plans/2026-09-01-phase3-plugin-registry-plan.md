---
title: Fase 3 — Registro plugin/skill — Piano di implementazione
date: 2026-09-01
design: 2026-09-01-phase3-plugin-registry-design.md
stubwise:
  project: stubwise
  backlogItem: bf9c532a-0327-43c1-aa78-dc6db00e4faf # https://stubwise.thecove.it/backlog/bf9c532a-0327-43c1-aa78-dc6db00e4faf
  ticket: d4710fa7-fe76-4fbc-8010-451638ea2d5d # https://stubwise.thecove.it/tickets/d4710fa7-fe76-4fbc-8010-451638ea2d5d
---

# Fase 3 — Registro plugin/skill — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Registro d'istanza di plugin Claude Code pinnati a commit e materializzati su un volume del worker; abilitazione per progetto con toggle su skill e hook; plugin base Stubwise (contratto della run via hook SessionStart) bundlato nell'immagine; i run di fix/deep dive/chat ricevono `--plugin-dir` con copie filtrate; smoke run automatico; scenari golden manuali.

**Architecture:** Il worker materializza (git a sha, validate, inventario) e serve i plugin ai run; il server espone registro e abilitazioni (solo admin) e legge l'inventario dal DB. Per ogni run il worker costruisce copie filtrate dei plugin abilitati (senza skill/hook spenti e senza `.mcp.json`) nella dir temporanea del run e passa `--plugin-dir` (base per primo) + `--setting-sources ""` + `--disallowedTools Skill(...)`. Design: `docs/plans/2026-09-01-phase3-plugin-registry-design.md` (**LEGGILO PRIMA**: §1 contiene i fatti verificati sul CLI che vincolano le scelte).

**Tech Stack:** come fasi precedenti; git via `execa` (helper dedicato, senza auth); `claude plugin validate`.

**Convenzioni trasversali (identiche alle fasi precedenti):** TDD; test filtrati con `pnpm --filter @stubwise/<pkg> exec vitest run <pattern>`; ribuilda i `packages/*` toccati; commit `feat(scope):` in italiano; `pnpm lint` + `pnpm typecheck` + `pnpm test` prima del merge; commenti in italiano; worktree dedicato; parità i18n; **lanciare `/stubwise:start` PRIMA del Task 1** (ticket + in_progress). Nessun test deve lanciare il CLI `claude` vero: il runner è sempre `FakeAgentRunner` nei test.

---

## Fase A — Dati e plugin base

### Task 1: Migrazione 0066 (`plugins`, `plugin_jobs`, `project_plugins`)

**Files:** Create `packages/db/drizzle/0066_plugin_registry.sql` (+ journal); Modify `packages/db/src/schema.ts`; Test `packages/db/src/plugins-schema.test.ts`.

Tabelle come da design §4 (enum compile-time via `text({enum})` come `repo_graphs`, non enum Postgres — evita la trappola del batch): `plugins` (slug unique, status default `none`, smokeStatus default `idle`, `inventory jsonb` `$type<PluginInventory>` — tipo dichiarato in `packages/shared/src/schemas/plugin.ts`, vedi Task 2), `plugin_jobs` (unique parziale `(plugin_id, kind) WHERE status IN ('queued','running')`, indice parziale `queued`), `project_plugins` (PK composta, `disabled_skills text[] default '{}'`, `disabled_hooks text[] default '{}'`). Test: default, unique parziale (23505), cascate. Commit `feat(db): migrazione 0066 — registro plugin`.

### Task 2: Schemi condivisi dell'inventario e delle API

**Files:** Create `packages/shared/src/schemas/plugin.ts` (`pluginInventorySchema`: `{ name, version?, description?, skills: [{name, description?, bytes}], commands: [{name}], agents: [{name}], hooks: [{key, event, matcher?, command}], hasMcp }`; `pluginSchema` (proiezione pubblica), `createPluginSchema` (`sourceUrl` https, `ref` 1..200, `sourceSubdir?` senza `..`), `updatePluginRefSchema`, `projectPluginSchema` (`pluginId, enabled, disabledSkills, disabledHooks`), `putProjectPluginsSchema`); esporta dal barrel. Test di validazione (URL non https rifiutato, subdir con `..` rifiutata). Commit `feat(shared): schemi del registro plugin`.

### Task 3: Plugin base Stubwise

**Files:** Create `apps/worker/plugins/stubwise-base/.claude-plugin/plugin.json` (`name: "stubwise-base"`), `hooks/hooks.json` (SessionStart, matcher `startup|resume|compact` — vedi l'emendamento nel design §3, command `"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh"`), `hooks/session-start.sh` (0755, POSIX sh: legge stdin e stampa `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<contratto>"}}` — contratto in inglese, < 400 token, testo dal design §3; JSON costruito con escaping sicuro, es. tramite `node -e` se disponibile o here-doc con contenuto senza virgolette), `skills/stubwise-conventions/SKILL.md` (frontmatter + convenzioni piano/report; "se `superpowers:writing-plans` è disponibile usala per la struttura del piano, ma l'output resta il messaggio finale"); Modify `apps/worker/Dockerfile` (COPY della dir in `/app/plugins/stubwise-base` con chown; verificare che `pnpm deploy` non la scarti: copiala esplicitamente nello stadio runtime), `apps/worker/package.json` (`files`/script se serve); Create `apps/worker/src/plugins/base.ts` (`basePluginPath()` risolto relativo al modulo come `askUserServerPath`, con `existsSync` → `null` in dev). Test: `session-start.sh` eseguito con `sh` produce JSON valido con il contratto (test node che spawna lo script); `plugin.json` valido; `basePluginPath` risolve nel dist. Commit `feat(worker): plugin base Stubwise con contratto della run`.

---

## Fase B — Worker: materializzazione, inventario, smoke, copia filtrata

### Task 4: Helper git e inventario

**Files:** Create `apps/worker/src/plugins/git.ts` (`fetchAtRef(url, ref, destDir, {timeoutMs}) → { sha }`: `git init`, `git fetch --depth 1 <url> <ref>` (con fallback a fetch pieno se il ref è uno sha non raggiungibile in shallow), `git checkout FETCH_HEAD`, `git rev-parse HEAD`, poi `rm -rf .git`; env `GIT_TERMINAL_PROMPT=0`, nessuna auth; errori con stderr redatto), `apps/worker/src/plugins/inventory.ts` (`readInventory(pluginDir) → PluginInventory`: parse `plugin.json`, frontmatter YAML minimale (name/description) delle `skills/*/SKILL.md`, `commands/*.md`, `agents/*.md`, `hooks/hooks.json` → chiavi `<Evento>#<i>`, `hasMcp`; robusto a anomalie: skill senza frontmatter → name = dir), Test con fixture in `apps/worker/src/plugins/__fixtures__/plugin-a/` (2 skill, 1 command, 1 hook, `.mcp.json`) e un repo git locale creato nel test (`git init` in tmp + commit) per `fetchAtRef` (sha e branch). Commit `feat(worker): fetch a ref e inventario dei plugin`.

### Task 5: Poller di materializzazione e smoke

**Files:** Create `apps/worker/src/plugins/queue.ts` (claim `plugin_jobs` SKIP LOCKED, complete/fail, recovery stale — pattern `graph/queue.ts`), `apps/worker/src/plugins/poller.ts` (`processPluginJobsOnce(deps)`: `materialize` → `fetchAtRef` in `<PLUGINS_DIR>/<slug>/<sha>` (subdir → dir del plugin), `claude plugin validate <dir> --strict` (via `execa` sul binario `claude`; in test iniettabile), `readInventory`, UPDATE `plugins` (`ready`, `resolvedSha`, `inventory`, `materializedAt`) + rimozione delle dir di sha precedenti + potatura `disabledSkills/disabledHooks` obsoleti + enqueue `smoke`; errori → `failed` con `error`. `smoke` → runner `haiku`/`maxTurns 1`/`--setting-sources ""`/`pluginDirs [base, plugin]`, prompt fisso, parse dell'output: tutte le skill `name` dell'inventario presenti come `<plugin.name>:<skill>` → `passed`, altrimenti `failed` con output troncato), `apps/worker/src/config.ts` (`PLUGIN_POLL_SECONDS` 20, `PLUGINS_DIR` default `/plugins`), `apps/worker/src/index.ts`, `apps/worker/Dockerfile` (`mkdir -p /plugins && chown worker:worker /plugins`, `ENV PLUGINS_DIR=/plugins`), `docker-compose.yml` (volume `claude-plugins:/plugins` sul worker, env). Test (testcontainers + fake runner + validate iniettato): materialize felice, validate fallito, fetch fallito, aggiornamento con potatura e rimozione dir vecchie, smoke passed/failed. Commit `feat(worker): materializzazione dei plugin e smoke run`.

### Task 6: Runner con `--plugin-dir`, `--setting-sources`, `--disallowedTools`

**Files:** Modify `apps/worker/src/agent/runner.ts` (`pluginDirs?: string[]`, `disallowedTools?: string[]`, `settingSources?: ""`), `claude-cli.ts` (argv: `--plugin-dir` ripetuto; `--disallowedTools ...`; `--setting-sources` — la stringa vuota passata come argomento separato), `fake.ts`. Test argv (`claude-cli.test.ts`). Commit `feat(worker): flag plugin nel runner`. **Deviazione applicata in implementazione:** il tipo di `settingSources` è il solo `""` e non `string[] | ""`, perché la lista dava due grafie per lo stesso argv e la lista VUOTA avrebbe significato «spegni tutte le sorgenti», semantica opposta alla convenzione di `allowedTools`/`disallowedTools`/`pluginDirs` (vuoto = ometti il flag); nessun chiamante accende sorgenti selettive (il Task 7 usa solo `""`).

### Task 7: Copia filtrata e innesto nei run

**Files:** Create `apps/worker/src/plugins/materialize-run.ts` (`preparePluginsForRun(db, { projectId, runTmpDir }) → { pluginDirs, disallowedTools }`: legge `project_plugins` abilitati con plugin `ready`, verifica dir `<PLUGINS_DIR>/<slug>/<resolvedSha>` e `plugin.json.name` coerenti (mismatch → skip + log), copia in `<runTmpDir>/plugins/<slug>` escludendo `skills/<spente>`, riscrivendo `hooks/hooks.json` senza i gruppi spenti (se non restano hook, file omesso), omettendo `.mcp.json`; `disallowedTools` = `Skill(<name>:<skill>)` per le spente; base plugin per primo se esiste; ritorna liste vuote se nulla); Modify `apps/worker/src/pipeline/fix.ts` (nuova "opt" `pluginOpt` calcolata una volta per run — plan, plan resume, execute, repair — con `pluginDirs`, `disallowedTools`, `settingSources: ""` SOLO quando `pluginDirs` non è vuoto; la dir temporanea del run: usa/estendi quella già usata per il file MCP), `apps/worker/src/backlog/deep-dive.ts` e `chat-turn.ts` (stessa opt). Test: copia filtrata su fixture (skill/hook/mcp esclusi, deny rule), mismatch saltato, run del fix riceve `pluginDirs` (FakeAgentRunner) con base per primo. Commit `feat(worker): plugin filtrati per progetto nei run di fix e backlog`.

---

## Fase C — Server e UI

### Task 8: Servizi e rotte del registro e delle abilitazioni

**Files:** Create `apps/server/src/services/plugins.ts` (`createPlugin` (slug derivato dall'ultimo segmento dell'URL/subdir, unicità), `requestUpdate(id, ref)` (accoda `materialize`, 409 se già in corso), `requestSmoke(id)`, `deletePlugin(id)` (409 `plugin_in_use` se `project_plugins.enabled`), `getProjectPlugins`, `putProjectPlugins` (valida che le skill/hook citati esistano nell'inventario)), `apps/server/src/routes/plugins.ts` + `apps/server/src/routes/project-plugins.ts` (requireAdmin), registrazione in `app.ts`, `apps/server/src/plugins/recommendations.ts` (o in `packages/shared`: `RECOMMENDED_DISABLED_SKILLS: Record<string, string[]>` con `superpowers` → 4 skill; esposto nel GET del registro come `recommendations`). Test rotte (CRUD, 401/403, 409 in uso, PUT abilitazioni con skill inesistente → 400). Commit `feat(server): API del registro plugin e abilitazioni per progetto`.

### Task 9: UI Impostazioni → Plugin

**Files:** Create `apps/web/src/components/plugins-section.tsx`, `apps/web/src/routes/settings/plugins.tsx`; Modify `apps/web/src/routes/settings/layout.tsx` (voce nav adminOnly), `apps/web/src/lib/api.ts` + `queries.ts` (`pluginsQueryOptions` con refetch 2 s se qualche `status === "materializing"` o `smokeStatus === "pending"`), `router.tsx`, i18n. Contenuto: lista + badge, form Aggiungi, inventario espandibile (hook col comando in `font-mono`), azioni Aggiorna/Riprova smoke/Rimuovi (con diff inventario mostrato quando `resolvedSha` cambia: confronto client-side tra inventario precedente in cache e nuovo — semplice). Test (happy-dom): lista, aggiunta, polling, inventario, 409 rimozione. Commit `feat(web): pagina Plugin nelle impostazioni`.

### Task 10: UI sezione Plugin nella pagina progetto

**Files:** Create `apps/web/src/components/project-plugins-section.tsx` (pattern `project-servers-section`: non-suspense; per plugin `ready`: switch abilitato + checkbox skill/hook; "Applica preset consigliato"; PUT insieme completo, ottimistico con rollback), Modify `apps/web/src/routes/projects/$projectId.tsx`, api/queries, i18n. Test: toggle, preset, PUT. Commit `feat(web): sezione Plugin nella pagina progetto`.

---

## Fase D — Golden, docs, chiusura

### Task 11: Scenari golden (manuali) e documentazione

**Files:** Create `apps/worker/scripts/golden/{run.ts, fixture/…, README.md}` (script `pnpm --filter @stubwise/worker golden`: usa `ClaudeCliRunner` reale, un repo fixture locale, base plugin + plugin dato via argomento; 3 scenari del design §8; output JSON; esce 1 se uno fallisce); Modify `CLAUDE.md` (sezione "Plugin/skill": registro, contratto, golden manuali, invariante "`.mcp.json` dei plugin mai caricato", deploy fase 3), `apps/docs` (pagina "Plugins" nella guida: cosa, sicurezza, preset superpowers; configuration.md `PLUGIN_POLL_SECONDS`), `.env.example`. Commit `docs(fase3): registro plugin, golden manuali`.

### Task 12: Verifica finale e note di deploy

`pnpm lint` + `pnpm typecheck` + `pnpm test`; `pnpm --filter @stubwise/worker build` e verifica che `dist` contenga il base plugin e lo script golden; playwright --list; `feature-backlog.md` (fase 3 ✅); `CLAUDE.md` § Deploy (fase 3: rebuild server+worker+caddy, migrazione 0066, volume `claude-plugins`, env opzionale). Commit `docs: note di deploy fase 3`.

**Deploy:** backup DB → `git pull` → `docker compose up -d --build server worker caddy` → verifica 0066 e volume → da Impostazioni → Plugin aggiungere `https://github.com/obra/superpowers.git` @ `v4.0.3` → attendere `ready` + smoke → abilitare sui progetti con il preset.
