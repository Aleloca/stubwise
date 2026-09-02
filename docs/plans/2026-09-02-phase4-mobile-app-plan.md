---
title: Fase 4 — App mobile (RN bare) — piano di implementazione
date: 2026-09-02
design: 2026-09-02-phase4-mobile-app-design.md
stubwise:
  project: stubwise
  backlog: ab61e273-a522-40bc-9534-b2c6085ead37
  ticket: 309111fe-b675-463d-91fd-da98bbc99fb5
  ticketUrl: https://stubwise.thecove.it/tickets/309111fe-b675-463d-91fd-da98bbc99fb5
---

# Fase 4 — App mobile: piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **Prima del Task 1**: esegui `/stubwise:start` sulla voce di backlog
> `ab61e273-a522-40bc-9534-b2c6085ead37` (converte in ticket e lo porta in
> `in_progress`). Nelle fasi precedenti questo passo è stato dimenticato due
> volte: fallo per primo. Lavora in un worktree (`feature/phase4-mobile-app`),
> come per le fasi 0–3.

**Goal:** un'app React Native **bare** (`apps/mobile`, bundle id/package
`com.app.aleloca.stubwise`) che è l'inbox delle decisioni di Stubwise in
tasca — stesse azioni della web app, push native con deep link, polso dei
progetti, timeline del lavoro, backlog e docs — più il backend che le serve
(login mobile → PAT, device token + canale delivery `push` che passa dal
**relay push** gestito da noi — unica modalità: le chiavi APNs/FCM sono
legate alla nostra identità dell'app e vivono solo nel relay, mai nelle
istanze —, riepilogo `GET /api/projects/pulse`, chat non-streaming) e il
relay stesso (`apps/push-relay`).

**Architecture:** l'app è un client come la SPA: chiama le rotte esistenti col
PAT (`Authorization: Bearer`), attraverso un client HTTP condiviso nuovo
(`packages/api-client`) tipizzato con gli schemi di `packages/shared` (dove si
promuovono le forme di ticket/job/backlog oggi ridichiarate nel server e nella
SPA). Le novità backend sono additive: 1 migrazione (0067), 4 rotte, un canale
delivery in più nel poller esistente, un modulo di segnali di progetto
condiviso tra worker e server. Nessun componente React è condiviso col web.

**Tech Stack:** React Native 0.7x bare + TypeScript, react-navigation
(native-stack + bottom-tabs), @tanstack/react-query + persister
(`@react-native-async-storage/async-storage`), react-native-keychain,
@notifee/react-native + @react-native-firebase/{app,messaging},
@react-native-community/netinfo, react-i18next, Jest +
@testing-library/react-native; backend: Fastify + Zod + Drizzle (Postgres),
APNs HTTP/2 (`http2` nativo + JWT ES256 con `jose` o `node:crypto`), FCM HTTP
v1 (`google-auth-library`); test con Vitest/testcontainers.

**Convenzioni ereditate dalle fasi 0–3** (valgono per tutto il piano):
- commit piccoli e frequenti, messaggi in italiano con prefisso
  `feat|fix|test|docs|chore(scope):`;
- TDD: test rosso → implementazione minima → verde; `pnpm --filter
  @stubwise/<pkg> exec vitest run <pattern>` per un singolo file (NON
  `pnpm test -- <pattern>`: non filtra);
- migrazioni: file SQL a mano in `packages/db/drizzle/00NN_*.sql` +
  `meta/_journal.json`; l'`ALTER TYPE … ADD VALUE` va in uno **statement
  proprio** e il valore nuovo NON si usa nella stessa migrazione (batch in una
  transazione);
- i18n backend in `packages/i18n/src/catalog.ts` (it/en, entrambi);
- dopo aver toccato `packages/*`, `pnpm -r build`: server/worker leggono
  `dist/`;
- **`pnpm lint` dalla radice prima di ogni merge** (la CI fallisce su lint
  anche con typecheck+test verdi);
- alla fine di ogni fase (A–D): `pnpm -r typecheck && pnpm lint`, poi i test
  dei package toccati; la suite completa (`pnpm -r --workspace-concurrency=1
  test`) prima del merge.

---

## Fase A — Monorepo, shared, api-client (senza app)

### Task 1: `apps/mobile` nasce e importa `@stubwise/shared` sul simulatore (rischio n.1)

**Files:**
- Create: `apps/mobile/` (scaffold `npx @react-native-community/cli@latest init StubwiseMobile --skip-install --pm pnpm --package-name com.app.aleloca.stubwise`, poi rinomina la dir in `apps/mobile` e il `name` in `package.json` a `@stubwise/mobile`, `private: true`)
- Create: `apps/mobile/metro.config.js`
- Create: `apps/mobile/tsconfig.json`
- Modify: `apps/mobile/package.json` (script `ios`, `android`, `start`, `typecheck` = `tsc --noEmit`, `build` = `pnpm typecheck`, `lint`, `test` = `jest`)
- Modify: `pnpm-workspace.yaml` (nessuna modifica: `apps/*` già incluso — verificare che `pnpm install` veda `@stubwise/mobile`)
- Modify: `tsconfig.json` alla radice se elenca i progetti (aggiungere il reference)
- Modify: `.gitignore` (aggiungere `apps/mobile/ios/Pods`, `apps/mobile/ios/build`, `apps/mobile/android/.gradle`, `apps/mobile/android/app/build`, `apps/mobile/android/build`, `*.keystore`, `apps/mobile/ios/*.xcworkspace/xcuserdata`)

**Step 1: scaffold e wiring pnpm**

- Bundle id iOS e `applicationId` Android: `com.app.aleloca.stubwise`
  (controlla `ios/StubwiseMobile.xcodeproj/project.pbxproj`
  `PRODUCT_BUNDLE_IDENTIFIER` e `android/app/build.gradle`).
- Display name `Stubwise` (`ios/StubwiseMobile/Info.plist`
  `CFBundleDisplayName`, `android/app/src/main/res/values/strings.xml`).
- `metro.config.js`:

```js
const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

const root = path.resolve(__dirname, "../..");
const config = {
  watchFolders: [root],
  resolver: {
    unstable_enableSymlinks: true,
    nodeModulesPaths: [
      path.resolve(__dirname, "node_modules"),
      path.resolve(root, "node_modules"),
    ],
  },
};
module.exports = mergeConfig(getDefaultConfig(__dirname), config);
```

- `tsconfig.json`: `extends: "@react-native/typescript-config"`, `jsx:
  react-jsx`, `moduleResolution: bundler`, `paths` NON necessari (i package
  workspace si risolvono da `node_modules`), `include: ["src", "index.js",
  "App.tsx", "jest.setup.ts"]`.
- `App.tsx` minimale che importa `ticketStatusSchema` da `@stubwise/shared`
  e mostra `ticketStatusSchema.options.length` in un `<Text>`.
- Aggiungi `@stubwise/shared: workspace:*` alle dependencies.

**Step 2: verifica sul simulatore**

Run: `pnpm install && pnpm -r build && pnpm --filter @stubwise/mobile ios`
Expected: l'app parte sul simulatore iOS e mostra il numero di stati (9).
Se Metro non risolve i symlink pnpm: **fallback** — crea `.npmrc` alla
radice con `node-linker=hoisted`, ri-`pnpm install`, riesegui `pnpm -r
build/typecheck/test` per confermare che il resto del monorepo non cambia, e
documenta la scelta in `apps/mobile/README.md`. Annota nel report quale
strada è servita.

**Step 3: typecheck/lint/test del package entrano nel workspace**

Run: `pnpm -r typecheck && pnpm lint && pnpm --filter @stubwise/mobile test`
Expected: verde (Jest con il test di default `__tests__/App.test.tsx`
adattato: rende `App` e trova il testo `9`). Se l'ESLint della radice non
copre `apps/mobile`, aggiungi il blocco per `apps/mobile/**` in
`eslint.config.js` (parser TS, env RN, ignora `ios/` e `android/`).

**Step 4: README iniziale e commit**

`apps/mobile/README.md`: prerequisiti (Xcode, CocoaPods, JDK 17, Android
Studio), `pnpm --filter @stubwise/mobile ios|android`, nota su Metro+pnpm.

