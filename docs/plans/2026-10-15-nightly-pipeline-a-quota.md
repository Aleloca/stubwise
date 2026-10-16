# Giro notturno — Piano A: quota degli account per tutti i lavori

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ogni run `claude` del worker sceglie l'account attraverso UN punto condiviso che riconosce il limite, ferma i run su un account al limite fino al reset, passa agli altri abbonamenti (l'account del progetto è «preferito»), non usa mai la chiave API per ripiego e tiene i lavori di sfondo sotto il 90% settimanale.

**Architecture:** un modulo `apps/worker/src/providers/select.ts` espone `selectProviders` (chi può essere usato ora, in che ordine) e `runWithProviders` (prova i candidati, marca l'account al limite con l'ora del reset, passa al successivo). Lo stato «al limite fino a» è una colonna di `ai_providers`; il margine settimanale si legge dagli snapshot `/usage` già raccolti ogni 5 minuti. Tutti i chiamanti (fix, triage, correzioni, review, backlog e refinement, posta, brief, plugin, Docs completi, daily report) migrano a `runWithProviders`.

**Tech Stack:** Node 22, TypeScript, drizzle + postgres.js, Fastify + Zod 4, React (web), Vitest + testcontainers.

**Spec:** `docs/plans/2026-10-15-nightly-pipeline-design.md` (§4, §5.1, §9). Piano B (il giro notturno): `docs/plans/2026-10-15-nightly-pipeline-b-nightly.md`, che usa `runWithProviders` con `workClass: "background"`.

## Global Constraints

- Migrazione **0088** a mano (SQL + `_journal.json`, `idx` 88, `when` = `1792022400000`, tag `0088_provider_quota`), additiva. **Fatta** (`0018f1b0`).
- La chiave API (`kind = 'api_key'`) **non entra mai nel passaggio automatico** se esiste almeno un abbonamento (`kind = 'account'`) abilitato — **anche se tutti gli abbonamenti sono al limite o oltre soglia** (il conteggio degli abbonamenti è fatto PRIMA dei filtri: è voluto, e la voce di deploy lo dice). Si usa: (a) se è il provider esplicito del progetto; (b) se l'istanza non ha NESSUN abbonamento abilitato (istanze self-hosted con sola chiave: comportamento di oggi invariato).
- Catena vuota (nessun provider abilitato) = un solo tentativo con l'auth storica del container, come oggi. Se quel tentativo finisce al limite, il fix va `held` `limit` (`holdAllProvidersLimited`), non resta in `fixing` fino allo stale.
- «Solo questo» (`ai_provider_exclusive`) ha effetto **solo con `ai_provider_id` valorizzato**: un `exclusive = true` rimasto con l'id nullo vale «preferito assente», mai «esclusivo di nessuno».
- `BACKGROUND_WEEKLY_THRESHOLD` (default 90, 1–100): un lavoro `background` non sceglie un abbonamento la cui ultima lettura settimanale **fresca** (≤ 15 minuti, `MAX_SNAPSHOT_AGE_MS`) è ≥ soglia. Senza lettura fresca, l'account è ammesso. **Sono `background`: il giro notturno (Piano B), il brief settimanale e la generazione Docs completa, tranne la sua fase product finale che è `interactive`** (decisioni del maintainer); tutto il resto è `interactive`.
- Un account «al limite» (`limited_until > now()`) non viene scelto da NESSUN lavoro.
- «Nessun account disponibile» non è un fallimento del lavoro: ogni coda rimette l'elemento in attesa **restituendo il tentativo** (UPDATE guardato), mai `failed`, mai `done` vuoto.
- La decisione di ripresa (`limit-resume-poller.ts`) e la scelta del run sono LA STESSA: `selectProviders`. Nessuna logica «fissato/catena» separata nel poller.
- I test esistenti del failover del fix (`handler.test.ts`) vanno aggiornati DICHIARANDOLO: cambia la semantica del provider fissato (da rigido a preferito) e della chiave API in catena.
- Testi visibili da i18n; segreti mai nei log.
- Ogni campo nuovo in una risposta letta dall'app nasce `.default()`.
- **Fuori dalla scelta, per costruzione** (l'invariante del Task A8 li nomina): il poller d'uso (`agent/usage-poller.ts`, deve leggere anche gli account al limite per sbloccarli), il test delle credenziali (`agent/credential-tester.ts`, prova un provider preciso), l'etichettatura del grafo (`graph/build.ts`, gira con l'auth del container e degrada a `--no-label`) e la chat RAG del server (`apps/server/src/routes/chat-llm.ts`, chiave API esplicita, ammessa dalla spec §4.3).

## Review Focus

1. **Due run paralleli sullo stesso account incontrano il limite insieme**: atteso un solo `limited_until` coerente (il più lontano), nessun errore di concorrenza, entrambi passano al prossimo abbonamento. Test in Task A3.
2. **Testo del limite senza ora di reset riconoscibile**: atteso `limited_until` dallo snapshot (`session_reset_at`/`weekly_reset_at`) o, in mancanza, `now + 60 min`; mai «al limite per sempre». Test in Task A1/A3.
3. **Istanza con la sola chiave API**: atteso il comportamento di oggi (la chiave è usata), mai «nessun provider disponibile». Test in Task A3.
4. **Progetto con account preferito disabilitato e «solo questo» spento**: atteso il passaggio agli altri abbonamenti; con «solo questo» acceso, il lavoro resta fermo con motivo `other` (come oggi per un provider fissato non risolvibile). Test in Task A3/A4.
5. **Il reset arriva prima dell'ora stimata**: atteso che un nuovo snapshot con margine (sessione < 100%, settimanale < 100%) azzeri `limited_until` e i lavori ripartano. Test in Task A6.

## Decisioni del preflight (15 ott 2026)

Il preflight (`.superpowers/sdd/2026-10-15-nightly-pipeline-a-quota/preflight.md`, D1–D18) ha verificato il piano contro il codice. Decisioni, già riportate nei task:

