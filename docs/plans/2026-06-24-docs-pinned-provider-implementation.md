# Provider bloccato per la generazione dei Docs — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development per eseguire questo piano task-by-task.

**Goal:** Permettere di bloccare opzionalmente una generazione Docs su un singolo
provider AI scelto, senza fallback. Default invariato (primo provider abilitato).

**Architecture:** Vedi `docs/plans/2026-06-24-docs-pinned-provider-design.md`. La
scelta viaggia: trigger (`POST /docs/generate` body `providerId`) →
`doc_generation_jobs.pinned_provider_id` → l'orientamento la copia su
`doc_generations.pinned_provider_id` → il dispatch dei nodi la legge da lì. Se il
provider scelto non è abilitato/esiste al run → la generazione FALLISCE, mai
`chain[0]`.

**Tech Stack:** Drizzle/Postgres, Fastify+Zod, worker (claude CLI), React+TanStack, Vitest.

---

## Task 1: Colonne DB + migrazione 0030

**Files:**
- Modify: `packages/db/src/schema.ts` (`docGenerationJobs` ~998, `docGenerations` ~856)
- Create: `packages/db/drizzle/0030_*.sql` (via drizzle-kit generate)

**Step 1.** In `docGenerationJobs` aggiungi:
```ts
pinnedProviderId: uuid("pinned_provider_id").references(() => aiProviders.id, {
  onDelete: "set null",
}),
```
Stesso campo in `docGenerations`. Commenti in italiano nello stile del file
(es. "Provider AI scelto per blindare la generazione; null = automatico (primo
abilitato)."). Verifica che `aiProviders` sia già importabile/definita prima (lo
è, riga ~550).

**Step 2.** `pnpm --filter @stubwise/db exec drizzle-kit generate` → verifica che
0030 aggiunga SOLO le due colonne + le due FK, niente altro.

**Step 3.** `pnpm --filter @stubwise/db typecheck && pnpm --filter @stubwise/db build`.

**Step 4.** Commit: `feat(db): pinned_provider_id su doc_generation_jobs e doc_generations`.

---

## Task 2: `loadProviderById` nel worker

**Files:**
- Modify: `apps/worker/src/providers/chain.ts`
- Test: `apps/worker/src/providers/chain.test.ts` (se esiste; altrimenti crealo)

**Step 1.** Aggiungi accanto a `loadProviderChain`:
```ts
/**
 * Risolve UN provider specifico per id, solo se `enabled`. Ritorna null se non
 * esiste, è disabilitato o il segreto non si decifra. Usato dal "provider
 * bloccato": niente fallback, se torna null il chiamante fallisce.
 */
export async function loadProviderById(
  db: Db,
  encryptionKey: Buffer,
  id: string,
): Promise<ResolvedProvider | null> {
  const [row] = await db
    .select({ id: aiProviders.id, kind: aiProviders.kind, label: aiProviders.label, secretEncrypted: aiProviders.secretEncrypted })
    .from(aiProviders)
    .where(and(eq(aiProviders.id, id), eq(aiProviders.enabled, true)));
  if (!row) return null;
  try {
    return { id: row.id, kind: row.kind, secret: decrypt(row.secretEncrypted, encryptionKey) };
  } catch {
    console.error(`[stubwise-worker] provider AI '${row.label}' (${row.id}) scartato: segreto non decifrabile`);
    return null;
  }
}
```
(Importa `and` da drizzle-orm.)

**Step 2.** Test (testcontainers, come gli altri test worker che usano il DB):
seed di un provider enabled → risolto; disabled → null; id inesistente → null.

**Step 3.** `pnpm --filter @stubwise/worker typecheck && pnpm --filter @stubwise/worker test chain`.

**Step 4.** Commit: `feat(worker): loadProviderById per il provider bloccato`.

---

## Task 3: Propagazione del pin nel worker (trigger → generazione → nodi)

**Files:**
- Modify: `apps/worker/src/docs/handler.ts` (trigger: usa il pin se presente)
- Modify: `apps/worker/src/docs/recursive/orient-handler.ts` (semina `doc_generations.pinned_provider_id`)
- Modify: `apps/worker/src/docs/recursive/node-dispatch.ts` (`resolveProvider` legge il pin dalla generazione)
- Test: i rispettivi `*.test.ts` esistenti (orient-handler.test, dispatch.test, handler.test)

**Contesto:** `DocJob = docGenerationJobs.$inferSelect` → dopo il Task 1
`job.pinnedProviderId` esiste. `claimNextDocJob` (`queue.ts:26`) fa `select()`
completo, quindi include già il campo (verifica). Oggi il provider è sempre
`chain[0]` in due punti: `handler.ts:88-89` (trigger/orientamento) e
`node-dispatch.ts:247 resolveProvider` (ogni nodo).

