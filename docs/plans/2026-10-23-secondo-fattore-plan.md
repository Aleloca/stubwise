# Secondo fattore sul login — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ogni login di Stubwise (web e app) chiede un secondo fattore — TOTP,
passkey o codice di riserva — e le azioni sensibili chiedono una riconferma
recente, con recupero, avvisi fuori dalla web e registro di sicurezza.

**Architecture:** la sessione esistente (`sessions`) guadagna uno **stadio**
(`second_factor` / `enrollment` / `full`) e la data dell'ultimo secondo
fattore: `/login` apre una sessione parziale di 10 minuti che raggiunge solo
le rotte dichiarate `{ kind: "second_factor" }`; la riconferma è un campo
`config.reauth` controllato dall'hook globale `accessPreHandler`, come
`config.access`. Gli avvisi sono un `notification_kind` nuovo
(`security.alert`) con un'audience a destinatario singolo che ignora le
preferenze, consegnato dal worker come oggi (push + DM Slack).

**Tech Stack:** Fastify + Zod + Drizzle (server), `otplib` (TOTP),
`@simplewebauthn/server` + `@simplewebauthn/browser` (passkey), `qrcode`
(QR nella web), React + TanStack (web), React Native bare (app), Vitest,
Playwright.

**Spec:** `docs/plans/2026-10-23-secondo-fattore-design.md`

## Global Constraints

