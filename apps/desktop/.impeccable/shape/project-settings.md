# Shape brief — Progetto → Settings: la colonna, General, AI, Automations, Usage

> Shape scritto dal controller senza intervista (31 ott 2026): le domande di
> discovery non sono state fatte al maintainer. Dove design e piano non
> bastavano la scelta è marcata **scelta del controller** e numerata
> **[PS n]** in fondo. Valgono come scritte le decisioni del maintainer del
> 31 ott 2026 (piano 9c): la discovery backlog spenta spegne il pulse e
> nient'altro (domanda 3 (a)); il report giornaliero spento dice «off» e
> «Generate» a mano resta (domanda 3 (a), effetto in `project-effects.md`).

Superficie: la **colonna di Settings** del progetto (`/p/<CODE>/settings/
<section>`) con le sue undici sezioni e il segno **«View only»**; le sezioni
**General**, **AI**, **Automations**, **Usage**; la regola della **sola
lettura** e del **«Who?»** per tutte le sezioni (anche Repositories,
Integration, Plugins, Archive, che hanno il loro shape). Statuses, Members e
Change log ci sono già (aree 2 e 9a): qui cambia solo come dicono la sola
lettura. Piano 9c: Task 7 (dati: Task 1, 2, 3). Spec area 9: «Impostazioni
del progetto (9c)», «Permessi», «Quanto è vero nel prototipo». Web di
riferimento (cosa si porta, non come appare): `apps/web/src/components/
project-form.tsx`, chiavi `projects.form.*` e `projects.detail.*`. Riusa
`SettingsFrame`/`SettingsState` (9a), `WhoCanLink` (`admin-audit.md`), la
`UsagePanel` (`admin-ai.md`). Mondo: «Catalogo numerato», modalità
**Operate**.

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi guida il progetto** (Laura Costa, Project Lead in ACQ;
    `project.settings.manage`): rinomina il progetto quando il cliente
    cambia nome commerciale, sceglie l'account AI quando un abbonamento è
    sempre al limite, spegne il brief di un progetto in pausa, alza il tetto
    alle correzioni. Lo fa poche volte all'anno, e vuole sapere **l'effetto
    prima** di salvare.
  - **Chi lavora nel progetto senza gestirlo** (Sara Montanari, Contributor
    in ACQ): «perché il brief di ACQ non arriva più?», «con che account
    lavora Claude qui?». Legge, non scrive, e deve trovare **a chi
    chiedere**.
  - **Chi gestisce solo i membri** (una persona con il solo
    `project.members.manage`): entra per Members, e deve capire al primo
    sguardo che il resto lo legge soltanto. È il caso del «View only».
  - **Chi guarda i conti del progetto** (`project.usage.view`): «quanto è
    costato Claude su ACQ questo mese, e in cosa?».
- **Stato d'animo**: manutenzione rara e consapevole. Ogni interruttore dice
  in parole **cosa cambia per chi lavora** e **dove lo si vedrà**.

## 2. Esito e prova

- **Azioni primarie**: rinominare e descrivere il progetto; scegliere
  l'account AI e «Use only this account»; accendere e spegnere i cinque
  interruttori, fissare i giorni del pulse e il tetto alle correzioni;
  leggere i consumi del progetto.
- **Successo**, a 1440×900, da Laura in ACQ:
  - nella colonna, sotto «Settings», leggo le undici sezioni in ordine;
    nessuna porta «View only»;
  - in General cambio la descrizione, premo **Save**, leggo «Saved»; il
    codice «ACQ» è testo con sotto «The code never changes: it's in every
    task code, like ACQ-57, and in links people have saved.»;
  - in AI scelgo «Backup Max», spunto «Use only this account», leggo sotto
    cosa succede quando è al limite, salvo;
  - in Automations spengo «Weekly brief», leggo nella barra «1 change»,
    salvo; nell'Overview la BriefCard dice che il brief è spento;
  - in Usage leggo il totale di ACQ negli ultimi 30 giorni e la tabella per
    operazione, senza nessuna colonna «Project».
- **Successo**, da Sara in ACQ: la voce «Settings» porta «View only»; ogni
  sezione ha in testa la riga «You can read these settings. Changing them
  needs someone who can change ACQ's settings. **Who?**»; il «Who?» mi dice
  Laura e Roberta. Usage e Change log non ci sono.
