# Shape brief — La Cassaforte delle credenziali, e la chiave del Mac

Superficie: la sezione di progetto **Credentials**
(`#/p/<CODE>/credentials`), con il dettaglio di una credenziale, «Show» e
«Copy», i lettori (condividere, togliere), gli accessi da confermare e il
registro degli accessi; la **barra della cassaforte** in testa alla
sezione (chiusa, aperta, da associare, revocata, irraggiungibile); la
**finestra dell'associazione** del Mac con l'impronta da confrontare; la
parte **«Macs that open the vault»** in Preferenze → Security; la parte
**Vault** nella pagina di una persona in Amministrazione (l'admin che
toglie i Mac di un altro). Azioni ⌘K «Open the vault», «Lock the vault»,
«Pair this Mac».

Lotto 10, design `docs/plans/2026-11-24-cassaforte-desktop-design.md`
(approvato dal maintainer il 24 nov 2026: D-1…D-8, D-1a, D-1b) e
invarianti `docs/invariants/vault.md`. Il main è già fatto
(`apps/desktop/src/main/vault*.ts`, 10d6ae859): questa shape è la parte
che si VEDE, prima nel prototipo e poi nell'app. Web di riferimento (cosa
serve, non come appare): `apps/web/src/routes/credentials.tsx`,
`apps/web/src/components/vault/*`, chiavi `vault.*`. Mondo: «Catalogo
numerato», modalità **Operate**; l'impronta e la password sono i soli
testi monospace della superficie. Scelte del brief **[VA n]**, raccolte
in fondo; quelle che il maintainer deve decidere in «Da decidere».

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi legge** (Laura in ACQ, Developer con `credentials` in lettura):
    deve entrare in un pannello di un fornitore. Vuole la password **ora**,
    copiarla e tornare al lavoro. Non vuole sapere cos'è un sigillo.
  - **Chi condivide** (Laura con `credentials.share`): passa una
    credenziale a una persona o a un ruolo, toglie chi se n'è andato,
    conferma la chiave di una persona nuova **dopo averla sentita**.
  - **Chi amministra** (Roberta, full admin): toglie i Mac di una persona
    che ha perso il portatile.
- **Stato d'animo**: fretta e prudenza insieme. La password serve subito,
  ma si sta tirando fuori un segreto: la superficie deve far sentire che
  è **aperta solo adesso, solo qui**, senza spaventare.

## 2. Esito e prova

- **Azioni primarie**: (1) aprire la cassaforte (Touch ID); (2) mostrare o
  copiare una password; (3) associare questo Mac la prima volta; (4)
  condividere e confermare; (5) togliere un Mac.
- **Successo**, a 1440×900:
  - in Credentials, con la cassaforte chiusa, leggo **una riga** che dice
    come aprirla («Locked. Open with Touch ID.») e il bottone, senza
    dialoghi in mezzo;
  - aperta, «Show» mette la password al posto dei pallini **nella riga**,
    «Copy» la copia con «Copied. The clipboard is cleared in 30 seconds.»;
  - la prima volta, la finestra dell'associazione mi fa **confrontare
    quattro gruppi di cifre** fra il Mac e il browser, e dopo il ritorno
    la cassaforte è già aperta;
  - in Security vedo i Mac che aprono la mia cassaforte e ne tolgo uno.
- **Verità del prodotto** (mai ammorbidite):
  - **la password non resta sullo schermo**: si nasconde da sola (30 s) e
    a cassaforte chiusa; la copia si cancella dagli appunti dopo 30 s;
  - **ogni «Show» e «Copy» finisce nel registro** degli accessi, con «from
    the Mac» (D-8): la superficie lo dice una volta, sotto la barra
    («Every Show and Copy is recorded.»);
  - **il server non vede mai una password**: la frase del web resta nel
    modulo («Encrypted on this Mac: the server never sees it.»);
  - **confermare una chiave è una persona che garantisce un'altra**: la
    domanda «Did you check with … in person or on the phone?» non si
    accorcia;
  - **togliere un Mac non chiude la sessione** (D-5): il Mac resta
    collegato a Stubwise, ma non apre più la cassaforte.