- Durata della sessione parziale: **10 minuti**. Finestra della riconferma: **10 minuti**.
- Codici di riserva: **10**, monouso, salvati solo come hash; avviso quando ne restano **≤ 3**.
- Tetto per account: **5** codici sbagliati di fila → passo del secondo fattore bloccato **15 minuti**; sessioni e token già aperti NON toccati.
- TOTP: 6 cifre, 30 s, SHA-1 (default delle app), tolleranza ±1 passo, anti-replay (un passo già usato non vale più).
- Segreto TOTP cifrato con `encrypt`/`decrypt` di `@stubwise/db` e `app.encryptionKey`; mai in log, elenchi, notifiche, webhook.
- Le rotte nuove del login stanno in `authRoutes` e usano `onRequest: credentialsRateLimit` (mai `config.rateLimit`: lo vieta `credentialsBucketViolation`).
- Le richieste con token personale (`request.user.patId` definito) non soddisfano MAI una riconferma: 403 `session_required` (stesso codice di `POST /api/users/:id/password-reset`).
- Sessioni e token esistenti restano validi al rilascio; nessun «disattiva 2FA».
- Passkey: solo web. `rpID` = hostname di `app.publicUrl`, `origin` = origin di `app.publicUrl`.
- Avvisi: inbox + push + DM Slack, non spegnibili dalle preferenze; niente email (Stubwise non ne manda).
- Registro di sicurezza: chi agisce e chi subisce come id **e** email in testo; conservazione 1 anno.
- Migrazioni: **0100** (tabelle e colonne), **0101** (solo `ALTER TYPE notification_kind ADD VALUE 'security.alert'`, valore mai usato nel batch).
- App mobile a utente singolo, fuori dagli store: niente compatibilità con app vecchie, ma i campi nuovi delle risposte che l'app legge restano `.optional()`/`.default()` (regola del `CLAUDE.md`).
- Commit: messaggi in italiano, stile `feat(server): …`, chiusi da `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `pnpm lint` verde prima di chiudere ogni task.

## Review Focus

1. **Sessione parziale che apre una rotta normale**: un cookie di sessione parziale su qualunque rotta non `second_factor` (anche `GET /api/auth/me`, SSE, `/api/inbox`) deve dare 401 `second_factor_required` — Task 1 (test sul registro + test su rotte campione).
2. **Sessione di prima del rilascio su un'azione sensibile**: `second_factor_at` nullo e nessun TOTP → 403 `second_factor_setup_required`, e dopo la configurazione dalla stessa sessione l'azione passa — Task 6.
3. **Codice TOTP riusato nello stesso passo** (login e subito riconferma col codice appena digitato): il secondo uso è rifiutato — Task 2.
4. **Codici sbagliati da IP diversi**: il tetto per account scatta anche se nessun IP supera il suo bucket — Task 4.
5. **Admin che azzera il 2FA di sé stesso o di chi sta sopra**: 400 su sé stesso, 403 `target_above` su chi sta sopra — Task 7.

---

### Task 1: Schema, migrazione 0100 e sessione a stadi

**Files:**
- Modify: `packages/db/src/schema.ts` (`sessions` ~341, `users` ~278; tabelle nuove accanto a `personalAccessTokens`)
- Create: `packages/db/drizzle/0100_second_factor.sql` (+ journal, snapshot via `pnpm --filter @stubwise/db exec drizzle-kit generate --name second_factor`)
- Modify: `apps/server/src/auth/session.ts`, `apps/server/src/auth/access.ts`, `apps/server/src/test/fixtures.ts`
- Test: `apps/server/src/auth/session.test.ts`, `apps/server/src/auth/route-access.test.ts`, `packages/db/src/schema.test.ts` (o il test di schema esistente più vicino)

**Interfaces:**
- Produces (schema):
  - `sessions`: + `stage text not null default 'full'` (CHECK in `('second_factor','enrollment','full')`), + `secondFactorAt timestamptz null`, + `webauthnChallenge text null`, + `createdAt timestamptz not null default now()`.
  - `users`: + `secondFactorFailures integer not null default 0`, + `secondFactorLockedUntil timestamptz null`.
  - `userTotp` (`user_totp`): `userId` uuid PK FK users cascade, `secretEncrypted text not null`, `confirmedAt timestamptz null`, `lastUsedStep bigint null`, `createdAt`.
  - `userBackupCodes` (`user_backup_codes`): `id` uuid PK, `userId` FK cascade, `codeHash text not null unique`, `usedAt timestamptz null`, `createdAt`; indice su `userId`.
  - `userPasskeys` (`user_passkeys`): `id` uuid PK, `userId` FK cascade, `credentialId text not null unique`, `publicKey text not null` (base64url), `counter bigint not null default 0`, `transports text[] not null default '{}'`, `name text not null`, `createdAt`, `lastUsedAt timestamptz null`.
  - `securityEvents` (`security_events`): `id` uuid PK, `userId` uuid null FK set null, `userEmail text not null`, `actorUserId` uuid null FK set null, `actorEmail text null`, `kind text not null`, `createdAt`; indici su `(userId, createdAt)` e `createdAt`.
- Produces (server):
  - `type SessionStage = "second_factor" | "enrollment" | "full"` in `auth/session.ts`.
  - `createSession(db, userId, opts?: { stage?: SessionStage; secondFactorAt?: Date | null; ttlMs?: number }): Promise<{ id: string }>` — default `stage: "full"`, `ttlMs: SESSION_TTL_MS`.
  - `SessionUser` + `sessionId?: string`, `sessionStage?: SessionStage`, `secondFactorAt?: Date | null` (assenti per i PAT).
  - `PARTIAL_SESSION_TTL_MS = 10 * 60 * 1000`.
  - `RouteAccess` + `{ kind: "second_factor" }`: rotta raggiungibile SOLO da una sessione parziale (una sessione `full` riceve 409 `second_factor_done`).
  - `requireAuth`: una sessione con `stage !== "full"` risponde 401 `second_factor_required` su ogni rotta che non sia `second_factor`.
  - Fixture: `seedUsers` e ogni helper che oggi fa `POST /api/auth/login` creano la sessione con `createSession(app.db, id, { stage: "full", secondFactorAt: new Date() })` e ne firmano il cookie come fa `/login`; esporta `fullSessionCookie(app, userId): Promise<string>` e `partialSessionCookie(app, userId, stage): Promise<string>`.

- [ ] **Step 1: test che falliscono**
  - `session.test.ts`: «una sessione parziale non apre `GET /api/auth/me`: 401 `second_factor_required`»; «una sessione parziale scaduta dopo 10 minuti è 401 `unauthorized`»; «una sessione esistente senza colonne nuove (default `full`, `secondFactorAt` null) apre le rotte come prima».
  - `route-access.test.ts`: «le rotte `second_factor` sono ESATTAMENTE queste» con l'elenco dei Task 4–5 (all'inizio vuoto; ogni task che ne aggiunge una aggiorna l'elenco):
    ```ts
    expect(secondFactorRoutes.sort()).toEqual([/* riempito dai Task 4 e 5 */]);
    ```
  - Test di schema: le tabelle e colonne nuove esistono dopo `runMigrations`.
- [ ] **Step 2:** `pnpm --filter @stubwise/server exec vitest run src/auth` → FAIL.
- [ ] **Step 3:** schema + migrazione 0100 (generata, poi riletta: deve contenere solo DDL, nessun `ALTER TYPE`), `createSession`/`findSessionUser`/`requireAuth`/`accessPreHandler` come da Interfaces, fixture.
- [ ] **Step 4:** `pnpm --filter @stubwise/server test` e `pnpm --filter @stubwise/db test` → PASS (le fixture non passano più da `/login`, quindi la suite resta verde anche quando il Task 4 cambia `/login`).
- [ ] **Step 5:** commit `feat(db,server): sessione a stadi e tabelle del secondo fattore`.

### Task 2: Moduli del secondo fattore (TOTP, codici di riserva, tetto, registro)

**Files:**
- Create: `apps/server/src/auth/second-factor/totp.ts`, `backup-codes.ts`, `lockout.ts`, `security-events.ts` (+ `.test.ts` accanto a ciascuno)
- Modify: `apps/server/package.json` (dipendenza `otplib`)

**Interfaces:**
- Produces:
  - `totp.ts`: `startTotpEnrollment(db, key: Buffer, user: { id: string; email: string }): Promise<{ secret: string; otpauthUrl: string }>` (sovrascrive una riga NON confermata, issuer `Stubwise`); `confirmTotp(db, key, userId, code): Promise<boolean>` (imposta `confirmedAt`, `lastUsedStep`); `verifyTotp(db, key, userId, code): Promise<boolean>` (solo righe confermate, ±1 passo, rifiuta `step <= lastUsedStep`, aggiorna `lastUsedStep`); `hasConfirmedTotp(db, userId): Promise<boolean>`.
  - `backup-codes.ts`: `BACKUP_CODE_COUNT = 10`; `regenerateBackupCodes(db, userId): Promise<string[]>` (cancella i precedenti; formato `xxxxx-xxxxx`, alfabeto senza caratteri ambigui, hash con `hashServerKey`); `consumeBackupCode(db, userId, code): Promise<boolean>` (normalizza maiuscole/trattino, UPDATE guardato `used_at is null`); `remainingBackupCodes(db, userId): Promise<number>`.
  - `lockout.ts`: `SECOND_FACTOR_MAX_FAILURES = 5`, `SECOND_FACTOR_LOCK_MS = 15 * 60 * 1000`; `lockedUntil(db, userId): Promise<Date | null>`; `recordFailure(db, userId): Promise<{ locked: boolean }>` (all'ultimo fallimento imposta il blocco e azzera il contatore); `recordSuccess(db, userId): Promise<void>`.
  - `security-events.ts`: `type SecurityEventKind = "login" | "enrolled" | "totp_reconfigured" | "passkey_added" | "passkey_removed" | "backup_codes_regenerated" | "backup_code_used" | "locked" | "second_factor_reset" | "password_reset_link"`; `recordSecurityEvent(db: DbOrTx, e: { kind; user: { id; email }; actor?: { id; email } | null }): Promise<void>` (cancella anche le righe più vecchie di 1 anno); `listSecurityEvents(db, userId, limit = 50)`.
  - `verifySecondFactorCode(db, key, userId, code): Promise<"totp" | "backup" | null>` in `second-factor/index.ts`: 6 cifre → `verifyTotp`, altrimenti `consumeBackupCode`; registra `backup_code_used`.

- [ ] **Step 1: test che falliscono** (contro Postgres di test, `startTestDb`):
  - «un codice valido passa una volta sola: lo stesso codice subito dopo è rifiutato» (anti-replay, Review Focus 3).
  - «un codice del passo precedente passa, di due passi fa no».
  - «una riga non confermata non verifica nulla».
  - «10 codici di riserva, ognuno usabile una volta; rigenerare invalida i vecchi; `XXXXX-xxxxx` e `xxxxxxxxxx` sono lo stesso codice».
  - «il DB non contiene il segreto in chiaro né i codici in chiaro» (leggi la riga, `expect(row.secretEncrypted).not.toContain(secret)`; nessun `codeHash` uguale a un codice).
  - «5 fallimenti → `lockedUntil` ≈ now+15′ e contatore a 0; un successo azzera il contatore».
  - «un evento resta leggibile dopo l'eliminazione dell'utente (email in testo)»; «le righe più vecchie di un anno spariscono alla scrittura successiva».
- [ ] **Step 2:** run → FAIL. **Step 3:** implementa. **Step 4:** run → PASS.
- [ ] **Step 5:** commit `feat(server): TOTP, codici di riserva, tetto per account e registro di sicurezza`.

### Task 3: Avviso `security.alert` (migrazione 0101, audience a destinatario singolo)

**Files:**
- Create: `packages/db/drizzle/0101_security_alert.sql` (solo `ALTER TYPE notification_kind ADD VALUE 'security.alert';`)
- Modify: `packages/db/src/schema.ts` (`notificationKind`), `packages/shared/src/schemas/notification.ts`, `packages/notifications/src/{format.ts,routing.ts,publish.ts,push/payload.ts}`, `packages/i18n/src/catalog.ts`, gli altri punti che nominano `google.proposal_handed` (usali come elenco di controllo: `actions.ts`, `inbox-visibility.ts`, `dispatch.ts`, `apps/server/src/services/inbox.ts`, `apps/web/src/components/inbox-item.tsx`, `apps/mobile/src/components/inbox/InfoCard.tsx`)
- Create: `apps/server/src/auth/second-factor/alerts.ts`
- Test: `packages/notifications/src/publish.test.ts`, `apps/server/src/notification-kinds.test.ts` (già esistente: deve restare verde), `apps/server/src/auth/second-factor/alerts.test.ts`

**Interfaces:**
- Produces:
  - Evento `{ kind: "security.alert"; subject: "second_factor_reset" | "password_reset_link" | "passkey_added" | "backup_codes_regenerated" | "locked"; actorEmail: string | null }`.
  - Audience nuova `"account_owner"` + `PublishOpts.accountUserId?: string`: un solo destinatario, mai gli admin per ruolo.
  - `MANDATORY_KINDS = new Set(["security.alert"])` in `publish.ts`: per questi kind `slackRecipients`/`pushRecipients` NON filtrano su `notifySlackDm`/`notifyPush` (restano necessari `slackUserId` e un device attivo).
  - `publishSecurityAlert(db: DbOrTx, userId: string, subject, actorEmail: string | null): Promise<void>` in `alerts.ts` (wrapper di `publishNotification` con `{ accountUserId: userId }`).
  - Titoli i18n `push.title.security.alert` e testi per soggetto in `catalog.ts` (it/en).

- [ ] **Step 1: test che falliscono**: «`security.alert` arriva SOLO all'utente indicato, non agli admin»; «con `notifyPush=false` e `notifySlackDm=false` le consegne push e slack_dm vengono comunque scritte»; «senza device e senza Slack resta solo la riga d'inbox»; parità enum (test esistente).
- [ ] **Step 2–4:** FAIL → implementa → PASS (`pnpm --filter @stubwise/notifications test`, `pnpm --filter @stubwise/server exec vitest run src/notification-kinds.test.ts src/auth`).
- [ ] **Step 5:** commit `feat(notifications): avviso di sicurezza obbligatorio all'interessato`.

