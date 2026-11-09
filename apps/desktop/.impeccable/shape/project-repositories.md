# Shape brief — Progetto → Settings: Repositories (creazione guidata, modifica, webhook, file d'ambiente) e Integration

> Shape scritto dal controller senza intervista (31 ott 2026): le domande di
> discovery non sono state fatte al maintainer. Dove design e piano non
> bastavano la scelta è marcata **scelta del controller** e numerata
> **[RE n]** in fondo. La sola lettura, il segno «View only» e il «Who?»
> seguono `project-settings.md` ([PS 3], [PS 4]).

Superficie: le sezioni **Repositories** (`/p/<CODE>/settings/repositories`,
con `?new=1` per la **creazione guidata** e `?repo=<id>` per la **pagina del
repository**) e **Integration** (`/p/<CODE>/settings/integration`), con i
dialoghi dei file d'ambiente e delle rigenerazioni. Le parti dell'8a (modo
delle PR dei colleghi, pipeline e ramo di rilascio) restano dentro la pagina
del repository, sotto i campi nuovi, solo col modulo Releases. Piano 9c:
Task 8 e 9 (dati: Task 3, 4). Spec area 9: «Impostazioni del progetto (9c)
→ Repositories, Integration», «Anti-obiettivi» (un segreto che ricompare).
CLAUDE.md: «Solo l'ambiente `test` entra in un worktree», «File `.env` per
progetto». Web di riferimento (cosa si porta, non come appare):
`apps/web/src/components/{repository-wizard,repository-form,
webhook-config-panel,integration-panel,project-env-files-section}.tsx`,
chiavi `repositories:wizard.*`, `integration:*`. Riusa `SecretOnce` (9a),
`PrototypeBox`, il dialogo di riconferma (`entry.md`), `WhoCanLink`. Mondo:
«Catalogo numerato», modalità **Operate**.

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi collega il codice** (Laura Costa in ACQ, `repos.manage`): aggiunge
    un repository a un progetto nuovo, ne cambia i comandi di test quando
    il progetto cambia strumenti, configura il webhook, carica il `.env` di
    test perché Claude possa far girare i test. Sa cosa sta facendo; teme
    di **sbagliare repository o ramo**, e di **esporre un segreto**.
  - **Chi deve solo sapere** (Sara Montanari in ACQ, `repos.view`): «da che
    repository scrive i Docs ACQ?», «il webhook è configurato?». Legge, non
    vede i file d'ambiente.
  - **Chi integra un sistema esterno** (uno sviluppatore del cliente, o
    Laura): copia il DSN, lo snippet `init()` e l'URL del webhook in arrivo,
    e rigenera la chiave quando è trapelata.
- **Stato d'animo**: precisione. Ogni passo dice cosa controlla; ogni
  segreto dice **che si vede una volta**; ogni ambiente dice **se arriva a
  Claude**.

## 2. Esito e prova

- **Azioni primarie**: aggiungere un repository in quattro passi (account
  git, repository, ramo, verifica degli accessi) più i comandi; modificarne i
  campi e i rami protetti; configurare il webhook; creare file d'ambiente,
  importare `KEY=value` o un `.env`, sostituire e rimuovere una variabile,
  eliminare un file; leggere e copiare chiave mascherata, DSN, snippet, URL
  dei webhook; rigenerare la chiave d'ingestione e il secret di un webhook
  git.
- **Successo**, a 1440×900, da Laura in ACQ:
  - premo **Add repository**, scelgo «Bitbucket Audin», cerco «portale»,
    scelgo `audin/portale-utenti`, lascio il ramo `main`, premo **Verify
    access**, leggo «✓ Access works: Stubwise can read and write
    audin/portale-utenti on main.», compaiono i comandi, premo **Create**: la
    riga è nell'elenco con «○ Webhook not configured»;
  - nella pagina del repository premo **Configure automatically** e leggo
    «✓ Webhook configured · just now»;
  - in **Environment files** leggo sopra TEST «✓ Claude reads these» e sopra
    PRODUCTION «○ Claude never reads these»; incollo tre righe con una rotta,
    riconfermo, e leggo «2 imported, 1 replaced, line 3 skipped»; delle
    variabili vedo solo il nome e «set just now»;
  - in **Integration** premo **Regenerate key…**, riconfermo, leggo la
    chiave intera, il DSN e lo snippet **una volta** in `SecretOnce`;
    chiuso, leggo solo «•••• 7c41».
- **Successo**, da Sara: l'elenco e la pagina del repository come testo,
  **Add repository** e **Configure automatically** spenti con «Who?»; al
  posto dei file d'ambiente la frase che dice che li vede solo chi gestisce
  i repository; in Integration DSN e snippet mascherati, **Copy** copia il
  testo mascherato e lo dice.
- **Verità del prodotto**:
  - **un segreto si vede una volta**: chiave d'ingestione e secret del
    webhook git solo in `SecretOnce` alla rigenerazione, poi le ultime 4; un
    **valore d'ambiente non si vede mai**, nemmeno le ultime 4: solo il
    nome, «set» e quando;
  - **solo l'ambiente `test` arriva a Claude**; staging e production si
    conservano per essere sostituiti e confrontati, mai usati;
  - **un repository si crea solo dopo una verifica riuscita della stessa
    terna** account · repository · ramo, fatta da chi crea; cambiare uno dei
    tre azzera la verifica;
  - **il nome del repository è nell'indirizzo dei Docs**: unico nel
    progetto;
  - **nessuna eliminazione di un repository** (come sul web): un
    repository lascia un progetto solo quando il progetto è eliminato
    (`project-archive.md`);
  - **«Webhook configured» solo con lo stato `configured`**.

