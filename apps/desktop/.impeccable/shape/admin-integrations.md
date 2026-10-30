# Shape brief — Amministrazione → Git accounts, Plugins, Google Workspace, Storage, Outgoing webhooks

> Shape scritto dal controller senza intervista (30 ott 2026). Le scelte
> non coperte da design e piano sono marcate **scelta del controller** e
> numerate **[IN n]** in fondo. Decisione del maintainer del 30 ott 2026:
> l'URL del webhook in uscita **non è un segreto** (si rilegge in chiaro,
> entra nel prima/dopo del registro, nessuna riconferma).

Superficie: cinque voci del gruppo **INSTANCE** / **ISTANZA** di
Amministrazione — **Git accounts** (`/admin/git-accounts`), **Plugins**
(`/admin/plugins`, `/admin/plugins/$pluginId`), **Google Workspace**
(`/admin/google`), **Storage** (`/admin/storage`), **Outgoing webhooks**
(`/admin/webhooks`) — con i loro dialoghi. Usa `SecretField` di
`admin-ai.md` per token git, client secret e chiave S3, **non** per l'URL
del webhook. Piano 9b: Task 10 e 11 (dati: Task 1 e 4). Spec area 9:
«Istanza (9b) → Integrazioni»; CLAUDE.md «Plugin e skill dell'agente». Web
di riferimento: `apps/web/src/components/{git-accounts-section,
plugins-section,plugin-inventory,google-workspaces-section,storage-section,
notifications-section}.tsx`, chiavi `settings.gitAccounts.*`,
`settings.plugins.*`, `settings.google.*`, `settings.storage.*`,
`notifications.*`. Mondo: «Catalogo numerato», modalità **Operate**.

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi collega i sistemi** (Roberta; un tecnico con `git_accounts.manage`,
    `plugins.manage`, `integrations.manage`, `settings.manage`): lo fa
    all'inizio e poi quando qualcosa scade (un token git, un client
    secret). Sa cosa sta facendo, ma un errore ha conseguenze larghe: tutti
    i repository di un account, il codice di un plugin che gira col worker.
  - **Chi deve solo sapere** (`git_accounts.view`): «con che account
    leggiamo i repo di ACQ? è valido?». Sola lettura.
- **Stato d'animo**: attenzione. Le azioni con conseguenze lontane
  (registrare un plugin, eliminare un account in uso, spegnere gli allegati)
  dicono le conseguenze **prima**, in righe.

## 2. Esito e prova

- **Azioni primarie**: creare, validare, modificare, sostituire il token ed
  eliminare un account git, e sceglierne il revisore predefinito; registrare
  un plugin, aggiornarlo a un ref, rifare lo smoke test, rimuoverlo, leggerne
  l'inventario; registrare un'app Google; configurare l'archiviazione e gli
  allegati; configurare il webhook in uscita, i suoi eventi, l'anteprima e
  l'invio di prova.
- **Successo**, a 1440×900:
  - in Git accounts leggo «Bitbucket Audin · Bitbucket · audin · •••• 9f2c ·
    checked Oct 28 · works» e sotto «Used by 6 repositories in ACQ, AUD and
    STW»;
  - eliminando un account in uso il dialogo elenca i repository che vedo e
    «and 2 in projects you can't see», senza nomi;
  - registrando un plugin leggo **prima del campo URL** che registrare esegue
    il codice, spunto che mi fido, riconfermo, e la riga passa da
    «Materializing…» a «Ready · smoke test passed»;
  - nella pagina di `superpowers` leggo le skill con la loro frase e gli hook
    col loro comando;
  - in Outgoing webhooks scelgo Slack, rileggo l'URL salvato in chiaro, spengo
    un evento, guardo l'anteprima del messaggio accanto e mando una prova.
- **Verità del prodotto**:
  - **un segreto si vede solo mentre si scrive** (token git, client secret,
    chiave S3): poi «•••• 1a2b» e «Replace» (RF 1);
  - **registrare un plugin esegue già il suo codice**: il consenso è sulla
    registrazione, e il dialogo lo dice in parole;
  - **un account git in uso non si elimina**; i repository di progetti che
    chi guarda non vede sono solo contati (R-G5);
  - **un'app Google con caselle collegate non si elimina**;
  - **l'URL del webhook si legge in chiaro** da chi ha `settings.manage`;
  - **il webhook non manda mai eventi di posta né `google.proposal`**.

## 3. Direzione scelta

