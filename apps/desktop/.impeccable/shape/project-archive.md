# Shape brief — Archiviare, riaprire ed eliminare un progetto; i repository rimasti senza progetto

> Shape scritto dal controller senza intervista (31 ott 2026): le domande di
> discovery non sono state fatte al maintainer. Dove design e piano non
> bastavano la scelta è marcata **scelta del controller** e numerata
> **[AR n]** in fondo. Valgono come scritte le decisioni del maintainer del
> 31 ott 2026 (piano 9c):
> - **domanda 1 (a)**: un progetto archiviato si apre in una **pagina sua**,
>   in sola lettura, con sintesi, membri, conteggi, Reopen e Delete;
> - **domanda 2 (b)**: i repository di un progetto eliminato **restano senza
>   progetto**, nel gruppo «Not in any project» di Amministrazione →
>   Repositories; si collegano a un altro progetto con `repos.manage` nel
>   progetto di destinazione o da full admin; il dialogo di Delete li conta;
>   il collegamento scrive `repository.linked`; da dove vengono lo leggono
>   solo gli ex membri e il full admin;
> - **domanda 4 (a)**: le esecuzioni aperte delle automazioni si annullano
>   con la nota «Project archived» e non rendono il progetto `busy`.

Superficie:
- la sezione **Archive** di Settings (`/p/<CODE>/settings/archive`) con il
  dialogo **Archive** e il suo `busy`;
- la scheda **Archived** di All projects (`/projects?view=archived`);
- la **pagina del progetto archiviato** (`/archived/<CODE>`), con i dialoghi
  **Reopen** e **Delete**;
- cosa si legge **dopo l'eliminazione**;
- in Amministrazione (`admin-instance.md` del 9b, che qui si estende): il
  gruppo **Not in any project** di Repositories, il dialogo **Link to a
  project…**, la riga «Only in archived projects» di Servers, la riga «not in
  any project» di Git accounts.

Piano 9c: Task 11 (dati: Task 5). Spec area 9: «Impostazioni del progetto
(9c) → Archive», «Anti-obiettivi» (un registro che rivela), Review Focus 3 e
4. Mondo: «Catalogo numerato», modalità **Operate**.

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi chiude una commessa** (Laura in ACQ, Giulia Ferri in RNC;
    `project.settings.manage`): il lavoro è finito e il progetto non deve
    più ingombrare binario, ⌘K e notifiche di nessuno, ma la storia deve
    restare leggibile per i membri. Teme di **perdere qualcosa** o di
    **fermare Claude a metà**.
  - **Chi riapre** (Giulia, sei mesi dopo, quando il cliente torna): vuole
    ritrovare tutto com'era, interruttori compresi.
  - **Chi elimina per sempre** (Roberta Fontana, full admin): una volta
    l'anno, per un progetto archiviato da tempo. Vuole **vedere prima cosa
    sparisce e cosa resta** (server, repository), e non poterlo fare per
    sbaglio.
  - **Chi raccoglie i repository rimasti** (Laura, `repos.manage` in ACQ):
    trova `shop-frontend` in «Not in any project» e lo porta nel suo
    progetto. **Non deve sapere** da quale progetto viene, se non ne era
    membro.
- **Stato d'animo**: gesto importante, raro, e due livelli di gravità
  diversi: **archiviare si torna indietro**, eliminare no. Il disegno lo
  deve far sentire.

## 2. Esito e prova

- **Azioni primarie**: archiviare (con l'attesa detta in parole se Claude
  lavora o un rilascio è in corso); leggere gli archiviati; aprire la pagina
  di un archiviato; riaprire; eliminare per sempre scrivendo il codice e
  riconfermando; collegare un repository senza progetto a un progetto.
- **Successo**, a 1440×900:
  - Laura in ACQ → Settings → Archive premo **Archive ACQ…**; con Claude al
    lavoro il dialogo dice «Claude is working on ACQ-57 “Fix the bill
    download”. Wait for it to finish, or stop it from the task, then archive
    again.»; finita la sessione, confermo: torno ad All projects, ACQ non c'è
    nel binario né in Projects, ed è in **Archived**;
  - Giulia apre **Archived**, legge «RNC · Vetrina online Tenuta Ronchi ·
    Archived Oct 3 by Roberta Fontana», apre la pagina, legge la sintesi, i
    membri, i conteggi e «When reopened: …», preme **Reopen**: RNC torna nel
    binario;
  - Roberta preme **Delete for good…** su RNC, legge i conteggi, «1
    repository stays without a project: shop-frontend», «1 server stays
    without a project: SRV-9», scrive «RNC», riconferma; il toast dice «RNC
    was deleted. 1 repository is now in no project.» e torna ad Archived;
  - in Amministrazione → Repositories Roberta legge il gruppo NOT IN ANY
    PROJECT con «shop-frontend · from RNC · Vetrina online Tenuta Ronchi»;
    Laura legge la stessa riga **senza** «from», preme **Link to a
    project…**, sceglie ACQ, e il repository è in ACQ → Settings →
    Repositories.
