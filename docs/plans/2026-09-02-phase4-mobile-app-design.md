---
title: Fase 4 — App mobile (React Native bare)
date: 2026-09-02
status: validato (brainstorming)
program: 2026-08-31-stubwise-nerve-center-program-design.md
design-source: designs/app-design.zip (canvas Claude Design "Stubwise Mobile")
stubwise:
  project: stubwise
  backlog: ab61e273-a522-40bc-9534-b2c6085ead37
  ticket: 309111fe-b675-463d-91fd-da98bbc99fb5
  ticketUrl: https://stubwise.thecove.it/tickets/309111fe-b675-463d-91fd-da98bbc99fb5
---

# Fase 4 — App mobile (React Native bare)

Quinta fase del programma. L'app è la "inbox delle decisioni" in tasca: le
stesse notifiche azionabili della web app (fasi 0–3), con push native, stato
dei progetti in parole, timeline del lavoro, backlog e docs. React Native
**bare** + TypeScript in `apps/mobile` (niente Expo). Il design è il canvas
Claude Design in `designs/app-design.zip` (report di lettura nel §2).

## 1. Stato di partenza (fatti verificati)

- **Auth**: `POST /api/auth/login` emette solo un cookie di sessione
  (`stubwise_session`, httpOnly, sameSite lax, 30 gg); `requireAuth` accetta
  PRIMA il Bearer PAT (`session.ts:167-183`) su ogni rotta `/api`; i PAT
  (`stw_pat_…`) ereditano tutti i permessi, nessuno scope, `expiresAt`
  opzionale; `/api/pats` è `requireAuth` (serve il cookie per il primo). Rate
  limit solo su login/register (10/min per IP, in-memory). Niente CORS su
  `/api` (irrilevante per un client nativo). **Nessuna rotta emette un token
  a un client nativo.**
- **API** usabili dall'app: inbox (`/api/inbox*`, schemi tutti in
  `packages/shared/src/schemas/notification.ts`), progetti, me/follows e
  notification-prefs, ticket (lista/dettaglio/jobs/questions/answer/run-ai/
  approve/reject), backlog (lista/dettaglio/convert/create/chat), attività,
  docs chat. **Le forme di ticket/job/backlog NON sono in shared** (solo gli
  enum): `ticketSchema`/`ticketDetailSchema` vivono nel server
  (`routes/tickets.ts:54,84`), ridichiarate a mano in `apps/web/src/lib/api.ts`.
- **Docs/backlog chat**: SSE su POST via `reply.hijack()`
  (`docs-chat-core.ts:124-126`); la SPA legge `response.body.getReader()`. La
  fetch di RN non espone `ReadableStream`.
- **Push**: canali delivery `webhook|slack_dm|slack_update`; il poller marca
  ogni altro canale `skipped channel_not_implemented`
  (`deliveries-poller.ts:236-240`); `publishNotification` crea le delivery
  per destinatario con `slackRecipients` (`publish.ts:219-231`, una query).
  **Nessuna tabella device token.** Testi: `formatNotificationText(event,
  lang)`; azioni: `actionsFor` pura; `openUrl` per il deep link.
- **Monorepo**: `pnpm-workspace.yaml` include `apps/*`; nessun `.npmrc`
  (layout pnpm symlinked); `tsconfig.base.json` NodeNext; `packages/shared`
  ESM-only, dip. solo zod, consumato da `dist/` (`mirror-slug` fuori dal
  barrel per `node:crypto`); `packages/i18n` senza I/O; locali web i18next in
  `apps/web/src/i18n/locales/*.json` (24 namespace). CI solo ubuntu
  (`pnpm -r build/lint/typecheck/test` + Playwright); nessun runner macOS,
  nessun artefatto nativo nel repo.
- **Client web** (`apps/web/src/lib/api.ts`): path relativi + `credentials:
  "include"`, `ApiError {status, code, details}`, `handledByFromError`;
  componenti di riferimento `inbox-item.tsx` (6 varianti, mutazioni
  per-card, ottimismo solo su snooze/handled), `question-panel.tsx`
  (generico), `ai-job-timeline.tsx`.
- **Segnali di progetto**: già calcolati nel worker per il pulse
  (`apps/worker/src/pulse/signals.ts`), non esposti via API.

## 2. Il design (sintesi del canvas)

