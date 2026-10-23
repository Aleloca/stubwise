# Secondo fattore sul login — design

Data: 23 ott 2026. Secondo di tre progetti in sequenza: (1) appartenenza e
permessi (rilasciato il 23 ott 2026), (2) secondo fattore sul login, (3)
cassaforte delle credenziali cifrata nel browser. Questo documento copre il
(2); la cassaforte lo presuppone.

## Perché

Oggi per entrare in Stubwise basta una password: un account rubato — e
quello di un admin vale tutto — è un accesso pieno. Con la cassaforte delle
credenziali in arrivo il danno cambia natura (le password dei servizi dei
clienti valgono più del resto di Stubwise), e il secondo fattore ne è il
prerequisito dichiarato. La cassaforte chiederà anche una **riconferma
recente** prima di mostrare una password: questo progetto la costruisce, e
la usa già sulle azioni sensibili che esistono oggi.

## Obiettivi

- **Ogni** login chiede un secondo fattore, per tutti gli utenti, senza
  eccezioni per ruolo.
- Fattori accettati:
  - **codice TOTP** a 6 cifre da un'app di autenticazione — la base, lo
    configura ognuno;
  - **passkey** (WebAuthn: Face ID, Touch ID, chiave fisica) — in più, per
    chi la vuole;
  - **codice di riserva** monouso — per l'emergenza.
- **Riconferma recente**: un meccanismo generale «questa azione vuole un
  secondo fattore usato da poco», usato subito sulle azioni sensibili e
  riusato così com'è dalla cassaforte.
- **Recupero** senza restare chiusi fuori: codici di riserva, reset da chi
  gestisce gli utenti, comando sul server per l'ultimo admin.

## Non obiettivi

- SMS o email come secondo fattore.
- «Ricorda questo dispositivo»: la sessione web dura già 30 giorni
  (`SESSION_TTL_MS`), e il secondo fattore si chiede al login.
- Login **solo** con passkey (senza password).
- Passkey nell'app mobile (vedi «App mobile»).
- Secondo fattore sui token personali esistenti, sul widget pubblico, sugli
  agenti di monitoraggio e sui webhook: sono credenziali di macchina.
- 2FA disattivabile dall'utente: è obbligatorio.

## Anti-obiettivi (fallimento anche se «funziona»)

- **Una porta che dà una sessione o un token senza secondo fattore**:
  `/login`, `/mobile-login`, l'accettazione di un invito, il primo setup,
  il reset della password. Oggi le porte sono queste; una nuova va coperta
  per costruzione, non per memoria (come il registro di `config.access`).
- **Una sessione «a metà»** (password giusta, secondo fattore non ancora
  dato o non ancora configurato) che apre una qualunque rotta diversa da
  quelle del secondo fattore.
- Il rilascio che chiude fuori qualcuno senza via d'uscita, admin compreso.
- Il segreto TOTP o i codici di riserva leggibili dal DB o da un backup
  senza la chiave, o presenti in un log.
- Un admin che, azzerando il 2FA di un altro, ne prende il posto senza
  lasciare traccia o scavalcando la protezione del bersaglio.

## Il flusso

### Login (web)

1. Email e password, come oggi (stesso rate limit, stesso messaggio
   d'errore indistinguibile).
2. Password giusta → il server **non** apre ancora la sessione completa:
   risponde «serve il secondo fattore» con lo stato dell'utente (già
   configurato o no). Lo stato intermedio vive in una **sessione parziale**
   (cookie a sé, durata breve: 10 minuti, *mia scelta*) che apre solo le
   rotte del secondo fattore.
3. Utente **con** 2FA configurato → schermata «codice dell'app», con
   «usa una passkey» se ne ha registrate e «usa un codice di riserva».
4. Utente **senza** 2FA (tutti, la prima volta dopo il rilascio) →
   **configurazione obbligatoria**: QR code (con il segreto anche in testo
   per l'inserimento a mano), conferma con un primo codice, poi i **10
   codici di riserva** mostrati una sola volta con «scarica» e «ho salvato i
   codici». Solo allora la sessione diventa completa.
5. Codici sbagliati: contano nello **stesso bucket** di rate limit delle
   credenziali (`credentialsRateLimit`, per IP), **e** c'è un tetto **per
   account** (*mia scelta*, dalla review del design): il bucket per IP da
   solo non ferma chi ha la password e prova i codici da molti IP. Dopo 5
   codici sbagliati di fila sull'account, il passo del secondo fattore si
   blocca per 15 minuti, con un avviso alla persona (vedi «Avvisi»). Il
   blocco tocca solo i login NUOVI: sessioni e token già aperti continuano,
   così un attaccante non può chiudere fuori qualcuno che è già dentro.
   Un codice TOTP già usato non vale una seconda volta (anti-replay).

### Le altre porte

- **Accettazione di un invito** (`/register`) e **primo setup
  dell'istanza** (`/setup`): oggi non aprono una sessione, rimandano al
  login. Il secondo fattore si configura lì, al primo login, come per tutti
  (*mia scelta*). Se un giorno una delle due aprisse una sessione, deve
  passare dallo stesso stato parziale.
- **Reset della password** (link monouso): reimposta solo la password; il
  login successivo chiede il secondo fattore come sempre (*mia scelta*). Il
  reset chiude già tutte le sessioni.
- **App mobile** (`/mobile-login`): stesso schema, vedi sotto.

### App mobile

`/mobile-login` oggi crea un **token personale senza scadenza**
(`createPatForUser`, label `Mobile · <device>`). Diventa: password → secondo
fattore (codice TOTP o di riserva) → token. Se l'utente non ha ancora il 2FA,
l'app lo dice e manda alla web per configurarlo (*mia scelta*: la
configurazione con QR si fa dal computer; l'app non deve inquadrare un QR
che sta sul suo stesso schermo). Passkey nell'app: non in questa fase (*mia
scelta*: richiede librerie native nell'app bare, e il codice basta).