**Step 1 — trigger (`handler.ts`).** Sostituisci la scelta `chain[0]`:
```ts
let provider: ResolvedProvider | undefined;
if (job.pinnedProviderId) {
  const pinned = await loadProviderById(deps.db, deps.encryptionKey, job.pinnedProviderId);
  if (!pinned) {
    // Provider bloccato non disponibile: NIENTE fallback → fallisci il trigger/generazione.
    await failDocJob(deps.db, job.id, {
      log: "[docs] provider bloccato non disponibile (disabilitato o cancellato): generazione annullata",
      error: "pinned_provider_unavailable",
    });
    return;
  }
  provider = pinned;
} else {
  const chain = await (deps.loadProviderChainFn ?? loadProviderChain)(deps.db, deps.encryptionKey);
  provider = chain[0];
}
```
Passa anche `job.pinnedProviderId` a `runOrientation` (nuova dep opzionale
`pinnedProviderId?: string`) così l'orientamento lo semina sulla generazione.

**Step 2 — orientamento (`orient-handler.ts`).** Dove `runOrientation` crea/semina
la riga `doc_generations` (cerca l'`insert(docGenerations)` o l'update di seed),
scrivi `pinnedProviderId: deps.pinnedProviderId ?? null`. Aggiungi la dep
opzionale `pinnedProviderId?: string` a `RunOrientationDeps`.

**Step 3 — node-dispatch (`node-dispatch.ts`).** `resolveProvider` deve diventare
consapevole del pin, leggendolo dalla generazione (i nodi conoscono solo
`generationId`):
```ts
async function resolveProvider(deps: DispatchNodeDeps, generationId: string): Promise<ResolvedProvider | undefined> {
  const [gen] = await deps.db
    .select({ pinnedProviderId: docGenerations.pinnedProviderId })
    .from(docGenerations)
    .where(eq(docGenerations.id, generationId));
  if (gen?.pinnedProviderId) {
    const pinned = await loadProviderById(deps.db, deps.encryptionKey, gen.pinnedProviderId);
    if (!pinned) {
      // Pin diventato indisponibile a metà generazione: fallisci, NIENTE chain[0].
      throw new PinnedProviderUnavailableError(gen.pinnedProviderId);
    }
    return pinned;
  }
  const chain = await (deps.loadProviderChainFn ?? loadProviderChain)(deps.db, deps.encryptionKey);
  return chain[0];
}
```
Aggiorna il chiamante (`runClaimedNode`, ~riga 145) a `resolveProvider(deps, node.generationId)`. Gestisci l'errore `PinnedProviderUnavailableError`: marca la generazione `failed` con messaggio chiaro (riusa il pattern di `failGenerationOnRestart`/fail della generazione già presente nel file) e NON proseguire il nodo con `chain[0]`. Definisci una piccola classe d'errore dedicata in cima al file.

**Step 4 — test.** Aggiungi/estendi:
- `handler.test`: con `pinnedProviderId` valido → orientamento riceve quel provider (mock `loadProviderById`/chain); con pin non risolvibile → trigger `failed`, nessuna chiamata a runOrientation.
- `orient-handler.test`: il pin viene scritto su `doc_generations.pinned_provider_id`.
- `dispatch.test`: con generazione pinnata → i nodi usano quel provider (non chain[0]); pin indisponibile → generazione `failed`, mai chain[0]; senza pin → chain[0] (comportamento attuale, regressione).

Mocka `loadProviderById` dove serve (iniezione coerente con `loadProviderChainFn` già usato — valuta se aggiungere una dep `loadProviderByIdFn?` per i test, sullo stile di `loadProviderChainFn`).

**Step 5.** `pnpm --filter @stubwise/worker typecheck && pnpm --filter @stubwise/worker test docs && pnpm lint`.

**Step 6.** Commit: `feat(worker): blinda la generazione sul provider scelto (niente fallback)`.

---

## Task 4: Server — `generate` accetta providerId, `status` ritorna pinnedProvider

**Files:**
- Modify: `apps/server/src/routes/docs.ts` (POST `/docs/generate` ~281, GET `/docs/status` ~326, gli schemi Zod)
- Test: `apps/server/src/routes/docs.test.ts` (o il file dove sono testati generate/status)

**Step 1 — body generate.** Aggiungi uno schema body opzionale:
```ts
const generateBodySchema = z.object({ providerId: z.uuid().optional() }).optional();
```
Nella route: se `request.body?.providerId` è presente, valida che esista in
`aiProviders` con `enabled = true`; altrimenti `apiError(reply, 400,
"provider_not_available", "Selected provider is not available")`. Passa
`pinnedProviderId: providerId ?? null` nei `.values({...})` dell'insert del job.
Attenzione all'idempotenza: se ritorni il job attivo esistente, NON cambiare il
suo pin (documenta: vince il job in volo). Aggiorna lo `schema.body`.

