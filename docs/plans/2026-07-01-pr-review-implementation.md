# PR Review — piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automazione "PR Review": ad ogni PR aperta/aggiornata su un repo collegato, un agente AI read-only analizza il diff nel contesto del codebase e pubblica verdetto + analisi (commento sticky sulla PR, commento AI sul ticket, notifica).

**Architecture:** Webhook esistente esteso con eventi PR opened/updated → coda con debounce `pr_review_jobs` (pattern `doc_auto_update_jobs`, claim `DELETE...RETURNING`) → poller del worker dentro il `ProjectSerializer` → worktree detached alla head della PR → agente claude CLI in permission-mode `plan` → pubblicazione su PR/ticket/notifiche. Le PR esterne generano un ticket di tipo `review` (nuovo enum value, `auto_fix=false` per evitare loop); le PR di Stubwise commentano il ticket esistente. Storico in `pr_reviews`, costi in `agent_runs` (esteso con `pr_review_id`).

**Tech Stack:** Drizzle/Postgres (pgvector image nei test), Fastify+Zod, Vitest (testcontainers per server/worker/db, happy-dom per web), React+TanStack Query, claude CLI via `AgentRunner`.

**Design di riferimento:** `docs/plans/2026-07-01-pr-review-automation-design.md`

**Convenzioni trasversali** (valgono per OGNI task):
- TDD: prima il test, verifica che fallisca, poi l'implementazione minima, verifica che passi, commit.
- Commenti in italiano, stile del file circostante (i file esistenti hanno docblock ricchi che spiegano i "perché").
- Dopo ogni task: commit con messaggio `feat(scope): ...` o `test(scope): ...`.
- A fine piano: `pnpm typecheck && pnpm lint && pnpm test` dalla radice (la CI fallisce su lint anche con test verdi).
- I test con testcontainers sono lenti (~2 min di bootstrap): lancia il singolo file con `pnpm --filter @stubwise/<pkg> test -- <file>` durante lo sviluppo.

---

## Task 1: tipo ticket `review` in shared + guardia sul triage

Il nuovo valore enum non deve permettere al triage AI di classificare ticket normali come `review`.

**Files:**
- Modify: `packages/shared/src/schemas/ticket.ts:13`
- Modify: `apps/worker/src/pipeline/prompts.ts:570-581`
- Test: `packages/shared/src/schemas/ticket.test.ts` (se esiste; altrimenti verifica via typecheck), `apps/worker/src/pipeline/prompts.test.ts` (esistente, aggiungi caso)

**Step 1: aggiorna l'enum condiviso**

In `packages/shared/src/schemas/ticket.ts` riga 13:

```ts
export const ticketTypeSchema = z.enum(["bug", "feature", "task", "feedback", "review"]);
```

**Step 2: scrivi il test della guardia triage**

In `apps/worker/src/pipeline/prompts.test.ts`, nel describe del parsing del triage, aggiungi:

```ts
it("rifiuta 'review' come tipo prodotto dal triage (riservato all'automazione PR Review)", () => {
  const raw = JSON.stringify({ decision: "fix", type: "review", effort: 2 });
  expect(() => parseTriageOutput(raw)).toThrow();
});
```

(Adatta il nome della funzione di parsing a quello reale esportato da `prompts.ts` — è quella che valida con gli `z.strictObject` alle righe 570-581.)

**Step 3: verifica che fallisca**

Run: `pnpm --filter @stubwise/worker test -- prompts`
Expected: FAIL — `"review"` ora è accettato da `ticketTypeSchema`.

**Step 4: introduci lo schema ristretto nel triage**

In `apps/worker/src/pipeline/prompts.ts`, vicino agli schemi del triage (righe ~565):

```ts
// Il triage riclassifica SOLO i tipi "umani": `review` è riservato ai ticket
// creati dall'automazione PR Review e non deve mai uscire da una classificazione.
const triageTypeSchema = z.enum(["bug", "feature", "task", "feedback"]);
```

Sostituisci `ticketTypeSchema` con `triageTypeSchema` nei tre `z.strictObject` alle righe 570, 575, 581. Il testo del prompt a riga 176 elenca già solo i 4 tipi: non toccarlo.

**Step 5: verifica che passi**

Run: `pnpm --filter @stubwise/worker test -- prompts` → PASS.
Run: `pnpm typecheck` → verde (scova eventuali switch esaustivi su `TicketType` rotti dal nuovo valore: sistemali in questo task se sono banali `Record` — quelli della UI si fanno nel Task 13).

Nota: `pnpm typecheck` FALLIRÀ su `apps/web` per i `Record<TicketType, ...>` in `badges.tsx`. Aggiungi subito le due entry (vedi Task 13 Step 1 per i valori esatti) per tenere il typecheck verde: è un cambio a due righe, il resto della UI resta nel Task 13.

**Step 6: commit**

```bash
git add packages/shared apps/worker/src/pipeline/prompts.ts apps/worker/src/pipeline/prompts.test.ts apps/web/src/components/badges.tsx apps/web/src/i18n/locales
git commit -m "feat(shared): tipo ticket 'review' + guardia sul triage"
```

---

## Task 2: schema DB + migrazioni

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0037_pr_review.sql` (generata)
- Create: `packages/db/drizzle/0038_pr_review_seed.sql` (a mano)
- Modify: `packages/db/drizzle/meta/_journal.json` (entry per la 0038)

**Step 1: aggiungi al Drizzle schema**

In `packages/db/src/schema.ts`:

1. Riga 132, estendi la phase: `export const agentRunPhase = pgEnum("agent_run_phase", ["triage", "fix", "review"]);`

2. In `agentRuns` (righe ~625-650): rendi `jobId` nullable e aggiungi la FK alla review. Sostituisci la definizione di `jobId` e aggiungi `prReviewId`:

```ts
    // Job AI del fix/triage; null per i run dell'automazione PR Review (che
    // referenziano pr_review_id). Esattamente uno dei due è valorizzato.
    jobId: uuid("job_id").references(() => aiJobs.id, { onDelete: "cascade" }),
    // Run dell'automazione PR Review; null per triage/fix.
    prReviewId: uuid("pr_review_id").references(() => prReviews.id, { onDelete: "cascade" }),
```

ATTENZIONE: `prReviews` va definita PRIMA di `agentRuns` nel file (o usa una lazy reference come fanno le altre tabelle: Drizzle accetta `() => prReviews.id` anche se definita dopo — verifica che il file compili). `ticketCostUsd`/`monthlyCostUsd` in `packages/db/src/cost.ts` continuano a funzionare: la prima filtra via inner join su `jobId`, la seconda somma tutto (ed è VOLUTO che le review rientrino nel budget mensile).

3. In `notificationSettings` (dopo `notifyBudgetHeld`, riga ~789):

```ts
  // Notifica al completamento di una PR Review automatica.
  notifyReviewCompleted: boolean("notify_review_completed").notNull().default(true),
```

4. In `instanceSettings` (dopo `monthlyBudgetUsd`, riga ~809):

```ts
  // Automazione PR Review: interruttore globale (default spento) e tetto di
  // costo USD per singola review (null = nessun limite). Il gate vive nel
  // webhook (accodamento) e nel worker (claim + verifica post-run del cap).
  prReviewEnabled: boolean("pr_review_enabled").notNull().default(false),
  prReviewMaxCostUsd: numeric("pr_review_max_cost_usd", { precision: 12, scale: 6 }),
```

5. Nuovi enum + tabelle, dopo `docAutoUpdateJobs` (riga ~1038):

```ts
export const prReviewStatus = pgEnum("pr_review_status", ["running", "completed", "failed"]);
export const prReviewVerdict = pgEnum("pr_review_verdict", ["approve", "request_changes"]);

/**
 * Coda di debounce dell'automazione PR Review (pattern doc_auto_update_jobs):
 * un solo job pending per (repository, PR). Il webhook fa upsert ad ogni
 * opened/synchronize aggiornando head e finestra; il poller del worker reclama
 * con DELETE...RETURNING quando `not_before` è scaduto. I metadati della PR
 * (titolo, corpo, branch) viaggiano nel job così il worker non deve richiamare
 * l'API del provider per costruire il prompt.
 */
export const prReviewJobs = pgTable(
  "pr_review_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    prUrl: text("pr_url").notNull(),
    prTitle: text("pr_title").notNull(),
    prBody: text("pr_body").notNull().default(""),
    sourceBranch: text("source_branch").notNull(),
    targetBranch: text("target_branch").notNull(),
    headSha: text("head_sha").notNull(),
    // Il poller reclama il job solo quando questo istante è scaduto (debounce).
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Un solo pending per (repo, PR): il webhook fa upsert su questo vincolo.
    uniqueIndex("pr_review_jobs_repository_pr_unique").on(table.repositoryId, table.prNumber),
  ],
);

/**
 * Storico delle review eseguite: una riga per run. `ticketId` punta al ticket
 * di Stubwise che ospita l'analisi (quello esistente per le PR aperte dal fix,
 * o il ticket di tipo `review` creato per le PR esterne); set null se il ticket
 * viene eliminato (lo storico sopravvive). `lastActivityAt` è l'heartbeat per
 * il recovery delle righe `running` orfane (riavvio del worker a metà review).
 */
