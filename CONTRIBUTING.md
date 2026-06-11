# Contribuire a Stubwise

Grazie per l'interesse! Questa guida copre il setup di sviluppo, le convenzioni
del progetto, come aggiungere un nuovo provider git e il processo di release.

## Prerequisiti

- **Node 22+** (vedi `.nvmrc`).
- **pnpm** (gestito via Corepack: `corepack enable`).
- **Docker** in esecuzione: la suite di test avvia Postgres con
  [testcontainers](https://testcontainers.com/), e i test e2e avviano uno stack
  reale. Non serve installare Postgres a mano.

## Setup

```bash
git clone https://github.com/Aleloca/stubwise.git
cd stubwise
corepack enable
pnpm install
```

Il monorepo è gestito con pnpm workspaces. I package (`packages/*`) sono
dipendenze dei `apps/*` via `workspace:*`.

### Build, lint, typecheck, test

```bash
pnpm -r build       # build di tutti i package (in ordine di dipendenza)
pnpm lint           # eslint sull'intero repo
pnpm -r typecheck   # typecheck per-package
pnpm test           # test per-package (vitest)
```

Note importanti:

- **Build prima dei test.** Alcuni test compilano i propri prerequisiti di
  workspace, ma il modo robusto (e quello usato in CI) è `pnpm -r build` prima
  di `pnpm test`/`pnpm -r typecheck`.
- **Docker richiesto per i test** di `@stubwise/server`, `@stubwise/worker` e
  `@stubwise/db`: avviano un container Postgres effimero via testcontainers. Se
  Docker non è in esecuzione questi test falliscono all'avvio.
- I test e2e (Playwright) sono **esclusi** da `pnpm test` e si lanciano a parte:

  ```bash
  pnpm --filter @stubwise/web exec playwright install --with-deps chromium  # una volta
  pnpm --filter @stubwise/web e2e
  ```

### Eseguire le app in sviluppo

Il **server** e il **worker** richiedono un Postgres raggiungibile (a differenza
dei test, che usano testcontainers). Il modo più semplice è avviare solo il
container Postgres del compose:

```bash
docker compose up -d postgres
cp .env.example .env   # DATABASE_URL di default punta a localhost:5432
```

Poi, in terminali separati:

```bash
pnpm --filter @stubwise/server dev   # API Fastify (applica le migrazioni all'avvio)
pnpm --filter @stubwise/web dev      # web app Vite
pnpm --filter @stubwise/worker dev   # pipeline AI (richiede git + CLI claude)
pnpm --filter @stubwise/docs dev     # sito di documentazione
```

Il server applica le migrazioni Drizzle all'avvio (`runMigrations`), quindi non
c'è un comando di migrazione separato da eseguire a mano.

## Convenzioni

- **Conventional Commits.** Messaggi come `feat(server): ...`, `fix(sdk): ...`,
  `chore: ...`, `docs: ...`, `test: ...`. La storia del repo usa anche scope e
  descrizioni in italiano: va bene mantenere coerenza con i commit vicini.
- **TDD.** Scrivi prima il test, poi l'implementazione. Ogni package ha la sua
  suite vitest (`*.test.ts` accanto al sorgente).
- **TypeScript strict.** Ogni package estende `tsconfig.base.json` (strict,
  `noUncheckedIndexedAccess`, ESM `NodeNext`). Il pattern per-package è:
  - `tsconfig.json` — per editor/typecheck, include `src`;
  - `tsconfig.build.json` — estende `tsconfig.json` ed esclude i `*.test.ts`,
    usato dallo script `build`.
  Mantieni questo pattern quando aggiungi un package.
- **Niente segreti nei commit.** Le credenziali git dei progetti sono cifrate a
  riposo con `ENCRYPTION_KEY`; non loggare token né payload cifrati.

## Aggiungere un nuovo GitProvider

L'astrazione vive in `packages/git`. Per supportare un nuovo provider (es.
GitLab) servono questi passi — usa `packages/git/src/github.ts` e
`packages/git/src/bitbucket.ts` come template.

