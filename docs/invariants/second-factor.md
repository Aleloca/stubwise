# Invarianti e trappole — Secondo fattore sul login (23 ott 2026)

> Design: `docs/plans/2026-10-23-secondo-fattore-design.md`. Voce di deploy
> e rollback: «Secondo fattore sul login» in `docs/operations/deploy-log.md`.
> Codice: `apps/server/src/auth/second-factor/`, rotte in
> `apps/server/src/routes/{auth,second-factor-login,me-security}.ts`.

Il modello in breve: la password giusta NON apre una sessione completa ma
una **sessione parziale** (10 minuti, cookie a sé, `sessions.stage <> 'full'`)
che apre solo le rotte `second_factor`; il secondo fattore (codice TOTP,
passkey, codice di riserva) la promuove a completa. Ogni sessione completa
ricorda l'ultimo uso di un fattore (`second_factor_at`): le azioni sensibili
chiedono che sia più recente di 10 minuti (la **riconferma**). Il TOTP è
obbligatorio per tutti e non si disattiva; le passkey sono un di più.

- **Una sessione parziale apre SOLO le rotte `second_factor` (test del
  registro).** `config.access` ha il tipo `second_factor` (con `stage`
  `second_factor` o `enrollment`): l'hook globale lascia passare una sessione
  parziale solo su quelle, e dà 401 `second_factor_required` su qualunque
  altra rotta (anche `GET /api/auth/me`, SSE, `/api/inbox`). Una sessione
  parziale di un altro stadio → 409 `second_factor_stage_mismatch`; una
  sessione completa (o un PAT) su una rotta `second_factor` → 409
  `second_factor_done`. `route-access.test.ts` elenca le rotte raggiungibili
  da una sessione parziale: aggiungerne una è una decisione visibile nel diff.
- **Ogni porta che dà una sessione o un token passa dal secondo fattore:
  `/login`, `/mobile-login`, `/desktop-exchange`; una porta nuova va
  aggiunta qui e al test.** La porta si DICHIARA (`config.credentialDoor`)
  e `route-access.test.ts` ne fissa l'elenco chiuso.
  `/register` e `/setup` oggi non aprono una sessione (rimandano al login) e
  il reset della password chiude le sessioni: se una di loro un giorno ne
  aprisse una, deve passare dallo stesso stato parziale (test negativi in
  `auth.test.ts` e `password-reset.test.ts`: nessun cookie, nessuna riga in
  `sessions`). `createSession` vuole lo `stage` ESPLICITO, senza default: una
  porta nuova non nasce completa per dimenticanza. Il login web risponde
  `{ user, stage }`, mai una sessione completa prima del fattore.
- **Il token del turno della chat con Claude NON è una porta (10 nov 2026,
  chat fetta 1).** `stw_chat_…` (`claude_chat_tool_tokens`) non lo dà una
  rotta HTTP: lo EMETTE il worker a inizio turno di una conversazione libera
  (`issueChatToolToken` di `@stubwise/db`), per far leggere ai tool di Claude
  il server COME l'autore, e lo revoca nel `finally`. Per questo non è in
  questo elenco né in `config.credentialDoor`, e non va aggiunto: chi legge
  l'elenco non lo scambi per una porta dimenticata. Le sue difese, ognuna col
  test negativo in `apps/server/src/auth/chat-tool-token.test.ts`: solo l'hash
  a riposo, scadenza al più la durata di un turno; accettato SOLO in GET e
  SOLO sull'allowlist chiusa `CHAT_TOOL_READ_ROUTES`
  (`apps/server/src/auth/chat-tool-routes.ts`, con il suo test di registro:
  nessuna voce pubblica, `second_factor`, con riconferma o porta di
  credenziale) — ogni altra rotta, anche GET, 403 `chat_tool_forbidden`, e
  quindi niente riconferma, PAT, handoff o mobile-login; nessuna `sessionId`,
  quindi `applyReauth` non lo soddisfa mai; vale solo finché la sua
  conversazione esiste, è dell'utente del token e non è archiviata (un token
  caduto è 401 e non ricade sul cookie). Mai nei log, nel prompt o negli
  eventi: lo tiene il ponte del turno nel worker, non il server MCP.
