# Invarianti e trappole — Cassaforte delle credenziali (23 ott 2026)

> Design: `docs/plans/2026-10-23-cassaforte-credenziali-design.md`. Codice:
> `apps/server/src/vault/`, `apps/server/src/routes/{vault,credentials}.ts`,
> `packages/vault-crypto` (le primitive, usate dal browser e dal server solo per
> `PRF_INPUT` e per le sfide di possesso: del kit e della propria chiave). Tabelle: `vault_settings`,
> `vault_person_keys`, `vault_person_key_seals`, `vault_recovery_challenges`,
> `credentials`, `credential_readers`, `credential_key_copies`,
> `credential_access_log`.

Il modello in breve: ogni credenziale ha una chiave casuale (la «chiave della
voce») che cifra la sola password; quella chiave è avvolta una volta per ogni
lettore con una chiave pubblica di PERSONA (la privata sta cifrata sul server
con la passkey, PRF, e si apre solo nel browser) e una volta per la chiave
pubblica di RECUPERO (la privata è nel kit stampato, mai sul server).

- **Il server non decifra mai niente.** Riceve e conserva buste opache
  (`{ v: 1, ... }` in base64url); non ha né una chiave privata né una password
  in chiaro, e non esiste un percorso di codice che le cifri o decifri per
  conto di qualcuno. Solo il campo **password** è cifrato: `service`, `label`,
  `url`, `username`, `notes` sono in chiaro e leggibili da chi ha il database
  (limite accettato, sotto). L'AAD lega ogni busta al suo posto — la password
  all'id della credenziale, ogni copia a `credentialId:recipientId` — quindi
  una copia incollata su un'altra credenziale non si apre. Le rotte non
  mettono nulla dei corpi nei log e un errore di validazione non rimanda i
  valori ricevuti (test a runtime in `vault-isolation.test.ts`).
- **La password cifrata esce da UNA rotta sola: `reveal`.** `POST
  /api/credentials/:id/reveal` è la sola che porta `passwordCiphertext`, solo
  da sessione, e scrive il registro (`credential_access_log`, «mostra» o
  «copia») nella stessa transazione. L'anteprima di una condivisione e gli
  accessi in attesa restituiscono la copia della chiave DI CHI CHIEDE (avvolta
  per la sua chiave di persona), mai la password cifrata: chi condivide la
  ricifra per i nuovi lettori senza dover «mostrare» N volte, ma senza il
  testo cifrato quella chiave non apre nulla, e il registro non si riempie di
  letture finte. Chi aggiunge un campo a quelle risposte si chiede se sta
  regalando la busta della password.
- **Un token personale (PAT) crea e sostituisce, non legge.** Può creare
  credenziali, sostituire una password, modificare ed eliminare (lo script
  d'inserimento del maintainer). Non può MAI scaricare una copia della chiave
  (`reveal`), vedere o cambiare i lettori, condividere, confermare accessi,
  attivare la cassaforte o usare il recupero: 403 `session_required`, controllato
  PRIMA di ogni altro esame della richiesta. Chi inserisce non rilegge.
- **Conferma umana obbligatoria, mai automatica.** Una persona entra su una
  credenziale solo se un'altra persona che la apre già (con `credentials.share`,
  o un full admin) conferma che la sua chiave è davvero la sua. Nessun
  percorso lo fa da sé, nemmeno «perché è un admin» e mai per la PROPRIA chiave
  (è proprio ciò che un login rubato vorrebbe fare). Unica eccezione, regola
  **V1**: la chiave di persona è `confirmed` all'atto della creazione SOLO se
  nell'istanza nessuna chiave è MAI stata confermata (`confirmed_at` non
  nullo, qualunque sia il suo stato oggi) **E** chi la crea è il full admin
  che ha attivato la cassaforte — che nessun altro potrebbe confermare. Ogni
  altra chiave, di admin compresi (anche quella ricreata da chi ha attivato),
  nasce `pending`. La conferma imposta SEMPRE `confirmed_at`: è su quella
  colonna che V1 si regge. Ricreare la chiave di una persona rende inutili le
  copie vecchie (si cancellano), e tutte le sue credenziali tornano «in
  attesa».
- **Nessuno conferma «a vuoto» (review finale).** Confermare una chiave
  vuole ALMENO una copia salvata nella stessa conferma, per chiunque e per
  ogni via — normale o col kit, full admin compresi (`nothing_to_confirm`,
  nessuna scrittura). Prima un full admin poteva confermare con `copies: []`:
  una chiave fantoccio confermata così riceveva poi ogni password nuova o
  cambiata. Una chiave che non ha niente da ricevere resta in attesa finché
  una credenziale non la raggiunge, e allora compare nell'elenco di quella
  credenziale: non è un vicolo cieco. La web non manda la conferma se nessuna
  copia si è aperta nel browser, e lo dice.
