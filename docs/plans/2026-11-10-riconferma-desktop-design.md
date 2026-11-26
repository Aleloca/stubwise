# Riconferma dal desktop — design (10 nov 2026)

> Stato: **DECISO il 10 nov 2026 dal maintainer: opzione B** (il codice
> dentro l'app), non la A consigliata. Le decisioni:
> - **D1**: il codice TOTP, o uno di riserva, si scrive DENTRO l'app desktop
>   (`POST /api/auth/desktop-reauth`), niente passkey dal desktop, e la
>   riconferma apre una finestra di 10 minuti su tutte le rotte sensibili per
>   quel PAT `desktop`;
> - **D2**: non si applica (nessuna approvazione nel browser);
> - **D3**: nessuna rotta esclusa, e (seconda decisione dello stesso giorno)
>   nemmeno negli handler. Token, desktop-handoff, il link di reset altrui e
>   la propria password sono aperti al PAT desktop riconfermato con una regola
>   sola (`browserOrConfirmedDesktop`). La cassaforte è aperta per decisione ma
>   bloccata tecnicamente dallo sblocco PRF (registro dei rimandi, area 9);
> - **D4**: una riga `reauth_desktop` nel registro di sicurezza (la riconferma,
>   e ogni azione fatta con la finestra, con l'azione), nessun
>   `security.alert`.
>
> Costruita nella migrazione 0132. L'invariante sta in
> `docs/invariants/second-factor.md` («La riconferma si DICHIARA…»). Il resto
> del documento è la proposta così com'era, con le opzioni scartate.
> Autore: stubwise-72, per l'orchestratrice.
>
> Registro: «Riconferma dal desktop» (area 9, chiusa) in
> `docs/plans/integrazione-registro-rimandi.md`; la classe C della chat
> (fetta 4) in `docs/plans/2026-11-10-integrazione-claude-chat-design.md`.

## Il problema

Le azioni sensibili dichiarano `config.reauth` (oggi 31 rotte, elenco chiuso
in `apps/server/src/auth/route-access.test.ts`): serve una **sessione** del
browser con un secondo fattore usato negli ultimi 10 minuti
(`applyReauth`, `apps/server/src/auth/access.ts`). **Un PAT non la soddisfa
mai** (403 `session_required`): è la difesa che impedisce a un token rubato
di cambiare ruoli, password e accessi.

L'app desktop impacchettata (`package:mac`) parla al server SOLO con un PAT
`kind = 'desktop'`, che ottiene dal login nel browser (PKCE,
`apps/desktop/src/main/browserLogin.ts`, `POST /api/auth/desktop-exchange`).
Quindi oggi, dal desktop:

- l'area 9 (ruoli, membri, ruoli d'istanza, reset della password e del 2FA
  di altri, identità collegate, Slack) non si può integrare;
- la classe **C** delle azioni di Claude (riconferma) non può esistere: la
  conferma di una C partirebbe dal PAT.

La build `app` web (`/app`, cookie di sessione) NON ha il problema: usa già il
dialogo «Confirm it's you» (`reauthenticate` in
`data/backend/real/session.ts`). Questo design riguarda solo il desktop
impacchettato.

Vincoli (da `second-factor.md` e dal registro):

1. Il secondo fattore si verifica SOLO da `attemptSecondFactor`, e le passkey
   funzionano solo sul dominio dell'istanza, cioè nel browser (il motivo per
   cui il login del desktop passa dal browser).
2. Un token non conia altri token (`POST /api/pats`, `desktop-handoff`: 403
   `session_required` anche col meccanismo nuovo).
3. Una porta che dà una sessione o un token è dichiarata
   (`config.credentialDoor`) e passa dal secondo fattore.
4. Il codice che torna al desktop passa da `stubwise://`, che NON è legato
   all'app (RFC 8252, «limite accettato dello schema»): ciò che viaggia lì
   deve essere inutile senza un segreto che sta solo nel main.

## Opzioni

