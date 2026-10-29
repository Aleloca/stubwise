# Shape brief — Change log e «Who can?»

> **Nota del 30 ott 2026 (maintainer):** `target_above` non esiste più (nessuna gerarchia). Ogni riferimento qui sotto è superato.

Superficie: **Change log** in Amministrazione (`/admin/changelog`) e la sua
parte di progetto in Progetto → Settings → Change log
(`/p/<CODE>/settings/changelog`), con la voce del registro
(`ChangeEntry`); **Who can?** (`/admin/who-can`, con `?action=&project=` e
`?person=&project=`); il link **`WhoCanLink`** accanto ai bottoni spenti per
permesso in tutte le aree; il gruppo «Who can?» di ⌘K. Piano 9a: Task 11
(dati: Task 2 e 3). Spec area 9: «Il registro delle modifiche», «Chi può
farlo?», anti-obiettivo «Un registro che rivela», Review Focus 5. Mondo:
«Catalogo numerato», modalità **Operate** con un tratto di **Read** (il
registro si legge). Scelte del brief **[AU n]**.

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi deve rispondere di un accesso** (Roberta; un «Auditor» con
    `changelog.view`): «chi ha dato a Marco `servers.operate`, e quando?»,
    «cosa è cambiato nei ruoli questo mese?». Cerca, filtra, legge.
  - **Chi guida un progetto** (Laura): guarda il registro del **suo**
    progetto in Settings, per sapere chi ha cambiato i membri.
  - **Chi è fermo davanti a un bottone spento** (Sara, Marco): «non posso
    approvare: a chi chiedo?». Vuole un nome, non una lezione sui permessi.
  - **Chi si chiede cosa può fare qualcuno** (Laura prima di dare un
    compito a Federico).
- **Stato d'animo**: verifica. Il registro deve essere **fatto** — frasi
  da template, date esatte, niente prosa generata — e «Who can?» deve
  rispondere in una riga per persona, con il perché.

## 2. Esito e prova

- **Azioni primarie**: filtrare il registro per persona, progetto, tipo e
  periodo e leggere una voce con prima e dopo; chiedere chi può fare
  un'azione in un progetto, o cosa può fare una persona, e vedere da dove
  viene ogni risposta.
- **Successo**, a 1440×900:
  - filtro «Marco Bellini · last 30 days» e leggo «Oct 29, 10:12 · Laura
    Costa gave Marco Bellini **operate servers** in ACQ» con prima/dopo
    «Developer → Developer + operate servers»;
  - una voce di reset dice «Roberta Fontana created a password reset link
    for Marco Bellini» e **non** contiene il link;
  - da «Approve plan» spento sulla task ACQ-57 premo **Who?** e leggo, senza
    lasciare la task: «Laura Costa — Project Lead role» · «Roberta Fontana —
    full admin»;
  - in «Who can?» scelgo «Claude» e leggo «Claude can work but doesn't
    decide» e l'elenco di ciò che non può fare.
- **Verità del prodotto**:
  - **il registro non si modifica né si cancella**: nessun «⋯» sulle voci;
  - **nessun segreto nel registro**: «the key was replaced», mai il valore;
  - **il registro e «Who can?» non rivelano**: progetti e persone che chi
    guarda non vede **non esistono** nelle risposte, nei filtri, nei
    conteggi (R-G5);
  - **«Who can?» è `can()`**: la stessa risposta del bottone; se le due
    divergessero, sarebbe un difetto.

## 3. Direzione scelta

- **Tesi**: **il registro è un giornale per giorni; «Who can?» è una
  domanda scritta come frase**. La pagina di «Who can?» si compone come la
  domanda che si fa a voce — «Who can [approve plans] in [ACQ]?» — e
  risponde con righe persona + perché **[AU 1]**.

### Change log (`/admin/changelog`)

- Voce della colonna di Amministrazione per chi ha `changelog.view` **o**
  almeno un tipo di voce leggibile (tabella dello spec).
