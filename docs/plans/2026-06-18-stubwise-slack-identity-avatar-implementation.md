# Identità Slack sui membri + avatar + invito da Slack — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development.

**Goal:** Associare l'identità Slack a ogni membro (`/team`), così l'attribuzione dei ticket da Slack funziona anche senza match di email; importare l'avatar Slack e mostrarlo ovunque compare l'utente; e poter invitare nuovi membri scegliendoli dal workspace Slack (prenotando identità+avatar applicati alla registrazione).

**Architecture:** Due colonne nullable su `users` (`slack_user_id` unique, `slack_avatar_url`) e su `invites` (idem). Il client Slack guadagna `listWorkspaceUsers` (`users.list`) e `getUserProfile` (`users.info` esteso a email+avatar). L'attribuzione prova prima il match per `slack_user_id`, poi l'email (con auto-link). Email/avatar sono sempre **derivati server-side da Slack** a partire dallo `slackUserId` (mai input arbitrario del client). Componente `Avatar` riusabile (immagine o iniziali). Tutta la gestione in `/team` è admin-only.

**Design:** `docs/plans/2026-06-18-stubwise-slack-identity-avatar-design.md`. **Convenzioni:** TDD, testcontainers per DB/route, migrazione additiva, i18n en/it (parità — test ricorsivo), errori inglese + `code`, NodeNext `.js`, secret/credenziali invariate, review spec+qualità. **Pre-merge:** `pnpm lint` (root) + `pnpm -r typecheck` + `pnpm -r test` + `pnpm --filter @stubwise/web e2e`. Nessun nuovo workspace package. **Nessun nuovo scope Slack** (`users:read` già richiesto).

---

### Task 1: Schema — colonne Slack su users e invites

**Files:** `packages/db/src/schema.ts`, migrazione (`drizzle-kit generate`, verifica SQL), `packages/db/src/schema.test.ts`.

- `users`: aggiungi `slackUserId text` (colonna `slack_user_id`, **unique**, nullable) e `slackAvatarUrl text` (`slack_avatar_url`, nullable).
- `invites`: aggiungi `slackUserId text` (`slack_user_id`, nullable) e `slackAvatarUrl text` (`slack_avatar_url`, nullable). (NON unique su invites: più inviti potrebbero teoricamente riferirsi allo stesso Slack id; l'unicità è garantita su `users`.)
- Migrazione `drizzle-kit generate` (sarà `0021_*.sql`): additiva (ADD COLUMN nullable + unique index su `users.slack_user_id`). Verifica il SQL e l'idempotenza (secondo `generate` → nessun diff). Allinea snapshot/journal.

**Test (testcontainers):** insert/read utente con `slackUserId`/`slackAvatarUrl`; **unique** su `users.slack_user_id` (due utenti stesso slack id → errore); due utenti con slackUserId null entrambi → consentito (unique ignora i null in Postgres — verifica); insert/read invito con i campi Slack (round-trip). Stile dei test esistenti (randomUUID).

**Commit:** `feat(db): colonne identità Slack su users e invites`

---

### Task 2: Client Slack — listWorkspaceUsers + getUserProfile

**Files:** `apps/server/src/slack/api.ts` (+ test `api.test.ts`).

- Estendi l'interfaccia `SlackClient`:
  - `getUserProfile(userId): Promise<{ email: string | null; displayName: string | null; avatarUrl: string | null } | null>` — usa `users.info`; estrai `user.profile.email`, `display_name`/`real_name`, e l'avatar migliore disponibile (preferenza `image_192` → fallback `image_512`/`image_72`). Best-effort (null se la chiamata fallisce). MANTIENI `getUserEmail` (o re-implementalo sopra `getUserProfile`) per non rompere i chiamanti esistenti.
  - `listWorkspaceUsers(): Promise<Array<{ id; displayName; email: string | null; avatarUrl: string | null }>>` — usa `users.list` con paginazione via `cursor` (`response_metadata.next_cursor`), un tetto massimo prudente (es. 1000 utenti / 5 pagine), **escludendo** `is_bot`, `deleted`, e l'utente `USLACKBOT`. Best-effort: in caso di errore ritorna lista vuota (o lancia? scegli: per il picker meglio propagare un errore gestito a monte → l'endpoint risponde "non disponibile"; documenta).