L'app è a utente singolo e fuori dagli store (memoria del maintainer): può
richiedere un aggiornamento insieme al server, senza compatibilità con
versioni vecchie.

### Token personali e MCP

- I token **esistenti** restano validi (decisione del maintainer: nessuno
  viene buttato fuori). Chi vuole fare pulizia li revoca dalle impostazioni.
- I token **nuovi** si creano solo da una sessione completa (quindi già con
  secondo fattore) **e** con riconferma recente.
- Una richiesta con token non chiede mai il secondo fattore.

### Sessioni esistenti al rilascio

Restano valide fino alla scadenza (decisione del maintainer). Al login
successivo scatta la configurazione obbligatoria.

## Riconferma recente

- Ogni sessione completa ricorda **quando** è stato usato l'ultima volta un
  secondo fattore (login o riconferma).
- **Sessioni di prima del rilascio** (valide fino a 30 giorni, utente senza
  2FA): non hanno quella data, e l'utente non ha un fattore con cui
  riconfermare. Un'azione sensibile allora apre la **configurazione
  obbligatoria** del 2FA (la stessa del primo login) al posto del dialogo di
  riconferma; finita la configurazione, la sessione conta come riconfermata
  e l'azione riparte (*mia scelta*, dalla review del design: altrimenti un
  admin non potrebbe cambiare un ruolo fino al login successivo).
- Un'azione sensibile dichiara di volerla: se l'ultimo uso è più vecchio di
  **10 minuti** (*mia scelta*), il server risponde con un errore dedicato
  (es. 403 `reauth_required`) e la web apre un dialogo «conferma con codice
  o passkey», poi ripete l'azione.
- Si dichiara nella rotta, accanto a `config.access` (es. un campo
  `reauth: true`), e un test del registro elenca le rotte che la chiedono —
  stessa filosofia di `config.access`: dichiarata, non ricordata.
- Le richieste con token personale non possono soddisfarla: un'azione
  sensibile via token risponde 403 (*mia scelta*: un token rubato non deve
  poter creare altri token o cambiare ruoli).