| # | Decisione | Dove |
|---|---|---|
| A-1 (D1) | «Solo questo» vale solo con `ai_provider_id` valorizzato: `exclusive = pref?.exclusive === true && pref.id != null`. Il server azzera `ai_provider_exclusive` quando il provider del progetto viene tolto o cancellato | A3, A7 |
| A-2 (D2) | Nuovo `emptyReason: "no_usable_provider"` (tutti i candidati scartati alla decifratura) → held `other`, mai `limit` | contratto, A3, A4 |
| A-3 (D4) | Gli esiti di fix, triage e correzione portano il testo del limite (`{ kind: "limit"; text }`); `correction.ts` non risolve nessun provider (lo riceve dall'handler): non c'è nulla da migrare lì | A4 |
| A-4 (D7, bloccante) | La ripresa (job, job Docs, generazioni in pausa) decide con `selectProviders(...).candidates.length > 0` più il margine dello snapshot sul primo candidato; via la logica «fissato/catena» separata | A6 |
| A-5 (D8) | `doc_generations.pinned_provider_id` si scrive solo se il progetto ha «solo questo»; altrimenti il provider del progetto è preferito anche per i Docs | contratto (`pinnedProviderId`), A6 |
| A-6 (D9, maintainer) | `background` = giro notturno, brief settimanale **e** generazione Docs completa. Una generazione completa senza margine va `paused` e riprende, come oggi al limite | Global Constraints, A5, A6, spec §2.9 e §4.4 |
| A-7 (D10, D11) | Per ogni coda un UPDATE guardato che rimette l'elemento `queued` restituendo il tentativo (backlog, smoke dei plugin, brief, daily report); la review riusa `requeueReviewJob` (esiste già). Chat CODE, deep dive e refinement: messaggio i18n nuovo «nessun account disponibile» (oggi non c'è nessuna gestione del limite) | A5 |
| A-8 (D15) | L'etichettatura del grafo resta sull'auth del container: fuori perimetro, dichiarata nell'invariante insieme alle altre eccezioni | Global Constraints, A8 |
| A-9 (D16) | Fra il Piano A e il Piano B il daily report resta col suo limite noto (il digest di un giorno aspetta finché il report non è `done`): accettato | A5 |
| A-10 | PR #103 (`fix/daily-report-haiku`, `DAILY_REPORT_MODEL`) si mergia PRIMA di A5 | A5, Step 0 |
| D3 | Con almeno un abbonamento abilitato la chiave API non si usa mai, nemmeno con tutti gli abbonamenti al limite: la voce di deploy lo dice | Global Constraints, A8 |
| D5 | `agent/text.ts` guadagna `runAgentTextRaw` (restituisce l'`AgentRunResult` grezzo, così il testo del limite non si perde); `runAgentText` ne diventa un involucro | contratto, A5 |
| D6 | `runWithProviders` prende il testo del limite da `ProviderLimitError.agentOutput` (A1 fa già riconoscere l'errore a `isLimitError`) | A3 |
| D12 | Snippet di `select.ts` senza `and` inutilizzato e con `AgentRunResult` importato | A3 |
| D13 | `index.ts` costruisce un solo `SelectDeps` (con `backgroundWeeklyThreshold`) per handler e poller; `processJob` riceve `projectId`; callback `onLimited(provider, index, total)` per la riga di log del job; `selectProvidersFn` iniettabile in `SelectDeps` (i 14 file di test che oggi finto-iniettano la catena lo usano invece di seminare `ai_providers`) | contratto, A3, A4, A5 |
| D14 | A7 riscrive anche `aiProviderAuto`/`aiProviderHint`; A8 aggiorna la guida utente `claude-setup.md` (rebuild di caddy) | A7, A8 |
| D17 | Auth storica + testo del limite → `holdAllProvidersLimited` | Global Constraints, A4 |
| D18 | Dopo un limite **settimanale** (il testo contiene «weekly») senza ora nel testo, `resetFor` preferisce `weekly_reset_at` | A3 |

## Cose trovate nel codice

- Oggi il provider fissato su un progetto è **rigido** (`processJob` in `handler.ts`, ramo `loadProviderByIdFn`): niente failover. Il failover esiste solo per fix/triage senza provider fissato, e la catena **include la chiave API** (posizione 4 in produzione).
- `LIMIT_MARKERS` (`providers/limit.ts`) non riconosce «You've hit your session limit» né «You've hit your weekly limit · resets …»: nessun marcatore è contenuto in quei testi.
- I chiamanti che risolvono un provider sono 17 file; fix/triage/correzioni, i nodi Docs e la review reagiscono al limite (la review riaccoda già con un cooldown: `requeueReviewJob` in `review/run-review.ts`). Gli altri (posta, backlog, brief, daily report, plugin) prendono il primo della catena o il fissato e, al limite, falliscono o scrivono un risultato vuoto; chat CODE, deep dive e refinement non hanno nessuna gestione del limite (fallimento generico).
- Il testo del limite oggi non arriva a nessuno: fix, triage e correzione restituiscono un `"limit"` nudo (`pipeline/{fix,triage,correction}.ts`), `runAgentText` restituisce `null` su exit ≠ 0 e `outputOrThrow` lancia senza l'output; il testo vive solo in `ProviderLimitError.agentOutput`.
- Le code non sanno «rimettere in attesa»: backlog (`MAX_BACKLOG_ATTEMPTS`), brief (`failBrief`) e plugin (esiti solo terminali) spendono un tentativo o chiudono.
- Il «margine» è già calcolato da `hasHeadroom`/`parseWindow` (A2 ha spostato `parseWindow`/`latestSnapshots` in `providers/usage-window.ts`).

---

## File structure

| File | Responsabilità |
|---|---|
| `packages/db/drizzle/0088_provider_quota.sql`, `schema.ts` | `ai_providers.limited_until`, `projects.ai_provider_exclusive` |
| `apps/worker/src/providers/limit.ts` | marcatori nuovi, `limitResetAt(text, now)` |
| `apps/worker/src/providers/usage-window.ts` | `parseWindow`, `latestSnapshots` (estratti da limit-resume-poller) |
| `apps/worker/src/providers/select.ts` | `selectProviders`, `runWithProviders`, `markProviderLimited` |
| `apps/worker/src/handler.ts`, `pipeline/{fix,triage,correction}.ts` | fix/triage/correzioni su `runWithProviders`; gli esiti al limite portano il testo |
| `apps/worker/src/index.ts` | un solo `SelectDeps` per handler e poller |
| `apps/worker/src/agent/text.ts` | `runAgentTextRaw` (risultato grezzo, testo del limite incluso) |
| `apps/worker/src/backlog/provider.ts` + chiamanti | backlog e refinement su `runWithProviders` |
| `apps/worker/src/review/run-review.ts`, `google/{classify,poller}.ts`, `briefs/poller.ts`, `plugins/poller.ts`, `reports/daily-report-poller.ts`, `docs/{handler,auto-update}.ts`, `docs/recursive/node-dispatch.ts` (+ handler dei nodi) | gli altri chiamanti |
| `packages/i18n/src/catalog.ts` | `backlog.noAccountAvailable` (it/en) |
| `apps/worker/src/agent/usage-poller.ts` | azzera `limited_until` quando uno snapshot fresco mostra margine |
| `apps/worker/src/providers/limit-resume-poller.ts` | riprende con la stessa decisione di `selectProviders` |
| `apps/worker/src/config.ts`, compose, `.env.example` | `BACKGROUND_WEEKLY_THRESHOLD` |
| `packages/shared/src/schemas/project.ts`, `apps/server/src/routes/{projects,ai-providers}.ts`, `apps/web/src/components/project-form.tsx` | `aiProviderExclusive` (e il suo azzeramento) |
| `apps/docs/src/content/docs/getting-started/claude-setup.md`, `docs/operations/deploy-log.md`, `docs/invariants/providers.md`, `CLAUDE.md` | documentazione |

## Interfacce (CONTRATTO)

```ts
// apps/worker/src/providers/limit.ts (Task A1, fatto)
export function isLimitError(input: AgentRunResult | Error | unknown): boolean;   // marcatori estesi; true anche per `instanceof ProviderLimitError`
export function limitResetAt(text: string, now: Date): Date | null;              // «resets 6pm (UTC)», «resets Oct 14, 1pm (UTC)», «resets 1:30pm (UTC)»
export class ProviderLimitError extends Error { readonly agentOutput: string }   // esistente: il testo vero del limite sta in agentOutput

// apps/worker/src/agent/text.ts (Task A5)
/** Come runAgentText, ma restituisce il risultato grezzo (output anche su exit ≠ 0): serve a riconoscere il limite. */
export async function runAgentTextRaw(runner: AgentRunner, opts: RunAgentTextOptions): Promise<AgentRunResult>;
// runAgentText(runner, opts) = textFromRun(await runAgentTextRaw(runner, opts)): comportamento invariato

// apps/worker/src/providers/usage-window.ts (Task A2, fatto)
export function parseWindow(value: unknown): { percentUsed: number } | null;
export interface LatestSnapshot { capturedAt: Date; parseOk: boolean; sessionRemaining: unknown; weeklyRemaining: unknown; sessionResetAt: Date | null; weeklyResetAt: Date | null }
export async function latestSnapshots(db: Db): Promise<Map<string, LatestSnapshot>>;
export const MAX_SNAPSHOT_AGE_MS = 15 * 60_000;

// apps/worker/src/providers/select.ts (Task A3)
export type WorkClass = "interactive" | "background";
export interface SelectInput {
  projectId: string | null;
  workClass: WorkClass;
  /** Provider imposto come ESCLUSIVO (generazione Docs nata con «solo questo», Task A6). Assente = si legge il progetto. */
  pinnedProviderId?: string | null;
}
export interface SelectDeps {
  db: Db;
  encryptionKey: Buffer;
  backgroundWeeklyThreshold: number;
  now?: () => Date;
  log?: (m: string) => void;
  /** Iniettabile nei test che oggi finto-iniettano la catena (loadProviderChainFn/loadProviderByIdFn). Default: selectProviders. */
  selectProvidersFn?: (deps: SelectDeps, input: SelectInput) => Promise<ProviderSelection>;
  /** Iniettabile per i test con db finto. Default: markProviderLimited (su un id inesistente è un no-op). */
  markProviderLimitedFn?: (db: Db, providerId: string, until: Date) => Promise<void>;
}
export type EmptyReason =
  | "exclusive_unavailable"   // «solo questo» su un provider disabilitato o sparito → held `other`
  | "no_usable_provider"      // tutti i candidati scartati alla decifratura → held `other`
  | "all_limited"             // tutti al limite (limited_until futuro) → held `limit`, ripresa automatica
  | "all_over_threshold";     // solo background: tutti oltre BACKGROUND_WEEKLY_THRESHOLD → in attesa
export interface ProviderSelection {
  /** Candidati in ordine di prova (decifrati). */
  candidates: ResolvedProvider[];
  /** Nessun provider abilitato: un tentativo con l'auth del container (comportamento storico). */
  legacyAuth: boolean;
  /** Perché la lista è vuota quando legacyAuth è falso. */
  emptyReason: EmptyReason | null;
}
export async function selectProviders(deps: SelectDeps, input: SelectInput): Promise<ProviderSelection>;
export async function markProviderLimited(db: Db, providerId: string, until: Date): Promise<void>;
export type ProviderRun<T> =
  | { kind: "done"; value: T; provider: ResolvedProvider | undefined }
  /** Auth storica (catena vuota) e run finito al limite: niente da marcare, il chiamante mette in attesa (fix: holdAllProvidersLimited). */
  | { kind: "legacy_limited"; value: T; limitText: string }
  | { kind: "unavailable"; reason: EmptyReason | "all_limited_now" };
export interface RunWithProvidersHooks {
  /** A ogni account trovato al limite durante i tentativi (riga di log del job: «provider i/N al limite»). index è 1-based. */
  onLimited?: (provider: ResolvedProvider, index: number, total: number) => void | Promise<void>;
}
export async function runWithProviders<T>(
  deps: SelectDeps,
  input: SelectInput,
  attempt: (provider: ResolvedProvider | undefined) => Promise<T>,
  limitTextOf: (value: T) => string | null,   // testo del limite se il run è finito al limite, altrimenti null
  hooks?: RunWithProvidersHooks,
): Promise<ProviderRun<T>>;
export function limitTextOfRun(r: AgentRunResult): string | null;   // isLimitError(r) ? r.output : null
/** Motivi che dicono «aspetta che torni margine» (ripresa automatica) contro «configurazione da sistemare». */
export function isQuotaWait(reason: EmptyReason | "all_limited_now"): boolean;   // all_limited | all_over_threshold | all_limited_now
```

---

### Task A1: Riconoscere il limite e la sua ora di reset — **fatto** (`c25f8fc0`)

> Fatto. In più rispetto al testo qui sotto: `isLimitError` riconosce anche `instanceof ProviderLimitError` (preflight D6).

**Files:**
- Modify: `apps/worker/src/providers/limit.ts`
- Test: `apps/worker/src/providers/limit.test.ts`

**Interfaces:**
- Produces: `LIMIT_MARKERS` estesi, `limitResetAt` (contratto).

- [ ] **Step 1: test che falliscono**

```ts
import { isLimitError, limitResetAt } from "./limit.js";

describe("limiti dell'abbonamento (testi veri del 13-15 ott 2026)", () => {
  const exit1 = (output: string) => ({ exitCode: 1, output }) as never;
  it("riconosce «hit your session limit» e «hit your weekly limit»", () => {
    expect(isLimitError(exit1("You've hit your session limit · resets 6pm (UTC)"))).toBe(true);
    expect(isLimitError(exit1("You've hit your weekly limit · resets Oct 14, 1pm (UTC)"))).toBe(true);
  });
  it("un exit 0 che cita il limite non è un limite", () => {
    expect(isLimitError({ exitCode: 0, output: "You've hit your session limit" } as never)).toBe(false);
  });
  it("un fallimento qualunque non è un limite", () => {
    expect(isLimitError(exit1("Error: test failed"))).toBe(false);
  });
});

describe("limitResetAt", () => {
  const now = new Date("2026-10-15T14:00:00Z");
  it("solo l'ora: oggi se è futura", () => {
    expect(limitResetAt("You've hit your session limit · resets 6pm (UTC)", now)?.toISOString()).toBe("2026-10-15T18:00:00.000Z");
  });
  it("solo l'ora già passata: domani", () => {
    expect(limitResetAt("resets 1pm (UTC)", now)?.toISOString()).toBe("2026-10-16T13:00:00.000Z");
  });
  it("con data e minuti", () => {
    expect(limitResetAt("You've hit your weekly limit · resets Oct 14, 1:30pm (UTC)", new Date("2026-10-13T10:00:00Z"))?.toISOString())
      .toBe("2026-10-14T13:30:00.000Z");
  });
  it("data a fine anno: l'anno dopo se il mese è già passato", () => {
    expect(limitResetAt("resets Jan 2, 9am (UTC)", new Date("2026-12-30T10:00:00Z"))?.toISOString()).toBe("2027-01-02T09:00:00.000Z");
  });
  it("testo senza reset riconoscibile: null", () => {
    expect(limitResetAt("You've hit your session limit", now)).toBeNull();
  });
});
```

- [ ] **Step 2: verificare che falliscano** — `pnpm --filter @stubwise/worker exec vitest run src/providers/limit.test.ts` → FAIL.

- [ ] **Step 3: implementazione**

In `LIMIT_MARKERS` aggiungere `"hit your session limit"`, `"hit your weekly limit"`, `"hit your usage limit"` (con un commento: testi del CLI 2.1.287, ott 2026). Poi:

```ts
const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
/**
 * Ora del reset annunciata dal CLI nel testo del limite («resets 6pm (UTC)»,
 * «resets Oct 14, 1:30pm (UTC)»). Solo UTC: è l'unico fuso che il CLI usa nei
 * testi osservati. Senza data: oggi se l'ora è futura, altrimenti domani. Con la
 * data: quest'anno, o il prossimo se la data è già passata da più di un giorno.
 * Null se il testo non ha un reset riconoscibile (il chiamante ripiega sullo
 * snapshot o su un'attesa fissa).
 */
export function limitResetAt(text: string, now: Date): Date | null {
  const m = /resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i.exec(text);
  if (!m) return null;
  let hour = Number(m[3]) % 12;
  if (m[5]!.toLowerCase() === "pm") hour += 12;
  const minute = m[4] !== undefined ? Number(m[4]) : 0;
  if (m[1] !== undefined) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    let at = new Date(Date.UTC(now.getUTCFullYear(), month, Number(m[2]), hour, minute));
    if (at.getTime() < now.getTime() - 86_400_000) at = new Date(Date.UTC(now.getUTCFullYear() + 1, month, Number(m[2]), hour, minute));
    return at;
  }
  let at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute));
  if (at.getTime() <= now.getTime()) at = new Date(at.getTime() + 86_400_000);
  return at;
}
```

- [ ] **Step 4: verificare** — stessi test → PASS; `pnpm --filter @stubwise/worker exec vitest run src/providers src/pipeline` → PASS (i fix che già usavano `isLimitError` ora vedono anche i testi nuovi).

- [ ] **Step 5: commit** — `fix(worker): il limite dell'abbonamento riconosciuto, con l'ora del reset`.

---

### Task A2: Migrazione 0088 e finestra d'uso condivisa — **fatto** (`0018f1b0`)

**Files:**
- Create: `packages/db/drizzle/0088_provider_quota.sql`; Modify: `_journal.json`, `packages/db/src/schema.ts`
- Create: `apps/worker/src/providers/usage-window.ts`; Modify: `limit-resume-poller.ts` (importa da lì, nessun cambio di comportamento)
- Test: `packages/db/src/migration-0088.test.ts`, `apps/worker/src/providers/usage-window.test.ts`

**Interfaces:**
- Produces: `aiProviders.limitedUntil`, `projects.aiProviderExclusive`, `parseWindow`, `latestSnapshots`, `MAX_SNAPSHOT_AGE_MS`.

- [ ] **Step 1: SQL**

```sql
-- Quota degli account (design 2026-10-15 §4): «al limite fino a» per provider e
-- «solo questo account» per progetto. Additiva.
ALTER TABLE "ai_providers" ADD COLUMN "limited_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ai_provider_exclusive" boolean DEFAULT false NOT NULL;
```

Journal: `{ "idx": 88, "version": "7", "when": 1792022400000, "tag": "0088_provider_quota", "breakpoints": true }`. In `schema.ts`: `limitedUntil: timestamp("limited_until", { withTimezone: true })` su `aiProviders` (docblock: «al limite fino a; nessun run lo sceglie prima; lo azzera uno snapshot fresco con margine»), `aiProviderExclusive: boolean("ai_provider_exclusive").notNull().default(false)` su `projects` (docblock: «true = il provider del progetto è esclusivo, niente passaggio ad altri account; false = preferito»).

- [ ] **Step 2: test della migrazione** (modello `migration-0087.test.ts`): le due colonne esistono, `ai_provider_exclusive` nasce `false` su un progetto esistente, `limited_until` nasce null.

- [ ] **Step 3: `usage-window.ts`** — sposta `parseWindow`, `LatestSnapshot`, `buildSnapshotIndex` (rinominata `latestSnapshots`, ora restituisce anche `sessionResetAt`/`weeklyResetAt`) e `MAX_SNAPSHOT_AGE_MS` da `limit-resume-poller.ts`, che li importa. Test: `parseWindow` (oggetto valido, numero non finito, null) e `latestSnapshots` su Postgres (ultimo per provider, `DISTINCT ON`).

- [ ] **Step 4: verificare** — `pnpm --filter @stubwise/db test -- migration-0088` e `pnpm --filter @stubwise/worker exec vitest run src/providers` → PASS (i test del resume poller invariati).

- [ ] **Step 5: commit** — `feat(db): 0088, account al limite e provider esclusivo del progetto`.

---

### Task A3: `selectProviders` e `runWithProviders`

**Files:**
- Create: `apps/worker/src/providers/select.ts`
- Modify: `apps/worker/src/config.ts` (+ compose, `.env.example`): `BACKGROUND_WEEKLY_THRESHOLD`
- Test: `apps/worker/src/providers/select.test.ts` (Postgres vero), `config.test.ts`

**Interfaces:**
- Consumes: Task A1, A2; `ResolvedProvider`, `decrypt`, `ProviderLimitError`.
- Produces: tutto il blocco `select.ts` del contratto (`SelectInput`, `SelectDeps` con `selectProvidersFn`/`markProviderLimitedFn`, `EmptyReason`, `ProviderRun` con `legacy_limited`, `RunWithProvidersHooks`, `limitTextOfRun`, `isQuotaWait`).

- [ ] **Step 1: test che falliscono**

Semina con un helper `provider(kind, position, { enabled?, limitedUntil?, badSecret? })` (cifra un segreto finto con la chiave di test; `badSecret` scrive un cifrato non decifrabile) e `project({ aiProviderId?, exclusive? })`. Casi:

```ts
describe("selectProviders", () => {
  it("nessun provider abilitato: legacyAuth, nessun candidato", ...);
  it("progetto senza preferito: solo abbonamenti, in ordine di position; la chiave API esclusa", ...);
  it("istanza con la SOLA chiave API: la chiave è candidata (comportamento di oggi)", ...);
  it("preferito per primo, poi gli altri abbonamenti", ...);
  it("preferito chiave API: è il primo candidato, poi gli abbonamenti", ...);
  it("«solo questo»: un solo candidato; preferito disabilitato → vuoto con exclusive_unavailable", ...);
  it("«solo questo» con ai_provider_id NULL (provider cancellato, ON DELETE SET NULL): si comporta come senza preferito, mai exclusive_unavailable né all_limited", ...);
  it("preferito disabilitato senza «solo questo»: gli altri abbonamenti", ...);
  it("pinnedProviderId in input: unico candidato anche se il progetto non è esclusivo; pin disabilitato → exclusive_unavailable", ...);
  it("account al limite (limited_until futuro) escluso; scaduto ammesso", ...);
  it("tutti al limite: vuoto con all_limited", ...);
  it("tutti gli abbonamenti al limite e una chiave API abilitata: vuoto con all_limited, la chiave NON entra (preflight D3)", ...);
  it("background: escluso l'account con settimanale ≥ soglia da snapshot fresco; ammesso con snapshot vecchio o assente", ...);
  it("interactive: lo stesso account oltre soglia è ammesso", ...);
  it("tutti oltre soglia in background: vuoto con all_over_threshold", ...);
  it("segreto non decifrabile: scartato, gli altri restano", ...);
  it("tutti i candidati non decifrabili: vuoto con no_usable_provider (mai all_limited)", ...);
});

describe("runWithProviders", () => {
  it("primo candidato riuscito: done, nessun account marcato", ...);
  it("limite sul primo: marcato con l'ora del testo, provato il secondo, onLimited(p, 1, 2) chiamato", ...);
  it("limite senza ora nel testo: limited_until dallo snapshot (il più vicino), altrimenti now+60min", ...);
  it("limite SETTIMANALE senza ora nel testo: limited_until = weekly_reset_at anche se session_reset_at è più vicino (preflight D18)", ...);
  it("ProviderLimitError lanciata: trattata come un risultato al limite, ora presa da agentOutput (preflight D6)", ...);
  it("eccezione non di limite: rilanciata, nessun account marcato", ...);
  it("tutti al limite durante i tentativi: unavailable all_limited_now", ...);
  it("legacyAuth: un tentativo con provider undefined; finito al limite → legacy_limited col testo", ...);
  it("selectProvidersFn iniettato: usato al posto della lettura di ai_providers", ...);
  it("Review Focus #1: due runWithProviders paralleli al limite sullo stesso account → un solo limited_until, il più lontano", ...);
});
```

(Ogni `...` è un test con semina, chiamata e `expect` sugli id dei candidati in ordine o sulle colonne di `ai_providers`; l'implementatore li scrive tutti, uno per riga.)

- [ ] **Step 2: verificare che falliscano.**

- [ ] **Step 3: implementazione**

```ts
// apps/worker/src/providers/select.ts
import { aiProviders, decrypt, projects, type Db } from "@stubwise/db";
import { asc, eq, sql } from "drizzle-orm";
import type { AgentRunResult } from "../agent/runner.js";
import type { ResolvedProvider } from "./chain.js";
import { isLimitError, limitResetAt, ProviderLimitError } from "./limit.js";
import { latestSnapshots, MAX_SNAPSHOT_AGE_MS, parseWindow } from "./usage-window.js";

/**
 * Scelta dell'account per OGNI run `claude` del worker (design 2026-10-15 §4).
 * UN posto solo: fix, review, backlog, posta, brief, Docs, giro notturno — e la
 * decisione di ripresa del limit-resume-poller.
 *
 * Ordine: il provider del progetto (preferito; con `ai_provider_exclusive` E un
 * id valorizzato è l'unico), poi gli ABBONAMENTI abilitati in ordine di
 * position. La chiave API entra solo se è il provider del progetto, o se
 * l'istanza non ha nessun abbonamento abilitato (self-hosted con sola chiave):
 * il conteggio degli abbonamenti è fatto PRIMA dei filtri, quindi con tutti gli
 * abbonamenti al limite la chiave resta fuori (voluto, preflight D3). Esclusi:
 * gli account «al limite» (`limited_until` futuro) e, per i lavori di sfondo,
 * gli abbonamenti oltre la soglia settimanale secondo uno snapshot fresco.
 */
export type WorkClass = "interactive" | "background";
// …SelectInput, SelectDeps, EmptyReason, ProviderSelection, ProviderRun, RunWithProvidersHooks come nel contratto…

const LIMIT_FALLBACK_MS = 60 * 60_000;

export async function selectProviders(deps: SelectDeps, input: SelectInput): Promise<ProviderSelection> {
  const now = deps.now?.() ?? new Date();
  const rows = await deps.db
    .select({ id: aiProviders.id, kind: aiProviders.kind, label: aiProviders.label, secretEncrypted: aiProviders.secretEncrypted, limitedUntil: aiProviders.limitedUntil })
    .from(aiProviders).where(eq(aiProviders.enabled, true)).orderBy(asc(aiProviders.position));
  if (rows.length === 0) return { candidates: [], legacyAuth: true, emptyReason: null };

  // Un pin esplicito (generazione Docs nata con «solo questo») vince sul progetto.
  const [pref] = input.pinnedProviderId
    ? [{ id: input.pinnedProviderId, exclusive: true }]
    : input.projectId === null ? [] : await deps.db
      .select({ id: projects.aiProviderId, exclusive: projects.aiProviderExclusive })
      .from(projects).where(eq(projects.id, input.projectId));
  // «Solo questo» vale solo con un id: ON DELETE SET NULL può lasciare exclusive=true con id nullo (preflight D1).
  const exclusive = pref?.exclusive === true && pref.id != null;
  const preferred = pref?.id ? rows.find((r) => r.id === pref.id) : undefined;
  if (exclusive && !preferred) return { candidates: [], legacyAuth: false, emptyReason: "exclusive_unavailable" };

  const hasAccount = rows.some((r) => r.kind === "account");
  const others = exclusive ? [] : rows.filter((r) => r.id !== preferred?.id && (r.kind === "account" || !hasAccount));
  let ordered = [...(preferred ? [preferred] : []), ...others];

  ordered = ordered.filter((r) => r.limitedUntil === null || r.limitedUntil.getTime() <= now.getTime());
  if (ordered.length === 0) return { candidates: [], legacyAuth: false, emptyReason: "all_limited" };

  if (input.workClass === "background") {
    const snaps = await latestSnapshots(deps.db);
    ordered = ordered.filter((r) => {
      if (r.kind !== "account") return true;
      const s = snaps.get(r.id);
      if (!s || !s.parseOk || now.getTime() - s.capturedAt.getTime() > MAX_SNAPSHOT_AGE_MS) return true;
      const weekly = parseWindow(s.weeklyRemaining);
      return weekly === null || weekly.percentUsed < deps.backgroundWeeklyThreshold;
    });
    if (ordered.length === 0) return { candidates: [], legacyAuth: false, emptyReason: "all_over_threshold" };
  }

  const candidates: ResolvedProvider[] = [];
  for (const r of ordered) {
    try {
      candidates.push({ id: r.id, kind: r.kind, secret: decrypt(r.secretEncrypted, deps.encryptionKey) });
    } catch {
      deps.log?.(`[stubwise-worker] provider AI '${r.label}' (${r.id}) scartato: segreto non decifrabile`);
    }
  }
  // Tutti scartati alla decifratura: un problema di configurazione, non di quota (preflight D2).
  return { candidates, legacyAuth: false, emptyReason: candidates.length === 0 ? "no_usable_provider" : null };
}

/** «Al limite fino a»: il più lontano fra il valore corrente e il nuovo (run paralleli). */
export async function markProviderLimited(db: Db, providerId: string, until: Date): Promise<void> {
  await db.update(aiProviders)
    .set({ limitedUntil: sql`greatest(coalesce(${aiProviders.limitedUntil}, ${until.toISOString()}::timestamptz), ${until.toISOString()}::timestamptz)` })
    .where(eq(aiProviders.id, providerId));
}

async function resetFor(deps: SelectDeps, providerId: string, text: string, now: Date): Promise<Date> {
  const fromText = limitResetAt(text, now);
  if (fromText) return fromText;
  const snap = (await latestSnapshots(deps.db)).get(providerId);
  const future = (d: Date | null | undefined): d is Date => d != null && d.getTime() > now.getTime();
  // Dopo un limite SETTIMANALE il reset di sessione non serve: riaprirebbe l'account per un run sprecato (preflight D18).
  const weekly = snap?.weeklyResetAt;
  if (/weekly/i.test(text) && future(weekly)) return weekly;
  const fromSnap = [snap?.sessionResetAt, snap?.weeklyResetAt].filter(future);
  if (fromSnap.length > 0) return new Date(Math.min(...fromSnap.map((d) => d.getTime())));
  return new Date(now.getTime() + LIMIT_FALLBACK_MS);
}

export async function runWithProviders<T>(
  deps: SelectDeps,
  input: SelectInput,
  attempt: (provider: ResolvedProvider | undefined) => Promise<T>,
  limitTextOf: (value: T) => string | null,
  hooks?: RunWithProvidersHooks,
): Promise<ProviderRun<T>> {
  const selection = await (deps.selectProvidersFn ?? selectProviders)(deps, input);
  if (selection.legacyAuth) {
    const value = await attempt(undefined);
    const limitText = limitTextOf(value);
    return limitText === null ? { kind: "done", value, provider: undefined } : { kind: "legacy_limited", value, limitText };
  }
  if (selection.candidates.length === 0) return { kind: "unavailable", reason: selection.emptyReason ?? "all_limited" };
  const mark = deps.markProviderLimitedFn ?? markProviderLimited;
  const total = selection.candidates.length;
  for (const [i, provider] of selection.candidates.entries()) {
    let limitText: string | null;
    let value: T | undefined;
    try {
      value = await attempt(provider);
      limitText = limitTextOf(value);
    } catch (error) {
      if (!isLimitError(error)) throw error;
      // ProviderLimitError porta il testo vero in agentOutput: il message non ha né marcatori né ora (preflight D6).
      limitText = error instanceof ProviderLimitError ? error.agentOutput : error instanceof Error ? error.message : String(error);
    }
    if (limitText === null) return { kind: "done", value: value as T, provider };
    const now = deps.now?.() ?? new Date();
    await mark(deps.db, provider.id, await resetFor(deps, provider.id, limitText, now));
    await hooks?.onLimited?.(provider, i + 1, total);
    deps.log?.(`[stubwise-worker] provider ${provider.id} al limite (${i + 1}/${total}): passo al successivo`);
  }
  return { kind: "unavailable", reason: "all_limited_now" };
}

export const limitTextOfRun = (r: AgentRunResult): string | null => (isLimitError(r) ? r.output : null);

export function isQuotaWait(reason: EmptyReason | "all_limited_now"): boolean {
  return reason === "all_limited" || reason === "all_over_threshold" || reason === "all_limited_now";
}
```

Config: `BACKGROUND_WEEKLY_THRESHOLD` intero 1–100, default 90, nello stile di `LIMIT_RESUME_HEADROOM_PERCENT`; `backgroundWeeklyThreshold` nel tipo e nel ritorno; compose `- BACKGROUND_WEEKLY_THRESHOLD=${BACKGROUND_WEEKLY_THRESHOLD:-90}` (il worker non ha `env_file`: una env non elencata in compose non arriva); `.env.example` vuota con commento, accanto a `LIMIT_RESUME_HEADROOM_PERCENT`. Test di config: default, override, 0 e 101 rifiutati.

- [ ] **Step 4: verificare** — `pnpm --filter @stubwise/worker exec vitest run src/providers src/config.test.ts` → PASS; `pnpm --filter @stubwise/worker lint` → pulito.

- [ ] **Step 5: commit** — `feat(worker): scelta dell'account in un posto solo (preferito, abbonamenti, soglia per lo sfondo)`.

---

### Task A4: Fix, triage e correzioni su `runWithProviders`

**Files:**
- Modify: `apps/worker/src/handler.ts` (`processJob`, `runJobWithProvider`, `createHandler`), `apps/worker/src/pipeline/fix.ts`, `apps/worker/src/pipeline/triage.ts`, `apps/worker/src/pipeline/correction.ts` (solo il tipo d'esito), `apps/worker/src/index.ts` (costruisce `SelectDeps`)
- Test: `apps/worker/src/handler.test.ts`, `apps/worker/src/pipeline/{fix,triage,correction}.test.ts`

**Interfaces:**
- Consumes: `runWithProviders` (A3) con `workClass: "interactive"`.
- Produces: `deps.select: SelectDeps` in `HandlerDeps` (sostituisce `loadProviderChainFn`/`loadProviderByIdFn`); esiti al limite con testo.

Premesse corrette (preflight D4, D11, D13):
- Oggi fix, triage e correzione restituiscono un `"limit"` nudo (`FixOutcome`, `TriageOutcome`, l'esito di `correction.ts`) e buttano l'output: il testo vive solo in `ProviderLimitError.agentOutput`. L'esito al limite diventa `{ kind: "limit"; text: string }` nei tre file (i chiamanti che confrontano con `"limit"` si aggiornano), così `runJobWithProvider` restituisce `{ limited: boolean; limitText: string | null }`.
- `correction.ts` **non risolve nessun provider**: lo riceve dall'handler via `runJobWithProvider` (`resolveProviderUserId` lì è il provider GIT). In quel file cambia solo il tipo dell'esito.
- `processJob` oggi riceve `aiProviderId`, non `projectId`: `createHandler` gli passa `row.projectId`.

Comportamento:
- `processJob` chiama `runWithProviders(deps.select, { projectId, workClass: "interactive" }, (p) => runJobWithProvider(…, p), (r) => r.limitText, { onLimited })`, dove `onLimited(provider, i, n)` scrive la riga di log del job di oggi («provider i/N al limite: failover alla credenziale successiva»).
- `unavailable` con `exclusive_unavailable` o `no_usable_provider` → `holdJobWithReason(…, "other")` (messaggio di oggi per il provider disabilitato / non decifrabile); con `all_limited`, `all_over_threshold` (non succede per `interactive`, ma il ramo è lo stesso) o `all_limited_now` → `holdAllProvidersLimited` (held `limit`, ripresa automatica). Usare `isQuotaWait`.
- `legacy_limited` (catena vuota, run al limite) → `holdAllProvidersLimited` (preflight D17: oggi il job restava in `fixing` fino allo stale).
- `index.ts` costruisce UN `SelectDeps` (`{ db, encryptionKey, backgroundWeeklyThreshold: config.backgroundWeeklyThreshold, log }`) e lo passa all'handler; A5 e A6 lo passano ai poller.
- Test: i file di test che oggi iniettano `loadProviderChainFn`/`loadProviderByIdFn` (14 in `apps/worker/src`, `grep -l`) passano a `select: { …, selectProvidersFn }` con una selezione finta, invece di seminare righe `ai_providers`. I test della scelta vera stanno in `select.test.ts`.

- [ ] **Step 1: test** — aggiornare i test di failover di `handler.test.ts` alla nuova semantica, DICHIARANDOLO nel commit: provider fissato → preferito (al limite passa al successivo abbonamento); fissato + esclusivo → held al limite come oggi; chiave API in catena non usata se ci sono abbonamenti. Aggiungere: «tutti al limite → held limit», «esclusivo disabilitato → held other», «tutti non decifrabili → held other», «account già al limite non viene nemmeno provato» (`limited_until` futuro, il runner finto non riceve chiamate con quel provider), «catena vuota e run al limite → held limit», «il testo del limite arriva a `markProviderLimited` con l'ora del reset» (fix e triage: l'esito `{ kind: "limit", text }`), «una riga di log del job per ogni passaggio». In `correction.test.ts`: l'esito al limite porta il testo.
- [ ] **Step 2: fallire, implementare, passare** — `pnpm --filter @stubwise/worker exec vitest run src/handler.test.ts src/pipeline`.
- [ ] **Step 3: commit** — `feat(worker): fix e correzioni passano fra gli abbonamenti, il provider del progetto è preferito`.

---

### Task A5: Backlog, refinement, review, posta, brief, plugin e daily report

**Files:**
- Step 0: merge di `origin/fix/daily-report-haiku` (PR #103, `DAILY_REPORT_MODEL`) — o di `main` se la PR è già mergiata — nel branch di lavoro, PRIMA di toccare `daily-report-poller.ts`.
- Modify: `apps/worker/src/agent/text.ts` (`runAgentTextRaw`; `runAgentText` ne diventa un involucro, comportamento invariato)
- Modify: `apps/worker/src/backlog/provider.ts` (`resolveBacklogProvider` sostituita da un wrapper su `runWithProviders`), e i chiamanti `backlog/{chat-turn,deep-dive,estimate,intake}.ts`, `backlog/refine/turn.ts`; `backlog/poller.ts` (solo il tipo delle deps e la rimessa in coda)
- Modify: `apps/worker/src/review/run-review.ts`, `apps/worker/src/google/{classify,poller}.ts`, `apps/worker/src/briefs/poller.ts`, `apps/worker/src/plugins/poller.ts`, `apps/worker/src/reports/daily-report-poller.ts`, `apps/worker/src/index.ts` (il `SelectDeps` del Task A4 a ogni poller)
- Modify: `packages/i18n/src/catalog.ts` (`backlog.noAccountAvailable`, it/en)
- Test: i `*.test.ts` accanto a ciascuno, `agent/text.test.ts`

**Interfaces:**
- Consumes: `runWithProviders`, `limitTextOfRun`, `isQuotaWait` (A3); `SelectDeps` da `index.ts` (A4).
- Produces: `runAgentTextRaw` (contratto), usato anche dal Piano B.

- [ ] **Step 0: merge di PR #103** — `git merge origin/fix/daily-report-haiku` (o `main` se la PR è già entrata), conflitti risolti, `pnpm --filter @stubwise/worker test -- config` verde. Da qui `DAILY_REPORT_MODEL` esiste.

Il testo del limite (preflight D5): ogni run che oggi passa da `runAgentText` o da `outputOrThrow` passa da `runAgentTextRaw` + `limitTextOfRun`; intake e stima controllano `isLimitError(result)` PRIMA di `outputOrThrow` (che lancia senza l'output). Il run al limite non va mai «fallito con exit N».

Classe di lavoro per chiamante e cosa succede con `unavailable` (la decisione sta QUI, una riga di commento in ciascun punto). «Restituire il tentativo» = un UPDATE **guardato** sullo stato `running` dell'elemento appena reclamato: `SET status = 'queued', attempts = attempts - 1` (dove la coda ha `attempts`), così un riavvio o un secondo tick non lo vedono due volte e il tetto dei tentativi non si consuma per la quota:

| Chiamante | `workClass` | Se `unavailable` (motivo di quota, `isQuotaWait`) |
|---|---|---|
| chat CODE, deep dive | `interactive` | messaggio i18n NUOVO `backlog.noAccountAvailable` nella chat della voce (oggi non c'è nessuna gestione del limite: il fallimento è generico, `backlog.codeTurnError`); il job `backlog_jobs` si chiude come oggi per un turno fallito |
| refinement | `interactive` | input `turn_failed` come per un turno fallito, più lo stesso messaggio i18n come risposta |
| stima, intake | `interactive` | `backlog_jobs` rimesso `queued` restituendo il tentativo (`attempts - 1`): senza, tre tick senza account lo porterebbero a `failed` (`MAX_BACKLOG_ATTEMPTS`) |
| review delle PR | `interactive` | `failRunningReview` + `requeueReviewJob` (esistono già e già riaccodano con cooldown al limite: oggi il ramo è `isLimitError` sul risultato, si estende a `unavailable`). `pr_reviews` non ha uno stato `pending`: l'attesa è la riga di `pr_review_jobs` |
| classificazione della posta (classificazione E riattribuzione, i due run di `classify.ts`) | `interactive` | il messaggio resta `new` (non passa da `markFailed`): il prossimo giro del poller lo riprende |
| brief settimanale | `background` | `project_briefs` rimesso `queued` restituendo il tentativo; MAI `failBrief` (spende tentativi) né `{ ok: true, summary: null }` (chiude il brief `done` vuoto, è il ramo di oggi «nessun provider») |
| smoke dei plugin | `interactive` | `plugin_jobs` rimesso `queued` restituendo il tentativo (oggi ogni esito è terminale: va aggiunto il ramo) |
| generazione Docs completa: orientamento e nodi (Task A6) | `background` | trigger `held` `limit` (orientamento) o generazione `paused` (nodi); la riprende il resume poller con la stessa scelta |
| generazione Docs completa: fase product finale (Task A6, decisione del maintainer) | `interactive` | ogni run passa da `runWithProviders` (al limite cambia account); senza account la fase si interrompe e lo dichiara in `doc_generations.stats.productSkipped` + una riga di log; generazione comunque `succeeded`, nessuna pausa (non restano nodi da cui riprendere) |
| daily report (finché esiste il poller; il Piano B lo assorbe) | `background` | `activity_reports` rimesso `queued` (non `failed`, non `done`): la fase «queued» del poller lo riprende al tick dopo per qualunque data entro la retention. Limite noto accettato (A-9): finché il report del giorno non è `done` il digest di quel giorno aspetta, e un report fa più run (uno per commit più il riassunto) |

Motivi di configurazione (`exclusive_unavailable`, `no_usable_provider`): come un errore del lavoro (il messaggio di errore di oggi, la coda segue la sua regola dei tentativi) con una riga di log che nomina il motivo. Non sono quota: rimettere in coda per sempre un lavoro che nessun account potrà mai fare è un ciclo.

Rimessa in coda senza attesa: un elemento rimesso `queued` viene ripreso al tick successivo, che rifà `selectProviders` (una lettura, nessun run) e lo rimette in coda finché manca un account. È un ciclo a vuoto economico e accettato; un `not_before` per coda è fuori da questo piano.

Per ogni chiamante: un test «primo account al limite → usato il secondo» e un test «nessun account disponibile → il lavoro resta da fare (non fallito, non `done`) e il tentativo non è consumato». Per chat e deep dive: «nessun account → messaggio `backlog.noAccountAvailable`». Per `text.ts`: `runAgentTextRaw` restituisce l'output anche su exit ≠ 0; `runAgentText` invariato.

- [ ] **Step 1–3**: test che falliscono, implementazione, `pnpm --filter @stubwise/worker test` → PASS.
- [ ] **Step 4: commit** — uno per famiglia: `runAgentTextRaw`, backlog e refinement; review e posta; brief, plugin e daily report.

---

### Task A6: Docs completi, ripresa e azzeramento del limite

**Files:**
- Modify: `apps/worker/src/docs/handler.ts` (seme di `pinned_provider_id`), `apps/worker/src/docs/recursive/node-dispatch.ts` e gli handler dei nodi (`docs/recursive/*-handler.ts`: `{ limit: true, text }`), `apps/worker/src/docs/auto-update.ts` (anche se spento: deve almeno fermarsi al primo limite finché esiste)
- Modify: `apps/worker/src/agent/usage-poller.ts`, `apps/worker/src/providers/limit-resume-poller.ts`, `apps/worker/src/index.ts` (il `SelectDeps` al resume poller e al dispatch)
- Test: i test accanto

Comportamento:
- **Generazione Docs completa = `background`** (decisione del maintainer A-6), **tranne la fase product finale, `interactive`** (decisione del maintainer del 15 ott, dopo la review di A6: account fino al limite; senza account il salto resta dichiarato in `stats.productSkipped`): la scelta per ogni nodo passa da `selectProviders(deps.select, { projectId, workClass: "background", pinnedProviderId: gen.pinnedProviderId })` (il `projectId` del dispatch si ricava con un join generazione → repository → progetto: oggi il dispatch conosce solo `generationId`). Senza margine (`isQuotaWait`) la generazione va `paused` come oggi al limite e riprende col resume poller; `exclusive_unavailable`/`no_usable_provider` → come oggi `PinnedProviderUnavailableError` (la generazione fallisce, il motivo nel log).
- **`pinned_provider_id`** (preflight D8, A-5): `docs/handler.ts` lo scrive SOLO se il progetto ha `ai_provider_exclusive = true` (e un `ai_provider_id`); senza «solo questo» resta null e il provider del progetto è preferito come per ogni altro lavoro. Il trigger fallisce per provider non risolvibile solo nel caso esclusivo (oggi lo fa per ogni pin). Le generazioni già in corso al deploy con un pin restano rigide: la voce di deploy lo dice.
- Handler dei nodi: al limite restituiscono `{ limit: true, text }` (il testo dell'output o di `ProviderLimitError.agentOutput`), così il dispatch chiama `markProviderLimited` con l'ora del testo invece del ripiego snapshot/+60'.
- `auto-update.ts`: al primo run al limite (`isLimitError`) il job si interrompe subito (niente `continue`). Basta questo: il Piano B lo rimuove.
- `usage-poller.ts`: dopo aver salvato uno snapshot `parseOk` con sessione < 100% e settimanale < 100%, `update ai_providers set limited_until = null where id = … and limited_until is not null` (Review Focus #5). Il poller d'uso NON passa da `selectProviders`: deve leggere anche gli account al limite.
- **`limit-resume-poller.ts`** (preflight D7, bloccante): la decisione di ripresa per i tre rami — job `held` per limite, job Docs, generazioni `paused` — diventa la stessa della scelta: `const sel = await selectProviders(deps.select, { projectId, workClass, pinnedProviderId })`; si riprende solo se `sel.candidates.length > 0` (o `sel.legacyAuth`) **e** il primo candidato ha margine secondo lo snapshot (`hasHeadroom` esistente, chiamato su `sel.candidates[0]`). Classe: `interactive` per i job di fix, `background` per le generazioni Docs. Spariscono i rami «progetto fissato → solo quel provider» e `chain.some(...)` su una catena che include la chiave API (che, passato il cooldown di 60', «aveva margine» e faceva ripartire job che `runWithProviders` rimetteva subito in `held`, con due commenti AI sul ticket a ogni giro).

- [ ] **Step 1–3**: test, implementazione, PASS. Test:
  - snapshot con margine → `limited_until` azzerato; snapshot al 100% → invariato; snapshot `parseOk = false` → invariato;
  - resume poller: **«tutti gli abbonamenti al limite + chiave API in catena → job NON ripreso»**; **«nessun commento AI ripetuto sul ticket»** (due tick consecutivi senza account: zero commenti `comment.limitResumed`/`comment.providersLimitHeld` nuovi); un abbonamento tornato disponibile → ripreso; progetto esclusivo col suo account al limite → non ripreso anche se altri abbonamenti sono liberi; generazione `paused` con tutti oltre soglia → resta `paused`, sotto soglia → ripresa;
  - Docs: progetto senza «solo questo» → `pinned_provider_id` null e un nodo al limite sul preferito passa al secondo abbonamento; con «solo questo» → pin scritto e nessun passaggio; nodo al limite → `limited_until` dall'ora del testo;
  - auto-update si ferma al primo limite.
- [ ] **Step 4: commit** — `feat(worker): Docs e ripresa leggono lo stato «al limite» degli account`.

---

### Task A7: «Solo questo account» nel progetto (shared, server, web)

**Files:**
- Modify: `packages/shared/src/schemas/project.ts` (`aiProviderExclusive: z.boolean().default(false)` nella risposta, `.optional()` negli input di creazione e patch), `apps/server/src/routes/projects.ts` (lettura e scrittura), `apps/server/src/routes/ai-providers.ts` (cancellazione), `apps/web/src/components/project-form.tsx` (checkbox sotto la scelta del provider, visibile solo con un provider scelto), i18n web `apps/web/src/i18n/locales/{en,it}.json`
- Test: `packages/shared/src/schemas/project.test.ts` (risposta senza il campo → false), `apps/server/src/routes/projects.test.ts` (patch e lettura), `apps/server/src/routes/ai-providers.test.ts` (cancellazione), test del form web (checkbox solo con provider scelto; fixture senza il campo)
- Create: `.changeset/shared-provider-exclusive.md` (`@stubwise/shared` minor)

Azzeramento (preflight D1, A-1): «solo questo» senza provider non ha senso e non deve sopravvivere.
- `PATCH /api/projects/:id` con `aiProviderId: null` scrive anche `ai_provider_exclusive = false` (qualunque cosa dica il body); con `aiProviderExclusive: true` e nessun provider (né nel body né in colonna) → `ai_provider_exclusive` resta `false`.
- `DELETE` del provider (`ai-providers.ts`, dove oggi c'è `.delete(aiProviders)`): nella stessa transazione, PRIMA della cancellazione, `update projects set ai_provider_exclusive = false where ai_provider_id = :id` (l'`ON DELETE SET NULL` azzera l'id, non il flag). Il worker è comunque difeso (A3), ma il dato resta pulito e la UI non mostra una casella accesa senza provider.

Testi: etichetta «Usa solo questo account» / «Use only this account», aiuto «Se è al limite, i lavori di questo progetto aspettano invece di passare a un altro account.» / «When it hits its limit, this project's work waits instead of switching to another account.». L'etichetta del provider del progetto (`projects:form.aiProvider`) diventa «Account preferito» / «Preferred account». Da riscrivere anche (preflight D14): `aiProviderAuto` (oggi «Automatico (catena con failover)») → «Automatico (abbonamenti in ordine)» / «Automatic (subscriptions in order)»; `aiProviderHint` → «// vale per tutti i lavori del progetto; se è al limite si passa agli altri abbonamenti (mai alla chiave API), salvo «solo questo».» / «// applies to all of this project's work; when it hits its limit the other subscriptions take over (never the API key), unless "only this" is on.».

- [ ] **Step 1–3**: test (compresi: «patch con provider null → esclusivo azzerato», «cancellazione del provider → esclusivo azzerato sui progetti che lo usavano, intatto sugli altri»), implementazione, `pnpm --filter @stubwise/shared test && pnpm --filter @stubwise/server test -- projects ai-providers && pnpm --filter @stubwise/web test -- project-form` → PASS.
- [ ] **Step 4: commit** — `feat: account del progetto preferito, con l'opzione «solo questo»`.

---

### Task A8: Documentazione e verifica finale

- `docs/operations/deploy-log.md`: voce «Quota degli account» (15 ott 2026). Ordine: server (0088) poi worker (controllo d'inattività), poi **caddy** (testi web e guida utente). Env nuova `BACKGROUND_WEEKLY_THRESHOLD`. **Cambi di comportamento**: provider fissato da rigido a preferito (chi vuole il comportamento di prima accende «solo questo» sul progetto); **la chiave API non si usa mai finché c'è almeno un abbonamento abilitato, nemmeno con tutti gli abbonamenti al limite** (oggi in produzione è in catena in posizione 4, come ultimo ripiego: dopo il deploy un lavoro aspetta il reset invece di spendere a consumo); generazione Docs completa e brief settimanale sotto la soglia del 90% settimanale; le generazioni Docs già in corso con un pin restano rigide fino alla fine. Rollback: innocuo per il server (colonne additive); il worker vecchio torna al comportamento rigido.
- `apps/docs/src/content/docs/getting-started/claude-setup.md`, sezione «Failover» (preflight D14): riscritta sulla semantica nuova (abbonamenti in ordine, account del progetto preferito, «solo questo», la chiave API fuori dal passaggio automatico se esistono abbonamenti, soglia per lo sfondo, «al limite fino al reset»). Richiede il rebuild di `caddy`.
- `CLAUDE.md`: riga d'indice della voce; invariante breve in `docs/invariants/` (file nuovo `providers.md`) e la sua riga nell'elenco di CLAUDE.md: «la scelta dell'account sta in `providers/select.ts`, e la ripresa usa la stessa funzione; un chiamante nuovo non risolve un provider da sé». **Eccezioni ammesse, nominate**: il poller d'uso (`agent/usage-poller.ts`), il test delle credenziali (`agent/credential-tester.ts`), l'etichettatura del grafo (`graph/build.ts`, auth del container, fuori perimetro per decisione: degrada a `--no-label`) e la chat RAG del server (`apps/server/src/routes/chat-llm.ts`, chiave API esplicita).
- Verifica: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.
- Commit `docs: quota degli account, voce di deploy e invariante`.