- **Chi passa o toglie l'accesso PROVA di avere la sua chiave aperta (review
  finale).** Conferma, rifiuto, condivisione (`POST .../readers`), revoca di
  un lettore (`DELETE .../readers/:readerId`, la prova nel corpo) e rotazione
  del kit vogliono `actorProof`: il server cifra un segreto casuale per la
  pubblica della chiave CONFERMATA di chi chiede (`POST
  /api/vault/actor-challenge`, `wrapActorChallenge`, AAD
  `actor-challenge:<id>:<personKeyId>`), ne tiene solo l'hash in
  `vault_recovery_challenges` (`kind = 'actor'`, `person_key_id`), legato a
  utente, sessione e chiave, 5 minuti, uso singolo; il browser lo apre con la
  privata in memoria. Senza prova valida — mancante, inventata, scaduta, già
  usata, di un'altra sessione, di un'altra persona, per una chiave nel
  frattempo ricreata — 403 `vault_proof_invalid` e nulla cambia. Il motivo: il
  server non può verificare le copie che riceve (sono buste opache), quindi
  un login rubato con `credentials.share`, o di un full admin, potrebbe
  altrimenti condividere con un complice o confermare un fantoccio mandando
  copie spazzatura. Le due specie di sfida (kit e chiave) non si scambiano:
  una prova vale solo per la sua `kind`. La prova è una per azione: chi
  riprova dopo un 409 ne chiede un'altra.
- **Chi crea o cambia una password ripete la chiave pubblica di recupero, e il
  server la confronta (`recipients_changed`).** Il corpo di creazione e di `PUT
  password` porta `recoveryPublicKey`, quella del GET dei destinatari. Il
  bloccaggio di `vault_settings` in condivisione non basterebbe: la copia
  `recovery` ha `recipientId` `"recovery"` sia per la chiave vecchia sia per la
  nuova, quindi una copia avvolta per il kit SUPERATO sembrerebbe valida. Con
  l'eco e con l'insieme dei destinatari (persone con chiave confermata) non
  aggiornato il server risponde 409 `recipients_changed` coi destinatari
  attuali e NON scrive nulla. La rigenerazione del kit blocca `vault_settings`
  in esclusiva, creazione e cambio password in condivisione.
- **Ogni copia porta una `keyVersion`.** È `md5(password_ciphertext)`: dice a
  quale versione della password appartiene la chiave. Una condivisione o una
  conferma preparate sulla password di ieri trovano il 409 (condivisione) o
  vengono saltate con `skipped: key_changed` (conferma): mai una copia di una
  chiave che non apre più la password attuale. Un cambio di password avvolge
  la chiave nuova per ogni lettore effettivo con chiave CONFERMATA, anche chi
  aspettava questa credenziale: la conferma umana garantisce la CHIAVE (è
  davvero quella persona), e la lista dei lettori è l'ACL decisa da chi
  condivide.
- **La revoca si applica a lettura, e poi si ripulisce.** Un lettore di un ruolo
  tolto dal progetto, o uscito dal progetto, perde la lettura SUBITO (`reveal`
  → 404, come una credenziale che non esiste) anche con la sua copia ancora in
  DB: la condizione dei lettori effettivi (`effectiveReaderCondition`,
  `readableNowCondition` in `vault/readers.ts`) si valuta a ogni richiesta, in
  linea con `docs/invariants/permissions.md`. La purga delle copie
  (`purgeStaleCopies`) è igiene e difesa in profondità, non il meccanismo:
  toglierla non riaprirebbe nulla. I full admin sono lettori impliciti di ogni
  credenziale. Una copia già scaricata nel browser di chi è stato revocato non
  si può richiamare: cambiare la password è l'unico rimedio (limite accettato).
- **Il recupero chiede la PROVA di possesso del kit.** Le rotte di recupero
  (`/api/vault/recovery/*`) sono dei soli full admin, con riconferma recente, e
  chiedono una sfida: il server genera un segreto casuale, lo avvolge con
  `@stubwise/vault-crypto` per la chiave pubblica di recupero, tiene solo un
  hash (`vault_recovery_challenges`, TTL breve, monouso), e il browser lo apre
  col kit e lo riporta. Senza prova valida: 403. È ciò che rende vero «col kit
  si rientra»: un login admin rubato non basta, il kit non arriva mai al
  server. Ogni uso finisce nel registro di sicurezza e avvisa gli altri full
  admin. Serve una sfida nuova prima di ogni conferma di recupero. Il recupero
  resta l'unica uscita di un'istanza con un solo admin che ha perso le passkey.
- **Rigenerare il kit vuole la propria chiave, TUTTE le copie, e lascia
  traccia.** `POST /api/vault/recovery-key` (full admin, riconferma) vuole
  la prova della propria chiave (sopra) e la copia di recupero di OGNI
  credenziale, altrimenti 409 `recipients_changed`; la web la prepara da
  `GET /api/vault/recovery-key/preview` (le proprie copie, senza password
  cifrate) e si ferma elencando le credenziali di cui chi ruota non ha la
  copia. Ogni rotazione scrive `vault_recovery_key_rotated` nel registro di
  sicurezza e avvisa gli altri full admin: il kit vecchio smette di valere.
  Anche l'attivazione (`vault_activated`) e la SOSTITUZIONE di un sigillo
  esistente (`vault_seal_replaced`) finiscono nel registro.