- **Tesi**: **ogni integrazione è un registro di righe con la sua salute
  in parole**. Una riga dice cos'è, con che credenziale (ultime 4 cifre),
  quando è stata provata l'ultima volta e con che esito, e **chi la usa**.
  Le azioni rare stanno in «⋯»; la prova è l'unico bottone sulla riga
  **[IN 1]**.

### Regole comuni

- Testata di ogni voce: h1 + riga in prosa + a destra il bottone di
  creazione (solo col permesso di scrittura).
- **Sola lettura**: una riga 13px ○ in testa, una volta: «You can read these
  accounts. Changing them needs someone who can manage git accounts.
  **Who?**» / «Puoi leggere questi account. Per cambiarli serve chi può
  gestire gli account git. **Chi?**» (azione `manageGitAccounts`). Bottoni
  visibili e spenti, ognuno col suo «Who?».
- **Esito di una prova** (account git, archiviazione, webhook): «checked
  Oct 28 · works» / «verificato il 28 ott · funziona» · «✕ invalid
  credentials» / «✕ credenziali non valide» · «✕ unreachable» / «✕ non
  raggiungibile» (`critical` con glifo) · «not checked yet» / «non ancora
  verificato». Durante: «Checking…» / «Verifica in corso…», 600 ms.
- **Riquadro «Prototype only»** in fondo a ogni voce con una prova: «Nothing
  real is contacted. Choose what the next check answers.» / «Non si contatta
  niente di vero. Scegli cosa risponde la prossima verifica.» con il menu
  del bersaglio quando ce n'è più d'uno.

### Git accounts (`/admin/git-accounts`)

- Si vede con `git_accounts.view` o `.manage`; si scrive con `.manage`.
- h1 «Git accounts» / «Account git» · «The credentials Stubwise uses to read
  and write your repositories. One account can serve many projects.» /
  «Le credenziali con cui Stubwise legge e scrive i repository. Un account
  può servire più progetti.» · **New account** / **Nuovo account**.
- **Riga** (60px, due righe):
  - **nome** 600 · piattaforma in parola «Bitbucket · audin» (con il
    workspace) o «GitHub» · se revisore predefinito, «Default reviewer» /
    «Revisore predefinito» in 12px 600 con ✓ (testo, nessun colore) · a
    destra **Validate** / **Verifica** e «⋯»;
  - seconda riga 13px `ink-muted`: «•••• 9f2c» · esito della verifica ·
    «Used by 6 repositories in ACQ, AUD, STW» / «Usato da 6 repository in
    ACQ, AUD, STW» (codici dei progetti visibili) · se ce ne sono di
    nascosti «and 2 in projects you can't see» / «e 2 in progetti che non
    vedi» · se nessuno «Not used yet» / «Non ancora usato».
- **«⋯»**: Edit… / Modifica… · Replace token… / Sostituisci il token… · Make
  default reviewer / Rendi revisore predefinito (o Stop being the default
  reviewer / Non più revisore predefinito) · Delete… / Elimina….
- **New account** (dialogo 480px): **Platform** Bitbucket · GitHub
  (segmentato) · **Name** · **Workspace** (solo Bitbucket: «The workspace
  slug, e.g. audin. Bitbucket needs it to list repositories.» / «Lo slug del
  workspace, es. audin. Bitbucket ne ha bisogno per elencare i
  repository.») · **Token** (`SecretField`) · riga 12px «After saving, use
  Verify to check it.» / «Dopo il salvataggio, usa Verifica per
  controllarlo.» → **Create** → riconferma → riga nuova, toast «GitHub
  Release created.» / «GitHub Release creato.»
  - Errori: «Bitbucket needs the workspace.» / «Per Bitbucket serve il
    workspace.» · «Give it a name.» · «Paste the token.»
- **Edit** (dialogo 440px): nome e workspace, nessuna riconferma, «Saved».
- **Replace token**: come il «Replace» di `admin-ai.md`, riconferma, toast
  «Token replaced for Bitbucket Audin. Verify it to check.» / «Token
  sostituito per Bitbucket Audin. Verificalo per controllare.»
- **Revisore predefinito**: frase nel dialogo di conferma (440px): «GitHub
  Stubwise reviews pull requests on GitHub for repositories that don't have
  a review account of their own.» / «GitHub Stubwise rivede le pull request
  su GitHub per i repository che non hanno un proprio account di
  revisione.» Se ne sostituisce un altro dello stesso ambito: riga in più
  «It replaces GitHub Old as the default reviewer.» / «Prende il posto di
  GitHub Old come revisore predefinito.» → **Make default** → toast «Now the
  default reviewer, in place of GitHub Old.» / «Ora è il revisore
  predefinito, al posto di GitHub Old.» Nessuna riconferma.
