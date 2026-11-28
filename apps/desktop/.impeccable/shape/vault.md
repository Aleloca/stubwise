# Shape brief — La Cassaforte delle credenziali, e la chiave del Mac

Superficie: la sezione di progetto **Credentials**
(`#/p/<CODE>/credentials`) e la pagina unica **Vault** (`#/vault`, tutte
le credenziali che chi guarda vede, filtrabili per progetto), con il dettaglio di una credenziale, «Show» e
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
in fondo; le decisioni del maintainer (25 nov 2026) nella tabella finale.

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
  in monospace 15px al posto dei pallini, e «Hide» accanto. Resta finché
  non la si nasconde (VA-Q3, maintainer), o finché la cassaforte non si
  chiude.

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
│ Cloudflare         ops@acquedotto       Gq7#v2-Lm…pZ    Hide  Copy   ⋯   │
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
- **La pagina unica «Vault»** (VA-Q1 «Entrambe», maintainer, 25 nov
  2026): una **destinazione della barra laterale**, `#/vault`, subito
  dopo «Drive» — come il Drive raccoglie i file di tutti i progetti, la
  Vault raccoglie le credenziali di tutti i progetti, con lo stesso filtro
  per progetto. La voce c'è solo se la cassaforte è attiva e chi guarda
  legge (o aspetta) almeno una credenziale, o può crearne in almeno un
  progetto; il punto «ti aspetta» come la sezione, per gli accessi da
  confermare **[VA 2]**.
- **⌘K**: «Open the vault» (Touch ID, da qualunque pagina), «Lock the
  vault» (aperta), «Pair this Mac» (non associato), «Find a credential»
  (apre la Vault con la ricerca).

### La pagina unica «Vault»

- Stessa cornice della sezione: h1 «Vault», riga in prosa «Every
  credential you can read, in all your projects.», la **barra della
  cassaforte**, la riga degli accessi da confermare (di tutti i progetti).
- Sopra l'elenco: campo di ricerca (servizio, etichetta, utente) e il
  **filtro per progetto** del Drive (scelta multipla coi codici; vuoto =
  tutti). Il filtro sta nell'indirizzo (`?project=ACQ,MKX`).
- Le righe sono quelle della sezione con in più, prima del servizio, il
  **codice del progetto** (cifre tabellari 600, link alla sezione
  Credentials del progetto). Ordine: progetto, poi servizio.
- **New credential** chiede prima il progetto (solo quelli dove chi guarda
  ha `credentials.create`); con un solo progetto possibile lo prende da
  sé. Il dettaglio, i lettori, il registro: lo stesso pannello di destra.
- Vuoto: «You can't read any credential yet.»; con un filtro che non
  trova niente: «No credentials in these projects.»

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
| nessuna chiave | ○ «You don't have a vault key yet. Create it in the browser with a passkey: credentials shared with you reach you after a reader confirms it.» | **Open in the browser** (Mac) · **Create your key** (build web): la pagina a sé, `/app/vault/#/setup` |
| chiave in attesa | ○ «Your vault key is waiting for confirmation. A reader who can share confirms it when they pass you a credential.» (+ l'impronta della propria chiave, monospace) | — |
| non attiva | «The vault hasn't been activated on this instance yet.» (+ per l'admin, sul Mac: «Activate it in the browser.») | al full admin: **Open in the browser** (Mac) · **Activate the vault** (build web), `/app/vault/#/setup`; agli altri — |

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
- **Show**: la password in monospace 15px nella riga e **Hide** al posto
  di «Show». Resta mostrata finché non si preme **Hide**, come nel web
  (VA-Q3, maintainer): torna pallini da sola solo quando la cassaforte si
  chiude. Più password possono essere mostrate insieme.
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
  · Notes (niente «Generate»: VA-Q6, maintainer). Sotto Password, 12px:
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
  Developers») · **Share**. Per ora (25 nov 2026, 94 con 46) è una select
  con persone e ruoli: diventa cercabile sopra una ventina di voci (voce nel
  registro dei rimandi, area 9). Non serve la cassaforte aperta: Share
  chiede il SUO Touch ID nel main (un tocco per azione, review M7, 25 nov
  2026), che apre il sigillo per sé, fa la prova della propria chiave e le
  copie, e lascia la cassaforte com'era. Annullare il tocco non dice niente;
  da associare, revocata o senza Touch ID il bottone è spento («Open the
  vault first») e la barra dice cosa fare. Lo stesso vale per Remove,
  Confirm e Reject. Solo chi LEGGE la credenziale condivide e toglie (serve
  la propria copia). Fatto: toast «Shared with Marco.» o «Waiting for
  confirmation: marco@….»
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

### La pagina a sé della cassaforte (fase 2, revisione I-2)