export const prReviews = pgTable(
  "pr_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    prUrl: text("pr_url").notNull(),
    prTitle: text("pr_title").notNull(),
    headSha: text("head_sha").notNull(),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    status: prReviewStatus("status").notNull().default("running"),
    verdict: prReviewVerdict("verdict"),
    // Analisi in markdown prodotta dall'agente (null finché running/failed).
    summary: text("summary"),
    error: text("error"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    // Lookup del ticket riusabile per le re-review della stessa PR.
    index("pr_reviews_repository_pr_idx").on(table.repositoryId, table.prNumber),
  ],
);
```

**Step 2: genera la migrazione**

```bash
cd packages/db && npx drizzle-kit generate --name pr_review
```

Expected: crea `drizzle/0037_pr_review.sql` con `ALTER TYPE "public"."ticket_type" ADD VALUE 'review'`, `ALTER TYPE "public"."agent_run_phase" ADD VALUE 'review'`, i due `CREATE TYPE` nuovi, le due `CREATE TABLE`, gli `ALTER TABLE` su `agent_runs` (drop not null + colonna), `notification_settings` e `instance_settings`. ISPEZIONALA: deve esserci tutto e niente di distruttivo.

**Step 3: scrivi a mano la migrazione di seed (transazione separata)**

Postgres NON permette di usare un valore enum aggiunto nella stessa transazione (`unsafe use of new value`): il seed va in un file separato (il migrator Drizzle esegue ogni file nella sua transazione). Crea `packages/db/drizzle/0038_pr_review_seed.sql`:

```sql
-- Regola di automazione per il tipo `review`: auto_fix SPENTO di default.
-- È l'anti-loop: il ticket creato dall'automazione PR Review non deve
-- innescare la pipeline di fix.
INSERT INTO "automation_rules" ("type", "auto_fix", "max_effort")
VALUES ('review', false, 3)
ON CONFLICT ("type") DO NOTHING;
```

Aggiungi l'entry in `packages/db/drizzle/meta/_journal.json` copiando il formato dell'ultima (idx 38, tag `0038_pr_review_seed`, `when` = timestamp epoch ms attuale, `breakpoints: true`).

**Step 4: aggiorna il fallback delle regole**

In `apps/server/src/routes/settings.ts`, `loadAllRules` (righe ~240-255) riempie i tipi mancanti con `DEFAULT_RULE` (autoFix true). Rendi il default consapevole del tipo:

```ts
// `review` nasce con auto-fix spento anche nel fallback (anti-loop): la riga
// seedata dalla migrazione lo garantisce già, questo copre il DB pre-seed.
const defaultRuleFor = (type: TicketType): Omit<AutomationRule, "type"> =>
  type === "review" ? { ...DEFAULT_RULE, autoFix: false } : DEFAULT_RULE;
```

e usa `defaultRuleFor(type)` dove oggi si usa `DEFAULT_RULE`.

**Step 5: test di migrazione**

I test di `packages/db` applicano le migrazioni su un container pulito: se qualcosa è rotto, esplode lì.

Run: `pnpm --filter @stubwise/db test`
Expected: PASS (le migrazioni si applicano, gli schemi combaciano).

Aggiungi in `packages/db/src` (nel file di test dello schema/migrazioni esistente, cercalo con `ls packages/db/src/*.test.ts`) un test che verifica il seed:

```ts
it("la migrazione seeda automation_rules per 'review' con auto_fix=false", async () => {
  const [row] = await db.select().from(automationRules).where(eq(automationRules.type, "review"));
  expect(row).toBeDefined();
  expect(row!.autoFix).toBe(false);
});
```

Run: `pnpm --filter @stubwise/db test` → PASS.

**Step 6: commit**

```bash
git add packages/db apps/server/src/routes/settings.ts
git commit -m "feat(db): tabelle pr_reviews/pr_review_jobs, enum review, settings PR Review"
```

---

## Task 3: `packages/git` — `prNumber` nel WebhookEvent + `parsePrEvent`

**Files:**
- Modify: `packages/git/src/provider.ts` (tipi + interfaccia)
- Modify: `packages/git/src/github.ts:84-96` (parseWebhook) + nuovo metodo
- Modify: `packages/git/src/bitbucket.ts:102-122` (parseWebhook) + nuovo metodo
- Test: `packages/git/src/github.test.ts`, `packages/git/src/bitbucket.test.ts` (esistenti)

**Step 1: scrivi i test (GitHub)**

In `github.test.ts`, describe nuovo:

```ts
describe("parsePrEvent", () => {
  const provider = new GitHubProvider();
  const payload = (action: string) => ({
    action,
    pull_request: {
      number: 42,
      title: "Add login",
      body: "Implements login flow",
      html_url: "https://github.com/acme/repo/pull/42",
      head: { ref: "feature/login", sha: "a".repeat(40) },
      base: { ref: "main" },
    },
  });
  const headers = { "x-github-event": "pull_request" };

  it("action=opened → kind opened con tutti i campi", () => {
    expect(provider.parsePrEvent(headers, payload("opened"))).toEqual({
      kind: "opened",
      provider: "github",
      prNumber: 42,
      title: "Add login",
      description: "Implements login flow",
      sourceBranch: "feature/login",
      targetBranch: "main",
      headSha: "a".repeat(40),
      prUrl: "https://github.com/acme/repo/pull/42",
    });
  });

  it("action=reopened → opened; synchronize → updated", () => {
    expect(provider.parsePrEvent(headers, payload("reopened"))?.kind).toBe("opened");
    expect(provider.parsePrEvent(headers, payload("synchronize"))?.kind).toBe("updated");
  });

  it("action=closed o evento non-PR → null; body null → null", () => {
    expect(provider.parsePrEvent(headers, payload("closed"))).toBeNull();
    expect(provider.parsePrEvent({ "x-github-event": "push" }, payload("opened"))).toBeNull();
    expect(provider.parsePrEvent(headers, null)).toBeNull();
  });

  it("body PR null → description stringa vuota", () => {
    const p = payload("opened");
    (p.pull_request as { body: unknown }).body = null;
    expect(provider.parsePrEvent(headers, p)?.description).toBe("");
  });
});

it("parseWebhook espone prNumber", () => {
  // adatta il payload closed esistente aggiungendo number: 7 e verifica event.prNumber === 7
});
```

Test analoghi in `bitbucket.test.ts` con header `x-event-key: pullrequest:created|pullrequest:updated` e payload:

```ts
const payload = {
  pullrequest: {
    id: 7,
    title: "Add login",
    description: "Implements login flow",
    source: { branch: { name: "feature/login" }, commit: { hash: "abc123def456" } },
    destination: { branch: { name: "main" } },
    links: { html: { href: "https://bitbucket.org/acme/repo/pull-requests/7" } },
  },
};
```

(Nota: Bitbucket manda hash abbreviati ~12 char: va bene, git li risolve nel mirror.)

**Step 2: verifica che falliscano**

Run: `pnpm --filter @stubwise/git test`
Expected: FAIL — `parsePrEvent` non esiste.

**Step 3: implementa i tipi e l'interfaccia**

In `provider.ts`, accanto a `WebhookEvent` (riga 72):

```ts
export interface WebhookEvent {
  kind: "merged" | "closed_unmerged";
  provider: GitProviderKind;
  /** Source branch della PR. */
  branch: string;
  prUrl: string;
  /** Numero della PR sul provider (GitHub number / Bitbucket id). */
  prNumber: number;
}

/**
 * Evento di apertura/aggiornamento di una PR (automazione PR Review).
 * `opened` copre anche la riapertura; `updated` è un push sulla source branch
 * (GitHub `synchronize`) o una modifica della PR (Bitbucket `pullrequest:updated`,
 * che scatta anche su edit di titolo/descrizione: il debounce assorbe il rumore).
 */
export interface PrActivityEvent {
  kind: "opened" | "updated";
  provider: GitProviderKind;
  prNumber: number;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  prUrl: string;
}
```

Nell'interfaccia `GitProvider` aggiungi, dopo `parseWebhook`:

```ts
  /** Eventi PR opened/updated per l'automazione PR Review; null se non pertinente. */
  parsePrEvent(headers: Record<string, string>, body: unknown): PrActivityEvent | null;
```

**Step 4: implementa GitHub**

In `github.ts`: in `parseWebhook` estrai anche `number` dal payload (`payload.pull_request.number`, deve essere `number`, altrimenti null) e ritorna `prNumber`. Poi:

```ts
  parsePrEvent(headers: Record<string, string>, body: unknown): PrActivityEvent | null {
    if (getHeader(headers, "x-github-event") !== "pull_request") return null;
    if (typeof body !== "object" || body === null) return null;
    const payload = body as { action?: unknown; pull_request?: unknown };
    const kind =
      payload.action === "opened" || payload.action === "reopened"
        ? "opened"
        : payload.action === "synchronize"
          ? "updated"
          : null;
    if (kind === null) return null;
    if (typeof payload.pull_request !== "object" || payload.pull_request === null) return null;
    const pr = payload.pull_request as {
      number?: unknown;
      title?: unknown;
      body?: unknown;
      html_url?: unknown;
      head?: { ref?: unknown; sha?: unknown };
      base?: { ref?: unknown };
    };
    if (
      typeof pr.number !== "number" ||
      typeof pr.title !== "string" ||
      typeof pr.html_url !== "string" ||
      typeof pr.head?.ref !== "string" ||
      typeof pr.head?.sha !== "string" ||
      typeof pr.base?.ref !== "string"
    ) {
      return null;
    }
    return {
      kind,
      provider: "github",
      prNumber: pr.number,
      title: pr.title,
      description: typeof pr.body === "string" ? pr.body : "",
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      headSha: pr.head.sha,
      prUrl: pr.html_url,
    };
  }