- **Verità del prodotto**:
  - **un archiviato è invisibile come uno inesistente** a chi non ne era
    membro e non è full admin (R-G5): nessuna scheda, nessun indirizzo,
    nessuna voce;
  - **anche per membri e full admin sparisce da binario, All projects, ⌘K,
    Home e notifiche**: lo trovano solo in Archived, in sola lettura; Claude
    non lo vede mai;
  - **archiviare non tocca niente**: interruttori, membri, notifiche restano,
    nascosti a lettura; Reopen li ridà com'erano;
  - **eliminare è del solo full admin, solo da archiviato**, scrivendo il
    codice esatto e riconfermando;
  - **i repository restano, senza progetto**; il webhook torna non
    configurato, e perdono file d'ambiente, pagine dei Docs, PR e rilasci;
  - **«from RNC» solo a chi poteva saperlo**.

## 3. Direzione scelta

- **Tesi**: **due gesti, due pesi**. Archiviare è un'azione **secondaria**
  con le conseguenze in righe e nessuna riconferma; eliminare è
  un'azione **`critical`** che vive solo sulla pagina dell'archiviato, mostra
  l'inventario di ciò che sparisce e di ciò che resta, e chiede il codice e
  la riconferma. L'archiviato ha **una pagina di catalogo**: la sua scheda
  d'archivio, non un progetto spento **[AR 1]**.

### Archive (`/settings/archive`)

- Si vede da ogni membro; si scrive con `project.settings.manage` (senza:
  bottone spento con **Who?** `manageProjectSettings`, riga ○ di [PS 3]).
- h1 «Archive» / «Archivia» · prosa «Archive ACQ when the work is over. It
  can be reopened at any time; only a full admin can delete it for good, and
  only once it's archived.» / «Archivia ACQ quando il lavoro è finito. Si può
  riaprire in ogni momento; solo un full admin può eliminarlo per sempre, e
  solo dopo averlo archiviato.»
- **WHAT HAPPENS** / **COSA SUCCEDE** (`heading-group`), righe 14px con ○:
  - «ACQ leaves the rail, All projects, ⌘K, Home and notifications, for
    everyone.» / «ACQ esce da binario, Tutti i progetti, ⌘K, Home e
    notifiche, per tutti.»
  - «Its members and full admins can still read it, in All projects →
    Archived.» / «I suoi membri e i full admin possono ancora leggerlo, in
    Tutti i progetti → Archiviati.»
  - «Its automations stop and no new Claude work starts. Automation runs
    still open are cancelled, with the note “Project archived”.» / «Le sue
    automazioni si fermano e non parte nuovo lavoro di Claude. Le esecuzioni
    delle automazioni ancora aperte si annullano, con la nota “Progetto
    archiviato”.»
  - «Nothing is deleted. Reopen brings it back as it was, settings
    included.» / «Non si cancella niente. Riapri lo riporta com'era,
    impostazioni comprese.»
- **Archive ACQ…** / **Archivia ACQ…** (secondario, non `critical`: si torna
  indietro).
- Sotto, 13px `ink-muted`: «Deleting for good happens from the archived
  project's page, and only a full admin can do it.» / «L'eliminazione
  definitiva si fa dalla pagina del progetto archiviato, e solo un full
  admin può farla.» (nessun bottone qui: un progetto attivo non si elimina)
  **[AR 2]**.

#### Il dialogo Archive (480px)

- «Archive ACQ?» / «Archiviare ACQ?» · le quattro righe di sopra in breve ·
  in più, se ci sono esecuzioni d'automazione aperte (dalla vista):
  «2 automation runs still open will be cancelled.» / «2 esecuzioni delle
  automazioni ancora aperte verranno annullate.» **[AR 3]**
- **Archive** / **Archivia** (primario) · **Cancel**. Nessuna riconferma
  (si torna indietro, *scelta del controller* del piano).
