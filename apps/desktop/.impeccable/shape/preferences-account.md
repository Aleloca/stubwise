# Shape brief — Preferenze personali: Account, Security, Tokens, Claude Code, Language & theme

Superficie: le sezioni delle **Preferenze** accanto a Notifiche (area 8a,
`alerts.md`), ognuna una pagina sua sotto `/preferences/$section`:
`account`, `security`, `tokens`, `claude-code`, `look`. Il componente
riusabile **`SecretOnce`** (valore mostrato una volta), che 9b e 9c
riprendono. Piano 9a: Task 7 (dati: Task 5; riconferma: Task 3). Spec area
9: «Preferenze personali», «La riconferma», anti-obiettivo «Un segreto che
ricompare». Inventario: sezione A. Web di riferimento (cosa si porta, non
come appare): `apps/web/src/routes/settings/{account,security,access-tokens,claude-code}.tsx`,
chiavi `settings.account|security|accessTokens|claudeCode`. Mondo:
«Catalogo numerato», modalità **Operate**. Scelte del brief **[PR n]**,
raccolte in fondo.

## 1. Lavoro e pubblico

- **Chi**: ogni persona, per sé. Nessuna sezione dipende da un permesso:
  sono le cose **mie**.
  - **Chi non è tecnico** (Giulia, Sara, Matteo): cambia la foto o la
    password, collega la sua casella Gmail, attiva il secondo fattore
    quando glielo chiedono. Non sa cos'è un token.
  - **Chi usa Claude Code** (Marco, Laura, ma anche Giulia in «modalità
    collaboratore»): crea il comando d'installazione, lo incolla nel
    Terminale, poi dimentica.
  - **Chi è prudente** (Roberta): controlla le sessioni aperte, le
    passkey, il registro della sicurezza.
- **Stato d'animo**: compito puntuale, raramente urgente; con i segreti,
  attenzione («lo copio ora o lo perdo»).

## 2. Esito e prova

- **Azioni primarie**: cambiare dati e password; collegare/scollegare le
  caselle Google e scegliere per ognuna se fa proposte; attivare e gestire
  il secondo fattore; chiudere una sessione; creare e revocare un token;
  creare il comando di Claude Code.
- **Successo**, a 1440×900:
  - in Security leggo in una riga se sono protetta e come: «On ·
    authenticator app, 2 passkeys, 7 backup codes left»; Sara legge «Off.
    You'll be asked to set it up before your first sensitive action.» e un
    bottone **Set up now**;
  - creo un token e lo vedo **una volta**, con **Copy** e la frase «Shown
    only now»; tornando alla pagina c'è solo il nome;
  - il comando di Claude Code si copia in un clic e sotto ci sono le
    quattro domande da fare a Claude;
  - una casella Google che ha perso l'accesso dice perché, in parole, e
    offre **Reconnect** sulla stessa riga.
- **Verità del prodotto**:
  - **token, comando di Claude Code, segreto TOTP e codici di backup si
    vedono una volta**: lasciata la pagina, non tornano nel DOM (`SecretOnce`
    smonta il valore);
  - **il cambio password chiude le altre sessioni**, e lo dice prima;
  - **il secondo fattore non si spegne**: si sostituisce un metodo, non lo
    si toglie (come il web: «It stays on: you can replace a method, not
    turn it off.»). L'ultima passkey si toglie solo se c'è l'app;
  - **chi collega una casella accetta che le email vadano all'analisi
    AI**: la frase del web resta, nel dialogo di collegamento.

## 3. Direzione scelta

- **Tesi**: **ogni sezione è una pagina del registro personale**, con la
  stessa cornice di Notifiche: h1 28px, una riga in prosa `ink-muted`,
  poi parti separate da filetti con titolo `headline` 20px. Nessuna card:
  righe e filetti. Le azioni stanno a destra della riga a cui si
  riferiscono **[PR 1]**.