## 3. Direzione scelta

- **Tesi**: **un repository è una scheda del catalogo con la sua salute in
  parole** (webhook, accessi), e una pagina sua per tutto ciò che si
  modifica. La creazione è un **percorso numerato** che non lascia andare
  avanti senza la prova degli accessi. I segreti hanno **una sola forma**
  ovunque: «•••• 7c41» e un'azione che li sostituisce **[RE 1]**.

### Repositories: l'elenco (`/settings/repositories`)

- h1 «Repositories» / «Repository» · prosa «The code repositories of ACQ.
  Claude works on them, and the Docs are written from them.» / «I
  repository di codice di ACQ. Claude ci lavora, e da loro si scrivono i
  Docs.» · a destra **Add repository** / **Aggiungi repository** (primario,
  `repos.manage`; spento con **Who?** `manageRepos` senza).
- **Riga di un repository** (60px, due righe, intera riga link a
  `?repo=<id>`):
  - **nome** 600 · nome completo `audin/portale-utenti` 13px `ink-muted` ·
    piattaforma in parola «Bitbucket» · a destra lo **stato del webhook** in
    glifo + parola (vedi sotto) · →;
  - seconda riga 13px `ink-muted`: «main · Bitbucket Audin · tests: `pnpm
    test`» / «main · Bitbucket Audin · test: `pnpm test`» (il comando in
    codice; senza comando «tests detected from the lockfile» / «test rilevati
    dal lockfile»); un account git eliminato o assente: «No git account» /
    «Nessun account git» in `ink-faint`.
- **Stati del webhook**, ovunque uguali:
  - `configured`: «✓ Webhook configured» / «✓ Webhook configurato»;
  - `not_configured`: «○ Webhook not configured» / «○ Webhook non
    configurato» (`ink-muted`);
  - `failed`: «✕ Webhook setup failed» / «✕ Configurazione del webhook non
    riuscita» (`critical`, glifo e parola).
- Riga 12px `ink-faint` sotto l'elenco, sempre: «A repository leaves a
  project only when the project is deleted.» / «Un repository lascia un
  progetto solo quando il progetto viene eliminato.» **[RE 2]**

### La creazione guidata (`?new=1`)

- **Dialogo 720px** **[RE 3]**, titolo «Add a repository to ACQ» / «Aggiungi
  un repository ad ACQ». A sinistra (180px, filetto `rule` a destra) i passi
  **numerati** in cifre tabellari: **1 Git account · 2 Repository · 3 Branch
  · 4 Access** / **1 Account git · 2 Repository · 3 Ramo · 4 Accessi**; il
  passo corrente in ink 600 con la barra 2px a sinistra, i fatti con ✓ e il
  valore scelto sotto in 12px («Bitbucket Audin»), quelli futuri `ink-faint`.
  Un passo fatto si riapre col clic. A destra il passo, con l'h2 del passo
  (`headline`) che riceve il fuoco. In fondo **Back** / **Indietro** ·
  **Next** / **Avanti** (primario) e, all'ultimo passo, **Create** / **Crea**.
- **1 · Git account**: gruppo di righe radio, una per account git
  dell'istanza (nome 600 · piattaforma · esito dell'ultima verifica come in
  `admin-integrations.md`). Un account con «✕ invalid credentials» è
  sceglibile, con sotto 12px «Its last check failed: access will likely fail
  too.» / «La sua ultima verifica non è riuscita: probabilmente non
  riuscirà nemmeno l'accesso.» **Nessun account git**: «There are no git
  accounts yet. Someone who can manage git accounts adds one in
  Administration → Git accounts.» / «Non ci sono ancora account git.
  Qualcuno che può gestire gli account git ne aggiunge uno in
  Amministrazione → Account git.» + **Who?** (`manageGitAccounts`) o il link
  se chi guarda vede quella voce; **Next** spento.
- **2 · Repository**: campo **Find a repository** / **Cerca un repository**
  sopra l'elenco di `listRemoteRepositories` (righe 40px: nome completo ·
  12px «default: main» / «predefinito: main»); un repository già in ACQ si
  legge `ink-faint` con «Already in ACQ» / «Già in ACQ» e non si sceglie.
  Nessuna corrispondenza: «No repository matches. If it's missing, Bitbucket
  Audin can't see it: check the account's access.» / «Nessun repository
  corrisponde. Se manca, Bitbucket Audin non lo vede: controlla gli accessi
  dell'account.» Sotto, **Name in Stubwise** / **Nome in Stubwise**,
  precompilato con l'ultima parte («portale-utenti»), con 12px «It's in the
  Docs addresses, like /docs/ACQ/portale-utenti.» / «È negli indirizzi dei
  Docs, come /docs/ACQ/portale-utenti.» Errore: «ACQ already has a
  repository called portale-utenti.» / «ACQ ha già un repository che si
  chiama portale-utenti.» (`name_taken`).
- **3 · Branch**: menu dei rami, con il predefinito scelto e «(default)» /
  «(predefinito)»; frase «Claude starts from this branch and opens its pull
  requests against it.» / «Claude parte da questo ramo e apre le sue pull
  request verso di lui.»
