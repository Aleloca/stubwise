# La Cassaforte dal desktop: la chiave del Mac (lotto 10)

*24 nov 2026. Scritto da 94 (main di Electron, §1–§5) e 72 (server,
protocollo e revoca remota, §6, §8–§10), su richiesta di 46. Prima di ogni codice:
lo porta 46 al maintainer.*

## 0. La decisione e cosa cambia

**Decisione del maintainer (24 nov 2026, via 46):** per aprire la cassaforte
dal desktop si usa la CHIAVE DEL MAC. Alla prima apertura dal browser (con la
passkey, PRF, come oggi) si sigilla una chiave nel portachiavi del Mac; da lì
il desktop si sblocca da solo.

**È un cambio d'invariante** (`docs/invariants/vault.md`):
- «Lo sblocco è la riautenticazione con passkey, con PRF. Non esiste un
  secondo meccanismo»: ne esiste un secondo, il sigillo del Mac, e nasce SOLO
  da uno sblocco con passkey nel browser (mai da sé, mai dal desktop);
- «Un token personale (PAT) crea e sostituisce, non legge»: diventa «… salvo
  il PAT desktop col suo sigillo del Mac» (la frase già prevista nella voce
  «Il PAT desktop riconfermato», 10 nov 2026). Gli altri PAT restano come sono;
- la privata di persona oggi vive solo nella memoria di una scheda del
  browser; dopo vive anche, sigillata, sul Mac, e aperta nella memoria del
  processo main del desktop.

Non cambia: il server non decifra mai niente; la conferma umana; la prova di
possesso (`actorProof`) per chi passa o toglie l'accesso; `reveal` come unica
uscita della password cifrata, col registro; l'isolamento.

## 1. Il modello: una chiave del dispositivo, non la privata in chiaro

Sul Mac non si salva la privata di persona. Si salva una **chiave del
dispositivo**, e il server tiene la privata di persona **sigillata per quella
chiave**.

- **Chiave del dispositivo**: una coppia P-256 (la stessa curva della
  cassaforte) generata nel MAIN alla prima associazione, con WebCrypto di
  Node (`globalThis.crypto.subtle`), estraibile solo per essere scritta
  sigillata da `safeStorage` (sotto). La pubblica va al server.
- **Sigillo del dispositivo**: nel browser, a cassaforte aperta con la
  passkey, la privata di persona si avvolge per la pubblica del dispositivo
  (ECDH effimera-statica → HKDF → AES-GCM, la forma delle copie di
  `wrapItemKey`, con un AAD suo: `stubwise/vault/v1/device-seal:` ‖
  personKeyId ‖ deviceId). Il server lo tiene come busta opaca (§6).
- **Sblocco dal desktop**: il main legge la privata del dispositivo dal
  portachiavi, scarica il sigillo del dispositivo, apre la privata di persona,
  verifica che sia la metà della pubblica di persona CONFERMATA (come
  `openPrivateKey`), e la tiene in memoria, non estraibile.

Perché così e non la privata di persona direttamente nel portachiavi:
- il server può **revocare** il Mac togliendo il sigillo (§8): la chiave del
  dispositivo da sola non apre niente;
- una chiave di persona RICREATA rende inutile il sigillo vecchio (AAD con
  `personKeyId`): il Mac non apre più la chiave sbagliata;
- il furto del solo `userData` (backup del Mac, Time Machine fuori dal
  portachiavi) non dà la privata di persona.

Primitive: la coppia del dispositivo e l'avvolgimento entrano in
`@stubwise/vault-crypto` (funzioni nuove, `wrapDeviceSeal`/`openDeviceSeal`,
con gli stessi test di formato delle altre buste); il main le usa da Node.

## 2. Dove sta la chiave sul Mac

- **`safeStorage`, non un modulo nativo del portachiavi.** È ciò che usa già
  la sessione (`session.bin`, `apps/desktop/src/main/session.ts`): su Mac la
  chiave di cifratura di `safeStorage` sta nel **portachiavi di login**
  dell'utente macOS (voce «Stubwise Safe Storage»), e il file cifrato in
  `userData`. Un file nuovo, `vault-device.bin`, accanto a `session.bin`:
  ```
  { v: 1, instanceUrl, userId, patId, deviceId, personKeyId,
    privateKey: <pkcs8 base64url> }
  ```
  Senza `safeStorage.isEncryptionAvailable()` non si associa: il desktop dice
  «Apri la cassaforte dal browser» (nessuna chiave in chiaro su disco, la
  stessa regola della sessione).