```bash
git add apps/mobile pnpm-lock.yaml .gitignore eslint.config.js
git commit -m "feat(mobile): scaffold RN bare in apps/mobile (com.app.aleloca.stubwise) con Metro su pnpm"
```

### Task 2: schemi promossi in `packages/shared`

**Files:**
- Modify: `packages/shared/src/schemas/ticket.ts` (aggiungi `ticketSchema`, `ticketDetailSchema` copiati da `apps/server/src/routes/tickets.ts:54-100`)
- Create: `packages/shared/src/schemas/ai-job.ts` (`aiJobSchema`, `aiJobStatusSchema` se non già in shared — verifica `grep -rn "awaiting_input" packages/shared/src`)
- Modify: `packages/shared/src/schemas/backlog.ts` (`backlogItemSchema`, `backlogItemDetailSchema` copiati dalla forma di risposta di `apps/server/src/routes/backlog.ts`)
- Create: `packages/shared/src/work-state.ts` (`workStateFor`)
- Modify: `packages/shared/src/index.ts` (export)
- Modify: `apps/server/src/routes/tickets.ts`, `apps/server/src/routes/backlog.ts`, `apps/server/src/routes/ai-jobs.ts` (importano da shared, cancellano le copie)
- Modify: `apps/web/src/lib/api.ts` (importa i tipi da shared, cancella le ridichiarazioni)
- Test: `packages/shared/src/work-state.test.ts`

**Step 1: test rosso per `workStateFor`**

I 9 stati in parole del canvas (chiave i18n, non testo):

```ts
import { describe, expect, it } from "vitest";
import { workStateFor } from "./work-state.js";

describe("workStateFor", () => {
  it("mappa ogni stato di job in uno dei 9 stati in parole", () => {
    expect(workStateFor({ status: "queued" })).toBe("proposed");
    expect(workStateFor({ status: "awaiting_input" })).toBe("waiting_answer");
    expect(workStateFor({ status: "awaiting_plan_approval" })).toBe("waiting_approval");
    expect(workStateFor({ status: "running", phase: "plan" })).toBe("planning");
    expect(workStateFor({ status: "running", phase: "execute" })).toBe("working");
    expect(workStateFor({ status: "held" })).toBe("held");
    expect(workStateFor({ status: "done", prUrl: "https://x" })).toBe("pr_ready");
    expect(workStateFor({ status: "done" })).toBe("done");
    expect(workStateFor({ status: "failed" })).toBe("failed");
  });
});
```

Adatta i campi (`phase`, `prUrl`) a quelli reali di `aiJobSchema`: leggi
`apps/server/src/routes/ai-jobs.ts` e lo schema DB `aiJobs` in
`packages/db/src/schema.ts` prima di scrivere il test.

**Step 2: Run** `pnpm --filter @stubwise/shared exec vitest run work-state` → FAIL.

**Step 3: implementa** `workStateFor` (funzione pura, `WorkState` = union
dei 9 literal) e sposta gli schemi. Nel server sostituisci le definizioni con
`import { ticketSchema, ticketDetailSchema } from "@stubwise/shared"`.
ATTENZIONE: gli schemi del server possono usare `z.uuid()`/`z.iso.datetime()`
e `dateSchema` locali: in shared usa solo zod (già dipendenza) e tieni la
forma identica — i test di `apps/server` (`tickets.test.ts`,
`backlog.test.ts`) fanno da regressione.

**Step 4: Run** `pnpm -r build && pnpm --filter @stubwise/shared test && pnpm --filter @stubwise/server exec vitest run tickets backlog ai-jobs && pnpm --filter @stubwise/web typecheck` → PASS.

**Step 5: Commit** `refactor(shared): promuovi ticket/job/backlog in shared e aggiungi workStateFor`.

### Task 3: logica pura di `@stubwise/notifications` senza DB

**Files:**
- Modify: `packages/notifications/package.json` (export `./pure` → `dist/pure.js`)
- Create: `packages/notifications/src/pure.ts` (riesporta da `./format.js` e `./actions.js` SOLO: `actionsFor`, `kindOffers`, `stateAllows`, `actorAllows`, `SNOOZE_OPTIONS`, `KINDS_WITH_OPTIONS`, `formatNotificationText`, `formatNotification`, tipi)
- Test: `packages/notifications/src/pure.test.ts`

**Step 1: test rosso** — il test verifica che il modulo `pure` NON importi
`@stubwise/db` né `drizzle-orm` (leggi `dist/pure.js` dopo build oppure usa
`import.meta.resolve`): più semplice, un test statico che legge i sorgenti di
`format.ts`/`actions.ts` e asserisce l'assenza di `from "@stubwise/db"` e
`from "drizzle-orm"`; se `actions.ts` importa `IN_FLIGHT_JOB_STATUSES` da un
posto con DB, spostalo.

**Step 2: Run** `pnpm --filter @stubwise/notifications exec vitest run pure` → FAIL (file assente).

**Step 3: implementa** `pure.ts` + export in `package.json`; verifica che RN
(Metro) riesca a bundlare `@stubwise/notifications/pure` senza tirare dentro
`pg` — se `format.ts` importa `@stubwise/i18n` va bene (senza I/O).

**Step 4: Run** `pnpm -r build && pnpm --filter @stubwise/notifications test` → PASS.

**Step 5: Commit** `feat(notifications): entry pure senza DB per i client`.

### Task 4: `packages/api-client`

**Files:**
- Create: `packages/api-client/package.json` (`@stubwise/api-client`, private, ESM, `main/types` su dist, dip: `@stubwise/shared`, `zod`)
- Create: `packages/api-client/tsconfig.json` (come `packages/shared`)
- Create: `packages/api-client/src/index.ts`, `src/client.ts`, `src/errors.ts`, `src/endpoints/{auth,inbox,projects,tickets,backlog,docs,me}.ts`
- Test: `packages/api-client/src/client.test.ts`, `src/endpoints/inbox.test.ts`

**Step 1: test rosso (client)**

```ts
import { describe, expect, it, vi } from "vitest";
import { ApiError, createStubwiseClient } from "./index.js";

describe("createStubwiseClient", () => {
  it("prefigge baseUrl, manda l'header di auth e valida la risposta", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ unread: 3 }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const client = createStubwiseClient({
      baseUrl: "https://stubwise.example",
      getAuthHeader: async () => "Bearer stw_pat_x",
      fetch: fetchImpl,
    });
    await expect(client.inbox.unreadCount()).resolves.toEqual({ unread: 3 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://stubwise.example/api/inbox/unread-count");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer stw_pat_x");
  });

  it("trasforma un errore JSON in ApiError con status/code/details", async () => {
    const client = createStubwiseClient({
      baseUrl: "https://x",
      getAuthHeader: async () => null,
      fetch: async () => new Response(JSON.stringify({ error: "already_handled", details: { handledBy: { name: "Ada" } } }), { status: 409 }),
    });
    await expect(client.inbox.act("id", "snooze", { until: "1h" })).rejects.toMatchObject({ status: 409, code: "already_handled" } satisfies Partial<ApiError>);
  });
});
```

Prima di scrivere gli endpoint, leggi `apps/web/src/lib/api.ts` (forma di
`request`, `ApiError`, `handledByFromError`, e il path/verbo esatto di ogni
rotta usata dall'app: inbox list/unread-count/actions/snooze/handled/answer,
me follows/prefs/devices, projects list/pulse, tickets list/detail/jobs/
questions/answer/run-ai/approve/reject, backlog list/detail/convert/create/
chat, docs search/pages/chat). L'elenco dei path va nel file
`packages/api-client/src/endpoints/*.ts` con lo schema shared di risposta e
`schema.parse` sulla risposta (fail-fast: una forma inattesa è un bug, non
un dato).

**Step 2: Run** `pnpm --filter @stubwise/api-client exec vitest run` → FAIL.

**Step 3: implementa**: `createStubwiseClient({ baseUrl, getAuthHeader,
fetch = globalThis.fetch, credentials? })` → `request(method, path, body?,
schema?)`; `ApiError` identica a quella web (`status`, `code`, `details`,
`handledByFromError`).