- **4 · Access**: frase «Stubwise checks that Bitbucket Audin can read and
  write audin/portale-utenti on main: Claude needs both to open pull
  requests.» / «Stubwise controlla che Bitbucket Audin possa leggere e
  scrivere audin/portale-utenti su main: a Claude servono entrambi per aprire
  le pull request.» · **Verify access** / **Verifica gli accessi**
  (secondario) → «Checking…» / «Verifica in corso…» 600 ms → esito:
  - `ok`: «✓ Access works.» / «✓ Gli accessi funzionano.» (`positive`, glifo
    e parola) e sotto compaiono i **comandi**:
    - **Test command** / **Comando dei test** (codice): «Leave it empty to
      detect it from the lockfile.» / «Lascialo vuoto per rilevarlo dal
      lockfile.»;
    - **Install command** / **Comando d'installazione** (codice), stessa
      frase;
    - **Create** acceso;
  - `invalid_credentials`: «✕ Bitbucket Audin's credentials don't work.
    Replace its token in Administration → Git accounts, then verify again.» /
    «✕ Le credenziali di Bitbucket Audin non funzionano. Sostituisci il token
    in Amministrazione → Account git, poi verifica di nuovo.» · nessun
    comando, **Create** spento;
  - `unreachable`: «✕ Couldn't reach Bitbucket. Try again in a moment.» /
    «✕ Bitbucket non risponde. Riprova fra poco.»
  - Riaprire il passo 1, 2 o 3 e cambiare la scelta **azzera** la verifica:
    il passo 4 torna senza ✓ e dice «The choice changed: verify again.» /
    «La scelta è cambiata: verifica di nuovo.»
  - **Riquadro «Prototype only»** in fondo al passo: «Nothing real is
    contacted. Choose what the next access check answers.» / «Non si
    contatta niente di vero. Scegli cosa risponde la prossima verifica.» ·
    Works / Invalid credentials / Unreachable (segmentato).
- **Create** → nessuna riconferma (nessun segreto) → il dialogo si chiude,
  la riga compare nell'elenco con lo sfondo `ink/6` per 2 s, il fuoco va
  alla riga; toast «portale-utenti added to ACQ. Configure its webhook so
  Stubwise hears about new commits.» / «portale-utenti aggiunto ad ACQ.
  Configura il webhook perché Stubwise sappia dei commit nuovi.» · **Open**
  / **Apri**.
- `access_not_verified` (la verifica non vale più, per esempio un altro
  «vedi come»): riga ✕ sopra i bottoni «Verify access again before
  creating.» / «Verifica di nuovo gli accessi prima di creare.»
- **Esc** o **Cancel** chiude; con scelte fatte: «Discard this repository?»
  / «Scartare questo repository?»; il fuoco torna ad **Add repository**.

### La pagina del repository (`?repo=<id>`)

- **Testata**: «← Repositories» · h1 = nome · riga 13px «audin/portale-
  utenti · Bitbucket · https://bitbucket.org/audin/portale-utenti» (URL in
  codice, link esterno simulato) · a destra lo stato del webhook.
