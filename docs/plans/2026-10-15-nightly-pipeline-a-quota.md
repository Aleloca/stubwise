# Giro notturno — Piano A: quota degli account per tutti i lavori

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ogni run `claude` del worker sceglie l'account attraverso UN punto condiviso che riconosce il limite, ferma i run su un account al limite fino al reset, passa agli altri abbonamenti (l'account del progetto è «preferito»), non usa mai la chiave API per ripiego e tiene i lavori di sfondo sotto il 90% settimanale.

**Architecture:** un modulo `apps/worker/src/providers/select.ts` espone `selectProviders` (chi può essere usato ora, in che ordine) e `runWithProviders` (prova i candidati, marca l'account al limite con l'ora del reset, passa al successivo). Lo stato «al limite fino a» è una colonna di `ai_providers`; il margine settimanale si legge dagli snapshot `/usage` già raccolti ogni 5 minuti. Tutti i chiamanti (fix, triage, correzioni, review, backlog e refinement, posta, brief, plugin, Docs completi, daily report) migrano a `runWithProviders`.

**Tech Stack:** Node 22, TypeScript, drizzle + postgres.js, Fastify + Zod 4, React (web), Vitest + testcontainers.

**Spec:** `docs/plans/2026-10-15-nightly-pipeline-design.md` (§4, §5.1, §9). Piano B (il giro notturno): `docs/plans/2026-10-15-nightly-pipeline-b-nightly.md`, che usa `runWithProviders` con `workClass: "background"`.

## Global Constraints

- Migrazione **0088** a mano (SQL + `_journal.json`, `idx` 88, `when` = `1792022400000`, tag `0088_provider_quota`), additiva.
- La chiave API (`kind = 'api_key'`) **non entra mai nel passaggio automatico** se esiste almeno un abbonamento (`kind = 'account'`) abilitato. Si usa: (a) se è il provider esplicito del progetto; (b) se l'istanza non ha NESSUN abbonamento abilitato (istanze self-hosted con sola chiave: comportamento di oggi invariato).
- Catena vuota (nessun provider abilitato) = un solo tentativo con l'auth storica del container, come oggi.
- `BACKGROUND_WEEKLY_THRESHOLD` (default 90, 1–100): un lavoro `background` non sceglie un abbonamento la cui ultima lettura settimanale **fresca** (≤ 15 minuti, `MAX_SNAPSHOT_AGE_MS` di oggi) è ≥ soglia. Senza lettura fresca, l'account è ammesso.
- Un account «al limite» (`limited_until > now()`) non viene scelto da NESSUN lavoro.
- I test esistenti del failover del fix (`handler.test.ts`) vanno aggiornati DICHIARANDOLO: cambia la semantica del provider fissato (da rigido a preferito) e della chiave API in catena.
- Testi visibili da i18n; segreti mai nei log.
- Ogni campo nuovo in una risposta letta dall'app nasce `.default()`.

## Review Focus

1. **Due run paralleli sullo stesso account incontrano il limite insieme**: atteso un solo `limited_until` coerente (il più lontano), nessun errore di concorrenza, entrambi passano al prossimo abbonamento. Test in Task A3.
2. **Testo del limite senza ora di reset riconoscibile**: atteso `limited_until` dallo snapshot (`session_reset_at`/`weekly_reset_at`) o, in mancanza, `now + 60 min`; mai «al limite per sempre». Test in Task A1/A3.
3. **Istanza con la sola chiave API**: atteso il comportamento di oggi (la chiave è usata), mai «nessun provider disponibile». Test in Task A3.
4. **Progetto con account preferito disabilitato e «solo questo» spento**: atteso il passaggio agli altri abbonamenti; con «solo questo» acceso, il lavoro resta fermo con motivo `other` (come oggi per un provider fissato non risolvibile). Test in Task A3/A4.
5. **Il reset arriva prima dell'ora stimata**: atteso che un nuovo snapshot con margine (sessione < 100%, settimanale < 100%) azzeri `limited_until` e i lavori ripartano. Test in Task A6.

## Cose trovate nel codice