- **Verità del prodotto**:
  - **il codice non cambia mai** (è nei codici delle task e nei link);
  - **il pulse ha bisogno della discovery backlog**: senza, non ha niente da
    proporre, e l'interruttore lo dice;
  - **«0» al tetto spegne il ciclo automatico delle correzioni**: le
    correzioni a mano restano;
  - **l'account «solo questo» non cede il lavoro a un altro account**: se è
    al limite o spento, il lavoro nuovo del progetto parte senza account
    (*ruling del piano*, Task 2);
  - **la pagina non decide i permessi**: legge `access` della vista
    (`projectSettingsAccess`), mai `can()`.

## 3. Direzione scelta

- **Tesi**: **ogni sezione è una pagina sola con una domanda sola**, come le
  schede di `admin-ai.md`: «come si chiama?» (General), «con quale
  account?» (AI), «cosa fa da solo?» (Automations), «quanto è costato?»
  (Usage). Ogni controllo ha sotto la sua frase d'effetto, in prosa, mai il
  nome tecnico dell'impostazione **[PS 1]**.

### La colonna di Settings

- Come il 9a ([RM 4]): con Settings corrente, la voce «Settings» della
  colonna del progetto apre sotto di sé le sezioni come voci rientrate da
  32px, una pagina ciascuna. Ordine (`PROJECT_SETTINGS_SECTIONS`):
  **General · Statuses · Members · AI · Automations · Repositories ·
  Integration · Plugins · Usage · Change log · Archive** / **Generali · Stati
  · Membri · AI · Automazioni · Repository · Integrazione · Plugin · Consumi
  · Registro delle modifiche · Archivia**.
- **Una sezione che chi guarda non vede non è nella colonna** (`access[s].
  visible` falso), e il suo indirizzo apre la **prima sezione visibile**
  senza messaggio (come [AI 3]). `/p/<CODE>/settings` apre **General**
  (prima: Statuses) **[PS 2]**.
- Chi vede cosa: la tabella delle Global Constraints del piano. In breve:
  Usage solo con `project.usage.view`; Change log solo con
  `project.settings.manage` o `project.members.manage`; Repositories con
  `repos.view`, anche **senza il modulo Releases** (le parti dell'8a dentro
  Repositories restano col modulo); tutte le altre ai membri.

#### La forma di «View only» **[PS 3]**

È la scelta che il follow-up del 9a (Task 10 Minor 2) rimanda qui. Tre
regole, tutte lette da `access` (mai calcolate nella pagina):

1. **Una sezione in sola lettura** è una sezione con `visible`, `canEdit`
   falso e `editAction` non nullo. Usage e Change log non sono mai «in sola
   lettura»: non hanno niente da scrivere (`editAction` nullo), quindi non
   portano mai il segno.
2. **Il segno sulla colonna**:
   - se **tutte** le sezioni visibili con un `editAction` sono in sola
     lettura (Sara), il segno «View only» / «Sola lettura» sta **solo sulla
     voce «Settings»**, a destra, 12px `ink-faint`, come oggi; le voci
     rientrate non lo ripetono;
   - se **alcune** sono scrivibili e altre no (chi gestisce solo i membri),
     «Settings» non ha segno e lo porta **ogni voce rientrata** in sola
     lettura, a destra, 12px `ink-faint`;
   - se tutte sono scrivibili (Laura, Roberta), nessun segno.
   - Il segno ha `title` «You can read this section, not change it.» / «Puoi
     leggere questa sezione, non cambiarla.» e testo per lettore di schermo
     nella stessa frase (il colore non è il segnale: è la parola).
3. **Il segno nella sezione**, sempre, sotto la riga in prosa della testata:
   una riga 13px con ○ in testa, la frase della sezione e **Who?** /
   **Chi?** in coda (azione `editAction`). È lo stesso modello di
   `admin-ai.md`, una volta per pagina. I controlli restano visibili e
   spenti, e ogni bottone spento porta anche il suo «Who?».

Le frasi della riga ○, per `editAction`:

| `editAction` | en | it |
|---|---|---|
| `manageProjectSettings` | «You can read these settings. Changing them needs someone who can change ACQ's settings.» | «Puoi leggere queste impostazioni. Per cambiarle serve chi può cambiare le impostazioni di ACQ.» |
| `manageMembers` | «You can read who works on ACQ. Changing it needs someone who can manage ACQ's members.» | «Puoi leggere chi lavora su ACQ. Per cambiarlo serve chi può gestire i membri di ACQ.» |
| `manageRepos` | «You can read these repositories. Changing them needs someone who can manage ACQ's repositories.» | «Puoi leggere questi repository. Per cambiarli serve chi può gestire i repository di ACQ.» |

- **Integration** ha due permessi (chiave: `project.settings.manage`; secret
  dei webhook git: `repos.manage`). Il segno di colonna lo porta solo chi non
  può fare **nessuna** delle due: Task 1 calcola `access.integration.canEdit`
  come «chiave **o** `repos.manage`», e la pagina legge poi
  `canRegenerateKey` e `gitWebhooks[].canRegenerate` per i singoli bottoni
  **[PS 4]** (scostamento dal piano, che dà a `canEdit` la sola chiave:
  altrimenti chi ha `repos.manage` senza le impostazioni leggerebbe «View
  only» su una sezione in cui può rigenerare un secret).
- **Archive**: è scrivibile per chi può archiviare (`project.settings.
  manage`); Delete, del solo full admin, ha il suo «Who?» sul bottone, ma
  non rende la sezione «View only».