- **Solo dark, iOS-first**; tab bar a 4 voci con sigle mono `INB / PRJ / BLG /
  DOC`; IBM Plex Sans/Mono; raggi 8 (10 le card); token identici alla web app
  (`ink-950 #0a0d10`, `ink-900 #0f1318`, `ink-800 #181f28`, `line #1d242d`,
  `fg #e9e6df`, `signal #f5a623`, `danger #ff6b6e`, `ok #4ad295`; in più
  muted `#98a1ac`, faint `#5c6671`, sky `#38bdf8` in esecuzione, violet
  `#a78bfa` in review); nessuna libreria di icone (glifi mono); un'unica
  animazione (blink 1.1s: cursore del wordmark e pallino "sta lavorando").
- **Inbox**: sezioni con etichette mono e contatore (`Ti blocca · 2`, `In
  attesa di altri · 1`, `Solo tu · maintainer · 2`, `Dai progetti · 1`); **6
  varianti di card**: domanda (Rispondi | Rimanda), proposta del pulse (A/B/C
  con `urgenza · effort · consigliata`, CTA "Procedi con A", Va raffinata |
  Rimanda | Gestita), piano da approvare (Approva | Rifiuta con istruzioni),
  PR pronta (verde), lavoro fallito (bordo rosso: Riprova | Apri | Rimanda),
  informativa (attenuata, senza azioni, dice chi sblocca). Sheet della domanda
  con opzioni+conseguenza, "Altro (testo libero)", "Chiedi di più"; sheet del
  rifiuto con chip (Riduci lo scope · Costa troppo · Rimanda a dopo). Stati:
  vuota ("Tutto gestito."), caricamento (skeleton delle card), offline
  (banner ambra "ultima sincronizzazione…"), permessi negati (card non
  bloccante), istanza irraggiungibile.
- **Progetti**: lista con una riga di **polso** per progetto (ambra "aspetta
  te — …", blu "sta lavorando — …", grigio "fermo da N giorni — …", verde
  "tutto tranquillo") + riga mono di conteggi; dettaglio con gruppi `Aspetta
  qualcuno · N` (ambra) / `Adesso · N` / `Pronto nel backlog · N` / Report di
  ieri, Brief settimanale; stato vuoto "Scegli cosa seguire".
- **Lavoro**: titolo, badge di stato (9 stati in parole), pill "sta lavorando
  da 18 min — ti avviso io", **Storia del lavoro** (timeline: Proposto →
  Domanda risposta → Piano approvato → In esecuzione → PR e review →
  Rilascio, passi futuri spenti); vista maintainer con "Il piano, in breve",
  Approva/Rifiuta, `Livello tecnico · solo maintainer` (costo, branch, log).
- **Backlog**: chip Attivi/Pronti/Tutti, voci con stato (Pronto/In
  raffinamento/Nuovo) e metadati, "Procedi" solo sui pronti, "Raffina in
  chat"; **cattura rapida** (sheet: testo + progetto, "Aggiungi al backlog");
  chat con bolle agente/utente.
- **Docs**: ricerca, "Chiedi al progetto" (risposta + fonti), "Oppure
  sfoglia" (guida, note di rilascio, pagine tecniche).