## 3. Direzione scelta

- **Tesi**: **la cassaforte è una sezione del progetto con una barra di
  stato in testa**. La barra dice in una riga se è aperta e come aprirla;
  sotto, l'elenco delle credenziali come le altre liste del progetto
  (righe, filetti, niente card). Le cose rare (lettori, registro, accessi
  da confermare) si aprono nel pannello di destra, come il membro di
  `admin-roles-members.md` **[VA 1]**.
- **Momento focale**: la **riga con la password mostrata** — la password
  in monospace 15px al posto dei pallini, «Hide» e il conto alla rovescia
  in parola («Hides in 30 s»).

```
┌─ ACQ ─ Credentials ───────────────────────────────────────────────────────┐
│ Credentials                                         [New credential]      │
│ Passwords for the project's services. Only the people who read one see it.│
│ ┌───────────────────────────────────────────────────────────────────────┐ │
│ │ ● Open · locks after 15 minutes without use · Every Show and Copy is  │ │
│ │   recorded.                                                   [Lock]  │ │
│ └───────────────────────────────────────────────────────────────────────┘ │
│ ○ 2 people are waiting for access                         [Review]        │
│ ───────────────────────────────────────────────────────────────────────── │
│ Aruba hosting      admin@acquedotto     ••••••••••      Show  Copy   ⋯   │
│ Cloudflare         ops@acquedotto       Gq7#v2-Lm…pZ    Hide · hides in 23 s│
│ Mailgun            postmaster           ••••••••••      Show  Copy   ⋯   │
│ Stripe (test)      laura.costa          Waiting for confirmation          │
└───────────────────────────────────────────────────────────────────────────┘
```

### Dove si entra **[VA 2]**

- **Sezione di progetto «Credentials»** (`PROJECT_SECTIONS`, fra
  «Servers» e «Settings»): c'è solo se la cassaforte è attiva
  nell'istanza **e** chi guarda legge almeno una credenziale del progetto
  o ha `credentials.create` lì. La voce non porta numeri né punti; con
  accessi da confermare che chi guarda può confermare, il punto «ti
  aspetta» dell'area 1 (è una decisione di una persona).
- **Preferenze → Security**: la parte «Macs that open the vault»
  (sotto «Passkeys», sopra «Open sessions»).
- **Amministrazione → la pagina di una persona**: la parte **Vault**
  (sotto «Linked identities»), solo full admin.
- **⌘K**: «Open the vault» (Touch ID, da qualunque pagina), «Lock the
  vault» (aperta), «Pair this Mac» (non associato). Nessuna voce in barra
  laterale: la cassaforte non è una destinazione, è dentro i progetti.

### La barra della cassaforte