- `users.list`/`users.info` usano lo scope `users:read` già richiesto: NESSUN nuovo scope.

**Test (Vitest, fetch/slackApi mockato, NIENTE rete):** `getUserProfile` mappa email+displayName+avatar dal payload `users.info`; sceglie `image_192`; null se `ok:false`. `listWorkspaceUsers` aggrega più pagine (mock con `next_cursor`), filtra bot/deleted/USLACKBOT, rispetta il tetto. `getUserEmail` resta funzionante.

**Commit:** `feat(server): client Slack listWorkspaceUsers + getUserProfile`

---

### Task 3: Server — proiezione utente estesa + link/unlink + workspace-users + attribuzione

**Files:** `apps/server/src/routes/users.ts`, `apps/server/src/slack/routes.ts` (o un nuovo file per workspace-users sotto `/api/slack`), `apps/server/src/ingest/reporter.ts`, `apps/web/src/lib/api.ts`, test.

- **Proiezione utente** (`users.ts`): `publicUserSchema` + `avatarUrl: string | null` (= `slack_avatar_url`) e `slackUserId: string | null`. `GET /api/users` li seleziona/espone. Aggiorna `SessionUser`/`PublicUser` lato client (`api.ts`) con `avatarUrl` (e `slackUserId`), e l'endpoint `GET /api/auth/me` per esporre `avatarUrl` dell'utente corrente.
- **`PUT /api/users/:id/slack`** (requireAdmin) body `{ slackUserId: string }`: 404 se utente inesistente; `getUserProfile(slackUserId)` → se null/non risolvibile → 400 `slack_user_not_found`; salva `slack_user_id` + `slack_avatar_url` (dall'avatar risolto) sull'utente; **409 `slack_identity_taken`** se lo slack id è già di un altro utente (intercetta unique violation o pre-check). Risposta con l'utente aggiornato (proiezione). Se Slack non configurato → 400 `slack_not_configured`.
- **`DELETE /api/users/:id/slack`** (requireAdmin): azzera i due campi; 204; 404 se utente assente.
- **`GET /api/slack/workspace-users`** (requireAdmin): se Slack non configurato → 400 `slack_not_configured`; altrimenti `listWorkspaceUsers()` arricchito con `linkedUserId` (join con `users.slack_user_id`): `{ id, displayName, email, avatarUrl, linkedUserId: string | null }[]`.
- **Attribuzione** (`reporter.ts` + `slack/routes.ts`): nuovo `resolveReporterBySlackId(db, slackUserId): Promise<string | null>` (match su `users.slack_user_id`). Nel `view_submission`: prova prima `resolveReporterBySlackId(payload.user.id)`; se null → `getUserEmail` → `resolveReporter(email)`. **Auto-link best-effort:** se il match è per email e quell'utente ha `slack_user_id` null, fai un UPDATE che setta `slack_user_id = payload.user.id` (+ `slack_avatar_url` se mancante, via getUserProfile) — racchiuso in try/catch (un conflitto unique non deve rompere la creazione del ticket).
- Client `api.ts`: `getSlackWorkspaceUsers()`, `linkUserSlack(userId, slackUserId)`, `unlinkUserSlack(userId)` + tipi.

**Test (testcontainers):** proiezione estesa (avatarUrl/slackUserId presenti); PUT link → salva id+avatar (getUserProfile mockato), unique→409, slack-not-configured→400, slack-user-not-found→400, requireAdmin; DELETE → 204 + campi azzerati; workspace-users (mock client) con linkedUserId corretto, not-configured→400; attribuzione: match per slackId prima, fallback email, auto-link salva l'id quando manca e NON rompe se l'id è già preso.

**Commit:** `feat(server): identità Slack utenti (link/unlink, workspace picker, attribuzione)`

---

### Task 4: Server — invito da Slack (prenotazione su invites + copia alla registrazione)

**Files:** `apps/server/src/routes/auth.ts`, `apps/web/src/lib/api.ts`, test `auth.test.ts`.

- **`POST /api/auth/invites`** (requireAdmin), esteso: body `{ email: string, slackUserId?: string }`. Se `slackUserId` presente: `getUserProfile(slackUserId)` (Slack dev'essere configurato, altrimenti 400 `slack_not_configured`); usa l'email risolta se il client non ne fornisce una coerente (scegli: l'email resta quella del body, ma se assente/vuota e Slack la fornisce usala — mantieni `email` obbligatoria nel body precompilata dal picker); salva sull'invito `slack_user_id` + `slack_avatar_url`. Senza `slackUserId` → comportamento attuale.
- **`POST /api/auth/register`**: nella transazione esistente (consuma invito → crea utente), copia `slack_user_id` + `slack_avatar_url` dall'invito ai `values` dell'INSERT utente. **Caso limite:** se quello `slack_user_id` è già su un altro utente (unique violation sull'utente), ritenta l'INSERT **senza** i campi Slack (best-effort: la registrazione non deve fallire). Implementa con un pre-check (`slack_user_id` già esistente → ometti) o intercettando la unique violation specifica su slack_user_id (distinguila da quella su email, che resta 409). Documenta l'approccio.
- **`GET /api/auth/invites`**: includi nella proiezione `slackUserId`/`slackAvatarUrl` (per la UI lista inviti).
- Client `api.ts`: `postInvite` esteso con `slackUserId?`; tipo `PendingInvite` con i campi Slack.

**Test (testcontainers):** POST invito con `slackUserId` → invito ha i campi Slack (getUserProfile mockato); register copia i campi sull'utente; register quando lo slack id è già preso → utente creato SENZA campi Slack (no errore); register classico (senza Slack sull'invito) invariato; email già esistente → 409 invariato; lista inviti espone i campi Slack.

**Commit:** `feat(server): invito di membri dal workspace Slack`

---

### Task 5: Web — componente Avatar + integrazione

**Files:** nuovo `apps/web/src/components/avatar.tsx` (+ test), `apps/web/src/components/activity-feed.tsx`, `apps/web/src/routes/tickets/$id.tsx` (assegnatario), `apps/web/src/lib/auth.ts`/`api.ts` (tipi), i18n, eventuale CSP.

- **`Avatar`**: props `{ src?: string | null; label: string; size?: number }`. Con `src` → `<img src alt={label} loading="lazy">` con dimensioni `size`; in caso di errore di caricamento (`onError`) ricade sulle iniziali. Senza `src` → iniziali (prime lettere di nome/email) su sfondo a **colore deterministico** (hash della label). Tondo, stile control-room.
- **Tipi**: assicurati che `PublicUser`/`SessionUser` (dal Task 3) abbiano `avatarUrl`; costruisci una mappa `userId → { email, avatarUrl }` dalla users query dove serve.
- **Integrazione**:
  - `activity-feed.tsx`: accanto agli autori di **commenti** ed **eventi** (risolvi avatar dalla users query per `authorId`/`actorId`; autori AI/sistema mantengono il trattamento attuale — niente avatar utente).
  - `$id.tsx`: avatar accanto all'**assegnatario** nel pannello azioni.
  - Dove si mostra l'**utente corrente** in modo prominente (se presente un header/menu utente).
- **CSP**: verifica se esiste una Content-Security-Policy con `img-src` ristretto (cerca header CSP / helmet / Caddy). Se sì, consenti il CDN avatar Slack (`*.slack-edge.com`); altrimenti annota che non serve. Il fallback iniziali copre comunque il blocco.
- i18n en/it per eventuali stringhe (alt/aria).

**Test web:** `Avatar` rende `<img>` con src e iniziali senza src; `onError` → iniziali; colore deterministico stabile per la stessa label. Integrazione: il feed mostra l'avatar per un autore con `avatarUrl` (mock users query). Mantieni verdi i test esistenti; parità i18n.

**Commit:** `feat(web): componente Avatar e integrazione (team/feed/assegnatario)`

---

### Task 6: Web — pagina /team (avatar, link/unlink, invito da Slack)

**Files:** `apps/web/src/routes/team.tsx`, `apps/web/src/lib/queries.ts` (query workspace-users), i18n, test (+ E2E se serve).

- **MembersSection**: per ogni membro mostra `Avatar` + email + ruolo + **stato Slack** ("Linked: {displayName}" / "Not linked"). Per admin: bottone **"Link Slack"** che apre un picker (dropdown ricercabile) popolato da `getSlackWorkspaceUsers()` (mostra nome + avatar; segna/disabilita i già collegati via `linkedUserId`) → alla scelta `linkUserSlack(userId, slackUserId)` → invalida `usersQueryOptions`. Sui collegati: **"Unlink"** → `unlinkUserSlack` (conferma leggera). Se Slack non configurato (l'endpoint risponde `slack_not_configured`), mostra l'azione disabilitata con hint "Configure Slack in Settings" + link a `/settings/slack`.
- **InvitesSection**: accanto al campo email (invariato), un'opzione **"Invite from Slack"** che apre lo stesso picker, limitato ai workspace users **non** già `linkedUserId` e — best-effort — non già presenti tra gli inviti in sospeso; alla scelta precompila l'email (da `getUserProfile`/dalla voce del picker) e invia `postInvite({ email, slackUserId })`. La lista inviti mostra `Avatar` + identità Slack quando l'invito ha i campi Slack.
- i18n en/it (parità) per tutte le nuove stringhe.

**Test web:** la lista membri rende avatar + stato; il picker "Link Slack" chiama `linkUserSlack` con gli id giusti (mock) e invalida; unlink chiama l'API; hint quando not-configured; "Invite from Slack" precompila e invia `postInvite` con `slackUserId`. **E2E**: `/team` non è nei flussi core E2E → mantieni verdi gli esistenti; non è richiesto un nuovo spec.

**Commit:** `feat(web): /team con avatar, associazione Slack e invito da Slack`

---

### Task 7: Docs + verifica finale

**Files:** `apps/docs/src/content/docs/integrations/slack.md` (sezione: associare i membri dal workspace, avatar, invito da Slack; ribadire che `users:read` basta — nessun nuovo scope), eventuale pagina/sezione Team. In inglese. `pnpm --filter @stubwise/docs build`.

**Verifica finale:** `pnpm lint` (root), `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @stubwise/web e2e`, `pnpm -r build`. Code review finale d'insieme vs design. **Deploy:** backup DB, migrazione additiva 0021 (colonne users+invites + unique index), rebuild server + caddy (web), verifica `/health` + colonne + CI. **Env/infra:** nessuna env nuova; nessun nuovo scope Slack (l'admin deve solo aver aggiunto `users:read` e reinstallato l'app — già fatto per l'attribuzione).

**Commit:** `docs: identità Slack sui membri, avatar e invito da Slack`

---

## Note / follow-up (NON in questa v1)
- **Avatar su S3** invece dell'URL Slack: rimandato.
- **Self-service** del collegamento Slack (ogni utente per sé): in v1 solo admin.
- **Re-sync periodico** di avatar/nomi Slack: in v1 si aggiorna al (ri)collegamento e all'auto-link.
- **Upload manuale** di un avatar non-Slack: fuori scope.
- **Picker per workspace molto grandi** (oltre il tetto di `users.list`): in v1 c'è un tetto prudente; una ricerca server-side via `users.lookupByEmail`/paginazione completa è un follow-up.