### Task 4: Login web a due passi (TOTP e codici di riserva)

**Files:**
- Modify: `apps/server/src/routes/auth.ts` (`/login`, rotte nuove), `packages/shared/src/schemas/` (schema auth: risposta di `/login`, corpi nuovi)
- Create: `apps/server/src/routes/second-factor-login.ts` (registrata DENTRO `authRoutes`, così condivide `credentialsRateLimit`)
- Test: `apps/server/src/routes/second-factor-login.test.ts`, `apps/server/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: Task 1 (`createSession` con stadio, `kind: "second_factor"`), Task 2, Task 3.
- Produces (tutte `{ kind: "second_factor" }` + `onRequest: credentialsRateLimit`, prefisso `/api/auth/second-factor`):
  - `/login` (password giusta) → crea sessione parziale (`stage` = `second_factor` se `hasConfirmedTotp`, altrimenti `enrollment`; TTL `PARTIAL_SESSION_TTL_MS`), risponde `{ user, stage }`. La 401 a password sbagliata resta identica.
  - `GET /` → `{ stage, passkeys: boolean, backupCodesRemaining: number, lockedUntil: string | null }`.
  - `POST /verify` `{ code }` → stadio `second_factor` soltanto; `verifySecondFactorCode`; ok → sessione promossa a `full` con `secondFactorAt = now`, TTL pieno, cookie rinnovato, `recordSuccess`, evento `login`; risponde `{ user, backupCodesRemaining }`. Errato → 401 `invalid_second_factor` + `recordFailure` (al blocco: evento `locked` + `publishSecurityAlert(…, "locked", null)`). Bloccato → 423 `second_factor_locked` con `lockedUntil`.
  - `POST /enroll` → stadio `enrollment` soltanto; `startTotpEnrollment` → `{ secret, otpauthUrl }`.
  - `POST /enroll/confirm` `{ code }` → `confirmTotp` + `regenerateBackupCodes` → sessione `full` come sopra, evento `enrolled`; risponde `{ user, backupCodes: string[] }`. Codice errato: stesso conteggio del tetto.

- [ ] **Step 1: test che falliscono**:
  - «password giusta: nessuna sessione completa, `GET /api/auth/me` col nuovo cookie è 401 `second_factor_required`».
  - «utente senza TOTP: stage `enrollment`, `/verify` è 409/403, `/enroll` + `/enroll/confirm` danno 10 codici e una sessione completa».
  - «utente con TOTP: codice giusto → `/me` 200; codice di riserva → 200 e `backupCodesRemaining` 9».
  - «5 codici sbagliati da IP diversi (`x-forwarded-for` o `remoteAddress` distinti nel `app.inject`) → 423, e una sessione completa aperta PRIMA resta valida» (Review Focus 4).
  - «codici sbagliati e password sbagliate consumano lo stesso bucket per IP» (estendi il test alternato login/mobile-login esistente).
  - Aggiorna l'elenco atteso di `route-access.test.ts` con le 4 rotte.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** commit `feat(server): login a due passi con TOTP e codici di riserva`.

### Task 5: Passkey (registrazione, login, riconferma)

**Files:**
- Create: `apps/server/src/auth/second-factor/passkeys.ts` (+ test)
- Modify: `apps/server/src/routes/second-factor-login.ts`, `apps/server/package.json` (`@simplewebauthn/server`)

**Interfaces:**
- Produces:
  - `passkeyRp(publicUrl: string): { rpID: string; rpName: "Stubwise"; origin: string }`.
  - `registrationOptions(db, sessionId, user): Promise<PublicKeyCredentialCreationOptionsJSON>` (esclude le credenziali già registrate; salva la challenge su `sessions.webauthnChallenge`).
  - `finishRegistration(db, sessionId, userId, name, response): Promise<{ id: string } | null>`.
  - `authenticationOptions(db, sessionId, userId)`; `finishAuthentication(db, sessionId, userId, response): Promise<boolean>` (aggiorna `counter` e `lastUsedAt`; challenge monouso: la cancella sempre).
  - Rotte di login (`second_factor`): `POST /api/auth/second-factor/passkey/options`, `POST /api/auth/second-factor/passkey/verify` `{ response }` → stessa promozione e stesso tetto di `/verify`.
  - Le rotte di registrazione e la riconferma via passkey sono nel Task 6/7 (sessione completa): questo task fornisce solo le funzioni.

- [ ] **Step 1: test che falliscono** con risposte WebAuthn finte firmate in test (genera una coppia di chiavi ES256 con `node:crypto` e costruisci `clientDataJSON`/`authenticatorData` a mano, oppure stubba `verifyAuthenticationResponse` con `vi.mock` SOLO per i casi di errore; il caso felice deve passare dalla verifica vera): «challenge riusata rifiutata», «origin diversa rifiutata», «passkey di un altro utente rifiutata», «login con passkey → sessione completa».
- [ ] **Step 2–4:** FAIL → implementa → PASS. Aggiorna `route-access.test.ts`.
- [ ] **Step 5:** commit `feat(server): passkey come secondo fattore`.

### Task 6: Riconferma recente (`config.reauth`)

**Files:**
- Modify: `apps/server/src/auth/access.ts` (dichiarazione `FastifyContextConfig.reauth`, controllo in `accessPreHandler`), le rotte elencate sotto
- Create: `apps/server/src/routes/me-security.ts` (prefisso `/api/me/security`, solo le rotte di riconferma in questo task)
- Test: `apps/server/src/auth/reauth.test.ts`, `apps/server/src/auth/route-access.test.ts`

**Interfaces:**
- Produces:
  - `config.reauth?: true | "setup_allowed"`; `REAUTH_WINDOW_MS = 10 * 60 * 1000`.
  - Controllo, dopo `requireAuth` e prima del switch di `access`: PAT → 403 `session_required`; utente senza TOTP confermato → 403 `second_factor_setup_required` (con `"setup_allowed"`: passa); `secondFactorAt` nullo o più vecchio della finestra → 403 `reauth_required`.
  - `POST /api/me/security/reauth` `{ code }` (`{ kind: "user" }`) → `verifySecondFactorCode` + tetto; ok → `sessions.secondFactorAt = now`, 204. PAT → 403 `session_required`. I codici sbagliati della riconferma contano nel tetto per account e il blocco ferma anche la riconferma (scelta del piano: un cookie rubato non deve poter provare codici all'infinito); la sessione resta valida, si bloccano solo le azioni sensibili.
  - `POST /api/me/security/reauth/passkey/options` e `/reauth/passkey/verify` (stesse regole).
  - `POST /api/me/security/totp/setup` (`reauth: "setup_allowed"`) e `/totp/setup/confirm` `{ code }`: per chi NON ha TOTP (sessioni di prima del rilascio) → conferma = TOTP + 10 codici + `secondFactorAt = now`; per chi lo ha → è la «riconfigura app» (sostituisce il segreto solo alla conferma; evento `totp_reconfigured`).
  - `reauth: true` sulle rotte (decisione del maintainer + design): `POST /api/pats`; `POST /api/auth/me/password`; `PATCH /api/users/:id/role`; `PATCH /api/users/:id/instance-role`; `POST /api/users/:id/password-reset`; `PUT` e `DELETE /api/users/:id/slack`; `POST /api/users/:id/git-identities`, `DELETE /api/users/:id/git-identities/:email`; `POST /api/roles`, `POST /api/roles/:id/duplicate`, `PATCH /api/roles/:id`, `DELETE /api/roles/:id`; `PUT` e `DELETE /api/projects/:projectId/members/:userId`; più quelle del Task 7.
- [ ] **Step 1: test che falliscono**:
  - `route-access.test.ts`: «le rotte con riconferma sono ESATTAMENTE queste» (elenco sopra + Task 7, ordinato).
  - `reauth.test.ts`, per OGNI rotta dell'elenco (tabella `it.each`): «scaduta → 403 `reauth_required` e nessun effetto», «fresca → passa il gate» (lo stato dopo può essere 2xx/4xx di dominio, ma non `reauth_required`), «via PAT → 403 `session_required`».
  - «sessione di prima del rilascio (Review Focus 2): `POST /api/pats` → 403 `second_factor_setup_required`; `/totp/setup` + `/totp/setup/confirm` dalla STESSA sessione; poi `POST /api/pats` → 201».
  - «un codice usato al login non vale per la riconferma nello stesso passo» (anti-replay attraverso le rotte).
- [ ] **Step 2–4:** FAIL → implementa → PASS. Gira l'intera suite server (le fixture del Task 1 danno `secondFactorAt = now`, quindi le suite esistenti delle rotte elencate restano verdi; se una suite simula il passare del tempo, aggiusta la sua fixture).
- [ ] **Step 5:** commit `feat(server): riconferma recente sulle azioni sensibili`.

### Task 7: Impostazioni → Sicurezza (API), reset da admin, script di recupero

**Files:**
- Modify: `apps/server/src/routes/me-security.ts`, `apps/server/src/routes/users.ts`
- Create: `apps/server/scripts/reset-second-factor.ts` (+ `.test.ts`), script `reset:second-factor` in `apps/server/package.json`
- Test: `apps/server/src/routes/me-security.test.ts`, `apps/server/src/routes/users.test.ts`

**Interfaces:**
- Produces (`/api/me/security`, `{ kind: "user" }`):
  - `GET /` → `{ totp: { configured: boolean; confirmedAt: string | null }, passkeys: Array<{ id; name; createdAt; lastUsedAt }>, backupCodesRemaining: number, events: SecurityEventView[] }`.
  - `POST /backup-codes` (`reauth: true`) → `{ codes: string[] }`, evento + `publishSecurityAlert("backup_codes_regenerated")`.
  - `POST /passkeys/options` (`reauth: true`), `POST /passkeys` `{ name, response }` (`reauth: true`) → evento + avviso `passkey_added`; `PATCH /passkeys/:id` `{ name }`; `DELETE /passkeys/:id` (`reauth: true`, evento `passkey_removed`). Solo le PROPRIE passkey (404 altrimenti).
  - `DELETE /api/users/:id/second-factor` (`instance/users.manage`, `preHandler: targetUserNotAbove()`, `reauth: true`): 400 su sé stessi; cancella TOTP, passkey, codici e TUTTE le sessioni del bersaglio (non i token); evento `second_factor_reset` con l'attore; avviso al bersaglio. 204.
  - `GET /api/users/:id/security-events` (`instance/users.manage`).
  - `POST /api/users/:id/password-reset` (esistente): + evento `password_reset_link` e avviso `password_reset_link` al bersaglio.
  - Script: `node dist/scripts/reset-second-factor.js --email <email>`: stessa cancellazione del reset da admin, evento con attore `null` e `actorEmail` `"server script"`, avviso; esce 1 se l'email non esiste.
- [ ] **Step 1: test che falliscono**: «GET non espone segreto né codici»; «rigenerare i codici manda l'avviso»; «passkey di un altro → 404»; «admin azzera il 2FA di un member: sessioni del member chiuse, PAT del member ancora valido, evento con email dell'attore»; Review Focus 5 («su sé stesso 400», «su chi sta sopra 403 `target_above`»); «il link di reset scrive l'evento e l'avviso»; script: «azzera per email; email inesistente → exit 1».
- [ ] **Step 2–4:** FAIL → implementa → PASS. Aggiorna l'elenco delle rotte con riconferma (Task 6).
- [ ] **Step 5:** commit `feat(server): sicurezza dell'account, reset del 2FA e script di recupero`.