- h1 «Change log» · riga in prosa: «Every change to access and settings:
  who made it, when, and what changed. Entries can't be edited or
  deleted.»
- **Barra dei filtri**: **Person** (chi ha fatto la modifica; ricerca fra
  le persone visibili) · **Project** (solo progetti visibili, più
  «Instance only») · **Type** (menu a gruppi: People · Invites · Roles ·
  Members · Departments · Security; 9b e 9c aggiungono i loro gruppi) ·
  **Period** (Last 7 days · Last 30 days · Last 90 days · Custom…). I
  filtri stanno nell'indirizzo; «Clear filters» quando ce n'è almeno uno.
- **Giornale**: voci raggruppate per giorno con `heading-group` («TODAY»,
  «YESTERDAY», «OCT 27»), più recenti in alto.
- **Voce** (`ChangeEntry`, 44px, si allunga col prima/dopo):
  - a sinistra l'ora in cifre tabellari (12px `ink-faint`), larghezza fissa;
  - la **frase** 14px, dal template i18n, con chi ha agito in 600 e
    l'oggetto come link quando esiste ed è visibile: «**Laura Costa** gave
    **Marco Bellini** operate servers in ACQ.» · «**Roberta Fontana**
    changed the role **Developer**: 2 permissions added.» · «**Roberta
    Fontana** reset **Marco Bellini**'s two-step verification.»;
  - a destra il codice del progetto (cifre tabellari, 600) se la voce è di
    un progetto; nessun codice per le voci d'istanza;
  - **prima e dopo**, quando la voce li ha: seconda riga 13px `ink-muted`
    «Developer → Release manager»; se il cambio è un elenco (permessi di un
    ruolo), la seconda riga riassume («+ merge pull requests, + adopt PRs ·
    − edit docs») e **Show details** apre sotto le due colonne «Before» /
    «After» con i permessi in parole **[AU 2]**;
  - oggetto eliminato nel frattempo: il nome resta in testo, «(deleted)».
  - Segreti: la frase dice che cosa è nato o è stato sostituito («created a
    password reset link», «created an access token “my-laptop MCP”») e mai
    il valore; nessun prima/dopo su un segreto.
- Nessuna azione sulle voci; il link dell'oggetto apre la sua pagina
  (persona, ruolo, reparto, membro nel pannello di Members).
- **Chi legge cosa**: chi non ha `changelog.view` vede solo i tipi che
  gestisce; la riga in prosa lo dice: «You see changes to what you manage:
  people and invites.» I filtri «Type» mostrano solo quei tipi.

### Change log del progetto (`/p/<CODE>/settings/changelog`)

- Voce rientrata sotto Settings (vedi `admin-roles-members.md`, [RM 4]),
  solo per chi ha `project.settings.manage` o `project.members.manage` nel
  progetto.
- h1 «Change log» · riga «Changes to ACQ's members and settings.» Stessi
  filtri senza **Project**; stesso giornale, senza il codice a destra
  (è sempre lo stesso).

### Who can? (`/admin/who-can`)

- Voce della colonna per tutti.
- h1 «Who can?» · riga in prosa: «Find out who can do something in a
  project, or what someone can do — and why. You only see the projects and
  people you can see.»
- **Due domande**, scelte con un controllo a due segmenti sopra la frase:
  **Who can…** · **What can… do** (`aria-pressed`; l'indirizzo ricorda la
  scelta).