- **Colonna delle Preferenze** (240px, nessun titolo): Notifications ·
  Account · Security · Tokens · Claude Code · Language & theme. Accanto a
  «Security», 12px `ink-faint`, «Off» quando il secondo fattore è spento
  (solo testo: niente punto «ti aspetta», non è una decisione).
- **Momento focale**: in Security, la **riga di stato** in testa; nelle
  pagine con segreti, il blocco `SecretOnce`.
- Larghezza del contenuto: fino a 720px (sono moduli e righe brevi).

```
┌──────────────┬──────────────────────────────────────────────────────────┐
│ Notifications│ Security                                                 │
│ Account      │ Two-step verification protects your sign-in and the      │
│ Security     │ actions that change who can do what.                     │
│ Tokens       │                                                          │
│ Claude Code  │ ✓ On · authenticator app, 2 passkeys, 7 backup codes left│
│ Language & t.│ ──────────────────────────────────────────────────────── │
│              │ Authenticator app                                        │
│              │ Set up on Sep 3.                          [Reconfigure]  │
│              │ ──────────────────────────────────────────────────────── │
│              │ Passkeys                                  [Add passkey]  │
│              │ MacBook Pro      Added Sep 3 · used today     Rename  ⋯  │
│              │ YubiKey          Added Sep 9 · used Oct 2     Rename  ⋯  │
│              │ ──────────────────────────────────────────────────────── │
│              │ Backup codes                                             │
│              │ 7 of 10 left.                          [Make new codes]  │
│              │ ──────────────────────────────────────────────────────── │
│              │ Open sessions                                            │
│              │ Stubwise for macOS · this device      Active now         │
│              │ Stubwise mobile · iPhone              2 h ago   Sign out │
│              │ ──────────────────────────────────────────────────────── │
│              │ Security log                                             │
└──────────────┴──────────────────────────────────────────────────────────┘
```

### `SecretOnce` — il valore mostrato una volta

- Blocco a tutta larghezza della parte: fondo `ink/4`, filetto `rule`,
  raggio 6px; il valore in **monospace** 13px (l'eccezione «token e
  chiavi»), selezionabile, che va a capo dentro il blocco; **Copy** in alto
  a destra (dopo il clic diventa «Copied» per 2 secondi, e toast «Copied»).
- Sopra il blocco, 13px, con glifo ▲ `warning`: «Copy it now. It's shown
  only this time: once you leave, it can't be seen again.» (la frase vale
  per token, comando, chiave TOTP, codici di backup, e in 9a anche per il
  link d'invito e di reset in `admin-people.md`).
- Sotto: **Done** (secondario). Done, un'altra sezione o un'altra pagina →
  il blocco sparisce e il valore non è più nel DOM. Nessuna conferma
  all'uscita **[PR 2]**.
- Copia non disponibile (prototipo senza appunti): il valore si seleziona
  da solo e la riga dice «Select and copy it with ⌘C.»

### Account

- Riga in prosa: «Your name, photo and password, and the mailboxes
  Stubwise reads for you.»
- **Profile**: avatar 56px (foto o iniziali sul colore del reparto, come
  nel binario) con **Change photo** (sceglie un file locale: resta in
  memoria, nessun caricamento) e **Remove photo** se c'è; **Name** ed
  **Email** come campi; **Save** compare solo con una modifica, accanto a
  **Cancel**; dopo: «Saved» 2 secondi. Email non valida: «Enter a full
  email address.» sotto il campo.
- **Password**: **Current password** · **New password** · **Confirm new
  password** · **Change password**. Sopra il bottone, 13px `ink-muted`:
  «Your other sessions — the mobile app and other computers — will be
  signed out. This one stays open. Access tokens keep working.» Errori in
  parole: «The current password is wrong.» · «The passwords don't match.»
  · «Use at least 8 characters.» Dopo: «Password changed. 2 other
  sessions were signed out.» (con link «See sessions» a Security).
- **Followed projects**: una riga sola: «You follow 12 projects. You get
  their notifications.» · link **Manage in All projects** (porta ad All
  projects filtrato sui seguiti; la stella resta lì) **[PR 3]**.