### Task 8: App mobile — login con codice

**Files:**
- Modify: `packages/shared/src/schemas/pat.ts` (`mobileLoginBodySchema` + `code?: string`), `apps/server/src/routes/auth.ts` (`/mobile-login`), `packages/api-client/src/endpoints/auth.ts`, `apps/mobile/src/screens/auth/LoginScreen.tsx`, i18n dell'app
- Test: `apps/server/src/routes/auth.test.ts`, `apps/mobile/src/screens/auth/LoginScreen.test.tsx`

**Interfaces:**
- Produces: `/mobile-login`: password errata → 401 `invalid_credentials` (invariata); utente senza TOTP → 403 `second_factor_setup_required` (nessun token); `code` assente → 401 `second_factor_required`; `code` errato → 401 `invalid_second_factor` (+ tetto); bloccato → 423 `second_factor_locked`; giusto → token come oggi + evento `login`. Il tetto e il bucket per IP sono gli stessi del web.
- App: al 401 `second_factor_required` la schermata mostra un campo «Codice (app o di riserva)» mantenendo email e password; al 403 `second_factor_setup_required` un messaggio «Configura il secondo fattore dalla web, poi torna qui»; 423 → messaggio col tempo d'attesa.
- [ ] **Step 1: test che falliscono** (server: i cinque esiti; app: i tre stati della schermata, con il doppio del client completo — vedi la trappola del doppio nel `CLAUDE.md`).
- [ ] **Step 2–4:** FAIL → implementa → PASS (`pnpm --filter @stubwise/mobile test`, server).
- [ ] **Step 5:** commit `feat(mobile): login dell'app con il secondo fattore`.