### A — Una prova monouso, legata a UNA richiesta, approvata nel browser (consigliata)

Lo stesso schema del login del desktop, applicato a una singola azione.

1. **Registrare l'intento** (desktop, col PAT). Il main genera `state` e
   `verifier` (PKCE) e calcola il digest della richiesta che vuole fare:
   metodo, URL registrato della rotta (`routeOptions.url`), parametri e
   SHA-256 del body in forma canonica (chiavi ordinate; la funzione sta in
   `@stubwise/shared` e la usano entrambi i lati).
   `POST /api/auth/desktop-reauth` `{ method, path, bodyDigest, challenge,
   deviceName }` → `{ id, expiresAt }`. Il server accetta SOLO un PAT
   `desktop`, SOLO una rotta che dichiara `config.reauth` e non è
   nell'elenco escluso (D3), e conserva il NOME della rotta da mostrare, preso
   da una mappa chiusa lato server (`REAUTH_ROUTE_LABELS`), mai da un testo
   del client.
2. **Approvare nel browser** (cookie). Il main apre
   `<istanza>/app/#/desktop-reauth?request=<id>&state=<s>`. La pagina legge
   la richiesta (`GET /api/auth/desktop-reauth/:id`: solo lo STESSO utente,
   altrimenti 404) e chiede «Confirm on "<device>": <azione>?». Il codice si
   chiede SOLO col clic su «Confirm»:
   `POST /api/auth/desktop-reauth/:id/approve`, con `config.reauth: true`.
   Il secondo fattore passa quindi dal dialogo e da `attemptSecondFactor`
   come ogni riconferma, passkey compresa. Risponde un codice monouso di 2
   minuti, di cui il DB tiene solo lo SHA-256.
3. **Tornare all'app.** Il browser apre `stubwise://reauth?code=…&state=…`,
   e il main accetta SOLO lo state pendente, come `handleAuthUrl`.
4. **Fare l'azione.** Il main manda la richiesta registrata col PAT e
   l'header `Stubwise-Reauth: <code>.<verifier>`. `applyReauth`, per un PAT
   `desktop` con quell'header, consuma la prova con UN UPDATE guardato
   (`used_at is null`, `approved_at is not null`, `expires_at > now()`,
   stesso utente, stesso `pat_id`, stessi metodo, rotta e digest della
   richiesta che sta servendo). PRIMA confronta `sha256(verifier)` col
   challenge: un verifier sbagliato la brucia, come in `desktop-exchange`.
   Senza header, o con una prova che non torna: 403 `session_required`, come
   oggi.

Il verifier, il codice e il PAT non lasciano mai il main. Il renderer sa
solo «in attesa del browser», «riuscita», «annullata», «scaduta».

- **Pro**: il fattore lo verifica il browser, quindi le passkey vanno. Ogni
  prova vale per UNA richiesta già scritta, una volta e per 2 minuti, e solo
  per il PAT che l'ha registrata. Un codice intercettato su `stubwise://` non
  serve senza il verifier. Un cookie rubato non basta: serve anche il PAT
  della stessa persona, e viceversa. La C della chat ci passa senza casi
  speciali: la sua conferma (`POST /api/claude/proposals/:id/confirm`) è una
  richiesta come le altre, e la proposta sta già sul server.
- **Contro**: un passaggio dal browser per ogni azione sensibile, anche due
  di fila. Serve una tabella nuova e tre rotte. `applyReauth` impara un
  caso: un PAT, solo `desktop`, solo con la prova.

### A′ — Come A, ma la prova apre una finestra di 10 minuti al PAT

L'approvazione nel browser imposta `pats.second_factor_at` e il PAT soddisfa
`reauth` come una sessione, su qualunque rotta, per 10 minuti.

