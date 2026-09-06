---
title: Fase 4 — fix di review prima del merge
date: 2026-09-06
design: 2026-09-02-phase4-mobile-app-design.md
plan: 2026-09-02-phase4-mobile-app-plan.md
stubwise:
  project: stubwise
  backlog: ab61e273-a522-40bc-9534-b2c6085ead37
---

# Fase 4 — fix di review prima del merge

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> Lavora nel worktree esistente `.worktrees/phase4-mobile-app` (branch
> `feature/phase4-mobile-app`, HEAD `50ec8c4`). **Non** mergiare su main e
> **non** deployare: merge e deploy li fa il maintainer. Il ticket della fase
> è già `in_progress`: non toccarne lo stato.

**Goal:** chiudere i findings della review indipendente della fase 4 (quattro
revisori: backend, deploy, app, regressioni) e far girare la CI sul branch,
che non è mai stato pushato.

**Convenzioni**: TDD (test rosso → fix → verde), commit piccoli in italiano
con prefisso `fix|test|chore(scope):`, `pnpm lint` dalla radice e `pnpm -r
typecheck` prima dell'ultimo commit. Le posizioni `file:riga` sotto sono
quelle di HEAD `50ec8c4`.

---

### Task 1: relay — il rate limit per IP deve vedere l'IP del client, non quello di Caddy

**Finding**: `apps/push-relay/src/server.ts:151` crea Fastify senza
`trustProxy`; il relay sta dietro Caddy (`caddy.d/relay.caddy.example` →
`reverse_proxy push-relay:8090`, nessuna porta pubblicata), quindi
`request.ip` è sempre l'IP interno di Caddy e `@fastify/rate-limit`
(`server.ts:192`, `perIpMinute` 600) conta TUTTE le istanze del mondo in un
solo bucket: oltre 600 send/min aggregati tutti prendono 429 →
`PushRelayUnavailable` → retry, e un'istanza rumorosa affama le altre. Il
commento a `server.ts:45-50` promette una difesa che non c'è.