Una riga 44px con filetto `rule` e fondo `ink/3`, in testa alla sezione,
sotto la riga in prosa. Uno stato alla volta (dallo stato del main,
`vault:status`, e dalla cassaforte dell'istanza):

| Stato | Glifo e frase | Azione |
|---|---|---|
| aperta | ● `positive` «Open · locks after 15 minutes without use» + 12px «Every Show and Copy is recorded.» | **Lock** |
| chiusa, Touch ID | ○ «Locked.» | **Open with Touch ID** (primario) |
| chiusa, senza Touch ID (D-1a) | ○ «Locked. This Mac has no Touch ID: open the vault in the browser with your passkey.» | **Open in the browser** |
| da associare | ○ «This Mac doesn't open the vault yet. Pair it once with your passkey in the browser.» | **Pair this Mac** |
| revocata (D-5) | ▲ `warning` «This Mac no longer opens the vault. You're still signed in.» | **Pair again** |
| irraggiungibile | ▲ «Couldn't reach Stubwise to open the vault.» | **Try again** |
| tocco annullato | (resta «Locked.», nessun avviso: annullare è una scelta) | — |
| nessuna chiave | ○ «You don't have a vault key yet. Create it in the browser with a passkey: credentials shared with you reach you after a reader confirms it.» | **Open in the browser** |
| chiave in attesa | ○ «Your vault key is waiting for confirmation. A reader who can share confirms it when they pass you a credential.» (+ l'impronta della propria chiave, monospace) | — |
| non attiva | «The vault hasn't been activated on this instance yet.» (+ per l'admin: «Activate it in the browser.») | — |

- **Open with Touch ID**: il dialogo di sistema di macOS («Stubwise wants
  to open the vault»). Durante: il bottone «Opening…» con l'anello; il
  fuoco resta sul bottone. Riuscita: la barra passa ad «aperta» (200ms),
  il fuoco al primo «Show».
- **Open in the browser**: apre la pagina della cassaforte del web
  (`/credentials` del progetto) nel browser di sistema; la barra dice
  «Opened in the browser.» per 5 s. Il desktop resta chiuso: è il caso
  D-1a, deciso dal maintainer **[VA 3]**.
- La chiusura per tempo, stop o schermo bloccato riporta la barra a
  «Locked.» senza toast; una password mostrata torna pallini.

### L'elenco delle credenziali

- Righe 44px: **servizio** (600) · etichetta 12px `ink-muted` sotto il
  servizio se c'è · **utente** (13px) · **password** (pallini, 10, in
  monospace) · azioni a destra. Ordine alfabetico per servizio.
- **Show** / **Copy** (aperta) — spenti con `title` «Open the vault first»
  a cassaforte chiusa; un clic su uno dei due a chiusa apre il Touch ID e,
  riuscito, fa l'azione chiesta (un passo in meno) **[VA 4]**.
- **Show**: la password in monospace 15px nella riga, «Hide · hides in
  30 s» (la parola cambia ogni 5 s, nessun numero che scorre ogni
  secondo); dopo 30 s torna pallini. Una sola mostrata per volta.
- **Copy**: toast «Copied. The clipboard is cleared in 30 seconds.»; il
  main cancella gli appunti dopo 30 s **solo se** contengono ancora quella
  password **[VA 5]**.
- Stato di lettura al posto della password: «Waiting for confirmation»
  (la mia chiave aspetta una copia) · «You don't read this one» (chi
  gestisce senza leggere: vede la riga per gestirla, mai la password).
- **«⋯»** della riga (secondo i permessi del server): Edit · Readers ·
  Access log · Delete… (conferma a due tempi in posto, come il web).
- Clic sulla riga: apre il **dettaglio** nel pannello di destra (480px):
  servizio, etichetta, URL (link al browser), utente con **Copy**,
  password con Show/Copy, note («Notes aren't encrypted.» 12px
  `ink-faint`), poi le parti **Readers** e **Access log**.
- Vuoto: «No credentials in this project yet.» + **New credential** (con
  `credentials.create`).

### Nuova e modifica

- Pannello di destra, modulo: Service · Label · URL · Username · Password
  (con «Generate» che propone 20 caratteri) · Notes. Sotto Password, 12px:
  «Encrypted on this Mac: the server never sees it.»; sotto Notes:
  «Notes aren't encrypted: don't write secrets here.» In modifica:
  «Leave empty to keep the current password.»
- Creare non chiede la cassaforte aperta (il PAT crea già oggi); cambiare
  la password sì (le copie per i lettori le fa il main con la chiave).
- Esito «recipients changed» (409 del server): «Someone's access changed
  while you were saving. Saved again for the current readers.» (il main
  rifà le copie e risalva, una volta) **[VA 6]**.

### Readers (condividere e togliere)