- **Pro**: un solo passaggio dal browser per più azioni (l'area 9 ne fa
  spesso più d'una di fila).
- **Contro**: per 10 minuti il PAT `desktop` vale come una sessione
  riconfermata su TUTTE le rotte sensibili, comprese quelle che il clic non
  nominava. Si perde la proprietà «il browser ha visto quale azione stava
  confermando». Non consigliata, ma è la variante da tenere se il maintainer
  giudica A troppo faticosa nell'uso.

### B — Riconferma dentro l'app, col codice dell'app di autenticazione

`POST /api/me/security/reauth` accetterebbe un PAT `desktop` col codice TOTP o
di riserva, e marcherebbe il PAT come riconfermato per 10 minuti.

- **Pro**: nessun browser, nessuna tabella nuova (solo una colonna sul PAT).
- **Contro**: le passkey non funzionano (dominio, app non firmata), quindi
  chi ha solo la passkey come comodità deve comunque avere l'app TOTP; in
  realtà il TOTP è obbligatorio per tutti, quindi va, ma il desktop
  diventerebbe l'unica superficie in cui la riconferma non può usare una
  passkey. Ha gli stessi problemi di finestra di A′. Rompe la frase «un PAT
  non la soddisfa mai» per il caso più largo. Non consigliata.

### C — Le azioni sensibili si fanno nel browser

Dal desktop si apre la pagina giusta di `/app` nel browser, e l'azione la fa
il web, col cookie e il suo dialogo.

- **Pro**: zero meccanismi nuovi, zero rischi nuovi.
- **Contro**: l'area 9 andrebbe fatta due volte (il desktop la mostra, il
  browser la esegue) o non esisterebbe nel desktop. Per la C della chat si
  regge, perché la proposta sta sul server: «Confirm in browser» aprirebbe la
  conversazione su `/app`. È la scelta minima se il maintainer vuole rinviare,
  e resta comunque il ripiego quando il browser non torna all'app.

## Raccomandazione

**A**, con le esclusioni di D3. Ha la stessa forma del login del desktop,
quindi è già rivista e ha gli stessi test negativi da copiare, e lega la
prova all'azione: è l'unica opzione in cui «ho confermato QUESTO, su QUESTO
dispositivo» resta vero fino al server. Se l'uso la rendesse pesante (più
azioni dell'area 9 di fila), la strada è A′, limitata alle rotte di una
stessa pagina e decisa a parte, non B.

## Decisioni per il maintainer

- **[DECIDE] D1 — l'opzione.** A (consigliata), A′, B o C.
- **[DECIDE] D2 — il fattore all'approvazione.** (a, consigliata) La pagina
  di approvazione usa `config.reauth: true` come `desktop-handoff`: se il
  browser ha usato un fattore negli ultimi 10 minuti basta il clic su
  «Confirm», altrimenti si apre il dialogo. (b) Il fattore si chiede SEMPRE,
  anche dentro la finestra: più fatica, e chi ha appena fatto il login nel
  browser lo rifà subito. Con la (a), chi ruba un cookie fresco e il PAT della
  stessa persona può approvare da sé: due furti, nella stessa finestra.
- **[DECIDE] D3 — le rotte escluse anche con la prova.** Consiglio:
  - quelle che coniano un token o un invito: `POST /api/pats`, `POST
    /api/auth/desktop-handoff`, `POST /api/auth/invites`;
  - il link di reset della password di un altro: `POST
    /api/users/:id/password-reset` (è una credenziale, ed è nel «mai» delle
    azioni di Claude);
  - le rotte della cassaforte (`/api/vault/*`), che hanno un loro modello
    (conferma umana, prova di possesso del kit, `docs/invariants/vault.md`):
    vanno ragionate con la loro area;
  - le cerimonie che vivono nel browser per costruzione: passkey e
    configurazione del TOTP (`/api/me/security/passkeys*`, `totp/setup*`).

  Ammesse: ruoli e duplicati, membri di progetto, ruolo d'istanza, cambio
  della propria password, azzeramento del 2FA di un altro (con il suo
  `security.alert`, invariato), identità git, Slack, codici di riserva
  (rigenerati, mostrati una volta nel desktop). Più la conferma di una
  proposta C della chat, quando esisterà. L'elenco ammesso è chiuso in un
  test di registro, come `route-access.test.ts`.