- **Delete…**:
  - in uso → dialogo 480px «Bitbucket Audin is still in use» / «Bitbucket
    Audin è ancora in uso» · elenco dei repository visibili (nome · codice
    del progetto, link a Progetto → Settings → Repositories) · «and 2 in
    projects you can't see» · «Link these repositories to another account
    first, in each project's settings.» / «Collega prima questi repository a
    un altro account, nelle impostazioni di ogni progetto.» · **Close**;
  - libero → «Delete GitHub Old? No repository uses it.» / «Eliminare GitHub
    Old? Nessun repository lo usa.» → **Delete** (`critical`) → riconferma.

### Plugins (`/admin/plugins`)

- Si vede e si scrive con `plugins.manage`.
- h1 «Plugins» / «Plugin» · «Claude Code plugins Claude can use when it
  works. Each one is a public git repository pinned to a commit; each project
  chooses which of its skills and hooks to use.» / «Plugin di Claude Code
  che Claude può usare quando lavora. Ognuno è un repository git pubblico
  fissato a un commit; ogni progetto sceglie quali skill e hook usare.» ·
  **Register plugin** / **Registra plugin**.
- Riga 12px `ink-muted` sotto la prosa, sempre: «Stubwise's base plugin is
  always on and isn't listed here.» / «Il plugin base di Stubwise è sempre
  acceso e non compare qui.»
- **Riga di un plugin** (60px, intera riga cliccabile verso la sua pagina):
  - **nome** 600 (dal manifest) · slug in 12px · **stato** con glifo e
    parola: «◌ Materializing…» / «◌ In preparazione…» (`ink-muted`), «✓
    Ready» / «✓ Pronto», «✕ Failed» / «✕ Non riuscito» (`critical`) · a
    destra lo **smoke test**: «Smoke test running…» / «Smoke test in
    corso…», «Smoke test passed» / «Smoke test superato», «✕ Smoke test
    failed» / «✕ Smoke test non superato»;
  - seconda riga 13px: «ref v4.0.3 · pin 3f2a9c1» (sha in cifre tabellari,
    7 caratteri) · «14 skills · 2 hooks» / «14 skill · 2 hook» · «updated
    Oct 27 by Roberta Fontana»; se `failed`, al posto dell'inventario la
    prima riga dell'errore in `critical`.
- **Register plugin** (dialogo 560px) **[IN 2]**:
  - **in testa, prima dei campi**, riquadro con filetto `rule-strong` e ▲
    `warning`, 14px:
    «**Registering runs this plugin's code.** Right after you register it,
    Stubwise installs it and runs a test with all of it turned on. Its
    hooks run without asking, with the worker's access to your repositories
    and to Claude's credentials. Register only a repository and a commit you
    trust. Choosing skills and hooks in a project comes later and doesn't
    undo this.» /
    «**Registrare esegue il codice del plugin.** Subito dopo la
    registrazione Stubwise lo installa e fa una prova con tutto acceso. I
    suoi hook girano senza chiedere, con l'accesso del worker ai tuoi
    repository e alle credenziali di Claude. Registra solo un repository e
    un commit di cui ti fidi. Scegliere skill e hook in un progetto viene
    dopo, e non annulla questo.»
  - **Repository address** / **Indirizzo del repository** (https) · **Ref**
    («A tag, branch or commit, e.g. v4.0.3» / «Un tag, un branch o un
    commit, es. v4.0.3») · **Subfolder** / **Sottocartella** (facoltativo);
    riga 12px «The name comes from the address. The plugin is pinned to the
    commit the ref points to now.» / «Il nome viene dall'indirizzo. Il plugin
    resta fissato al commit a cui punta il ref adesso.»
  - casella **«I trust this repository and this commit»** / **«Mi fido di
    questo repository e di questo commit»**: **Register** resta spento
    finché non è spuntata (**confermata dal maintainer il 30 ott 2026**,
    insieme alla riconferma).
  - **Register** → riconferma → la riga compare «Materializing…», dopo 800 ms
    «Ready» con «Smoke test running…» → «passed». Toast «superpowers
    registered.» / «superpowers registrato.»
  - Errori sotto l'indirizzo: «Use an https address.» / «Usa un indirizzo
    https.» · «Remove the username and password: the repository must be
    public.» / «Togli nome utente e password: il repository dev'essere
    pubblico.» · «git@ addresses aren't supported: use the https one.» /
    «Gli indirizzi git@ non sono supportati: usa quello https.» · «This
    address is already registered as superpowers.» / «Questo indirizzo è già
    registrato come superpowers.» · «This address gives the name
    “My_Plugin”, which isn't allowed: use lowercase letters, digits and
    dashes.» / «Da questo indirizzo viene il nome “My_Plugin”, che non è
    ammesso: servono lettere minuscole, cifre e trattini.»