- **Login** (URL istanza, email, password); **onboarding notifiche** (passo
  2: "È Stubwise che ti raggiunge" + toggle dei progetti seguiti, "Attiva le
  notifiche e inizia" / "Più tardi"); **impostazioni** come sheet dall'avatar
  (Notifiche: quiet hours, progetti seguiti, canali; Istanza: server, lingua;
  Esci).
- **Push**: lock screen con titolo = la decisione; notifica espansa con le
  opzioni come azioni; **widget** small/medium "decisioni in attesa".
- Note per gli sviluppatori: tab bar nativa, sheet nativi, push con category
  per tipo e stessa API della card, deep link `stubwise://inbox/{id}`,
  widget WidgetKit/Glance, dettatura di sistema; vocabolario dagli enum di
  `packages/shared`; i18n con namespace `mobile.*`; ottimismo su risposta e
  card; offline con ultima sincronizzazione; snooze "1h / stasera / domani".

## 3. Perimetro v1 e rinvii (decisi)

**Dentro**: login (URL+email+password) e onboarding (permesso notifiche +
progetti seguiti); inbox completa (sezioni, 6 varianti, sheet domanda e
rifiuto con chip, Rimanda `1h/stasera/domani` → `1h/tomorrow/3d`, Gestita,
tutti gli stati); progetti (lista col polso, dettaglio, vuoto); lavoro
(timeline in parole, piano, Approva/Rifiuta, livello tecnico maintainer);
backlog (lista con filtri, Procedi, cattura rapida testuale, chat a testo
libero); docs (ricerca, sfoglia, "Chiedi al progetto" senza streaming); push
APNs/FCM con deep link e **azioni statiche per kind**; impostazioni (progetti
seguiti, push on/off, lingua, esci).

**Rinvii** (collocati nel programma, commit `4f02252`):

| Rinvio | Fase |
| --- | --- |
| "Rilascia (merge)" dalla card PR (Stubwise non fa merge) → la card mostra verdetto e "Apri la PR" | 8 |
| Riassunto "in breve" di piano/PR per non tecnici → v1 mostra titolo + "Leggi il piano" | 5 |
| Chat di raffinamento guidata a bottoni | 7 |
| Opzioni dinamiche nella notifica espansa (Content Extension), widget WidgetKit/Glance, dettatura dedicata, login via QR, quiet hours per utente | 4b |
| Canale email | backlog |

Deviazione operativa dal canvas: **le azioni decisionali NON si accodano
offline** (rischio di corse e stato stantio); la card resta e il bottone dice
"serve la rete". Rimanda/Gestita sì (ottimistiche con rollback).

## 4. Architettura dell'app e del monorepo

- **`apps/mobile`**: RN bare (ultima 0.7x stabile) + TS; bundle id iOS e
  package Android **`com.app.aleloca.stubwise`**. Metro con pnpm **senza**
  `.npmrc` hoisted: `unstable_enableSymlinks` + `watchFolders` (radice) +
  `resolver.nodeModulesPaths`; **Task 1 = app vuota che importa
  `@stubwise/shared` e gira su simulatore** (rischio n.1, da chiudere subito);
  fallback dichiarato `node-linker=hoisted`. `tsconfig` proprio (`jsx:
  react-jsx`, `moduleResolution: bundler`) come fa `apps/web`.
- **`packages/api-client`** (nuovo, framework-free): `createStubwiseClient({
  baseUrl, getAuthHeader })`, `ApiError { status, code, details }`,
  `handledByFromError`, funzioni tipizzate con gli schemi shared per gli
  endpoint usati dall'app; la SPA migra al package nella stessa fase (adapter
  cookie: `credentials: "include"` e base relativa) così il client è uno.
- **Schemi promossi in `packages/shared`**: `ticketSchema`,
  `ticketDetailSchema`, `aiJobSchema`, `backlogItemSchema` (lista/dettaglio),
  `projectPulseSummarySchema` (nuovo), `docsChatAnswerSchema` (nuovo).
- **Logica pura condivisa senza `@stubwise/db`**: `format.ts`/`actions.ts`
  di `@stubwise/notifications` esposti da un entry senza dipendenze DB
  (`@stubwise/notifications/pure`) o spostati in `packages/shared`.
- **i18n**: `apps/mobile/src/i18n/{en,it}.json`, react-i18next, namespace
  `mobile.*`, test di parità; copy italiano del canvas 1:1; inglese tradotto.
- **Dentro l'app**: react-navigation (bottom-tabs + stack per tab + modali
  presentati come sheet: `presentation: "modal"` con detents iOS /
  `@gorhom/bottom-sheet`), TanStack Query con persister su disco (cache =
  ultima sincronizzazione), `react-native-keychain` (token), push con
  `@react-native-firebase/messaging` (FCM) e `@notifee/react-native`
  (categorie/azioni su entrambe le piattaforme; APNs via Firebase o nativo —
  scelta nel task push, documentata), `react-native-safe-area-context`,
  `@react-native-community/netinfo` (offline). Font IBM Plex bundlati. Tema
  solo scuro.
- **Struttura**: `src/app` (navigazione, provider), `src/screens/{inbox,
  projects, work, backlog, docs, auth, settings}`, `src/components` (card
  varianti, question-sheet, timeline, badges, pulse-row, section-label,
  skeletons, offline-banner), `src/lib` (client, storage, push, deep links,
  timeline builder), `src/i18n`.
- Nessun componente React condiviso col web (primitive diverse).

## 5. Backend a servizio dell'app

