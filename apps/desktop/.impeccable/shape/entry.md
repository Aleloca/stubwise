# Shape brief — Ingresso: login, secondo fattore, invito, primo avvio, riconferma

> **Nota del 30 ott 2026 (maintainer):** `target_above` non esiste più (nessuna gerarchia). Ogni riferimento qui sotto è superato.

Superficie: le schermate **fuori dall'intelaiatura** (nessun binario,
nessuna colonna): `/login` con il passo del secondo fattore, `/register/$token`
(registrazione da invito), `/setup` (primo avvio su istanza vuota); il
**dialogo di riconferma** (`layout/ReauthDialog.tsx` + `useReauth()`), che si
apre sopra qualunque pagina; nel menu del profilo «Sign out» e, nel riquadro
«Prototype only», «Reset prototype» e «Reset to empty instance». Piano 9a:
Task 6 (dati: Task 3 e 5). Spec area 9: «Ingresso», «La riconferma»,
«Quanto è vero nel prototipo». Web di riferimento (cosa si porta, non come
appare): `apps/web/src/routes/{login,login-second-factor,register,setup}.tsx`
e le chiavi `auth.*`. Invarianti: `docs/invariants/second-factor.md`. Mondo:
«Catalogo numerato» (`DESIGN.md`), modalità **Operate**. Scelte del brief
**[IN n]**, raccolte in fondo; quelle che cambiano ciò che si vede in
«Scelte da confermare».

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi entra ogni mattina** (Laura, Marco: hanno il secondo fattore):
    email, password, codice; vogliono essere dentro in dieci secondi.
  - **Chi entra senza secondo fattore** (Sara): non viene fermata al login;
    lo scopre solo alla prima azione delicata, e lì deve capire **perché**
    le si chiede di attivarlo.
  - **Chi è stato invitato**: non ha mai visto Stubwise. Arriva da un link
    che qualcuno gli ha passato a mano; vuole sapere chi lo invita, in quali
    progetti, e creare l'account.
  - **Chi installa** (primo avvio): istanza vuota, nessuno dentro. Crea il
    primo amministratore.
  - **Chi prova il prototipo** (il maintainer, chi rivede): deve poter
    entrare con qualunque persona del seme senza ricordare credenziali.
- **Stato d'animo**: neutro e di passaggio. Nessuna di queste schermate è
  una destinazione: sono porte. Devono essere brevi, ferme, e dire gli
  errori in parole senza mai rivelare se un'email esiste.

## 2. Esito e prova

- **Azioni primarie**: entrare; completare il secondo fattore (codice,
  passkey o codice di backup); registrarsi da invito; creare il primo
  admin; confermare un'azione delicata (riconferma), con l'iscrizione al
  secondo fattore quando manca.
- **Successo**, a 1440×900:
  - login di Laura: email + password → «Two-step verification» → `123456`
    → Home, in tre schermate senza scorrere;
  - una password sbagliata dice «The email or password is wrong.» — la
    stessa frase per un'email che non esiste e per una persona disattivata;
  - al quinto codice sbagliato: «Too many wrong codes. Two-step
    verification is locked until 10:42.» e il campo si spegne;
  - un invito scaduto dice chi l'aveva mandato e cosa fare («Ask Roberta
    Fontana for a new invite.»), non un 404;
  - dentro l'app, «Change role…» su Marco senza riconferma recente apre
    «Confirm it's you», chiede il codice e **ripete il cambio di ruolo da
    solo**: chi agisce non deve rifare il gesto.
- **Verità del prodotto** (mai ammorbidite):
  - **un errore di login non dice mai se l'email esiste**;
  - **il blocco è un blocco**: con l'orario di fine, nessun modo per
    aggirarlo dalla stessa schermata (la passkey e i codici di backup
    passano dallo stesso contatore, come in `second-factor.md`);
  - **la riconferma è dell'app, non del browser**: un dialogo modale con il
    nome dell'azione che sta per ripartire;
  - **un'azione chiusa senza riconferma non ha cambiato niente**, e lo si
    dice («Nothing was changed.»);
  - **i codici di backup e il segreto TOTP si vedono una volta**.

## 3. Direzione scelta

- **Tesi**: **una colonna sola al centro della finestra, come la prima
  pagina di un catalogo**. Logo «S_» in alto, un titolo 28px, una riga in
  prosa, il modulo, sotto il riquadro «Prototype only». Niente immagini,
  niente illustrazioni, niente pannello di marketing accanto: è uno
  strumento di lavoro **[IN 1]**.
- La colonna è larga 400px, centrata in orizzontale, con il blocco a un
  terzo dall'alto (non al centro esatto: l'occhio parte in alto). Fondo
  `ground`, nessun riquadro intorno al modulo: i campi stanno sul fondo,
  separati dal ritmo, non da una card.