- **Riquadro «Prototype only»**: «The next registration or update ends:
  (•) Ready ( ) Failed» / «La prossima registrazione o aggiornamento finisce:
  (•) Pronto ( ) Non riuscito».

### La pagina di un plugin (`/admin/plugins/$pluginId`)

- **Testata**: «← Plugins» · h1 = nome · riga 13px «github.com/obra/
  superpowers · ref v4.0.3 · pin 3f2a9c1 · registered by Roberta Fontana» ·
  stato e smoke test come nella riga · a destra **Update to ref…** /
  **Aggiorna a un ref…** e «⋯» (Run the smoke test again / Rifai lo smoke
  test · Remove… / Rimuovi…).
- **Failed**: riquadro ✕ `critical` sotto la testata «Couldn't prepare
  lint-helpers.» / «Impossibile preparare lint-helpers.» + l'errore (testo
  del worker, in codice se è un log) + «Try another ref with Update to
  ref.» / «Prova un altro ref con Aggiorna a un ref.»
- **Inventory** / **Inventario** (`headline`):
  - SKILLS (`heading-group` + «14»): righe nome (600) + descrizione 13px
    `ink-muted`, due righe con «More»;
  - HOOKS (+ «2»): righe chiave «SessionStart#0» (cifre tabellari) · evento
    · comando in un blocco codice monospace di una riga, ellissi, intero al
    passaggio;
  - riga 12px ○: «A plugin's own MCP servers (.mcp.json) are never loaded.»
    / «I server MCP propri di un plugin (.mcp.json) non vengono mai
    caricati.»
  - riga 12px: «Each project chooses which of these to use, in Project →
    Settings → Plugins.» / «Ogni progetto sceglie quali usare, in Progetto →
    Impostazioni → Plugin.»
  - Nessun inventario (`materializing` o `failed` da sempre): «No inventory
    yet.» / «Nessun inventario ancora.»
- **Update to ref…** (dialogo 480px): la frase in testa in breve «Updating
  runs the new commit's code the same way: install and test with everything
  on.» / «Aggiornare esegue il codice del nuovo commit allo stesso modo:
  installazione e prova con tutto acceso.» · **Ref** · la stessa casella di
  fiducia · **Update** → riconferma → stato «Materializing…». Toast
  «superpowers is updating to v4.1.0.» / «superpowers si sta aggiornando a
  v4.1.0.»
- **Run the smoke test again**: nessuna riconferma (lo stesso commit, già
  accettato) → «Smoke test running…».
- **Remove…**: dialogo 440px «Remove superpowers?» / «Rimuovere
  superpowers?» · «Projects lose its skills and hooks from their next run.
  Runs in progress finish with it.» / «I progetti perdono le sue skill e i
  suoi hook dalla prossima esecuzione. Le esecuzioni in corso finiscono con
  lui.» → **Remove** (`critical`). Nessuna riconferma (non esegue codice né
  tocca un segreto).

### Google Workspace (`/admin/google`)

- `integrations.manage`.
- h1 «Google Workspace» · «Google apps that let people connect their Gmail
  and Calendar. Each app covers one or more email domains.» / «App Google
  che permettono di collegare Gmail e Calendar. Ogni app copre uno o più
  domini email.» · **Add an app** / **Aggiungi un'app**.
- **Riga** (60px): **nome** · domini «audin.it, audin.com» · a destra «⋯»;
  seconda riga 13px: client ID troncato (cifre tabellari) · «•••• 7d1e» ·
  «4 mailboxes connected» / «4 caselle collegate» (o «No mailboxes
  connected» / «Nessuna casella collegata»).