**Step 4: la SPA migra**: in `apps/web/src/lib/api.ts` sostituisci `request`
con il client (`baseUrl: ""`, `credentials: "include"`, `getAuthHeader: () =>
null`) e riesporta `ApiError`/`handledByFromError` da `@stubwise/api-client`
così gli import esistenti non cambiano. Aggiungi la dipendenza in
`apps/web/package.json` e — TRAPPOLA nota — nelle **dependencies**, non nelle
devDependencies (`Dockerfile.caddy` builda la SPA con le sole deps
dichiarate: un package workspace in devDeps rompe il build Docker).

**Step 5: Run** `pnpm -r build && pnpm --filter @stubwise/api-client test && pnpm --filter @stubwise/web test && pnpm --filter @stubwise/web typecheck` → PASS.

**Step 6: Commit** `feat(api-client): client HTTP condiviso tipizzato; la SPA lo adotta`.

---

## Fase B — Backend

### Task 5: `POST /api/auth/mobile-login`

**Files:**
- Modify: `packages/shared/src/schemas/pat.ts` (`mobileLoginBodySchema { email, password, deviceName: string.min(1).max(80) }`, `mobileLoginResponseSchema { token, user: sessionUserSchema }`)
- Modify: `apps/server/src/routes/auth.ts` (nuova rotta accanto a `/login`, `config: { rateLimit: opts.rateLimit }`)
- Modify: `apps/server/src/routes/pat.ts` (estrai `createPatForUser(db, userId, name, expiresAt)` riusabile — oggi la creazione è inline nel handler alla riga ~60)
- Test: `apps/server/src/routes/auth.test.ts`

**Step 1: test rosso** (accanto ai test di `/login` esistenti; riusa il
setup testcontainers del file):

```ts
it("mobile-login emette un PAT 'Mobile · <device>' e risponde token+user", async () => {
  const res = await app.inject({ method: "POST", url: "/api/auth/mobile-login", payload: { email, password, deviceName: "iPhone di Ada" } });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.token).toMatch(/^stw_pat_/);
  expect(body.user.email).toBe(email);
  const me = await app.inject({ method: "GET", url: "/api/pats", headers: { authorization: `Bearer ${body.token}` } });
  expect(me.json().some((p: { name: string }) => p.name === "Mobile · iPhone di Ada")).toBe(true);
});
it("mobile-login con password errata → 401 e nessun PAT creato", …);
it("mobile-login è rate-limited come /login", …);
```

**Step 2: Run** `pnpm --filter @stubwise/server exec vitest run routes/auth` → FAIL.