- **`POST /api/auth/mobile-login`** `{ email, password, deviceName }`
  (rate-limited come login): verifica credenziali, crea un PAT `name =
  "Mobile · <deviceName>"` senza scadenza, risponde `{ token, user }`.
  Logout = `DELETE /api/pats/:id` + pulizia locale. I PAT mobile compaiono in
  Impostazioni → Access token e sono revocabili.
- **Migrazione 0067**: `device_tokens` (`id`, `userId`, `platform ios|
  android`, `token` unique, `patId?` FK pats set null, `appVersion?`,
  `lastSeenAt`, `disabledAt?`, `disabledReason?`); `users.notify_push` (bool,
  default true); `ALTER TYPE delivery_channel ADD VALUE 'push'` (statement
  separato).
- **Rotte** `PUT /api/me/devices` (upsert per token; lega al PAT corrente),
  `DELETE /api/me/devices/:token`; `notification-prefs` estese con `push`.
- **Publish**: `pushRecipients` (gemello di `slackRecipients`): per ogni
  destinatario con `notify_push` e almeno un device attivo → **una** delivery
  `push` per destinatario (non per device): i device si risolvono al momento
  dell'invio dal `userId` della notifica e il poller invia a tutti quelli
  attivi — semplice e coerente con `slack_dm`. Esito per device registrato
  nel `detail` della delivery; la delivery è `sent` se almeno un device ha
  accettato.
- **Relay push (unica modalità)**. L'app sugli store è una sola ed è la
  nostra, quindi le chiavi APNs (`.p8` del team Apple) e FCM (service
  account del progetto Firebase) sono legate alla **nostra** identità e non
  possono stare nel repo né in un'istanza self-hosted: chiunque le avesse
  potrebbe spammare i device e farle revocare. Nessuna istanza parla con
  APNs/FCM: il **poller** del worker manda `POST <PUSH_RELAY_URL>/v1/send`
  `{ tokens: [{ platform, token }], payload }` a un **relay** gestito da noi
  (`apps/push-relay`, deployato sul nostro VPS su un sottodominio dedicato),
  che possiede le chiavi e inoltra. Env dell'istanza: `PUSH_RELAY_URL`
  (default = il relay pubblico; **stringa vuota = push spente**, delivery
  `skipped push_disabled`). Il relay risponde per token: `ok` /
  `invalid_token` (`BadDeviceToken`, `Unregistered`, `UNREGISTERED`,
  `INVALID_ARGUMENT`) → `disabledAt` sul device, nessun retry / `retry`
  (rete, 429, 5xx) → backoff esistente.