- **«⋯»**: Edit… · Replace secret… / Sostituisci il secret… · Delete….
- **Add an app** (dialogo 560px): **Name** · **Email domains** (gettoni,
  Invio o virgola per aggiungere) · **Client ID** · **Client secret**
  (`SecretField`) · sezione chiusa **How to set it up in Google Cloud** /
  **Come impostarla su Google Cloud** (parità col web: redirect URI
  copiabile, scopes, «Create the consent screen as an Internal app…»,
  «Enable the Gmail API and the Google Calendar API…»). **Add** →
  riconferma → toast «Audin Workspace added. People with an audin.it address
  can connect it in Preferences → Account.» / «Audin Workspace aggiunta. Chi
  ha un indirizzo audin.it può collegarla in Preferenze → Account.»
  - Errori: «“acme” isn't a domain: use a form like acme.com.» / «“acme” non
    è un dominio: usa una forma come acme.com.» · «acme.com already belongs
    to Audin Workspace.» / «acme.com appartiene già ad Audin Workspace.»
- **Edit**: nome, domini, client ID; nessuna riconferma.
- **Delete…** con caselle: dialogo 480px «Audin Workspace still has 4
  connected mailboxes» · «Marco Bellini, Laura Costa and 2 more people.» /
  «Marco Bellini, Laura Costa e altre 2 persone.» (nomi solo delle persone
  visibili, le altre contate) · «Each person disconnects their own in
  Preferences → Account.» / «Ognuno scollega la propria in Preferenze →
  Account.» · **Close**. Senza caselle: conferma → **Delete** → riconferma.

### Storage (`/admin/storage`)

- `settings.manage`.
- h1 «Storage» / «Archiviazione» · «Where uploaded files are kept: Drive
  files and message attachments. Any S3-compatible bucket works.» / «Dove
  stanno i file caricati: i file del Drive e gli allegati dei messaggi.
  Va bene qualunque bucket compatibile S3.»
- **Stato in testa** (riga 14px con glifo):
  - «✓ Uploads are on.» / «✓ I caricamenti sono attivi.»;
  - «○ Uploads are off: attachments are turned off.» / «○ I caricamenti sono
    spenti: gli allegati sono disattivati.»;
  - «✕ Uploads are off: the last check failed.» / «✕ I caricamenti sono
    spenti: l'ultima verifica non è riuscita.» (`critical`);
  - «○ Not set up: no one can upload files.» / «○ Non configurata: nessuno
    può caricare file.»
  - Sempre sotto, 12px: «Files already uploaded stay where they are.» /
    «I file già caricati restano dove sono.» **[IN 3]**
- **Modulo**: Endpoint · Region / Regione · Bucket · Access key ID ·
  **Secret access key** (`SecretField`) · interruttore **Attachments** /
  **Allegati** con frase «Let people upload files to Drive and attach them
  to messages.» / «Permetti di caricare file nel Drive e di allegarli ai
  messaggi.» · **Check connection** / **Verifica la connessione** con
  l'esito accanto · **Save**.
- Salvare **con** una chiave nuova chiede la riconferma; senza, no. Toast
  «Saved.» Spegnere gli allegati: conferma a due tempi «Turn off uploads for
  everyone?» / «Spegnere i caricamenti per tutti?» → salva subito.

### Outgoing webhooks (`/admin/webhooks`)

- `settings.manage`.
- h1 «Outgoing webhooks» / «Webhook in uscita» · «Send a message to one chat
  channel or endpoint when something happens in any project.» / «Manda un
  messaggio a un canale di chat o a un endpoint quando succede qualcosa in
  un progetto.»
- **Due colonne a 1440** (contenuto 1040px): a sinistra il modulo (560px),
  a destra l'**anteprima** agganciata (400px, filetto `rule` a sinistra).
- **Modulo**:
  - interruttore **Send messages** / **Manda i messaggi**;
  - **Format** / **Formato**: Slack · Discord · Generic JSON / JSON generico
    (segmentato);
  - **Address** / **Indirizzo**: **campo di testo normale, in chiaro**,
    sempre riletto col valore salvato; sotto 12px «Anyone who can change
    the instance settings can read this address.» / «Chi può cambiare le
    impostazioni dell'istanza può leggere questo indirizzo.» Nessuna
    riconferma (decisione del maintainer del 30 ott 2026);
  - sezione chiusa **How to get the address** / **Come ottenere
    l'indirizzo**, con i passi del web per il formato scelto;
  - **Events** / **Eventi**: gruppi con `heading-group` e un interruttore per
    evento; il fuoco o il passaggio su una riga cambia l'evento
    dell'anteprima. «12 of 21 on» / «12 di 21 accesi» in testa.
  - **Save** → «Saved»; **Send a test** / **Manda una prova** → «Sent ·
    delivered» / «Inviata · consegnata» oppure «✕ The address answered with
    an error» / «✕ L'indirizzo ha risposto con un errore» oppure «✕ Couldn't
    reach the address» / «✕ Impossibile raggiungere l'indirizzo».
  - Errori sotto il campo: «Use an https address.» / «Usa un indirizzo
    https.» · «Add the address, or turn messages off.» / «Aggiungi
    l'indirizzo, o spegni i messaggi.»
