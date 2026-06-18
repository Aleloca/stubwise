# Stubwise — Identità Slack sui membri + avatar + invito da Slack (design)

> Design validato il 2026-06-18. Estende l'integrazione Slack (ingestion esterna,
> vedi `docs/plans/2026-06-18-stubwise-external-ingestion-design.md`) con:
> associazione esplicita identità Slack ↔ membro, import avatar, e invito di
> nuovi membri scelti dal workspace Slack.

## Obiettivo

1. Nella pagina `/team`, associare ogni membro alla sua identità Slack, così
   l'attribuzione automatica del creatore di un ticket da Slack funziona **anche
   quando l'email non coincide**.
2. Importare l'**avatar Slack** e usarlo come avatar del membro ovunque in
   Stubwise.
3. **Invitare** nuovi membri scegliendoli direttamente dal workspace Slack
   (precompila email + "prenota" l'identità/avatar applicati alla registrazione).

## Decisioni (validate)

- **Associazione via picker dal workspace Slack** (`users.list`), che salva lo
  `slack_user_id` (stabile) — non l'handle.
- **Avatar = URL Slack salvato** (es. `image_192`, CDN pubblica). Niente download
  su S3 in v1.
- **Avatar mostrato ovunque** compare l'utente (componente `Avatar` riusabile con
  fallback a iniziali).
- **Gestione admin-only** (coerente con la sezione inviti di `/team`).
- **Nessun nuovo scope Slack**: `users.list` usa `users:read`, già richiesto per
  l'attribuzione. Scope invariati: `commands`, `users:read`, `users:read.email`.

## Modello dati (migrazione 0021, additiva)

- `users`: `slack_user_id text` (**unique**, nullable — uno Slack user → un solo
  membro) + `slack_avatar_url text` (nullable).
- `invites`: `slack_user_id text` (nullable) + `slack_avatar_url text` (nullable)
  — la "prenotazione" che vive sull'invito finché non viene accettato.
- Nessuna tabella nuova.

## Client Slack (esteso)

Oggi: `views.open`, `getUserEmail` (via `users.info`). Aggiunte (scope `users:read`):
- `listWorkspaceUsers()` → `users.list` (paginato via cursor, tetto prudente,
  esclude bot e disattivati) → `{ id, displayName, email, avatarUrl }[]`.
