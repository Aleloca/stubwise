# Revisore predefinito e scope di Validate — piano di implementazione

> **Per chi esegue:** un task alla volta, in TDD: prima il test che fallisce,
> poi il codice, poi le mutazioni indicate (ognuna deve far diventare ROSSO
> almeno un test, e deve produrre codice che GIRA e sbaglia, non che esplode —
> vedi CLAUDE.md, «Mutation testing»). Ogni task si chiude con un commit suo e
> con una revisione indipendente (un revisore che non ha scritto il codice).
> Dopo ogni modifica a `packages/*` ribuilda il package prima di lanciare i
> test di `apps/*`: server e worker leggono `dist/`, non i sorgenti.
> Worktree: `/Users/aleloca/git/stubwise/.worktrees/default-reviewer-and-scopes`,
> branch `feat/default-reviewer-and-scopes` (da `origin/main` 8ad52eb0).

Due parti, un solo branch e un solo deploy:

- **Parte 1 — revisore predefinito per provider + workspace.** Un account git
  può essere marcato «revisore predefinito»; una repository senza revisore
  esplicito usa quello del suo provider/workspace. Una sola funzione decide il
  revisore EFFETTIVO, e tutti i consumatori la chiamano.
- **Parte 2 — Validate verifica gli scope Bitbucket.** Il bottone Validate di
  Impostazioni → Account git legge gli scope CONCESSI dall'header della
  chiamata che già fa, e li confronta con quelli che il RUOLO dell'account
  richiede (ruolo calcolato dal server, predefinito compreso).

---

## 0. Premesse verificate sul codice (8ad52eb0)

Ogni riga qui sotto è stata letta, non dedotta.

- La rotta di Validate è **`POST /api/git-accounts/:id/validate`**
  (`apps/server/src/routes/git-accounts.ts`, ~riga 235), non `GET` come nella
  richiesta. Il piano la lascia `POST`.
- `checkReviewAccount` (`apps/server/src/routes/repositories.ts:177`) è
  **per repository**: vuole `repoUrl`/`defaultBranch`, fa `validateCredentials`
  sulla repository (scrittura, filtra i check `purpose: "webhook"`), poi
  risolve identità del revisore (refresh) e del principale e le confronta.
  A livello di ACCOUNT (senza repository) il permesso di scrittura non è
  verificabile: è un permesso per repository.
- Il CHECK `repositories_review_not_main_chk`
  (`packages/db/src/schema.ts:500`, `0081_pr_corrections.sql:64`) è sulla
  colonna esplicita. Resta com'è.
- `gitAccounts.workspace` è `NULL` per GitHub *di norma*, ma
  `createAccountSchema` accetta `workspace` per qualunque provider: un account
  GitHub con `workspace` valorizzato esiste in potenza. `checkReviewAccount`
  confronta il workspace **solo su Bitbucket**. La chiave del predefinito deve
  fare lo stesso (vedi D1).
- Le migrazioni sono SQL scritto a mano più `_journal.json` (gli snapshot si
  fermano alla 0060). L'ultima è la 0081.
- L'app mobile legge `repositorySchema` (via `packages/api-client`,
  `endpoints/repositories.ts:33`, schermata `ProjectRepositoriesScreen`), MAI
  `gitAccountSchema` né gli avvisi del salvataggio. Non mostra il revisore.
- Il commit WIP della Parte 2 è **7a373ee2** sul branch
  `feat/validate-bitbucket-scopes`: `packages/git/src/bitbucket-scopes.ts`
  (insiemi, `bitbucketRequiredScopes`, `parseBitbucketScopes`,
  `bitbucketScopeChecks`), l'opzione `requiredScopes` in
  `GitProvider.validateAccount` (`provider.ts`), l'export in `index.ts` e i
  test in `bitbucket.test.ts`. **`BitbucketProvider.validateAccount` non
  chiama ancora `bitbucketScopeChecks`**: i test nuovi oggi sono rossi. Mai
  eseguiti fino in fondo.

### Consumatori di `reviewGitAccountId` / `review_git_account_id`

Trovati con `grep -rn -E "reviewGitAccount|review_git_account_id|reviewAccount"`
su `apps` e `packages`, test esclusi. Ognuno ha un task.

| # | File:riga | Cosa fa col valore | Dopo | Task |
|---|---|---|---|---|
| C1 | `apps/worker/src/review/cycle.ts:183-201` (`loadReviewerProject`, chiamata a :274) | `innerJoin` su `repositories.reviewGitAccountId`: credenziali con cui `submitPrReview` pubblica il verdetto; `null` → pubblica col principale | `resolveReviewAccount` | P1-5 |
| C2 | `apps/server/src/services/pr-correction-webhook.ts:220,243` (`handleChangesRequested`, punto 2) | `accountIds = [main, explicit?]`: identità da considerare «proprie», fail-closed; un evento di una di queste → `own_account`, nessuna scrittura | `[main, effettivo?]` via `resolveReviewAccount` | P1-4 |
| C3 | `apps/worker/src/pipeline/correction.ts:704-731` (→ `refreshProviderFeedback`, :301) | `accounts: [main, explicit?]`: autori esclusi dalla fotografia dei commenti | `[main, effettivo?]` | P1-5 |
| C4 | `apps/server/src/routes/repositories.ts:177-307` (`checkReviewAccount`), :390 (POST), :656-670 (PATCH) | valida il revisore ESPLICITO scelto nel form | invariato per l'esplicito; in più avviso NON bloccante sul predefinito che diventa effettivo | P1-6 |
| C5 | `apps/server/src/routes/repositories.ts:686-690` (guardie nel WHERE del PATCH) | «revisore ≠ principale» riverificato contro le corse | invariato: riguarda la colonna esplicita | — (test di non regressione in P1-6) |
| C6 | `apps/server/src/routes/repositories.ts:143` (`toPublicRepository`) | espone l'esplicito | invariato + campi DERIVATI `effectiveReviewAccount`, `skippedDefaultReviewAccount` | P1-3 |
| C7 | `packages/shared/src/schemas/project.ts:56` (`repositorySchema.reviewGitAccountId`) | schema di risposta | invariato + i due campi nuovi `.nullable().default(null)` | P1-3 |
| C8 | `packages/db/src/schema.ts:464,503` + `0081_pr_corrections.sql:63-65` | colonna, FK `ON DELETE SET NULL`, CHECK | invariati | — |
| C9 | `apps/web/src/components/repository-form.tsx:28,62-124,186-211` | select del revisore, «nessuno», «non più valido» | quando vuoto, «Revisore: predefinito (<nome>)» / «nessuno» dai campi derivati | P1-8 |
| C10 | `apps/web/src/routes/repositories/$slug.tsx:170`, `apps/web/src/lib/api.ts:1131,1173,1193` | passa il valore al form; tipi | tipi dei campi nuovi, opzionali | P1-8 |
| C11 | `apps/server/src/routes/git-accounts.ts` `POST /:id/validate` | (oggi non lo legge) | calcola il RUOLO con `resolveReviewAccounts` | P2-2 |