- **Anteprima**: titolo 12px `heading-group` PREVIEW / ANTEPRIMA · «New task
  in ACQ» come esempio; Slack e Discord resi come messaggio (testo in grassetto, link,
  campi), JSON in un blocco codice monospace. Dati d'esempio fittizi,
  dichiarati: «Example data» / «Dati d'esempio».

#### Gli eventi del webhook **[IN 4]** (**confermata dal maintainer il 30 ott 2026**)

I 13 del web (`source: "web"`) più 8 del catalogo 8a/8b (`source:
"catalog"`), in sei gruppi. Mai `google.proposal`, eventi di posta,
`security.alert`, né avvisi personali.

| Gruppo | Evento | en | it |
|---|---|---|---|
| TASKS AND REQUESTS | `ticket.created` | New task from the SDK or the widget | Nuova task dall'SDK o dal widget |
| | `task.created_by_automation` (catalogo) | Task created by an automation | Task creata da un'automazione |
| | `support.request` (catalogo) | New request in the backlog | Nuova richiesta nel backlog |
| CLAUDE'S WORK | `job.plan_review` | Plan waiting for approval | Piano in attesa di approvazione |
| | `job.awaiting_input` | Claude asked a question | Claude ha fatto una domanda |
| | `job.held` | Work on hold | Lavoro in attesa |
| | `job.budget_held` | Work on hold: budget reached | Lavoro in attesa: budget raggiunto |
| | `job.failed` | Claude's work failed | Il lavoro di Claude non è riuscito |
| PULL REQUESTS AND RELEASES | `job.pr_opened` | Pull request opened by Claude | Pull request aperta da Claude |
| | `job.pr_closed` | Pull request closed without merge | Pull request chiusa senza merge |
| | `review.completed` | Pull request review done | Revisione della pull request fatta |
| | `pr.analysis_issues` (catalogo) | Problems found in a pull request | Problemi trovati in una pull request |
| | `release.merged` (catalogo) | Merged to production | Mergiata in produzione |
| | `release.succeeded` (catalogo) | Release succeeded | Rilascio riuscito |
| | `release.failed` (catalogo) | Release failed | Rilascio non riuscito |
| DOCS | `docs.limit_paused` | Docs paused, or the nightly run needs attention | Docs in pausa, o il giro notturno chiede attenzione |
| | `docs.release_note` (catalogo) | New release note | Nuova nota di rilascio |
| SERVERS | `monitor` | Server in trouble, down or back to normal | Server in difficoltà, fermo o tornato normale |
| | `server.diagnosis_ready` (catalogo) | Claude's diagnosis of a server is ready | La diagnosi di Claude su un server è pronta |
| PROJECT | `project.pulse` | Proposal for an idle project | Proposta per un progetto fermo |
| | `project.brief` | Weekly project brief | Brief settimanale del progetto |

- `monitor` copre anche `server.trouble`, `server.down`, `server.recovered`
  (come la riga unica delle Preferenze, shape [A 10]).
- **Esclusi, col motivo** (per la parità): `pr.opened` (ogni PR del
  progetto: rumore, e quella di Claude è già `job.pr_opened`);
  `task.created` (coincide con `ticket.created`); `pr.corrected` (avviso
  personale all'autore); `support.customer_replied` (porterebbe fuori le
  parole di un cliente); posta, Google, sicurezza.
- Seme: Slack acceso su `ticket.created`, `job.pr_opened`, `job.failed`,
  `monitor`.

## 4. Ambito e confini

- **Dentro**: le cinque voci con le azioni del Task 4; la pagina del
  plugin; sola lettura di Git accounts; i riquadri «Prototype only» (prove
  di git, S3, webhook; esito del plugin).
- **Fuori**: Slack e posta ammessa (sostituiti); sorgenti e webhook in
  arrivo (area 7); le abilitazioni dei plugin per progetto e il preset
  consigliato (9c); il diff dell'inventario fra revisioni del web (*scelta
  del controller*: rimandato, l'inventario si legge intero); la chiave di
  firma del webhook (non esiste neanche sul web).
- **Anti-obiettivi**: un token o un secret rivisto; l'URL del webhook
  mascherato o dietro riconferma; un plugin registrabile senza aver letto
  l'avviso; un repository di un progetto invisibile nominato nel rifiuto;
  un evento di posta fra quelli del webhook.