- **DETAILS** / **DETTAGLI** (`heading-group`), modulo a etichette 160px:
  - **Name** / **Nome**: frase dei Docs come nella creazione;
  - **Address** / **Indirizzo** (https): errore «Use an https address.» /
    «Usa un indirizzo https.»;
  - **Default branch** / **Ramo predefinito**: menu dei rami;
  - **Git account** / **Account git**: menu degli account;
  - **Review account** / **Account di revisione**: menu con prima voce
    «Default reviewer (GitHub Stubwise)» / «Revisore predefinito (GitHub
    Stubwise)» o «No default reviewer» / «Nessun revisore predefinito», poi
    gli account della **stessa piattaforma**, escluso quello principale
    (scelte spente con la ragione, mai nascoste): «Not on Bitbucket» / «Non è
    su Bitbucket», «It's the main account» / «È l'account principale».
    Frase: «The account that reviews Claude's pull requests. It must differ
    from the one that writes them.» / «L'account che rivede le pull request
    di Claude. Dev'essere diverso da quello che le scrive.» Errore
    (`review_account`): «Choose an account on Bitbucket other than the main
    one.» / «Scegli un account su Bitbucket diverso da quello principale.»;
  - **Test command**, **Install command** (codice), vuoti = «Detected from
    the lockfile» / «Rilevato dal lockfile» in segnaposto;
  - **Code graph** / **Grafo del codice**: interruttore + «Lets chats find
    the code that answers a question. Rebuilt after each push.» / «Permette
    alle chat di trovare il codice che risponde a una domanda. Si ricostruisce
    dopo ogni push.» (si salva e basta, Global Constraints);
  - **Protected branches** / **Rami protetti**: area di testo, **un ramo per
    riga** (codice), frase «Claude never pushes to these. End a line with /*
    for every branch that starts the same way, like release/*.» / «Claude
    non fa mai push su questi. Chiudi una riga con /* per tutti i rami che
    iniziano così, come release/*.» Errore: «Line 2: a branch can't be empty
    or contain spaces.» / «Riga 2: un ramo non può essere vuoto né contenere
    spazi.»
  - **Barra di salvataggio** agganciata in fondo: «3 changes · Discard ·
    Save» → «Saved»; nessuna riconferma; una voce per campo cambiato.
- **WEBHOOK** (`heading-group`):
  - riga di stato in parole:
    - `not_configured`: «○ Not configured: Stubwise doesn't hear about new
      commits, so the nightly Docs, the reports and the code graph don't
      see them.» / «○ Non configurato: Stubwise non sa dei commit nuovi,
      quindi Docs notturni, report e grafo del codice non li vedono.»;
    - `configured`: «✓ Configured on Oct 28.» / «✓ Configurato il 28 ott.»;
    - `failed`: «✕ Couldn't configure it on Oct 31. Check that Bitbucket
      Audin can manage webhooks, then try again.» / «✕ Non è stato possibile
      configurarlo il 31 ott. Controlla che Bitbucket Audin possa gestire i
      webhook, poi riprova.»;
  - **Configure automatically** / **Configura automaticamente** (secondario;
    con `configured` diventa **Configure again** / **Configura di nuovo**)
    → «Configuring…» / «Configurazione in corso…» 600 ms → toast «Webhook
    configured.» / «Webhook configurato.» oppure, se lo era già, «Webhook
    updated.» / «Webhook aggiornato.»; `failed`: la riga ✕ e nessun toast di
    riuscita, mai «Configured»;
  - 12px: «To set it up by hand, the address and secret are in
    Integration.» / «Per configurarlo a mano, indirizzo e secret sono in
    Integrazione.» con link;
  - **Riquadro «Prototype only»**: «The next setup ends: (•) Configured ( )
    Failed» / «La prossima configurazione finisce: (•) Configurato ( ) Non
    riuscito».
- **ENVIRONMENT FILES** / **FILE D'AMBIENTE** (sotto, vedi la sezione che
  segue): **solo con `repos.manage`**.
- **RELEASES** / **RILASCI** (le parti dell'8a, invariate): solo col modulo.
- **Sola lettura** (Sara): ogni campo come testo (i rami protetti uno per
  riga, i comandi in codice), la riga ○ con «Who?» (`manageRepos`) in
  testa alla pagina, **Configure automatically** spento con **Who?**, nessun
  riquadro «Prototype only». Al posto dei file d'ambiente una riga ○
  «Environment files are visible only to people who can manage ACQ's
  repositories.» / «I file d'ambiente li vede solo chi può gestire i
  repository di ACQ.» + **Who?**.

### I file d'ambiente

- Frase in testa, sempre, 13px con ○ **[RE 4]**: «Only the test
  environment's files reach Claude: they're copied into its working copy
  before install and tests. Staging and production values are kept so you can
  replace them, never shown and never used automatically.» / «Solo i file
  dell'ambiente di test arrivano a Claude: vengono copiati nella sua copia di
  lavoro prima dell'installazione e dei test. I valori di staging e
  production si conservano per poterli sostituire, mai mostrati e mai usati
  in automatico.»
- **Un gruppo per ambiente** del progetto, nell'ordine Test · Staging ·
  Production: testata `heading-group` col nome dell'ambiente («TEST ·
  Test») e a destra il segno del perimetro, **in parole** (`reachesClaude`
  della vista, mai dedotto nella pagina):
  - `test`: «✓ Claude reads these» / «✓ Claude li legge»;
  - altri: «○ Claude never reads these» / «○ Claude non li legge mai».
  - A destra **New file** / **Nuovo file** (secondario).
- **Un file** (riga 44px): percorso in codice `.env` · «3 variables» / «3
  variabili» · **Import…** / **Importa…** · **Add variable…** / **Aggiungi
  variabile…** · «⋯» (Delete file… / Elimina il file…).
- **Le variabili**, sotto il file, rientrate 16px (righe 36px): **nome** in
  codice `DATABASE_URL` · «set Oct 29» / «impostata il 29 ott» (12px,
  cifre tabellari) · a destra **Replace…** / **Sostituisci…** e
  **Remove…** / **Rimuovi…** (link-bottoni). **Nessun valore, nessuna
  ultima cifra, nessun «Show»**.
- Un ambiente senza file: «No files for Production.» / «Nessun file per
  Production.»
- **New file** (dialogo 440px): «New file for Staging» / «Nuovo file per
  Staging» · **Path** / **Percorso** (codice, segnaposto `.env.local`) ·
  «Relative to the repository root, like .env or apps/web/.env.» /
  «Relativo alla radice del repository, come .env o apps/web/.env.» ·
  errori «Use a path inside the repository, without .. or a leading /.» /
  «Usa un percorso dentro il repository, senza .. né / iniziale.»
  (`path`); «Staging already has .env.local.» / «Staging ha già
  .env.local.» (`path_taken`) · **Create** (nessuna riconferma: è vuoto).
- **Import…** (dialogo 560px) **[RE 5]**: «Import into .env (Test)» /
  «Importa in .env (Test)»:
  - area di testo 8 righe, codice, segnaposto `KEY=value`, campo di tipo
    segreto per l'autocompletamento (nessun suggerimento del browser);
  - **Choose a file…** / **Scegli un file…** (legge un `.env` dal computer
    nel campo, senza mostrarlo altrove);
  - 12px: «KEY=value, export KEY=value and quoted values work. Lines starting
    with # and empty lines are ignored. A name already in the file is
    replaced.» / «Funzionano KEY=value, export KEY=value e i valori fra
    virgolette. Le righe che iniziano con # e quelle vuote si ignorano. Un
    nome già nel file viene sostituito.»;
  - **Import** → riconferma → l'area si **svuota subito** (il valore non
    resta nel dialogo) e il dialogo mostra l'esito in parole: «2 imported, 1
    replaced, line 3 skipped.» / «2 importate, 1 sostituita, riga 3
    saltata.» e, per ogni riga saltata, «Line 3: not in KEY=value form.» /
    «Riga 3: non è nella forma KEY=value.» o «Line 5: the name isn't valid
    (letters, digits and _, not starting with a digit).» / «Riga 5: il nome
    non è valido (lettere, cifre e _, senza iniziare con una cifra).» — mai
    il contenuto della riga · **Done** / **Fatto**;
  - niente di valido: «Nothing to import: no line is in KEY=value form.» /
    «Niente da importare: nessuna riga è nella forma KEY=value.», dialogo
    aperto, nessuna riconferma chiesta.
- **Add variable… / Replace…** (dialogo 440px): «Set a variable in .env
  (Production)» / «Imposta una variabile in .env (Production)» · **Name**
  (codice; fisso con Replace) · **Value** / **Valore**: campo da scrivere
  come in `SecretField` (password, **Show**/**Hide**, monospace), senza lo
  stato salvato; 12px «Once saved, no one can read it again, not even you:
  you can only replace it.» / «Una volta salvato, nessuno può rileggerlo,
  nemmeno tu: puoi solo sostituirlo.» · **Save** → riconferma → toast
  «DATABASE_URL set in .env (Production).» / «DATABASE_URL impostata in .env
  (Production).» Errore nome: «Use letters, digits and _, not starting with
  a digit.» / «Usa lettere, cifre e _, senza iniziare con una cifra.»
