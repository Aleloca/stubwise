# L'utilizzo degli account dal `rate_limit_event` — piano

> **Per chi esegue:** SUB-SKILL OBBLIGATORIA: superpowers:subagent-driven-development (consigliata) o superpowers:executing-plans, task per task. I passi usano le caselle (`- [ ]`).

**Obiettivo:** lo snapshot d'uso degli account Claude si scrive dal `rate_limit_event` dello stream-json (run veri + run minimo per gli account fermi); spariscono PTY `/usage`, parser e fallback Haiku sulla chiave API.

**Architettura:** un modulo puro legge l'evento; `StreamingClaudeRunner` lo consegna appena arriva a una callback `onRateLimit` delle opzioni del run; `TrackingAgentRunner` la aggancia per i provider `account` e scrive lo snapshot (e decide lo sblocco) attraverso funzioni di `providers/usage-window.ts`. Il poller d'uso diventa uno scheduler di run minimi. I lettori (`hasHeadroom`, soglia di sfondo) trattano una finestra assente o resettata come 0%.

**Stack:** TypeScript, Node 22, Vitest (+ testcontainers per il DB), Drizzle.

**Spec:** `docs/plans/2026-11-19-utilizzo-account-da-rate-limit-event-design.md` — leggerla prima di cominciare.

## Vincoli globali

- Si lavora SOLO nel worktree `.claude/worktrees/usage-rate-limit`, branch `fix/usage-da-rate-limit-event` (base = produzione `d3e94841`). Mai `main`, mai push senza richiesta.
- **Nessuna migrazione**, nessun valore nuovo di enum: snapshot nuovi con `source = 'deterministic'`, `parse_ok = true`, `raw_text = null`.
- Jsonb delle finestre nella forma esistente: `{ percentUsed, percentRemaining, resetsLabel: null }` (interi 0–100, complementari).
- `utilization` è una frazione: ×100 arrotondato; **> 1 → 100**; negativa/non numerica → finestra scartata.
- Sblocco (`limited_until = null`) solo con `status === "allowed"` **e** ogni finestra dell'evento < 100.
- `USAGE_PROBE_IDLE_MINUTES`: intero ≥ 1, default **30**. `MAX_SNAPSHOT_AGE_MS` = **45′**. `USAGE_POLL_MINUTES` resta (default 5, 0 = spento).
- Run minimo: operazione `usage_probe`, `projectId: null`, modello `"haiku"`, `maxTurns: 1`, `timeoutMs: 60_000`, `permissionMode: "default"`, cwd = directory temporanea vuota.
- Tutto fail-open: un errore di parse/insert/callback si logga (mai segreti) e non tocca l'esito del run.
- Ogni commit: `pnpm lint` (o eslint sui file toccati), test del file intero toccato, commit, in catena `&&`; output su file letto dopo, mai `cmd | tail` prima del commit. Commit solo con percorsi espliciti (`git commit -- <percorsi>`), mai `-a` (`graphify-out/` è sempre sporco).
- Test con testcontainers: Docker solo per i test, e si fermano solo i container propri.
- Dopo un fix si rilancia il **file di test intero**, non solo il caso nuovo.

## Focus della review

1. **Evento in un run respinto per limite** (`status: "rejected"`): lo snapshot si scrive, lo sblocco NO. → test nel Task 3.
2. **Finestra extra a 100 con `allowed`** (es. `seven_day_opus`): niente sblocco, anche se `seven_day` < 100. → Task 3.
3. **Callback che lancia o insert che fallisce** a metà di un run vero: il run finisce con il suo esito. → Task 2 (runner) e Task 4 (tracking).
4. **Reset già passato** in uno snapshot (es. `weekly_reset_at` di ieri al 100%): conta 0%, non blocca la ripresa né la soglia di sfondo. → Task 3.
5. **Account al limite con 100% e reset futuro**: nessuna sonda (niente credito extra); passato il reset, sì. → Task 5.

---

### Task 1: lettura pura dell'evento

**File:**
- Create: `apps/worker/src/agent/rate-limit-event.ts`
- Test: `apps/worker/src/agent/rate-limit-event.test.ts`

**Interfacce:**
- Produce:
  ```ts
  export interface RateLimitWindow { usedPercent: number; resetsAt: Date | null }
  export interface RateLimitInfo {
    status: string;                 // "allowed" | "allowed_warning" | "rejected" | altro
    rateLimitType: string | null;
    windows: Record<string, RateLimitWindow>; // TUTTE le chiavi valide di unifiedWindows
  }
  export function parseRateLimitEvent(ev: Record<string, unknown>): RateLimitInfo | null
  ```