- **Secure Enclave: non ora.** Sarebbe la forma migliore (P-256 non
  estraibile), ma vuole un modulo nativo e un'app FIRMATA con i suoi
  entitlement; oggi `package:mac` fa un dmg non firmato. Da riprendere quando
  l'app sarà firmata (registro dei rimandi).
- **Cosa protegge, onestamente**: il disco rubato o il backup (il portachiavi
  è cifrato con la password di login). NON protegge da un programma ostile
  che gira come lo stesso utente macOS a Mac sbloccato: con un'app non
  firmata l'ACL della voce del portachiavi è debole. È lo stesso limite della
  sessione di oggi, e va scritto nei limiti accettati (§11).

## 3. Come la legge l'app (main e renderer)

**La privata non esce mai dal main**, come il token oggi.
- Il main apre la privata di persona e la tiene come `CryptoKey` non
  estraibile; il renderer non la vede.
- Il renderer chiede al main **operazioni**, per IPC, ognuna stretta
  (validata come `api:request`):
  - `vault:status` → `{ state: "unpaired" | "locked" | "open" | "revoked", fingerprint }`;
  - `vault:unlock` → apre (§1); nessun prompt (decisione: «si sblocca da
    solo»), vedi D-1;
  - `vault:reveal(credentialId, purpose)` → il main chiama `POST
    /api/credentials/:id/reveal` (il registro lo scrive il server), apre la
    copia e la password, e dà al renderer SOLO il testo della password;
  - `vault:proof(challengeId?)` → il main chiede e apre la sfida
    (`/api/vault/actor-challenge`) e la riporta col corpo della richiesta che
    la vuole (condividere, confermare, togliere un lettore): il renderer
    manda la richiesta, il main la firma;
  - `vault:wrap(credentialId, recipients)` → le copie per i lettori nuovi,
    fatte nel main.
- Le rotte della cassaforte passano SOLO da questi canali: `apiProxy` le
  rifiuta (`/api/vault/*`, `/api/credentials/*/reveal`), così un renderer
  compromesso non costruisce da sé richieste con la privata.
- **Chiusura in memoria**: la privata di persona si dimentica (resta il
  sigillo e la chiave del dispositivo) con «Chiudi la cassaforte», dopo
  15 minuti senza usarla, quando il Mac va in stop o si blocca lo schermo
  (`powerMonitor`: `suspend`, `lock-screen`), all'uscita. La riapertura è
  di nuovo automatica (D-1).

## 4. Più utenti sullo stesso Mac

- **Utenti macOS diversi**: separati dal sistema. `userData` e portachiavi
  sono per utente macOS: ognuno ha il suo `vault-device.bin` e la sua voce
  del portachiavi. Niente da fare.
