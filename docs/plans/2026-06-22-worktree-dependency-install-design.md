# Installazione delle dipendenze nel worktree — Design

**Data:** 2026-06-22

## Problema

La pipeline di fix crea un **git worktree effimero** dal mirror bare del repo e ci fa
lavorare l'agente, poi esegue il comando di test del repo nel loop di **self-repair**.
Un git worktree condivide `.git` ma ha i propri file di lavoro: **non contiene
`node_modules`**. In nessun punto della pipeline le dipendenze vengono installate.

Conseguenza: per qualunque repo i cui test invochino un binario locale (vitest, jest,
eslint…) il comando di test fallisce con **exit 127** (`sh: 1: vitest: not found`),
indipendentemente dalla qualità del fix. Dopo `SELF_REPAIR_MAX_ATTEMPTS` tentativi il
job va `failed` senza aprire PR.

Osservato in produzione sul ticket #9 (progetto *Trion Gestionale*, `trion-webapp`):

```
> trion-webapp@0.1.0 test
> vitest
sh: 1: vitest: not found
[fix] self-repair tentativo 0/1/2: test rossi (exit 127)
[fix] test rossi: per prudenza nessuna PR
```

Reperto secondario: l'immagine **runtime** del worker ha solo `npm` (corepack è abilitato
solo nello stage di build). Un repo con `pnpm-lock.yaml`/`yarn.lock` fallirebbe anche solo
a far partire `pnpm test`/`yarn test`.

## Obiettivo

Installare le dipendenze nel worktree **una volta**, **prima** che l'agente lavori (così
può scrivere/eseguire i test durante il fix) **e** prima del loop di self-repair.

## Decisioni (dal brainstorming)

1. **Risoluzione del comando di install — auto-detect + override configurabile**
   (speculare a `resolveTestCommand`):
   - **Override**: nuovo campo `projects.install_command`. Se valorizzato (trim non vuoto)
     vince sempre. Parsing semplice come per `test_command` (split sugli spazi, niente
     shell/quoting/pipe).
   - **Auto-detect** (override assente): dal lockfile presente nel worktree:
     - `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`
     - `yarn.lock` → `yarn install --frozen-lockfile`
     - `package-lock.json` → `npm ci`
     - `package.json` presente ma **nessun** lockfile → `npm install`
     - nessun `package.json` → `null` (niente da installare, si prosegue)
   - Precedenza pnpm > yarn > npm se più lockfile coesistono.

2. **Timing — prima dell'agente e del self-repair.** L'install gira nel callback di
   `withWorktree`, una sola volta, **prima** del primo run dell'agente che ne ha bisogno.
   In modalità **plan-only** (read-only, nessun test) si **salta**: non vale 10' di install.

3. **Package manager nell'immagine.** Aggiungere `corepack enable` allo stage **runtime**
   del worker (fornisce gli shim `pnpm` e `yarn`). `npm` è già presente con Node.

## Comportamento su install fallito

L'install è eseguito dal worker (execa, `reject:false`, timeout dedicato), **non**
nell'env ristretto dell'agente. Se il comando risolto **fallisce** (exit non-zero o
timeout):

- si **logga** l'esito in modo prominente nel log del job (output troncato, niente
  segreti) con un messaggio esplicito "install dipendenze fallito";
- si **prosegue** comunque con l'agente: un install flaky (rete) non deve sprecare
  l'intera run, e l'agente potrebbe non aver bisogno di tutte le dipendenze. Il guard
  esistente del self-repair ("test rossi → niente PR") resta la rete finale, ma ora il
  log spiega il *perché* a monte invece di un criptico 127.

`npm ci` richiede un `package-lock.json` coerente; se fallisce per quel motivo, l'auto-detect
ha già scelto `npm ci` solo in presenza del lockfile, quindi non aggiungiamo fallback
automatici (YAGNI): chi ha un setup particolare usa l'override `install_command`.

## Invariante di staleness

L'install aggiunge fino a `INSTALL_TIMEOUT_MS` (default **10'**) **una volta** alla durata
massima di un job. `assertStaleInvariant` (apps/worker/src/index.ts) deve includere questo
addendo, e il commento dell'invariante va aggiornato in `config.ts`, `docker-compose.yml`
e `index.ts` (vedi invariante WORKER_STALE_MINUTES). Con i default attuali
(fix 40' + self-repair 70' + 2× triage 4' + margine 5' ≈ 119') l'aggiunta di 10' porta il
minimo a ~129', sotto il default `WORKER_STALE_MINUTES=150`: **nessun cambio di default**,
ma il calcolo e i commenti vanno aggiornati.

## Sicurezza

`pnpm install`/`npm ci` eseguono gli script di lifecycle (`postinstall`) delle dipendenze
del repo: codice arbitrario. È un'istanza self-hosted sui propri repo e l'agente già
esegue codice del repo, quindi il modello di fiducia non cambia. Manteniamo gli script
abilitati (servono per i build nativi). Nessun segreto finisce nell'output loggato
(troncamento + nessuna iniezione di credenziali nell'env dell'install).

## Fuori scope (YAGNI)

- Cache persistente di `node_modules`/store del package manager tra run (i worktree sono
  effimeri in tmpdir). Possibile ottimizzazione futura via volume condiviso.
- Fallback a catena `npm ci` → `npm install`.
- Install in linguaggi non-JS (pip, bundler, …): oggi la pipeline è npm-centrica.

## Superficie di modifica

- **DB**: migrazione `0024` additiva `projects.install_command text` (nullable);
  `packages/db/src/schema.ts`.
- **Worker**: nuovo `pipeline/install-command.ts` (`resolveInstallCommand`) + test;
  `runInstallCommand` in `fix.ts`; wiring nel callback `withWorktree`; config
  `INSTALL_TIMEOUT_MS`; invariante in `index.ts`.
- **Immagine**: `corepack enable` nello stage runtime di `apps/worker/Dockerfile`.
- **Server**: `installCommand` in zod/persistenza/proiezione di `routes/projects.ts`.
- **Web**: campo "Comando di installazione" in `project-form.tsx` (+ i18n it/en, `lib/api.ts`).
- **Docs**: menzione del campo install in `apps/docs`.
- **Compose**: commento dell'invariante in `docker-compose.yml`.