- [ ] **Passo 1: test che falliscono.** Fixture = le tre righe vere del design (Stubwise Claude Max 0.18, Anthropic Account 0.38, Account Leo 0.28, con i loro `resetsAt`). Casi:
  - `parseRateLimitEvent(leo)` → `{ status: "allowed", rateLimitType: "seven_day", windows: { seven_day: { usedPercent: 28, resetsAt: new Date(1795428000 * 1000) } } }`.
  - forma vecchia senza `unifiedWindows` (`{ status:"allowed", rateLimitType:"five_hour", utilization:0.5, resetsAt:1795400000 }`) → `windows: { five_hour: { usedPercent: 50, … } }`.
  - `unifiedWindows: { seven_day: { utilization: 1.04, resetsAt } }` → `usedPercent: 100`.
  - finestra con `utilization: -1` o `"x"` scartata; se non resta nessuna finestra → `null`.
  - `resetsAt` assente o non numerico → `resetsAt: null`.
  - `type` diverso da `rate_limit_event`, o `rate_limit_info` mancante → `null`.
  - più finestre (`seven_day` + `seven_day_opus`) → entrambe in `windows`.
- [ ] **Passo 2:** `pnpm --filter @stubwise/worker exec vitest run src/agent/rate-limit-event.test.ts` → FAIL (modulo assente).
- [ ] **Passo 3:** implementare `parseRateLimitEvent` (nessuna dipendenza, nessun throw).
- [ ] **Passo 4:** stesso comando → PASS.
- [ ] **Passo 5:** lint + commit `feat(worker): lettura del rate_limit_event dello stream-json`.

### Task 2: il runner in streaming consegna l'evento

**File:**
- Modify: `apps/worker/src/agent/runner.ts` (`AgentRunOptions`, vicino a `provider?:`, riga ~218)
- Modify: `apps/worker/src/agent/streaming-cli.ts` (handler `lines.on("line", …)`, riga ~527)
- Test: `apps/worker/src/agent/streaming-cli.test.ts`

**Interfacce:**
- Consuma: `parseRateLimitEvent`, `RateLimitInfo` (Task 1).
- Produce, su `AgentRunOptions`:
  ```ts
  /** Chiamata (fire-and-forget) quando il CLI emette un rate_limit_event; `at` = istante d'arrivo. Solo StreamingClaudeRunner. */
  onRateLimit?: (info: RateLimitInfo, at: Date) => void | Promise<void>;
  ```

- [ ] **Passo 1: test che falliscono.** Estendere lo script `FAKE`: se il testo contiene `RATELIMIT` emette, prima di `finish`, `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"seven_day","unifiedWindows":{"seven_day":{"utilization":0.28,"resetsAt":1795428000}}}}`. Test:
  - «consegna il rate_limit_event a onRateLimit con l'istante d'arrivo»: una chiamata, `info.windows.seven_day.usedPercent === 28`, `at` fra prima e dopo il run.
  - «una onRateLimit che lancia (sincrona o promise rifiutata) non cambia l'esito del run»: `exitCode` 0, `output` con `echo:`.
  - «senza RATELIMIT la callback non è chiamata».
- [ ] **Passo 2:** `pnpm --filter @stubwise/worker exec vitest run src/agent/streaming-cli.test.ts` → i nuovi FAIL.
- [ ] **Passo 3:** nel handler delle righe, per `ev.type === "rate_limit_event"`: `parseRateLimitEvent(ev)`; se non null chiamare `opts.onRateLimit?.(info, new Date())` dentro try/catch, e `Promise.resolve(...).catch(log)` per la versione async. Non entra in `toSessionEvents` (resta fuori dalle sessioni). Aggiornare il commento alla riga ~239 che nomina `rate_limit_event`. `ClaudeCliRunner` non cambia.
- [ ] **Passo 4:** stesso comando, file intero → PASS.
- [ ] **Passo 5:** lint + commit `feat(worker): il runner in streaming consegna il rate_limit_event`.

### Task 3: snapshot, sblocco e lettori in `usage-window`

**File:**
- Modify: `apps/worker/src/providers/usage-window.ts`
- Modify: `apps/worker/src/providers/limit-resume-poller.ts` (`hasHeadroom`, riga ~120)
- Modify: `apps/worker/src/providers/select.ts` (filtro `background`, riga ~152)
- Test: `apps/worker/src/providers/usage-window.test.ts`, `limit-resume-poller.test.ts`, `select.test.ts`