- **`busy`** (la risposta del livello dati): il dialogo resta aperto e
  cambia contenuto, con ▲ `warning` e il titolo «ACQ can't be archived yet»
  / «ACQ non si può ancora archiviare», poi una riga per ragione:
  - sessione viva: «▸ Claude is working on **ACQ-57** “Fix the bill
    download”.» / «▸ Claude sta lavorando su **ACQ-57** “Correggi lo
    scaricamento della bolletta”.» (codice link alla task; una sessione
    senza codice: il solo titolo, «▸ Claude is working on “Prepare the
    release notes”.»);
  - sessione in attesa (`waiting`): «◷ **ACQ-61** “…” is waiting for the
    queue to resume.» / «◷ **ACQ-61** “…” aspetta la ripresa della coda.»;
  - rilascio: «▸ The release **ACQ-R12** is running.» / «▸ Il rilascio
    **ACQ-R12** è in corso.»
  - poi, sempre: «Wait for it to finish, or stop it from its page, then
    archive again.» / «Aspetta che finisca, o fermalo dalla sua pagina, poi
    archivia di nuovo.» (al plurale con più ragioni: «Wait for them…» /
    «Aspetta che finiscano…»);
  - **Archive again** / **Archivia di nuovo** (primario) · **Close** /
    **Chiudi**. Nessun lavoro viene fermato da qui **[AR 4]**.
- **Riuscito**: il dialogo si chiude, la pagina va ad **All projects**
  (scheda Projects), il fuoco all'h1, toast «ACQ is archived. Its members
  find it in Archived.» / «ACQ è archiviato. I suoi membri lo trovano in
  Archiviati.» · **Open Archived** / **Apri Archiviati**.
- Altri rifiuti: `already_archived` «Someone already archived ACQ.» /
  «Qualcuno ha già archiviato ACQ.» (stesso arrivo in All projects);
  `forbidden` «You can no longer change this.».

### All projects → Archived (`/projects?view=archived`)

- **Scheda** «Archived» / «Archiviati» dopo Projects · Stalled · Activity,
  **solo per chi ne vede almeno uno** (`listArchivedProjects` non vuoto),
  col numero accanto («Archived 1»). Per gli altri non esiste, e
  `?view=archived` apre Projects senza messaggio.
- Prosa sopra l'elenco: «Projects that are over. You can read them; reopen
  one to work in it again.» / «Progetti chiusi. Puoi leggerli; riaprine uno
  per lavorarci di nuovo.»
- **Riga** (56px, due righe; intera riga link a `/archived/<CODE>`): **codice**
  600 cifre tabellari · **nome** · cliente 13px `ink-muted` · seconda riga
  «Archived Oct 3 by Roberta Fontana» / «Archiviato il 3 ott da Roberta
  Fontana» (persona disattivata «(deactivated)») · a destra **Reopen** /
  **Riapri** (secondario; spento con **Who?** `manageProjectSettings` senza
  `canReopen`) e «⋯» con **Delete for good…** / **Elimina per sempre…**
  (spenta con **Who?** `deleteProjects` senza `canDelete`).
- Ordine: archiviati più di recente in alto. Nessun segno di fissato,
  nessuna striscia, nessun conteggio di task aperte.
- Un archiviato **non** è in ⌘K (nemmeno cercando il codice o il nome), né
  nel binario, né fra i fissati.

### La pagina dell'archiviato (`/archived/<CODE>`)

- Fuori da `/p/` (il progetto non è «visibile»): nessuna colonna del
  progetto; la colonna resta quella di All projects. «not found» uguale a un
  codice inesistente per chi non può vederlo (Sara, ACQ per Laura dopo un
  Delete).
- **Testata**: «← Archived» / «← Archiviati» · fascia 13px con ○ a tutta
  larghezza, filetto sotto: «Archived on Oct 3 by Roberta Fontana. Read
  only: reopen it to work in it again.» / «Archiviato il 3 ott da Roberta
  Fontana. Sola lettura: riaprilo per lavorarci di nuovo.» · **codice** a 28px
  e **nome** a 16px (come la testata di colonna) · cliente 13px · a destra
  **Reopen** (primario; spento con **Who?**) e **Delete for good…**
  (secondario `critical`; spento con **Who?** `deleteProjects`).
- **SUMMARY** / **SINTESI**: la descrizione (o «No description.» / «Nessuna
  descrizione.»).
- **MEMBERS** / **MEMBRI**: righe 40px avatar · nome · ruolo di progetto in
  parola; nessuna azione. Sotto, 12px: «Full admins can read it too.» /
  «Possono leggerlo anche i full admin.»
- **WHAT'S IN IT** / **COSA CONTIENE**: elenco a due colonne, numero in
  cifre tabellari a destra della parola: Tasks · Requests · Docs pages ·
  Conversations · Channels · Drive files · Automations · Environments ·
  Environment files · Releases / Task · Richieste · Pagine dei Docs ·
  Conversazioni · Canali · File del Drive · Automazioni · Ambienti · File
  d'ambiente · Rilasci (gli zeri restano: dicono che non c'è niente). Sotto:
  «To open them, reopen the project.» / «Per aprirli, riapri il progetto.»
  **[AR 5]**
- **REPOSITORIES** / **REPOSITORY**: i nomi (`shop-frontend`) e la frase «If
  RNC is deleted, these stay without a project and can be linked to another
  one.» / «Se RNC viene eliminato, questi restano senza progetto e si possono
  collegare a un altro.» Nessun repository: la sezione non c'è.
