# Invarianti e trappole — Cassaforte delle credenziali (23 ott 2026)

> Design: `docs/plans/2026-10-23-cassaforte-credenziali-design.md`. Codice:
> `apps/server/src/vault/`, `apps/server/src/routes/{vault,credentials}.ts`,
> `packages/vault-crypto` (le primitive, usate dal browser e dal server solo per
> `PRF_INPUT` e per le sfide di possesso: del kit e della propria chiave). Tabelle: `vault_settings`,
> `vault_person_keys`, `vault_person_key_seals`, `vault_recovery_challenges`,
> `credentials`, `credential_readers`, `credential_key_copies`,
> `credential_access_log`, e dal lotto 10 (24 nov 2026, la cassaforte dal
> desktop, design `docs/plans/2026-11-24-cassaforte-desktop-design.md`)
> `vault_device_pairings`, `vault_device_seals` (`apps/server/src/vault/device-seals.ts`).

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
  /api/credentials/:id/reveal` è la sola che porta `passwordCiphertext`, da
  sessione o dal PAT desktop col sigillo vivo, e scrive il registro
  (`credential_access_log`, «mostra» o «copia», con `via` `browser` o
  `desktop` e il sigillo del Mac, D-8) nella stessa transazione. L'anteprima di una condivisione e gli
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
  **Il PAT desktop riconfermato** (10 nov 2026): il maintainer ha deciso
  che dal desktop si debba poter fare tutto quello che si fa dal browser,
  cassaforte compresa. Oggi però la regola qui sopra vale ANCHE per lui,
  perché il desktop non sa sbloccare la chiave: lo sblocco è una passkey con
  PRF (voce «Lo sblocco…» sotto), e dal desktop le passkey non ci sono.
  **Dal lotto 10 (24 nov 2026) la frase è «… salvo il PAT desktop CON UN
  SIGILLO DEL MAC VIVO»** (voce «Il sigillo del dispositivo» sotto): sulle
  SOLE rotte che dichiarano `config.desktopVault` — `reveal`, la sfida della
  propria chiave, gli accessi in attesa (elenco, conferma, rifiuto) e i
  lettori (elenco, anteprima, condivisione, revoca), e dal 25 nov 2026 (D-9)
  l'elenco dei propri Mac e la rimozione di un ALTRO proprio Mac — il PAT desktop passa se
  ha un sigillo vivo legato a lui (D-7: tutto come il browser a cassaforte
  aperta). L'elenco è chiuso in `route-access.test.ts`, e solo la rimozione
  di un Mac chiede anche la riconferma (dal desktop, `desktop-reauth`); il controllo sta in UN posto,
  `vault/device-access.ts` (`requireVaultCaller`). La riconferma del desktop
  (`desktop-reauth`) NON apre la cassaforte: senza sigillo il desktop riceve
  403 `device_seal_required`. Restano del browser, anche col sigillo:
  attivare, il recupero col kit, rigenerare il kit, creare o ricreare una
  chiave di persona e i suoi sigilli, associare un Mac (`vaultRoutes`
  dichiara `config.browserOnly` su ogni altra rotta). La sfida della propria
  chiave chiesta dal Mac è legata al SUO PAT (`pat_id`, non la sessione): non
  vale dal browser né da un altro Mac, e viceversa. Gli altri PAT (`manual`,
  `mobile`) restano come sono. **Una sola lettura passa dal PAT desktop
  ANCHE SENZA sigillo** (25 nov 2026, `config.desktopRead`, elenco chiuso in
  `route-access.test.ts`): `GET /api/vault/status`, perché il Mac deve dire
  «nessuna chiave» o «la tua chiave aspetta conferma» proprio prima di
  essere associato. Al Mac la risposta ridotta — attiva o no, la propria
  chiave (id, stato, data, pubblica per l'impronta), sigilli e passkey vuoti
  —, nessuna busta; con l'interruttore spento 404 `vault_desktop_disabled`.
  **E sopra tutto l'interruttore d'istanza
  `VAULT_DESKTOP`** (decisione di 46, 25 nov 2026, SPENTO di default, si
  accende solo con l'app desktop firmata): spento, il PAT desktop riceve 404
  `vault_desktop_disabled` (review M2: un codice suo, mai il `not_found` di una
  credenziale cancellata) sulle rotte `desktopVault` e su quelle del sigillo del Mac
  (`/device-pairings`, `/device-seals/mine`) e sullo stato, come se non ci fossero; le rotte
  del browser restano. È una scelta di DEPLOY, non un'attestazione del
  client (review 2, M7): il server non verifica che chi chiama sia l'app
  firmata. Il controllo sta negli stessi due punti
  (`vault/device-access.ts` e `desktopOnly` in `routes/vault.ts`).
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
- **Il sigillo del dispositivo (lotto 10, 24 nov 2026): una COPIA della
  chiave di persona per un Mac, che nasce solo da uno sblocco con passkey.**
  Il main del desktop fa generare una coppia P-256 al Secure Enclave
  (review I1, decisione di 46 del 25 nov 2026: una voce del Keychain di data
  protection con l'access group del Team ID, accesso `privateKeyUsage` +
  `biometryCurrentSet`; la privata non esce dall'enclave, che fa l'ECDH via
  `deriveBits`, e su disco restano solo id e pubblica) e chiede l'associazione
  COL SUO PAT desktop E la sua riconferma recente (`POST
  /api/vault/device-pairings`, review I2: un PAT da solo non basta; la
  riconferma è DICHIARATA sulla rotta, `config.reauth`, review 2 M4, e la
  rotta è `config.desktopOnly`, elenco chiuso in `route-access.test.ts`; solo
  l'hash dello state, 10 minuti, uso singolo, legata a QUEL PAT e a QUELLA
  pubblica). Il browser vede da quando esiste quel login e il suo ultimo uso. Il
  browser la legge per state (`/lookup`, lo state nel corpo, mai nei log), la
  persona scrive nel browser il codice che il Mac mostra (gli ultimi 4 caratteri della sua impronta) — la pagina NON mostra l'impronta,
  che altrimenti si copierebbe da lei (review 2, M3) — e con la passkey
  (riconferma recente, PRF) e la prova della propria chiave confermata
  (`actorProof`) sigilla la privata di persona per la pubblica del Mac
  (`sealForDevice`, `@stubwise/vault-crypto`: la privata in chiaro non esce
  dal package; AAD `stubwise/vault/v1/device-seal:<personKeyId>:<deviceId>:`
  ‖ SHA-256 della pubblica di persona). PAT e pubblica del Mac li prende il
  server dall'associazione, mai dal corpo; la chiave sigillata è quella
  CONFERMATA attuale, scelta dal server. Il server non apre il sigillo (busta
  opaca). **Nessun PAT associa un Mac** (la rotta del sigillo vuole la
  sessione), e un Mac non ne associa un altro. **La revoca vale a lettura**:
  il sigillo serve solo se non è revocato, se è legato al PAT che chiede e se
  la sua chiave di persona è ANCORA quella confermata (una chiave ricreata o
  rifiutata lo spegne senza riscrivere la riga); un PAT revocato lo porta via
  in cascata. **Togliere un Mac toglie il SOLO sigillo, non il PAT** (D-5,
  decisione del maintainer): dal desktop («Dimentica questo Mac», logout; e
  dal 25 nov 2026, D-9, anche gli ALTRI propri Mac, col sigillo vivo, la
  riconferma del desktop E la prova della propria chiave — limite accettato: un Mac rubato e sbloccato può
  staccare gli altri), dal browser (riconferma), o da un full admin per un'altra persona (D-6,
  riconferma, registro con l'attore, avviso alla persona). Ogni sigillo e
  ogni revoca finiscono nel registro di sicurezza (`vault_device_sealed`,
  `vault_device_seal_revoked`) e avvisano la persona. Test:
  `apps/server/src/routes/vault-device.test.ts` (negativi prima).
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
- **Lo sblocco è la riautenticazione con passkey, con PRF.** Dal lotto 10
  esiste UN secondo meccanismo, il sigillo del Mac, e nasce SOLO da uno
  sblocco con passkey nel browser: non è un'altra porta, è una copia della
  stessa chiave avvolta per un dispositivo che la persona ha scelto e
  riconosciuto scrivendo il codice che il Mac mostra (voce sotto). Per il resto: lo sblocco usa `/api/me/security/reauth/passkey/*`
  (`purpose: "vault"` aggiunge la valutazione PRF) e **NON rinnova
  `secondFactorAt`** (indurimento del 27 nov 2026, I6): apre solo
  `sessions.vault_unlocked_at`, che vale per le rotte della cassaforte che
  dichiarano `config.reauth: "vault"` (voce «Modello di minaccia» sotto). `PRF_INPUT` vive in UN posto, `@stubwise/vault-crypto`; il
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

- **Modello di minaccia del browser (indurimento del 27 nov 2026).** La
  chiave privata di una persona si apre NEL BROWSER, con il segreto PRF della
  sua passkey. Quindi **un XSS più un tocco della passkey vale il furto
  permanente della chiave**: lo script che gira nella pagina riceve il
  segreto PRF come la web, apre la privata e può portarla fuori. Da lì ogni
  copia avvolta per quella chiave si apre fuori da Stubwise, per sempre,
  finché la chiave non viene ricreata. Nessuna regola del server lo impedisce
  dopo il fatto: si difende **prima** (niente script estranei nella pagina) e
  si **limita e si vede** il danno. Le difese, e dove stanno:
  - **CSP dell'origine** (C1/M1): header di Caddy su `/`, `/app` e `/guide`,
    `script-src 'self'` senza `unsafe-inline` né `unsafe-eval`, più
    `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'` e
    `connect-src 'self'`. `connect-src` chiude solo `fetch`, XHR, WebSocket e
    EventSource verso altri host: uno script che gira nella pagina ha ancora
    immagini, navigazioni e form verso fuori per portare via un segreto. La
    difesa vera è `script-src`, cioè che uno script estraneo non giri. La guida ammette per hash solo gli script inline
    di Starlight. Il build di caddy fallisce se il web o l'app hanno uno
    script inline (`scripts/caddy-csp.mjs`, test in CI). Su `/app` anche COOP
    `same-origin` e `index.html` `no-store`. Chi aggiunge uno script inline,
    o un `eval`, rompe la pagina in produzione, non solo una regola: la
    strada è un file `.js` servito dall'origine.
  - **Lo sblocco non è una riconferma** (I6): un tocco della passkey per «aprire
    la cassaforte» non apre per 10 minuti le rotte sensibili (registrare una
    passkey, creare un PAT, le azioni di Claude con riconferma). Lo scopo lo
    salva il SERVER sulla challenge che emette (`purpose: "vault"`), mai il
    client alla verifica. **Non ferma un XSS**: lo script può chiedere da sé
    una riconferma piena (opzioni senza scopo) e ottenerla con un tocco della
    passkey, come la web. I6 chiude il riuso ACCIDENTALE dello sblocco,
    cioè le rotte sensibili aperte senza un gesto apposta, non un attaccante
    che la pagina la controlla.
  - **Una passkey in più che apre la cassaforte non è silenziosa** (I7): ogni
    sigillo nuovo (`vault_seal_added`) o sostituito (`vault_seal_replaced`)
    lascia la sua riga e un `security.alert` alla persona.
  - **Una raffica di letture ha un tetto e un avviso** (C2, `REVEAL_BURST` in
    `apps/server/src/vault/credentials-service.ts`): contati sul registro
    delle letture, come segreti DISTINTI della stessa persona in 10 minuti.
    Al 10° un avviso alla persona e agli altri full admin
    (`vault_reveal_burst`). Oltre il 20° un segreto nuovo risponde 429
    `vault_reveal_rate_limited`, senza riga, con `Retry-After` (anche nel
    corpo, `retryAfterSeconds`): il tempo prima che esca dalla finestra il
    segreto la cui ultima lettura è la più vecchia. Il tetto non ferma chi ha
    già la privata e i ciphertext: ferma lo svuotamento via `reveal` e lo rende
    visibile. **L'avviso si può ripetere**: scatta alla lettura che porta il
    conteggio dei segreti distinti da 9 a 10, quindi se il conteggio scende
    sotto la soglia (letture uscite dalla finestra) e risale, ne arriva un
    altro. Accettato: ogni avviso corrisponde a una risalita vera.
  - **Scritture col cookie solo dalla stessa origine** (M5,
    `apps/server/src/auth/same-origin.ts`): `Sec-Fetch-Site` same-origin
    (o `Origin` con lo stesso host), altrimenti 403 `cross_origin_request`;
    copre l'altro sottodominio dello stesso sito, che `SameSite=Lax` non
    ferma. Il PAT non è toccato.
  Rimandati, e perché: **Trusted Types** su `/app`. Il renderer usa
  `dangerouslySetInnerHTML` in cinque punti (riconferma, configurazione
  del secondo fattore, sicurezza, blocchi wireframe, stampa), e accenderli
  vuole prima una policy per ognuno.
- **Procedura d'incidente: «la chiave di una persona potrebbe essere uscita».**
  Si parte da un avviso `vault_reveal_burst` o `vault_seal_added` che la
  persona non riconosce, o da un XSS sospetto. In quest'ordine:
  1. **Fermare l'accesso.** Si disattiva la persona (Utenti → Disattiva, con
     `users.manage`): cancella sessioni e PAT. Se è un falso allarme si
     riattiva, e la persona crea token nuovi.
  2. **Vedere cosa è stato letto.** Il registro delle letture dei progetti
     della persona dice quali segreti e quando:
     `select credential_snapshot, action, via, created_at from
     credential_access_log where user_id = '<id>' order by created_at desc;`.
     Il registro di sicurezza dice sigilli, passkey e Mac:
     `select kind, detail, created_at from security_events where user_id =
     '<id>' order by created_at desc;`.
  3. **Togliere ciò che apre la chiave.** Si tolgono le passkey che la
     persona non riconosce e i Mac associati (Impostazioni → Sicurezza, o
     da un admin).
  4. **Considerare la chiave persa.** Una chiave uscita resta aperta per chi
     l'ha presa: non si «revoca», si sostituisce. La persona ricrea la sua
     chiave (la vecchia diventa `superseded` e le sue copie spariscono, vedi
     sopra) e un admin la riconferma.
  5. **Cambiare le password.** Si cambiano TUTTE le password delle
     credenziali che la persona poteva leggere, non solo quelle nel registro
     delle letture: chi ha la privata e un dump del database apre ogni copia
     avvolta per lei senza passare da `reveal`. Una password cambiata
     rigenera ciphertext e copie per i lettori attuali.
  6. **Se il sospetto è un XSS**, la causa va chiusa prima di riattivare
     chiunque. Lo stesso script avrebbe lavorato per ogni persona che ha
     aperto la cassaforte in quella pagina: i passi 2–5 vanno ripetuti per
     ciascuna.

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