```

**Step 5: implementa Bitbucket**

In `bitbucket.ts`: in `parseWebhook` estrai `pullrequest.id` (number) → `prNumber`. Poi `parsePrEvent` con lo stesso stile difensivo: event key `pullrequest:created` → opened, `pullrequest:updated` → updated; campi da `pullrequest.{id,title,description,source.branch.name,source.commit.hash,destination.branch.name,links.html.href}` (description mancante → `""`).

**Step 6: verifica che passino, poi sistema i chiamanti**

Run: `pnpm --filter @stubwise/git test` → PASS.
Run: `pnpm typecheck` — i test/fixture del server che costruiscono payload PR closed senza `number`/`id` falliranno a runtime (parseWebhook ora ritorna null senza numero): aggiorna gli helper `githubPayload`/`bitbucketPayload`/`githubClosedUnmergedPayload`/`bitbucketRejectedPayload` in `apps/server/src/routes/webhooks.test.ts:320-366` aggiungendo `number: 7` / `id: 7`.

Run: `pnpm --filter @stubwise/server test -- webhooks` → PASS (comportamento invariato).

**Step 7: commit**

```bash
git add packages/git apps/server/src/routes/webhooks.test.ts
git commit -m "feat(git): parsePrEvent (opened/updated) e prNumber nel WebhookEvent"
```

---

## Task 4: `packages/git` — `getPullRequestState` + `upsertPrComment`

**Files:**
- Modify: `packages/git/src/provider.ts`, `github.ts`, `bitbucket.ts`
- Test: `github.test.ts`, `bitbucket.test.ts`

I test dei provider usano `fetchImpl` iniettabile (vedi `GitProviderOptions` e i test esistenti di `openPullRequest`): mocka `fetch` così.

**Step 1: scrivi i test (GitHub, analoghi per Bitbucket)**

```ts
describe("getPullRequestState", () => {
  it("state=open → 'open'; state=closed → 'closed'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { state: "open" }));
    const provider = new GitHubProvider({ fetchImpl });
    await expect(provider.getPullRequestState(CONFIG, 42)).resolves.toBe("open");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/repo/pulls/42",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("upsertPrComment", () => {
  const MARKER = "<!-- stubwise-pr-review -->";
  it("nessun commento col marker → POST di un nuovo commento", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, [{ id: 1, body: "altro" }])) // list
      .mockResolvedValueOnce(jsonResponse(201, { id: 2 })); // create
    const provider = new GitHubProvider({ fetchImpl });
    await provider.upsertPrComment(CONFIG, 42, MARKER, `${MARKER}\nAnalisi`);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/acme/repo/issues/42/comments",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("commento col marker esistente → PATCH dello stesso commento", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, [{ id: 9, body: `${MARKER}\nvecchia` }]))
      .mockResolvedValueOnce(jsonResponse(200, { id: 9 }));
    const provider = new GitHubProvider({ fetchImpl });
    await provider.upsertPrComment(CONFIG, 42, MARKER, `${MARKER}\nnuova`);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/acme/repo/issues/comments/9",
      expect.objectContaining({ method: "PATCH" }),
    );
  });
});
```

Bitbucket: state `OPEN` → open, `MERGED`/`DECLINED`/`SUPERSEDED` → closed; commenti su `GET/POST /2.0/repositories/{owner}/{repo}/pullrequests/{n}/comments` (lista in `values[]`, testo in `content.raw`, update con `PUT .../comments/{id}`), auth Basic come `ensureWebhook` (bitbucket.ts:381-389).

**Step 2: verifica che falliscano** → `pnpm --filter @stubwise/git test` FAIL.

**Step 3: interfaccia**

In `provider.ts`, dentro `GitProvider`:

```ts
  /** Stato attuale della PR: 'open' se ancora aperta, 'closed' se mergiata/chiusa. */
  getPullRequestState(
    p: ProjectGitConfig,
    prNumber: number,
    opts?: { fetchImpl?: FetchLike }
  ): Promise<"open" | "closed">;
  /**
   * Crea o aggiorna il commento "sticky" della review sulla PR: se esiste già
   * un commento che contiene `marker` lo aggiorna, altrimenti ne crea uno.
   */
  upsertPrComment(
    p: ProjectGitConfig,
    prNumber: number,
    marker: string,
    body: string,
    opts?: { fetchImpl?: FetchLike }
  ): Promise<void>;
```

**Step 4: implementa (GitHub)**

```ts
  async getPullRequestState(
    p: ProjectGitConfig,
    prNumber: number,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<"open" | "closed"> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const response = await fetchImpl(`${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${p.credentials.token}`,
        Accept: "application/vnd.github+json",
      },
    });
    await ensureOkResponse(response, "GitHub");
    const data = (await readJsonResponse(response, "GitHub")) as { state?: unknown };
    return data.state === "open" ? "open" : "closed";
  }

  async upsertPrComment(
    p: ProjectGitConfig,
    prNumber: number,
    marker: string,
    body: string,
    opts: { fetchImpl?: FetchLike } = {}
  ): Promise<void> {
    const fetchImpl = opts.fetchImpl ?? this.fetchImpl;
    const { owner, repo } = parseRepoUrl(p.repoUrl);
    const headers = {
      Authorization: `Bearer ${p.credentials.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };
    // Una pagina da 100 basta: il commento sticky è tra i primi della PR.
    const listResponse = await fetchImpl(
      `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
      { method: "GET", headers },
    );
    await ensureOkResponse(listResponse, "GitHub");
    const list = (await readJsonResponse(listResponse, "GitHub")) as { id?: unknown; body?: unknown }[];
    const existing = Array.isArray(list)
      ? list.find((c) => typeof c.body === "string" && c.body.includes(marker))
      : undefined;
    const target =
      existing && typeof existing.id === "number"
        ? { url: `${API_BASE}/repos/${owner}/${repo}/issues/comments/${existing.id}`, method: "PATCH" }
        : { url: `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`, method: "POST" };
    const response = await fetchImpl(target.url, {
      method: target.method,
      headers,
      body: JSON.stringify({ body }),
    });
    await ensureOkResponse(response, "GitHub");
  }
```

Bitbucket speculare: body `{ content: { raw: body } }`, lista `GET .../pullrequests/{n}/comments?pagelen=100` → `values[]` con `content.raw`, update `PUT .../comments/{id}`.

**Step 5: verifica che passino** → `pnpm --filter @stubwise/git test` PASS.

**Step 6: commit** — `feat(git): getPullRequestState e upsertPrComment (sticky) per PR Review`

---

## Task 5: `packages/git` — eventi webhook PR nella registrazione

**Files:**
- Modify: `packages/git/src/bitbucket.ts:395` (eventi `ensureWebhook`)
- Test: test esistenti di `ensureWebhook` in `bitbucket.test.ts`

GitHub registra già l'evento `pull_request` (github.ts:298,307) che copre opened/synchronize: NESSUNA modifica. Bitbucket deve aggiungere created/updated.

**Step 1: aggiorna il test** di `ensureWebhook` in `bitbucket.test.ts` per aspettarsi:

```ts
events: [
  "pullrequest:created",
  "pullrequest:updated",
  "pullrequest:fulfilled",
  "pullrequest:rejected",
  "repo:push",
],
```

**Step 2: FAIL** → **Step 3:** aggiorna l'array a bitbucket.ts:395. **Step 4: PASS.**

**Step 5: commit** — `feat(git): eventi pullrequest:created/updated nel webhook Bitbucket`

Nota da riportare nel PR/README del task: i webhook Bitbucket GIÀ configurati vanno riallineati con "Configura webhook" dalla UI del repository (l'`ensureWebhook` è idempotente e fa PATCH/PUT).

---

## Task 6: server — webhook PR opened/updated → coda con debounce

**Files:**
- Modify: `apps/server/src/routes/webhooks.ts`
- Test: `apps/server/src/routes/webhooks.test.ts`

**Step 1: scrivi i test**

Aggiungi al file di test (usa gli helper esistenti `createProject`, `sign`, e aggiungi un helper per abilitare la feature):

```ts
async function setPrReviewEnabled(enabled: boolean): Promise<void> {
  await testDb.db
    .insert(instanceSettings)
    .values({ id: 1, prReviewEnabled: enabled })
    .onConflictDoUpdate({ target: instanceSettings.id, set: { prReviewEnabled: enabled } });
}

function githubPrOpenedPayload(overrides: Partial<{ action: string; sha: string }> = {}): string {
  return JSON.stringify({
    action: overrides.action ?? "opened",
    pull_request: {
      number: 42,
      title: "Add login",
      body: "desc",
      html_url: "https://github.com/acme/repo/pull/42",
      head: { ref: "feature/login", sha: overrides.sha ?? "a".repeat(40) },
      base: { ref: "main" },
    },
  });
}