### Task 9: Web — secondo passo del login e configurazione obbligatoria

**Files:**
- Create: `apps/web/src/routes/login-second-factor.tsx` (+ test), `apps/web/src/components/security/totp-enrollment.tsx`, `backup-codes-panel.tsx`
- Modify: `apps/web/src/routes/login.tsx`, `apps/web/src/router.tsx` (rotta pubblica `/login/second-factor`; in `authedRoute.beforeLoad` un 401 `second_factor_required` → redirect lì), `apps/web/src/lib/api.ts`, `apps/web/src/i18n/locales/{it,en}.json`, `apps/web/package.json` (`qrcode`, `@simplewebauthn/browser`)

**Interfaces:**
- Consumes: le rotte del Task 4 e 5.
- Produces:
  - `TotpEnrollment({ start, confirm, onDone })`: QR (SVG da `qrcode`) + segreto in testo + campo codice; riusato dal Task 10/11.
  - `BackupCodesPanel({ codes, onConfirm })`: codici, «Scarica» (`.txt`), casella «Ho salvato i codici» che abilita «Continua».
  - Pagina: stadio `second_factor` → campo codice, «Usa una passkey» se `passkeys`, «Usa un codice di riserva»; stadio `enrollment` → `TotpEnrollment` poi `BackupCodesPanel`; 423 → messaggio col minuto di sblocco; dopo il login con ≤ 3 codici rimasti, avviso con link a Impostazioni → Sicurezza.