- Oggi il provider fissato su un progetto è **rigido** (`handler.ts:287-313`): niente failover. Il failover esiste solo per fix/triage senza provider fissato, e la catena **include la chiave API** (posizione 4 in produzione).
- `LIMIT_MARKERS` (`providers/limit.ts`) non riconosce «You've hit your session limit» né «You've hit your weekly limit · resets …»: nessun marcatore è contenuto in quei testi.
- I chiamanti che risolvono un provider sono 17 file; solo fix/triage/correzioni e i nodi Docs reagiscono al limite. Gli altri (review, posta, backlog, brief, daily report, plugin) prendono il primo della catena o il fissato e, al limite, falliscono o scrivono un risultato vuoto.
- Il «margine» è già calcolato da `hasHeadroom`/`parseWindow` in `limit-resume-poller.ts`: si estrae in un modulo condiviso invece di duplicarlo.

---

## File structure

| File | Responsabilità |
|---|---|
| `packages/db/drizzle/0088_provider_quota.sql`, `schema.ts` | `ai_providers.limited_until`, `projects.ai_provider_exclusive` |
| `apps/worker/src/providers/limit.ts` | marcatori nuovi, `limitResetAt(text, now)` |
| `apps/worker/src/providers/usage-window.ts` | `parseWindow`, `latestSnapshots` (estratti da limit-resume-poller) |
| `apps/worker/src/providers/select.ts` | `selectProviders`, `runWithProviders`, `markProviderLimited` |
| `apps/worker/src/handler.ts`, `pipeline/{fix,triage,correction}.ts` | fix/triage/correzioni su `runWithProviders` |
| `apps/worker/src/backlog/provider.ts` + chiamanti | backlog e refinement su `runWithProviders` |
| `apps/worker/src/review/run-review.ts`, `google/{classify,poller}.ts`, `briefs/poller.ts`, `plugins/poller.ts`, `reports/daily-report-poller.ts`, `docs/{handler,auto-update}.ts`, `docs/recursive/node-dispatch.ts` | gli altri chiamanti |
| `apps/worker/src/agent/usage-poller.ts` | azzera `limited_until` quando uno snapshot fresco mostra margine |
| `apps/worker/src/providers/limit-resume-poller.ts` | riprende anche in base a `limited_until` |
| `apps/worker/src/config.ts`, compose, `.env.example` | `BACKGROUND_WEEKLY_THRESHOLD` |
| `packages/shared/src/schemas/project.ts`, `apps/server/src/routes/projects.ts`, `apps/web/src/components/project-form.tsx` | `aiProviderExclusive` |

## Interfacce (CONTRATTO)

```ts
// apps/worker/src/providers/limit.ts (Task A1)
export function isLimitError(input: AgentRunResult | Error | unknown): boolean;   // marcatori estesi
export function limitResetAt(text: string, now: Date): Date | null;              // «resets 6pm (UTC)», «resets Oct 14, 1pm (UTC)», «resets 1:30pm (UTC)»

// apps/worker/src/providers/usage-window.ts (Task A2)
export function parseWindow(value: unknown): { percentUsed: number } | null;
export interface LatestSnapshot { capturedAt: Date; parseOk: boolean; sessionRemaining: unknown; weeklyRemaining: unknown; sessionResetAt: Date | null; weeklyResetAt: Date | null }
export async function latestSnapshots(db: Db): Promise<Map<string, LatestSnapshot>>;
export const MAX_SNAPSHOT_AGE_MS = 15 * 60_000;

// apps/worker/src/providers/select.ts (Task A3)
export type WorkClass = "interactive" | "background";
export interface SelectDeps { db: Db; encryptionKey: Buffer; backgroundWeeklyThreshold: number; now?: () => Date; log?: (m: string) => void }
export interface ProviderSelection {
  /** Candidati in ordine di prova (decifrati). */
  candidates: ResolvedProvider[];
  /** Nessun provider abilitato: un tentativo con l'auth del container (comportamento storico). */
  legacyAuth: boolean;
  /** Perché la lista è vuota quando legacyAuth è falso. */
  emptyReason: "exclusive_unavailable" | "all_limited" | "all_over_threshold" | null;
}
export async function selectProviders(deps: SelectDeps, input: { projectId: string | null; workClass: WorkClass }): Promise<ProviderSelection>;
export async function markProviderLimited(db: Db, providerId: string, until: Date): Promise<void>;
export type ProviderRun<T> =
  | { kind: "done"; value: T; provider: ResolvedProvider | undefined }
  | { kind: "unavailable"; reason: NonNullable<ProviderSelection["emptyReason"]> | "all_limited_now" };
export async function runWithProviders<T>(
  deps: SelectDeps,
  input: { projectId: string | null; workClass: WorkClass },
  attempt: (provider: ResolvedProvider | undefined) => Promise<T>,
  limitTextOf: (value: T) => string | null,   // testo del limite se il run è finito al limite, altrimenti null
): Promise<ProviderRun<T>>;
```