- **Il sigillo della privata è legato alla sua pubblica.** AAD del sigillo:
  `stubwise/vault/v1/seal:` ‖ SHA-256(punto pubblico non compresso), e
  `sealPrivateKey`/`openPrivateKey`/`resealPrivateKey` prendono la pubblica e
  verificano che sia la metà della privata. Se il server presentasse
  un'altra pubblica accanto al sigillo, il browser non apre nulla
  (`open_failed`) invece di mostrare un'impronta falsa o cifrare per una
  chiave d'altri. La pubblica così verificata resta in memoria con la
  privata: da lì la web calcola l'impronta che la persona vede della PROPRIA
  chiave (avviso della chiave in attesa, Impostazioni → Sicurezza), da
  confrontare con quella che vede chi conferma.
- **Decisione: l'HKDF delle copie non lega la pubblica del destinatario, ed
  è accettato.** Il wrapping (ECDH effimera-statica → HKDF con salt = la
  pubblica effimera) non mette la pubblica del destinatario nell'`info`.
  Basta così: l'AAD lega ogni copia a `credentialId:recipientId`, ogni copia
  ha una coppia effimera NUOVA, e l'import P-256 di WebCrypto valida il
  punto. Non si cambia il formato senza un motivo nuovo.
- **`reveal` legge la credenziale in condivisione (`FOR SHARE`).** Un cambio
  di password in corso (riga in esclusiva) finisce prima: password cifrata e
  copia restituite sono della STESSA chiave. La web non mostra né copia una
  password che arriva dopo che la cassaforte si è chiusa.
- **Lo sblocco è la riautenticazione con passkey, con PRF.** Non esiste un
  secondo meccanismo: lo sblocco usa `/api/me/security/reauth/passkey/*`
  (`purpose: "vault"` aggiunge la valutazione PRF) e quindi rinnova anche
  `secondFactorAt`. `PRF_INPUT` vive in UN posto, `@stubwise/vault-crypto`; il
  server lo importa (passkey) e non ne ha una copia. Una passkey senza PRF non
  apre la cassaforte, e la web lo dice invece di creare chiavi inutilizzabili.
- **ISOLAMENTO: le tabelle della cassaforte non le legge nessuno fuori dalle
  sue rotte.** Non le leggono worker, ricerca, embedding, chat RAG e grafo,
  MCP, Slack, notifiche (salvo gli avvisi di sicurezza di `vault/alerts.ts`,
  che non portano campi delle credenziali), webhook, né i prompt dell'agente.
  `apps/server/src/vault/vault-isolation.test.ts` lo verifica su due piani: **sul
  sorgente** — un elenco ESPLICITO di aree vietate (worker, MCP, embeddings,
  docs-engine, notifications, google, sdk, agent, git, widget, e nel server
  graph-chat, slack, ingest, backlog, services, storage, scripts, più le rotte
  di ricerca/chat/inbox/inbound) che non devono nominare le tabelle né importare
  il modulo — e un elenco CHIUSO di chi può nominarle o importare
  `apps/server/src/vault`: `routes/vault.ts` e `routes/credentials.ts`
  (`app.ts` monta le rotte, non importa il modulo). Le aree vietate non
  possono sparire in silenzio: se una cartella non esiste più il test fallisce.
  **A runtime** — una credenziale esistente non compare in `GET /api/search` né
  nella cronologia, e un errore di validazione di una rotta non riporta i
  valori del corpo. Chi ha bisogno che una nuova parte del server legga le
  credenziali non allarga l'elenco per far passare il test: è un cambio di
  prodotto (anti-obiettivo del design).
- **Le credenziali non servono all'automazione.** Nessun tool MCP, nessun run
  dell'agente, nessuna chat AI, nessun job del worker ne vede una riga. Il
  worker non monta né nomina queste tabelle (nel rilascio non c'entra).

## Limiti accettati

- **Server compromesso mentre lo si usa**: chi lo controlla in quel momento può
  servire una web modificata che ruba ciò che si sblocca, dare allo script una
  chiave pubblica falsa o aggiungere un lettore finto che il browser
  completerebbe. La cifratura end-to-end protegge dal furto di dati (VPS
  spento, database, backup), non da un server attivamente compromesso: è il
  limite di ogni cassaforte web.
- I campi in chiaro (servizio, utente, URL, note) sono leggibili da chi ha il
  database e finiscono in backup e WAL.
- Password perse per costruzione solo se tutti i lettori, tutti gli admin e il
  kit di recupero sono persi.
- Una password già mostrata a un lettore poi revocato non si «dimentica»:
  si cambia la password.
- **Cambiare il dominio (`PUBLIC_URL`) rende inutilizzabili tutte le passkey**,
  quindi nessuno apre più la cassaforte con la sua: si rientra col kit, ognuno
  ricrea la chiave e gli accessi si riconfermano. Va scritto nella voce di
  deploy e nella guida.