- **Perché è sicuro senza registrare le istanze**: il **token del device è
  già la credenziale** (stringa lunga e non indovinabile, nota solo
  all'istanza su cui il telefono ha fatto login): chi ha accesso al relay
  può raggiungere solo gli utenti che si sono loggati volontariamente sulla
  sua istanza. Il relay aggiunge: rate limit per token (60/h, 500/giorno) e
  per IP, cap sulla dimensione del payload, nessun log dei payload; e
  l'app, al **logout**, invalida il token (`messaging().deleteToken()`) e lo
  cancella sull'istanza, così un'ex istanza non può più raggiungere quel
  telefono anche se se lo era salvato.
- **Privacy dichiarata (v1)**: il relay vede titolo e corpo delle
  notifiche di tutte le istanze, in TLS e senza log. La cifratura
  end-to-end (chiave per device, ciphertext attraverso il relay,
  decifratura in una Notification Service Extension) è in **fase 4b**.
- **Payload**: `title` per kind (i18n backend `push.title.*` nella lingua del
  destinatario), `body = formatNotificationText`, `category = kind`,
  `data = { notificationId, kind, deepLink: "stubwise://inbox/<id>" }`,
  `badge = unreadCount` del destinatario, `thread-id = projectId`.
- **Propagazione**: le push già consegnate non si ritirano; il badge si
  riallinea alla sync; il deep link su una card gestita mostra "ci ha pensato
  X" (stato `handled` con `handledBy`).
- **`GET /api/projects/pulse`**: per i progetti seguiti (admin: tutti) →
  `{ projectId, waitingForYou: [...], waitingForOthers: [{who, what}],
  running: [{ticketNumber, title, sinceMinutes}], failed: n, backlogReady: n,
  idleDays, lastActivityAt, lastReportDate? }`. I segnali del pulse
  (`apps/worker/src/pulse/signals.ts`) si spostano in un modulo condiviso
  (`packages/notifications` o nuovo `packages/project-signals`, dip. solo db)
  usato da worker e server.
- **Docs/backlog chat non-streaming**: parametro `?stream=false` sugli
  endpoint chat: il core accumula gli eventi e risponde `{ answer, sources,
  sessionId }`. Stessa logica, nessuna duplicazione.
- **Timeline in parole**: costruita dall'app da `/jobs`, `/questions`,
  `/activity` (nessuna rotta nuova); mapping stato job → 9 stati in parole
  in `packages/shared` (`workStateFor(job)`), riusabile dalla web in futuro.

## 6. Push e deep link, offline, ruoli

- **Categorie statiche per kind** (registrate all'avvio): `job.awaiting_input`
  → Rispondi (apre la card) / Rimanda 1h; `job.plan_review` → Approva
  (esegue) / Rifiuta… (apre) / Rimanda 1h; `project.pulse` → Procedi con la
  consigliata (esegue `answer` con `optionIndex = recommendedIndex`) / Apri;
  `job.failed`, `job.held` → Riprova (esegue `relaunch`) / Apri; altri → Apri.
  Le azioni eseguite dalla notifica usano il token dal Keychain e la stessa
  rotta `/actions/:action`; 409 → apre l'app sulla card informativa.
  L'app rispetta le `actions` dichiarate dal server: se l'azione non è più
  offerta, apre l'app.
- **Deep link** `stubwise://inbox/<id>`, `stubwise://tickets/<id>`,
  `stubwise://projects/<id>` via `linking` di react-navigation; Universal
  Links non in v1.
- **Badge** = `unread-count` al foreground e a ogni push ricevuta.
- **Offline**: banner ambra con timestamp dell'ultima sync; cache persistita;
  Rimanda/Gestita ottimistiche con rollback; decisionali solo online;
  refresh on-foreground; contatore ogni 60 s solo in foreground.
- **Ruoli**: le azioni arrivano già filtrate dal server (`actions[]`); la
  sezione "Solo tu · maintainer" raggruppa le card con azioni admin-only; il
  livello tecnico si mostra solo se `role === "admin"`.

## 7. Distribuzione, CI, test

- **iOS**: Xcode, firma automatica col team, archivio manuale → TestFlight
  interno; procedura in `apps/mobile/README.md`. **Android**: `gradle
  assembleRelease`/`bundleRelease` con keystore locale (fuori dal repo),
  APK diretto / Play internal. Versione e build in `package.json` +
  `Info.plist`/`build.gradle` (script `pnpm --filter @stubwise/mobile
  version:bump`). Credenziali APNs/FCM **solo nel `.env` del relay** sul
  nostro VPS (`APNS_KEY_P8` base64, `APNS_KEY_ID`, `APNS_TEAM_ID`,
  `APNS_BUNDLE_ID` = `com.app.aleloca.stubwise`, `FCM_SERVICE_ACCOUNT_JSON`
  base64): il relay è un servizio del nostro compose (`push-relay`, immagine
  `Dockerfile.push-relay`) esposto da Caddy sul sottodominio `push.<dominio>`;
  le altre istanze non lo deployano, lo usano.
- **CI**: `apps/mobile` entra in `pnpm -r lint/typecheck/test` su ubuntu
  (Jest + `@testing-library/react-native`); nessuna build nativa in CI (v1);
  `pnpm -r build` non deve richiedere toolchain nativa (script `build` del
  mobile = typecheck).
- **Test**: componenti (6 varianti di card, sheet domanda con conferma,
  timeline, sezioni, polso), logica pura (kind → categoria push, timeline
  builder, `workStateFor`), `packages/api-client` (fetch mock), server
  (mobile-login, devices, prefs push, canale push con client APNs/FCM fake,
  `/projects/pulse`, chat `stream=false`), worker (delivery push via relay
  finto: invio, `invalid_token` → disabled, `retry` → backoff), relay
  (client APNs/FCM con trasporto finto, rate limit, validazione). Nessun
  test tocca APNs/FCM veri; E2E e prova su device alla verifica di fine
  programma.
- **Deploy**: migrazione 0067; rebuild server+worker+caddy; servizio
  `push-relay` nuovo con le chiavi nel `.env` e la rotta Caddy per
  `push.<dominio>` (DNS da creare); poi TestFlight/APK interno.

## 8. Fuori scopo (v2+ → fase 4b e altre)

Vedi §3. In più: tema chiaro, iPad/tablet, Universal Links, Detox, build
native in CI, fastlane.