## 5. Stati e intervalli

| Voce | Caricamento | Vuoto | Errore |
|---|---|---|---|
| Git accounts | 2 righe scheletro | «No git accounts yet. A project needs one to connect a repository.» / «Nessun account git. Un progetto ne ha bisogno per collegare un repository.» + **New account** (o la frase con **Who?**) | «Couldn't load the git accounts.» · **Retry** |
| Plugins | 2 righe scheletro | «No plugins yet. Claude works with Stubwise's base plugin only.» / «Nessun plugin. Claude lavora solo col plugin base di Stubwise.» + **Register plugin** | «Couldn't load the plugins.» · **Retry** |
| Plugin | testata + 6 righe | inventario: «No inventory yet.» | «Couldn't load this plugin.» · **Retry**; rimosso o inesistente: «not found» con «← Plugins» |
| Google | 2 righe scheletro | «No Google apps yet. Without one, no one can connect Gmail or Calendar.» / «Nessuna app Google. Senza, nessuno può collegare Gmail o Calendar.» + **Add an app** | «Couldn't load the Google apps.» · **Retry** |
| Storage | modulo scheletro | «○ Not set up» col modulo vuoto | «Couldn't load the storage settings.» · **Retry** |
| Webhooks | modulo + anteprima scheletro | spento, senza indirizzo: «Messages are off.» / «I messaggi sono spenti.» | «Couldn't load the webhook.» · **Retry** |

- **Senza permessi**: ogni voce assente dalla colonna senza il suo permesso;
  per indirizzo «not found». Git accounts in sola lettura con `.view`.
- **Istanza vuota**: nessun account, plugin, app; archiviazione «Not set
  up»; webhook spento.
- **Rifiuti** (in parole, stato invariato): `forbidden` «You can no longer
  change this.»; `in_use` come nei dialoghi; `invalid` sotto il campo;
  `conflict` (due registrazioni dello stesso indirizzo nello stesso istante)
  «Someone just registered this address.» / «Qualcuno ha appena registrato
  questo indirizzo.»; `reauth_required` annullato «Nothing was changed.»;
  errore «Couldn't save. Try again.» · **Retry**.
- **Intervalli**: 0–10 account git, 0–40 repository per account; 0–20
  plugin, 0–60 skill e 0–10 hook ciascuno; 0–6 app Google, 1–10 domini;
  21 eventi del webhook. Indirizzi e nomi lunghi: ellissi nella riga,
  interi nel `title` e nella pagina.

## 6. Interazione e layout

- Contenuto fino a 880px; Outgoing webhooks fino a 1040px (due colonne);
  pagina del plugin fino a 880px.
- Dopo un dialogo il fuoco torna al controllo che l'ha aperto; dopo la
  creazione va alla riga nuova.
- Plugin in preparazione: la riga aggiorna stato e smoke senza saltare
  (altezza fissa), annuncio `aria-live` «superpowers is ready.» / «superpowers
  è pronto.»
- **1440×900**: righe a due linee; webhook con l'anteprima a destra.
- **1024×680** (720px utili):
  - nelle righe la credenziale e l'uso scendono su una terza riga se non ci
    stanno; «Validate» resta sulla prima;
  - Outgoing webhooks a una colonna: l'anteprima scende sotto gli eventi,
    chiusa di default dietro **Show preview** / **Mostra l'anteprima**;
  - pagina del plugin: il comando degli hook va a capo sotto chiave ed
    evento;
  - dialoghi a 480/560px, centrati.

## 7. Vincoli

- Solo via `data/queries/instance.ts` (`listGitAccounts`, `createGitAccount`,
  `updateGitAccount`, `replaceGitToken`, `validateGitAccount`,
  `deleteGitAccount`, `setDefaultReviewer`, `listPlugins`, `getPlugin`,
  `registerPlugin`, `updatePluginRef`, `rerunSmoke`, `removePlugin`,
  `simulateNextPluginOutcome`, `listGoogleApps`, `createGoogleApp`,
  `updateGoogleApp`, `replaceGoogleSecret`, `deleteGoogleApp`, `getStorage`,
  `saveStorage`, `setAttachments`, `testStorage`, `getWebhook`,
  `saveWebhook`, `testWebhook`, `previewWebhook`, `WEBHOOK_EVENTS`).
- `SecretField` per token git, client secret, chiave S3; mai per l'URL del
  webhook.
- Le etichette di «⋯» del plugin non usano «Re-run»/«Rerun» (en) né
  «Rilancia» (it): «Run the smoke test again» / «Rifai lo smoke test».