- **Statuses** smette di calcolare `can()`: legge `access.statuses.canEdit`
  e usa la stessa riga ○ (la frase di oggi «Only people who manage this
  project's settings can change them.» diventa quella della tabella).

```
1440 ── colonna (240px) ────────┬── area di lavoro (Sara in ACQ) ──────────────────
│ ACQ                           │ General                                          │
│ Portale utenti Acquedotto…    │ The project's name, its description and its code. │
│ Client project                │ ○ You can read these settings. Changing them     │
│ ───────────────────────────── │   needs someone who can change ACQ's settings.   │
│ Overview                      │   Who?                                           │
│ Tasks                     24  │ ──────────────────────────────────────────────── │
│ …                             │ Name         Portale utenti Acquedotto delle     │
│ ───────────────────────────── │              Colline                             │
│ Settings          View only   │ Description  Self-service portal for water       │
│    General                 ◂  │              customers: bills, readings, …       │
│    Statuses                   │ Code         ACQ                                 │
│    Members                    │              The code never changes: it's in    │
│    AI                         │              every task code, like ACQ-57, …     │
│    Automations                │                                                  │
│    Repositories               │                                                  │
│    Integration                │                                                  │
│    Plugins                    │                                                  │
│    Archive                    │                                                  │
```

### General (`/settings/general`)

- h1 «General» / «Generali» · prosa «The project's name, its description and
  its code.» / «Il nome del progetto, la sua descrizione e il suo codice.»
- Modulo a etichette a sinistra (140px) e campi a destra (fino a 560px):
  - **Name** / **Nome**: campo 14px; errore sotto «Give the project a
    name.» / «Dai un nome al progetto.» (`invalid: "name"`);
  - **Description** / **Descrizione** (facoltativa): area di testo 4 righe
    che cresce fino a 10; sotto 12px `ink-muted` «Shown in All projects and
    at the top of the Overview.» / «Si vede in Tutti i progetti e in testa
    all'Overview.»; vuota: segnaposto «What this project is for…» / «A cosa
    serve questo progetto…»;
  - **Code** / **Codice**: **testo**, non un campo spento (cifre tabellari,
    600) · sotto 12px «The code never changes: it's in every task code, like
    ACQ-57, and in links people have saved.» / «Il codice non cambia mai: è
    in ogni codice di task, come ACQ-57, e nei link che le persone hanno
    salvato.» **[PS 5]**
- **Save** / **Salva** (primario, sotto il modulo, acceso solo con una
  modifica) → «Saved» / «Salvato» 12px accanto per 2 s. Nessuna riconferma.
  Il nome nuovo compare subito nella testata della colonna, nel binario
  (`title` della tessera) e in ⌘K.
- Lasciare la sezione con modifiche: «Discard your changes?» / «Scartare le
  modifiche?» · **Discard** / **Keep editing**.
- **Sola lettura**: i valori come testo (la descrizione intera, a capo), la
  riga ○, nessun bottone.

### AI (`/settings/ai`)

- h1 «AI» · prosa «Which AI account Claude uses for ACQ's work.» / «Con quale
  account AI lavora Claude su ACQ.»
- **Account**, un gruppo di righe radio (52px, due righe):
  - **Automatic** / **Automatico** (prima riga): seconda riga 13px «Claude
    uses the instance's accounts in order: Team Max, then Backup Max. When
    one is at its limit, the next takes over.» / «Claude usa gli account
    dell'istanza in ordine: Team Max, poi Backup Max. Quando uno è al limite,
    passa al successivo.» (i nomi vengono da `choices` nell'ordine della
    catena; la chiave API non si nomina qui);
  - **una riga per account** di `choices`: nome 600 · tipo in parola
    «Subscription» / «Abbonamento» o «API key» / «Chiave API» · a destra lo
    **stato in parole**, solo se non è normale:
    - `enabled` falso: «○ Off in Administration» / «○ Spento in
      Amministrazione» (`ink-muted`); la riga resta sceglibile, e se scelta
      sotto dice «It's off: until someone turns it on, Claude uses
      Automatic.» / «È spento: finché qualcuno non lo accende, Claude usa
      Automatico.»;
    - `limited`: «● At its limit» / «● Al limite» (`critical`, con glifo e
      parola).
- **Use only this account** / **Usa solo questo account**: casella sotto il
  gruppo, spenta con «Automatic» scelto e la frase 12px «Choose an account
  first.» / «Scegli prima un account.» (regola, nessun «Who?»). Sotto, sempre
  visibile quando c'è un account scelto, 13px:
  - spuntata: «When Backup Max is at its limit or off, Claude's new work in
    ACQ doesn't switch to another account: it starts without one, and the
    task says so.» / «Quando Backup Max è al limite o spento, il lavoro nuovo
    di Claude su ACQ non passa a un altro account: parte senza, e la task lo
    dice.» **[PS 6]**
  - non spuntata: «When Backup Max is at its limit or off, the instance's
    other accounts take over.» / «Quando Backup Max è al limite o spento,
    subentrano gli altri account dell'istanza.»
- **L'account scelto non c'è più** (`chosenUnavailable`): riquadro con
  filetto `rule-strong` e ▲ `warning` sopra il gruppo: «The account chosen
  for ACQ was deleted. Claude uses Automatic until you choose again.» /
  «L'account scelto per ACQ è stato eliminato. Claude usa Automatico finché
  non ne scegli un altro.» Il gruppo ha «Automatic» selezionato in bozza, e
  **Save** è acceso (salvare conferma la scelta). In sola lettura la frase
  diventa «…until someone chooses again.» / «…finché qualcuno non ne sceglie
  un altro.»
- **Save** → «Saved». Nessuna riconferma (non tocca segreti). Errori:
  `invalid: "provider"` (l'account è sparito fra lettura e salvataggio):
  «That account no longer exists. Choose another.» / «Quell'account non
  esiste più. Scegline un altro.» e la vista si ricarica.
- Riga 12px `ink-faint` in fondo: «The account is the one each run starts
  with: runs already started keep theirs.» / «Vale per le esecuzioni che
  partono da adesso: quelle già partite tengono il loro account.»
- **Nessun account nell'istanza**: «There are no AI accounts on this
  instance yet. Claude can't work until someone adds one in Administration →
  AI.» / «Non ci sono ancora account AI su questa istanza. Claude non può
  lavorare finché qualcuno non ne aggiunge uno in Amministrazione → AI.» +
  link (solo per chi vede quella voce), «Automatic» solo.

### Automations (`/settings/automations`)

- h1 «Automations» / «Automazioni» · prosa «What Claude does on its own in
  ACQ, without anyone asking.» / «Cosa fa Claude da solo su ACQ, senza che
  nessuno lo chieda.» Il nome non va confuso con le automazioni dell'area 7:
  riga 12px `ink-faint` «Rules that start from events are in Automations, in
  the project's sections.» / «Le regole che partono da un evento sono in
  Automazioni, fra le sezioni del progetto.» con link **[PS 7]**.
- **Righe degli interruttori** (64px, filetto sotto): nome 600 · frase
  d'effetto 13px `ink-muted` (due righe al massimo) · a destra
  l'interruttore con etichetta accessibile («Weekly brief» / «Brief
  settimanale»). Ordine e frasi (dal web, riscritte in parole):

| Interruttore | en | it |
|---|---|---|
| `docsNightly` | **Docs updated every night** — «Every night Claude updates the Docs pages touched by new commits and writes the release note. Off: the Docs say they aren't updated.» | **Docs aggiornati ogni notte** — «Ogni notte Claude aggiorna le pagine dei Docs toccate dai commit nuovi e scrive la nota di rilascio. Spento: i Docs dicono che non si aggiornano.» |
| `dailyReport` | **Daily report** — «Every night, a summary of the day's commits in the project's repositories. Off: Activity says it's off, and you can still generate one by hand.» | **Report giornaliero** — «Ogni notte, un riassunto dei commit del giorno nei repository del progetto. Spento: Attività dice che è spento, e lo puoi ancora generare a mano.» |
| `backlogDiscovery` | **Backlog discovery** — «Feedback and feature requests go to the backlog to be gathered and refined, instead of straight to work.» | **Discovery del backlog** — «Feedback e richieste di funzionalità vanno nel backlog per essere raccolte e raffinate, invece che direttamente al lavoro.» |
| `pulse` | **Pulse** — «When ACQ sits still, Claude proposes backlog items to restart from.» + campo **every [7] days** | **Pulse** — «Quando ACQ è fermo, Claude propone voci di backlog da cui ripartire.» + campo **ogni [7] giorni** |
| `weeklyBrief` | **Weekly brief** — «Every Monday, where ACQ stands, written for people who don't read code. Off: the Overview says it's off; briefs already written stay.» | **Brief settimanale** — «Ogni lunedì, dove sta ACQ, scritto per chi non legge il codice. Spento: l'Overview dice che è spento; i brief già scritti restano.» |

- **Giorni del pulse**: campo numerico 64px (cifre tabellari) sulla seconda
  riga della riga del pulse, «every [7] days» / «ogni [7] giorni», spento
  col pulse spento. Errore sotto: «Choose a whole number of days from 1 to
  30.» / «Scegli un numero intero di giorni da 1 a 30.» (`pulse_days`).
- **Il pulse senza discovery** (regola, nessun «Who?»):
  - con la discovery spenta l'interruttore del pulse è **spento e non
    cliccabile**, e sotto, 12px, «The pulse needs backlog discovery: without
    it there's nothing to propose.» / «Il pulse ha bisogno della discovery
    del backlog: senza, non c'è niente da proporre.» (`pulseNeedsBacklog`
    della vista);
  - spegnendo la discovery con il pulse acceso, **anche il pulse si spegne
    nella bozza**, e la riga del pulse dice per 4 s (poi resta la frase di
    sopra) «Pulse turned off too.» / «Spento anche il pulse.»; riaccendendo
    la discovery il pulse resta spento **[PS 8]**;
  - se il salvataggio torna `pulse_needs_backlog` (stato cambiato nel
    frattempo): la frase sopra, sopra la barra, in ✕.
