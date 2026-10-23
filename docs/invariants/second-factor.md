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
  `/login`, `/mobile-login`; una porta nuova va aggiunta qui e al test.**
  `/register` e `/setup` oggi non aprono una sessione (rimandano al login) e
  il reset della password chiude le sessioni: se una di loro un giorno ne
  aprisse una, deve passare dallo stesso stato parziale. Il login web risponde
  `{ user, stage }`, mai una sessione completa prima del fattore.
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
  `POST /api/users/:id/password-reset`: un token rubato non crea altri token
  né cambia ruoli. `route-access.test.ts` fissa l'ELENCO delle rotte con
  `reauth`: una rotta sensibile nuova la dichiara e aggiorna l'elenco.
- **Il segreto TOTP è cifrato, i codici di riserva sono hash, niente di tutto
  ciò in log, elenchi, notifiche o webhook.** Il segreto usa
  `encrypt`/`decrypt` di `@stubwise/db` con `app.encryptionKey`; si decifra
  solo per verificare. `user_totp` ha un segreto CONFERMATO e uno PENDING:
  «riconfigura app» scrive il pending e il vecchio resta valido finché il
  nuovo non è confermato con un codice. I codici di riserva (10, monouso) si
  salvano solo come hash e si mostrano una volta alla generazione. Il codice
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