- **WHEN REOPENED** / **ALLA RIAPERTURA**: «These come back on: Backlog
  discovery, Pulse every 7 days, Weekly brief. Docs updated every night and
  Daily report stay off.» / «Tornano accesi: Discovery del backlog, Pulse
  ogni 7 giorni, Brief settimanale. Docs aggiornati ogni notte e Report
  giornaliero restano spenti.» (da `switchesOnReopen`; con tutto spento
  «Every automation stays off.» / «Ogni automazione resta spenta.»)
  *Ruling del controller (pre-flight)*, P28: l'esempio di prima accendeva
  il pulse con la discovery spenta, che `pulse_needs_backlog` vieta, e i
  Docs notturni e il report su RNC, che è `client` e nel seme li ha spenti.
- **Change log**: link «Its change log» / «Il suo registro delle modifiche»
  verso Amministrazione → Change log filtrato su RNC, solo per chi vede il
  registro d'Amministrazione e ne legge le voci (R-M1).

#### Reopen (dialogo 440px)

- «Reopen RNC?» / «Riaprire RNC?» · righe:
  - «It comes back in the rail, All projects, ⌘K and Home for its
    members.» / «Torna nel binario, in Tutti i progetti, ⌘K e Home per i suoi
    membri.»
  - «Its settings are as they were.» / «Le impostazioni sono com'erano.»
  - «Automations start again from new events: what happened while it was
    archived isn't caught up.» / «Le automazioni ripartono dagli eventi
    nuovi: ciò che è successo mentre era archiviato non si recupera.»
  - «Notifications its members had come back.» / «Le notifiche che i membri
    avevano tornano.»