- **Lo stesso utente macOS, un'altra persona di Stubwise o un'altra istanza**
  (logout e login di un altro, cambio d'istanza): il file porta
  `instanceUrl`, `userId` e `patId`, e si usa SOLO se coincidono con la
  sessione attuale. Al cambio:
  - `replaceToken` (login nuovo) e `logout` cancellano `vault-device.bin` e la
    privata in memoria, e chiedono al server di togliere il sigillo di quel
    dispositivo (best-effort, mai silenzioso, come la revoca del PAT);
  - un file che non coincide (residuo di un crash) si cancella alla lettura.
  Un solo dispositivo associato per volta per profilo dell'app: niente
  «portachiavi di più persone» nello stesso `userData`.
- **Lo stesso Stubwise con due Mac**: due dispositivi, due sigilli, ognuno
  revocabile da sé (§8).

## 5. La revoca locale

- **«Dimentica questo Mac»** (Impostazioni → Sicurezza, nel desktop):
  cancella `vault-device.bin` e la privata in memoria, e toglie il PROPRIO
  sigillo sul server; il login resta (anche dal browser togliere un Mac
  toglie solo il sigillo: §8, D-5). Se il server non risponde, il locale si
  cancella comunque e l'app lo dice: il sigillo resta finché non lo toglie il
  browser (§8).
- **Logout**: come sopra (§4), sempre.
- **Sigillo revocato dal server** (revoca remota, chiave di persona ricreata,
  PAT revocato): l'apertura risponde 404/403; il main cancella il file e la
  privata, lo stato diventa `revoked` e il desktop offre di riassociare dal
  browser.
- **Il PAT desktop revocato** (Impostazioni → token, dal browser) porta via
  con sé il sigillo (§8): il desktop torna al login.

## 6. Il server: il sigillo del dispositivo, il PAT desktop e la sua rotta (72)

### 6.1 Cosa tiene il server

Una tabella nuova, `vault_device_seals`:

| colonna | | |
|---|---|---|
| `id` | uuid | l'id del sigillo (`deviceId` nell'AAD) |
| `user_id` | fk `users`, cascata | di chi è |
| `person_key_id` | fk `vault_person_keys`, cascata | la chiave di persona sigillata (solo `confirmed`) |
| `pat_id` | fk `personal_access_tokens`, cascata | il PAT `desktop` a cui è legato |
| `device_public_key` | text | la pubblica P-256 del dispositivo (non compressa, base64url) |
| `seal` | text | la busta opaca `{ v: 1, … }`: la privata di persona avvolta per la pubblica del dispositivo, AAD `device-seal:` ‖ personKeyId ‖ deviceId |
| `device_name` | text | quello che dice il main («MacBook Pro di Ada»), solo per l'elenco |
| `created_at`, `last_used_at`, `revoked_at` | timestamptz | |

- **Uno per PAT** (indice unico su `pat_id` where `revoked_at is null`): un Mac, un
  login, un sigillo.
- **Il server non apre il sigillo** e non ha la privata del dispositivo: è una
  busta opaca come le altre («Il server non decifra mai», invariata).
- Le cascate fanno sparire il sigillo quando sparisce ciò a cui è legato: il PAT
  (logout, revoca, reset della password), la chiave di persona (ricreata o
  rifiutata), la persona.
- Entra nell'elenco CHIUSO di `vault-isolation.test.ts`: la nominano solo
  `routes/vault.ts` e `routes/credentials.ts`.

E la tabella degli accoppiamenti in corso, `vault_device_pairings` (§6.2):
`state` (hash), `pat_id`, `device_public_key`, `device_name`, `expires_at`
(10 minuti), `used_at`; uso singolo. Anche lei nell'elenco chiuso.

### 6.2 Il sigillo nasce SOLO dal browser, con la passkey

`POST /api/vault/device-seals` (da **sessione** del browser, `browserOnly`,
riconferma recente, cassaforte aperta):

- corpo: `{ patId, devicePublicKey, seal, deviceName, pairingState, actorProof }`;
- `actorProof`: la prova della PROPRIA chiave aperta (la sfida che c'è già,
  `kind = 'actor'`): chi sigilla prova di avere la privata in memoria. Senza,
  403 `vault_proof_invalid`, nulla scritto;