- **Who can…**: frase con due menu in linea, 20px: «Who can **[approve a
  plan ▾]** in **[ACQ Acquisitions ▾]**?»
  - il menu delle azioni è il catalogo `ACTIONS`, in parole, a gruppi
    come la `PermissionTable`, con ricerca; un'azione d'istanza toglie il
    secondo menu e la frase diventa «Who can **[manage roles ▾]**?»;
  - il menu dei progetti offre solo i progetti visibili;
  - **Risposta**: «4 people» (16px, 600) e una riga per persona (40px):
    avatar · **nome** · il **perché** in prosa 13px `ink-muted` — «Project
    Lead role» · «given by Roberta Fontana on Oct 29» · «Development
    department» · «full admin»; più motivi separati da «·» **[AU 3]**.
    Ordine: chi ce l'ha da un ruolo, poi dato a mano, poi reparto, poi full
    admin; dentro, per nome. Clic sul nome → pagina della persona (se chi
    guarda vede People).
  - **Claude**, sempre in fondo, separato da un filetto: «Claude — can work,
    doesn't decide.» e, per l'azione scelta, «Claude can start runs.» oppure
    «Claude can't approve plans.»
  - Nessuno: «No one you can see can merge pull requests in ACQ.» (e la
    riga di Claude).
- **What can… do**: «What can **[Marco Bellini ▾]** do in **[ACQ ▾]**?»
  (il secondo menu ha anche «the whole instance»):
  - la risposta è la `PermissionTable` in **sola lettura**, solo con i
    permessi che la persona ha, ognuno con la sua fonte; l'interruttore
    «Also show what Marco can't do» aggiunge le righe mancanti in
    `ink-faint` senza fonte;
  - un progetto dove la persona non è membro: «Marco isn't a member of
    AUD.» (e, se ha permessi d'istanza che valgono ovunque, li elenca);
  - **Claude** scelto: «Claude can work but doesn't decide.» poi
    **CAN** (i permessi di lavoro) e **NEVER** (quelli negati per regola,
    R-L9), senza fonti: è una regola, non una concessione.
- Il menu delle persone offre solo le persone visibili (chi condivide
  almeno un progetto visibile con chi guarda, più i full admin) e Claude.

### `WhoCanLink` — accanto ai bottoni spenti

- La frase che oggi dice «Someone who can approve plans in ACQ decides»
  resta e guadagna in coda un link **Who?** (13px, sottolineato al
  passaggio) **[AU 4]**.
- Il link apre un **popover** (320px, ancorato al link, `rule-strong`,
  ombra dei menu): titolo «Who can approve a plan in ACQ», fino a 6 righe
  persona + perché breve, «and 3 more» se sono di più, poi **Open in Who
  can?** (porta alla pagina con la domanda già scritta). Esc o clic fuori
  lo chiudono e il fuoco torna al link.
- Dove compare (ogni frase che oggi nomina un permesso mancante):
  - task: avvio del run, rilancio, ripresa della correzione, «Request
    changes», approvazione del piano, risposta a una domanda di Claude;
  - Releases: Merge, collegare l'ambiente di produzione, «Ask Claude to fix
    it», tetto delle correzioni raggiunto;
  - server (8b): «Start the fix», collegare l'accesso SSH, aggiungere un
    server o un controllo, soglie in lettura;
  - Support: risposta al cliente;
  - backlog: refinement in lettura;
  - Settings del progetto in lettura; elenchi vuoti «Only people who can
    create tasks…»;
  - Preferenze → Account: Google senza Workspace.
- Il popover rispetta R-G5: Sara, da un bottone spento di ACQ, vede solo
  persone di ACQ che vede.

### ⌘K

- Scrivendo «who can» (o «chi può»), la palette mostra il gruppo **WHO
  CAN?** con le azioni del catalogo che corrispondono al resto del testo,
  nel progetto corrente se ce n'è uno: «Who can approve plans in ACQ».
  Invio apre «Who can?» con la domanda scritta. Senza progetto corrente la
  voce dice «…in a project» e apre con il menu dei progetti aperto.

## 4. Ambito e confini

- **Dentro**: il registro d'istanza e di progetto con filtri e prima/dopo;
  «Who can?» nei due versi; il popover su tutti i bottoni spenti elencati;
  ⌘K.
- **Fuori**: esportazione del registro; avvisi su una voce; modifica o
  cancellazione (non esistono); il «perché no» di una singola persona
  oltre l'interruttore «what can't do».
- **Anti-obiettivi**: una voce che contiene un segreto; un progetto o una
  persona invisibile in un filtro, in un conteggio o in un «and 3 more»;
  una risposta di «Who can?» calcolata a parte da `can()`; un popover che
  porta via dalla pagina senza chiederlo; un registro scritto in prosa
  generata.

## 5. Stati e intervalli

| Pagina | Caricamento | Vuoto | Errore |
|---|---|---|---|
| Change log | 3 giorni scheletro, 4 voci ciascuno | con filtri: «No changes match these filters.» · **Clear filters**; senza: «Nothing recorded yet.» | «Couldn't load the change log.» · **Retry** |
| Change log progetto | come sopra | «No changes to ACQ yet.» | come sopra |
| Who can? | scheletro di 4 righe sotto la frase | «No one you can see can … in ACQ.» | «Couldn't work out who can. Try again.» · **Retry** |
| Popover | 3 righe scheletro | «No one you can see can do this here.» | «Couldn't load who can.» · **Retry** nel popover |

- **Senza permessi**: Change log assente dalla colonna per chi non legge
  nessun tipo; la parte di progetto assente da Settings senza i due
  permessi; un indirizzo con un progetto invisibile (`?project=AUD` per
  Sara) si comporta come un progetto inesistente: il menu torna su
  «Choose a project» e una riga dice «Pick a project.» (nessun «not
  allowed»).
- `escalation`, `target_above`, ultimo gestore, `reauth_required`: queste
  pagine non scrivono, quindi non li producono; il registro **non** registra
  i tentativi rifiutati (stato invariato, nessuna voce).
- **Intervalli**: ~20 voci nel seme, fino a centinaia (lista virtualizzata
  oltre 100, i titoli dei giorni agganciati); 0–40 persone per risposta;
  azioni del catalogo ~25.

## 6. Interazione e layout

- Contenuto fino a 880px; le frasi del registro vanno a capo, l'ora resta
  allineata in alto.
- **Show details** apre in posto, 200ms; il fuoco resta sul bottone, che
  diventa **Hide details**.
- I due menu in linea di «Who can?» sono `combobox` con ricerca; cambiare
  una scelta aggiorna la risposta subito (annunciata in `aria-live`).
- **1024×680** (720px utili): nel registro il codice del progetto scende
  sulla seconda riga, prima del prima/dopo; «Before» / «After» di **Show
  details** passano da due colonne a una sotto l'altra; in «Who can?» la
  frase con i menu va a capo su due righe e il perché scende sotto il nome;
  il popover resta 320px e si apre verso l'alto se in basso non c'è
  spazio.

## 7. Vincoli

- Solo via `data/queries.ts` (`listChanges`, `listProjectChanges`,
  `whoCan`, `whatCan`, catalogo `ACTIONS`); il popover usa la stessa
  `whoCan`.
- Le frasi delle voci sono template i18n per tipo (`registerChangeTypes`):
  9b e 9c aggiungono tipi e template senza toccare `ChangeEntry`.
- Testi en/it con parità; le azioni del catalogo hanno un'etichetta
  all'infinito («approve a plan») per comporsi nella frase in entrambe le
  lingue («Chi può **approvare un piano** in ACQ?»).

## Scelte del brief

1. **[AU 1]** «Who can?» si compone come una frase con due menu in linea,
   nei due versi.
2. **[AU 2]** Prima/dopo riassunti su una riga; il dettaglio completo dei
   permessi si apre in posto.
3. **[AU 3]** Il perché di ogni persona è prosa breve accanto al nome, non
   un'etichetta colorata.
4. **[AU 4]** Il link «Who?» accanto ai bottoni spenti apre un popover sul
   posto, con «Open in Who can?» per andare oltre.
5. **[AU 5]** Il registro raggruppato per giorno, più recente in alto,
   senza azioni sulle voci.

## Scelte confermate dal maintainer (29 ott 2026)

1. **«Who?» come popover sul posto** invece di portare alla pagina «Who
   can?» **[AU 4]**.