- **+R**: `createGitAccount`, `replaceGitToken`, `deleteGitAccount`,
  `registerPlugin`, `updatePluginRef`, `createGoogleApp`,
  `replaceGoogleSecret`, `deleteGoogleApp`, `saveStorage` con chiave nuova.
  Non: webhook, revisore predefinito, verifica, smoke, rimozione del plugin,
  allegati.
- **Voci del registro** (gruppo `integrations`):
  - `git_account.created`: «**Roberta Fontana** added the git account
    **GitHub Release** (GitHub).» / «**Roberta Fontana** ha aggiunto
    l'account git **GitHub Release** (GitHub).»
  - `git_account.updated`: «…changed the git account **Bitbucket Audin**.»
    / «…ha modificato l'account git **Bitbucket Audin**.» («workspace audin
    → audin-srl»)
  - `git_account.token_replaced`: «…replaced the token of **Bitbucket
    Audin**.» / «…ha sostituito il token di **Bitbucket Audin**.»
  - `git_account.deleted`: «…deleted the git account **GitHub Old**.» /
    «…ha eliminato l'account git **GitHub Old**.»
  - `git_account.default_reviewer_changed`: «…made **GitHub Stubwise** the
    default reviewer on GitHub.» / «…ha reso **GitHub Stubwise** revisore
    predefinito su GitHub.» («GitHub Old → GitHub Stubwise»)
  - `plugin.registered`: «…registered the plugin **superpowers** at
    v4.0.3.» / «…ha registrato il plugin **superpowers** a v4.0.3.»
  - `plugin.ref_updated`: «…updated **superpowers** to a new ref.» / «…ha
    aggiornato **superpowers** a un nuovo ref.» («v4.0.3 → v4.1.0»)
  - `plugin.smoke_rerun`: «…ran the smoke test of **superpowers** again.» /
    «…ha rifatto lo smoke test di **superpowers**.»
  - `plugin.removed`: «…removed the plugin **lint-helpers**.» / «…ha rimosso
    il plugin **lint-helpers**.»
  - `google_app.created` / `.updated` / `.secret_replaced` / `.deleted`:
    «…added / changed / replaced the client secret of / deleted the Google
    app **Audin Workspace**.» / «…ha aggiunto / modificato / sostituito il
    client secret di / eliminato l'app Google **Audin Workspace**.» (domini
    nel prima/dopo di `.updated`)
  - `storage.changed`: «…changed the storage settings.» / «…ha cambiato le
    impostazioni dell'archiviazione.» («Attachments on → off»; «bucket
    stubwise-files → stubwise-prod»)
  - `storage.secret_replaced`: «…replaced the storage secret key.» / «…ha
    sostituito la chiave segreta dell'archiviazione.»
  - `webhook.changed`: «…changed the outgoing webhook.» / «…ha cambiato il
    webhook in uscita.» con l'**URL nel prima/dopo** («https://hooks.slack
    .com/…/T01 → https://hooks.slack.com/…/T02») e gli eventi («+ release
    failed · − PR opened»).

## Scelte del brief (scelte del controller, da confermare)

1. **[IN 1]** Ogni integrazione è una riga con credenziale, ultima prova e
   uso; la prova è l'unico bottone sulla riga, il resto in «⋯».
2. **[IN 2]** Il dialogo del plugin mette l'avviso «registrare esegue il
   codice» **prima** dei campi e chiede la casella «Mi fido», oltre alla
   riconferma (anche per «Aggiorna a un ref»).
3. **[IN 3]** Spegnere l'archiviazione blocca solo i caricamenti nuovi; i
   file già caricati restano leggibili.
4. **[IN 4]** Gli eventi del webhook: i 13 del web più 8 del catalogo
   (rilasci, problemi della PR, nota di rilascio, task da automazione,
   richiesta nel backlog, diagnosi del server); esclusi le risposte dei
   clienti, gli avvisi personali e la posta.
5. **[IN 5]** Il diff dell'inventario fra revisioni del plugin non si porta
   nel 9b.

## Scelte confermate dal maintainer (30 ott 2026)

1. **[IN 2]** La casella «I trust this repository and this commit» / «Mi
   fido di questo repository e di questo commit» è obbligatoria, insieme alla
   riconferma, per registrare **e** per aggiornare un plugin.
2. **[IN 4]** Gli eventi del webhook sono i 13 del web più gli 8 del
   catalogo della tabella; le risposte dei clienti
   (`support.customer_replied`) **non** escono col webhook.