**Step 2 — status pinnedProvider.** Estendi la risposta con
`pinnedProvider: z.object({ id: z.uuid(), label: z.string(), kind: docPage..(usa l'enum aiProviderKind) }).nullable()`.
Risolvi il pin della GENERAZIONE corrente (preferito) o, se non c'è generazione,
del `latestJob`: fai una select join/lookup su `aiProviders` per `label`/`kind`
dato `pinned_provider_id`. Se nessun pin → `null`.

**Step 3 — test.** generate con `providerId` di un provider enabled → 202 e il job
ha `pinned_provider_id` settato (verifica nel DB o via status); `providerId` di un
provider disabilitato o inesistente → 400; generate senza body → comportamento
attuale; status ritorna `pinnedProvider` `{id,label,kind}` quando pinnato, `null`
altrimenti. (Riusa gli helper di seed dei provider se esistono; altrimenti
inserisci una riga `aiProviders` nel test.)

**Step 4.** `pnpm --filter @stubwise/server typecheck && pnpm --filter @stubwise/server test docs && pnpm lint`.

**Step 5.** Commit: `feat(server): generate accetta providerId, status espone pinnedProvider`.

---

## Task 5: Web — client API, dropdown nel pannello, provider nello stato

**Files:**
- Modify: `apps/web/src/lib/docs-api.ts` (`generateDocs`, `DocStatus`)
- Modify: `apps/web/src/lib/queries.ts` (eventuale key per ai-providers se non c'è)
- Modify: `apps/web/src/components/docs-generation-panel.tsx`
- Possibile nuova funzione: `getAiProviders()` in un client (cerca se esiste già un client per `/api/ai-providers`; se no aggiungilo in un lib coerente, es. `lib/ai-providers-api.ts` o dentro un file settings esistente)
- Test: `apps/web/src/components/docs-generation-panel.test.tsx` (se esiste; altrimenti i test di route che montano il pannello)

**Step 1 — client.**
- `generateDocs(projectId, providerId?)` → POST con body `{ providerId }` solo se presente.
- `DocStatus` (o il tipo di ritorno di `getDocStatus`) estendi con
  `pinnedProvider: { id: string; label: string; kind: "account" | "api_key" } | null`.
- Funzione per elencare i provider abilitati (GET `/api/ai-providers`) tipizzata
  `{ id, label, kind, enabled, position }[]` (guarda lo schema pubblico in
  `apps/server/src/routes/ai-providers.ts`); filtra `enabled` lato UI.

**Step 2 — pannello.** Nel `DocsGenerationPanel` (admin):
- `useQuery` dei provider (solo se admin). Dropdown "Provider" sopra il pulsante:
  opzione default `Automatico (primo abilitato)` (value vuoto) + un'opzione per
  provider abilitato con `label` + tag kind. Stato locale `selectedProviderId`.
- `generateDocs(projectId, selectedProviderId || undefined)` nella mutation.
- Disabilita il dropdown mentre una generazione è in corso (riusa lo stato già
  presente nel pannello per il "in progress").
- Mostra `Provider: <label>` quando `status.pinnedProvider` non è null; niente in
  automatico. Se non ci sono provider, mostra solo "Automatico".
- i18n: aggiungi le chiavi necessarie in `it.json`/`en.json` (es.
  `docs.generation.provider`, `providerAuto`, `providerLabel`).

**Step 3 — test.** Il pannello: dropdown popolato dai provider mockati, default
automatico; selezionando un provider e cliccando Genera, `generateDocs` riceve il
`providerId`; con `status.pinnedProvider` valorizzato, il pannello mostra il label.

**Step 4.** `pnpm --filter @stubwise/web typecheck && pnpm --filter @stubwise/web test && pnpm lint`.

**Step 5.** Commit: `feat(web): selezione del provider bloccato nel pannello di generazione`.

---

## Task 6: Verifica finale + deploy

**Step 1.** Dalla radice del worktree: `pnpm typecheck && pnpm lint`, poi i test
toccati (`-r test` è flaky con testcontainers concorrenti: lancia per-package
db/server/worker/web se serve).

**Step 2.** REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch (merge su main).

**Step 3.** Deploy: `server` (migrazione 0030 + endpoint) + `worker` (logica
provider) + `caddy` (UI). **Il worker va ricostruito solo quando NON c'è una
generazione in corso** (`select id from doc_generations where status='running'`
vuoto). Verifica: colonne presenti, server healthy, bundle UI aggiornato.

---

## Note trasversali

- **Mai fallback quando pinnato**: né il trigger né i nodi devono ripiegare su
  `chain[0]` se il pin è impostato ma non risolvibile → fail con errore chiaro.
- **Default identico**: senza `providerId`, ZERO cambiamenti di comportamento
  (orientamento e nodi continuano con `chain[0]`).
- **Idempotenza**: un generate con providerId mentre un job è già attivo non
  cambia il pin del job in volo (documentato).
- **YAGNI**: nessun fallback nuovo nel default, nessuna impostazione di progetto.