- Nel dettaglio, la parte **Readers**: «Who reads it» (lettori effettivi,
  con la fonte: «role Developer», «full admin», «created it») e «Added
  directly» con **Remove** sulle righe dirette (`credentials.share`).
  Ogni persona in attesa porta il perché in parola («waiting: no vault
  key yet», «waiting: their key needs confirmation», «waiting for a copy
  of the key»).
- **Share with**: un campo che cerca persone e ruoli del progetto («All
  Developers») · **Share**. Serve la cassaforte aperta (la prova della
  propria chiave e le copie le fa il main). Fatto: toast «Shared with
  Marco.» o «Waiting for confirmation: marco@….»
- **Remove**: conferma a due tempi in posto, poi la frase del web, che
  non si toglie: «Marco no longer reads this credential. If he saw the
  password, change it on the service and here.» + **Change the password**.

### Accessi da confermare

- Riga sotto la barra (solo per chi può confermare, con accessi in
  attesa): ○ «2 people are waiting for access» · **Review**. Apre il
  pannello di destra con una scheda per persona: nome ed email · «Key
  created on Nov 22, 10:12» · «Device: Chrome on macOS» · **impronta
  della chiave** in monospace 15px, quattro gruppi · «3 credentials».
- **Confirm** → conferma a due tempi con la domanda intera: «Did you
  check with Marco, in person or on the phone, that this key is his
  (date, device, fingerprint)?» · **Yes, I checked: confirm** **[VA 7]**.
  Esiti in parola (dal web): «Marco now reads 3 credentials.» · «1
  credential changed in the meantime: confirm again.» · «1 credential you
  can't pass on waits for another reader.»
- **Reject** → «Reject Marco's key? It receives nothing, and he'll have
  to create a new one.» · **Yes, reject the key** (`critical`).

### Access log

- Nel dettaglio (una credenziale) e dal «⋯» della sezione (tutto il
  progetto): righe con data e ora in cifre tabellari · chi · azione
  («shown», «copied») · **da dove**: «from the Mac» / «from the browser»
  (D-8). Vuoto: «Nobody has shown or copied a password yet.»

### La finestra dell'associazione (Pair this Mac)

Dialogo 520px, tre momenti nello stesso dialogo **[VA 8]**:

```
Pair this Mac
This Mac will open your vault with Touch ID. You confirm it once, in the
browser, with your passkey.

  This Mac's key
  3f9a 1c2e 07d4 91be                      ← monospace 24px, cifre tabellari

  1  The browser opens Stubwise.
  2  Check that it shows the same four groups.
  3  Choose "Pair this Mac" there.

  ◌ Waiting for the browser…  expires in 10 minutes        [Cancel]
```

- **Pair this Mac** (dalla barra o ⌘K): il main chiede l'accoppiamento e
  apre il browser; il dialogo mostra l'impronta e i tre passi, e «Waiting
  for the browser…» con l'anello.
- **Riuscita** (ritorno `stubwise://vault`): «This Mac opens your vault.»
  con ✓, la barra già aperta sotto (D-1b: senza Touch ID questa volta);
  **Done** chiude.
- **Fallita**, in parola, con **Try again**:
  - scaduta: «The pairing expired. Start again.»;
  - sigillo che non si apre: «The browser's answer didn't match this
    Mac. Nothing was saved. Start again.»;
  - cifratura di sistema assente: «This Mac can't keep the key safely
    (no system keychain). Open the vault in the browser.»;
  - un altro login nel frattempo: «You signed in again meanwhile. Start
    again.»
- Chiudere il dialogo durante l'attesa = **Cancel** (la richiesta si
  dimentica, niente su disco).

### Preferenze → Security: «Macs that open the vault»

- Parte con titolo `headline`, riga in prosa: «These Macs open your vault
  with Touch ID. Removing one doesn't sign it out.»