describe("webhook PR Review (accodamento)", () => {
  it("pull_request opened con toggle attivo → riga in pr_review_jobs", async () => {
    await setPrReviewEnabled(true);
    const project = await createProject({ name: "PRR-1", provider: "github", ... });
    const body = githubPrOpenedPayload();
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/git/${project.slug}`,
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(project.webhookSecret, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(204);
    const jobs = await testDb.db.select().from(prReviewJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.prNumber).toBe(42);
    expect(jobs[0]!.headSha).toBe("a".repeat(40));
    expect(jobs[0]!.notBefore.getTime()).toBeGreaterThan(Date.now());
  });

  it("synchronize sulla stessa PR → upsert (una sola riga, head e debounce aggiornati)", async () => {
    // opened + poi synchronize con sha diverso: 1 riga, headSha = nuovo sha,
    // notBefore spostato in avanti.
  });

  it("toggle spento → nessuna riga (204)", async () => {
    await setPrReviewEnabled(false);
    // ... expect 0 righe
  });

  it("firma errata → 401 e nessuna riga", async () => { ... });
});
```

**Step 2: FAIL** → `pnpm --filter @stubwise/server test -- webhooks`

**Step 3: implementa il ramo nel webhook**

In `webhooks.ts`:

1. Import: aggiungi `instanceSettings, prReviewJobs` da `@stubwise/db`.
2. Costante sotto `DEBOUNCE_MS` (riga 37):

```ts
/**
 * Debounce dell'automazione PR Review: ogni opened/synchronize sposta
 * `not_before` di questo intervallo, così una raffica di push sulla PR produce
 * una sola review sulla head finale. Più corto del debounce Docs: la review
 * serve "presto" dopo l'apertura, e i push su una PR sono meno frequenti dei
 * push su main.
 */
const PR_REVIEW_DEBOUNCE_MS = 90 * 1000;
```

3. Nel handler, DOPO il ramo push (riga 196) e PRIMA di `parseWebhook` (riga 198):

```ts
      // Ramo PR Review: apertura/aggiornamento di una PR. Mutuamente esclusivo
      // con gli altri due (parsePushEvent copre solo i push, parseWebhook solo
      // le chiusure). Gate sul toggle d'istanza: spento = no-op.
      const prEvent = provider.parsePrEvent(headers, request.body);
      if (prEvent) {
        const [settings] = await instance.db
          .select({ enabled: instanceSettings.prReviewEnabled })
          .from(instanceSettings)
          .where(eq(instanceSettings.id, 1));
        if (settings?.enabled !== true) return reply.code(204).send();

        // Upsert sul vincolo (repository, PR): un solo pending per PR, i push
        // ravvicinati aggiornano head/metadati e allungano il debounce.
        const notBefore = new Date(Date.now() + PR_REVIEW_DEBOUNCE_MS);
        await instance.db
          .insert(prReviewJobs)
          .values({
            repositoryId: context.repositoryId,
            prNumber: prEvent.prNumber,
            prUrl: prEvent.prUrl,
            prTitle: prEvent.title,
            prBody: prEvent.description,
            sourceBranch: prEvent.sourceBranch,
            targetBranch: prEvent.targetBranch,
            headSha: prEvent.headSha,
            notBefore,
          })
          .onConflictDoUpdate({
            target: [prReviewJobs.repositoryId, prReviewJobs.prNumber],
            set: {
              prUrl: prEvent.prUrl,
              prTitle: prEvent.title,
              prBody: prEvent.description,
              sourceBranch: prEvent.sourceBranch,
              targetBranch: prEvent.targetBranch,
              headSha: prEvent.headSha,
              notBefore,
            },
          });
        return reply.code(204).send();
      }
```

**Step 4: PASS** → **Step 5: commit** — `feat(server): webhook PR opened/updated accoda pr_review_jobs con debounce`

---

## Task 7: server — chiusura PR: cleanup coda + auto-chiusura ticket review

**Files:**
- Modify: `apps/server/src/routes/webhooks.ts` (ramo `parseWebhook`)
- Test: `apps/server/src/routes/webhooks.test.ts`

**Step 1: scrivi i test**

```ts
describe("webhook PR Review (chiusura)", () => {
  it("PR esterna mergiata → pending eliminato e ticket review chiuso a done con commento", async () => {
    // Setup: repo, ticket type 'review' (insert diretto), riga pr_reviews con
    // ticketId che punta al ticket e (repositoryId, prNumber=7), pending in
    // pr_review_jobs per la stessa PR. Payload: pull_request closed merged=true
    // con head.ref = "feature/login" (NON stubwise/*) e number=7.
    // Expect: 204; pr_review_jobs vuota; ticket.status === "done"; commento
    // system con l'URL della PR.
  });

  it("PR esterna chiusa senza merge → ticket review a closed", async () => { ... });

  it("PR stubwise mergiata → flusso esistente INTATTO (ticket fix a done)", async () => {
    // Il test esistente deve continuare a passare: questo caso è già coperto,
    // verifica solo che i test esistenti non si rompano.
  });
});
```

**Step 2: FAIL.**

**Step 3: implementa**

In `webhooks.ts`, il ramo dopo `parseWebhook` (riga 198). Oggi: `if (!match) return 204`. Ristruttura così — PRIMA del check `STUBWISE_BRANCH_RE`, gestisci il lato review (vale per QUALUNQUE branch):

```ts
      const event = provider.parseWebhook(headers, request.body);
      if (!event) return reply.code(204).send();

      // Lato PR Review, per QUALUNQUE PR chiusa: il pending in coda non serve
      // più (la review di una PR chiusa è inutile), e l'eventuale ticket di
      // tipo `review` della PR si chiude da solo (done se mergiata, closed se
      // rifiutata). Vale anche per le PR stubwise (che però non hanno mai un
      // ticket review: le due query sotto sono no-op in quel caso).
      await instance.db
        .delete(prReviewJobs)
        .where(
          and(
            eq(prReviewJobs.repositoryId, context.repositoryId),
            eq(prReviewJobs.prNumber, event.prNumber),
          ),
        );

      const [reviewRow] = await instance.db
        .select({ ticketId: prReviews.ticketId })
        .from(prReviews)
        .where(
          and(
            eq(prReviews.repositoryId, context.repositoryId),
            eq(prReviews.prNumber, event.prNumber),
          ),
        )
        .orderBy(desc(prReviews.createdAt))
        .limit(1);
      if (reviewRow?.ticketId) {
        const [reviewTicket] = await instance.db
          .select({ id: tickets.id, status: tickets.status, type: tickets.type })
          .from(tickets)
          .where(eq(tickets.id, reviewRow.ticketId));
        // Si auto-chiude SOLO il ticket di tipo review ancora aperto: il
        // ticket di un fix stubwise ha già il suo flusso di chiusura sotto.
        if (
          reviewTicket &&
          reviewTicket.type === "review" &&
          reviewTicket.status !== "done" &&
          reviewTicket.status !== "closed"
        ) {
          const lang = await getContentLanguage(instance.db);
          await instance.db.transaction(async (tx) => {
            await tx
              .update(tickets)
              .set({ status: event.kind === "merged" ? "done" : "closed" })
              .where(eq(tickets.id, reviewTicket.id));
            await tx.insert(comments).values({
              ticketId: reviewTicket.id,
              authorType: "system",
              body: t(lang, event.kind === "merged" ? "comment.prMerged" : "comment.prClosed", {
                url: event.prUrl,
              }),
            });
          });
        }
      }

      const match = STUBWISE_BRANCH_RE.exec(event.branch);
      if (!match) return reply.code(204).send();
      // ... flusso esistente invariato ...
```

Import aggiuntivi: `desc` da drizzle-orm, `prReviews` da `@stubwise/db`. Nota: `getContentLanguage` è già chiamata più sotto nel flusso stubwise — va bene chiamarla due volte solo nel raro caso di overlap; in alternativa solleva la chiamata prima del blocco review (scelta libera, mantieni il codice pulito).

**Step 4: PASS** (nuovi + esistenti). **Step 5: commit** — `feat(server): chiusura PR pulisce la coda review e auto-chiude il ticket review`

---

## Task 8: server — settings automation estese con PR Review

**Files:**
- Modify: `apps/server/src/routes/settings.ts:29-54` (schemi) e `:264-315` (route)
- Test: `apps/server/src/routes/settings.test.ts` (esistente, stesso file dei test automation)

**Step 1: scrivi i test**

```ts
it("GET /automation include prReview (default: disabilitata, nessun cap)", async () => {
  const res = await app.inject({ method: "GET", url: "/api/settings/automation", headers: { cookie: adminCookie } });
  expect(res.statusCode).toBe(200);
  expect(res.json().prReview).toEqual({ enabled: false, maxCostUsd: null });
});

it("PUT /automation salva prReview e la restituisce", async () => {
  const current = (await app.inject({ method: "GET", url: "/api/settings/automation", headers: { cookie: adminCookie } })).json();
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings/automation",
    headers: { cookie: adminCookie },
    payload: { rules: current.rules, prReview: { enabled: true, maxCostUsd: 2.5 } },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().prReview).toEqual({ enabled: true, maxCostUsd: 2.5 });
});

it("GET /automation include la regola del tipo 'review' con autoFix=false", async () => {
  const rules = (await app.inject({ ... })).json().rules;
  const review = rules.find((r: { type: string }) => r.type === "review");
  expect(review).toBeDefined();
  expect(review.autoFix).toBe(false);
});
```

**Step 2: FAIL.**

**Step 3: implementa**

Schemi (righe ~29-54):

```ts
const prReviewSettingsSchema = z.object({
  enabled: z.boolean(),
  // numeric(12,6) in drizzle → stringa; l'API la espone come number.
  maxCostUsd: z.number().nonnegative().nullable().default(null),
});

const automationSettingsSchema = z.object({
  rules: z.array(automationRuleSchema),
  prReview: prReviewSettingsSchema,
});

const updateAutomationBodySchema = z.object({
  rules: z.array(automationRuleSchema).min(1),
  prReview: prReviewSettingsSchema,
});
```

Aggiungi un loader accanto a `loadAllRules`:

```ts
/** Impostazioni PR Review dal singleton instance_settings (default: spenta). */
async function loadPrReviewSettings(db: Db): Promise<z.infer<typeof prReviewSettingsSchema>> {
  const [row] = await db
    .select({
      enabled: instanceSettings.prReviewEnabled,
      maxCostUsd: instanceSettings.prReviewMaxCostUsd,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  return {
    enabled: row?.enabled ?? false,
    maxCostUsd: row?.maxCostUsd != null ? Number(row.maxCostUsd) : null,
  };
}
```

GET: `return { rules: await loadAllRules(app.db), prReview: await loadPrReviewSettings(app.db) };`

PUT: dentro la transazione esistente, dopo il loop delle rules:

```ts
      const maxCost = request.body.prReview.maxCostUsd;
      await tx
        .insert(instanceSettings)
        .values({
          id: 1,
          prReviewEnabled: request.body.prReview.enabled,
          prReviewMaxCostUsd: maxCost != null ? String(maxCost) : null,
        })
        .onConflictDoUpdate({
          target: instanceSettings.id,
          set: {
            prReviewEnabled: request.body.prReview.enabled,
            prReviewMaxCostUsd: maxCost != null ? String(maxCost) : null,
          },
        });
```

e il return diventa come il GET.

**Step 4: PASS** — occhio: i test esistenti del PUT vanno aggiornati (il body ora richiede `prReview`). **Step 5: commit** — `feat(server): impostazioni PR Review in /api/settings/automation`

---

## Task 9: notifiche — evento `review.completed`

**Files:**
- Modify: `packages/notifications/src/format.ts` (evento, EMOJI, KEY_FOR_KIND, linkParam, textParams, formatGeneric)
- Modify: `packages/notifications/src/dispatch.ts` (`NotificationSettingsRow`, `TOGGLE_FOR_KIND`)
- Modify: `packages/i18n/src/catalog.ts` (chiavi `notify.reviewCompleted` en+it)
- Modify: `apps/server/src/routes/settings.ts` (schema/route notifiche: campo `notifyReviewCompleted`)
- Test: test esistenti di `packages/notifications` (segui il pattern dei kind esistenti) e parità cataloghi i18n (`packages/i18n/src/index.test.ts` la verifica già)

**Step 1: test** — nel file di test di format/dispatch, aggiungi il caso:

```ts
it("review.completed: formato slack contiene verdetto e link PR; toggle notifyReviewCompleted lo gata", async () => { ... });
```

Copia la struttura di un test esistente di `job.pr_closed`.

**Step 2: FAIL.**

**Step 3: implementa**

format.ts — nuovo evento:

```ts
/** Review AI di una PR completata (automazione PR Review). */
export interface ReviewCompletedEvent {
  kind: "review.completed";
  ticketNumber: number;
  ticketTitle: string;
  projectName: string;
  ticketUrl: string;
  prUrl: string;
  /** Verdetto della review. */
  verdict: "approve" | "request_changes";
}
```

Aggiungilo alla union `NotificationEvent`. Poi: `EMOJI["review.completed"] = "🔎"`, `KEY_FOR_KIND["review.completed"] = "notify.reviewCompleted"`, linkParam → `prUrl`, textParams → include `verdict` tradotto (usa due chiavi `notify.verdict.approve` / `notify.verdict.requestChanges` per il testo umano), ramo in `formatGeneric` con `{ ...base, prUrl: event.prUrl, verdict: event.verdict }`.

catalog.ts (en):

```ts
"notify.reviewCompleted": "PR review completed for {title}: {verdict} — {url}",
"notify.verdict.approve": "approval suggested ✅",
"notify.verdict.requestChanges": "changes requested ⚠️",
```

(it):

```ts
"notify.reviewCompleted": "Review della PR completata per {title}: {verdict} — {url}",
"notify.verdict.approve": "approvazione suggerita ✅",
"notify.verdict.requestChanges": "modifiche richieste ⚠️",
```

dispatch.ts: `notifyReviewCompleted: boolean` in `NotificationSettingsRow` (righe 35-46) e `"review.completed": "notifyReviewCompleted"` in `TOGGLE_FOR_KIND`.

settings.ts route notifiche (righe ~317-359): aggiungi `notifyReviewCompleted: z.boolean()` allo schema body/response e alla select/upsert, come gli altri toggle.

**Step 4: PASS** → `pnpm --filter @stubwise/notifications test && pnpm --filter @stubwise/i18n test && pnpm --filter @stubwise/server test -- settings`

**Step 5: commit** — `feat(notifications): evento review.completed con toggle dedicato`

---

## Task 10: worker — `MirrorManager.withWorktreeAtSha` + `getPrDiff`

**Files:**
- Modify: `apps/worker/src/git/mirrors.ts`
- Test: `apps/worker/src/git/mirrors.test.ts` (esistente: usa repo git locali su tmpdir — segui il pattern dei test di `withWorktree`)

**Step 1: scrivi i test**

```ts
it("withWorktreeAtSha monta un worktree detached allo sha e lo rimuove", async () => {
  // Setup come i test esistenti: repo bare locale + un commit A + un commit B.
  // withWorktreeAtSha(project, shaA, fn): dentro fn, `git rev-parse HEAD` === shaA
  // e il file del commit B NON esiste. Dopo: la dir del worktree non esiste più.
});

it("withWorktreeAtSha con sha malformato → InvalidShaError", async () => {
  await expect(mirrors.withWorktreeAtSha(project, "not-a-sha; rm -rf /", async () => {}))
    .rejects.toThrow(InvalidShaError);
});

it("getPrDiff ritorna il diff dal merge-base col branch target", async () => {
  // main: commit A. branch feature da A con commit C che aggiunge feature.txt.
  // main avanza con commit B. getPrDiff(project, shaC, "main") deve contenere
  // "feature.txt" e NON i file del commit B (merge-base = A).
});

it("getPrDiff tronca i diff enormi e segnala truncated", async () => {
  // commit con file > MAX_DIFF_CHARS: truncated === true, length <= cap.
});
```

**Step 2: FAIL.**

**Step 3: implementa**

In `mirrors.ts`:

```ts
/** Cap del diff passato al prompt della review: oltre, si tronca (l'agente ha comunque il worktree). */
const MAX_DIFF_CHARS = 150_000;

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export class InvalidShaError extends Error {
  constructor(sha: string) {
    super(`SHA non valido: ${sha}`);
    this.name = "InvalidShaError";
  }
}
```

Metodi (modellati su `openWorktree`, mirrors.ts:338-404 — riusa `ensureMirror`, la naming dei worktree dir e la rimozione):

```ts
  /**
   * Monta un worktree DETACHED a uno sha arbitrario (head di una PR) e lo
   * rimuove alla fine. A differenza di openWorktree non crea alcun branch:
   * la review è read-only, nessun push. Lo sha deve essere raggiungibile dal
   * mirror (GitHub: il clone --mirror porta anche refs/pull/*; Bitbucket: la
   * source branch di una PR same-repo è un branch normale. Le PR da fork
   * Bitbucket non sono raggiungibili: l'errore git emerge chiaro qui).
   */
  async withWorktreeAtSha<T>(
    project: MirrorProject,
    sha: string,
    fn: (dir: string) => Promise<T>,
  ): Promise<T> {
    if (!SHA_RE.test(sha)) throw new InvalidShaError(sha);
    const mirrorDir = await this.ensureMirror(project);
    const worktreeDir = /* stesso schema di openWorktree per il path tmp */;
    await this.git(["worktree", "add", "--force", "--detach", worktreeDir, sha], { cwd: mirrorDir });
    try {
      return await fn(worktreeDir);
    } finally {
      await this.git(["worktree", "remove", "--force", worktreeDir], { cwd: mirrorDir }).catch(() => {});
    }
  }

  /**
   * Diff della PR: merge-base tra la head e il branch target, poi diff
   * troncato a MAX_DIFF_CHARS. Se il merge-base non è calcolabile (storia
   * riscritta), fallback al diff diretto contro il target.
   */
  async getPrDiff(
    project: MirrorProject,
    headSha: string,
    targetBranch: string,
  ): Promise<{ diff: string; truncated: boolean }> {
    if (!SHA_RE.test(headSha)) throw new InvalidShaError(headSha);
    const mirrorDir = await this.ensureMirror(project);
    let base = `refs/heads/${targetBranch}`;
    try {
      const { stdout } = await this.git(["merge-base", headSha, `refs/heads/${targetBranch}`], { cwd: mirrorDir });
      base = stdout.trim();
    } catch {
      // Fallback: diff diretto contro il target (meno preciso ma utilizzabile).
    }
    const { stdout: diff } = await this.git(["diff", base, headSha], { cwd: mirrorDir });
    if (diff.length <= MAX_DIFF_CHARS) return { diff, truncated: false };
    return { diff: diff.slice(0, MAX_DIFF_CHARS), truncated: true };
  }
```

Adatta le chiamate `this.git` alla firma privata reale (guarda `openWorktree` e `getChangedFiles` per stdout handling). ATTENZIONE al `targetBranch`: arriva dal webhook — va validato. Riusa la logica di `assertBranchName` se generalizzabile, o valida con `/^[\w./-]+$/` e rifiuta stringhe che iniziano con `-` (argomento git). Il passaggio come ref `refs/heads/<nome>` già evita l'interpretazione come opzione se non inizia con `-`.

**Step 4: PASS** → `pnpm --filter @stubwise/worker test -- mirrors`

**Step 5: commit** — `feat(worker): worktree detached a sha e diff PR nel MirrorManager`

---

## Task 11: worker — prompt della review + parsing dell'output

**Files:**
- Create: `apps/worker/src/review/prompts.ts`
- Test: `apps/worker/src/review/prompts.test.ts`

**Step 1: scrivi i test**

```ts
import { describe, expect, it } from "vitest";
import { buildReviewPrompt, parseReviewOutput } from "./prompts.js";

describe("parseReviewOutput", () => {
  it("JSON puro → verdict + summary", () => {
    const out = parseReviewOutput('{"verdict":"approve","summary":"Tutto ok"}');
    expect(out).toEqual({ verdict: "approve", summary: "Tutto ok" });
  });
  it("JSON in fence markdown → estratto e parsato", () => {
    const raw = 'Ecco la review:\n```json\n{"verdict":"request_changes","summary":"- bug a riga 3"}\n```\n';
    expect(parseReviewOutput(raw)?.verdict).toBe("request_changes");
  });
  it("verdetto sconosciuto o JSON assente → null", () => {
    expect(parseReviewOutput('{"verdict":"maybe","summary":"x"}')).toBeNull();
    expect(parseReviewOutput("nessun json")).toBeNull();
  });
});

describe("buildReviewPrompt", () => {
  it("contiene titolo, corpo, branch, diff e la lingua dei contenuti", () => {
    const prompt = buildReviewPrompt({
      prTitle: "Add login",
      prBody: "desc",
      sourceBranch: "feature/login",
      targetBranch: "main",
      diff: "diff --git a/x b/x",
      diffTruncated: false,
      language: "it",
    });
    expect(prompt).toContain("Add login");
    expect(prompt).toContain("diff --git");
    expect(prompt).toContain('"verdict"');
  });
});
```

**Step 2: FAIL.** → **Step 3: implementa**

```ts
import { z } from "zod";
import { LANGUAGE_NAMES, type Language } from "@stubwise/i18n"; // adatta all'export reale

const reviewOutputSchema = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  summary: z.string().min(1),
});
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

/**
 * Estrae e valida il JSON finale dell'agente: prova il testo intero, poi il
 * primo fence ```json, poi la prima {...} bilanciata. null = output inusabile
 * (la review fallisce con errore esplicito, mai un verdetto inventato).
 */
export function parseReviewOutput(raw: string): ReviewOutput | null {
  const candidates: string[] = [raw.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const brace = raw.indexOf("{");
  if (brace >= 0) candidates.push(raw.slice(brace, raw.lastIndexOf("}") + 1));
  for (const candidate of candidates) {
    try {
      const parsed = reviewOutputSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Tentativo successivo.
    }
  }
  return null;
}

export interface ReviewPromptInput {
  prTitle: string;
  prBody: string;
  sourceBranch: string;
  targetBranch: string;
  diff: string;
  diffTruncated: boolean;
  language: Language;
}

/**
 * Prompt della review: agente in permission-mode plan (read-only), col
 * worktree alla head della PR come cwd. Il diff è nel prompt; il codebase
 * intero è navigabile per valutare l'impatto. Output: SOLO il JSON finale.
 */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  return [
    `You are a senior code reviewer. Review the following pull request critically.`,
    ``,
    `## Pull request`,
    `Title: ${input.prTitle}`,
    `Source branch: ${input.sourceBranch} → target: ${input.targetBranch}`,
    input.prBody ? `Description:\n${input.prBody}` : `(no description)`,
    ``,
    `## Diff (merge-base → head)${input.diffTruncated ? " — TRUNCATED, explore the worktree for the rest" : ""}`,
    "```diff",
    input.diff,
    "```",
    ``,
    `## Instructions`,
    `- The working directory is the repository checked out at the PR head: navigate the codebase to judge the impact of the changes (callers, conventions, tests).`,
    `- Evaluate: correctness, regressions, security, error handling, consistency with the repo's conventions, missing tests.`,
    `- Be critical but fair: approve when the change is sound; request changes only for concrete, actionable issues (cite file and line).`,
    `- Write the summary in ${LANGUAGE_NAMES[input.language]}.`,
    `- Your FINAL message must be ONLY a JSON object, no prose around it:`,
    `  {"verdict": "approve" | "request_changes", "summary": "<markdown with findings, file:line references>"}`,
  ].join("\n");
}
```

(Verifica l'export reale di `LANGUAGE_NAMES`/`Language` in `packages/i18n/src/index.ts:18-21` e adatta.)

**Step 4: PASS** → **Step 5: commit** — `feat(worker): prompt e parsing dell'output della PR review`

---

## Task 12: worker — `runPrReview` (esecuzione + pubblicazione)

Il cuore. Modellato su `runAutoUpdate` (`apps/worker/src/docs/auto-update.ts`): deps iniettabili, best-effort, mai crash del worker.

**Files:**
- Create: `apps/worker/src/review/run-review.ts`
- Test: `apps/worker/src/review/run-review.test.ts` (testcontainers, pattern di `auto-update.test.ts`/`fix.test.ts`: DB vero + `mirrors`/`runner`/`getProviderFn` fake iniettati)
- Modify: `packages/i18n/src/catalog.ts` (chiavi commento)

**Step 1: chiavi i18n**

catalog.ts (en):

```ts
"comment.reviewVerdict.approve": "🔎 **PR Review** — approval suggested ✅ ({url})",
"comment.reviewVerdict.requestChanges": "🔎 **PR Review** — changes requested ⚠️ ({url})",
"comment.reviewTicketBody": "Automatic review of pull request {url} (branch `{branch}`).",
```

(it):

```ts
"comment.reviewVerdict.approve": "🔎 **PR Review** — approvazione suggerita ✅ ({url})",
"comment.reviewVerdict.requestChanges": "🔎 **PR Review** — modifiche richieste ⚠️ ({url})",
"comment.reviewTicketBody": "Review automatica della pull request {url} (branch `{branch}`).",
```

**Step 2: scrivi i test d'integrazione**

Setup comune: `startTestDb()`, seed di project+repository+git_account (credenziali cifrate con la chiave di test — copia gli helper da `auto-update.test.ts`), `instanceSettings` con `prReviewEnabled: true`. Deps fake:

```ts
const fakeMirrors = {
  withWorktreeAtSha: vi.fn(async (_p, _sha, fn) => fn("/tmp/fake-worktree")),
  getPrDiff: vi.fn(async () => ({ diff: "diff --git a/x b/x\n+1", truncated: false })),
};
const fakeRunner = {
  run: vi.fn(async () => ({
    result: '{"verdict":"request_changes","summary":"- `src/x.ts:3`: bug"}',
    usage: [{ model: "sonnet", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, costUsd: 0.01 }],
  })),
};
const upsertPrComment = vi.fn(async () => {});
const getPullRequestState = vi.fn(async () => "open" as const);
const fakeGetProvider = () => ({ upsertPrComment, getPullRequestState }) as unknown as GitProvider;
```

(Adatta la shape di `runner.run`/usage alla firma REALE di `AgentRunner`/`AgentRunResult` in `apps/worker/src/agent/runner.ts` — guardala prima di scrivere i test.)

Casi:

```ts
it("PR esterna: crea ticket 'review' numerato, commento AI, riga pr_reviews completed, commento sticky, notifica", async () => {
  const job = makeJob({ sourceBranch: "feature/login", prNumber: 42 });
  await runPrReview(deps, job);

  const [review] = await db.select().from(prReviews);
  expect(review!.status).toBe("completed");
  expect(review!.verdict).toBe("request_changes");

  const [ticket] = await db.select().from(tickets).where(eq(tickets.type, "review"));
  expect(ticket).toBeDefined();
  expect(ticket!.source).toBe("webhook");
  expect(review!.ticketId).toBe(ticket!.id);

  const cmts = await db.select().from(comments).where(eq(comments.ticketId, ticket!.id));
  expect(cmts.some((c) => c.authorType === "ai" && c.body.includes("modifiche richieste"))).toBe(true);

  expect(upsertPrComment).toHaveBeenCalledWith(
    expect.anything(), 42, "<!-- stubwise-pr-review -->", expect.stringContaining("stubwise-pr-review"),
  );

  const runs = await db.select().from(agentRuns);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.prReviewId).toBe(review!.id);
  expect(runs[0]!.phase).toBe("review");
});

it("PR stubwise (source branch stubwise/ticket-N): commenta il ticket esistente, NON ne crea uno nuovo", async () => {
  // Seed: ticket con number=5 nel progetto. Job con sourceBranch "stubwise/ticket-5".
  // Expect: nessun ticket type 'review'; commento AI sul ticket 5; pr_reviews.ticketId = ticket 5.
});

it("re-review della stessa PR esterna: riusa il ticket review esistente (nuovo commento, stesso ticket)", async () => {
  // runPrReview due volte: 1 solo ticket, 2 commenti AI, 2 righe pr_reviews.
});

it("PR già chiusa al claim → nessuna riga pr_reviews, nessun run dell'agente", async () => {
  getPullRequestState.mockResolvedValueOnce("closed");
  await runPrReview(deps, makeJob({}));
  expect(fakeRunner.run).not.toHaveBeenCalled();
  expect(await db.select().from(prReviews)).toHaveLength(0);
});

it("output agente non parsabile → pr_reviews failed con errore, nessun commento", async () => {
  fakeRunner.run.mockResolvedValueOnce({ result: "boh", usage: [] });
  ...
  expect(review!.status).toBe("failed");
  expect(upsertPrComment).not.toHaveBeenCalled();
});

it("cap di costo per review superato → failed con motivo, nessuna pubblicazione", async () => {
  // instanceSettings.prReviewMaxCostUsd = 0.001, usage costUsd = 0.01.
  expect(review!.status).toBe("failed");
  expect(review!.error).toContain("cost");
});

it("upsertPrComment che fallisce NON fa fallire la review (resta completed, commento ticket presente)", async () => {
  upsertPrComment.mockRejectedValueOnce(new Error("403"));
  ...
});
```

**Step 3: FAIL.** → **Step 4: implementa**

`apps/worker/src/review/run-review.ts` — struttura completa:

```ts
export const PR_REVIEW_COMMENT_MARKER = "<!-- stubwise-pr-review -->";

export interface PrReviewJobRow {
  repositoryId: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  prBody: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
}

export interface RunPrReviewDeps {
  db: Db;
  mirrors: Pick<MirrorManager, "withWorktreeAtSha" | "getPrDiff">;
  runner: AgentRunner;
  encryptionKey: string;
  model: string;
  maxTurns: number;
  agentTimeoutMs: number;
  publicUrl: string;
  getProviderFn?: typeof getProvider;              // iniettabile nei test
  loadProviderByIdFn?: typeof loadProviderById;    // come auto-update.ts
  loadProviderChainFn?: typeof loadProviderChain;
}
```

Flusso di `runPrReview(deps, job)` (ogni passo è best-effort, log con prefisso `[stubwise-worker] pr-review:`):

1. **Contesto**: replica `loadProjectContext` di `auto-update.ts:189-233` (join repositories→gitAccounts→projects, decifra credenziali) → `{ mirrorProject, projectId, aiProviderId, repositoryName, projectSlug }`. Repo sparito → return.
2. **Gate toggle**: rileggi `instanceSettings.prReviewEnabled` — se false (spenta dopo l'accodamento), return silenzioso.
3. **Gate PR aperta**: `getProviderFn(provider).getPullRequestState(mirrorProject, job.prNumber)` — `"closed"` → return. Errore API → prosegui comunque (log warning).
4. **Gate budget mensile**: `monthlyCostUsd(db)` vs `instanceSettings.monthlyBudgetUsd` — sforato → inserisci `prReviews` con `status: "failed"`, `error: "monthly budget exceeded"`, return.
5. **Provider AI**: come `resolveProvider` di auto-update.ts:302-315 (pinned del progetto o chain[0]; bloccato → failed row con errore).
6. **Riga running**: `insert(prReviews).values({...job, status: "running"}).returning()`. Heartbeat: `setInterval` 60s che aggiorna `lastActivityAt` (clearInterval in `finally`).
7. **Diff**: `mirrors.getPrDiff(mirrorProject, job.headSha, job.targetBranch)`.
8. **Agente**: `mirrors.withWorktreeAtSha(mirrorProject, job.headSha, (dir) => deps.runner.run({ cwd: dir, prompt, model: deps.model, permissionMode: "plan", maxTurns: deps.maxTurns, timeoutMs: deps.agentTimeoutMs, provider }))` con `prompt = buildReviewPrompt({...job, diff, diffTruncated, language: await getContentLanguage(db)})`. `AgentTimeoutError`/`AgentRunError`/`ProviderLimitError` → update riga a failed con messaggio, return.
9. **Consumi**: inserisci `agent_runs` con `prReviewId` (NON `jobId`), `phase: "review"`, una riga per modello (copia `recordAgentRun` di queue.ts:31-49 adattandola — falla vivere in questo modulo come `recordReviewRun`, best-effort).
10. **Cap per review**: somma `costUsd` dei run appena registrati; se `prReviewMaxCostUsd` è impostato e superato → update failed `error: "per-review cost cap exceeded (…)"`; return SENZA pubblicare.
11. **Parse**: `parseReviewOutput(result)` — null → failed `"unparseable agent output"`.
12. **Ticket**: risoluzione in quest'ordine:
    - `STUBWISE_BRANCH_RE` (copia la regex `/^stubwise\/ticket-(\d+)$/` — mettila in questo modulo) su `job.sourceBranch` → ticket per `(projectId, number)`;
    - altrimenti ultima `prReviews.ticketId` non-null per `(repositoryId, prNumber)` → riusa;
    - altrimenti crea il ticket in transazione (replica di `createTicket` di `apps/server/src/db/tickets.ts:50-85` — il worker non può importare da apps/server):

```ts
async function createReviewTicket(db: Db, input: {
  projectId: string; prTitle: string; prUrl: string; sourceBranch: string; prNumber: number; lang: Language;
}): Promise<{ id: string; number: number; title: string }> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(projects)
      .set({ nextTicketNumber: sql`${projects.nextTicketNumber} + 1` })
      .where(eq(projects.id, input.projectId))
      .returning({ nextTicketNumber: projects.nextTicketNumber });
    if (!claimed) throw new Error(`progetto ${input.projectId} non trovato`);
    const [ticket] = await tx
      .insert(tickets)
      .values({
        projectId: input.projectId,
        number: claimed.nextTicketNumber - 1,
        title: `PR Review: ${input.prTitle} (#${input.prNumber})`,
        body: t(input.lang, "comment.reviewTicketBody", { url: input.prUrl, branch: input.sourceBranch }),
        type: "review",
        priority: "medium",
        source: "webhook",
        status: "open",
      })
      .returning({ id: tickets.id, number: tickets.number, title: tickets.title });
    return ticket!;
  });
}
```

13. **Pubblicazione** in transazione: commento AI sul ticket (`comments`, `authorType: "ai"`, body = `t(lang, "comment.reviewVerdict.<verdict>", { url: job.prUrl })` + `\n\n` + summary) e update `prReviews` → `{ status: "completed", verdict, summary, ticketId, finishedAt: new Date() }`.
14. **Commento sticky sulla PR** (best-effort, FUORI transazione): `upsertPrComment(mirrorProject, prNumber, MARKER, body)` con body = marker + verdetto + summary + firma `_— Stubwise PR Review_`. Fallimento → solo log.
15. **Notifica** (best-effort): `dispatchNotification(db, { kind: "review.completed", ticketNumber, ticketTitle, projectName: repositoryName, ticketUrl: `${publicUrl}/tickets/${ticketId}`, prUrl, verdict })`.

**Step 5: PASS** → `pnpm --filter @stubwise/worker test -- run-review`

**Step 6: commit** — `feat(worker): runPrReview — esecuzione review e pubblicazione su ticket/PR`

---

## Task 13: worker — poller, config e wiring

**Files:**
- Create: `apps/worker/src/review/poller.ts`
- Modify: `apps/worker/src/config.ts`, `apps/worker/src/index.ts`
- Test: `apps/worker/src/review/poller.test.ts`

**Step 1: test del poller** (pattern di `auto-update-poller` — se esiste un suo test, copiane la struttura):

```ts
it("reclama solo i job con notBefore scaduto (DELETE...RETURNING) e li esegue nel serializer del progetto", async () => {
  // Due job: uno scaduto, uno futuro. runPrReviewFn spy. Dopo pollPrReviewsOnce:
  // spy chiamato 1 volta col job scaduto; in tabella resta solo il futuro.
});

it("un job che lancia non blocca gli altri e non propaga", async () => { ... });

it("marca failed le pr_reviews running con heartbeat stantio", async () => {
  // Riga running con lastActivityAt vecchio di staleMinutes+1 → dopo il tick è failed.
});
```

**Step 2: FAIL.** → **Step 3: implementa `poller.ts`**

Copia la struttura INTERA di `auto-update-poller.ts` (claim `DELETE...RETURNING` su `notBefore <= now()`, risoluzione `projectId` dal repository, `serializer.run(projectId, () => runPrReviewFn(deps, job))`, try/catch per-job e per-tick, `startPrReviewPoller` con setInterval+unref+AbortSignal, `intervalSeconds <= 0` = disabilitato). In più, in testa a `pollPrReviewsOnce`, il recovery delle righe stantie:

```ts
  // Recovery: una review `running` col heartbeat fermo è un worker morto a
  // metà run (il claim è DELETE: il job non esiste più, nessun retry). La si
  // chiude failed così la UI non mostra run fantasma. Best-effort.
  await deps.db
    .update(prReviews)
    .set({ status: "failed", error: "stale: worker riavviato durante la review", finishedAt: sql`now()` })
    .where(and(eq(prReviews.status, "running"),
      lte(prReviews.lastActivityAt, sql`now() - make_interval(mins => ${deps.staleMinutes})`)))
    .catch(...);
```

**Step 4: config** — in `apps/worker/src/config.ts`, accanto a `DOCS_AUTOUPDATE_POLL_SECONDS` (righe ~263-284), stesso stile di parsing/validazione:

- `PR_REVIEW_POLL_SECONDS` → `prReviewPollSeconds`, intero ≥ 0, 0 = disabilitato, default 60.
- `PR_REVIEW_MODEL` → `prReviewModel`, default `"sonnet"`.
- `PR_REVIEW_MAX_TURNS` → `prReviewMaxTurns`, default 50.
- `PR_REVIEW_TIMEOUT_MINUTES` → `prReviewTimeoutMs` (minuti → ms), default 15.

**Step 5: wiring** — in `apps/worker/src/index.ts`, sotto `startAutoUpdatePoller` (riga ~232):

```ts
startPrReviewPoller({
  db,
  mirrors,
  runner,
  encryptionKey: config.encryptionKey,
  model: config.prReviewModel,
  maxTurns: config.prReviewMaxTurns,
  agentTimeoutMs: config.prReviewTimeoutMs,
  publicUrl: config.publicUrl,        // verifica il nome reale in config.ts
  staleMinutes: config.staleMinutes,  // idem (WORKER_STALE_MINUTES)
  serializer,
  intervalSeconds: config.prReviewPollSeconds,
  signal: controller.signal,
});
```

(Verifica i nomi reali di `publicUrl`/`staleMinutes` in config.ts; se il worker non ha `publicUrl`, guardare come `notify.ts`/`ticketUrl` del worker lo risolve e riusare quello.)

NOTA staleness: NON tocchiamo `WORKER_STALE_MINUTES` (il timeout della review — 15 min — è sotto lo stale attuale; l'invariante di `assertStaleInvariant` in index.ts resta valida). Se in futuro si alza il timeout review sopra lo stale, vale la trappola dei 3 punti (config.ts, compose, index.ts).

**Step 6: PASS** → `pnpm --filter @stubwise/worker test -- poller` e poi l'intera suite worker: `pnpm --filter @stubwise/worker test`.

**Step 7: commit** — `feat(worker): poller PR review con debounce claim e recovery stale`

---

## Task 14: web — settings, badge, notifiche, i18n

**Files:**
- Modify: `apps/web/src/lib/api.ts:1322-1358` (tipi + client automation), `:1369-1424` (notifiche)
- Modify: `apps/web/src/routes/settings/automation.tsx`
- Modify: `apps/web/src/components/badges.tsx:61-73` (se non già fatto nel Task 1)
- Modify: `apps/web/src/components/notifications-section.tsx` (nuovo toggle)
- Modify: `apps/web/src/i18n/locales/en.json`, `it.json`
- Test: `apps/web/src/routes/settings.test.tsx`

**Step 1: scrivi i test**

In `settings.test.tsx`: aggiorna `DEFAULT_AUTOMATION` (righe 16-23) aggiungendo la regola `review` e `prReview: { enabled: false, maxCostUsd: null }`, poi:

```ts
it("mostra la sezione PR Review e salva enabled + max cost nel PUT", async () => {
  let putBody: unknown = null;
  mockApi({
    ...adminBase(),
    "PUT /api/settings/automation": (_url, init) => {
      putBody = JSON.parse(String(init?.body));
      return jsonResponse(200, { ...DEFAULT_AUTOMATION, prReview: { enabled: true, maxCostUsd: 2 } });
    },
  });
  renderAt("/settings/automation");
  await userEvent.click(await screen.findByLabelText("PR review enabled"));
  await userEvent.type(screen.getByLabelText("Max cost per review ($)"), "2");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(putBody).not.toBeNull());
  expect((putBody as { prReview: unknown }).prReview).toEqual({ enabled: true, maxCostUsd: 2 });
});
```

E in `badges.test.tsx`: `TypeBadge type="review"` rende l'etichetta "Review".

**Step 2: FAIL.** → **Step 3: implementa**

api.ts:

```ts
export interface PrReviewSettings {
  enabled: boolean;
  /** Tetto di costo USD per singola review; null = nessun limite. */
  maxCostUsd: number | null;
}