- **Azioni che la chiedono da subito** (decisione del maintainer):
  - creare un token personale;
  - cambiare la propria password;
  - gestire il proprio 2FA: aggiungere/togliere passkey, rigenerare i codici
    di riserva, riconfigurare l'app;
  - azzerare il 2FA di un altro utente;
  - cambiare ruoli e permessi: creare/modificare/eliminare un ruolo,
    cambiare il ruolo d'istanza di qualcuno, aggiungere/togliere membri o
    cambiarne il ruolo in un progetto;
  - generare il link di reset della password di un altro;
  - collegare o scollegare l'identità Slack di un utente (`PUT
    /users/:id/slack`) e le identità git: Slack risponde alle domande e
    agisce sui piani a nome della persona, senza secondo fattore (*mia
    scelta*, dalla review del design).
- Nell'app mobile le azioni sensibili oggi non ci sono; se una rotta
  sensibile viene chiamata dall'app con il suo token, vale la regola dei
  token (403).

## Impostazioni → Sicurezza (per ogni utente)

- Stato: app configurata (data), passkey registrate (nome, data, ultimo
  uso), codici di riserva rimasti (numero, non i codici).
- Aggiungere una passkey (con un nome), rinominarla, toglierla.
- Rigenerare i codici di riserva (invalida i precedenti, mostra i nuovi una
  volta).
- Riconfigurare l'app (nuovo segreto, conferma con un codice dalla nuova).
- Non c'è «disattiva 2FA».

## Recupero

- **Codici di riserva**: 10, monouso, generati alla configurazione e
  rigenerabili. Usarne uno vale come secondo fattore al login (e come
  riconferma). Quando ne restano pochi (≤ 3, *mia scelta*) la web lo
  segnala.
- **Reset da chi gestisce gli utenti**: chi ha il permesso d'istanza di
  gestione utenti (`users.manage`) azzera il 2FA di un altro — app, passkey
  e codici — con le **protezioni già esistenti sul bersaglio**
  (`target_above`: non si agisce su chi ha più permessi). Chiede la
  riconferma. Chiude tutte le sessioni della persona; i suoi token restano
  (*mia scelta*, coerente con «i token restano»). Al login successivo la
  persona riconfigura. L'azione resta registrata (vedi «Registro di
  sicurezza»).
- **Un admin che prende l'account di un pari grado** (link di reset della
  password + azzeramento del 2FA sulla stessa persona: `target_above` ferma
  solo chi ha PIÙ permessi): **accettato** (decisione del maintainer). Le
  due azioni restano libere; ciascuna è registrata e la persona riceve un
  avviso **fuori dalla web** (vedi «Avvisi»).
- **Ultimo admin chiuso fuori**: un comando sul server, nello stile degli
  script esistenti (`apps/server/scripts/`), che azzera il 2FA di un utente
  per email. Documentato nella voce di deploy-log.

## Avvisi

- Alla persona, quando: il suo 2FA viene azzerato da un altro, un altro le
  genera un link di reset della password, viene aggiunta una passkey,
  vengono rigenerati i codici di riserva, scatta il blocco per codici
  sbagliati (*mia scelta* l'elenco: sono i momenti in cui un intruso si
  «installa» o ci prova).
- Canali (decisione del maintainer): **inbox + push sul telefono + DM
  Slack** se la persona è collegata. Push e Slack contano perché arrivano
  FUORI dalla web, che un intruso potrebbe controllare. Stubwise oggi non
  manda email, e questo progetto non la aggiunge. Limite accettato: chi non
  ha né app né Slack lo vede solo in inbox.
- L'avviso non si spegne dalle preferenze di notifica (*mia scelta*).
- È un `notification_kind` nuovo: vale la trappola del rollback nel
  `CLAUDE.md`.

## Registro di sicurezza

- Una tabella nuova, solo in aggiunta (*mia scelta*, dalla review del
  design: oggi non esiste un registro generale). Una riga per: login riuscito
  con secondo fattore, configurazione, passkey aggiunta/tolta, codici
  rigenerati, codice di riserva usato, blocco per codici sbagliati,
  azzeramento del 2FA da un altro, link di reset generato da un altro.
- Chi agisce e chi subisce si salvano come id **e** come email in testo:
  la riga resta leggibile anche se un utente viene eliminato (le colonne
  d'autore altrove sono `ON DELETE SET NULL`).
- Si legge in Impostazioni → Sicurezza (le proprie righe) e, per chi ha
  `users.manage`, nella scheda dell'utente. Conservazione: un anno (*mia
  scelta*).

## Dati e segreti

- Il **segreto TOTP** si conserva **cifrato** con la chiave d'istanza
  (`ENCRYPTION_KEY`, come i token dei provider); serve in chiaro solo per
  verificare un codice, sul server.
- I **codici di riserva** si conservano solo come **hash** (non servono mai
  in chiaro dopo la generazione).
- Le **passkey** si conservano come chiave pubblica + metadati (id
  credenziale, contatore, nome, date): niente di segreto.
- Nessuno di questi valori compare in log, risposte di elenco, ricerca,
  notifiche o webhook.

## Rilascio

- Migrazione: tabelle per fattori/passkey/codici, colonna dell'ultimo uso
  del secondo fattore sulla sessione, stato della sessione parziale.
- Ordine: server (con le migrazioni) e caddy **insieme** (la web nuova
  serve per la configurazione obbligatoria: un server nuovo con la web
  vecchia lascerebbe chi fa login senza la schermata del codice). Il worker
  non c'entra, salvo il `notification_kind` se la consegna degli avvisi
  passa da lì.
- App mobile da ricompilare insieme (utente singolo).
- Rollback: un server vecchio ignora le tabelle nuove e torna al login con
  la sola password; il `notification_kind` nuovo lo rende non sicuro finché
  ne esistono righe (trappola nota).

## Verifica

- Test negativi per **ogni porta**: password giusta senza secondo fattore
  non apre nessuna rotta oltre a quelle del secondo fattore; un test del
  registro elenca le rotte raggiungibili da una sessione parziale.
- Rate limit: tentativi di codice e di password nello stesso bucket.
- Anti-replay del codice TOTP.
- Riconferma: per ogni rotta dichiarata, scaduta → `reauth_required`,
  fresca → passa, via token → 403.
- Reset da admin con `target_above`.
- Tetto per account: 5 codici sbagliati da IP diversi → blocco del passo
  del secondo fattore, sessioni esistenti ancora valide.
- Sessione di prima del rilascio: un'azione sensibile porta alla
  configurazione, e dopo l'azione passa.
- Avvisi: push e DM Slack partono sugli eventi elencati.
- E2E Playwright del primo login con configurazione obbligatoria e del
  login con codice.

## Lasciato al builder

- Librerie per TOTP e WebAuthn (*mia indicazione*: quelle standard e
  mantenute dell'ecosistema Node, es. `otplib` e `@simplewebauthn`).
- Forma esatta delle tabelle e della sessione parziale.
- Testi e layout delle schermate, nello stile «terminal» della web.
- Il formato del file dei codici di riserva scaricato.