- **Remove…** (dialogo 440px): «Remove DATABASE_URL from .env
  (Production)?» / «Rimuovere DATABASE_URL da .env (Production)?» · (solo
  Test) «Claude's next runs won't have it.» / «Le prossime esecuzioni di
  Claude non l'avranno.» · **Remove** (`critical`) → riconferma.
- **Delete file…** (dialogo 440px): «Delete .env (Production) and its 2
  variables?» / «Eliminare .env (Production) e le sue 2 variabili?» ·
  **Delete** (`critical`) → riconferma → toast «.env deleted from
  Production.»
- **Nessun ambiente** **[RE 6]**: senza il modulo Releases, «Environment
  files belong to an environment, and environments come with the Releases
  module.» / «I file d'ambiente appartengono a un ambiente, e gli ambienti
  arrivano col modulo Rilasci.»; col modulo ma senza ambienti, «Environment
  files belong to an environment, and ACQ has none yet. Add one in Releases
  → Environments.» / «I file d'ambiente appartengono a un ambiente, e ACQ non
  ne ha ancora. Aggiungine uno in Rilasci → Ambienti.» con link.
- Dopo ogni dialogo il fuoco torna al bottone o al «⋯» che l'ha aperto; se
  la riga è sparita (variabile rimossa, file eliminato), al **New file** del
  suo ambiente.

### Integration (`/settings/integration`)

- h1 «Integration» / «Integrazione» · prosa «How other systems send ACQ
  their errors and events: the ingestion key, the inbound webhook, the git
  webhooks.» / «Come gli altri sistemi mandano ad ACQ errori ed eventi: la
  chiave d'ingestione, il webhook in arrivo, i webhook git.»
- Visibile a tutti i membri. Sola lettura secondo [PS 4]: la riga ○ in testa
  solo se chi guarda non può rigenerare niente.
- **INGESTION KEY** / **CHIAVE D'INGESTIONE** (`heading-group`):
  - riga «•••• 7c41 · made Oct 2 by Laura Costa» / «•••• 7c41 · creata il 2
    ott da Laura Costa» (cifre tabellari; nel seme senza autore: «made Oct
    2») · a destra **Regenerate key…** / **Rigenera la chiave…**
    (secondario; spento con **Who?** `manageProjectSettings` senza
    `canRegenerateKey`);
  - **DSN**: in codice, con la chiave **mascherata**
    (`https://••••7c41@stubwise.example/ingest/ACQ`) · **Copy** / **Copia**;
  - **SDK snippet** / **Snippet dell'SDK**: blocco di codice di 6 righe con
    `init({ dsn: "…••••7c41…" })` · **Copy**;
  - sotto i due **Copy**, una volta, 12px **[RE 7]**: «Copy gives the text
    with the key hidden. Paste the full key from where you saved it when it
    was made, or regenerate it.» / «Copia dà il testo con la chiave nascosta.
    Incolla la chiave intera da dove l'hai salvata quando è nata, o
    rigenerala.» Dopo la copia, «Copied, with the key hidden.» / «Copiato,
    con la chiave nascosta.» per 2 s.