1. **Implementa l'interfaccia `GitProvider`** (`packages/git/src/provider.ts`)
   in un nuovo file, es. `packages/git/src/gitlab.ts`. Devi fornire:
   - `getCloneUrl(p)` e `getAuthHeader(p)` — credenziali per git-over-https,
     mai persistite su disco (passate per-invocazione via
     `git -c http.extraheader`);
   - `openPullRequest(p, pr)` — apre la PR e ritorna `{ url }`;
   - `parseWebhook(headers, body)` — ritorna un `PrMergedEvent` se il payload è
     una PR mergiata, altrimenti `null` (non lancia mai, non verifica la firma);
   - `verifyWebhook(headers, rawBody, secret)` — verifica HMAC-SHA256 sulla
     **raw body** (riusa `verifyHmacSignature` se lo schema è `sha256=<hex>`).

2. **Aggiungi il valore all'enum di dominio** in
   `packages/shared/src/schemas/project.ts`:

   ```ts
   export const gitProviderKindSchema = z.enum(["bitbucket", "github", "gitlab"]);
   ```

3. **Aggiorna l'enum del database.** L'enum Postgres `git_provider_kind` è
   derivato da `gitProviderKindSchema` in `packages/db/src/schema.ts`, ma un
   nuovo valore richiede una **migrazione** Drizzle (`ALTER TYPE ... ADD VALUE`).
   Genera/aggiungi la migrazione in `packages/db/drizzle`.

4. **Registra nel factory** `getProvider` in `packages/git/src/index.ts`:

   ```ts
   case "gitlab":
     return new GitLabProvider(options);
   ```

   Lo `switch` è esaustivo (`satisfies never` nel `default`): senza il nuovo
   case il typecheck fallisce, il che è voluto.

5. **Aggiungi i test** accanto all'implementazione (`gitlab.test.ts`),
   modellati su `github.test.ts`/`bitbucket.test.ts`: clone URL, auth header,
   apertura PR (con `fetchImpl` mockato), parsing e verifica del webhook.

## Processo di release

`@stubwise/sdk` e `@stubwise/shared` sono pubblicati su npm; gli altri package e
le app non lo sono (sono ignorati in `.changeset/config.json`). Il versioning è
gestito con [Changesets](https://github.com/changesets/changesets).

1. **Aggiungi un changeset** insieme al tuo cambiamento:

   ```bash
   pnpm changeset
   ```

   Seleziona i package interessati e il tipo di bump (patch/minor/major), poi
   committa il file generato in `.changeset/`.

2. **Al merge su `main`**, il workflow `.github/workflows/release.yml`
   (`changesets/action`) apre/aggiorna una PR "Version Packages" che consuma i
   changeset, alza le versioni e aggiorna i changelog.

3. **Al merge di quella PR**, lo stesso workflow esegue `pnpm changeset publish`
   e pubblica i package su npm. Le dipendenze `workspace:*` vengono riscritte
   alla versione reale al momento della pubblicazione.

La pubblicazione richiede il secret di repository **`NPM_TOKEN`**: finché non è
configurato, il passo di publish non autentica e non pubblica nulla (il workflow
resta innocuo). Per testare l'impacchettamento in locale senza pubblicare:

```bash
pnpm -r build
pnpm --filter @stubwise/sdk exec pnpm publish --dry-run --no-git-checks
pnpm --filter @stubwise/shared exec pnpm publish --dry-run --no-git-checks
```

## Aprire una Pull Request

- Assicurati che `pnpm -r build`, `pnpm lint`, `pnpm -r typecheck` e `pnpm test`
  passino in locale (richiede Docker per i test).
- La CI (`.github/workflows/ci.yml`) rigira gli stessi passi più i test e2e su
  ogni push e PR verso `main`.
- Includi un changeset se tocchi `@stubwise/sdk` o `@stubwise/shared`.