- [ ] **Step 1: test che falliscono** (happy-dom, mock dell'API): i due stadi, l'errore di codice, il blocco, «Continua» disabilitato finché non si spunta, la difesa `?? 0` su `backupCodesRemaining` assente (fixture SENZA il campo, regola del `CLAUDE.md`).
- [ ] **Step 2–4:** FAIL → implementa → PASS (`pnpm --filter @stubwise/web test`).
- [ ] **Step 5:** commit `feat(web): secondo passo del login e configurazione obbligatoria`.

### Task 10: Web — dialogo di riconferma globale

**Files:**
- Create: `apps/web/src/lib/reauth.ts` (+ test), `apps/web/src/components/security/reauth-dialog.tsx` (+ test)
- Modify: `apps/web/src/lib/api.ts` (intercetta i 403 `reauth_required` e `second_factor_setup_required`), il layout autenticato (monta il dialogo)

**Interfaces:**
- Produces: `requestReauth(reason: "reauth_required" | "second_factor_setup_required"): Promise<boolean>` (un solo dialogo alla volta: richieste concorrenti aspettano lo stesso esito); il client API ripete UNA volta la richiesta dopo `true`, altrimenti rilancia l'errore originale. Il dialogo usa il guscio di `components/backlog/modal.tsx`; `reauth_required` → codice / passkey / codice di riserva; `second_factor_setup_required` → `TotpEnrollment` + `BackupCodesPanel` sulle rotte `/api/me/security/totp/setup*`.
- [ ] **Step 1: test che falliscono**: «un 403 `reauth_required` apre il dialogo e, confermato, la richiesta è ripetuta una volta»; «annullato → l'errore originale arriva al chiamante»; «due richieste insieme → un dialogo»; «`second_factor_setup_required` mostra la configurazione».
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** commit `feat(web): riconferma prima delle azioni sensibili`.

### Task 11: Web — Impostazioni → Sicurezza e reset dal Team

**Files:**
- Create: `apps/web/src/routes/settings/security.tsx` (+ test)
- Modify: `apps/web/src/router.tsx` (`settingsSecurityRoute`), la navigazione delle impostazioni, `apps/web/src/routes/team.tsx` (accanto al link di reset password: «Azzera 2FA» con `ConfirmDialog` e il registro dell'utente), `apps/web/src/components/inbox-item.tsx` (resa di `security.alert`), i18n

**Interfaces:**
- Consumes: Task 7, componenti del Task 9, `requestReauth` (implicito via api).
- Produces: pagina con stato TOTP (+ «Riconfigura app»), passkey (aggiungi con nome via `@simplewebauthn/browser`, rinomina, togli), codici rimasti (+ «Rigenera», avviso a ≤ 3), registro eventi. Nessun «disattiva». «Azzera 2FA» visibile solo con `users.manage` (permessi letti da `/me`, mai dedotti).
- [ ] **Step 1: test che falliscono**: rendering dei tre blocchi; «rigenera mostra i codici nuovi una volta»; «nessun bottone disattiva»; Team: «Azzera 2FA assente senza `users.manage`»; inbox: card `security.alert` per ogni soggetto.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** commit `feat(web): pagina Sicurezza e azzeramento del 2FA dal Team`.

### Task 12: E2E Playwright

**Files:**
- Create: `apps/web/e2e/second-factor.ts` (helper: legge il segreto mostrato in testo nella configurazione, calcola i codici con `otplib`), `apps/web/e2e/second-factor.spec.ts`
- Modify: `apps/web/e2e/core-flows.spec.ts`, `apps/web/e2e/roles-flow.spec.ts` (i login via UI e via `request` passano dal secondo passo), `apps/web/package.json` (devDependency `otplib`)

- [ ] **Step 1:** spec nuova: «primo login → configurazione obbligatoria → codici → dentro»; «logout, login con codice»; «creare un token personale dopo 10 minuti chiede la riconferma» (usa `page.clock` per avanzare l'ora, o una sessione con `secondFactorAt` vecchio se il clock non tocca il server: in quel caso fai il test al livello di `request` con un cookie preparato da `start-stack.mjs`).
- [ ] **Step 2:** `pnpm --filter @stubwise/web exec playwright test` → le spec esistenti FALLISCONO finché non usano l'helper; aggiornale.
- [ ] **Step 3:** run → PASS tutte.
- [ ] **Step 4:** commit `test(web): e2e del secondo fattore`.

### Task 13: Documentazione e voce di deploy

**Files:**
- Create: `docs/invariants/second-factor.md`, `apps/docs/src/content/docs/team/two-factor.md`
- Modify: `CLAUDE.md` (indice delle invarianti + indice delle voci di deploy-log), `docs/operations/deploy-log.md` (voce «Secondo fattore sul login»), `apps/docs/src/content/docs/team/roles-and-members.md` (link)

- [ ] **Step 1:** `docs/invariants/second-factor.md`, titoli come nel resto di `docs/invariants/`: «Una sessione parziale apre SOLO le rotte `second_factor` (test del registro)»; «Ogni porta che dà una sessione o un token passa dal secondo fattore: `/login`, `/mobile-login`; una porta nuova va aggiunta qui e al test»; «La riconferma si DICHIARA (`config.reauth`, test del registro), un PAT non la soddisfa mai»; «Il segreto TOTP è cifrato, i codici sono hash, niente di tutto ciò in log/elenchi/notifiche»; «Il tetto per account non tocca sessioni e token aperti»; «`security.alert` ignora le preferenze e va solo all'interessato»; «Admin che azzera un pari grado: accettato, registrato e avvisato fuori dalla web (decisione del 23 ott 2026)».
- [ ] **Step 2:** voce di deploy-log: migrazioni 0100/0101; **backup**; ORDINE server → worker (consegna di `security.alert`: il worker vecchio non conosce il kind) → caddy, con i controlli d'inattività del worker; app mobile da ricompilare; avviso che al primo login ognuno configura il 2FA; script di recupero `docker compose exec server node dist/scripts/reset-second-factor.js --email <email>`; **rollback**: caddy insieme al server, NON sicuro finché esistono righe `security.alert` (`select count(*) from notifications where kind = 'security.alert';`), un server vecchio torna al login con la sola password e ignora le tabelle nuove; le sessioni parziali create dal server nuovo sarebbero lette come complete da un server vecchio → cancellarle nel rollback (`delete from sessions where stage <> 'full';`).
- [ ] **Step 3:** guida utente (inglese, come le altre pagine della guida): configurare, login, codici di riserva, passkey, telefono perso.
- [ ] **Step 4:** `pnpm lint && pnpm typecheck && pnpm --filter @stubwise/docs build` → verdi.
- [ ] **Step 5:** commit `docs: secondo fattore, invarianti, guida e voce di deploy`.