- **Reopen** (primario) → nessuna riconferma → la pagina va a `/p/RNC`
  (Overview), toast «RNC is open again.» / «RNC è di nuovo aperto.» Dalla
  riga di Archived: stesso dialogo, e si resta in Archived (la riga sparisce,
  il fuoco va alla riga successiva o, se non ce n'è, al titolo della scheda).
- Rifiuti: `invalid` (non più archiviato: qualcuno l'ha già riaperto) «Someone
  already reopened RNC.» / «Qualcuno ha già riaperto RNC.» e si va a `/p/RNC`;
  `not_found` (eliminato nel frattempo) «RNC no longer exists.» / «RNC non
  esiste più.» e ritorno ad Archived.

#### Delete for good (dialogo 560px)

- Si apre dalla pagina o dal «⋯» della riga, solo per il full admin. Legge
  `getDeletionPreview`: caricamento con 6 righe scheletro; errore «Couldn't
  load what would be deleted, so nothing can be deleted now.» / «Impossibile
  caricare cosa verrebbe eliminato, quindi ora non si può eliminare
  niente.» · **Retry** / **Riprova**.
- Titolo «Delete RNC for good?» / «Eliminare RNC per sempre?» · prima riga, in
  `critical` con ✕: «This can't be undone.» / «Non si può tornare indietro.»
- **DELETED** / **ELIMINATO** (`heading-group`), elenco a due colonne dei
  conteggi **non zero** («6 tasks», «2 requests», «2 Docs pages», «1
  conversation», «1 channel and its messages», «3 Drive files», «1
  environment», «1 environment file») e una riga «and its members, settings
  and notifications» / «e i suoi membri, le impostazioni e le notifiche».
- **STAYS WITHOUT A PROJECT** / **RESTA SENZA PROGETTO** (solo se c'è
  qualcosa):
  - «1 repository: **shop-frontend**. It keeps its address, git account and
    commands, and can be linked to another project from Administration →
    Repositories. Its environment files, Docs pages and pull requests go.» /
    «1 repository: **shop-frontend**. Tiene indirizzo, account git e
    comandi, e si può collegare a un altro progetto da Amministrazione →
    Repository. File d'ambiente, pagine dei Docs e pull request se ne
    vanno.» (al plurale: «2 repositories: shop-frontend, shop-admin.»);
  - «1 server: **SRV-9**. It stays in Administration → Servers, not in any
    project.» / «1 server: **SRV-9**. Resta in Amministrazione → Server, in
    nessun progetto.» (R-L7).
- Riga 13px: «The instance's change log keeps a line saying you deleted RNC.»
  / «Il registro delle modifiche dell'istanza tiene una riga che dice che hai
  eliminato RNC.»
- **Type RNC to confirm** / **Scrivi RNC per confermare**: campo 160px
  (cifre tabellari); **Delete for good** / **Elimina per sempre**
  (`critical`) spento finché il testo non è **esattamente** il codice. Se il
  testo ha la lunghezza giusta ma è diverso (anche solo per le minuscole):
  12px sotto «Type it exactly as shown: RNC.» / «Scrivilo esattamente così:
  RNC.» **[AR 6]**
- **Delete for good** → riconferma (`entry.md`) → riuscito: il dialogo si
  chiude; si torna ad **All projects → Archived** (o a Projects, se Archived
  è ora vuoto e la scheda sparisce); il fuoco va al **titolo della scheda**
  (o all'h1); toast «RNC was deleted. 1 repository is now in no project.» /
  «RNC è stato eliminato. 1 repository ora non è in nessun progetto.» ·
  **Open Repositories** / **Apri Repository** (solo per chi vede quella voce
  d'Amministrazione; senza repository rimasti, solo «RNC was deleted.» /
  «RNC è stato eliminato.»).
- Rifiuti (stato invariato, dialogo aperto): `not_archived` «RNC was reopened
  in the meantime. Nothing was deleted.» / «RNC è stato riaperto nel
  frattempo. Non è stato eliminato niente.» (poi si chiude e si va a
  `/p/RNC`); `forbidden` «Only a full admin can delete a project.» / «Solo
  un full admin può eliminare un progetto.»; `code_mismatch` (prevenuto)
  «The code doesn't match. Nothing was deleted.»; riconferma annullata
  «Nothing was deleted.» / «Non è stato eliminato niente.»

### Amministrazione → Repositories: «Not in any project» (estende `admin-instance.md`)

- **Gruppo** NOT IN ANY PROJECT / IN NESSUN PROGETTO **dopo** i gruppi per
  progetto, **solo se non è vuoto**; a destra «1 repository». Lo vede chi
  vede la voce (`repos.manage` in almeno un progetto) e il full admin.
- **Riga** (60px, due righe; **non** è un link: non c'è un progetto in cui
  aprirla):
  - **nome** 600 · nome completo 13px `ink-muted` · account git per nome (o
    «No git account») · a destra **Link to a project…** / **Collega a un
    progetto…** (secondario);
  - seconda riga 13px `ink-muted`:
    - con `formerProject` (ex membri, full admin): «From **RNC** · Vetrina
      online Tenuta Ronchi, deleted Oct 31» / «Da **RNC** · Vetrina online
      Tenuta Ronchi, eliminato il 31 ott»;
    - senza: «Without a project since Oct 31» / «Senza progetto dal 31
      ott». **Nient'altro** nella riga, nel `title`, nel DOM o nella ricerca
      lascia intuire il progetto **[AR 7]**.
- **Find a repository** cerca nel nome e nel nome completo; nel progetto
  d'origine solo se `formerProject` c'è.
- **Link to a project…** spento quando `linkTargets` è vuoto: 12px «None of
  your projects can take it: you need to manage repositories in an active
  project.» / «Nessuno dei tuoi progetti può prenderlo: serve poter gestire
  i repository in un progetto attivo.» + **Who?** (`manageRepos`).
- **Il dialogo** (440px): «Link shop-frontend to a project» / «Collega
  shop-frontend a un progetto» · **Project** / **Progetto**: menu dei soli
  `linkTargets` (codice + nome, in ordine di codice) · righe:
  - «It joins with its address, git account, commands and protected
    branches.» / «Entra con indirizzo, account git, comandi e rami
    protetti.»
  - «Its webhook starts not configured, and it has no environment files.» /
    «Il webhook parte non configurato, e non ha file d'ambiente.»
  - **Link** / **Collega** (primario) → nessuna riconferma → toast
    «shop-frontend is now in ACQ.» / «shop-frontend ora è in ACQ.» · **Open**
    / **Apri** (ACQ → Settings → Repositories `?repo=`).
  - Rifiuti, dialogo aperto, stato invariato: `name_taken` «ACQ already has a
    repository called shop-frontend. Choose another project.» / «ACQ ha già
    un repository che si chiama shop-frontend. Scegli un altro progetto.»;
    `forbidden` «You can't manage ACQ's repositories anymore.» / «Non puoi
    più gestire i repository di ACQ.» (il menu si ricarica); `not_found`
    «That project is no longer available, or someone already linked this
    repository. Nothing changed.» / «Quel progetto non è più disponibile, o
    qualcuno ha già collegato questo repository. Non è cambiato niente.»
    (il dialogo si chiude e l'elenco si ricarica).
- **Il fuoco**, dopo il collegamento: la riga sparisce dal gruppo; il fuoco va
  al **Link to a project…** della riga successiva nel gruppo; se il gruppo
  sparisce, all'**h1** della pagina **[AR 8]**. Dopo un annullamento, al
  bottone che l'ha aperto.
- **Delete…** / **Elimina…** **[AR 9]** (**confermata dal maintainer il 31
  ott 2026**, domanda 4 (b)): solo per il **full admin**, nel «⋯» della riga
  (per gli altri il «⋯» non c'è: la riga ha solo **Link to a project…**).
  - Dialogo 440px: «Delete shop-frontend for good?» / «Eliminare
    shop-frontend per sempre?» · righe:
    - «✕ This can't be undone.» / «✕ Non si può tornare indietro.»
      (`critical`);
    - «Stubwise forgets its address, commands and protected branches. The
      repository on GitHub isn't touched.» / «Stubwise dimentica
      indirizzo, comandi e rami protetti. Il repository su GitHub non
      viene toccato.»;
    - con un account git: «GitHub Shop stops counting it as in use.» /
      «GitHub Shop smette di contarlo come in uso.» (*ruling del
      controller (pre-flight)*, P25: nel seme `shop-frontend` sta su un
      terzo account, «GitHub Shop», che nessun altro repository usa).
  - **Delete** / **Elimina** (`critical`) → riconferma (`entry.md`) → la
    riga sparisce, toast «shop-frontend deleted.» / «shop-frontend
    eliminato.»; il fuoco come dopo un collegamento ([AR 8]).
  - Rifiuti (stato invariato): `not_found` (collegato o eliminato nel
    frattempo) «Someone already linked or deleted this repository. Nothing
    changed.» / «Qualcuno ha già collegato o eliminato questo repository.
    Non è cambiato niente.» e l'elenco si ricarica; `forbidden` «Only a full
    admin can delete it.» / «Solo un full admin può eliminarlo.»; riconferma
    annullata «Nothing was deleted.» / «Non è stato eliminato niente.»
  - Nessun «Who?» nel «⋯» per chi non è full admin: la voce non c'è (chi
    vede la riga ha già la sua azione, Link).

### Le altre righe d'Amministrazione

- **Git accounts** (`admin-integrations.md`): un repository senza progetto
  nell'uso di un account si legge «shop-frontend (not in any project)» /
  «shop-frontend (in nessun progetto)», senza codice; il rifiuto `in_use` di
  Delete lo elenca allo stesso modo. Eliminato il repository senza progetto
  ([AR 9]), l'account non lo conta più come in uso.
- **Servers** (`admin-instance.md`): un server legato solo ad ambienti di
  progetti archiviati ha la colonna dei progetti vuota e, sulla seconda riga,
  «Only in archived projects» / «Solo in progetti archiviati», senza nomi né
  numeri.
- **Change log** d'Amministrazione: la voce `project.deleted` (sotto); un
  archiviato compare nel filtro dei progetti solo per chi ne legge le voci,
  con «(archived)» / «(archiviato)» accanto al nome.

```
1440 ── All projects → Archived (Giulia) ───────────────────────────────────────
│ All projects                                                                 │
│ Projects   Stalled   Activity   Archived 1                                   │
│ ─────────────────────────────────────────── ━━━━━━━━━━ ───────────────────── │
│ Projects that are over. You can read them; reopen one to work in it again.  │
│ RNC  Vetrina online Tenuta Ronchi   Tenuta Ronchi Srl        [Reopen]  ⋯    │
│      Archived Oct 3 by Roberta Fontana                                       │

1440 ── /archived/RNC (Roberta) ─────────────────────────────────────────────────
│ ← Archived                                                                   │
│ ○ Archived on Oct 3 by Roberta Fontana. Read only: reopen it to work in it  │
│   again.                                                                     │
│ RNC  Vetrina online Tenuta Ronchi              [Reopen] [Delete for good…]   │
│ Tenuta Ronchi Srl                                                            │
│ SUMMARY ──────────────────────────  MEMBERS ─────────────────────────────── │
│ Online shop window for the estate…  GF Giulia Ferri      Project Lead        │
│                                     MB Marco Bellini     Developer           │
│ WHAT'S IN IT ─────────────────────  EB Elena Moretti     Legacy Member       │
│ Tasks            6  Channels     1  REPOSITORIES ────────────────────────── │
│ Requests         2  Drive files  3  shop-frontend                            │
│ Docs pages       2  Automations  0  If RNC is deleted, these stay without a │
│ Conversations    1  Environments 1  project and can be linked to another.   │
│ WHEN REOPENED ─────────────────────────────────────────────────────────────── │
│ These come back on: Backlog discovery, Pulse every 7 days, Weekly brief. … │
```

## 4. Ambito e confini

- **Dentro**: Archive con `busy` in parole; scheda Archived; pagina
  dell'archiviato; Reopen; Delete con conteggi, ciò che resta, codice e
  riconferma; il gruppo «Not in any project», il collegamento e
  l'eliminazione da full admin; le righe
  d'Amministrazione che cambiano; le voci del registro.
- **Fuori**: fermare il lavoro di Claude dal dialogo di Archive; riaprire
  da ⌘K; aprire le task o i file di un archiviato (si riapre); eliminare un
  progetto attivo; eliminare un repository che sta in un progetto;
  recuperare gli eventi persi mentre era archiviato.
- **Anti-obiettivi**: «RNC», «Ronchi» o «Tenuta Ronchi Srl» in qualunque
  superficie letta da chi non ne era membro (righe, `title`, ricerca, voci,
  toast, conteggi di Delete); un archiviato in ⌘K, nel binario, nelle
  notifiche o in Home; un Delete senza codice o senza riconferma; un Archive
  con un bottone `critical` che lo fa sembrare irreversibile; un Delete
  `critical` raggiungibile da un progetto attivo; una riga di «Not in any
  project» che si apre su un progetto.

## 5. Stati e intervalli

| Superficie | Caricamento | Vuoto | Errore |
|---|---|---|---|
| Archive | 4 righe scheletro | — | «Couldn't load ACQ's settings.» · **Retry** / **Riprova** |
| Archived | 3 righe scheletro da 56px | la scheda non esiste | «Couldn't load the archived projects.» / «Impossibile caricare i progetti archiviati.» · **Retry** |
| Pagina dell'archiviato | testata + 4 blocchi scheletro | descrizione vuota, nessun repository: come sopra | «Couldn't load RNC.» / «Impossibile caricare RNC.» · **Retry**; invisibile o inesistente: «not found» con «← All projects» |
| Anteprima di Delete | 6 righe scheletro | nessun repository o server che resta: il gruppo non c'è | sopra |
| Not in any project | dentro lo scheletro di Repositories | il gruppo non c'è | come Repositories |

- **Senza permessi**: Archive in sola lettura (riga ○, bottone spento con
  «Who?»); in Archived e sulla pagina Reopen e Delete spenti con «Who?» (la
  pagina resta leggibile); niente scheda Archived per chi non ne vede
  nessuno; `/archived/<CODE>` «not found» come un codice inesistente;
  «Link to a project…» spento con «Who?» senza `linkTargets`; il gruppo
  «Not in any project» `forbidden` per chi non vede la voce (non c'è).
- **Istanza vuota**: nessun progetto, nessun archiviato, nessun gruppo.
- **Intervalli**: 0–50 archiviati (oltre 20, il campo «Find an archived
  project» / «Cerca un progetto archiviato» sopra l'elenco); 1–40 membri
  sulla pagina (oltre 12, «Show all 40» / «Mostra tutti e 40»); conteggi
  fino a migliaia (cifre tabellari con separatore); 0–10 repository e 0–5
  server che restano; 0–30 repository senza progetto; 0–50 `linkTargets`
  (il menu ha la ricerca oltre 10).

## 6. Interazione e layout

- Archive fino a 880px; Archived nella larghezza di All projects; la
  pagina dell'archiviato fino a 1040px.
- Dialoghi: il fuoco va a **Cancel** (Archive, Delete, Reopen: gesti che
  toccano altri) e, in Delete, al campo del codice dopo il caricamento
  dell'anteprima. Dopo un dialogo aperto da un bottone o da «⋯», il fuoco
  torna lì, anche dopo una conferma che cambia la riga; se la riga sparisce,
  come scritto sopra (riga successiva, titolo della scheda, h1).
- **1440×900**: la pagina dell'archiviato a due colonne (SUMMARY e WHAT'S IN
  IT a sinistra 520px, MEMBERS e REPOSITORIES a destra), WHEN REOPENED a
  tutta larghezza sotto; il dialogo di Delete con i conteggi su due colonne.
- **1024×680** (720px utili):
  - la pagina dell'archiviato a **una colonna**: SUMMARY, WHAT'S IN IT (due
    colonne di conteggi), MEMBERS, REPOSITORIES, WHEN REOPENED; Reopen e
    Delete scendono sotto il nome, a sinistra;
  - la riga di Archived: **Reopen** resta a destra della prima riga, il
    cliente scende sulla seconda accanto a «Archived Oct 3…»;
  - il dialogo di Delete (fino a 656px) con i conteggi su due colonne e i
    gruppi uno sotto l'altro;
  - nel gruppo «Not in any project» il bottone **Link to a project…** scende
    sotto la seconda riga, a destra; l'account git va sulla seconda riga.

## 7. Vincoli

- Solo via `data/queries/projectSettings.ts` (`useArchiveProject`,
  `useReopenProject`, `useArchivedProjects`, `useArchivedProject`,
  `useDeletionPreview`, `useDeleteProject`) e `data/queries/instance.ts`
  (`useDetachedRepositories`, `useLinkRepository`,
  `useDeleteDetachedRepository`); `canReopen`, `canDelete`,
  `formerProject`, `linkTargets`, `canDelete` della riga senza progetto, `inArchivedOnly`,
  `switchesOnReopen` e `openAutomationRuns` (dall'anteprima
  d'archiviazione, *ruling del controller*: [AR 3]) dalla vista.
- `/archived/$code` fuori da `/p/$code`; `?view=archived` in All projects.
- ⌘K: nessuna voce per gli archiviati (un test lo prova).
- **+R**: `deleteProject` e `deleteDetachedRepository`. Non: Archive,
  Reopen, Link.
- Testi en/it con parità; nessuna stringa con il nome di un progetto che la
  lettura non ha dato.
- **Voci del registro**:
  - `project.archived` (gruppo `project`, scope progetto): «**Laura Costa**
    archived **ACQ**.» / «**Laura Costa** ha archiviato **ACQ**.»;
  - `project.reopened`: «**Giulia Ferri** reopened **RNC**.» / «**Giulia
    Ferri** ha riaperto **RNC**.» Le voci di un archiviato le legge chi lo
    vede da archiviato (R-M1 su visibili ∪ archiviati), dal registro
    d'Amministrazione; il link porta a `/archived/<CODE>` finché è
    archiviato;
  - `project.deleted` (gruppo `projects`, scope **istanza**, full admin o
    `changelog.view`): a chi era membro o è full admin «**Roberta Fontana**
    deleted the project **RNC** · Vetrina online Tenuta Ronchi. 1 repository
    is now in no project.» / «**Roberta Fontana** ha eliminato il progetto
    **RNC** · Vetrina online Tenuta Ronchi. 1 repository ora non è in nessun
    progetto.»; agli altri «…deleted a project you couldn't see. 1 repository
    is now in no project.» / «…ha eliminato un progetto che non vedevi. 1
    repository ora non è in nessun progetto.» (chiave `changelog.
    hiddenProject`); con 0 repository la seconda frase non c'è; link ad
    Amministrazione → Repositories quando c'è un repository rimasto;
  - `repository.linked` (gruppo `repositories`, nel progetto di
    **destinazione**): «**Laura Costa** linked the repository
    **shop-frontend** to **ACQ**.» / «**Laura Costa** ha collegato il
    repository **shop-frontend** ad **ACQ**.» — **mai** il progetto
    d'origine, per nessuno; link a ACQ → Settings → Repositories;
  - `repository.deleted` (gruppo `projects`, scope **istanza**, come
    `project.deleted`: full admin o `changelog.view`): a chi era membro del
    progetto d'origine o è full admin «**Roberta Fontana** deleted the
    repository **shop-frontend**, which was in no project (from **RNC**).»
    / «**Roberta Fontana** ha eliminato il repository **shop-frontend**, che
    non era in nessun progetto (da **RNC**).»; agli altri la stessa frase
    **senza** la parentesi; nessun link (non c'è più niente da aprire).

## Scelte del brief (scelte del controller, da confermare)

1. **[AR 1]** Due pesi: Archive secondario senza riconferma, Delete
   `critical` solo sulla pagina dell'archiviato, con codice e riconferma.
2. **[AR 2]** La sezione Archive di un progetto attivo non ha un bottone di
   Delete, solo la frase che dice dove e da chi si fa.
3. **[AR 3]** Il dialogo di Archive conta le esecuzioni d'automazione che
   verranno annullate (serve il numero nella vista o nell'anteprima).
4. **[AR 4]** Il `busy` dice cosa aspettare e dove fermarlo; il dialogo non
   ferma niente da sé.
5. **[AR 5]** I conteggi della pagina dell'archiviato non sono link: per
   aprire si riapre.
6. **[AR 6]** Il campo del codice dice «scrivilo esattamente» quando la
   lunghezza è giusta ma il testo è diverso.
7. **[AR 7]** «Without a project since Oct 31» per chi non può sapere da
   dove viene; «From RNC · …» per gli ex membri e il full admin.
8. **[AR 8]** Dopo un collegamento il fuoco va al bottone della riga
   successiva del gruppo, o all'h1 se il gruppo sparisce.
9. **[AR 9]** ~~Un repository senza progetto non si elimina da nessuna
   parte~~: sostituita dalla decisione del maintainer qui sotto.

## Scelte confermate dal maintainer (31 ott 2026)

1. **[AR 9]** Domanda 4 (b): un repository senza progetto **si può
   eliminare**, solo dal full admin, da Amministrazione → Repositories, con
   conferma `critical` e riconferma; voce `repository.deleted`, senza la
   provenienza per chi non la vede; l'account git smette di contarlo come
   «in uso».

## Ruling del controller (31 ott 2026)

1. **[AR 3]** Il numero delle esecuzioni d'automazione da annullare entra
   nella vista d'archiviazione del Task 5 (`getArchivePreview`), con un
   test.