---

### Task A1: Riconoscere il limite e la sua ora di reset

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

### Task A2: Migrazione 0088 e finestra d'uso condivisa

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
- Consumes: Task A1, A2; `ResolvedProvider`, `decrypt`.
- Produces: tutto il blocco `select.ts` del contratto.

- [ ] **Step 1: test che falliscono**

Semina con un helper `provider(kind, position, { enabled?, limitedUntil? })` (cifra un segreto finto con la chiave di test) e `project({ aiProviderId?, exclusive? })`. Casi:

```ts
describe("selectProviders", () => {
  it("nessun provider abilitato: legacyAuth, nessun candidato", ...);
  it("progetto senza preferito: solo abbonamenti, in ordine di position; la chiave API esclusa", ...);
  it("istanza con la SOLA chiave API: la chiave è candidata (comportamento di oggi)", ...);
  it("preferito per primo, poi gli altri abbonamenti", ...);
  it("preferito chiave API: è il primo candidato, poi gli abbonamenti", ...);
  it("«solo questo»: un solo candidato; preferito disabilitato → vuoto con exclusive_unavailable", ...);
  it("preferito disabilitato senza «solo questo»: gli altri abbonamenti", ...);
  it("account al limite (limited_until futuro) escluso; scaduto ammesso", ...);
  it("tutti al limite: vuoto con all_limited", ...);
  it("background: escluso l'account con settimanale ≥ soglia da snapshot fresco; ammesso con snapshot vecchio o assente", ...);
  it("interactive: lo stesso account oltre soglia è ammesso", ...);
  it("tutti oltre soglia in background: vuoto con all_over_threshold", ...);
  it("segreto non decifrabile: scartato, gli altri restano", ...);
});

describe("runWithProviders", () => {
  it("primo candidato riuscito: done, nessun account marcato", ...);
  it("limite sul primo: marcato con l'ora del testo, provato il secondo", ...);
  it("limite senza ora nel testo: limited_until dallo snapshot, altrimenti now+60min", ...);
  it("limite lanciato come eccezione (isLimitError): trattato come un risultato al limite", ...);
  it("eccezione non di limite: rilanciata, nessun account marcato", ...);
  it("tutti al limite durante i tentativi: unavailable all_limited_now", ...);
  it("legacyAuth: un tentativo con provider undefined", ...);
  it("Review Focus #1: due runWithProviders paralleli al limite sullo stesso account → un solo limited_until, il più lontano", ...);
});
```