export interface AutomationSettings {
  rules: AutomationRule[];
  prReview: PrReviewSettings;
}

export function putAutomationSettings(
  rules: AutomationRule[],
  prReview: PrReviewSettings,
): Promise<AutomationSettings> {
  return api.put("/api/settings/automation", { rules, prReview });
}
```

`NotificationSettings` (riga ~1369): aggiungi `notifyReviewCompleted: boolean;` e la riga nel body di `putNotificationSettings`.

automation.tsx: stato `const [prReview, setPrReview] = useState<PrReviewSettings>(settings.prReview);` (+ sync `useEffect`), `mutation.mutate({ rules, prReview })` → adegua `mutationFn`. Sezione sopra il footer save, stesso linguaggio visivo della tabella (bordo, `font-mono`, i18n `automation:prReview*`):

```tsx
      <section className="border-t border-line pt-4">
        <h3 className="font-mono text-[12px] tracking-[0.12em] text-fg-muted uppercase">
          {t("automation:prReviewTitle")}
        </h3>
        <p className="mt-1 text-[13px] text-fg-muted">{t("automation:prReviewSubtitle")}</p>
        <div className="mt-3 flex items-center gap-6">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={prReview.enabled}
              aria-label={t("automation:prReviewEnabledLabel")}
              onChange={(e) => updatePrReview({ enabled: e.target.checked })}
            />
            {t("automation:prReviewEnabled")}
          </label>
          <label className="flex items-center gap-2">
            {t("automation:prReviewMaxCost")}
            <input
              type="number"
              min={0}
              step="0.5"
              value={prReview.maxCostUsd ?? ""}
              placeholder={t("automation:maxCostPlaceholder")}
              aria-label={t("automation:prReviewMaxCostLabel")}
              onChange={(e) => {
                const parsed = e.target.value === "" ? null : Number(e.target.value);
                updatePrReview({ maxCostUsd: parsed === null || Number.isNaN(parsed) ? null : parsed });
              }}
            />
          </label>
        </div>
      </section>