- **INBOUND WEBHOOK** / **WEBHOOK IN ARRIVO**:
  - frase «Systems like Audin or HubSpot post events here. They reach ACQ's
    automations as incoming events.» / «Sistemi come Audin o HubSpot mandano
    qui i loro eventi. Arrivano alle automazioni di ACQ come eventi in
    arrivo.»;
  - **Address** / **Indirizzo** in codice · **Copy**;
  - **Authentication** / **Autenticazione**: «Header Authorization: Bearer
    ••••7c41» / «Intestazione Authorization: Bearer ••••7c41» (è la stessa
    chiave d'ingestione, e lo dice: «It's the ingestion key.» / «È la chiave
    d'ingestione.»);
  - **Example request** / **Richiesta d'esempio**: blocco di codice con un
    corpo JSON d'esempio · **Copy**.
- **GIT WEBHOOKS** / **WEBHOOK GIT**: frase «Each repository's git platform
  calls this address on every push. Configure automatically, in
  Repositories, sets both for you.» / «La piattaforma git di ogni repository
  chiama questo indirizzo a ogni push. Configura automaticamente, in
  Repository, li imposta entrambi per te.» Una riga per repository (52px,
  due righe): **nome** 600 · stato del webhook · seconda riga: indirizzo in
  codice + **Copy** · secret «•••• 9c0d» o «No secret yet» / «Nessun secret
  ancora» · a destra **Regenerate secret…** / **Rigenera il secret…**
  (`canRegenerate`; spento con **Who?** `manageRepos`). Nessun repository:
  «ACQ has no repositories yet.» / «ACQ non ha ancora repository.» + link a
  Repositories.
- **SDK GUIDE** / **GUIDA ALL'SDK**: frase «A step-by-step guide to send
  ACQ's errors from an app: install, init, test. Hand it to whoever
  integrates the app.» / «Una guida passo passo per mandare gli errori di
  un'app ad ACQ: installazione, init, prova. Dalla a chi integra l'app.» ·
  **Copy guide** / **Copia la guida** · **Save as file…** / **Salva come
  file…** (`.md`, parità col download del web) — in entrambi la chiave è
  mascherata, e lo dice la stessa frase dei **Copy**.
- **Regenerate key…** (dialogo 480px): «Make a new ingestion key for ACQ?»
  / «Creare una nuova chiave d'ingestione per ACQ?» · conseguenze in righe:
  - «The current key stops working now: errors and events sent with it are
    refused.» / «La chiave attuale smette di funzionare adesso: errori ed
    eventi mandati con lei vengono rifiutati.»
  - «Every app and system that sends to ACQ needs the new key.» / «Ogni app
    e sistema che manda ad ACQ ha bisogno della chiave nuova.»
  - «The new key is shown only once.» / «La chiave nuova si vede una volta
    sola.»
  → **Regenerate** / **Rigenera** (`critical`) → riconferma → il dialogo
  diventa il pannello **`SecretOnce`**: «This key is shown only now.» /
  «Questa chiave si vede solo adesso.» · la **chiave** intera (codice) ·
  **DSN** intero · **snippet** intero, ognuno con **Copy** · **Done** /
  **Fatto**. Chiuso, la sezione mostra «•••• <nuove 4>»; il valore non è più
  nel DOM.
- **Regenerate secret…** (dialogo 480px): «Make a new webhook secret for
  portale-utenti?» / «Creare un nuovo secret del webhook per
  portale-utenti?» · «Bitbucket's pushes are refused until the webhook has
  the new secret. Configure automatically sets it for you.» / «I push di
  Bitbucket vengono rifiutati finché il webhook non ha il secret nuovo.
  Configura automaticamente lo imposta per te.» → **Regenerate** → riconferma
  → `SecretOnce` col secret · **Done**.
- `reauth_required` annullato: toast «Nothing was changed.» / «Non è
  cambiato niente.», il dialogo resta aperto; il fuoco torna al bottone che
  l'ha aperto dopo ogni dialogo, anche dopo una conferma che cambia la riga.

```
1440 ── Repositories → portale-utenti (Laura in ACQ) ───────────────────────────
│ ← Repositories                                         ✓ Webhook configured │
│ portale-utenti                                                              │
│ audin/portale-utenti · Bitbucket · https://bitbucket.org/audin/portale-u…   │
│ DETAILS ─────────────────────────────────────────────────────────────────── │
│ Name             portale-utenti                                             │
│ Default branch   [main ▾]          Git account   [Bitbucket Audin ▾]        │
│ Review account   [Default reviewer (none on Bitbucket) ▾]                   │
│ Test command     [pnpm test        ]                                        │
│ Protected        main                                                       │
│ branches         release/*                                                  │
│ WEBHOOK ─────────────────────────────────────────────────────────────────── │
│ ✓ Configured on Oct 28.                          [Configure again]          │
│ ENVIRONMENT FILES ───────────────────────────────────────────────────────── │
│ ○ Only the test environment's files reach Claude: …                         │
│ TEST · Test                          ✓ Claude reads these    [New file]     │
│   .env           3 variables         [Import…] [Add variable…]  ⋯           │
│     DATABASE_URL     set Oct 29                       Replace…  Remove…     │
│ PRODUCTION · Production              ○ Claude never reads these [New file]  │
│   .env           2 variables         [Import…] [Add variable…]  ⋯           │
│                                       ┌ 3 changes · Discard · [Save] ┐       │
```

## 4. Ambito e confini

- **Dentro**: elenco, creazione guidata con verifica e comandi, pagina del
  repository con tutti i campi del web e i rami protetti, webhook con
  configurazione automatica simulata, file d'ambiente per ambiente
  (crea, importa, imposta, sostituisci, rimuovi, elimina), Integration
  completa con le due rigenerazioni; due riquadri «Prototype only».
- **Fuori**: eliminare un repository; scrivere un valore d'ambiente in
  chiaro da qualche parte; scaricare o rileggere un `.env`; configurare il
  webhook a mano da Stubwise (si copia indirizzo e secret); ambienti
  (Releases → Environments, 8a); il gruppo «Not in any project» di
  Amministrazione (`project-archive.md`).
- **Anti-obiettivi**: un valore d'ambiente, una chiave o un secret nel DOM
  dopo la chiusura del dialogo; ultime cifre di un valore d'ambiente; un
  «Copy» che copia la chiave intera da una lettura; «Webhook configured»
  dopo un `failed`; «Create» acceso senza verifica; un ambiente diverso da
  test che dice di arrivare a Claude; il contenuto di una riga saltata
  nell'esito dell'import.

## 5. Stati e intervalli

| Parte | Caricamento | Vuoto | Errore |
|---|---|---|---|
| Elenco | 3 righe scheletro da 60px | «ACQ has no repositories yet. Add one so Claude can work on the code and the Docs can be written.» / «ACQ non ha ancora repository. Aggiungine uno perché Claude possa lavorare sul codice e si possano scrivere i Docs.» + **Add repository** (senza permesso: «Someone who can manage ACQ's repositories can add one. **Who?**») | «Couldn't load ACQ's repositories.» / «Impossibile caricare i repository di ACQ.» · **Retry** / **Riprova** |
| Creazione, passo 2 | 5 righe scheletro | vedi «Nessuna corrispondenza» | «Couldn't list Bitbucket Audin's repositories.» / «Impossibile elencare i repository di Bitbucket Audin.» · **Retry** |
| Pagina del repository | testata + modulo scheletro | — | «Couldn't load portale-utenti.» · **Retry**; repository inesistente o di un altro progetto: «not found» con «← Repositories» |
| File d'ambiente | 2 gruppi scheletro | vedi «Nessun ambiente» / «No files for …» | «Couldn't load the environment files.» / «Impossibile caricare i file d'ambiente.» · **Retry** (il resto della pagina resta) |
| Integration | 4 gruppi scheletro | git webhook senza repository: sopra | «Couldn't load ACQ's integration.» / «Impossibile caricare l'integrazione di ACQ.» · **Retry** |

- **Senza permessi**: Repositories assente senza `repos.view` (indirizzo →
  prima sezione); in sola lettura senza `repos.manage`; i file d'ambiente
  assenti senza `repos.manage` (la frase con «Who?»). Integration visibile a
  ogni membro, con i bottoni spenti e «Who?».
- **Rifiuti** (stato invariato, nel punto dell'azione):
  - `forbidden`: «You can no longer change this.» / «Non puoi più cambiarlo.»
    e la parte passa in sola lettura (i file d'ambiente spariscono con la
    frase);
  - `not_found` (progetto archiviato nel frattempo): come [PS 11];
  - `invalid`: le frasi sotto i campi (`name_taken`, `url`,
    `review_account`, ramo protetto, `path`, `path_taken`, chiave);
    `access_not_verified` come sopra;
  - `reauth_required` annullato: «Nothing was changed.», dialogo aperto; per
    l'import l'area resta **vuota** (il testo incollato non si conserva: si
    reincolla) **[RE 8]**;
  - errore del livello dati: «Couldn't save. Try again.» · **Retry**.
- **Intervalli**: 0–12 repository per progetto (oltre 10 il campo «Find a
  repository» sopra l'elenco); 0–200 repository remoti per account (la
  lista scorre nel passo, 320px); 1–40 rami; 0–20 rami protetti; 0–4
  ambienti; 0–6 file per ambiente; 0–80 variabili per file (oltre 20, il
  file si apre chiuso con «Show 80 variables» / «Mostra 80 variabili»);
  import fino a 500 righe; nomi lunghi in ellissi con `title`, percorsi
  interi a capo.

## 6. Interazione e layout

- Contenuto fino a 880px; il dialogo della creazione 720px a 1440.
- **1440×900**: pagina del repository col modulo a etichette 160px e due
  campi per riga dove sono brevi (ramo · account); righe delle variabili su
  una riga sola (nome · data · azioni).
- **1024×680** (720px utili, dialoghi fino a 656px):
  - **creazione guidata**: la colonna dei passi a sinistra **diventa una
    riga** sopra il contenuto: «1 Git account ✓ · 2 Repository ✓ · 3 Branch ·
    4 Access», con il passo corrente in 600 e sottolineato; se non ci sta
    (italiano), restano i numeri e il nome del solo passo corrente
    («① ② ❸ ④ Ramo»), il resto nel `title`; i bottoni restano in fondo a
    destra; la lista dei repository remoti a tutta larghezza;
  - **pagina del repository**: etichette sopra i campi, un campo per riga;
  - **righe delle variabili**: due righe — nome in codice sulla prima con
    la data a destra, **Replace…** e **Remove…** sulla seconda, a destra;
  - righe dei file: **Import…** e **Add variable…** scendono sotto il
    percorso; «⋯» resta sulla prima riga;
  - Integration: DSN e indirizzi vanno a capo dentro il blocco di codice
    (mai scorrimento orizzontale della pagina), **Copy** sopra a destra del
    blocco;
  - `SecretOnce` a tutta larghezza del dialogo, chiave a capo.
- Animazioni: comparsa delle righe nuove (`ink/6` 2 s), dei comandi dopo la
  verifica (200ms), nessuna sotto reduced-motion.

## 7. Vincoli

- Solo via `data/queries/projectSettings.ts`; le mutazioni con un segreto
  negli argomenti o nel risultato (`importEnvFile`, `setEnvVar`,
  `removeEnvVar`, `deleteEnvFile`, `regenerateIngestionKey`,
  `regenerateWebhookSecret`) con `{ secret: true }` (`gcTime: 0`).
- `SecretOnce` per chiave e secret appena nati; **nessun `SecretField`**
  salvato (il valore non si rilegge); il campo del valore d'ambiente e
  l'area dell'import si svuotano all'invio.
- `reachesClaude`, `canManage`, `canRegenerateKey`, `canRegenerate`
  vengono dalla vista, non da un controllo nella pagina.
- Il riquadro della verifica e quello del webhook solo con `repos.manage`.
- **Seme che serve a questo shape** (per il Task 1): STW non ha oggi un
  ambiente `test` (`data/seed/releases/environments.ts` ha solo Production e
  Staging): il seme deve aggiungerlo, o `test → .env con 3 chiavi` non ha
  dove stare; ACQ non ha oggi repository: serve quello `not_configured` del
  piano (`portale-utenti`, `audin/portale-utenti`, Bitbucket Audin) **[RE 9]**.
- **+R**: `regenerateIngestionKey`, `regenerateWebhookSecret`,
  `importEnvFile`, `setEnvVar`, `removeEnvVar`, `deleteEnvFile`. Non:
  creare o modificare un repository, configurare il webhook, creare un file
  vuoto.
- **Voci del registro** (gruppo `repositories`, scope progetto, legge chi ha
  `repos.manage`; la chiave d'ingestione nel gruppo `project`; mai un valore
  o un segreto):
  - `repository.created`: «**Laura Costa** added the repository
    **portale-utenti** to **ACQ**.» / «**Laura Costa** ha aggiunto il
    repository **portale-utenti** ad **ACQ**.»
  - `repository.updated` (una per campo, `params.field`): «…changed the
    **test command** of **portale-utenti**.» / «…ha cambiato il **comando
    dei test** di **portale-utenti**.» (prima/dopo come scritti; i campi:
    name, address, default branch, git account, review account, test
    command, install command, code graph «On → Off», protected branches
    «main → main, release/*»);
  - `repository.pr_mode_changed`, `repository.release_pipeline_changed`
    (8a, Task 3): «…changed how colleagues' pull requests are handled in
    **portale-utenti**.» / «…ha cambiato come si gestiscono le pull request
    dei colleghi in **portale-utenti**.»; «…changed the release pipeline of
    **portale-utenti**.» / «…ha cambiato la pipeline di rilascio di
    **portale-utenti**.» («Automatic → build, deploy»);
  - `repository.webhook_configured`: «…configured the webhook of
    **portale-utenti**.» / «…ha configurato il webhook di
    **portale-utenti**.» («Not configured → Configured»; con `failed` la
    voce dice «…tried to configure… it failed» / «…ha provato a
    configurare… non è riuscito»);
  - `repository.webhook_secret_regenerated`: «…made a new webhook secret for
    **portale-utenti**.» / «…ha creato un nuovo secret del webhook per
    **portale-utenti**.»
  - `env_file.created` / `.deleted`: «…created / deleted the file
    **.env.local** for **Staging** in **portale-utenti**.» / «…ha creato /
    eliminato il file **.env.local** per **Staging** in **portale-utenti**.»
  - `env_file.imported`: «…imported 3 variables into **.env** (**Test**).» /
    «…ha importato 3 variabili in **.env** (**Test**).»
  - `env_var.set` / `.removed`: «…set / removed **DATABASE_URL** in **.env**
    (**Production**).» / «…ha impostato / rimosso **DATABASE_URL** in
    **.env** (**Production**).» (solo il nome)
  - `environment.created` / `.updated` / `.deleted` (8a, `environments.
    manage`): «…added / changed / deleted the environment **Staging** in
    **ACQ**.» / «…ha aggiunto / modificato / eliminato l'ambiente
    **Staging** in **ACQ**.»
  - `project.ingestion_key_regenerated` (gruppo `project`): «…made a new
    ingestion key for **ACQ**.» / «…ha creato una nuova chiave
    d'ingestione per **ACQ**.» (nessun prima/dopo).
  - Link `projectSettings`: `repositories` (con `?repo=` quando c'è un
    repository) o `integration`; ambienti a Releases → Environments.

## Scelte del brief (scelte del controller, da confermare)

1. **[RE 1]** Un segreto ha una sola forma, «•••• 7c41» e un'azione che lo
   sostituisce; un valore d'ambiente nemmeno quella, solo il nome e la data.
2. **[RE 2]** Una riga dice che un repository lascia un progetto solo con
   l'eliminazione del progetto.
3. **[RE 3]** Creazione guidata in un dialogo da 720px con i passi numerati
   a sinistra; a 1024 i passi diventano una riga sopra.
4. **[RE 4]** La frase «solo test arriva a Claude» sta in testa ai file e,
   per ogni ambiente, un segno in parole.
5. **[RE 5]** L'import accetta testo incollato o un file scelto; l'esito
   dice i numeri e le righe saltate, mai il loro contenuto.
6. **[RE 6]** Senza ambienti (o senza il modulo Releases) i file d'ambiente
   non si possono creare, e la frase dice dove nascono gli ambienti.
7. **[RE 7]** «Copy» di DSN, snippet e guida copia il testo mascherato, e lo
   dice.
8. **[RE 8]** Se la riconferma dell'import si annulla, il testo incollato
   non si conserva.
9. **[RE 9]** Il seme aggiunge l'ambiente Test a STW e il repository
   `portale-utenti` ad ACQ.

## Ruling del controller (31 ott 2026)

1. **[RE 9]** Accettata: il seme del Task 1 aggiunge l'ambiente `test` a STW
   e il repository `portale-utenti` (`audin/portale-utenti`, Bitbucket Audin,
   webhook `not_configured`) ad ACQ.
2. **[RE 7]** «Save as file…» della guida SDK accettato (parità col web).
3. «Nessuna eliminazione di un repository» resta vera **dentro un
   progetto**. Un repository **senza progetto** si elimina invece dal full
   admin, da Amministrazione → Repositories (`project-archive.md`, [AR 9],
   confermata dal maintainer il 31 ott 2026).