- **Il login del desktop passa dal browser, e il secondo fattore lo dà la
  sessione completa (9 nov 2026).** `POST /api/auth/desktop-handoff` vuole
  una sessione COMPLETA del browser E la riconferma (`config.reauth`, come
  `POST /api/pats`: conia un token, e un cookie rubato non deve bastare). Una
  sessione parziale → 401 `second_factor_required` dall'hook, una completa
  con il fattore più vecchio di 10 minuti → 403 `reauth_required`, un PAT →
  403 `session_required` (un token non conia altri token) ed emette un codice monouso legato al
  challenge PKCE del desktop: 2 minuti, solo lo SHA-256 nel DB. `POST
  /api/auth/desktop-exchange` è pubblica, nel bucket di `/login`, NON chiede
  un codice (il fattore c'è già stato nel browser): consuma il codice con un
  UPDATE guardato (`used_at is null and expires_at > now()`), PRIMA di
  confrontare `sha256(verifier)` col challenge — un verifier sbagliato lo
  brucia — e rilascia un PAT `kind = 'desktop'` («Desktop · <nome>»). Nel
  registro di sicurezza scrive `login`, come `/mobile-login`; nessun
  `security.alert` (non ne esiste uno per il primo login di un dispositivo).
- **Limite accettato dello schema `stubwise://` (RFC 8252).** Uno schema
  custom non è legato all'app che lo registra: chi costruisce un link
  `/app/#/desktop-login` con un challenge scelto da lui, e lo fa approvare
  alla vittima, fa consegnare il codice al gestore `stubwise://` sulla
  macchina della vittima. PKCE protegge lo scambio (serve il verifier del
  challenge), non chi riceve il codice. La difesa è la conferma esplicita: il
  codice si chiede SOLO col clic su «Allow», sotto la domanda che nomina il
  dispositivo («Allow Stubwise on "<device>" to sign in as <you>?»), con la
  riconferma recente del secondo fattore, e vale 2 minuti e una volta. Non si
  emette mai il codice al caricamento della pagina, e non si toglie la
  domanda «per comodità».
- **Reset e cambio della password revocano i token `mobile` e `desktop`**
  (`revokeMobilePats`): entrambi nascono da password e secondo fattore. I PAT
  `manual` (MCP, Claude Code, script) restano E cancellano i codici
  di `desktop_handoffs` ancora aperti: un codice emesso con la password di
  prima non diventa un token dopo.
- **Lo stadio `enrollment` vale solo finché l'app non c'è.** Lo stadio si
  decide al `/login`, ma la sessione parziale vive 10 minuti: `/enroll` e
  `/enroll/confirm` ricontrollano `hasConfirmedTotp` e, con l'app ormai
  configurata, rispondono 409 `second_factor_stage_mismatch` senza toccare
  niente — altrimenti chi ha la password, con una sessione aperta prima che
  il vero utente configuri l'app, la sostituirebbe senza secondo fattore.
  `confirmTotp` invece NON rifiuta un segreto esistente: lo usa la
  riconfigurazione da Sicurezza. La conferma dell'app (login e Sicurezza)
  verifica il codice sotto il tetto SENZA scrivere (`matchPendingTotp`) e,
  solo a tentativo riuscito, conferma l'app, scrive i codici di riserva e
  promuove la sessione in UNA transazione (`commitPendingTotp`, `firstOnly`
  dal login): un codice giusto che perde la corsa col blocco non lascia
  un'app confermata senza codici di riserva.
- **Ogni verifica di un codice o di una passkey passa da UN helper,
  `attemptSecondFactor(db, user, verify)`.** Login (verifica e conferma
  dell'iscrizione), login con passkey, riconferma e `/mobile-login` non
  rifanno il conto dei fallimenti da sé: l'helper prenota il tentativo
  (`reserveAttempt`/`settleFailure`/`settleSuccess` in `lockout.ts`),
  esegue `verify` e restituisce `ok | wrong | busy | locked`. Mappa HTTP:
  `wrong` → 401 `invalid_second_factor`, `locked` → 423
  `second_factor_locked` (+ `lockedUntil`), `busy` → 429
  `second_factor_busy`. Chi legge lo stato del blocco e poi verifica fuori
  dall'helper riapre la corsa che la prenotazione chiude (parallele da molti
  IP superavano il tetto). Una prenotazione rimasta aperta oltre 60 s (crash
  tra prenotazione e verdetto) viene azzerata dal tentativo successivo
  (`users.second_factor_reserved_at`).
- **La riconferma si DICHIARA (`config.reauth`, test del registro), e un PAT
  non la soddisfa mai.** `reauth: true` sulla rotta sensibile, accanto a
  `config.access`; `"setup_allowed"` per la configurazione dell'app (una
  sessione di prima del rilascio, senza TOTP, apre l'iscrizione invece del
  dialogo: 403 `second_factor_setup_required`). Il gate gira DOPO
  l'autenticazione e PRIMA del controllo del permesso. Un token personale
  (`request.user.patId`) riceve 403 `session_required`, lo stesso codice di
  `POST /api/users/:id/password-reset`: un token rubato non crea altri token,
  non cambia ruoli e non conia inviti (`POST /api/auth/invites` è sensibile:
  un invito porta un ruolo d'istanza e dei progetti). `route-access.test.ts` fissa l'ELENCO delle rotte con
  `reauth`: una rotta sensibile nuova la dichiara e aggiorna l'elenco.
- **Il segreto TOTP è cifrato, i codici di riserva sono hash, niente di tutto
  ciò in log, elenchi, notifiche o webhook.** Il segreto usa
  `encrypt`/`decrypt` di `@stubwise/db` con `app.encryptionKey`; si decifra
  solo per verificare. `user_totp` ha un segreto CONFERMATO e uno PENDING:
  «riconfigura app» scrive il pending e il vecchio resta valido finché il
  nuovo non è confermato con un codice. I codici di riserva (10, monouso) si
  salvano solo come HMAC-SHA256 con una sottochiave della chiave di cifratura
  dell'istanza (mai uno SHA-256 nudo: ~50 bit si proverebbero offline da un
  dump del DB) e si mostrano una volta alla generazione. Cambiare
  `ENCRYPTION_KEY` invalida i codici di riserva come già il segreto TOTP. Il codice
  TOTP è anti-replay (`lastUsedStep`): lo stesso passo non vale due volte,
  nemmeno il login seguito subito da una riconferma. Le passkey sono chiave
  pubblica e metadati, niente di segreto.