```

(`updatePrReview` come `updateRule`: patch + `mutation.reset()`.) Adatta le classi agli input della tabella esistente (copiale).

i18n en.json, namespace `automation`:

```json
"prReviewTitle": "PR Review",
"prReviewSubtitle": "On every opened or updated pull request, an AI agent reviews the changes and suggests approval or changes. Requires the repository webhook.",
"prReviewEnabled": "Enabled",
"prReviewEnabledLabel": "PR review enabled",
"prReviewMaxCost": "Max cost per review ($)",
"prReviewMaxCostLabel": "Max cost per review ($)"
```

it.json speculare ("Review automatica delle PR: ad ogni PR aperta o aggiornata…"). Namespace `badges`: `"type": { ..., "review": "Review" }` in entrambe le lingue. Namespace `notifications` (guarda le chiavi esistenti dei toggle in `notifications-section.tsx`): aggiungi la label del nuovo toggle in en+it.

badges.tsx (se non già fatto al Task 1):

```ts
  review: "badges:type.review",   // in TYPE_LABEL_KEYS
  review: "text-purple-400 border-purple-400/30",   // in TYPE_CLASS
```

notifications-section.tsx: aggiungi `notifyReviewCompleted` alla lista dei toggle seguendo ESATTAMENTE il pattern degli altri (cerca `notifyPrClosed` nel componente).

**Step 4: PASS** → `pnpm --filter @stubwise/web test` (il test di parità i18n verifica en/it allineati).

**Step 5: commit** — `feat(web): sezione PR Review in settings, badge review, toggle notifica`

---

## Task 15: guida utente + verifica finale

**Files:**
- Modify: `apps/docs/src/content/docs/.../automation.*` (la pagina linkata da `/guide/ai-pipeline/automation/` — trovala con `grep -r "automation" apps/docs/src/content/docs --include=*.md* -l`)
- Modify: `docs/plans/2026-07-01-pr-review-automation-design.md` (stato → implementato)

**Step 1: documenta la feature nella guida Starlight**

Aggiungi alla pagina dell'automazione una sezione "PR Review": cosa fa, come si abilita (toggle globale + webhook del repository con gli eventi PR — per Bitbucket serve ri-eseguire "Configura webhook"), dove si vede il risultato (commento sticky sulla PR, ticket di tipo review per le PR esterne, commento sul ticket per quelle di Stubwise), il cap di costo. Segui la struttura/lingua delle sezioni esistenti.

**Step 2: verifica completa dalla radice**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: tutto verde. (I test con testcontainers sono seriali per `maxForks`: pazienza.) Gli E2E Playwright NON girano qui: per la parte UI toccata (settings/automation) lanciali a mano se esiste uno spec pertinente: `cd apps/web && npx playwright test`.

**Step 3: aggiorna lo stato del design doc**

In `docs/plans/2026-07-01-pr-review-automation-design.md`: `Stato: design validato` → `Stato: implementato (vedi 2026-07-01-pr-review-implementation.md)`.

**Step 4: commit finale**

```bash
git add apps/docs docs/plans
git commit -m "docs: guida PR Review e chiusura piano"
```

---

## Fuori scope (esplicitamente rimandato)

- Trigger manuale della review dalla UI (`POST /api/.../re-review`): il design lo consente, si aggiunge dopo.
- Chip col verdetto accanto al link PR nel dettaglio ticket (il commento AI basta per la v1).
- Review delle PR da fork Bitbucket (sha non raggiungibile dal mirror: falliscono con errore chiaro).
- Deploy: modifica frontend+backend ⇒ ribuildare `caddy`, `server` E `worker`; riallineare i webhook Bitbucket esistenti; il riavvio del worker segue la regola di sempre (nessuna generazione Docs attiva).