- Righe 40px: nome del Mac («MacBook Pro di Laura») · «this Mac» per il
  corrente · «Paired Nov 24 · used today» · impronta breve 12px
  monospace (`3f9a…91be`, intera nel `title`) · azione a destra.
- **Questo Mac**: **Forget this Mac** → conferma a due tempi in posto:
  «This Mac stops opening the vault. You stay signed in.» → fatto: la
  riga sparisce; se il server non risponde, «Forgotten on this Mac. The
  server didn't answer: remove it from the browser too.»
- **Un altro Mac**: **Remove** apre la stessa pagina nel browser (la
  rotta è del browser, §6.3 del design) **[VA 9]**.
- Vuoto: «No Mac opens your vault yet.» + **Pair this Mac**.

### Amministrazione → una persona: Vault (D-6)

- Parte **Vault** (solo full admin): «Marco's Macs that open the vault»
  con le stesse righe (senza impronta) e **Remove…** per riga.
- **Remove…** → dialogo 440px «Remove Marco's MacBook Pro from the
  vault?» con le conseguenze, una per riga: «That Mac stops opening the
  vault.» · «Marco stays signed in on it.» · «Marco gets a security
  alert, and it's recorded in the change log.» → **Remove** (`critical`)
  → riconferma → toast «Removed. Marco was told.»
- Dal desktop la rotta dell'admin è del browser come la propria **[VA
  9]**: **Remove…** apre la pagina della persona nel browser.

### Prototype only

- Riquadro tratteggiato dell'8a sotto la barra: «Next Touch ID:» · «Works»
  · «Cancelled» · «This Mac has no Touch ID»; «Next opening:» · «Works» ·
  «Seal revoked» · «Stubwise unreachable»; «Pairing:» · «Return from the
  browser» · «Expire» · «Seal doesn't match». Frase: «This decides what
  happens next. Nothing is encrypted in the prototype.»

## 4. Ambito e confini

- **Dentro**: sezione Credentials (elenco, dettaglio, nuova e modifica,
  Show/Copy, Readers, accessi da confermare, Access log), barra con i
  dieci stati, finestra dell'associazione, parte di Security, parte
  Vault dell'admin, ⌘K, riquadro «Prototype only».
- **Fuori** (restano del browser, D-7): attivare la cassaforte, il kit di
  recupero e la sua rotazione, creare o ricreare la propria chiave,
  sigillare un Mac; togliere un ALTRO Mac (§6.3, **[VA 9]**).
- **Anti-obiettivi**: una password nel DOM a cassaforte chiusa; una
  password che resta mostrata dopo la chiusura; «Show» che apre un
  dialogo modale con la password; un contatore che scorre ogni secondo;
  la domanda della conferma accorciata a «Confirm?»; l'impronta in un
  tooltip soltanto.

## 5. Stati e intervalli

- **Lista**: 0–60 credenziali per progetto (scorre); servizio lungo va a
  capo in due righe, utente troncato con `title`.
- **Lettori**: 1–30 effettivi; ruoli e persone mescolati, i ruoli prima.
- **In attesa**: 0–5 persone; il conto nella riga «N people are waiting».
- **Caricamento**: scheletro dell'elenco (3 righe); la barra ha il suo
  stato «Checking the vault…».
- **Errore** della sezione: «Couldn't load credentials» + **Retry**.
- **Cambio di persona** (prototipo, «vedi come»): la cassaforte si chiude
  (è di chi la apre).

## 6. Interazione e layout

- La sezione occupa la colonna del progetto (fino a 1120px); il pannello
  di destra 480px come gli altri del progetto.
- Fuoco: dopo l'apertura al primo **Show**; dopo «Show» resta sul bottone
  (diventato «Hide»); la password mostrata è annunciata solo come «Password
  shown» (`aria-live="polite"`), mai letta ad alta voce.
- **Movimento**: barra 200ms al cambio di stato; nulla sotto
  reduced-motion.
- 1024×680: l'utente va sotto il servizio, le azioni restano a destra.