Nessun consumatore in `apps/server/scripts`, `apps/mobile`, `packages/api-client`
(oltre allo schema), né nel calcolo del ciclo (`derivePrCycle`) o nella coda di
rilascio. L'implementatore di P1-2 **rifà il grep** prima di cominciare e
aggiunge al piano ogni riga nuova: se un consumatore resta fuori, la regola
«una sola funzione» è falsa.

---

## 1. Decisioni

**D1 — Chiave del predefinito e indice.** «Ambito» di un account =
`(provider, workspace se Bitbucket altrimenti '')`. Indice unico parziale:

```sql
CREATE UNIQUE INDEX "git_accounts_default_reviewer_scope_uq"
  ON "git_accounts" (
    "provider",
    (CASE WHEN "provider" = 'bitbucket' THEN COALESCE("workspace", '') ELSE '' END)
  )
  WHERE "is_default_reviewer";
```

Perché un'espressione e non `NULLS NOT DISTINCT` su `(provider, workspace)`:
quel costrutto renderebbe due account GitHub con `workspace` diversi (campo che
su GitHub non significa niente, ma che l'API accetta) due ambiti separati, cioè
due predefiniti GitHub — e la risoluzione, che come `checkReviewAccount` ignora
il workspace su GitHub, non saprebbe quale scegliere. La stessa regola vive in
TypeScript in `reviewScopeKey` (P1-2), e un test di DB (P1-1) fissa che le due
dicano la stessa cosa.

**D2 — Revisore effettivo.** `explicit` se `review_git_account_id` non è null
(la FK `SET NULL` e il CHECK garantiscono che esista e ≠ principale);
altrimenti il predefinito con `reviewScopeKey` uguale a quello del principale,
**scartato se è il principale stesso**; altrimenti nessuno. Nessuna opzione
«nessun revisore» per repository (decisione dell'utente).

**D3 — Un account principale di qualche repository PUÒ diventare predefinito,
con un avviso.** Motivi:
1. il caso si crea comunque DOPO (un admin sceglie il predefinito come
   principale di una repository nuova): la risoluzione deve gestirlo in ogni
   caso, e rifiutarlo all'impostazione non lo elimina;
2. auto-innesco: nessun rischio. Su quelle repository l'account è il
   principale, quindi è già fra gli «account propri» del webhook; altrove è il
   revisore effettivo, quindi è proprio anche lì;
3. cosa vede l'utente: alla conferma del toggle, un avviso che elenca le
   repository in cui il predefinito NON si applica perché ne è il principale;
   nel form di quelle repository, «Revisore: nessuno — il predefinito (<nome>)
   è l'account principale di questa repository» (campo derivato
   `skippedDefaultReviewAccount`, P1-3).

**D4 — Impostare il predefinito: rotte dedicate, sostituzione esplicita.**
`PUT /api/git-accounts/:id/default-reviewer` (imposta) e
`DELETE /api/git-accounts/:id/default-reviewer` (toglie), solo admin. Non un
campo del `PATCH`: l'impostazione fa chiamate di rete e ha una risposta sua.
Se nello stesso ambito c'è già un predefinito, il `PUT` lo SOSTITUISCE nella
stessa transazione e la risposta lo dice (`replaced: {id, name} | null`); la
UI lo chiede prima con una conferma. Una corsa fra due admin la ferma l'indice
→ `409 default_reviewer_conflict`.

**D5 — Validazione all'impostazione: bloccante a livello di account, avvisi a
livello di repository.**
- *Bloccanti (422)*: credenziali non decifrabili; Bitbucket senza workspace;
  identità non leggibile (`resolveProviderUserId` con `refresh: true`) →
  `review_account_identity_unresolved`; `validateAccount` con
  `requiredScopes: BITBUCKET_REVIEWER_SCOPES` (Parte 2) con almeno un check
  `ok: false` → `default_reviewer_invalid`, messaggio = i dettagli dei check.
- *Avvisi (200, `warnings`)*: per ogni repository in cui il predefinito
  diventerebbe EFFETTIVO, `checkReviewAccount(verifyRemote: true)` (scrittura
  sulla repository, identità diversa dal principale). Un esito ko non blocca:
  ogni repository che fallisce compare negli avvisi col suo `code`. Più le
  repository «saltate» di D3.
- Perché la scrittura non blocca: non esiste l'opzione «nessun revisore» per
  repository, quindi un 422 per UNA repository senza accesso renderebbe il
  predefinito impossibile finché quella repository esiste. L'avviso dice cosa
  succederà (la review ricade su un commento del principale, già gestito da
  `cycle.ts` con «Verdetto non apposto»), e il rimedio (dare accesso o un
  revisore esplicito) resta all'admin.
- Le chiamate per repository vanno con concorrenza limitata (4), ognuna già
  col timeout del provider.

**D6 — Account propri nel webhook = principale + revisore EFFETTIVO.** Non
«ogni predefinito dell'istanza»: aggiungere un account non usato su quella
repository allargherebbe il fail-closed (un'identità non risolvibile di un
account estraneo scarterebbe ogni «Request changes» di quella repository) senza
chiudere nessun ciclo — il ciclo nasce solo dall'account che Stubwise usa per
pubblicare su QUELLA repository. Finestra accettata: se l'admin cambia il
predefinito nei secondi fra la pubblicazione di una review e l'arrivo del suo
webhook, quell'evento viene valutato con la configurazione nuova (vedi Dubbi).

**D7 — Modifiche all'account predefinito.**
- `PATCH` che cambia il `workspace` di un account predefinito → `409
  default_reviewer_workspace_locked` («togli il predefinito prima»): spostarlo
  di ambito in silenzio cambierebbe il revisore di N repository senza la
  validazione di D5, e potrebbe collidere con l'indice.
- `PATCH` delle credenziali: consentito (azzera già `provider_user_id`, che si
  riscopre al primo uso; il webhook resta fail-closed se non si risolve). La
  UI suggerisce di rilanciare Validate.
- `DELETE` dell'account: il flag sparisce con la riga; le repository che lo
  usavano come effettivo restano senza revisore. Nessun 409 nuovo (la FK
  esplicita era già `SET NULL`).

**D8 — Il web non deduce il revisore effettivo.** Il server lo deriva e lo
manda in ogni proiezione di repository (GET lista, GET singola, risposte di
POST/PATCH): `effectiveReviewAccount: {id, name, source: "explicit" |
"default"} | null` e `skippedDefaultReviewAccount: {id, name} | null`, entrambi
`.nullable().default(null)`. Stesso criterio di `canMerge`: la regola sta in
un posto e il client la legge.

**D9 — Ruolo per Validate (Parte 2).** Calcolato dal server:
- `primary` = esiste una repository con `git_account_id = id`;
- `reviewer` = esiste una repository il cui revisore EFFETTIVO
  (`resolveReviewAccounts`) è `id`, **oppure l'account è marcato predefinito**.
  Deviazione motivata dalla richiesta («revisore… dove la risoluzione lo
  sceglie davvero»): un predefinito appena impostato in un ambito senza
  repository cadrebbe in «mai usato» → insieme del principale → un ko sui
  webhook che il suo ruolo non chiede. Il flag è una dichiarazione esplicita
  dell'admin sul ruolo.
- nessuno dei due → insieme del principale (`bitbucketRequiredScopes` lo fa
  già).

**D10 — Header degli scope assente** (app password legacy, o
`x-credential-type` diverso da `api_token`): un check «Scope del token» con
`ok: true` e il dettaglio «non verificabili per questo tipo di credenziale…
controlla a mano che abbia …». Già nel WIP; motivo: `ok: false` lascerebbe
rosso PER SEMPRE un account con app password, che Stubwise accetta ancora, per
un fatto che nessuna azione dell'utente cambia. Il check non afferma che gli
scope ci siano: lo dice nel testo.

**D11 — GitHub resta com'è.** `x-oauth-scopes` esiste solo per i token
classici; un fine-grained PAT non dichiara i suoi permessi in nessun header.
`x-accepted-github-permissions` dice cosa richiede l'ENDPOINT chiamato, non cosa
ha il token: confrontarlo con niente non dà un verdetto. Senza rete non è
verificabile se esista un altro header; il piano non lo cerca. `GitHubProvider`
ignora `requiredScopes`.

**D12 — 403 con `error.detail.required`/`granted`.** Sul 403 della chiamata
già fatta, se il corpo JSON ha `error.detail.required` (array o stringa), il
dettaglio del check di autenticazione nomina gli scope richiesti mancanti
(`required − granted`). Nessuna chiamata in più; un corpo diverso lascia il
messaggio di oggi.

---

## 2. Ordine dei task e revisioni

```
P2-1 (cherry-pick + wiring packages/git)        ── indipendente
P1-1 (migrazione 0082 + schema drizzle)
P1-2 (resolveReviewAccount in notifications)    ── dopo P1-1
P1-3 (schemi shared + proiezione server)        ── dopo P1-2
P1-4 (webhook: account propri)                  ── dopo P1-2
P1-5 (worker: pubblicazione + fotografia)       ── dopo P1-2
P1-6 (form repository: avviso sul predefinito)  ── dopo P1-3
P1-7 (rotte del predefinito)                    ── dopo P1-2, P2-1
P2-2 (Validate: ruolo dal server)               ── dopo P1-2, P2-1
P1-8 (web: toggle, scritta nel form, Validate)  ── dopo P1-3, P1-7, P2-2
P1-9 (CLAUDE.md, guida, changeset)              ── per ultimo
P1-10 (verifica finale: typecheck, lint, test, E2E)
```

Revisioni che si possono fare INSIEME (stesso revisore, stesso giro):
- **P1-1 + P1-2** (dato e regola: il revisore controlla che indice e
  `reviewScopeKey` dicano la stessa cosa);
- **P1-4 + P1-5** (tutti i punti in cui un account è «proprio»: devono usare la
  stessa lista);
- **P1-3 + P1-6** (proiezione e avvisi della repository);
- **P1-7 + P2-2** (le due rotte di `git-accounts.ts`).

P2-1, P1-8 e P1-9 si rivedono da soli. P1-4 va rivisto da qualcuno che legga
l'invariante «Il ciclo di correzione non si innesca da sé» in CLAUDE.md.

---

## 3. Task

### P2-1 — Riprendere il WIP della Parte 2 e collegarlo a `validateAccount`

**File:** `packages/git/src/bitbucket-scopes.ts` (dal WIP), `bitbucket.ts`,
`bitbucket.test.ts`, `provider.ts`, `index.ts`.

1. `git cherry-pick 7a373ee2` nel worktree di QUESTO branch (non toccare
   `.worktrees/validate-bitbucket-scopes`). Correggere il messaggio con
   `git commit --amend` in `feat(git): scope Bitbucket da x-oauth-scopes` più
   la riga Co-Authored-By. Lanciare subito
   `pnpm --filter @stubwise/git test`: i test nuovi di
   «validateAccount: scope del token» devono essere **ROSSI** (è il test che
   fallisce prima — annotare quali e perché nel messaggio del commit
   successivo).
2. In `BitbucketProvider.validateAccount` (`bitbucket.ts:944`): firma
   `opts: { fetchImpl?; requiredScopes? } = {}`; dentro il `probe` conservare
   la `Response` (variabile locale fuori dalla closure); se lo status è 200,
   restituire `[check, ...bitbucketScopeChecks(r.headers, opts.requiredScopes
   ?? BITBUCKET_PRIMARY_SCOPES)]`. Su ogni altro status, o se `probe` cattura
   un errore di rete, il solo check di prima.
3. D12: sul 403, leggere il corpo (`await r.text()` in try, `JSON.parse` in
   try) e, se c'è `error.detail.required`, aggiungere al dettaglio «mancano
   …». Test: 403 con corpo `{"type":"error","error":{"message":"…","detail":
   {"required":["read:repository:bitbucket"],"granted":["read:user:bitbucket"]}}}`
   → il dettaglio contiene `read:repository:bitbucket` e NON
   `read:user:bitbucket`; 403 con corpo non JSON → dettaglio di oggi.
4. Verificare `GitHubProvider.validateAccount`: accetta l'opzione (stesso tipo
   dell'interfaccia) e la ignora. Test: con `requiredScopes` passato, l'output è
   identico a senza. Aggiornare i doppi di `GitProvider` che implementano
   `validateAccount` (grep `validateAccount` nei test di server/worker): il
   campo è opzionale, quindi di norma non serve, ma il typecheck lo conferma.
5. Test esistente `"200: check ok…"`: nel WIP aspetta 2 check (header assente
   → «Scope del token»). Tenerlo.

**Mutazioni** (ognuna rossa):
- in `bitbucketScopeChecks`, `missing.length === 0` → `missing.length >= 0`
  (gruppo sempre ok);
- togliere `.toLowerCase()` da `parseBitbucketScopes` (rosso il test
  «formattazione varia»);
- `credentialType !== "api_token" || granted === null` → solo
  `granted === null` (rosso il test app password);
- in `validateAccount`, chiamare i check anche su status ≠ 200 (rosso «risposta
  non 2xx»);
- default `?? BITBUCKET_REVIEWER_SCOPES` invece del principale (rosso il test
  «token completo, validato come principale»: sparisce il gruppo webhook);
- D12: non sottrarre `granted` (rosso: compare `read:user:bitbucket`).

`pnpm --filter @stubwise/git build` alla fine (server e worker leggono `dist`).

---

### P1-1 — Migrazione 0082 e schema drizzle

**File:** `packages/db/drizzle/0082_default_reviewer.sql`,
`packages/db/drizzle/meta/_journal.json` (voce idx 82, `when` > 0081),
`packages/db/src/schema.ts` (`gitAccounts`), test nuovo
`packages/db/src/migration-0082.test.ts`.

SQL (un solo batch, nessun enum, nessun backfill — il default è il backfill
corretto: oggi nessun account è predefinito):

```sql
ALTER TABLE "git_accounts" ADD COLUMN "is_default_reviewer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "git_accounts_default_reviewer_scope_uq" ON "git_accounts" USING btree ("provider",(CASE WHEN "provider" = 'bitbucket' THEN COALESCE("workspace", '') ELSE '' END)) WHERE "is_default_reviewer";
```

Drizzle: `isDefaultReviewer: boolean("is_default_reviewer").notNull().default(false)`
e, nel terzo argomento di `pgTable`, `uniqueIndex(...).on(table.provider,
sql\`(CASE …)\`).where(sql\`${table.isDefaultReviewer}\`)`, con un commento che
rimanda a `reviewScopeKey` (P1-2) e a D1.

**Test (testcontainers, schema dello stesso stile di `migration-0081.test.ts`
per la catena fino alla 0081, poi lo SQL reale della 0082):**
1. *(fallisce prima: la colonna non esiste)* righe esistenti dopo la 0082
   hanno `is_default_reviewer = false`.
2. Due Bitbucket predefiniti nello STESSO workspace → `23505`
   (`expectSqlState`).
3. Due Bitbucket predefiniti in workspace DIVERSI → ok.
4. Due Bitbucket predefiniti con workspace entrambi NULL → `23505` (COALESCE).
5. Due GitHub predefiniti, uno con `workspace` NULL e uno con `workspace =
   'acme'` → `23505` (D1: su GitHub il workspace non conta).
6. Un GitHub e un Bitbucket predefiniti → ok.
7. Due account NON predefiniti nello stesso ambito → ok (indice parziale).

**Mutazioni:** togliere il `CASE` (indice su `(provider, workspace)`) → rossi
4 e 5; togliere il `WHERE` → rosso 7.

---

### P1-2 — `resolveReviewAccount`: una sola regola

**File nuovo:** `packages/notifications/src/review-account.ts` (+ export in
`index.ts`), test `review-account.test.ts`.

```ts
/** L'ambito di un account per il predefinito: D1. Gemello dell'indice della 0082. */
export function reviewScopeKey(a: { provider: GitProviderKind; workspace: string | null }): string;

export type ReviewAccountSource = "explicit" | "default";

/** Regola pura (D2). `defaults` = TUTTI gli account con is_default_reviewer. */
export function pickReviewAccount<A extends { id: string; provider: GitProviderKind; workspace: string | null }>(input: {
  main: A;
  explicit: A | null;
  defaults: readonly A[];
}): { effective: { account: A; source: ReviewAccountSource } | null; skippedDefault: A | null };

/** Batch: una query per repository+principale+esplicito, una per i predefiniti. */
export async function resolveReviewAccounts(db: Db, repositoryIds: readonly string[]):
  Promise<Map<string, ReturnType<typeof pickReviewAccount<GitAccountRow>>>>;

/** Una repository: `resolveReviewAccounts(db, [id]).get(id)`; null se la repository non esiste. */
export async function resolveReviewAccount(db: Db, repositoryId: string): Promise<…>;
```

Restituisce le RIGHE `git_accounts` intere (servono credenziali e
`providerUserId` ai consumatori), mai serializzate così come sono: le
proiezioni pubbliche prendono solo `id`/`name`.

`pickReviewAccount`:
- `explicit` non null → `{ account: explicit, source: "explicit" }`,
  `skippedDefault: null` (il predefinito non si guarda: se ce n'è uno uguale al
  principale, non è «saltato», è irrilevante);
- altrimenti cerca in `defaults` quello con `reviewScopeKey` uguale al
  principale; se `id === main.id` → `effective: null, skippedDefault: quello`;
  se c'è e diverso → `source: "default"`; se non c'è → tutto null.

**Test (prima che il file esista: rossi per import):**
1. esplicito vince sul predefinito;
2. nessun esplicito, predefinito nello stesso workspace Bitbucket → default;
3. predefinito in un ALTRO workspace Bitbucket → null;
4. predefinito GitHub, principale GitHub con `workspace` valorizzato diverso →
   default (D1);
5. predefinito = principale → `effective: null`, `skippedDefault` = lui;
6. predefinito di un altro provider → null;
7. `reviewScopeKey` e indice d'accordo: test di DB in `resolveReviewAccounts`
   che inserisce gli account dei casi 2-5 e verifica che dove l'indice accetta
   due predefiniti la regola ne trovi al più uno per principale (proprietà sui
   casi enumerati, non una copia della CASE);
8. `resolveReviewAccounts` con 3 repository di ambiti diversi → mappa corretta
   per ciascuna, e (spia su `db`, o conteggio query via logger drizzle) DUE
   query, non 2N;
9. repository inesistente → assente dalla mappa / `resolveReviewAccount` null.

**Mutazioni:** in `pickReviewAccount` togliere il controllo `id === main.id`
(rosso 5); confrontare `provider` soltanto (rosso 3); far vincere il
predefinito sull'esplicito (rosso 1); `reviewScopeKey` che usa il workspace
anche su GitHub (rosso 4).

Ribuilda `@stubwise/notifications` (e `@stubwise/db` da P1-1).

---

### P1-3 — Campi derivati nella proiezione della repository

**File:** `packages/shared/src/schemas/project.ts` (`repositorySchema`,
`gitAccountSchema`), test accanto (`project.test.ts`);
`apps/server/src/routes/repositories.ts` (`toPublicRepository` e i quattro
punti che la chiamano); `apps/server/src/routes/git-accounts.ts`
(`toPublicAccount`); test `repositories.test.ts`, `git-accounts.test.ts`.

Schemi (tutti additivi):

```ts
// repositorySchema
effectiveReviewAccount: z.object({ id: z.uuid(), name: z.string().min(1),
  source: z.enum(["explicit", "default"]) }).nullable().default(null),
skippedDefaultReviewAccount: z.object({ id: z.uuid(), name: z.string().min(1) })
  .nullable().default(null),
// gitAccountSchema
isDefaultReviewer: z.boolean().default(false),
```

Server: `toPublicRepository(row, gitAccountName, review)` dove `review` viene
da `resolveReviewAccounts` — UNA chiamata per la lista (tutte le repository
della risposta), una per GET/POST/PATCH singoli. Mai calcolato nel client.

**Test:**
1. *(prima)* `repositorySchema.parse` di una risposta SENZA i due campi →
   entrambi `null`; `gitAccountSchema.parse` senza `isDefaultReviewer` →
   `false` (regola «solo cambi additivi»);
2. GET `/api/repositories` con tre repository: esplicito, predefinito, nessuno
   → `source` corretti e nomi; una quarta col predefinito = principale →
   `effectiveReviewAccount: null`, `skippedDefaultReviewAccount` valorizzato;
3. GET `/:slug`, POST e PATCH portano gli stessi campi;
4. `GET /api/git-accounts` porta `isDefaultReviewer`;
5. nessun campo `encryptedCredentials`/`providerUserId` nei sotto-oggetti
   (asserzione sulle chiavi esatte).

**Mutazioni:** derivare `source` sempre `"explicit"`; passare
`effectiveReviewAccount: null` nella lista (rosso 2, non 3: verifica che la
lista non sia scoperta).

---

### P1-4 — Webhook: il predefinito conta come account proprio (INVARIANTE)

**File:** `apps/server/src/services/pr-correction-webhook.ts` (punto 2,
righe ~213-280); test `pr-correction-webhook.test.ts`.

Sostituzione: la select del punto 1 non prende più
`repositories.reviewGitAccountId`; dopo il controllo `pr_not_open`,
`const review = await resolveReviewAccount(db, repositoryId)` e
`accountIds = [row.gitAccountId, ...(review?.effective ? [review.effective.account.id] : [])]`.
Le righe degli account si possono prendere da `resolveReviewAccount` invece
che rileggere (la principale va comunque caricata: è in `accounts` per il
punto 2b). Il resto del fail-closed non cambia: per OGNI id in lista,
identità `null` → `identity_unresolved` con l'avviso sul ticket.

**Test NEGATIVO — il primo da scrivere, rosso prima della modifica:**
repository con principale P, nessun revisore esplicito, account D predefinito
nello stesso workspace (provider_user_id di D in cache). Evento
`changes_requested` con `actorId = D.providerUserId` →
- esito `own_account`;
- `select count(*) from pr_corrections where repository_id = …` → **0**;
- `select count(*) from ai_jobs where correction_id is not null` → **0**.
Accanto, il verso positivo con gli STESSI dati: lo stesso evento da un terzo
(T, permesso `write`) → 1 riga in `pr_corrections` (così lo zero sopra non può
essere una query rotta). Oggi il negativo è rosso: D non è in `accountIds`,
l'evento passa come umano.

Altri test:
2. predefinito con identità NON risolvibile (token che risponde 403, nessuna
   cache) → `identity_unresolved`, 0 righe, un commento di sistema sul ticket
   col nome di D (stessa forma di oggi per l'esplicito);
3. repository con esplicito E (diverso da D) → `accountIds` = P, E: un evento
   di D su quella repository NON è `own_account` (D6), e un'identità non
   risolvibile di D NON scarta l'evento — asserire che `fetchPlatformIdentity`
   non viene chiamata per D;
4. predefinito = principale → lista con il solo P (nessun duplicato, nessuna
   doppia risoluzione).

**Mutazioni:** tornare a leggere solo la colonna esplicita (rosso il
negativo); includere il predefinito anche quando c'è l'esplicito (rosso 3);
saltare un account con identità null invece di uscire (rosso 2).

---

### P1-5 — Worker: pubblicazione della review e fotografia dei commenti

**File:** `apps/worker/src/review/cycle.ts` (`loadReviewerProject`, :183);
`apps/worker/src/pipeline/correction.ts` (:704-731); test
`apps/worker/src/review/cycle.test.ts`, `apps/worker/src/pipeline/correction.test.ts`.

- `loadReviewerProject`: `const r = await resolveReviewAccount(deps.db,
  repositoryId)`; `r?.effective` null → `null`; altrimenti decifra le
  credenziali di `r.effective.account` come oggi. Il log del ripiego nomina la
  fonte (`explicit`/`default`).
- `correction.ts`: `reviewerAccount = (await resolveReviewAccount(db,
  row.repository.id))?.effective?.account`; `accounts: [row.account,
  ...(reviewerAccount ? [reviewerAccount] : [])]`.

**Test:**
1. *(prima)* cycle: repository senza esplicito, predefinito D →
   `submitPrReview` chiamato con le credenziali di D (asserire sul token
   passato al doppio del provider, non sul solo fatto che sia chiamato);
2. cycle: predefinito = principale → pubblica col principale (commento), come
   senza revisore;
3. cycle: esplicito E e predefinito D → credenziali di E;
4. *(prima)* correction: un commento della PR scritto da D (predefinito)
   NON entra in `provider_feedback` (asserire sulla colonna di
   `pr_corrections` dopo la rilettura), mentre quello di un terzo sì.

**Mutazioni:** in `loadReviewerProject` ignorare `source: "default"` (rosso 1);
in `correction.ts` passare solo `[row.account]` (rosso 4).

---

### P1-6 — Form della repository: avviso sul predefinito che diventa effettivo

**File:** `packages/shared/src/schemas/project.ts` (`repositoryWarningSchema`),
`apps/server/src/routes/repositories.ts` (POST e PATCH), test.

`repositoryWarningSchema` guadagna `"default_review_account_invalid"`. Valore
nuovo in un enum di risposta: lo legge solo il web (cast; l'avviso ignoto non
rompe niente) — l'app non salva repository. Additivo.

Regola: dopo il salvataggio, se `effectiveReviewAccount.source === "default"`
e la richiesta ha cambiato COSA va verificato (creazione; cambio di
principale; cambio di `repoUrl`/`defaultBranch`; esplicito appena tolto),
`checkReviewAccount(verifyRemote: true)` sul predefinito; un esito ko →
avviso `default_review_account_invalid` (più il `code` del check nel log).
**Non bloccante**: l'admin non ha scelto quell'account qui, e senza l'opzione
«nessuno» un blocco renderebbe la repository non salvabile.

Invariati e coperti da test di non regressione: la validazione bloccante
dell'esplicito (`checkReviewAccount` come oggi), le guardie nel WHERE del
PATCH (C5), il CHECK (C8).

**Test:**
1. *(prima)* POST senza revisore, con predefinito D senza scrittura (doppio
   del provider: `no_write_permission`) → 201, `warnings` contiene
   `default_review_account_invalid`, la riga c'è;
2. PATCH che cambia solo il nome → nessuna chiamata di rete (spia su
   `validateCredentials`);
3. PATCH che toglie l'esplicito con un predefinito valido → nessun avviso,
   `effectiveReviewAccount.source === "default"`;
4. non regressione: esplicito = principale → 400 `review_account_same_as_main`;
   inserimento diretto che violi il CHECK → `23514`.

**Mutazioni:** rendere bloccante l'avviso (rosso 1); verificare a ogni PATCH
(rosso 2).

---

### P1-7 — Rotte del predefinito

**File:** `apps/server/src/routes/git-accounts.ts`; test `git-accounts.test.ts`.

`PUT /api/git-accounts/:id/default-reviewer` (admin):
1. account esiste (404);
2. Bitbucket senza workspace → 422 `default_reviewer_workspace_missing`;
3. credenziali → 400 `credentials_undecryptable`;
4. identità `resolveProviderUserId(refresh: true)` null → 422
   `review_account_identity_unresolved` (messaggio con il suggerimento sullo
   scope `read:user:bitbucket`, come `checkReviewAccount`);
5. `validateAccount(..., { requiredScopes: BITBUCKET_REVIEWER_SCOPES })`: un
   check ko → 422 `default_reviewer_invalid` coi dettagli;
6. transazione: `update … set is_default_reviewer = false where ambito = …
   and id <> :id returning id, name` (→ `replaced`), poi `set true where id`;
   `isUniqueViolation` → 409 `default_reviewer_conflict`;
7. DOPO il commit, gli avvisi di D5: per le repository dove ora è effettivo
   (`resolveReviewAccounts` sulle repository dell'ambito),
   `checkReviewAccount(verifyRemote: true)` con concorrenza 4; più quelle in
   cui è saltato (D3). Risposta:
   `{ account, replaced, warnings: [{ repositoryId, repositoryName, code }] }`
   con `code` ∈ `default_is_main` | i codici di `checkReviewAccount`.

`checkReviewAccount` va estratto in `apps/server/src/services/review-account-check.ts`
(da `routes/repositories.ts`) per essere usato da entrambe le rotte: nessun
cambio di comportamento, i test esistenti del form restano verdi senza
toccarli.

`DELETE /api/git-accounts/:id/default-reviewer` (admin): idempotente, 204.

`PATCH /api/git-accounts/:id`: workspace diverso su un account predefinito →
409 `default_reviewer_workspace_locked` (D7).

**Test:**
1. *(prima)* PUT su un account valido → 200, flag in DB true, `replaced: null`;
2. PUT su un secondo account dello stesso ambito → `replaced` = il primo; in
   DB un solo flag;
3. identità non leggibile → 422 e flag in DB **invariato** (asserzione sulla
   colonna, non solo sullo status);
4. scope del revisore mancanti (header senza `write:pullrequest:bitbucket`) →
   422; header assente (app password) → 200 (D10: non verificabile ≠ ko);
5. repository dell'ambito in cui il predefinito non ha scrittura → 200 con
   avviso per QUELLA repository; repository in cui è il principale → avviso
   `default_is_main`;
6. `member` → 403 e flag invariato;
7. DELETE → flag false; DELETE ripetuto → 204;
8. PATCH workspace su un predefinito → 409, workspace invariato.

**Mutazioni:** saltare il passo 6a (rosso 2 per `23505` o per due flag);
rendere bloccante l'avviso per repository (rosso 5); passare l'insieme del
principale a `validateAccount` (rosso 4: ko sui webhook).

---

### P2-2 — Validate: ruolo calcolato dal server

**File:** `apps/server/src/routes/git-accounts.ts` (`POST /:id/validate`);
test `git-accounts.test.ts`.

Prima di `validateAccount`, solo per Bitbucket:
`primary` = `exists(select 1 from repositories where git_account_id = id)`;
`reviewer` = `row.isDefaultReviewer || [...resolveReviewAccounts(db, idsDelleRepositoryDelloStessoProvider)].some(r => r.effective?.account.id === id)`
(D9). `requiredScopes = bitbucketRequiredScopes({ primary, reviewer })`.
Nessuna scrittura, nessuna chiamata in più al provider. La risposta
(`validateResponseSchema`) non cambia forma: i check nuovi sono altri elementi
di `checks`, e il web li disegna già.

**Test (header `x-oauth-scopes` simulato):**
1. *(prima)* account solo revisore esplicito, token senza webhook → `ok: true`,
   nessun check «Scope webhook»;
2. stesso token, account principale di una repository → `ok: false`, check
   webhook che nomina `read:webhook:bitbucket` e `write:webhook:bitbucket`;
3. account predefinito effettivo su una repository, nessun esplicito → come 1
   (il predefinito conta: è il punto della Parte 1);
4. account predefinito senza repository nell'ambito → come 1 (D9);
5. predefinito saltato ovunque (è il principale) e mai revisore → insieme del
   principale;
6. account mai usato → insieme del principale;
7. token senza `read:user:bitbucket` → check identità ko col testo «i Request
   changes da Bitbucket vengono scartati»;
8. GitHub → output invariato rispetto a oggi.

**Mutazioni:** `reviewer` dalla sola colonna esplicita (rosso 3); togliere
`row.isDefaultReviewer` (rosso 4); `primary` sempre true (rosso 1).

---

### P1-8 — Web

**File:** `apps/web/src/lib/api.ts` (tipi `Repository`, `GitAccount`, client
delle due rotte nuove), `apps/web/src/components/git-accounts-section.tsx`,
`apps/web/src/components/repository-form.tsx`, `apps/web/src/i18n/locales/{en,it}.json`,
test `git-accounts-section.test.tsx`, `repository-form.test.tsx`; E2E in
`apps/web/e2e/core-flows.spec.ts` (o uno spec nuovo).

- Tipi: `effectiveReviewAccount?`, `skippedDefaultReviewAccount?`,
  `isDefaultReviewer?` **opzionali** (il web fa un cast, non parsa); letti
  `?? null` / `?? false` nel punto di lettura.
- Account git: un toggle «Revisore predefinito» per account, solo admin.
  Accenderlo su un ambito che ne ha già uno chiede conferma («sostituisce
  <nome>»). Dopo la risposta: gli avvisi per repository in un elenco sotto
  l'account (nome repository + testo del codice), gli errori 422 col
  messaggio del server.
- Form repository: con il select del revisore VUOTO, sotto il campo:
  «Revisore: predefinito (<nome>)» se `effectiveReviewAccount?.source ===
  "default"`; «Revisore: nessuno — il predefinito (<nome>) è l'account
  principale di questa repository» se `skippedDefaultReviewAccount`;
  altrimenti «Revisore: nessuno». L'etichetta dell'opzione vuota del select
  passa da «Nessuno» a «Predefinito» (`reviewAccountNone` → testo nuovo).
  Attenzione: la scritta descrive lo stato SALVATO; se l'utente cambia il
  principale nel form senza salvare, la scritta si nasconde (non si
  ricalcola nel client: D8).
- Avviso `default_review_account_invalid` dopo un salvataggio, accanto a
  quello esistente `main_account_identity_unresolved`.
- Validate: nessun cambio di codice atteso (i check sono in più nella stessa
  lista); verificarlo con un test che renderizza 4 check.

**Test:**
1. *(prima)* form con `effectiveReviewAccount: {source: "default", name:
   "pr-bot"}` e select vuoto → «predefinito (pr-bot)»;
2. fixture **SENZA** i campi nuovi → «Revisore: nessuno», nessuna eccezione
   (la fixture va lasciata senza campi apposta: è la prova del `?? null`);
3. `skippedDefaultReviewAccount` → testo del caso saltato;
4. toggle: chiama `PUT …/default-reviewer`, mostra `replaced` e gli avvisi;
   fixture account senza `isDefaultReviewer` → toggle spento;
5. un `member` non vede il toggle.

**E2E** (mock di rete come gli altri spec): imposta il predefinito da
Impostazioni → Account git, apre una repository senza revisore e legge
«predefinito (<nome>)».

**Mutazioni:** leggere `effectiveReviewAccount.source` senza `?.` (rosso 2,
eccezione); dedurre il predefinito dalla lista account nel client invece che
dal campo (un test con la lista account che dice altro dal campo lo rende
rosso).

---

### P1-9 — CLAUDE.md, guida utente, changeset

**CLAUDE.md, voce di deploy** «Revisore predefinito e scope di Validate (1 ott
2026)», da scrivere con questi fatti (verificarli sul codice finito):
- rebuild **server + worker + caddy**; ordine consigliato: prima `server`
  (applica la 0082), poi `worker caddy` — un worker nuovo avviato prima della
  migrazione fallisce la risoluzione (colonna assente) e la review di quel
  momento ricade sul ripiego; l'app si aggiorna dagli store;
- migrazione **0082** additiva: colonna `git_accounts.is_default_reviewer`
  (default false, nessun backfill: al deploy nessun predefinito, nessun
  comportamento cambia) e indice unico parziale per ambito (D1); nessun enum,
  nessuna env, nessun kind di notifica; un valore nuovo in
  `repositoryWarningSchema` (letto solo dal web);
- passo post-deploy facoltativo: impostare il predefinito e rilanciare
  Validate sugli account Bitbucket (ora segnala gli scope mancanti);
- **rollback — il server NON è innocuo, il worker sì**, da verificare
  leggendo le due versioni: con **server vecchio e worker nuovo** il worker
  pubblica con il predefinito, ma il webhook vecchio considera propri solo
  principale ed esplicito → il «Request changes» del predefinito passa come
  richiesta UMANA, azzera la serie e il ciclo riparte **all'infinito** (il
  tetto conta i giri dopo l'ultima richiesta umana). Con **worker vecchio** il
  predefinito non pubblica niente: nessun ciclo, le PR tornano senza revisore.
  Prima di scendere sul server, una delle due:
  (a) materializzare il predefinito come esplicito (mantiene il revisore,
  ma da lì in poi cambiare il predefinito non tocca più quelle repository):
  ```sql
  update repositories r set review_git_account_id = d.id
  from git_accounts m, git_accounts d
  where r.git_account_id = m.id and r.review_git_account_id is null
    and d.is_default_reviewer and d.provider = m.provider
    and (m.provider <> 'bitbucket' or coalesce(d.workspace,'') = coalesce(m.workspace,''))
    and d.id <> m.id;
  ```
  (b) togliere il predefinito (`update git_accounts set is_default_reviewer =
  false;`) e scendere server E worker insieme. In entrambi i casi il caddy
  scende col server. La colonna e l'indice sopravvivono; il migratore ignora
  la 0082 già applicata;
- per spegnere senza toccare immagini: togliere il predefinito dalla UI.

**CLAUDE.md, invariante** «Il revisore effettivo si risolve in UN posto»:
`resolveReviewAccount`/`pickReviewAccount` (`packages/notifications/src/review-account.ts`);
chi legge `review_git_account_id` direttamente rompe il filtro anti-auto-innesco
(il test negativo di P1-4 è la guardia); `reviewScopeKey` e l'indice della 0082
sono gemelli; il predefinito = principale si scarta; il CHECK resta sulla sola
colonna esplicita; account propri = principale + effettivo (D6). Aggiornare
anche l'invariante «Il ciclo di correzione non si innesca da sé» (oggi dice
«l'account revisore della repository»: diventa «revisore EFFETTIVO, esplicito
o predefinito»).

**Guida** `apps/docs/src/content/docs/ai-pipeline/automation.md`, sezione
«The reviewer account (optional)»: il predefinito (dove si imposta, ambito,
cosa vince, caso del principale, avvisi); una riga su Validate che ora
controlla gli scope Bitbucket per ruolo e cosa dice con un'app password.

**Changeset:** `@stubwise/shared` **minor** (campi nuovi negli schemi).

---

### P1-10 — Verifica finale

`pnpm typecheck`, `pnpm lint` (la CI fallisce su lint anche con il resto
verde), test di `@stubwise/db`, `@stubwise/git`, `@stubwise/notifications`,
`@stubwise/shared`, `@stubwise/server`, `@stubwise/worker`, `@stubwise/web`;
E2E web a mano (`apps/web/e2e`). Catturare l'esito PRIMA di filtrare l'output
(`| tail` riporta l'esito di tail). Rifare il grep dei consumatori: nessuna
lettura di `reviewGitAccountId` fuori da `review-account.ts`, dalla proiezione
e dalle rotte che SCRIVONO la colonna. `graphify update .` dopo il codice.

---

## 4. Dubbi aperti per il coordinatore

1. **D6** (account propri = principale + effettivo, non ogni predefinito):
   chiude il ciclo e non allarga il fail-closed, ma lascia una finestra di
   secondi se il predefinito cambia fra pubblicazione e webhook. Accettabile?
2. **D9** (il flag conta come ruolo revisore anche senza repository) devia
   dalla lettera della richiesta.
3. **D5**: la scrittura per repository è un avviso, non un blocco. Se si
   preferisce bloccare, serve l'opzione «nessun revisore» per repository, che
   l'utente ha escluso.
4. Validate è `POST`, non `GET`: il piano non lo cambia.
5. Ordine di deploy server→worker: un compose `up` dei due insieme apre una
   finestra di secondi in cui un worker nuovo legge una colonna che non c'è.
   In alternativa si può rendere `resolveReviewAccounts` tollerante (codice in
   più per un caso di secondi): il piano non lo fa.