**Interfacce:**
- Consuma: `RateLimitInfo` (Task 1).
- Produce, in `usage-window.ts`:
  ```ts
  export const MAX_SNAPSHOT_AGE_MS = 45 * 60_000;
  /** % usata EFFETTIVA: finestra assente → 0; resetAt passato → 0; altrimenti percentUsed. */
  export function effectiveUsedPercent(value: unknown, resetAt: Date | null, now: Date): number;
  /** Inserisce lo snapshot (five_hour → session, seven_day → weekly). Nessuna delle due → non scrive, ritorna false. */
  export async function writeRateLimitSnapshot(db: Db, providerId: string, info: RateLimitInfo, capturedAt: Date): Promise<boolean>;
  /** status "allowed" e ogni finestra < 100. */
  export function rateLimitAllowsUnlock(info: RateLimitInfo): boolean;
  /** Azzera limited_until se valorizzato; true se ha scritto. Logga lo sblocco. */
  export async function clearProviderLimit(db: Db, providerId: string): Promise<boolean>;
  ```
  `writeRateLimitSnapshot` scrive `captured_at = capturedAt` (esplicito, non `now()`).

- [ ] **Passo 1: test che falliscono** (`usage-window.test.ts`, DB vero):
  - `writeRateLimitSnapshot` con la fixture di Leo → riga con `weeklyRemaining = { percentUsed: 28, percentRemaining: 72, resetsLabel: null }`, `sessionRemaining = null`, `weeklyResetAt = 2026-11-23T10:00:00Z`, `source = "deterministic"`, `parseOk = true`, `rawText = null`, `capturedAt` = quello passato.
  - con solo `seven_day_opus` → ritorna `false`, nessuna riga.
  - `rateLimitAllowsUnlock`: `allowed` + tutto < 100 → true; `rejected` → false; `allowed` con `seven_day` 40 e `seven_day_opus` 100 → false.
  - `effectiveUsedPercent`: `null` → 0; `{percentUsed: 100}` con reset ieri → 0; con reset domani → 100; reset `null` → percentUsed.
  - `clearProviderLimit`: con `limited_until` futuro → true e colonna null; già null → false.
- [ ] **Passo 2: test che falliscono sui lettori:**
  - `limit-resume-poller.test.ts`: «snapshot fresco con la sola settimanale al 30% → headroom (riprende senza cooldown)»; «sola settimanale al 100% con reset passato → riprende»; aggiornare i casi esistenti che presumono 15′ di freschezza se ne dipendono.
  - `select.test.ts`: «sfondo: settimanale oltre soglia ma `weekly_reset_at` passato → ammesso».
- [ ] **Passo 3:** `pnpm --filter @stubwise/worker exec vitest run src/providers/usage-window.test.ts src/providers/limit-resume-poller.test.ts src/providers/select.test.ts` → i nuovi FAIL.
- [ ] **Passo 4:** implementare. `hasHeadroom`: con snapshot fresco e `parseOk`, margine = `effectiveUsedPercent(session, sessionResetAt, now) < headroomPercent && effectiveUsedPercent(weekly, weeklyResetAt, now) < 100` (niente più ricaduta al fallback quando manca la sessione). `select.ts`: `effectiveUsedPercent(s.weeklyRemaining, s.weeklyResetAt, now) < backgroundWeeklyThreshold`. Commento di `MAX_SNAPSHOT_AGE_MS` riscritto (soglia della sonda 30′ + un giro + margine).
- [ ] **Passo 5:** stesso comando, file interi → PASS.
- [ ] **Passo 6:** lint + commit `feat(worker): snapshot d'uso dal rate_limit_event e finestre che possono mancare`.

### Task 4: `TrackingAgentRunner` scrive lo snapshot

**File:**
- Modify: `apps/worker/src/agent/tracking-runner.ts`
- Test: `apps/worker/src/agent/tracking-runner.test.ts`

**Interfacce:**
- Consuma: `onRateLimit` (Task 2), `writeRateLimitSnapshot`, `rateLimitAllowsUnlock`, `clearProviderLimit` (Task 3).

- [ ] **Passo 1: test che falliscono.** Runner interno finto che chiama `opts.onRateLimit?.(info, at)` durante `run`. Seminare un provider `account` oltre a quello `api_key` esistente. Casi:
  - account → una riga in `ai_usage_snapshots` col `captured_at` = `at`, anche con `record: false`;
  - account con `limited_until` futuro e info `allowed` < 100 → `limited_until` null; con `rejected` → invariato;
  - `api_key` o nessun provider → nessuna riga, e la `onRateLimit` del chiamante riceve comunque l'evento;
  - la `onRateLimit` del chiamante è chiamata anche per l'account (concatenazione);
  - insert che fallisce (provider id inesistente → FK) → il run ritorna il suo risultato, nessun throw.