- **Il tetto per account non tocca sessioni e token aperti.** 5 codici
  sbagliati di fila → il passo del secondo fattore si blocca 15 minuti; il
  blocco riguarda solo i login NUOVI. Se toccasse le sessioni già aperte,
  chiunque conosca una password potrebbe chiudere fuori il titolare mentre è
  dentro. Il bucket per IP (`credentialsRateLimit`) resta, ma da solo non
  basta: il tetto per account è ciò che ferma chi prova da molti IP.
- **`security.alert` ignora le preferenze e va solo all'interessato.** Inbox
  + push + DM Slack (mai email: Stubwise non ne manda), non spegnibile dalle
  preferenze, audience = la persona colpita. Si pubblica per: 2FA azzerato da
  un altro, link di reset della password generato da un altro, passkey
  aggiunta, codici rigenerati, blocco. Il link «Apri» NON sta nell'evento: si
  deriva a lettura da `PUBLIC_URL` (inbox del server e poller consegne del
  worker), perché un campo scritto nel jsonb esiste solo sulle card nuove.
- **Il registro di sicurezza (`security_events`) è solo in aggiunta.** Chi
  agisce e chi subisce si salvano come id **e** email in testo (le colonne
  d'autore altrove sono `ON DELETE SET NULL`); conservazione un anno.
- **Admin che azzera un pari grado: accettato, registrato e avvisato fuori
  dalla web (decisione del 23 ott 2026).** `target_above` ferma solo chi ha
  PIÙ permessi; link di reset password + azzeramento del 2FA sulla stessa
  persona sono due azioni libere per un pari grado. Ciascuna chiede la
  riconferma, scrive una riga nel registro e manda un `security.alert` che
  arriva fuori dalla web. Non si «stringe» senza una nuova decisione di
  prodotto. L'azzeramento su sé stessi è 400.
- **Recupero dell'ultimo admin: lo script sul server.**
  `apps/server/src/scripts/reset-second-factor.ts` (prod: `docker compose
  exec server node dist/scripts/reset-second-factor.js --email <email>`)
  riusa `resetSecondFactor`, quindi azzera anche i contatori del blocco.
  Sessioni e token della persona: le sessioni si chiudono, i token restano.
- **Sessioni e token di prima del rilascio restano validi.** Al prossimo
  login web ognuno passa dalla configurazione obbligatoria; un'azione
  sensibile da una sessione vecchia manda alla configurazione, e a fine
  setup la sessione conta come riconfermata. Non esiste «disattiva 2FA».
- **Passkey solo sul web.** `rpID` = hostname di `app.publicUrl`, `origin` =
  origin: un'istanza servita da un altro hostname invalida le passkey
  registrate. L'app mobile chiede il codice (TOTP o di riserva); un utente
  senza 2FA è mandato a configurarlo sul web.
- **Test E2E: `TRUST_PROXY=true` solo in `apps/web/e2e/start-stack.mjs`.**
  Serve a dare a ogni contesto il suo IP (`X-Forwarded-For`) e non esaurire
  il bucket delle credenziali; non è una configurazione di produzione.