- `getUserProfile(userId)` → `users.info` esteso a `{ email, displayName,
  avatarUrl }` (oggi ne legge solo l'email).

## Attribuzione aggiornata (cuore della richiesta)

Nel `view_submission` di Slack l'ordine diventa:
1. **match per `slack_user_id`** (dal `payload.user.id`) — stabile, indipendente
   dall'email (nuovo helper `resolveReporterBySlackId(db, slackUserId)`);
2. **fallback** a `users.info` → email → match per email (comportamento attuale).

**Auto-link:** se il match avviene per email e il membro non ha ancora
`slack_user_id`, lo salviamo (con avatar se mancante) nella stessa operazione —
così le associazioni si auto-popolano nei casi facili; il picker manuale serve
per chi non ha mai l'email allineata.

## Server — endpoint

- **`GET /api/slack/workspace-users`** (requireAdmin): se Slack è configurato
  ritorna la lista del workspace per il picker, ogni voce con `linkedUserId` (se
  già associata a un membro). Slack non configurato → 400 `slack_not_configured`.
- **`PUT /api/users/:id/slack`** (requireAdmin) `{ slackUserId }`: valida via
  `getUserProfile`, salva `slack_user_id` + `slack_avatar_url`. Identità già di un
  altro membro → 409 `slack_identity_taken` (colonna unique).
- **`DELETE /api/users/:id/slack`** (requireAdmin): dissocia (azzera i due campi).
- **`GET /api/users`**: proiezione estesa con `avatarUrl` (= `slack_avatar_url`) e
  `slackUserId` (per lo stato "collegato"; non è un segreto).
- **`POST /api/auth/invites`** (admin), esteso: oltre a `email` accetta
  `slackUserId?`. Se presente, il server risolve il profilo (`getUserProfile`) e
  salva sull'invito `email` + `slack_user_id` + `slack_avatar_url`.
- **`POST /api/auth/register`**: nella transazione esistente copia
  `slack_user_id` + `slack_avatar_url` dall'invito all'utente. L'identità è legata
  al **token**, non all'email digitata (che resta editabile, precompilata).

**Sicurezza:** il client invia **solo** lo `slackUserId`; email e avatar URL sono
**derivati server-side** da Slack, mai accettati come input arbitrario (evita
XSS via `<img>`/SSRF). Endpoint di gestione admin-only.

**Caso limite (unique `slack_user_id`):** se alla registrazione quell'identità è
già legata a un altro membro, l'utente viene creato **senza** i campi Slack
(best-effort) — la registrazione non fallisce mai per questo; l'admin ri-associa
da /team. Il picker esclude utenti Slack già collegati o già invitati.

## UI

### Pagina /team
- **Membri**: avatar + stato Slack ("Linked: @nome" / "Not linked"). Admin:
  azione **"Link Slack"** (picker da `workspace-users`, mostra nome+avatar, segna
  i già collegati) → `PUT …/slack`; **"Unlink"** → `DELETE …/slack`. Se Slack non
  configurato, azione disabilitata con hint → Settings → Slack.
- **Inviti**: accanto all'email manuale, **"Invite from Slack"** apre lo stesso
  picker limitato ai membri del workspace non ancora registrati/invitati →
  precompila email + prenota identità. La lista inviti mostra l'identità/avatar
  prenotati.

### Componente Avatar (riusabile)
`{ src?: string|null; label; size }`. Con `src` → `<img>` (lazy, alt); senza →
iniziali su sfondo a colore deterministico (hash email). Unico punto che decide
immagine vs iniziali.

### Integrazione avatar
`publicUser`/`SessionUser` guadagnano `avatarUrl`. Avatar mostrato in: /team,
autori di commenti/eventi nell'activity feed (risolti dalla users query;
AI/sistema invariati), assegnatario del ticket, e utente corrente.

**CSP:** se l'app ha una `img-src` ristretta, estenderla al CDN Slack
(`*.slack-edge.com`); il fallback a iniziali copre comunque il blocco immagine.

## Errori

`slack_not_configured` (400), `slack_identity_taken` (409); auto-link e copia in
registrazione **best-effort** (non bloccano mai attribuzione/registrazione).

## Testing (TDD)

- **Slack client**: `listWorkspaceUsers` (paginazione, esclude bot/disattivati),
  `getUserProfile` (email+avatar) — `fetch` mockato.
- **Endpoint**: workspace-users (not-configured→400, `linkedUserId`), PUT/DELETE
  slack (salva id+avatar, unique→409, dissocia), proiezione utente estesa.
- **Attribuzione** (testcontainers): match slack-id prima, fallback email,
  auto-link salva l'id quando manca.
- **Inviti**: POST con slackUserId prenota, register copia i campi, conflitto →
  best-effort senza Slack, picker esclude già-membri/invitati.
- **UI**: Avatar (img vs iniziali), /team link/unlink, invito da Slack, hint
  not-configured; parità i18n en/it.
- **E2E**: mantenere verdi gli esistenti; aggiornare solo se si toccano flussi
  coperti.

## Deploy

Migrazione **0021** additiva (colonne su `users` e `invites`); **nessuna env
nuova**; **nessun nuovo scope Slack** (`users:read` già richiesto — l'admin deve
solo averlo aggiunto e reinstallato l'app). Rebuild server + caddy; verifica
`/health`, colonne, CI. Aggiornare la doc Slack/Team (picker, invito da Slack,
avatar, nota scope).

## Fuori scope (follow-up)

- **Avatar su S3** (sovrano, invece dell'URL Slack): rimandato.
- **Self-service** del collegamento Slack (ogni utente collega il proprio):
  in v1 è solo admin da /team.
- **Re-sync periodico** degli avatar/nomi Slack: in v1 si aggiorna al
  (ri)collegamento e all'auto-link.
- **Upload manuale** di un avatar non-Slack: fuori scope.