- [ ] **Passo 2:** `pnpm --filter @stubwise/worker exec vitest run src/agent/tracking-runner.test.ts` → FAIL.
- [ ] **Passo 3:** in `run`, se `opts.provider?.kind === "account"`, passare a `inner.run` una `onRateLimit` che (a) inoltra a quella del chiamante, (b) `writeRateLimitSnapshot`, poi se `rateLimitAllowsUnlock(info)` → `clearProviderLimit`; tutto in try/catch con log. Aggiornare il docblock della classe (punto 4: snapshot d'uso).
- [ ] **Passo 4:** stesso comando, file intero → PASS.
- [ ] **Passo 5:** lint + commit `feat(worker): ogni run di un account lascia lo snapshot d'uso`.

### Task 5: il poller diventa la sonda degli account fermi; via PTY e parser

**File:**
- Modify (riscrittura): `apps/worker/src/agent/usage-poller.ts`, `apps/worker/src/agent/usage-poller.test.ts`
- Delete: `apps/worker/src/agent/usage-pty.ts`, `usage-pty.test.ts`, `usage-parser.ts`, `usage-parser.test.ts`
- Modify: `apps/worker/src/config.ts` (+ `config.test.ts`), `apps/worker/src/index.ts` (riga ~381), `.env.example` (righe ~95–115)
- Modify: `apps/worker/src/agent/tracking-runner.ts` (docblock di `trackedClaudeCliRunner`: la sonda non lo usa più)

**Interfacce:**
- Consuma: `latestSnapshots`, `LatestSnapshot`, `parseWindow` (esistenti), `TrackingAgentRunner`, `StreamingClaudeRunner`, `loadProviderChain`.
- Produce:
  ```ts
  export function shouldProbe(
    account: { limitedUntil: Date | null },
    snap: LatestSnapshot | undefined,   // parseOk false = come assente
    now: Date, idleMs: number, tickMs: number,
  ): boolean;
  export interface ProbeDeps { db: Db; encryptionKey: Buffer; runner: AgentRunner; idleMs: number; tickMs: number; now?: () => Date }
  export async function probeIdleAccountsOnce(deps: ProbeDeps): Promise<void>;
  export function startUsagePoller(opts: { db: Db; encryptionKey: Buffer; intervalMinutes: number; idleMinutes: number; signal: AbortSignal }): () => void;
  ```
  Config: `usageProbeIdleMinutes: number` da `USAGE_PROBE_IDLE_MINUTES`.

- [ ] **Passo 1: test che falliscono** (`usage-poller.test.ts`, tutto nuovo; i test di `buildRunLlmFromChain`/`pollUsageOnce` si tolgono):
  - `shouldProbe` (puro): senza snapshot → true; snapshot di 10′ → false; di 31′ → true; `parseOk false` → true; al limite con snapshot di 6′ e tick 5′ → true; al limite con settimanale 100 e `weeklyResetAt` domani → false; stesso ma reset ieri → true.
  - `probeIdleAccountsOnce` (DB vero, runner finto): sonda solo gli account che ne hanno bisogno (account fresco no, account fermo sì, `api_key` mai, disabilitato mai); opzioni del run = vincoli globali (`usage_probe`, `projectId: null`, `"haiku"`, `maxTurns: 1`, `timeoutMs: 60_000`, `permissionMode: "default"`, `provider` = l'account); un run che lancia sul primo account non ferma il secondo; la funzione non lancia mai.
  - `config.test.ts`: default 30, valore esplicito, `0` e non intero rifiutati.
- [ ] **Passo 2:** `pnpm --filter @stubwise/worker exec vitest run src/agent/usage-poller.test.ts src/config.test.ts` → FAIL.
- [ ] **Passo 3:** implementare. `limitedUntil` si legge da `ai_providers` (la catena non lo porta). Gli account si sondano in sequenza. `startUsagePoller` costruisce `new TrackingAgentRunner({ inner: new StreamingClaudeRunner(), db, models: createModelResolver(db, console) })` — streaming sempre, anche con `AGENT_STREAMING=false`; lo snapshot lo scrive il Task 4, il poller non scrive snapshot. Niente sovrapposizione fra giri, `unref`, stop sull'`AbortSignal` (come oggi). Cancellare PTY e parser; `index.ts` passa `idleMinutes` e il log d'avvio dice «sonda d'uso ogni N′ (fermi da M′)». `.env.example`: blocco riscritto + `USAGE_PROBE_IDLE_MINUTES=`, e nei commenti di `LIMIT_RESUME_*` «snapshot fresco (≤ 45′)» al posto di «/usage» e «15 minuti».
- [ ] **Passo 4:** `grep -rn "usage-pty\|usage-parser\|buildRunLlmFromChain\|captureUsageOutput" apps packages --include='*.ts'` → nessun risultato. `pnpm --filter @stubwise/worker typecheck` → pulito. Test del passo 2, file interi → PASS.
- [ ] **Passo 5:** lint + commit `feat(worker): sonda d'uso per gli account fermi, via PTY e parser di /usage`.

### Task 6: server, scenari golden e voce di deploy

**File:**
- Modify: `apps/server/src/routes/usage-snapshots.ts` (solo docblock: origine dal `rate_limit_event`, `resetsLabel` null per i nuovi, `source` `deterministic` = letto senza LLM)
- Modify: `packages/db/src/schema.ts` (solo il commento dell'enum `ai_usage_source` / della tabella, se parla di `/usage` o del parser)
- Modify: `apps/worker/scripts/golden/run.ts` (+ `README.md` accanto)
- Modify: `docs/operations/deploy-log.md` (voce nuova in coda), `CLAUDE.md` (una riga nell'indice delle voci)

- [ ] **Passo 1:** golden: ogni scenario che usa `StreamingClaudeRunner` passa una `onRateLimit` che conta gli eventi; il riepilogo finale stampa per scenario «rate_limit_event: N» e fallisce lo scenario `plan-only` se N = 0 (così un CLI aggiornato che cambia l'evento salta fuori lì). README: una riga che lo dice.
- [ ] **Passo 2:** voce di deploy-log «L'utilizzo degli account dal rate_limit_event» (19 nov 2026): cosa ribuildare (`worker`; `server` facoltativo, solo docblock; niente `caddy`), **da questo branch e non da `main`**, nessuna migrazione, env nuova `USAGE_PROBE_IDLE_MINUTES` (default 30, non serve impostarla), controllo d'inattività prima del riavvio del worker, verifica post-deploy (`select p.label, s.captured_at, s.weekly_remaining from ai_usage_snapshots s join ai_providers p on p.id = s.provider_id where s.captured_at > now() - interval '35 minutes' and s.parse_ok` → una riga per account; nessuna `agent_runs` `usage_probe` nuova con provider `api_key`), rollback (immagine vecchia del worker: torna il PTY, rotto ma innocuo; nessuna pulizia).
- [ ] **Web:** nessun cambio (decisione del piano): il pannello già mostra la sola settimanale e usa `weeklyResetAt` quando `resetsLabel` manca; così il deploy non tocca `caddy`.
- [ ] **Passo 3:** `pnpm --filter @stubwise/server typecheck && pnpm --filter @stubwise/worker typecheck` → pulito.
- [ ] **Passo 4:** lint + commit `docs: rilascio dell'utilizzo dal rate_limit_event, golden che lo verifica`.

### Task 7 (rimandabile): via `node-pty` dal worker

**File:**
- Modify: `apps/worker/package.json`, `pnpm-lock.yaml`, `apps/worker/Dockerfile` (righe ~19–26 e ~58–63)

- [ ] **Passo 1:** verificare che nient'altro compili addon nativi nel worker: `find node_modules/.pnpm -name binding.gyp -not -path '*node-pty*'` dalla radice, e `pnpm why <pacchetto>` per ciascun risultato: conta solo ciò che è dipendenza (anche transitiva) di `@stubwise/worker`. Se c'è altro che serve la toolchain, togliere solo il `chmod` dello `spawn-helper` e lasciare la toolchain, aggiornandone il commento.
- [ ] **Passo 2:** `pnpm --filter @stubwise/worker remove node-pty` e ritocco del Dockerfile.
- [ ] **Passo 3:** `docker build -f apps/worker/Dockerfile .` riesce (poi rimuovere l'immagine di prova); `pnpm --filter @stubwise/worker typecheck` pulito.
- [ ] **Passo 4:** commit `chore(worker): via node-pty, non serve più` (solo i tre file).

### Chiusura

- [ ] Giro completo del worker e del server (`pnpm --filter @stubwise/worker test`, `pnpm --filter @stubwise/server test`), `pnpm lint`, `pnpm typecheck`.
- [ ] Scenari golden col CLI pinnato 2.1.287 (manuali: si lanciano solo col via del maintainer, consumano quota).
- [ ] `graphify-out/` NON si committa su questo branch (si rigenera su `main` dopo il merge: è il file più esposto a conflitti col lavoro delle altre sessioni).