- **Google mailboxes**: riga in prosa «Stubwise reads Gmail and Calendar
  from these mailboxes, read-only, and turns what needs doing into
  proposals.»
  - Una riga per casella (44px): indirizzo · Workspace (13px `ink-muted`)
    · stato in parola con glifo («Connected · synced 5 min ago»; ▲
    `warning` «Needs reconnecting: access was revoked on Google») ·
    interruttore **Proposals** (etichetta visibile, `aria-describedby` con
    «Turns emails and events from this mailbox into proposals.») · a
    destra **Reconnect** (solo se serve) e «⋯» con **Disconnect…**
    (conferma a due tempi in posto: «Disconnect — sure?»; sotto, «Mail and
    Calendar stop showing this mailbox. Proposals already made stay.»).
  - **Connect a mailbox**: dialogo 480px — scelta del Workspace (se ce n'è
    più d'uno), la frase del consenso del web in un paragrafo a sé, poi
    **Continue on Google**. Nel riquadro «Prototype only» del dialogo: «What
    Google answers:» con gli esiti del web (Connected · Wrong domain ·
    Permissions left out · Mailbox owned by someone else · Failed). L'esito
    negativo si scrive nel dialogo con la frase del web e **Try again**.
  - Vuoto: «No mailbox connected. Connect one to see your mail and
    calendar in Stubwise.» · **Connect a mailbox**.
  - Nessun Workspace sull'istanza: «Google isn't set up on this instance
    yet.» e un link **Who can?** (vedi `admin-audit.md`) che risponde «chi
    gestisce le integrazioni». Il bottone di collegamento non c'è.
  - Lo stato è lo stesso che leggono Mail e Calendar: scollegare qui cambia
    anche là.

### Security

- Riga in prosa: «Two-step verification protects your sign-in and the
  actions that change who can do what.»
- **Riga di stato** in testa (16px, 600): ✓ `positive` «On · authenticator
  app, 2 passkeys, 7 backup codes left» · oppure ○ «Off» + «You'll be
  asked to set it up before your first sensitive action.» + **Set up now**
  (apre la configurazione dell'app qui sotto, non il dialogo).
- **Authenticator app**: «Set up on Sep 3.» · **Reconfigure** (riconferma).
  La configurazione si apre **in posto** sotto la riga (non in un
  dialogo): QR 160px con «Prototype: this QR code is made up.», «Can't
  scan? Enter this key» in `SecretOnce`, campo del primo codice,
  **Confirm** · **Cancel**. Durante una riconfigurazione: «Until you
  confirm, your current app keeps working.» Dopo: «Authenticator app
  updated. Codes from the previous one no longer work.» Per chi la attiva
  per la prima volta, dopo **Confirm** si aprono subito i codici di backup
  (in `SecretOnce`, 10 codici su due colonne, **Download**).
- **Passkeys**: righe (40px) nome · «Added Sep 3 · used today» ·
  **Rename** (campo in posto, Invio salva, Esc annulla; nessuna
  riconferma) · «⋯» → **Remove…** (riconferma, poi conferma a due tempi
  in posto). **Add passkey** apre in posto un campo «Name this passkey»
  (esempio «MacBook, YubiKey») e **Continue** → riconferma → nel prototipo
  il riquadro «Simulate passkey» / «Simulate a failed passkey». Fallita:
  «The passkey wasn't created. Try again.» Vuoto: «No passkeys yet. A
  passkey signs you in with your fingerprint, face or a security key.»
  L'ultima passkey senza app: «Remove» spento con «Set up the
  authenticator app first: two-step verification can't be turned off.»
- **Backup codes**: «7 of 10 left.» (3 o meno: ▲ `warning` «Few codes
  left. Make new ones and keep them safe.») · **Make new codes**
  (riconferma; poi la frase «The current codes stop working right away.»
  e **Make new codes** di nuovo come conferma a due tempi) → `SecretOnce`
  con i 10 codici, **Download**, **Copy**.
- **Open sessions**: una riga per sessione: dispositivo in parole
  («Stubwise for macOS», «Stubwise mobile · iPhone», «Browser · Chrome on
  Windows») · «this device» per quella corrente · ultimo uso · **Sign out**
  sulle altre (senza conferma: è reversibile rientrando). Una sola
  sessione: la riga corrente e «No other sessions.»
- **Security log**: gli ultimi 10 eventi, una riga ciascuno: data e ora in
  cifre tabellari · frase dal catalogo del web («Signed in», «Passkey
  added», «Backup code used», «Two-step verification reset by Roberta
  Fontana»…) · **Show all** apre il resto in posto (fino a 90 giorni).
  Vuoto: «Nothing recorded yet.»
- Sara (spento): le parti Passkeys, Backup codes non si mostrano finché
  l'app non è configurata; restano Open sessions e Security log.

### Tokens

- Riga in prosa: «A personal access token lets a tool act as you — for
  example Claude Code with the Stubwise plugin. Treat it like a password.»
- **New token** in alto a destra apre in posto, sopra l'elenco: **Name**
  (esempio «my-laptop MCP») · **Expires** (facoltativo, data; vuoto =
  «Never»; nel passato: «Pick a date in the future.») · **Create token**
  (riconferma) → `SecretOnce` con `stw_pat_…` e sotto: «Use it as
  STUBWISE_TOKEN. To set up Claude Code with one command, use Claude
  Code.» (link alla sezione).
- **Elenco**: tabella a righe 40px — Name · Created · Expires («Never»,
  data, ▲ «Expired») · Last used («Never», relativo) · **Revoke** (conferma
  a due tempi in posto: «Revoke — sure?»). Un token creato dal comando di
  Claude Code ha il nome «Claude Code · Oct 29».
- Mai il valore, nemmeno troncato.
- Vuoto: «No tokens yet.» con **New token**.

### Claude Code

- Riga in prosa: «Use Stubwise from Claude Code: ask how a project works,
  report a problem, follow your requests.»
- **Before you start**, due righe con glifo ○: «Claude Code installed on
  your computer» · «Node.js 22 or later» (link al sito di Node, apre il
  browser).
- **Create the command** (riconferma, perché crea un token **[PR 4]**) →
  `SecretOnce` con il comando su più righe (stessa forma di
  `lib/sdk-install-guide.ts` del web) e sotto: «Paste it in Terminal on
  macOS or Linux. On Windows use PowerShell 7 or later.» e «It also created
  the token “Claude Code · Oct 29” — you'll find it in Tokens.»
- **What to ask Claude**: quattro righe-prompt copiabili, ognuna con
  **Copy** al passaggio: «How does…» · «I found a problem…» · «I wish I
  could…» · «Where are my requests at?»
- Rifare il comando ne crea uno nuovo con un token nuovo; quello vecchio
  resta finché non lo si revoca (la riga lo dice: «Your previous command
  keeps working until you revoke its token.»).

### Language & theme

- Due gruppi di scelta, gli stessi del menu del profilo: **Language**
  (English · Italiano, ognuna nel suo nome) e **Theme** (System · Light ·
  Dark). Si applicano subito. Sotto, 12px `ink-faint`: «Also in the
  profile menu.»

## 4. Ambito e confini

- **Dentro**: le cinque pagine, `SecretOnce`, i dialoghi di Google, le
  riconferme dichiarate (TOTP, aggiungi/rimuovi passkey, codici di backup,
  creazione di token e del comando).
- **Fuori**: DM Slack (sostituito); push mobile (è in Notifiche); stato e
  ruolo d'istanza della persona (è in People); cambio della propria email
  con verifica (si salva e basta).
- **Anti-obiettivi**: un token o un codice che si rivede; un «Disable
  two-step verification»; il consenso di Google nascosto; un elenco di
  token che mostra le ultime cifre (non esistono, nel web non ci sono).

## 5. Stati e intervalli

- **Caricamento**: ogni pagina mostra lo scheletro delle sue righe (3
  righe per parte) sotto il titolo; h1 e riga in prosa ci sono subito.
- **Errore di lettura**: al posto delle parti, «Couldn't load your
  security settings.» (frase per pagina) · **Retry**; la colonna resta.
- **Errore di scrittura**: sotto il controllo che l'ha fatta, ✕
  `critical` + frase («Couldn't revoke the token. Try again.») + **Retry**;
  lo stato in pagina non cambia.
- **`reauth_required`**: non è un errore in pagina: apre il dialogo di
  `entry.md` e, se annullato, il toast «Nothing was changed.»
- **Senza permessi**: nessuna parte è vietata; l'unico caso è Google senza
  Workspace (sopra).
- **Intervalli**: token 0–30 (oltre 10 la tabella scorre con la pagina,
  intestazione agganciata); caselle 0–4; passkey 0–6; sessioni 1–8;
  registro fino a 90 giorni. Nomi lunghi: ellissi, intero nel `title`.

## 6. Interazione e layout

- Le aperture in posto (nuovo token, aggiungi passkey, configurazione
  dell'app) spingono giù il resto con 200ms in altezza; il fuoco va al
  primo campo; Esc chiude e torna al bottone.
- Dopo una creazione, il fuoco va al titolo del blocco `SecretOnce`
  (annunciato), così lo screen reader legge la frase «shown only now».
- **1024×680** (720px utili, il contenuto è già fino a 720): nessun
  cambio di struttura; nella tabella dei token **Last used** scende sotto
  il nome come seconda riga 12px; nelle caselle Google lo stato va su una
  seconda riga e l'interruttore resta a destra.

## 7. Vincoli

- Solo via `data/queries.ts` (`updateProfile`, `changePassword`,
  `listMyMailboxes`, `connectMailbox`, `reconnectMailbox`,
  `disconnectMailbox`, `setProposals`, `getMySecurity`, `startTotpSetup`,
  `confirmTotp`, `addPasskey`, `renamePasskey`, `removePasskey`,
  `regenerateBackupCodes`, `endSession`, `listTokens`, `createToken`,
  `revokeToken`, `createClaudeCodeCommand`).
- `PREFERENCE_SECTIONS` diventa `["notifications", "account", "security",
  "tokens", "claude-code", "look"]`; via il `Placeholder`.
- Testi en/it con parità, dalle chiavi del web senza i commenti «// …».
- **Nota per il piano**: `createClaudeCodeCommand` crea un token, ma nel
  Task 5 non è marcata **+R** mentre `createToken` sì. Il brief la tratta
  come delicata **[PR 4]**: se confermato, va aggiunta a
  `REAUTH_REQUIRED` e al test del registro.

## Scelte del brief

1. **[PR 1]** Ogni sezione è una pagina con la cornice di Notifiche: parti
   separate da filetti, azioni a destra della riga.
2. **[PR 2]** `SecretOnce` sparisce con **Done** o lasciando la pagina,
   senza chiedere conferma.
3. **[PR 3]** I progetti seguiti sono una riga col conteggio e il link ad
   All projects, non un secondo elenco con le stelle.
4. **[PR 4]** Creare il comando di Claude Code chiede la riconferma come
   creare un token.
5. **[PR 5]** La configurazione dell'app di autenticazione si apre in
   posto, non in un dialogo; i codici di backup seguono subito alla prima
   attivazione.
6. **[PR 6]** «Off» accanto a Security nella colonna quando il secondo
   fattore è spento, solo come testo.

## Scelte confermate (29 ott 2026)

1. **Comando di Claude Code con riconferma** (crea un token) **[PR 4]**:
   confermata dal maintainer.
2. **Valore mostrato una volta che sparisce senza conferma** uscendo dalla
   pagina **[PR 2]**: scelta di dettaglio del controller.