**Step 3: implementa**: verifica credenziali con la stessa sequenza di
`/login` (dummy hash contro l'enumerazione, `verifyPassword`), poi
`createPatForUser` (nessuna scadenza), risposta `{ token, user }`. NON crea
la sessione cookie.

**Step 4: Run** → PASS. **Step 5: Commit** `feat(auth): mobile-login emette un PAT per device`.

### Task 6: migrazione 0067 — `device_tokens`, `users.notify_push`, canale `push`

**Files:**
- Create: `packages/db/drizzle/0067_mobile_push.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (idx 67, tag `0067_mobile_push`)
- Modify: `packages/db/src/schema.ts` (`deliveryChannel` += `"push"`; `users.notifyPush`; tabella `deviceTokens`)
- Modify: `packages/shared/src/schemas/notification.ts` (enum canale += `push`; `notificationPrefsSchema` += `push: boolean`)
- Test: `packages/db/src/inbox-schema.test.ts` (o nuovo `device-tokens.test.ts`)

**Step 1: SQL**

```sql
ALTER TYPE "delivery_channel" ADD VALUE IF NOT EXISTS 'push';
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notify_push" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
CREATE TABLE "device_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "pat_id" uuid REFERENCES "personal_access_tokens"("id") ON DELETE SET NULL,
  "platform" text NOT NULL CHECK ("platform" IN ('ios','android')),
  "token" text NOT NULL UNIQUE,
  "app_version" text,
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "disabled_at" timestamptz,
  "disabled_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "device_tokens_user_active_idx" ON "device_tokens" ("user_id") WHERE "disabled_at" IS NULL;
```

Verifica il nome reale della tabella PAT in `schema.ts` (`pats`?
`personal_access_tokens`?) prima di scrivere la FK. Il valore `push` NON va
usato in questa migrazione (trappola del batch).

**Step 2: test rosso** — inserisce un device, verifica unique su `token` e
che `delivery_channel` accetti `push` (dopo la migrazione, in un test
separato con una connessione nuova).

**Step 3: Run** `pnpm --filter @stubwise/db exec vitest run device-tokens` → FAIL → implementa schema → PASS.

**Step 4: Commit** `feat(db): migrazione 0067 — device token, notify_push, canale push`.

### Task 7: rotte `/api/me/devices` e preferenza `push`

**Files:**
- Modify: `apps/server/src/routes/me-prefs.ts` (GET/PUT prefs con `push`; `PUT /api/me/devices`; `DELETE /api/me/devices/:token`)
- Modify: `packages/shared/src/schemas/notification.ts` (`deviceRegistrationSchema { platform, token, appVersion? }`)
- Test: `apps/server/src/routes/me-prefs.test.ts`

**Step 1: test rosso**: PUT device con PAT → 204 e riga con `patId` del PAT
usato; PUT stesso token da un altro utente → il device passa al nuovo utente
(token = device, chi è loggato ora lo possiede); DELETE → riga rimossa
(NON disabilitata: logout = via); GET prefs espone `push: true`; PUT prefs
`push: false` persiste; PUT device con cookie di sessione (no PAT) → 204 con
`patId` null.

**Step 2–4**: rosso → implementa → verde. `patId` viene da `request.user`:
verifica come `findPatUser` espone l'id del PAT (se non lo espone, aggiungi
`patId?` a `SessionUser` in `auth/session.ts`).

**Step 5: Commit** `feat(server): registrazione device e preferenza push`.

### Task 8: `pushRecipients` nel publish + `notify_push`

**Files:**
- Modify: `packages/notifications/src/publish.ts` (dopo `slackReady`, `pushReady = await pushRecipients(inner, recipients)` → delivery `{ channel: "push" }` per destinatario)
- Test: `packages/notifications/src/publish.test.ts`

**Step 1: test rosso**: utente con `notify_push` e un device attivo → una
delivery `push`; con device `disabled_at` → nessuna; con `notify_push=false`
→ nessuna; due device → UNA delivery (per destinatario).

**Step 2–4**: rosso → implementa (una query, come `slackRecipients`:
`exists(device_tokens where user_id and disabled_at is null)`) → verde.

**Step 5: Commit** `feat(notifications): delivery push per destinatario con device attivi`.

### Task 9: contratto del relay, payload e client del relay (`packages/notifications/src/push/`)

Il modello è **relay-only**: l'app sugli store è una sola (la nostra), le
chiavi APNs/FCM sono legate alla nostra identità e vivono SOLO nel relay
(Task 10b). Nessuna istanza parla con APNs/FCM.

**Files:**
- Modify: `packages/shared/src/schemas/push.ts` (nuovo): `pushRelaySendRequestSchema { tokens: [{ platform: "ios"|"android", token }].min(1).max(20), payload: { title, body, category, data: Record<string,string>, badge?: number, threadId?: string, collapseId?: string } }`, `pushRelaySendResponseSchema { results: [{ token, status: "ok"|"invalid_token"|"retry", reason? }] }` — è il contratto pubblico tra istanze e relay: versionato nel path (`/v1/send`), additivo da qui in poi
- Create: `packages/notifications/src/push/payload.ts` (`buildPushPayload(event, lang, { notificationId, unreadCount }) → payload` del contratto: `data = { notificationId, kind, deepLink: "stubwise://inbox/<id>" }`, `collapseId = notificationId`, `threadId = projectId`)
- Create: `packages/notifications/src/push/relay-client.ts` (`createPushRelayClient({ url, fetch?, timeoutMs = 10_000 }) → send(tokens, payload) → PushRelaySendResponse`; errori di rete/timeout/5xx del relay → lancia `PushRelayUnavailable` (→ retry nel poller); 4xx → lancia `PushRelayRejected` (→ delivery `failed`, è un bug di contratto))
- Create: `packages/notifications/src/push/config.ts` (`loadPushConfig(env) → { relayUrl } | null`: `PUSH_RELAY_URL` **assente → default `https://push.stubwise.thecove.it`** (costante `DEFAULT_PUSH_RELAY_URL`), **stringa vuota → `null` = push spente**, URL non `https:` (tranne `http://localhost*` per i test) → lancia, fail-fast all'avvio come `PULSE_TIMEZONE`)
- Modify: `packages/notifications/src/index.ts` (export)
- Modify: `packages/i18n/src/catalog.ts` (`push.title.<kind>` it/en, uno per kind: es. `job.awaiting_input` → «Una domanda ti aspetta» / "A question is waiting for you"; `project.pulse` → «Da dove ripartire su {project}»; `job.plan_review` → «Piano da approvare»; `job.failed` → «Lavoro fallito»; `pr.opened` → «PR pronta»; ecc. — copri TUTTI i `NotificationKind`)
- Test: `push/payload.test.ts`, `push/relay-client.test.ts`, `push/config.test.ts`, `packages/shared/src/schemas/push.test.ts`

**Step 1: test rossi**
- `payload`: per ogni kind di `sampleEvents` produce title non vuoto in it ed
  en, `category === kind`, `data.deepLink === "stubwise://inbox/<id>"`,
  `body === formatNotificationText(event, lang)`; il risultato passa
  `pushRelaySendRequestSchema.shape.payload`.
- `relay-client`: con `fetch` finto: POST `<url>/v1/send`, body conforme allo
  schema, `content-type: application/json`; risposta 200 → parsata con lo
  schema; 503/timeout → `PushRelayUnavailable`; 400 → `PushRelayRejected`;
  risposta 200 malformata → `PushRelayRejected`.
- `config`: env senza la chiave → default pubblico; `""` → `null`; `http://
  relay.example` → lancia; `http://localhost:9999` → ok.

**Step 2: Run** `pnpm --filter @stubwise/notifications exec vitest run push/ && pnpm --filter @stubwise/shared exec vitest run push` → FAIL.

**Step 3: implementa.** **Step 4: Run** → PASS.

**Step 5: Commit** `feat(notifications): contratto del relay push, payload e client`.

### Task 10: ramo `push` nel poller delle delivery (via relay)

**Files:**
- Modify: `apps/worker/src/notify/deliveries-poller.ts` (prima del fallback `channel_not_implemented` alla riga ~240: `case "push"`)
- Modify: `apps/worker/src/config.ts` (`loadPushConfig(process.env)`; log di avvio «push: relay <url>» / «push: spente (PUSH_RELAY_URL vuota)»)
- Modify: `apps/worker/src/index.ts` (passa il client del relay al poller; riga di riepilogo avvio)
- Modify: `docker-compose.yml` (env `PUSH_RELAY_URL: ${PUSH_RELAY_URL-https://push.stubwise.thecove.it}` sul worker — sintassi `${VAR-default}` (trattino, non `:-`) così una stringa vuota in `.env` resta vuota e spegne le push)
- Test: `apps/worker/src/notify/deliveries-poller.test.ts`

**Step 1: test rosso** (con un client del relay finto in `DeliveriesPollerDeps`):
- config `null` → delivery `skipped` con `push_disabled`;
- utente con 2 device (ios+android) → UNA chiamata al relay con entrambi i
  token, delivery `sent`, `detail` con l'esito per token;
- relay risponde `invalid_token` per un token → quel device prende
  `disabled_at` + `disabled_reason`, la delivery resta `sent` se l'altro è
  `ok`, `failed` senza retry se erano tutti `invalid_token`;
- relay risponde `retry` per tutti, o `PushRelayUnavailable` → retry col
  `backoffMs` esistente; `PushRelayRejected` → `failed` senza retry;
- il payload contiene `badge = unreadCount` del destinatario (query
  `notifications where user_id and read_at is null and handled_at is null`
  — riusa la stessa condizione della rotta `unread-count` in
  `apps/server/src/routes/inbox.ts`: estraila in `packages/notifications`
  se è inline);
- utente senza device attivi al momento dell'invio → `skipped
  no_active_device`.

**Step 2: Run** `pnpm --filter @stubwise/worker exec vitest run deliveries-poller` → FAIL.

**Step 3: implementa**; la lingua del destinatario viene da `users.language`
(vedi come lo fa il ramo `slack_dm`).

**Step 4: Run** → PASS. **Step 5: Commit** `feat(worker): consegna push attraverso il relay, token invalidi disabilitati`.

### Task 10b: il relay (`apps/push-relay`)

Microservizio nostro, deployato solo sul nostro VPS. Le istanze self-hosted
non lo eseguono: lo chiamano.

**Files:**
- Create: `apps/push-relay/package.json` (`@stubwise/push-relay`, private; dip: `fastify`, `@fastify/rate-limit`, `@stubwise/shared`, `google-auth-library`; script `build` (tsc), `start`, `test`, `typecheck`, `lint`)
- Create: `apps/push-relay/src/apns.ts` (`createApnsClient({ keyP8, keyId, teamId, bundleId, sandbox, http2Connect? })` → `send(token, payload) → { status: "ok"|"invalid_token"|"retry", reason? }`; JWT ES256 con `node:crypto` (`createSign("SHA256")` su `{ alg:"ES256", kid }.{ iss, iat }`), cache 50 min; header `apns-topic = bundleId`, `apns-push-type = alert`, `apns-collapse-id`, `apns-priority 10`; `aps: { alert: {title, body}, badge, category, "thread-id", sound: "default" }` + `data`)
- Create: `apps/push-relay/src/fcm.ts` (`createFcmClient({ serviceAccountJson, fetch? })` → stesso contratto; token OAuth2 con `google-auth-library` (`JWT`, scope `https://www.googleapis.com/auth/firebase.messaging`), POST `https://fcm.googleapis.com/v1/projects/<project_id>/messages:send`; `message: { token, notification: {title, body}, data, android: { notification: { channel_id: category, tag: collapseId } }, apns: { headers: { "apns-collapse-id" }, payload: { aps: { category, badge, "thread-id" } } } }` — l'`apns` dentro FCM serve se i token iOS arrivano da Firebase Messaging: vedi decisione in fondo)
- Create: `apps/push-relay/src/config.ts` (`loadRelayConfig(env)`: `APNS_KEY_P8` base64, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_SANDBOX`, `FCM_SERVICE_ACCOUNT_JSON` base64, `RELAY_RATE_PER_TOKEN_HOUR` (60), `RELAY_RATE_PER_TOKEN_DAY` (500), `RELAY_RATE_PER_IP_MINUTE` (600), `PORT` (8090); **entrambe le chiavi obbligatorie**, fail-fast)
- Create: `apps/push-relay/src/server.ts` (`buildRelay({ config, apns, fcm })` → Fastify: `POST /v1/send` valida con `pushRelaySendRequestSchema`, applica il rate limit per token (contatore in memoria con finestra scorrevole — UN solo processo, niente Redis in v1) e per IP (`@fastify/rate-limit`), inoltra per piattaforma in parallelo, risponde `pushRelaySendResponseSchema`; `GET /healthz`; **nessun log del payload** (solo conteggi e stati); body limit 16 KB)
- Create: `apps/push-relay/src/index.ts` (avvio)
- Create: `Dockerfile.push-relay` (come `apps/server/Dockerfile`: build pnpm del workspace, `pnpm deploy --filter @stubwise/push-relay`)
- Modify: `docker-compose.yml` (servizio `push-relay`, `profiles: ["relay"]` così le istanze self-hosted NON lo avviano per default; env dal `.env`; solo rete interna)
- Modify: `Caddyfile` (blocco `push.{$PUSH_RELAY_HOST}` → `reverse_proxy push-relay:8090`, attivo solo se `PUSH_RELAY_HOST` è impostato — verifica la sintassi condizionale di Caddy; in alternativa un `Caddyfile.relay` importato)
- Test: `apps/push-relay/src/{apns,fcm,server,config}.test.ts`

**Step 1: test rossi**
- `apns`: con un `http2Connect` finto che registra le richieste: header
  `apns-topic`, `authorization: bearer <jwt>` con `kid` nell'header JWT;
  risposta 410 `Unregistered` / 400 `BadDeviceToken` → `invalid_token`; 503
  → `retry`; il JWT è riusato entro 50 min.
- `fcm`: con `fetch` finto: URL con il `project_id` del service account,
  `message.token`, `message.data` con SOLE stringhe; risposta 404
  `UNREGISTERED` / 400 `INVALID_ARGUMENT` → `invalid_token`; 429/5xx →
  `retry`.
- `server` (`app.inject`): body non conforme → 400; 2 token ios+android →
  un send per client, risposta con 2 risultati; 61ª richiesta per lo stesso
  token nell'ora → quel token risponde `retry` con `reason:
  "rate_limited"` (la richiesta NON è 429: gli altri token passano); payload
  > 16 KB → 413; `GET /healthz` → 200.
- `config`: chiave mancante → lancia; base64 non valido → lancia.

**Step 2: Run** `pnpm --filter @stubwise/push-relay test` → FAIL. **Step 3:
implementa.** **Step 4: Run** → PASS; `docker build -f Dockerfile.push-relay .`
riesce.

**Step 5: Commit** `feat(push-relay): relay push con chiavi APNs/FCM, rate limit per token`.

**Deploy del relay (maintainer, a fine fase)**: DNS `push.stubwise.thecove.it`
→ VPS; `.env`: `PUSH_RELAY_HOST`, `APNS_*`, `FCM_SERVICE_ACCOUNT_JSON`;
`docker compose --profile relay up -d --build push-relay caddy`. La nostra
istanza usa il relay come tutte le altre (default di `PUSH_RELAY_URL`), così
lo esercitiamo davvero.

### Task 11: segnali di progetto condivisi + `GET /api/projects/pulse`

**Files:**
- Create: `packages/notifications/src/project-signals.ts` (sposta QUI da `apps/worker/src/pulse/signals.ts`: `isProjectIdle`, `listCandidates`, `PULSE_HELD_STATUS`, `PULSE_IN_FLIGHT_STATUSES`, `PULSE_BLOCKING_JOB_STATUSES`, tipi; `signals.ts` del worker resta come re-export sottile finché i test del worker non vengono aggiornati, poi si elimina)
- Create: `packages/notifications/src/project-pulse-summary.ts` (`summarizeProject(db, projectId, viewer: { userId, role }) → ProjectPulseSummary`)
- Modify: `packages/shared/src/schemas/project.ts` (`projectPulseSummarySchema`)
- Modify: `apps/server/src/routes/projects.ts` (`GET /api/projects/pulse` — DICHIARALA PRIMA di `/api/projects/:id` o Fastify la tratterà come id)
- Test: `packages/notifications/src/project-pulse-summary.test.ts`, `apps/server/src/routes/projects.test.ts`

**Step 1: test rosso** (`summarizeProject`, testcontainers come in
`publish.test.ts`):
- job `awaiting_input` col richiedente = viewer → `waitingForYou` contiene
  `{ kind: "question", ticketNumber, title, notificationId }`;
- job `awaiting_plan_approval` e viewer `admin` → in `waitingForYou`; viewer
  `member` non richiedente → in `waitingForOthers` con `who` = «un
  maintainer» (chiave i18n, la stringa la fa l'app);
- job `running` → `running[{ ticketNumber, title, sinceMinutes }]`;
- `failed` conta i job falliti senza rilancio; `backlogReady` conta le voci
  `ready`; `idleDays` da `isProjectIdle`/ultima attività; `lastReportDate`
  dall'ultimo `activity_reports done`.

Poi la rotta: `GET /api/projects/pulse` restituisce solo i progetti seguiti
(`project_follows`) per un member e tutti per un admin, ordinati: prima chi ha
`waitingForYou`, poi `running`, poi `idleDays` desc.

**Step 2: Run** → FAIL. **Step 3: implementa**. **Step 4: Run** `pnpm -r build && pnpm --filter @stubwise/notifications test && pnpm --filter @stubwise/worker exec vitest run pulse && pnpm --filter @stubwise/server exec vitest run projects` → PASS (i test del pulse del worker restano verdi con il re-export).

**Step 5: Commit** `feat(server): GET /api/projects/pulse su segnali condivisi col pulse`.

### Task 12: chat docs/backlog non-streaming (`?stream=false`)

**Files:**
- Modify: `apps/server/src/routes/docs-chat-core.ts` (`streamChatResponse` accetta `mode: "sse" | "json"`; in `json` accumula `delta`, `sources`, `done` e alla fine `reply.send({ answer, sources, sessionId })` SENZA hijack; la persistenza è identica)
- Modify: `apps/server/src/routes/docs-chat.ts:77`, `apps/server/src/routes/backlog.ts:1078` (e la rotta docs di progetto in `project-docs.ts` se ha una chat): query `stream` (`z.stringbool().default(true)` — verifica la versione di zod in uso; altrimenti `z.enum(["true","false"])`)
- Modify: `packages/shared/src/schemas/docs.ts` (`docsChatAnswerSchema { answer, sources[], sessionId }`)
- Test: `apps/server/src/routes/docs-chat-core.test.ts`, `docs-chat.test.ts`

**Step 1: test rosso**: con LLM finto che emette 3 delta e 2 fonti,
`?stream=false` risponde `200 application/json` `{ answer: "abc", sources:
[..2], sessionId }` e il messaggio assistant è persistito come nel caso SSE;
errore LLM a metà → `502` con `{ error }` (nessuna risposta parziale, e
nessun messaggio persistito — a differenza dell'SSE che appende il
`TRUNCATION_MARKER`: documenta la differenza in un commento).

**Step 2–4**: rosso → implementa → verde (`pnpm --filter @stubwise/server exec vitest run docs-chat backlog-chat`).

**Step 5: Commit** `feat(server): chat docs/backlog anche in JSON non-streaming per i client nativi`.

**Chiusura fase B**: `pnpm -r build && pnpm -r typecheck && pnpm lint`;
`pnpm --filter @stubwise/server test`, `pnpm --filter @stubwise/worker test`,
`pnpm --filter @stubwise/notifications test`, `pnpm --filter @stubwise/db
test`. Aggiorna `packages/api-client` con gli endpoint nuovi (mobile-login,
devices, projects/pulse, chat `stream=false`) + test.

---

## Fase C — L'app

Ogni task dell'app: componenti in `apps/mobile/src/components`, schermate in
`apps/mobile/src/screens/<area>`, test Jest accanto (`*.test.tsx`), stringhe
in `apps/mobile/src/i18n/{it,en}.json` sotto `mobile.<area>.*` con **copy
italiano preso 1:1 dal canvas** (`designs/app-design.zip` → `Stubwise
Mobile.dc.html`: aprilo e leggi i testi delle schermate prima di ogni task
UI). Nessuna libreria di icone: glifi mono (`◆ ▲ ● ○ →` ecc. come nel
canvas). Test di parità it/en: `apps/mobile/src/i18n/parity.test.ts` (stesse
chiavi).

### Task 13: fondamenta dell'app — tema, i18n, storage, client, navigazione, login, onboarding

**Files:**
- Create: `apps/mobile/src/theme/{tokens,typography}.ts` (token del design: `ink950 #0a0d10`, `ink900 #0f1318`, `ink800 #181f28`, `line #1d242d`, `fg #e9e6df`, `muted #98a1ac`, `faint #5c6671`, `signal #f5a623`, `danger #ff6b6e`, `ok #4ad295`, `sky #38bdf8`, `violet #a78bfa`; raggi 8/10; font IBM Plex Sans/Mono — file `.ttf` in `apps/mobile/assets/fonts/`, linkati con `react-native.config.js` + `npx react-native-asset`)
- Create: `apps/mobile/src/i18n/{index.ts,it.json,en.json}`
- Create: `apps/mobile/src/lib/storage.ts` (Keychain: `saveSession({ baseUrl, token, patId, user })`, `loadSession`, `clearSession`; AsyncStorage per il persister di TanStack Query e per `lastSyncAt`)
- Create: `apps/mobile/src/lib/client.ts` (`createStubwiseClient` con `baseUrl` dalla sessione e `getAuthHeader` dal Keychain; su 401 → `clearSession` + evento `session:expired`)
- Create: `apps/mobile/src/app/{App.tsx,providers.tsx,navigation.tsx,linking.ts}` (`NavigationContainer` con `linking` per `stubwise://inbox/:id`, `stubwise://tickets/:id`, `stubwise://projects/:id`; stack radice: `Auth` (Login, Onboarding) | `Main` (tabs INB/PRJ/BLG/DOC con sigle mono nella tab bar e badge sul tab INB)
- Create: `apps/mobile/src/screens/auth/{LoginScreen,OnboardingScreen}.tsx`
- Create: `apps/mobile/src/components/{Wordmark,SectionLabel,MonoBadge,Skeleton,OfflineBanner,PrimaryButton,GhostButton}.tsx` (Wordmark con il blink 1.1 s del cursore — `Animated` loop)
- Modify: `apps/mobile/ios/StubwiseMobile/Info.plist` (`CFBundleURLTypes` con scheme `stubwise`), `apps/mobile/android/app/src/main/AndroidManifest.xml` (intent-filter `stubwise://`)
- Test: `LoginScreen.test.tsx`, `OnboardingScreen.test.tsx`, `storage.test.ts`, `navigation.test.tsx` (deep link → schermata), `i18n/parity.test.ts`

**Step 1: test rossi** (Jest + testing-library; mocka `react-native-keychain`
e `@react-native-async-storage/async-storage` in `jest.setup.ts` — usano i
mock ufficiali dei package):
- Login: form URL/email/password; submit → chiama
  `client.auth.mobileLogin` con `deviceName` = `DeviceInfo.getDeviceName()`
  (o `Platform` + modello); errore 401 → testo «Email o password non
  corretti» (copy del canvas); URL non raggiungibile → stato «istanza
  irraggiungibile» con «Riprova»; successo → sessione salvata + naviga a
  Onboarding.
- Onboarding: mostra i progetti (`client.projects.list`) con toggle
  (preselezionati i seguiti da `me/follows`), «Attiva le notifiche e inizia»
  → chiede il permesso (mock `notifee.requestPermission`) → registra il
  device (`client.me.registerDevice`) → salva i follow → `Main`; «Più tardi»
  → salta solo il permesso.
- Deep link `stubwise://inbox/abc` con sessione → apre `Main/Inbox/Card abc`;
  senza sessione → Login (il link viene ricordato e riaperto dopo il login).

**Step 2: Run** `pnpm --filter @stubwise/mobile test` → FAIL.

**Step 3: implementa**. Dipendenze da aggiungere (versioni compatibili con
la RN scelta, tutte con autolinking, `pod install` dopo): `@react-navigation/
native`, `@react-navigation/native-stack`, `@react-navigation/bottom-tabs`,
`react-native-screens`, `react-native-safe-area-context`,
`@tanstack/react-query`, `@tanstack/query-async-storage-persister`,
`@tanstack/react-query-persist-client`, `@react-native-async-storage/
async-storage`, `react-native-keychain`, `react-i18next`, `i18next`,
`react-native-device-info`, `@react-native-community/netinfo`.

**Step 4: Run** test → PASS; `pnpm --filter @stubwise/mobile ios` → login
reale contro `https://stubwise.thecove.it` con un utente di prova (crea un
utente member apposta se serve; NON usare il PAT admin del maintainer).

**Step 5: Commit** `feat(mobile): fondamenta — tema, i18n, sessione, navigazione, login e onboarding`.

### Task 14: Inbox — sezioni e 6 varianti di card, sheet domanda e rifiuto, snooze/gestita, stati

**Files:**
- Create: `apps/mobile/src/screens/inbox/{InboxScreen,InboxCardScreen}.tsx`
- Create: `apps/mobile/src/lib/inbox-sections.ts` (`sectionize(items, viewer) → { blocksYou, waitingOthers, onlyYouMaintainer, fromProjects }` — pura: `blocksYou` = card con azioni decisionali per il viewer (`actions` include `answer`/`approve`/`relaunch`), `onlyYouMaintainer` = admin-only (kind `job.plan_review`, `job.held`…), `waitingOthers` = informative con `waitingOn`, `fromProjects` = `project.pulse` e `pr.opened`)
- Create: `apps/mobile/src/components/inbox/{InboxCard,QuestionCard,PulseProposalCard,PlanReviewCard,PrReadyCard,FailedCard,InfoCard,QuestionSheet,RejectSheet,SnoozeSheet}.tsx`
- Create: `apps/mobile/src/lib/inbox-mutations.ts` (hook TanStack: `useSnooze` e `useHandled` **ottimistiche** con rollback; `useAnswer`, `useApprove`, `useReject`, `useRelaunch`, `useProceed` **non** ottimistiche, disabilitate offline con label «serve la rete»; 409 → `handledByFromError` → invalida e mostra «ci ha pensato {name}»)
- Test: `inbox-sections.test.ts`, `InboxCard.test.tsx` (una `describe` per variante), `QuestionSheet.test.tsx`, `RejectSheet.test.tsx`, `InboxScreen.test.tsx` (vuoto «Tutto gestito.», skeleton, offline banner, permessi negati card non bloccante)

Riferimenti web da rileggere prima: `apps/web/src/components/inbox-item.tsx`
(azioni per variante, ottimismo), `question-panel.tsx` (opzioni +
conseguenza, «Altro (testo libero)», conferma), `apps/web/src/lib/api.ts`
(`answer`, `snooze { until: "1h"|"tomorrow"|"3d" }`). Le opzioni Rimanda del
canvas «1h / stasera / domani» mappano su `1h / tomorrow / 3d` (etichette del
canvas, valori dell'API).

**Step 1: test rossi** per ogni variante (rende con un `ActionableNotification`
di `sampleEvents` + `actions`): bottoni presenti solo se l'azione è in
`actions`; Approva → conferma → chiama `approve`; Rifiuta → `RejectSheet` con
i chip «Riduci lo scope · Costa troppo · Rimanda a dopo» + testo → `reject`
con le istruzioni concatenate; proposta pulse → «Procedi con A» → `answer`
con `optionIndex` della consigliata; domanda → `QuestionSheet` con opzioni +
conseguenza, «Altro (testo libero)», conferma «Invia la risposta»; fallito →
Riprova/Apri/Rimanda; informativa senza bottoni con «Aspetta {who}»; snooze
ottimistico: la card sparisce subito e torna se la mutazione fallisce.

**Step 2–4**: rosso → implementa → verde.

**Step 5: Commit** `feat(mobile): inbox con sezioni, 6 varianti di card, sheet domanda/rifiuto`.

### Task 15: Progetti — lista col polso e dettaglio

**Files:**
- Create: `apps/mobile/src/screens/projects/{ProjectsScreen,ProjectDetailScreen}.tsx`
- Create: `apps/mobile/src/lib/pulse-line.ts` (`pulseLineFor(summary, viewerId) → { tone: "signal"|"sky"|"faint"|"ok", key, params }` — ambra «aspetta te — …» se `waitingForYou.length`, blu «sta lavorando — …» se `running.length`, grigio «fermo da N giorni» se `idleDays >= 2` senza attività, verde «tutto tranquillo»)
- Create: `apps/mobile/src/components/projects/{PulseRow,CountsLine,ProjectGroup}.tsx`
- Test: `pulse-line.test.ts`, `ProjectsScreen.test.tsx`, `ProjectDetailScreen.test.tsx`

**Step 1: test rossi**: `pulseLineFor` sui 4 casi con precedenza (aspetta
te > sta lavorando > fermo > tranquillo); lista ordinata come dal server;
riga mono di conteggi «2 in attesa · 1 in corso · 3 pronte»; dettaglio con
gruppi `Aspetta qualcuno · N` (ambra) / `Adesso · N` / `Pronto nel backlog ·
N` / «Report di ieri» (apre `/activity` del giorno: v1 mostra il riassunto
`summary` del report, rotta esistente) ; stato vuoto «Scegli cosa seguire» con
link ai toggle (Impostazioni → progetti seguiti).

**Step 2–4**: rosso → implementa → verde. **Step 5: Commit** `feat(mobile): progetti con polso e dettaglio`.

### Task 16: Lavoro — timeline in parole, piano, approvazione, livello tecnico

**Files:**
- Create: `apps/mobile/src/screens/work/WorkScreen.tsx` (rotta `Work/:ticketId`)
- Create: `apps/mobile/src/lib/timeline.ts` (`buildTimeline({ ticket, jobs, questions }) → Step[]` con i 6 passi del canvas — Proposto → Domanda risposta → Piano approvato → In esecuzione → PR e review → Rilascio — ognuno `done|current|future` con data; usa `workStateFor`)
- Create: `apps/mobile/src/components/work/{StatusBadge,WorkingPill,Timeline,PlanSection,TechLevel}.tsx`
- Test: `timeline.test.ts`, `WorkScreen.test.tsx`

**Step 1: test rossi**: `buildTimeline` da job `awaiting_input` → passi 1
done, 2 current, resto future; da `done` con PR → 1–5 done, 6 future
(Rilascio non è mai `done` in v1: Stubwise non fa merge — rinvio fase 8);
`WorkingPill` «sta lavorando da 18 min — ti avviso io» dal `startedAt`;
Approva/Rifiuta solo se `job.status === "awaiting_plan_approval"` e viewer
admin; «Leggi il piano» apre il `plan` markdown in una schermata modale
(renderer: `react-native-markdown-display`, sanitizza — solo testo, niente
HTML); `TechLevel` (costo, branch, log ultime 50 righe) solo per `role ===
"admin"`.

**Step 2–4**: rosso → implementa → verde. **Step 5: Commit** `feat(mobile): schermata del lavoro con timeline in parole`.

### Task 17: Backlog — lista, Procedi, cattura rapida, chat testuale

**Files:**
- Create: `apps/mobile/src/screens/backlog/{BacklogScreen,BacklogItemScreen,CaptureSheet,BacklogChatScreen}.tsx`
- Test: `BacklogScreen.test.tsx`, `CaptureSheet.test.tsx`, `BacklogChatScreen.test.tsx`

**Step 1: test rossi**: chip Attivi/Pronti/Tutti filtrano per
`backlogItemStatusSchema` (mappa: Pronti = `ready`; Attivi = tutto tranne
`archived|converted`; Tutti); voce con stato in parole (Pronto / In
raffinamento / Nuovo) e metadati `urgenza · effort · rischio`; «Procedi» solo
su `ready` → `convert` → naviga al `Work` del ticket creato; «Raffina in chat»
→ chat con bolle (invia con `client.backlog.chat(id, message, { stream:
false })`, risposta mostrata intera; indicatore «sta pensando» col blink);
cattura rapida: FAB «+» → sheet testo + picker progetto (default: ultimo
usato) → `client.backlog.create` → toast «Aggiunta al backlog» e voce
«Nuovo» in cima (invalidate).

**Step 2–4**: rosso → implementa → verde. **Step 5: Commit** `feat(mobile): backlog con Procedi, cattura rapida e chat`.

### Task 18: Docs — ricerca, sfoglia, «Chiedi al progetto»

**Files:**
- Create: `apps/mobile/src/screens/docs/{DocsScreen,DocsPageScreen,AskProjectScreen}.tsx`
- Test: `DocsScreen.test.tsx`, `AskProjectScreen.test.tsx`

**Step 1: test rossi**: ricerca (debounce 300 ms) → `client.docs.search`;
«Oppure sfoglia» con i tre gruppi (guida, note di rilascio, pagine tecniche)
dai `kind` delle pagine; pagina in markdown; «Chiedi al progetto» → picker
progetto/repo + domanda → `client.docs.chat(..., { stream: false })` →
risposta + «Fonti» (lista cliccabile → `DocsPageScreen`).

**Step 2–4**: rosso → implementa → verde. **Step 5: Commit** `feat(mobile): docs con ricerca, sfoglia e chiedi al progetto`.

### Task 19: Push — registrazione, categorie statiche, azioni dalla notifica, badge, foreground refresh

**Files:**
- Create: `apps/mobile/src/lib/push.ts` (`setupPush()`: `messaging().getToken()`/`onTokenRefresh` → `client.me.registerDevice`; `notifee.setNotificationCategories` (iOS) / `createChannel` (Android) con le categorie statiche: `job.awaiting_input` [Rispondi, Rimanda 1h], `job.plan_review` [Approva, Rifiuta…, Rimanda 1h], `project.pulse` [Procedi con la consigliata, Apri], `job.failed`/`job.held` [Riprova, Apri], default [Apri]; `onForegroundEvent`/`onBackgroundEvent` → `handlePushAction`)
- Create: `apps/mobile/src/lib/push-actions.ts` (`categoryFor(kind)` pura; `handlePushAction({ kind, notificationId, actionId, data }, client)`: esegue `snooze 1h`/`approve`/`relaunch`/`answer(recommended)` con la stessa rotta della card; 409 o azione non più offerta → apre `stubwise://inbox/<id>`; mai esegue `reject`/`answer` con testo dalla notifica)
- Modify: `apps/mobile/src/app/providers.tsx` (`AppState` → foreground: `refetchQueries` inbox + `unread-count` → `notifee.setBadgeCount`; intervallo 60 s in foreground per `unread-count`)
- Modify: `apps/mobile/index.js` (`messaging().setBackgroundMessageHandler` + `notifee.onBackgroundEvent` registrati fuori dal componente)
- Modify: iOS: `AppDelegate` (Firebase configure, `UNUserNotificationCenter` delegate), `Info.plist` (`UIBackgroundModes remote-notification`), capability Push Notifications + `GoogleService-Info.plist` (NON nel repo: `.gitignore` + README); Android: `google-services.json` (NON nel repo), `build.gradle` plugin
- Test: `push-actions.test.ts` (categoria per kind; azione Approva → `approve` chiamato; 409 → `Linking.openURL("stubwise://inbox/<id>")`; Rifiuta → apre l'app senza chiamare API), `push.test.ts` (registrazione al token e al refresh)

**Step 1: Run** test → FAIL. **Step 2: implementa**. **Step 3**: prova reale
su device fisico iOS (APNs non arriva sul simulatore) con l'istanza di prod
configurata (Task 23) — se non è ancora configurata, la prova reale si fa
alla verifica di fine programma, ma la registrazione del device deve
comparire in `device_tokens`.

**Step 4: Commit** `feat(mobile): push con categorie statiche, azioni dalla notifica, badge`.

### Task 20: Impostazioni e logout; polish offline; accessibilità di base

**Files:**
- Create: `apps/mobile/src/screens/settings/SettingsSheet.tsx` (dall'avatar: Notifiche → push on/off (`me/prefs push`), progetti seguiti (`me/follows`); Istanza → server (sola lettura), lingua (it/en, persiste); Esci → `DELETE /api/me/devices/:token` + `DELETE /api/pats/:patId` + **`messaging().deleteToken()`** (invalida il token: un'ex istanza non può più raggiungere questo telefono, anche se se lo era salvato — è la garanzia di sicurezza del modello a relay) + `clearSession` + reset cache; al login successivo `getToken()` ne genera uno nuovo)
- Modify: `apps/mobile/src/app/providers.tsx` (`OfflineBanner` globale da NetInfo: «Offline — ultima sincronizzazione {time}»; `lastSyncAt` aggiornato a ogni fetch riuscito)
- Test: `SettingsSheet.test.tsx` (logout revoca device e PAT e chiama `deleteToken`; anche se una delle chiamate remote fallisce la sessione locale viene comunque cancellata e `deleteToken` viene comunque chiamato), `OfflineBanner.test.tsx`
- Accessibilità: `accessibilityLabel` sui bottoni con glifo, `accessibilityRole="button"`, font scaling consentito (niente `allowFontScaling={false}`)

**Step 1–4**: rosso → implementa → verde. **Step 5: Commit** `feat(mobile): impostazioni, logout, banner offline`.

**Chiusura fase C**: `pnpm --filter @stubwise/mobile typecheck && pnpm lint
&& pnpm --filter @stubwise/mobile test`; smoke sul simulatore iOS di ogni
tab con l'istanza di prod e l'utente di prova; build Android debug
(`pnpm --filter @stubwise/mobile android`) almeno una volta su emulatore.

---

## Fase D — Distribuzione, CI, documentazione, deploy

### Task 21: CI e script di versione

**Files:**
- Modify: `.github/workflows/ci.yml` (nessun job nuovo: `apps/mobile` entra in `pnpm -r build/lint/typecheck/test` — verifica che `pnpm -r build` non richieda toolchain nativa (`build` = typecheck) e che Jest non abbia bisogno di `watchman`; se `pnpm -r test` del mobile è lento, resta comunque nel job unico)
- Create: `apps/mobile/scripts/version-bump.mjs` (legge `package.json` `version`, scrive `CFBundleShortVersionString`/`CFBundleVersion` in `Info.plist` e `versionName`/`versionCode` in `android/app/build.gradle`; `versionCode` = numero di build incrementale salvato in `package.json` `buildNumber`)
- Modify: `apps/mobile/package.json` (script `version:bump`)
- Test: `apps/mobile/scripts/version-bump.test.mjs` (Jest su file temporanei)

**Step 1–4**: rosso → implementa → verde; push su un branch e verifica che
il job CI su ubuntu passi con il mobile incluso.

**Step 5: Commit** `chore(mobile): CI su ubuntu e script di versione`.

### Task 22: README di build/distribuzione e documentazione

**Files:**
- Modify: `apps/mobile/README.md`: (1) prerequisiti; (2) dev locale; (3) Firebase: creare il progetto, scaricare `GoogleService-Info.plist` / `google-services.json` (fuori dal repo, percorsi attesi); (4) iOS: Xcode → Signing & Capabilities (team, Push Notifications, Background Modes) → Product → Archive → Distribute → TestFlight interno, passo per passo; (5) Android: keystore locale (`keytool` comando), `gradle.properties` con le proprietà `STUBWISE_UPLOAD_STORE_FILE`… (fuori dal repo), `./gradlew bundleRelease`/`assembleRelease`, Play internal o APK diretto; (6) `pnpm --filter @stubwise/mobile version:bump`; (7) **il relay push**: perché esiste (app unica sugli store, chiavi legate alla nostra identità), cosa vede (titolo e corpo in TLS, nessun log — cifratura E2E in fase 4b), come un'istanza self-hosted lo usa (default di `PUSH_RELAY_URL`, `""` per spegnere le push) e come lo operiamo noi: credenziali APNs (`.p8` da Apple Developer → Keys, `APNS_KEY_ID`, `APNS_TEAM_ID`) e FCM (service account JSON) in base64 nel `.env` del VPS (`base64 -i AuthKey.p8 | tr -d '\n'`), DNS `push.<dominio>`, `docker compose --profile relay up -d --build push-relay caddy`; (8) troubleshooting Metro+pnpm.
- **⚠️ VOCE OBBLIGATORIA per `CLAUDE.md`, sezione "Invarianti e trappole"** (emersa nella fase A, Task 4b — non perderla):

  > **Verso l'app mobile, solo cambi ADDITIVI alle risposte.** L'app si aggiorna
  > dagli store, non dai nostri deploy: per settimane un server nuovo parla a
  > client vecchi. Aggiungere un campo è sicuro (il client vecchio lo scarta);
  > aggiungere un valore a un enum è sicuro **solo perché** gli schemi dei client
  > passano da `readerSchema` (`packages/shared/src/reader.ts`), che li apre e
  > riporta l'ignoto come `UNKNOWN`. **Rimuovere o rinominare un campo NON è
  > sicuro e nessun meccanismo lo copre**: il parse dell'intera risposta
  > fallisce, e sulla lista d'inbox significa schermata principale vuota su ogni
  > telefono finché l'utente non aggiorna. Un rename «tanto è solo un rename» su
  > una rotta che il mobile legge è un incidente di produzione che non possiamo
  > ritirare.

- Modify: `CLAUDE.md`: sezione monorepo (`apps/mobile`, `packages/api-client`, `apps/push-relay`), architettura runtime (servizio `push-relay` sotto profilo `relay`, solo sul nostro VPS; le istanze self-hosted NON lo avviano), sezione "Deploy" con la voce **Fase 4** (migrazione 0067; rebuild server+worker+caddy; `PUSH_RELAY_URL` di default punta al relay pubblico e `""` spegne le push; deploy del relay con profilo `relay` + DNS; rollback: scendere di immagine sul server è sicuro? — il canale `push` è un valore enum nuovo che il **poller vecchio** marca `channel_not_implemented` (innocuo), ma controlla se `notificationPrefsViewSchema`/`deliveryChannel` in shared compaiono in risposte di rotte preesistenti → scrivi la conclusione VERA dopo aver letto gli schemi), trappola «rotta `/api/projects/pulse` prima di `/:id`», nota che `apps/web` dipende da `@stubwise/api-client` in dependencies (Dockerfile.caddy).
- Modify: `apps/docs` (guida utente Starlight): pagina «App mobile» (installazione via TestFlight/APK, login, notifiche, cosa si può fare dall'app).

**Step: Commit** `docs(fase4): README di build mobile, note di deploy, guida utente`.

### Task 23: verifica finale e consegna

- `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test` verdi.
- `graphify update . && git add graphify-out/` e commit.
- Report finale per il maintainer con: quale strada Metro è servita (symlink
  o hoisted), l'elenco delle env nuove, i passi manuali che restano (Firebase
  project, chiavi APNs/FCM in `.env` del VPS, primo archivio TestFlight,
  keystore Android), e la conferma che l'app gira sul simulatore contro prod
  con l'utente di prova.
- Il merge su main e il deploy (migrazione 0067, env, rebuild
  server+worker+caddy) li fa il maintainer, come nelle fasi precedenti.

---

## Rischi e decisioni prese nel piano

- **Metro + pnpm** è il rischio n.1 e sta nel Task 1: se serve `node-linker=
  hoisted` cambia il layout di `node_modules` di tutto il monorepo; il Task 1
  impone di ri-verificare build/typecheck/test globali prima di proseguire.
- **Relay-only, per decisione del maintainer**: niente modalità «diretta»
  con le chiavi nell'istanza. L'app sugli store è una sola ed è la nostra;
  chi self-hosta usa quella e il nostro relay. Il token del device è la
  credenziale: un'istanza può raggiungere solo i telefoni che vi hanno
  fatto login, e il logout invalida il token. Il contratto `/v1/send` è
  pubblico e additivo (le istanze vecchie devono continuare a funzionare
  contro relay nuovi).
- **Token iOS**: l'app usa `@react-native-firebase/messaging` anche su iOS,
  quindi il token registrato con `platform: ios` è un **token FCM** (Firebase
  media verso APNs). Il relay manda perciò tutto via FCM in v1, con il blocco
  `apns` dentro il messaggio FCM per category/badge/thread; il client APNs
  diretto del relay resta implementato e testato ma inattivo finché non si
  registrano token APNs nativi (fase 4b, insieme alla Notification Service
  Extension). Documentalo in README e in un commento in `server.ts`.
  **Semplificazione ammessa**: se il tempo stringe, il client APNs diretto
  può essere rimandato a 4b; in quel caso `APNS_*` NON sono obbligatorie e
  la config lo dice.
- **Nessuna build nativa in CI**: gli errori nativi emergono solo in locale;
  accettato per la v1 (fase 4b valuta un runner macOS/fastlane).
- **Le azioni decisionali dalla notifica** (Approva, Procedi con la
  consigliata, Riprova) eseguono senza aprire l'app: è ciò che il canvas
  chiede; la conferma la dà il sistema (la notifica espansa). `Rifiuta` e le
  risposte con testo aprono sempre l'app.