(Ogni `...` è un test con semina, chiamata e `expect` sugli id dei candidati in ordine o sulle colonne di `ai_providers`; l'implementatore li scrive tutti, uno per riga.)

- [ ] **Step 2: verificare che falliscano.**

- [ ] **Step 3: implementazione**

```ts
// apps/worker/src/providers/select.ts
import { aiProviders, decrypt, projects, type Db } from "@stubwise/db";
import { and, asc, eq, sql } from "drizzle-orm";
import type { ResolvedProvider } from "./chain.js";
import { isLimitError, limitResetAt } from "./limit.js";
import { latestSnapshots, MAX_SNAPSHOT_AGE_MS, parseWindow } from "./usage-window.js";

/**
 * Scelta dell'account per OGNI run `claude` del worker (design 2026-10-15 §4).
 * UN posto solo: fix, review, backlog, posta, brief, Docs, giro notturno.
 *
 * Ordine: il provider del progetto (preferito; con `ai_provider_exclusive` è
 * l'unico), poi gli ABBONAMENTI abilitati in ordine di position. La chiave API
 * entra solo se è il provider del progetto, o se l'istanza non ha nessun
 * abbonamento (self-hosted con sola chiave). Esclusi: gli account «al limite»
 * (`limited_until` futuro) e, per i lavori di sfondo, gli abbonamenti oltre la
 * soglia settimanale secondo uno snapshot fresco.
 */
export type WorkClass = "interactive" | "background";
// …SelectDeps, ProviderSelection, ProviderRun come nel contratto…

const LIMIT_FALLBACK_MS = 60 * 60_000;

export async function selectProviders(deps: SelectDeps, input: { projectId: string | null; workClass: WorkClass }): Promise<ProviderSelection> {
  const now = deps.now?.() ?? new Date();
  const rows = await deps.db
    .select({ id: aiProviders.id, kind: aiProviders.kind, label: aiProviders.label, secretEncrypted: aiProviders.secretEncrypted, limitedUntil: aiProviders.limitedUntil })
    .from(aiProviders).where(eq(aiProviders.enabled, true)).orderBy(asc(aiProviders.position));
  if (rows.length === 0) return { candidates: [], legacyAuth: true, emptyReason: null };

  const [pref] = input.projectId === null ? [] : await deps.db
    .select({ id: projects.aiProviderId, exclusive: projects.aiProviderExclusive })
    .from(projects).where(eq(projects.id, input.projectId));
  const preferred = pref?.id ? rows.find((r) => r.id === pref.id) : undefined;
  if (pref?.exclusive && pref.id && !preferred) return { candidates: [], legacyAuth: false, emptyReason: "exclusive_unavailable" };

  const hasAccount = rows.some((r) => r.kind === "account");
  const others = pref?.exclusive ? [] : rows.filter((r) => r.id !== preferred?.id && (r.kind === "account" || !hasAccount));
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
  return { candidates, legacyAuth: false, emptyReason: candidates.length === 0 ? "all_limited" : null };
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
  const fromSnap = [snap?.sessionResetAt, snap?.weeklyResetAt].filter((d): d is Date => d != null && d.getTime() > now.getTime());
  if (fromSnap.length > 0) return new Date(Math.min(...fromSnap.map((d) => d.getTime())));
  return new Date(now.getTime() + LIMIT_FALLBACK_MS);
}

export async function runWithProviders<T>(
  deps: SelectDeps,
  input: { projectId: string | null; workClass: WorkClass },
  attempt: (provider: ResolvedProvider | undefined) => Promise<T>,
  limitTextOf: (value: T) => string | null,
): Promise<ProviderRun<T>> {
  const selection = await selectProviders(deps, input);
  if (selection.legacyAuth) return { kind: "done", value: await attempt(undefined), provider: undefined };
  if (selection.candidates.length === 0) return { kind: "unavailable", reason: selection.emptyReason ?? "all_limited" };
  for (const provider of selection.candidates) {
    let limitText: string | null;
    let value: T | undefined;
    try {
      value = await attempt(provider);
      limitText = limitTextOf(value);
    } catch (error) {
      if (!isLimitError(error)) throw error;
      limitText = error instanceof Error ? error.message : String(error);
    }
    if (limitText === null) return { kind: "done", value: value as T, provider };
    const now = deps.now?.() ?? new Date();
    await markProviderLimited(deps.db, provider.id, await resetFor(deps, provider.id, limitText, now));
    deps.log?.(`[stubwise-worker] provider ${provider.id} al limite: passo al successivo`);
  }
  return { kind: "unavailable", reason: "all_limited_now" };
}
```

Helper per i chiamanti (stesso file): `export const limitTextOfRun = (r: AgentRunResult): string | null => (isLimitError(r) ? r.output : null);`.

Config: `BACKGROUND_WEEKLY_THRESHOLD` intero 1–100, default 90, nello stile delle env vicine; `backgroundWeeklyThreshold` nel tipo e nel ritorno; compose `- BACKGROUND_WEEKLY_THRESHOLD=${BACKGROUND_WEEKLY_THRESHOLD:-90}`; `.env.example` vuota con commento. Test di config: default, override, 0 e 101 rifiutati.

- [ ] **Step 4: verificare** — `pnpm --filter @stubwise/worker exec vitest run src/providers src/config.test.ts` → PASS.

- [ ] **Step 5: commit** — `feat(worker): scelta dell'account in un posto solo (preferito, abbonamenti, soglia per lo sfondo)`.

---

### Task A4: Fix, triage e correzioni su `runWithProviders`

**Files:**
- Modify: `apps/worker/src/handler.ts:272-345` (`processJob`), `apps/worker/src/pipeline/correction.ts` (risoluzione del provider), eventuali `deps.loadProviderByIdFn`/`loadProviderChainFn` (sostituiti da `SelectDeps` iniettabile)
- Test: `apps/worker/src/handler.test.ts`, `apps/worker/src/pipeline/correction.test.ts`

**Interfaces:**
- Consumes: `runWithProviders` (A3) con `workClass: "interactive"`; `runJobWithProvider` resta (restituisce `limited: boolean`; per `limitTextOf` serve il testo: farla restituire `{ limited: boolean; limitText: string | null }`).

Comportamento:
- `processJob` chiama `runWithProviders(deps.select, { projectId, workClass: "interactive" }, (p) => runJobWithProvider(…, p), (r) => r.limitText)`.
- `unavailable` con `exclusive_unavailable` → `holdJobWithReason(…, "other")` (messaggio di oggi per il provider disabilitato); qualunque altro motivo → `holdAllProvidersLimited` (held `limit`, ripresa automatica).
- Log del job a ogni passaggio (come oggi: «provider i/N al limite: failover alla credenziale successiva»).

- [ ] **Step 1: test** — aggiornare i test di failover di `handler.test.ts` alla nuova semantica, DICHIARANDOLO nel commit: provider fissato → preferito (al limite passa al successivo abbonamento); fissato + esclusivo → held al limite come oggi; chiave API in catena non usata se ci sono abbonamenti. Aggiungere: «tutti al limite → held limit», «esclusivo disabilitato → held other», «account già al limite non viene nemmeno provato» (`limited_until` futuro, il runner finto non riceve chiamate con quel provider).
- [ ] **Step 2: fallire, implementare, passare** — `pnpm --filter @stubwise/worker exec vitest run src/handler.test.ts src/pipeline`.
- [ ] **Step 3: commit** — `feat(worker): fix e correzioni passano fra gli abbonamenti, il provider del progetto è preferito`.

---

### Task A5: Backlog, refinement, review, posta, brief, plugin e daily report

**Files:**
- Modify: `apps/worker/src/backlog/provider.ts` (`resolveBacklogProvider` sostituita da un wrapper su `runWithProviders`), e i chiamanti `backlog/{chat-turn,deep-dive,estimate,intake,poller}.ts`, `backlog/refine/turn.ts`
- Modify: `apps/worker/src/review/run-review.ts`, `apps/worker/src/google/{classify,poller}.ts`, `apps/worker/src/briefs/poller.ts`, `apps/worker/src/plugins/poller.ts`, `apps/worker/src/reports/daily-report-poller.ts`
- Test: i `*.test.ts` accanto a ciascuno

**Interfaces:**
- Consumes: `runWithProviders` (A3).

Classe di lavoro per chiamante (la decisione sta QUI, una riga di commento in ciascun punto):

| Chiamante | `workClass` | Se `unavailable` |
|---|---|---|
| chat CODE, deep dive, refinement, stima, intake | `interactive` | errore in parole come oggi al limite (messaggio della voce / input `turn_failed` per il refinement); intake e stima restano in coda e si riprovano |
| review delle PR | `interactive` | la review resta `pending` e si riprova al prossimo tick (oggi fallisce) |
| classificazione della posta | `interactive` | il messaggio resta da classificare, si riprova al prossimo giro del poller |
| brief settimanale | `background` | la settimana resta da generare, si riprova al prossimo tick |
| smoke dei plugin | `interactive` | il job resta in coda |
| daily report (finché esiste il poller; il Piano B lo assorbe) | `background` | il report non viene marcato `done`: si riprova al prossimo tick (oggi i report del 12-13 ott sono rimasti vuoti per sempre) |

Per ogni chiamante: un test «primo account al limite → usato il secondo» e un test «nessun account disponibile → il lavoro resta da fare (non fallito, non `done`)».

- [ ] **Step 1–3**: test che falliscono, implementazione, `pnpm --filter @stubwise/worker test` → PASS.
- [ ] **Step 4: commit** — uno per famiglia: backlog e refinement; review e posta; brief, plugin e daily report.

---

### Task A6: Docs completi, ripresa e azzeramento del limite

**Files:**
- Modify: `apps/worker/src/docs/handler.ts`, `apps/worker/src/docs/recursive/node-dispatch.ts` (e gli handler dei nodi che usano `isLimitError`), `apps/worker/src/docs/auto-update.ts` (anche se spento: deve almeno fermarsi al primo limite finché esiste)
- Modify: `apps/worker/src/agent/usage-poller.ts`, `apps/worker/src/providers/limit-resume-poller.ts`
- Test: i test accanto

Comportamento:
- Generazione Docs completa: la scelta passa da `selectProviders` con `workClass: "background"`; al limite il nodo marca l'account (`markProviderLimited`) e la generazione va in `paused` come oggi; la ripresa avviene quando `selectProviders` restituisce almeno un candidato.
- `auto-update.ts`: al primo run al limite (`isLimitError`) il job si interrompe subito (niente `continue`). Basta questo: il Piano B lo rimuove.
- `usage-poller.ts`: dopo aver salvato uno snapshot `parseOk` con sessione < 100% e settimanale < 100%, `update ai_providers set limited_until = null where id = … and limited_until is not null` (Review Focus #5).
- `limit-resume-poller.ts`: `hasHeadroom` aggiunge la condizione «`limited_until` nullo o passato»; i test esistenti restano verdi.

- [ ] **Step 1–3**: test (snapshot con margine → `limited_until` azzerato; snapshot al 100% → invariato; resume poller non riprende un job il cui unico provider ha `limited_until` futuro; auto-update si ferma al primo limite), implementazione, PASS.
- [ ] **Step 4: commit** — `feat(worker): Docs e ripresa leggono lo stato «al limite» degli account`.

---

### Task A7: «Solo questo account» nel progetto (shared, server, web)

**Files:**
- Modify: `packages/shared/src/schemas/project.ts` (`aiProviderExclusive: z.boolean().default(false)` nella risposta, `.optional()` negli input di creazione e patch), `apps/server/src/routes/projects.ts` (lettura e scrittura), `apps/web/src/components/project-form.tsx` (checkbox sotto la scelta del provider, visibile solo con un provider scelto), i18n web `en`/`it`
- Test: `packages/shared/src/schemas/project.test.ts` (risposta senza il campo → false), `apps/server/src/routes/projects.test.ts` (patch e lettura), test del form web (checkbox solo con provider scelto; fixture senza il campo)
- Create: `.changeset/shared-provider-exclusive.md` (`@stubwise/shared` minor)

Testi: etichetta «Usa solo questo account» / «Use only this account», aiuto «Se è al limite, i lavori di questo progetto aspettano invece di passare a un altro account.» / «When it hits its limit, this project's work waits instead of switching to another account.». L'etichetta del provider del progetto diventa «Account preferito» / «Preferred account».

- [ ] **Step 1–3**: test, implementazione, `pnpm --filter @stubwise/shared test && pnpm --filter @stubwise/server test -- projects && pnpm --filter @stubwise/web test -- project-form` → PASS.
- [ ] **Step 4: commit** — `feat: account del progetto preferito, con l'opzione «solo questo»`.

---

### Task A8: Documentazione e verifica finale

- `docs/operations/deploy-log.md`: voce «Quota degli account» (15 ott 2026). Ordine: server (0088) poi worker. Env nuova `BACKGROUND_WEEKLY_THRESHOLD`. **Cambio di comportamento**: provider fissato da rigido a preferito (chi vuole il comportamento di prima accende «solo questo» sul progetto); chiave API fuori dal ripiego automatico se esistono abbonamenti. Rollback: innocuo per il server (colonne additive); il worker vecchio torna al comportamento rigido.
- `CLAUDE.md`: riga d'indice della voce; invariante breve in `docs/invariants/` (file nuovo `providers.md`): «la scelta dell'account sta in `providers/select.ts`; un chiamante nuovo non risolve un provider da sé».
- Verifica: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.
- Commit `docs: quota degli account, voce di deploy e invariante`.