- **[DECIDE] D4 — avviso.** (a, consigliata) Una riga `reauth_desktop` nel
  registro di sicurezza a ogni prova consumata (chi, dispositivo, rotta),
  nessun `security.alert`: le rotte che lo meritano lo mandano già, ed è la
  stessa scelta del primo login di un dispositivo. (b) Un `security.alert` a
  ogni approvazione.
- **D5 — fuori da questo design.** L'app mobile (stesso problema, ma senza
  integrazione in corso) e un «Confirm in browser» per la build `app` web,
  che non serve: ha il cookie.

## Cosa cambia nelle invarianti (`second-factor.md`)

- La voce «La riconferma si DICHIARA… e un PAT non la soddisfa mai» diventa:
  «un PAT non la soddisfa mai **da solo**: solo un PAT `desktop`, con una
  prova monouso legata a quella richiesta, approvata nel browser da una
  sessione completa e riconfermata dello stesso utente; mai sulle rotte
  escluse». Le rotte escluse restano `session_required` anche con la prova.
- Una voce nuova, come quella del token del turno: **la prova di riconferma
  del desktop NON è una porta** (non dà una sessione né un token, autorizza
  UNA richiesta), quindi non va in `config.credentialDoor`. Le sue difese,
  ciascuna col suo test negativo:
  - solo hash nel DB;
  - 2 minuti, una volta;
  - legata a utente, `pat_id`, metodo, rotta e digest del body;
  - verifier PKCE, che uno sbagliato brucia;
  - approvazione solo col clic e con la riconferma;
  - mai sulle rotte escluse.
- Il limite dello schema `stubwise://` si estende a questa pagina con la
  stessa difesa: la domanda nomina il dispositivo E l'azione, il codice si
  chiede solo col clic. Per approvare un intento serve il PAT della vittima
  per registrarlo, e il codice torna comunque sulla macchina della vittima,
  dove nessuno state lo aspetta.
- Reset e cambio della password revocano già i PAT `desktop`, e con loro le
  prove registrate da quei PAT (FK `ON DELETE CASCADE`).

## Il lavoro (se passa A)

- **DB**: `desktop_reauth_requests` (utente, `pat_id` con CASCADE, metodo,
  rotta, digest, challenge, dispositivo, `code_hash`, `approved_at`,
  `expires_at`, `used_at`), potata come `desktop_handoffs`.
- **Shared**: la forma canonica del body e il digest, con un test di parità
  fra i due lati; gli schemi delle tre rotte.
- **Server**: le tre rotte, sotto il bucket delle credenziali per
  registrazione e approvazione; il ramo di `applyReauth`; `REAUTH_ROUTE_LABELS`
  e l'elenco chiuso delle ammesse e delle escluse in un test di registro.
  Test negativi: PAT non `desktop`, prova di un altro PAT o utente, rotta,
  metodo o body diversi, riuso, scadenza, verifier sbagliato (che la brucia),
  rotta esclusa, approvazione senza riconferma (403 `reauth_required`) o con
  un PAT (403 `session_required`), approvazione di un intento di un altro
  utente (404).
- **Main del desktop**: `createBrowserReauth`, gemello di
  `createBrowserLogin`. Una richiesta pendente alla volta, 5 minuti, e
  `stubwise://reauth`. Il canale `api:request` impara a ripetere la
  richiesta con la prova quando il server risponde `reauth_required` o
  `session_required` su una rotta ammessa.
- **Renderer**: `useReauth()` in modo app desktop mostra «Confirm in your
  browser» (attesa, «Cancel», «Open again»), invece del dialogo del codice.
- **Web `/app`**: la pagina `#/desktop-reauth`, gemella di
  `#/desktop-login`.
- **Rollback**: un server vecchio non conosce l'header, quindi il desktop
  riceve `session_required` come oggi e l'azione non parte. La tabella resta
  inerte.