- La barra del titolo della finestra resta trascinabile (36px in alto, i
  semafori di macOS a sinistra).

```
                         ┌──┐
                         │S_│
                         └──┘
                     Sign in to Stubwise
             Enter the email and password of your account.

             Email
             [laura.costa@example.test                 ]
             Password
             [••••••••                                 ]
                                              [ Sign in ]

            ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
              Prototype only
              Every account's password is  stubwise
              The two-step code is  123456
              Sign in as:  Roberta · Laura · Marco · Giulia · Matteo · Sara
            └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

### Login (`/login`)

- Logo 32px (il componente del binario) · h1 «Sign in to Stubwise» ·
  riga 14px `ink-muted` «Enter the email and password of your account.»
- Campi **Email** e **Password** (etichetta sopra, 14px; il campo 36px,
  filetto `rule-strong`, fuoco con l'anello `focus`). Invio dal campo
  password invia.
- **Sign in** primario, allineato a destra sotto i campi; durante: «Signing
  in…» con il bottone che resta largo uguale.
- Errore: una riga sotto i campi, glifo ✕ `critical` + «The email or
  password is wrong.» (`role="alert"`); il fuoco torna al campo password,
  svuotato; l'email resta.
- Errore del livello dati (`failNext`): «Couldn't sign in. Try again.» con
  **Retry** accanto (ripete l'invio con gli stessi campi).
- **Riquadro «Prototype only»** (il riquadro tratteggiato dell'8a, 400px):
  la password del seme e il codice fisso in monospace (sono «token e
  chiavi», l'eccezione delle Global Constraints), poi «Sign in as:» e i
  nomi delle persone del «vedi come» **attive**, come link: un clic
  riempie email e password, non invia **[IN 2]**. Le persone disattivate
  non compaiono.

### Secondo fattore (passo dentro `/login`)

- Stessa colonna; il logo resta, il titolo cambia: «Two-step verification»
  · riga «Enter the 6-digit code from your authenticator app.» · sotto,
  12px `ink-muted`, «Signing in as laura.costa@example.test · Not you?»
  (link che torna al passo 1).
- **Codice**: un campo solo, 6 cifre, cifre tabellari, `inputmode=numeric`,
  `autocomplete=one-time-code`; alla sesta cifra si invia da solo (si può
  anche premere **Verify**).
- **Altri modi**, sotto il bottone, una riga di link 13px: «Use a passkey»
  · «Use a backup code». Il modo scelto sostituisce il campo:
  - **Passkey**: «Use the passkey on this device.» e il bottone **Use
    passkey**; nel prototipo il riquadro offre «Simulate passkey» (riesce) e
    «Simulate a failed passkey» → «The passkey didn't work. Try again or use
    a code.»;
  - **Codice di backup**: campo di 10 caratteri «xxxxx-xxxxx», monospace;
    dopo l'ingresso con un codice di backup, se ne restano 3 o meno, un
    passo in più: «You have 2 backup codes left. Make new ones in
    Preferences → Security.» · **Continue**.
  - Da ogni modo si torna agli altri con gli stessi link.
- **Codice sbagliato**: ✕ `critical` «That code didn't work. 4 tries
  left.» (il contatore si mostra dal secondo errore in poi: al primo basta
  «That code didn't work.»). Il campo si svuota e riprende il fuoco.
- **Blocco** (5 errori): il campo e i link si spengono; al loro posto, in
  un blocco con filetto `critical` a sinistra (l'unico della schermata):
  «Too many wrong codes. Two-step verification is locked until 10:42.» e
  sotto «Back to sign in». Il riquadro del prototipo aggiunge «Pass 15
  minutes» (usa l'orologio `now()`, come «Pass time» delle Automazioni).
- **Sara** (nessun secondo fattore) salta questo passo: dopo la password è
  in Home.

### Registrazione da invito (`/register/$token`)

- Caricamento: la colonna con il logo e due righe scheletro al posto del
  titolo; nessun modulo finché l'invito non è letto.
- **Invito valido**: h1 «Join Stubwise» · riga «Roberta Fontana invited
  you.» · elenco **What you'll get**, una riga per progetto offerto: codice
  in cifre tabellari · nome · ruolo in parole («ACQ Acquisitions ·
  Developer»); se l'invito dà anche un ruolo d'istanza diverso da User, una
  riga in più «On the whole instance: Auditor». Poi i campi: **Email**
  (precompilata, in sola lettura: l'invito è per quell'indirizzo) · **Your
  name** · **Password** · **Confirm password** · **Create account**.
  - Password che non coincidono: sotto il secondo campo «The passwords
    don't match.»; password vuota o sotto 8 caratteri: «Use at least 8
    characters.»
  - Dopo: dentro, in Home, con un toast «Welcome, Federico. You're in ACQ
    and AUD.»
- **Invito scaduto**: h1 «This invite has expired» · «Roberta Fontana
  invited you on Oct 12. The invite expired on Oct 19. Ask Roberta for a
  new one.» · nessun modulo · link «Go to sign in».
- **Invito revocato**: h1 «This invite is no longer valid» · «Roberta
  Fontana withdrew it. If you still need access, ask them.»
- **Token sconosciuto**: la stessa pagina di «revocato» senza nome («This
  invite link isn't valid. Ask whoever sent it for a new one.»): un link
  inventato non rivela niente.
- **Già usato**: «This invite was already used. Sign in instead.» con il
  link.
- Errore del livello dati: «Couldn't load the invite.» · **Retry**.

### Primo avvio (`/setup`)

- Ci si arriva solo con l'istanza vuota (ogni altra rotta reindirizza qui;
  con l'istanza piena `/setup` reindirizza a `/login`).
- h1 «Set up Stubwise» · riga «This instance is new. The first account
  administers everything: people, roles, projects and settings.» · campi
  **Your name** · **Email** · **Password** · **Confirm password** ·
  **Create the admin account**.
- Dopo: Home vuota («No projects yet», lo stato vuoto della Home) con un
  toast «You're the instance's full admin.» La prima cosa che la Home vuota
  propone a chi ha `projects.create` resta quella dell'area 2.
- Il riquadro «Prototype only» qui dice: «This is the empty instance. Reset
  prototype brings back the sample company.» · **Reset prototype**.

### Menu del profilo

- In fondo al menu, sotto le voci, con un filetto: **Sign out** → `/login`
  (vuoto). Il «vedi come» resta: cambia persona senza login.
- Riquadro «Prototype only» in fondo al menu (tratteggiato, 12px):
  **Reset prototype** («Brings back the sample data and undoes every
  change.») e **Reset to empty instance** («Removes every person except
  Claude, every project and task, so you can try the first setup.»).
  Entrambi chiedono una conferma a due tempi in posto (il bottone diventa
  «Reset — sure?» per 4 secondi), come il merge delle Releases.

### Dialogo di riconferma («Confirm it's you»)

- Modale 440px, raggio 12px, `rule-strong`, scrim; il fuoco va al campo.
- Titolo «Confirm it's you» · riga **che nomina l'azione**: «To change
  Marco Bellini's instance role, enter a code from your authenticator
  app.» (la frase viene dall'azione che ha aperto il dialogo; per un'azione
  senza frase propria: «This action needs a recent confirmation.») **[IN 3]**.
- Campo del codice come al login, link «Use a passkey» · «Use a backup
  code»; **Confirm** primario · **Cancel**.
- Sotto, 12px `ink-faint`: «You won't be asked again for 10 minutes.»
- **Esito**:
  - codice giusto → il dialogo si chiude e l'azione riparte da sola; il
    suo esito (toast o cambio in pagina) è quello di sempre;
  - codice sbagliato, blocco: come al login, dentro il dialogo;
  - **Cancel** o Esc → il dialogo si chiude, un toast «Nothing was
    changed.» e il fuoco torna al controllo che aveva aperto l'azione;
  - l'azione ripetuta fallisce per un altro motivo (`escalation`,
    `target_above`…): il dialogo si chiude e il rifiuto si mostra nel posto
    dove l'azione era partita, con la sua frase (vedi
    `admin-roles-members.md`, «Rifiuti»).
- **Iscrizione al volo** (Sara, `no_second_factor`): lo stesso dialogo, in
  tre passi, con la riga dei passi in alto «1 Scan · 2 Confirm · 3 Save
  backup codes»:
  1. «This action needs two-step verification, and you haven't set it up
     yet. It takes a minute.» · il QR (SVG finto del prototipo, 160px, con
     sotto «Prototype: this QR code is made up.») · «Can't scan? Enter
     this key:» con la chiave in monospace e **Copy**;
  2. «Enter the first code the app shows.» · campo · **Confirm**;
  3. «Save your backup codes. Each works once, and they're shown only
     now.» · i 10 codici in due colonne monospace · **Download** ·
     **Copy** · casella «I've saved them» che abilita **Continue**.
  - **Continue** chiude il dialogo e ripete l'azione. **Cancel** a metà
    non attiva niente («Two-step verification wasn't set up. Nothing was
    changed.»).
- La finestra di grazia è **per persona**: cambiando persona col «vedi
  come» il dialogo si ripresenta per l'altra.

## 4. Ambito e confini

- **Dentro**: le quattro schermate, i tre modi del secondo fattore, blocco,
  invito valido/scaduto/revocato/usato/sconosciuto, primo avvio,
  riconferma con iscrizione al volo, «Sign out», i due reset del
  prototipo.
- **Fuori**: «Password dimenticata» dal login (sul web non esiste: il
  reset lo crea un admin, `admin-people.md`); la pagina pubblica del link
  di reset (nel prototipo il link si copia e basta: nessuna pagina lo
  apre); SSO; «Ricordami».
- **Anti-obiettivi**: un errore che distingue «email inesistente» da
  «password sbagliata»; un modo di saltare il blocco; un dialogo di
  riconferma che non dice quale azione sta confermando; i codici di
  backup che ricompaiono dopo «Continue»; un'illustrazione o un pannello
  promozionale accanto al login.

## 5. Stati e intervalli

| Schermata | Caricamento | Errore | Altri stati |
|---|---|---|---|
| Login | bottone «Signing in…» | credenziali (frase unica) · livello dati + Retry | persona disattivata = credenziali |
| Secondo fattore | «Verifying…» | codice sbagliato con tentativi · passkey fallita | bloccato fino alle HH:MM |
| Registrazione | scheletro | livello dati + Retry | valido · scaduto · revocato · usato · sconosciuto |
| Primo avvio | «Creating…» | livello dati + Retry | solo a istanza vuota |
| Riconferma | «Confirming…» | come il secondo fattore | iscrizione in 3 passi · annullata |

- Nomi lunghi nell'invito: ellissi a una riga, intero nel `title`. Fino a
  8 progetti offerti in elenco; oltre, i primi 6 e «and 4 more» che apre il
  resto in posto.
- Testi in italiano più lunghi: i bottoni non hanno larghezza fissa, la
  colonna da 400px va a capo.

## 6. Interazione e layout

- Ordine di tabulazione: campi → bottone → link degli altri modi →
  riquadro del prototipo.
- Il passaggio fra login e secondo fattore è una dissolvenza di 200ms sul
  blocco centrale (il logo resta fermo); nulla sotto reduced-motion.
- Dialogo: Esc = Cancel; Invio nel campo = Confirm; il fuoco è intrappolato
  nel dialogo e torna al controllo d'origine.
- **1024×680**: la colonna resta 400px; il blocco sale a 64px dall'alto
  invece che a un terzo, così login + riquadro del prototipo stanno senza
  scorrere. Il dialogo di riconferma resta 440px; nel passo 3
  dell'iscrizione i codici restano su due colonne e il dialogo scorre
  dentro di sé se l'altezza non basta.

## 7. Vincoli

- Solo via `data/queries.ts` (`login`, `loginSecondFactor`, `getInvite`,
  `register`, `isInstanceEmpty`, `createFirstAdmin`, `reauthenticate`,
  `enrollDuringReauth`, `logout`, `resetToEmptyInstance`).
- `useReauth()` riconosce `reauth_required` da **qualunque** funzione e ne
  conserva gli argomenti per ripeterla; nessuna pagina scrive un dialogo
  suo.
- Testi en/it con parità; le frasi di partenza sono quelle di `auth.*` del
  web, riscritte senza i commenti in stile terminale («// …»).
- Riuso: riquadro «Prototype only», toast, dialogo modale e conferma a due
  tempi esistenti; il QR è una funzione pura del prototipo.

## Scelte del brief

1. **[IN 1]** Una colonna sola centrata, senza card né immagini, per tutte
   le schermate d'ingresso.
2. **[IN 2]** Il riquadro «Prototype only» del login elenca le persone
   attive del seme come link che riempiono email e password (non inviano).
3. **[IN 3]** Il dialogo di riconferma nomina l'azione che sta per
   ripartire, e la ripete da solo dopo il codice.
4. **[IN 4]** Il contatore dei tentativi rimasti compare dal secondo
   errore.
5. **[IN 5]** L'iscrizione al volo sta dentro lo stesso dialogo, in tre
   passi, e i codici di backup chiedono «I've saved them» prima di
   proseguire.
6. **[IN 6]** «Sign out» e i due reset del prototipo in fondo al menu del
   profilo, i reset con conferma a due tempi.

## Scelte di dettaglio (del controller, 29 ott 2026)

1. **Login senza card**: logo, titolo e campi direttamente sul fondo, una
   colonna da 400px a un terzo dall'alto **[IN 1]**.
2. **Entrare come una persona del seme con un clic** che riempie il modulo
   (si preme comunque «Sign in», e il codice si scrive) **[IN 2]**.