Un documento suo, **fuori dall'app**: `vault.html` (`vaultPage/`), servito
su `/app/vault/` con la sua CSP stretta; ci si entra SEMPRE con una
navigazione completa (la barra, «Use for the vault» in Security, il Mac),
mai cambiando il frammento dell'app. Niente binario, colonna, chat, posta,
riquadro di Claude, né il livello dati dell'app: la colonna da 432px come
l'ingresso, il logo, la pagina, e in fondo i rimandi («Back to Stubwise»,
le altre pagine). Senza sessione: il login dell'app, e poi il ritorno qui.
La riconferma è un riquadro «Confirm it's you» nella pagina (la passkey, o
il codice se non ce n'è una), non il dialogo dell'app. Passi e testi sono
quelli del web vecchio (`apps/web/src/routes/vault-setup.tsx`,
`vault-recovery.tsx`, `vault-pair.tsx`), coi token dell'app.

- **`#/setup` — non attiva**: al full admin «Generate the recovery kit» →
  il kit, mostrato **una volta** (monospace, «Print», «Download»,
  l'avvertenza in `critical`) → la casella «I printed/saved the kit»
  abilita «Activate the vault» → la passkey (una senza PRF ferma tutto
  PRIMA di attivare), la riconferma se serve, e la chiave di chi attiva.
  Agli altri: «The vault hasn't been activated on this instance yet. A full
  admin activates it here.»
- **`#/setup` — attiva**: la propria chiave — «Create your key» (nessuna),
  la frase dell'attesa (in attesa), «You have a vault key.» (confermata);
  se nessuna passkey la apre più, l'avviso in `critical` e «Recreate the
  vault key». Al full admin con la chiave confermata, «Regenerate the
  recovery kit» (l'anteprima prima del kit: con credenziali senza la
  propria copia l'elenco e niente kit; la sostituzione vuole la cassaforte
  aperta, e se è chiusa la apre con la passkey).
- **`#/recover`** (solo full admin): il testo incollato lascia subito la
  pagina; poi una scheda per persona in attesa (email, chiave e
  dispositivo, impronta monospace, quante credenziali, «Confirm with the
  kit», con un tocco della passkey per ogni conferma o, senza passkey, il
  codice); «Done: forget the kit». Il kit vale 10 minuti: scaduto, la
  pagina lo dice e lo richiede.
- **Il kit** non va negli appunti, in una cache, in `#print-root` né nel
  contesto di Claude: sta nello stato del componente che lo mostra, e si
  butta dopo la conferma o lasciando la pagina.
- **`#/pair?state=…`**: l'avviso «Continue only if you started this from
  your Mac just now…» in `warning`, il nome del Mac e il suo login, il campo
  degli ultimi 4 caratteri (l'impronta NON si mostra, M3), «Pair this Mac»
  solo con 4 caratteri, la passkey, e il ritorno a `stubwise://vault?state=…`.
- **`#/passkeys`**: le proprie passkey, «Opens the vault» per quelle col
  sigillo e «Use for the vault» per le altre (due tocchi: prima una che
  apre, poi questa). In Preferenze → Security, accanto a una passkey senza
  sigillo, «Use for the vault» è il link a questa pagina.

### La finestra dell'associazione (Pair this Mac)

Dialogo 520px, tre momenti nello stesso dialogo **[VA 8]**:

```
Pair this Mac
This Mac will open your vault with Touch ID. You confirm it once, in the
browser, with your passkey.

  This Mac's key
  3f9a 1c2e 07d4 91be                      ← monospace 24px, cifre tabellari

  1  The browser opens Stubwise.
  2  Type the last 4 characters of this key there (91be).
  3  Choose "Pair this Mac" there.

  ◌ Waiting for the browser…  expires in 10 minutes        [Cancel]
```

- **Pair this Mac** (dalla barra o ⌘K): il main chiede l'accoppiamento e
  apre il browser; il dialogo mostra l'impronta e i tre passi, e «Waiting
  for the browser…» con l'anello.
- **Il codice si scrive, non si confronta** (M3 della seconda revisione,
  decisione di 46, 25 nov 2026): la pagina `#/pair` della pagina a sé della
  cassaforte (`/app/vault/`; prima `vault-pair` del web vecchio) NON mostra
  l'impronta; chiede gli ultimi 4 caratteri di quella che mostra QUESTO
  dialogo, e li confronta con l'impronta calcolata dalla pubblica del
  server. Mostrata anche nel browser, la si copierebbe dalla pagina stessa
  — anche da un link mandato da chi ha avviato un'associazione al posto
  tuo, che senza il dialogo sul Mac non ha niente da farti scrivere.
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
  corrente · «Paired Nov 24 · used today» · impronta **intera** 12px
  monospace (`3f9a 1c2e 07d4 91be`: un'impronta troncata non si confronta,
  revisione di sicurezza M7) · azione a destra.
- **Questo Mac**: **Forget this Mac** → conferma a due tempi in posto:
  «This Mac stops opening the vault. You stay signed in.» → fatto: la
  riga sparisce; se il server non risponde, «Forgotten on this Mac. The
  server didn't answer: remove it from the browser too.»
- **Un altro Mac**: **Remove** si fa da qui (VA-Q4 «Anche dal desktop»,
  maintainer) con la **riconferma** («Confirm it's you», come le altre
  azioni delicate) **e** la cassaforte aperta (Touch ID: la rotta vuole
  anche la prova della propria chiave; 72, e5b85be0e) → conferma a due
  tempi in posto:
  «That Mac stops opening the vault. It stays signed in.» → toast
  «Removed. You'll get a security alert.» **[VA 9]**.
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
- **«Pairing:» sta DENTRO il dialogo dell'associazione** (94, 25 nov 2026):
  il dialogo è modale, e un riquadro sotto la barra non si potrebbe
  toccare mentre aspetta; lì c'è un secondo riquadro tratteggiato, solo
  durante l'attesa. Sotto la barra restano «Next Touch ID» e «Next
  opening».

## 4. Ambito e confini

- **Dentro**: sezione Credentials (elenco, dettaglio, nuova e modifica,
  Show/Copy, Readers, accessi da confermare, Access log), barra con i
  dieci stati, finestra dell'associazione, parte di Security, parte
  Vault dell'admin, ⌘K, riquadro «Prototype only».
- **Dentro, solo nella build web** (fase 2 della cassaforte nel browser,
  design `2026-11-27-cassaforte-browser-design.md` §10, decisione di 46 del
  28 nov 2026): attivare la cassaforte, il kit di recupero e la sua
  rotazione, creare o ricreare la propria chiave, il recupero col kit, la
  pagina che sigilla un Mac, «Use for the vault» accanto a una passkey.
  D-7 («restano del browser») ora vuol dire **la pagina a sé della
  cassaforte nel browser** (`/app/vault/`), non il web vecchio, che verrà
  ritirato. Vedi «La pagina a sé della cassaforte» sotto.
- **Anti-obiettivi**: una password nel DOM a cassaforte chiusa; una
  password che resta mostrata dopo la chiusura; «Show» che apre un
  dialogo modale con la password;
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
2. **[VA 2]** Si entra dalla sezione di progetto, dalla destinazione
   «Vault» in barra laterale (dopo Drive), da Security, dalla pagina della
   persona e da ⌘K.
3. **[VA 3]** Senza Touch ID, «Open in the browser» (D-1a).
4. **[VA 4]** Show/Copy a cassaforte chiusa aprono il Touch ID e fanno
   l'azione.
5. **[VA 5]** Gli appunti si cancellano dopo 30 s, solo se contengono
   ancora la password.
6. **[VA 6]** «Recipients changed» si risolve da solo una volta.
7. **[VA 7]** La domanda della conferma intera, come nel web.
8. **[VA 8]** L'associazione in un dialogo con l'impronta grande e tre
   passi.
9. **[VA 9]** I propri altri Mac si tolgono dall'app, con la cassaforte
   aperta; quelli di un'altra persona li toglie l'admin dal browser.

## Decisioni del maintainer (25 nov 2026, via 46)

| # | Domanda | Decisione |
|---|---|---|
| VA-Q1 | Dove sta la cassaforte | **Entrambe**: la sezione «Credentials» di ogni progetto E la pagina unica «Vault» con tutte le credenziali, filtrabili per progetto. La pagina unica è una destinazione in barra laterale dopo «Drive» (scelta di 94, §3). |
| VA-Q2 | Show e Copy a cassaforte chiusa | **Aprono il Touch ID e fanno l'azione** (la raccomandazione). |
| VA-Q3 | La password mostrata si nasconde da sola? | **No**: resta finché non si preme «Hide», come nel web. «Copy» svuota comunque gli appunti dopo 30 s. |
| VA-Q4 | Togliere un altro proprio Mac dal desktop | **Anche dal desktop**, con la cassaforte aperta (rotta del PAT desktop chiesta a 72). Quelli di un'altra persona: l'admin, dal browser. |
| VA-Q5 | «from the Mac» nel registro | **A chiunque legga il registro** (la raccomandazione). |
| VA-Q6 | «Generate» nella password nuova | **No**. |
| M3 (rev. 2) | L'impronta nella pagina d'associazione del browser | **Non si mostra** (46): il browser chiede gli ultimi 4 caratteri del codice che mostra il dialogo sul Mac, e li confronta con l'impronta della pubblica del server. |