**Files:**
- Modify: `apps/push-relay/src/server.ts:151` (`Fastify({ trustProxy: 1, ... })` — **un solo hop**, non `true`: con `true` un client può spoofare `X-Forwarded-For` e scegliersi il bucket)
- Modify: `apps/push-relay/src/server.ts:45-50` (aggiorna il commento: la difesa per IP funziona perché Caddy è l'unico hop fidato)
- Modify: `caddy.d/relay.caddy.example` e `apps/push-relay/README.md` (o la sezione relay in `apps/mobile/README.md`): dire esplicitamente che il relay va esposto SOLO dietro un reverse proxy che sovrascrive `X-Forwarded-For` (Caddy lo fa di default), mai con la porta pubblicata
- Test: `apps/push-relay/src/server.test.ts`

**Step 1: test rosso** — con `app.inject` e `remoteAddress` fisso (è
Caddy), due sequenze di richieste con header `x-forwarded-for` diversi
(`203.0.113.1` e `203.0.113.2`), tetto basso per il test (`perIpMinute:
3`): esaurire il tetto con il primo IP NON deve far rispondere 429 al
secondo. Secondo test, anti-spoofing: con `x-forwarded-for: 1.2.3.4,
203.0.113.1` (un client che si inventa un hop davanti) il bucket deve
essere quello dell'ULTIMO indirizzo, l'unico appeso dal proxy fidato.
Scrivi questo test leggendo `request.ip` in un hook `onRequest` di prova e
asserendo il valore, così documenti il comportamento reale di `trustProxy:
1` invece di indovinarlo.

**Step 2: Run** `pnpm --filter @stubwise/push-relay exec vitest run server` → FAIL (oggi il secondo IP prende 429).

**Step 3: fix.** **Step 4: Run** → PASS.

**Step 5: Commit** `fix(push-relay): trustProxy a un hop, il limite per IP distingue le istanze`.

### Task 2: app — una push ricevuta in primo piano aggiorna inbox e badge

**Finding**: `apps/mobile/src/lib/push.ts`, handler `onMessage`: mostra la
notifica locale (solo Android) ma non invalida le query dell'inbox né
aggiorna il badge. Il design (§6) chiede refresh «on-foreground + push» e
badge «a ogni push»: oggi la lista resta stantia finché non cambia
`AppState` (`providers.tsx:198`) o scade l'intervallo.

**Files:**
- Modify: `apps/mobile/src/lib/push.ts` (`setupPush` riceve una callback `onPushReceived` o il `queryClient`; in `onMessage`: `queryClient.invalidateQueries({ queryKey: inboxKeys.all })` + refresh di `unread-count` + `notifee.setBadgeCount`)
- Modify: `apps/mobile/src/app/providers.tsx` (passa la callback; riusa la stessa funzione del foreground così c'è UN solo punto che decide cosa si aggiorna)
- Test: `apps/mobile/src/lib/push.test.ts`

**Step 1: test rosso** — simula `onMessage` con un payload `data.kind =
"job.awaiting_input"` e asserisci che la callback viene chiamata (o che
`invalidateQueries` è chiamato con `inboxKeys.all`) e che il badge viene
aggiornato con il valore restituito da `unread-count` mockata.

**Step 2–4**: rosso → fix → verde (`pnpm --filter @stubwise/mobile test -- push`).

**Step 5: Commit** `fix(mobile): una push in primo piano aggiorna inbox e badge`.

### Task 3: app — logout sequenziato (device, poi PAT e `deleteToken`)

**Finding**: `apps/mobile/src/screens/settings/SettingsSheet.tsx:156-163`:
`messaging().deleteToken()` gira in **parallelo** a `getPushToken() →
deleteDevice()`. Se `deleteToken` finisce prima, `getToken` può generare un
token NUOVO e `deleteDevice` cancella quello sbagliato: il vecchio resta
attivo sul server finché il relay non risponde `invalid_token`.

**Files:**
- Modify: `apps/mobile/src/screens/settings/SettingsSheet.tsx:156-163` (ordine: 1. leggi il token corrente UNA volta; 2. `deleteDevice(token)`; 3. `revokePat`; 4. `deleteToken()`; 5. `clearSession` + reset cache. I passi 2–4 in `try/catch` separati: un fallimento non salta i successivi, e il 5 gira SEMPRE)
- Test: `apps/mobile/src/screens/settings/SettingsSheet.test.tsx`

**Step 1: test rosso** — con mock che registrano l'ordine delle chiamate,
asserisci `deleteDevice` → `revokePat` → `deleteToken` → `clearSession`, e
che `deleteDevice` riceve il token letto PRIMA di `deleteToken`; caso di
errore su `deleteDevice`: gli altri tre passi girano lo stesso.

**Step 2–4**: rosso → fix → verde.

**Step 5: Commit** `fix(mobile): logout sequenziato, il device cancellato è quello giusto`.

### Task 4: rifiniture minori dell'app (un commit)

**Files:**
- Modify: `apps/mobile/src/lib/client.ts` — la guardia «401 → `clearSession` + sessione scaduta» deve **escludere** `POST /api/auth/mobile-login` (una password errata non è una sessione scaduta). Test: un 401 su mobile-login NON chiama `clearSession`; un 401 su `/api/inbox` sì.
- Modify: `apps/mobile/src/app/providers.tsx:~185` — `refreshBadge` ha un `catch {}` vuoto: logga con il logger dell'app (livello warn) come fanno gli altri catch.
- Modify: `apps/mobile/src/...` `useUnreadCount` — `refetchInterval: 30_000` → `60_000`, allineato al badge e al design («contatore ogni 60 s solo in foreground»).
- Modify: `apps/mobile/package.json` — `test-renderer ^1.2.0` in devDependencies sembra un pacchetto estraneo accanto a `react-test-renderer`: `grep -rn "test-renderer" apps/mobile --include=*.ts --include=*.tsx --include=*.js -l | grep -v node_modules`; se non è importato da nessuna parte, rimuovilo e ri-`pnpm install`.

**Commit** `chore(mobile): guardia 401 esclude il login, catch loggato, intervallo 60 s`.

### Task 5: Android — firma di release cablata (senza keystore nel repo)

**Finding**: `apps/mobile/android/app/build.gradle:98-103` firma anche
`release` con `signingConfigs.debug` (scaffold RN mai toccato). Il README
ha già lo snippet: va applicato.

**Files:**
- Modify: `apps/mobile/android/app/build.gradle` — `signingConfigs.release` che legge `STUBWISE_UPLOAD_STORE_FILE`, `STUBWISE_UPLOAD_STORE_PASSWORD`, `STUBWISE_UPLOAD_KEY_ALIAS`, `STUBWISE_UPLOAD_KEY_PASSWORD` da `~/.gradle/gradle.properties` (o env); `buildTypes.release.signingConfig = signingConfigs.release` **solo se** `STUBWISE_UPLOAD_STORE_FILE` è definita, altrimenti resta la debug con un `logger.warn("Release firmata con la keystore di DEBUG: definisci STUBWISE_UPLOAD_* in ~/.gradle/gradle.properties")` — così `pnpm --filter @stubwise/mobile android` continua a funzionare per chi non ha la keystore
- Modify: `apps/mobile/README.md` (la sezione keystore deve corrispondere ESATTAMENTE ai nomi delle proprietà)
- Verifica: `cd apps/mobile/android && ./gradlew :app:assembleRelease --dry-run` (o `assembleDebug` se la toolchain non è disponibile: in quel caso dillo nel report) — deve passare senza le proprietà (warn) e, se le definisci con una keystore temporanea creata con `keytool`, senza warn.

**Commit** `chore(mobile-android): firma di release da gradle.properties, fallback debug con avviso`.

### Task 6: push del branch e CI verde

Il branch **non è mai stato pushato**: la CI (`.github/workflows/ci.yml`,
job ubuntu con `pnpm -r build/lint/typecheck/test`) non ha mai visto
`apps/mobile`, `apps/push-relay` né `packages/api-client`.

**Step 1**: `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r
--workspace-concurrency=1 test` nel worktree → tutto verde.

**Step 2**: `git push -u origin feature/phase4-mobile-app`.

**Step 3**: `gh run watch` (o `gh run list --branch feature/phase4-mobile-app`)
finché il workflow CI è **verde**. Se fallisce: correggi sul branch (commit
`fix(ci): …`), ripusha, riattendi. Non è verde finché non lo è il job E2E
Playwright, che gira SOLO in CI e non è mai stato eseguito con la SPA
migrata a `@stubwise/api-client`.

**Step 4**: `graphify update .` e commit del grafo, se l'hook non l'ha già
fatto.

**Step 5 — report al maintainer**: HEAD finale, link al run CI verde,
esito del Task 5 (dry-run gradle riuscito o toolchain assente), e conferma
esplicita di ognuno dei sei task. Poi fermati: merge e deploy non sono tuoi.

---

## Fuori da questo piano (segnalati dalla review, vanno in backlog, non ora)

- `GET /api/projects/pulse`: 4 query in `Promise.all` per progetto, per un
  admin con N progetti sono 4N query concorrenti sul pool; accettabile oggi,
  da rivedere con decine di progetti (`project-pulse-summary.ts:226`).
- `esbuild` come devDependency di `packages/notifications` solo per
  `pure.test.ts`: pesante per un test, valutare un test statico sugli import.
- `apps/web/tsconfig.json` `paths` che ancorano `react`/`react-dom` ai
  `@types` locali (perché `apps/mobile` porta `@types/react` 19): da togliere
  al passaggio della SPA a React 19.
- `Dockerfile.caddy` ora installa anche le dipendenze di `apps/mobile`
  (peso del build, non correttezza): valutare `pnpm install --filter`.
- `StubwiseMobile.entitlements` `aps-environment = development`: Xcode lo
  sostituisce con `production` all'export TestFlight; da ricordare se si
  passa a fastlane/export manuale (fase 4b).