## 7. Vincoli

- Solo via `data/queries.ts` (credenziali, lettori, accessi in attesa,
  registro) e, per la cassaforte, una facciata `vault` che nel prototipo
  finge il main e nell'app chiama `window.stubwise.vault` (stato, apri,
  chiudi, associa, dimentica; Show, Copy, condividi e conferma passano
  dal main). La UI non deduce lo stato: lo legge.
- Permessi dal server (`credentials.create|edit|share`, full admin), mai
  dedotti.
- Testi en/it con parità.
- Riuso: righe e filetti delle liste di progetto, pannello di destra,
  conferma a due tempi, dialoghi e toast esistenti, `SecretOnce` no (la
  password non è un segreto «mostrato una volta»).

## Scelte del brief

1. **[VA 1]** Sezione del progetto con una barra di stato in testa; il
   raro nel pannello di destra.
2. **[VA 2]** Si entra dalla sezione di progetto, da Security, dalla
   pagina della persona e da ⌘K; nessuna voce in barra laterale.
3. **[VA 3]** Senza Touch ID, «Open in the browser» (D-1a).
4. **[VA 4]** Show/Copy a cassaforte chiusa aprono il Touch ID e fanno
   l'azione.
5. **[VA 5]** Gli appunti si cancellano dopo 30 s, solo se contengono
   ancora la password.
6. **[VA 6]** «Recipients changed» si risolve da solo una volta.
7. **[VA 7]** La domanda della conferma intera, come nel web.
8. **[VA 8]** L'associazione in un dialogo con l'impronta grande e tre
   passi.
9. **[VA 9]** Togliere un altro Mac (proprio o di un altro) si fa dal
   browser.

## Da decidere (per il maintainer)

| # | Domanda | Raccomandazione |
|---|---|---|
| VA-Q1 | **Dove sta la cassaforte nel layout?** (a) una sezione di ogni progetto, «Credentials», come nel web; (b) una destinazione in barra laterale, «Vault», con tutte le credenziali che leggo, filtrabili per progetto; (c) tutte e due. | **(a)**: le credenziali sono del progetto (permessi e lettori stanno lì), e la barra laterale resta dei posti dove si lavora ogni giorno. «Le mie credenziali» del web diventa una ricerca ⌘K («Find a credential») invece di una pagina. |
| VA-Q2 | **Show e Copy a cassaforte chiusa**: spenti finché non apro, o aprono il Touch ID e poi fanno l'azione? | **Aprono il Touch ID e fanno l'azione** [VA 4]: chi clicca «Copy» vuole la password, non un passo in più. |
| VA-Q3 | **La password mostrata si nasconde da sola dopo 30 s?** Il web la lascia finché non si preme «Hide». | **Sì, 30 s**, come la copia negli appunti: il Mac resta sulla scrivania più a lungo di una scheda del browser. |
| VA-Q4 | **Togliere un ALTRO Mac dal desktop.** D-7 dice «dal desktop tutto come nel browser», ma il §6.3 del design lascia al browser il sigillo di un altro dispositivo (anche per l'admin). Dal desktop: (a) «Remove» apre il browser; (b) si toglie da qui (serve una rotta del PAT desktop in più, 72). | **(a)**: un Mac rubato e aperto non deve poter staccare gli altri Mac del proprietario, e la rotta resta una sola. Se il maintainer intende D-7 alla lettera, è (b) e lo dico a 72. |
| VA-Q5 | **Il registro dice «from the Mac» anche a chi guarda il registro del progetto, o solo all'admin?** | **A tutti quelli che vedono il registro**: è un fatto, e serve proprio a chi condivide. |
| VA-Q6 | **«Generate» nella password nuova**: lo mettiamo (il web non ce l'ha)? | **Sì**, 20 caratteri con simboli; è il momento in cui si sceglie una password. Se si preferisce la parità col web, si toglie. |