- **come si prova che il PAT è quello del Mac che ha generato la pubblica**
  (la proposta di 94, con un passo in più): il main, quando chiede di
  accoppiare, chiama `POST /api/vault/device-pairings` **col suo PAT**
  mandando `devicePublicKey`; il server crea una riga d'accoppiamento
  (`pairingState` casuale, hash, 10 minuti, uso singolo) legata a QUEL `pat_id`
  e a QUELLA pubblica, e risponde lo `state`. Il main apre il browser su
  `/app/#/vault-pair?state=…`. Il browser legge dal server la pubblica e il
  nome del dispositivo per quello `state` (mai dall'URL: un URL si inoltra), e
  la persona confronta l'**impronta** del dispositivo che il Mac mostra con
  quella del browser prima di sigillare. Il `POST` del sigillo vuole lo stesso
  `state`: il server controlla che `patId` e `devicePublicKey` siano quelli
  dell'accoppiamento, che il PAT sia `desktop`, non revocato e della STESSA
  persona della sessione. Altrimenti 409 `pairing_invalid`, nulla scritto;
- la chiave sigillata è la chiave di persona `confirmed` di chi sigilla
  (`person_key_id` lo calcola il server, non arriva dal corpo);
- scrive `vault_device_sealed` nel registro di sicurezza e avvisa la persona
  stessa (`security.alert`, sempre consegnato).

### 6.3 Cosa può fare il PAT desktop con un sigillo, e cosa resta `session_required`

Il PAT `desktop` col suo sigillo vivo diventa «il PAT desktop riconfermato»
dell'invariante. In più di un PAT qualunque:

- `GET /api/vault/device-seals/mine` → il proprio sigillo (la busta) e la
  pubblica di persona, per aprirlo nel main;
- `POST /api/credentials/:id/reveal` (la busta della password e la propria copia
  della chiave), col registro come dal browser (`credential_access_log`, con
  `via: "desktop"` e il `deviceSealId`);
- le sfide e le prove della propria chiave (`actor-challenge`), quindi
  condividere, togliere un lettore, confermare una chiave altrui, rifiutare;
- creare e cambiare password come oggi;
- `DELETE /api/vault/device-seals/mine`: toglie SOLO il sigillo legato a QUEL
  PAT (logout, login di un altro, «Dimentica questo Mac», §4–§5); registro
  `vault_device_seal_revoked`, motivo «dimenticato dal Mac».

Restano `session_required` anche col sigillo (la regola di adesso):

- **attivare la cassaforte, il recupero col kit, rigenerare il kit**: sono i
  gesti di ultima istanza, legati alla passkey e alla riconferma del browser;
- **creare, ricreare o sigillare una chiave di persona** e **sigillare un
  dispositivo** (§6.2): un Mac non si accoppia da sé, né ne accoppia un altro;
- **togliere un sigillo di un ALTRO dispositivo** dal desktop: si fa dal browser
  (§8). Il proprio sì (logout).

Ogni rotta che il PAT desktop apre si **dichiara** (`config.desktopVault: true`,
test del registro delle rotte come per `config.reauth`), e il controllo sta in
UN posto (`vault/device-access.ts`): PAT `desktop`, non revocato, sigillo vivo
legato a quel PAT e alla chiave `confirmed` ATTUALE della persona. Il resto
delle rotte della cassaforte resta `browserOnly`.

### 6.4 Registro e isolamento

- Registro di sicurezza: `vault_device_sealed`, `vault_device_seal_revoked`
  (chi, quale dispositivo, perché: logout, revoca remota, chiave ricreata,
  permesso tolto), `vault_device_seal_used` NO (sarebbe una riga per apertura):
  l'uso aggiorna `last_used_at`, e ogni `reveal` dal desktop è già nel registro
  degli accessi con `via: "desktop"`.
- `vault-isolation.test.ts`: le tabelle nuove (`vault_device_seals`,
  `vault_device_pairings`) nell'elenco delle tabelle, il modulo nuovo (`vault/device-access.ts`) nel perimetro di `apps/server/src/vault`.

## 7. Il protocollo dell'associazione, lato desktop (94)

Come il login (`browserLogin.ts`), con il passo di 72 (§6.2):
1. il main genera la coppia del dispositivo (§1) e, **col suo PAT**, chiama
   `POST /api/vault/device-pairings { devicePublicKey, deviceName }`; il
   server risponde lo `state` (10 minuti, uso singolo, legato a quel PAT e a
   quella pubblica). La privata del dispositivo resta in memoria finché
   l'associazione non finisce;
2. il main apre nel browser `<istanza>/app/#/vault-pair?state=<s>` (nell'URL
   SOLO lo state) e mostra nella sua finestra l'**impronta** della chiave del
   dispositivo, con «Confronta con quella nel browser»;
3. il browser, a cassaforte aperta con la passkey, legge dal server pubblica e
   nome per quello state, mostra la stessa impronta, e con «Associa questo
   Mac» sigilla la privata di persona (`POST /api/vault/device-seals`, §6.2),
   poi riapre `stubwise://vault?state=<s>`;
4. il main accetta SOLO lo state pendente, scarica il sigillo
   (`GET /api/vault/device-seals/mine`), lo APRE e verifica la privata contro
   la pubblica di persona (§1) PRIMA di scrivere `vault-device.bin`: un
   sigillo che non si apre non lascia niente su disco;
5. scaduto lo state o chiusa la finestra senza ritorno: la privata del
   dispositivo si dimentica, nulla su disco; si ricomincia.

## 8. La revoca remota (72)

- **Elenco dei Mac**: `GET /api/vault/device-seals` (browser) → i propri sigilli
  vivi: nome, impronta della pubblica, creato, ultimo uso. In Impostazioni →
  Sicurezza, accanto alle passkey.
- **Togliere un Mac dal browser** (`DELETE /api/vault/device-seals/:id`, sessione,
  riconferma): `revoked_at` sul SOLO sigillo; il PAT desktop legato resta
  (decisione D-5: il Mac resta collegato a Stubwise ma non apre più la
  cassaforte; il login si toglie da Impostazioni → token, come oggi).
  Registro e avviso.
- **Mac perso, senza il browser a portata**: un full admin può togliere i sigilli
  di una persona (D-6; il solo sigillo, come D-5) (Utenti → la persona → Dispositivi), con la
  riconferma, registro e avviso alla persona — lo stesso schema di «admin che
  azzera un pari grado» del secondo fattore.
- **Revoche implicite, applicate a LETTURA** (come la revoca dei lettori,
  `docs/invariants/vault.md`): il sigillo non vale più se il PAT è revocato, se
  la chiave di persona non è più quella `confirmed` attuale (ricreata,
  rifiutata), se la persona è disattivata o ha perso l'accesso. Il controllo di
  `device-access.ts` lo calcola a ogni richiesta; le cascate e una purga sono
  igiene, non il meccanismo.
- **Ricreare la chiave di persona** rende inutile ogni sigillo (cascata, e prima
  ancora il controllo a lettura): un Mac compromesso con la privata in memoria si
  neutralizza così, oltre che cambiando le password che aveva letto (limite
  accettato, come oggi per un browser).

## 9. Cosa cambia in `docs/invariants/vault.md`, e perché resta accettabile (72)

Cambiano tre frasi, tutte nella stessa direzione: **una seconda via di sblocco,
legata a un dispositivo accoppiato dalla passkey**.

1. «Un token personale (PAT) crea e sostituisce, non legge» diventa «… salvo il
   PAT desktop riconfermato **con un sigillo del dispositivo vivo**», con
   l'elenco dichiarato delle rotte (§6.3) e quelle che restano
   `session_required`.
2. «Lo sblocco è la riautenticazione con passkey, con PRF. Non esiste un secondo
   meccanismo» diventa «… **Il secondo meccanismo è il sigillo del dispositivo,
   che nasce solo da uno sblocco con passkey** (§6.2): non è un'altra porta, è
   una copia della stessa chiave, avvolta per un dispositivo che la persona ha
   scelto e confrontato a vista».
3. **Nuova voce**: il sigillo del dispositivo — dove sta, a cosa è legato, chi lo
   crea, come si revoca (a lettura), cosa non può fare.

Perché resta accettabile:

- **Il server continua a non decifrare niente**: riceve un'altra busta opaca.
- **La conferma umana non cambia**: il sigillo apre la chiave di persona già
  `confirmed`, non crea una chiave né la conferma; accoppiare un Mac non dà
  accesso a credenziali che la persona non aveva.
- **Il rischio nuovo è il Mac**: chi ha il Mac sbloccato con la sessione aperta
  apre le password della persona. È lo stesso rischio del browser con la
  cassaforte aperta, ma più lungo (D-1, D-2 di 94 lo riducono: Touch ID, chiusura
  dopo 15 minuti). Contro il furto del Mac spento: `safeStorage` sta nel
  portachiavi, e il file da solo non serve senza il login macOS; il sigillo si
  revoca da remoto (§8).
- **Il server compromesso** (limite accettato già scritto) resta tale: potrebbe
  servire al desktop una pubblica di persona falsa — ma il main verifica che la
  pubblica sia la metà della privata aperta, come il browser
  (`openPrivateKey`), e non cifra per chiavi d'altri.

## 10. Test negativi (lato server, 72)

- Un PAT `manual` o `mobile` con un sigillo inventato → `session_required` su
  `reveal` e su ogni rotta dichiarata `desktopVault`.
- Il PAT desktop di **un'altra persona** con lo stesso `deviceId` → 404.
- Un sigillo creato con lo `state` di un accoppiamento di un **altro PAT**, o di
  un'altra pubblica, o scaduto, o già usato → 409 `pairing_invalid`, nulla scritto.
- Senza `actorProof`, o con quella di un'altra sessione → 403 `vault_proof_invalid`.
- Dopo la revoca del PAT, la ricreazione della chiave di persona, la
  disattivazione della persona o la revoca dal browser → il `reveal` dal desktop
  è 403/404 SUBITO, con la riga del sigillo ancora in DB (la revoca a lettura).
- Le rotte che restano `session_required` lo restano col sigillo vivo: attivare,
  recupero, kit, chiavi di persona, sigillare un dispositivo.
- `DELETE /api/vault/device-seals/mine` col PAT desktop non toglie il sigillo
  di un'altra persona né quello di un altro PAT della stessa persona (404).
- `vault-isolation.test.ts`: le tabelle nuove non le nomina nessuno fuori dalle
  rotte della cassaforte.

## 11. Limiti accettati (proposti)

- Un programma ostile che gira come lo stesso utente macOS, a Mac sbloccato,
  può usare la cassaforte del desktop (app non firmata, §2). È più largo di
  oggi, dove serve la passkey a ogni sblocco.
- Una password mostrata nel desktop a un lettore poi revocato non si
  dimentica (come nel browser).
- Un Mac associato e perso: finché non si revoca (§8), chi lo apre con la
  password di login dell'utente apre la cassaforte.
- Togliere un Mac dalla cassaforte (D-5) non lo scollega da Stubwise: chi ha
  quel Mac vede ancora ciò che il login gli dà fuori dalla cassaforte, finché
  qualcuno non revoca il suo PAT desktop (Impostazioni → token).

## 12. Da decidere (per il maintainer) — DECISO il 24 nov 2026

*Il maintainer ha approvato il design il 24 nov 2026 e ha deciso D-1, D-5,
D-6 e D-7; D-2, D-3, D-4 e D-8 li ha decisi 46 con le raccomandazioni.
**D-5 è diverso dalla raccomandazione.***

| # | Domanda | Raccomandazione | Decisione (24 nov 2026) |
|---|---|---|---|
| D-1 | Lo sblocco dal desktop chiede qualcosa (Touch ID, `systemPreferences.promptTouchID`) o è davvero automatico? | **Touch ID alla riapertura** (dopo stop, blocco schermo o 15 minuti), automatico solo all'avvio subito dopo l'associazione. Restringe il limite di §11 (un programma ostile non passa il Touch ID) e costa un tocco. **È una proposta contro la lettera della decisione**: cambia «si sblocca da solo» in «con un tocco, dopo una pausa». Se il maintainer vuole «da solo» alla lettera: automatico sempre, e il limite resta. | **Touch ID alla riapertura**, come raccomandato (maintainer). |
| D-2 | La chiusura in memoria dopo quanto? | **15 minuti senza usarla**, più stop/blocco dello schermo. | **15 minuti**, più stop e blocco dello schermo (46). |
| D-3 | Quanti Mac per persona? | **Senza tetto**, ognuno nell'elenco con nome e ultima apertura, revocabile. | **Nessun tetto** (46). |
| D-4 | Secure Enclave quando l'app sarà firmata? | **Sì**, voce nel registro dei rimandi. | **Sì**, voce nel registro dei rimandi (46). |
| D-5 | Togliere un Mac dal browser revoca anche il suo PAT desktop (il login), o solo il sigillo? | **Anche il PAT**: un Mac perso non deve restare connesso. | **Solo il sigillo** (maintainer, DIVERSA dalla raccomandazione): il Mac resta collegato a Stubwise ma non apre più la cassaforte; il PAT desktop non si tocca. |
| D-6 | Un full admin può togliere i Mac di un'altra persona (Mac perso, persona senza browser)? | **Sì**, con riconferma, registro e avviso alla persona, come l'azzeramento del secondo fattore. | **Sì**, con riconferma, registro e avviso alla persona (maintainer); il solo sigillo, come D-5. |
| D-7 | Dal desktop col sigillo si può condividere e confermare (con la prova della propria chiave), o solo leggere? | **Sì, tutto ciò che fa il browser a cassaforte aperta**, salvo attivare, recupero, kit e chiavi di persona (la decisione del 10 nov: «dal desktop tutto»). | **Tutto come il browser**, salvo attivazione, recupero, kit e chiavi di persona (maintainer). |
| D-8 | Il `reveal` dal desktop si distingue nel registro degli accessi (`via: "desktop"`)? | **Sì**: chi guarda il registro deve sapere da dove si è letta una password. | **Sì**, `via: "desktop"` nel registro degli accessi (46). |