- **Correction cap** / **Tetto alle correzioni**, sotto un filetto `rule`
  (è un'altra famiglia: le PR): nome 600 · frase «How many times Claude may
  fix a pull request on its own when the review asks for changes, before
  stopping and asking you. Manual corrections are never counted.» / «Quante
  volte Claude può correggere da solo una pull request quando la revisione
  chiede modifiche, prima di fermarsi e chiedere a te. Le correzioni a mano
  non contano mai.» · campo numerico 64px · accanto, la sua lettura in
  parole: «0 = automatic cycle off» / «0 = ciclo automatico spento» sempre
  in 12px `ink-faint`; con 0 scritto, a destra del campo «Automatic cycle
  off: corrections only by hand.» / «Ciclo automatico spento: correzioni solo
  a mano.»; con N «Up to 3 automatic corrections per pull request.» / «Fino
  a 3 correzioni automatiche per pull request.» Errore: «Choose a whole
  number from 0 to 10.» / «Scegli un numero intero da 0 a 10.»
  (`correction_cap`).
- **Barra di salvataggio** agganciata in fondo (come Roles e Automation del
  9b): «2 changes · **Discard** · **Save**» / «2 modifiche · **Scarta** ·
  **Salva**» → «Saved». Nessuna riconferma. **Una voce del registro per
  valore cambiato**. Lasciare la sezione con modifiche: «Discard 2
  changes?» / «Scartare 2 modifiche?»
- Riga 12px `ink-faint` in fondo **[PS 9]**: «Prototype: these turn the
  visible parts on and off. Nothing here writes a brief, a report or Docs by
  itself.» / «Prototipo: accendono e spengono le parti che si vedono. Qui
  niente scrive da solo un brief, un report o i Docs.»
- **Sola lettura**: interruttori nello stato salvato, spenti, ognuno con la
  sua etichetta; i numeri come testo; nessuna barra; la riga ○.

### Usage (`/settings/usage`)

- Voce visibile solo con `project.usage.view`; altrimenti assente, e
  l'indirizzo apre la prima sezione.
- h1 «Usage» / «Consumi» · prosa «What Claude cost in ACQ over a period.» /
  «Quanto è costato Claude su ACQ in un periodo.»
- È la **`UsagePanel` del 9b** con `scope: { projectId }`:
  - **periodo**, **totali**, **istogramma per giorno**, **Show as table**:
    identici ad `admin-ai.md`, filtrati sul progetto;
  - **tabella per dimensione**: «Group by [Operation ▾] then by [— ▾]» /
    «Raggruppa per [Operazione ▾] poi per [— ▾]»; le dimensioni sono
    **Day · Model · Provider · Operation**: **Project cade** (è fisso), e con
    lui la riga «Other projects» e la sua frase **[PS 10]**. Di base
    «Operation» (nell'istanza è «Project»);
  - periodo e gruppi nell'indirizzo (`?range=`, `?group=`, `?then=`), come
    nell'istanza.
- Riga 12px `ink-faint` sotto i totali: «Only ACQ's work. The instance's
  total is in Administration → AI → Usage.» / «Solo il lavoro di ACQ. Il
  totale dell'istanza è in Amministrazione → AI → Consumi.» (link solo per
  chi vede quella scheda).
- Nessuna scrittura, nessun segno «View only».

### Statuses, Members, Change log

- Restano quelli delle aree 2 e 9a; cambia solo la sola lettura (riga ○ con
  «Who?» della tabella, segno di colonna dalla regola). Change log aggiunge
  al filtro **Type** i gruppi `project` («Project settings» / «Impostazioni
  del progetto») e `repositories` («Repositories» / «Repository») (Task 12).

## 4. Ambito e confini

- **Dentro**: la colonna con le undici sezioni e il «View only»; General,
  AI, Automations, Usage; le frasi d'effetto; la sola lettura per tutte le
  sezioni; le voci del registro di queste sezioni e di quelle dell'area 2 e
  dell'8a che oggi non scrivono (Task 3).
- **Fuori**: Repositories, Integration (`project-repositories.md`), Plugins
  (`project-plugins.md`), Archive (`project-archive.md`), gli effetti nelle
  altre aree (`project-effects.md`); le regole della posta del progetto e
  «Rigenera il brief» (fuori per tutta l'area); cambiare il codice;
  cambiare il template o il cliente del progetto.
- **Anti-obiettivi**: un campo del codice spento che sembra modificabile; un
  interruttore senza la frase di cosa cambia; un «View only» su Usage o
  Change log; il pulse acceso senza discovery; un `can()` nella pagina;
  «Other projects» o una colonna «Project» nei consumi del progetto; il nome
  di un'impostazione tecnica a schermo («docAutoUpdate», «correctionCap»).

## 5. Stati e intervalli

| Sezione | Caricamento | Vuoto | Errore |
|---|---|---|---|
| General | 3 righe scheletro del modulo | descrizione vuota: segnaposto (in lettura «No description.» / «Nessuna descrizione.») | «Couldn't load ACQ's settings.» / «Impossibile caricare le impostazioni di ACQ.» · **Retry** / **Riprova** |
| AI | 4 righe scheletro | nessun account nell'istanza: la frase sopra | come General |
| Automations | 6 righe scheletro | — | come General |
| Usage | come `admin-ai.md` | «No AI usage in ACQ in this period.» / «Nessun consumo AI su ACQ in questo periodo.» | «Couldn't load ACQ's usage.» / «Impossibile caricare i consumi di ACQ.» · **Retry** |

- **Senza permessi**: una sezione non visibile non è nella colonna; il suo
  indirizzo apre la prima visibile. Un progetto invisibile o archiviato per
  indirizzo `/p/<CODE>/settings/*` è «not found» (R-G5, come uno
  inesistente; l'archiviato si apre da `/archived/<CODE>`,
  `project-archive.md`).
- **Sola lettura**: la riga ○ con «Who?» e i valori come testo (General,
  numeri) o controlli spenti (interruttori, radio); nessuna barra di
  salvataggio, nessun «Save».
- **Rifiuti** (nel punto dell'azione, stato invariato):
  - `forbidden` (permesso perso nel frattempo): «You can no longer change
    this.» / «Non puoi più cambiarlo.», la sezione ricarica e passa in sola
    lettura, la bozza si perde (lo dice la frase);
  - `not_found` (progetto archiviato o diventato invisibile mentre la
    pagina era aperta): «ACQ is no longer available to you. Nothing was
    changed.» / «ACQ non è più disponibile per te. Non è cambiato niente.» e
    ritorno ad All projects **[PS 11]**;
  - `invalid`: le frasi sotto i campi (`name`, `provider`,
    `exclusive_needs_account` — prevenuto dalla casella spenta —,
    `pulse_days`, `correction_cap`, `pulse_needs_backlog`);
  - errore del livello dati: «Couldn't save. Try again.» / «Impossibile
    salvare. Riprova.» · **Retry** nella barra, bozza conservata.
- **Intervalli**: nome 1–120 caratteri (va a capo nella testata della
  colonna su due righe, poi ellissi con `title`); descrizione 0–1000
  caratteri; 0–8 account; pulse 1–30; tetto 0–10; Usage come l'istanza.

## 6. Interazione e layout

- Contenuto fino a 880px (`SettingsFrame`); Usage fino a 1040px.
- Il fuoco, aprendo una sezione dalla colonna, va all'h1; dopo «Save» resta
  sul bottone e «Saved» si annuncia (`aria-live="polite"`).
- Le barre di salvataggio entrano in 150ms (nessuna sotto reduced-motion).
- **1440×900** (area di lavoro 1136px): General a due colonne (etichette 140px
  · campi 560px); AI e Automations a una colonna, interruttori a destra
  della riga; Usage con i cinque totali in fila.
- **1024×680** (720px utili):
  - la colonna di Settings resta a 240px: il segno «View only» delle voci
    rientrate è testo 12px a destra e, se l'etichetta italiana non ci sta
    («Registro delle modifiche»), l'etichetta va in ellissi con `title`, il
    segno resta intero;
  - General: le etichette **sopra** i campi (niente colonna da 140px);
  - Automations: la frase d'effetto va su tre righe, l'interruttore resta a
    destra della prima riga; il campo dei giorni resta sulla seconda;
  - Usage come `admin-ai.md` a 1024 (totali 3 + 2, tabella senza Tokens).

## 7. Vincoli

- Solo via `data/queries/projectSettings.ts` (`useProjectSettings`,
  `useUpdateProjectGeneral`, `useSetProjectAi`, `useSaveProjectAutomations`,
  `useProjectUsage`) e `projectSettingsAccess` per colonna e rotte.
- Nessun `can()` nelle pagine delle impostazioni (anche
  `ProjectStatusesSettings.tsx`).
- Testi en/it con parità; nessun nome di campo tecnico a schermo.
- **+R**: nessuna di queste sezioni (non toccano segreti).
- **Voci del registro** (gruppo `project`, scope progetto, legge chi ha
  `project.settings.manage` nel progetto; template i18n, chi agisce in 600;
  valori stabili tradotti a lettura con `settingValues`):
  - `project.renamed`: «**Laura Costa** renamed **ACQ**.» / «**Laura Costa**
    ha rinominato **ACQ**.» (prima/dopo: i due nomi, come scritti);
  - `project.description_changed`: «…changed **ACQ**'s description.» / «…ha
    cambiato la descrizione di **ACQ**.» (nessun prima/dopo: dice solo che è
    cambiata);
  - `project.ai_account_changed`: «…changed the AI account of **ACQ**.» /
    «…ha cambiato l'account AI di **ACQ**.» («Automatic → Backup Max (only
    this account)» / «Automatico → Backup Max (solo questo account)»; un
    account eliminato si legge «Backup Max (deleted)» / «(eliminato)», e se
    il nome non è più noto «an account that was deleted» / «un account
    eliminato»);
  - `project.switch_changed`: «…turned off the **weekly brief** in
    **ACQ**.» / «…ha spento il **brief settimanale** in **ACQ**.» e «…turned
    on…» / «…ha acceso…» («On → Off» / «Acceso → Spento»; `params.switch`
    tradotto: Docs updated every night, Daily report, Backlog discovery,
    Pulse, Weekly brief);
  - `project.pulse_interval_changed`: «…changed how often the pulse runs in
    **ACQ**.» / «…ha cambiato ogni quanto passa il pulse in **ACQ**.»
    («Every 7 days → Every 14 days» / «Ogni 7 giorni → Ogni 14 giorni»);
  - `project.correction_cap_changed`: «…changed the correction cap of
    **ACQ**.» / «…ha cambiato il tetto alle correzioni di **ACQ**.» («3 → 0
    (automatic cycle off)» / «3 → 0 (ciclo automatico spento)»);
  - dalle scritture che c'erano già (Task 3):
    - `project.statuses_changed`: «…changed **ACQ**'s statuses.» / «…ha
      cambiato gli stati di **ACQ**.» («To do, Doing, Done → To do, Doing,
      Review, Done»);
    - `project.stall_thresholds_changed`: «…changed when a task counts as
      stalled in **ACQ**.» / «…ha cambiato quando una task di **ACQ** conta
      come ferma.» («In progress: 5 → 7 days» / «In corso: 5 → 7 giorni»);
    - `widget.created` / `.updated` / `.deleted` (gruppo `repositories`,
      `widget.manage`): «…added / changed / deleted the support widget
      **Customer portal help** in **ACQ**.» / «…ha aggiunto / modificato /
      eliminato il widget d'assistenza **Customer portal help** in **ACQ**.»
  - Ogni voce porta il link `projectSettings` alla sua sezione
    (`#/p/ACQ/settings/automations`); i widget a Support → Widget come oggi.
  - Claude non legge nessuna di queste voci.

## Scelte del brief (scelte del controller, da confermare)

1. **[PS 1]** Ogni controllo ha sotto la sua frase d'effetto in prosa; mai il
   nome tecnico.
2. **[PS 2]** `/p/<CODE>/settings` apre General (prima apriva Statuses); un
   indirizzo di sezione non visibile apre la prima visibile, senza messaggio.
3. **[PS 3]** «View only»: sulla voce «Settings» se tutto ciò che si può
   scrivere è in sola lettura, su ogni voce rientrata se è misto; in ogni
   caso la riga ○ con «Who?» in testa alla sezione. Usage e Change log non lo
   portano mai.
4. **[PS 4]** `access.integration.canEdit` = chiave **o** `repos.manage`
   (scostamento dal Task 1, solo per il segno di colonna e la riga ○; i
   bottoni leggono `IntegrationView`).
5. **[PS 5]** Il codice è testo con la frase del perché, non un campo spento.
6. **[PS 6]** La frase di «Use only this account» dice l'effetto del
   prototipo (parte senza account e la task lo dice), non l'attesa del web.
7. **[PS 7]** La sezione si chiama «Automations» come nel piano, con una
   riga che rimanda alle automazioni dell'area 7.
8. **[PS 8]** Spegnere la discovery spegne anche il pulse nella bozza, e lo
   dice; riaccenderla non riaccende il pulse.
9. **[PS 9]** Una riga dice che nel prototipo gli interruttori accendono e
   spengono solo ciò che si vede.
10. **[PS 10]** Usage del progetto senza la dimensione Project e senza «Other
    projects»; di base raggruppa per Operation.
11. **[PS 11]** Una scrittura che trova `not_found` (progetto archiviato nel
    frattempo) riporta ad All projects con la frase.

## Scelte confermate dal maintainer (31 ott 2026)

1. **[PS 3]** «View only» nella forma (a): segno sulla voce «Settings» se
   tutto ciò che si può scrivere è in sola lettura, sulle singole voci se è
   misto, e sempre la riga ○ con «Who?» in testa alla sezione.

## Ruling del controller (31 ott 2026)

1. **[PS 2]** Accettata: `/p/<CODE>/settings` apre General.
2. **[PS 4]** Accettata: `access.integration.canEdit` = chiave **oppure**
   `repos.manage` (il piano è allineato, Task 1).
