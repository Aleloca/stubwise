# Shape brief — Releases (sezione del progetto, dettaglio di un rilascio, impostazioni del repository, blocco Home)

Superficie: sezione **Releases** del progetto (`#/p/<code>/releases`, con
`?view=prs|releases|environments` per gli elenchi interi e `?pr=<id>` per
il pannello di una PR), dettaglio di un rilascio
(`#/p/<code>/releases/<AUD-V7>`), sezione **Repositories** in Progetto →
Settings, blocco Home **Releases**, gruppo di ⌘K. Piano 8a: Task 8 (dati:
Task 2, 4, 5; avvisi: Task 3 e `alerts.md`). Spec: area 8, sezioni
«Rilasci», «PR», «Permessi», «Stati», «Quanto è vero nel prototipo».
Mondo: «Catalogo numerato» (`DESIGN.md`), modalità **Operate**, con un
tratto di **Read** (il log di una run e il dettaglio del rilascio).
Il maintainer detta da telefono: nessuna domanda interattiva, le scelte
del brief sono numerate **[R n]** e raccolte in fondo, quelle che
cambiano davvero cosa si costruisce erano marcate «da confermare» e sono ora
**approvate dal maintainer il 28 ott 2026**.

## 1. Lavoro e pubblico

- **Chi**: tre persone diverse arrivano qui.
  - **Chi rilascia** (Project Lead con `release.merge`, es. Laura): apre la
    sezione per sapere cosa è pronto, mergiarlo, e poi sapere **se è
    arrivato in produzione**. Arriva anche dall'avviso «rilascio fallito»
    (obbligatorio per chi ha fatto il merge).
  - **Chi scrive codice** (Developer, es. Marco): ha una PR aperta, magari
    fuori da Stubwise, e vuole sapere cosa ha trovato Claude e se Claude
    ha spinto un commit sul suo ramo (avviso obbligatorio). Non può
    mergiare.
  - **Chi segue il progetto senza essere tecnico** (Matteo, Project Lead
    senza ruoli tecnici; Sara, Contributor): vuole sapere «è uscito?» in
    una parola, senza leggere log.
- **Stato d'animo**: dopo un merge, ansia breve («è andato?»); dopo un
  fallimento, urgenza e bisogno di capire **senza** aprire GitHub. Davanti
  a un commit di Claude sul proprio ramo, diffidenza: la UI deve dire
  sempre perché, quale commit, e come spegnerlo.
- **Molti non sono tecnici**: gli stati sono parole («In production»,
  «Failed at “Run migrations”»), mai `conclusion: failure`; il log c'è,
  ma dietro la frase.

## 2. Esito e prova

- **Azioni primarie**: (1) rilasciare una PR pronta (merge a due tempi);
  (2) capire e far riparare un rilascio fallito; (3) leggere l'analisi di
  Claude su una PR e, se serve, restringerla a «Solo analisi».
- **Successo**, a 1440×900:
  - aprendo Releases capisco in un colpo d'occhio: c'è un rilascio fallito
    che mi riguarda? cosa è pronto da rilasciare? com'è l'ultimo rilascio?
  - una PR di Marco aperta su GitHub e una PR di Claude hanno **la stessa
    riga**: cambiano solo l'autore e, se c'è, la task collegata;
  - aprendo un rilascio fallito, la prima cosa sotto il titolo è **dove** è
    fallito (run e passo) in una frase, e sotto le due azioni: «Fix it with
    Claude» e «Ask Claude to explain»;
  - le ultime righe del log sono già lì; «Show all» apre 5000 righe senza
    bloccare la finestra.
- **Verità del prodotto** (mai ammorbidite in UI):
  - **Stubwise non rilascia**: l'unica azione è il merge. Nessun «Deploy»,
    nessun «Re-run pipeline», nessun «Promote» — neanche fra i «Simula»
    del prototipo, che simulano un **esito**, mai un avvio. Dove qualcuno
    potrebbe cercarlo (rilascio fallito), una riga 12px muted lo dice:
    «Stubwise doesn't re-run pipelines. Fix the cause, merge the fix: it
    becomes a new release.» **[R 1]**
  - lo stato senza pipeline è un'**osservazione** («not in production
    yet»), mai una promessa;
  - una correzione di Claude sul ramo di un collega è **un commit sopra**:
    la UI lo mostra con lo sha e il perché, mai «rewrote», mai «rebased».

## 3. Direzione scelta

- **Tesi**: **una lista sola, raggruppata per ciò che manca**. Le PR non
  sono divise per autore né duplicate fra «PR aperte» e «coda»: la coda è
  il primo gruppo della stessa lista (**READY TO RELEASE**), seguito da
  **NOT READY YET** (con il motivo in parola) **[R 2] approvato 28 ott 2026**.
  Sotto, **Releases** (i merge recenti col loro stato) ed **Environments**.
  Tutto in una pagina che scorre, ogni parte con la sua `headline`; ogni
  parte lunga si tronca e apre il suo elenco intero con «Show all N»
  (`?view=`) **[R 3] approvato 28 ott 2026**.
- **Momento focale**: il riquadro **Needs attention** in testa alla pagina
  — l'unico con fondo (`ink/4`, filetto `rule`, raggio 8px), come «Now»
  delle automazioni — presente **solo** quando c'è un rilascio fallito
  senza task di riparazione, o una PR di cui sono autore con un commit
  nuovo di Claude non ancora visto **[R 4]**. Vuoto = non c'è.
- **PR in un pannello, non in una pagina**: cliccare una PR apre il
  pannello docked da 360px (`?pr=<id>`, come i dettagli del resto
  dell'app) con analisi intera, correzioni e azioni. Il rilascio invece ha
  una **pagina** (codice citabile `AUD-V7`, log lungo) **[R 5]**.
- **Colonna del progetto**: la voce «Releases» esiste già (modulo).
  Conteggio `ink-faint` = PR aperte. Punto pieno «ti aspetta» **solo** se
  un rilascio fallito di cui sono il destinatario obbligatorio non ha
  ancora una task di riparazione **[R 6]**. Mai per «pronta da
  rilasciare» (non è un'urgenza).

```
1440 · #/p/AUD/releases
┌rail┬ AUD ─────────────┬ Releases                                               ┐
│    │ Audin 2.0        │┌ NEEDS ATTENTION ─────────────────────────────────────┐│
│    │ ──────────────── ││ ⚠ AUD-V7 failed at “Run migrations” · Deploy prod    ││
│    │ Overview         ││   merged by you · 2 h ago     [Ask Claude…] [Fix it ▸]││
│    │ Tasks            │└───────────────────────────────────────────────────────┘│
│    │ …                │ Pull requests 7                       Repository ▾      │
│    │ Releases   7 ●   │ READY TO RELEASE                                        │
│    │ Support          │ audin-app#212 Export CSV dei contatti   (CL) Claude · AUD-131│
│    │ Servers          │   ✓ Low risk · no problems · checks passing · approved [Release]│
│    │ ──────────────── │ NOT READY YET                                           │
│    │ Settings         │ audin-app#214 Filtri salvati          (MR) Marco Rossi  │
│    │                  │   ▲ Medium risk · 3 problems · Claude pushed 1 fix · checks running│
│    │                  │ audin-app#209 Fix typo README     (EX) ext-contrib · fork│
│    │                  │   ▲ Low risk · 1 problem · Claude can't fix: from a fork │
│    │                  │ Releases                                  Show all 14 › │
│    │                  │ AUD-V7  Import fatture        ⚠ Failed      Laura · 2 h │
│    │                  │ AUD-V6  Export CSV v1         ✓ Succeeded   Laura · 1 d │
│    │                  │ Environments                                   [+ Add]  │
│    │                  │ Production · app.audin.it · SRV-3 · runs abc1234 = AUD-V6│
└────┴──────────────────┴─────────────────────────────────────────────────────────┘
```

## 4. Ambito e confini

- **Dentro**: la pagina della sezione con le quattro parti; pannello di una
  PR (analisi, correzioni, «Solo analisi», «Request changes», link alla
  piattaforma, «Simula…»); merge a due tempi con tutti gli errori; dettaglio
  di un rilascio (stato, run, passo fallito, log, «Ask Claude to explain»,
  «Fix it with Claude», «Simula…»); ambienti (elenco, aggiunta, modifica,
  eliminazione); sezione **Repositories** nelle impostazioni del progetto;
  blocco Home; ⌘K; destinazioni degli avvisi `pr.*` e `release.*`.
- **Fuori**: le preferenze degli avvisi (`alerts.md`); la sezione Servers e
  gli accessi SSH (8b: qui `SRV-n` è testo semplice finché 8b non c'è, poi
  link); la conversazione con Claude in sé (area 3, `conversation.md`); la
  task di riparazione dopo la creazione (dettaglio task esistente).
- **Anti-obiettivi**:
  - qualunque bottone, voce di menu, scorciatoia o «Simula» che **avvii,
    rilanci o promuova** una pipeline o un rilascio (il test della Task 8
    cerca «Deploy» e «Re-run» per nome accessibile);
  - un bottone «Adopt» o qualunque distinzione di forma fra PR di Stubwise
    e dei colleghi oltre al segno d'autore;
  - un muro di badge colorati per riga (l'anti-riferimento è la coda del
    web: cinque `ColumnBadge` in fila): la riga ha **una** parola di stato
    con glifo, il resto è prosa muted;
  - un log come prima cosa della pagina: la frase viene prima, il log dopo;
  - un cruscotto di percentuali («92% releases succeeded»).

## 5. Stati e intervalli

### Volumi

- PR aperte per progetto: 0–40 (tipico 2–10); titoli fino a 250 caratteri
  (ellissi su una riga in lista, a capo nel pannello); problemi trovati
  0–40 (pannello: primi 8 + «Show all 40»); correzioni per PR 0–`cap`+
  quelle oltre il tetto chieste a mano.
- Rilasci: storico illimitato; la pagina ne mostra 10, `?view=releases`
  pagine da 50. Run per rilascio 1–8.
- Log: 0–10 000 righe; si apre con le **ultime 40** **[R 7]**.
- Ambienti: 0–8 per progetto.
- Repository per progetto: 1–6.

### Stati di una PR (parola + glifo, mai solo colore)

| Stato (`prState`) | en / it (parola in lista) | Glifo | Seconda riga (esempio) |
|---|---|---|---|
| `analyzing` | Analysing / In analisi | anello tratteggiato ink (Claude al lavoro) | «Claude is reading the changes · since 14:02» |
| `clean` | No problems / Nessun problema | spunta `positive` | «Low risk · checks passing · approved» |
| `issues` | 3 problems / 3 problemi | triangolo `warning` | «Medium risk · 3 problems · Claude will fix them» o «· analysis only» |
| `correcting` | Claude is fixing / Claude corregge | anello tratteggiato ink | «Correction 2 of 3 · started 14:10» |
| `corrected` | Fixed by Claude / Corretta da Claude | spunta ink | «Claude pushed 1f3c9a0 · 2 problems fixed · analysing again» |
| `discarded` | Correction discarded / Correzione scartata | barra obliqua `ink-faint` | «Marco pushed new commits first · analysing the new head» |
| `capped` | Limit reached / Tetto raggiunto | ‖ `ink-muted` | «Claude stopped after 3 corrections» |
| `analysis_only` | Analysis only / Solo analisi | occhio lineare `ink-muted` | «Claude doesn't push here · set by Marco Rossi» |
| `analysis_off` | Analysis off / Analisi spenta | cerchio vuoto `ink-faint` | «Analysis is off for audin-scripts» |
| `not_fixable` | Analysed / Analizzata | spunta o triangolo come sopra | «Claude can't fix this: it comes from a fork» (o: protected branch / default branch / target branch / another task's branch) |

- Accanto, sulla stessa seconda riga e sempre in parole: rischio (`Low /
  Medium / High risk`, `high` in `critical`, gli altri ink-muted), controlli
  (`checks passing / failing / running / unreadable`), review (`approved /
  changes requested / no review yet`), «on staging» se `sameCommit` con un
  ambiente **[R 8]**.
- **Autore**: avatar 20px + nome. PR di Stubwise: avatar CL «Claude» +
  codice della task come link (`AUD-131`). PR di un collega: avatar della
  persona (o iniziali del login git se non collegata) + nome; se il ramo o
  un riferimento la collega a una task, il codice accanto come per Claude.
  Da fork: «· fork» dopo il nome. **Nessun** altro segno di differenza.
- **Motivo di «non pronta»** (prima voce della seconda riga nel gruppo
  NOT READY YET): «checks failing», «checks running», «conflicts with
  main», «changes requested», «draft» — dai fatti già letti, mai una stima.

### Stati di un rilascio (`releaseStatus`)

| Stato | en / it | Glifo | Frase in «Now» del dettaglio |
|---|---|---|---|
| `running` | In progress / In corso | triangolo ▸ ink | «2 runs · 1 running (Deploy production, 6 min)» o, senza run ancora, «Waiting for the pipeline to start · merged 4 min ago» |
| `succeeded` | Succeeded / Riuscito | spunta `positive` | «All 2 runs succeeded · finished 16:14» |
| `failed` | Failed / Fallito | icona `critical` | «Failed at “Run migrations” in “Deploy production”» |
| `not_in_production` | Not in production yet / Non ancora in produzione | orologio lineare `ink-muted` | «SRV-2 still runs 9f1e2ab (reported 10 min ago)» |
| `in_production` | In production / In produzione | spunta `positive` | «Appeared on SRV-2 at 14:20» |
| `unavailable` | Status unavailable / Stato non disponibile | cerchio vuoto `ink-faint` | «AUD has no production environment» / «The production environment has no server linked» |

- **Task di riparazione aperta**: suffisso in lista «· AUD-140 fixing»
  (codice link) e, nel dettaglio, riga sotto «Now».
- **Senza pipeline**, in «Now», una riga 12px muted spiega il perché una
  volta: «No pipeline run started within 30 minutes of the merge, so
  Stubwise follows the production server instead.»
- Merge fatto fuori da Stubwise: «merged by Laura Bianchi outside
  Stubwise» o, identità non collegata, «merged by `lbianchi` (not linked to
  anyone) outside Stubwise».

### Pagine

- **Caricamento**: barra attiva in testa; scheletri della forma vera (3
  righe PR a due linee, 3 righe di rilascio); nel dettaglio, intestazione,
  «Now» e 2 run.
- **Errore**: per parte, nella parte («Couldn't load the pull requests» +
  «Retry»), le altre restano; nel dettaglio, pagina intera con «Retry».
- **Vuoti**: PR: «No open pull requests in AUD.»; rilasci: «No releases
  yet. A release starts when a pull request is merged into main.»;
  ambienti: con permesso «No environments yet. Add where AUD runs, so
  releases can be followed on the server.» + **Add environment**, senza
  «No environments yet.». Repository nessuno: «AUD has no repositories, so
  there's nothing to release.» (link a Docs → repository, come oggi).
- **Senza permessi**: niente `release.merge` → nel gruppo READY TO RELEASE
  nessun «Release», al suo posto 12px muted «Someone who can release in
  AUD can merge it.» (una volta, sotto l'intestazione del gruppo, non per
  riga) **[R 9]**; niente `repos.view` → log sostituito da «The log is
  visible to people who can see AUD's code.» (passo fallito e link alla
  piattaforma restano); niente `environments.manage` → ambienti in sola
  lettura.
- **Inesistente o invisibile** (R-G5): `#/p/AUD/releases/AUD-V99` e un
  codice di un progetto invisibile mostrano la stessa «This release
  doesn't exist or you can't see it»; un `?pr=` sconosciuto chiude il
  pannello senza errore.
- **Cambio di persona** con la pagina aperta: si ricarica; un dettaglio non
  più visibile diventa R-G5 senza lampeggiare.

## 6. Interazione e layout

### Pagina della sezione (`#/p/AUD/releases`)

Colonna di lettura fino a 960px, 32px di margine.

- **Testata**: h1 «Releases»; riga 13px muted «Pull requests on AUD's
  repositories and what happened after the merge. Stubwise merges, the
  pipeline releases.» **[R 1]**. Nessun bottone primario di pagina.
- **Needs attention** (solo se c'è): una riga per caso, massimo 3 + «and 2
  more» che scorre a Releases:
  - rilascio fallito: icona `critical` + «**AUD-V7** failed at “Run
    migrations” · Deploy production» · «merged by you · 2 h ago» · a destra
    «Ask Claude to explain» (secondario) e **Fix it with Claude**
    (primario, con il permesso; senza, solo «Open»);
  - commit di Claude sulla mia PR: «Claude pushed a fix to your **#214**
    Filtri salvati · 2 problems fixed» · «Open» · «Set to analysis only».
- **Pull requests** (`headline` + conteggio; a destra filtro **Repository
  ▾** solo se più di un repository): gruppi `heading-group` READY TO
  RELEASE e NOT READY YET, ciascuno ordinato per data di apertura, più
  recente in alto. Nella pagina: tutto READY, i primi 8 di NOT READY +
  «Show all 23» (`?view=prs`, stessa lista intera con filtri Repository ·
  Author · State) **[R 3]**.
  - **Riga** (min 56px, due linee, tutta cliccabile → pannello):
    linea 1: `audin-app#212` (code, tnum) · titolo 14px ink (ellissi) ·
    autore a destra; linea 2 (13px muted): glifo + parola di stato
    (ink, 600) · rischio · resto in prosa. Nel gruppo READY, all'estrema
    destra **Release** (secondario, testo ink).
  - **Merge a due tempi** **[R 10]**: «Release» → la riga si espande in
    posto (200ms) con la frase «Merge **#212** into **main**? The
    pipeline will release it; Stubwise only follows it.» e **Confirm merge**
    (primario, fondo ink) · «Cancel». Esc annulla; il secondo tempo **non
    scade da sé**, ma si richiude se il focus esce dalla riga. Durante il
    merge «Merging…» disattivato.
  - **Esito**: riuscito → la riga esce dal gruppo (150ms), compare in testa
    a Releases come «AUD-V8 · In progress», e un avviso transitorio in basso
    «Merged. Following it as **AUD-V8**» con link. Errore → la riga resta
    espansa con l'errore in parole (`role="alert"`) e cosa fare:

    | errore | en | it |
    |---|---|---|
    | `already_closed` | This pull request isn't open any more. | Questa PR non è più aperta. |
    | `checks_failed` | Checks are failing on this pull request, so it can't be released. | I controlli sono rossi su questa PR: non si può rilasciare. |
    | `checks_unreadable` | Couldn't read the checks on GitHub. Try again in a moment. | Non è stato possibile leggere i controlli su GitHub. Riprova fra poco. |
    | `not_mergeable` | GitHub refused the merge: conflicts or branch rules not met. | GitHub ha rifiutato il merge: conflitti o regole del ramo non soddisfatte. |
    | `merge_forbidden` | The git account saved for AUD can't merge this pull request. | L'account git salvato per AUD non può mergiare questa PR. |
    | `not_found` | This pull request wasn't found. | Questa PR non è stata trovata. |
    | `forbidden` | You can't release in AUD any more. | Non puoi più rilasciare in AUD. |

    Il nome della piattaforma viene dal repository (GitHub / Bitbucket).
    Dopo `already_closed`/`not_found` la riga si aggiorna da sola.
- **Releases** (`headline` + «Show all 14 ›»): ultimi 10. **Riga** (44px,
  una linea): `AUD-V7` · titolo della PR · glifo + parola di stato · «Laura
  Bianchi · 2 h ago» a destra; fuori da Stubwise «· outside Stubwise»;
  con task di riparazione «· **AUD-140** fixing». Clic → dettaglio.
- **Environments** (`headline`; a destra **Add environment** con
  `environments.manage`): righe 44px: nome · tipo in parola (Test /
  Staging / Production) · URL (link esterno ↗) · server `SRV-3` · «runs
  abc1234 · = **AUD-V6** · 10 min ago» (il rilascio corrispondente se
  `sameCommit`, altrimenti solo lo sha) **[R 11]**. Con il permesso, «⋯»
  per riga: Edit · Delete. **Dialogo** 440px: Nome, Tipo (radio), URL,
  Server (menu dei server collegati al progetto, «None»); un solo ambiente
  di tipo Production per progetto: la scelta è spenta con «AUD already has
  a production environment: Production» **[R 12] approvato 28 ott 2026**.
  Eliminare chiede conferma: «Delete Production? Releases without a
  pipeline will show “Status unavailable” until another production
  environment has a server.»

### Pannello di una PR (`?pr=<id>`, 360px docked)

- **Testata**: `audin/audin-app#214` (code) · «Open on GitHub ↗»; titolo
  16px 600 a capo; riga autore («by Marco Rossi · opened Oct 25 ·
  feature/filtri → main»); task collegata se c'è.
- **Claude's analysis** (`heading-group`): stato in parola + glifo; «on
  1f3c9a0 · 14:05»; rischio; il riassunto (14px, fino a 6 righe, «More»);
  **Problems** come elenco numerato: titolo + file (link alla riga nella
  piattaforma), primi 8 + «Show all 40». Etichetta 12px muted «Written by
  Claude», come le motivazioni delle automazioni.
- **Corrections** (`heading-group`, solo se ce ne sono o se possibili):
  riga per giro, dal più recente: «Correction 2 · pushed 1f3c9a0 · 14:12 ·
  automatic» con il **perché** (template) e «View commit ↗»; scartata:
  «Correction 3 · discarded: Marco pushed first · doesn't count»; ferma:
  «stopped before pushing: set to analysis only». Sotto, il contatore
  derivato: «2 of 3 automatic corrections used» **[R 13]**.
  - Non correggibile: riga unica «Claude can't fix this: it comes from a
    fork.» (o il motivo), nessuna azione di correzione.
- **Azioni** (in fondo, ordine fisso):
  - **Analysis only** — interruttore con frase «Claude analyses this pull
    request but doesn't push to its branch.» Solo sulle PR dei **colleghi**;
    attivo per l'autore (se è una persona in Stubwise) o con `prs.adopt`;
    sul repository «Off» spento con «Analysis is off for audin-scripts»;
    accenderlo con una correzione in volo dice «The correction in progress
    will stop before pushing.» **[R 14] approvato 28 ott 2026**;
  - **Request changes** (stesso componente della task: casella «What should
    change» + «Send to Claude»): sulle PR altrui con `prs.adopt`, sulle PR
    di Stubwise con il permesso di oggi. Al tetto: senza `plans.approve` il
    bottone c'è spento con «Claude reached the limit of 3 corrections.
    Someone who can approve plans in AUD can ask for more.»; con
    `plans.approve` è attivo e la casella dice «This goes over AUD's limit
    of 3 corrections.»
  - **Release** (se pronta e con `release.merge`): stesso due tempi della
    riga.
- **Simula** (riquadro tratteggiato `rule-strong`, `heading-group`
  PROTOTYPE ONLY, sotto le azioni) **[R 15]**: «Advance Claude's work»
  (un passo di analisi/correzione) · «Simulate a push by the author». Frase
  13px «In the real app Claude works on its own; here you move it one step
  at a time.»

### Dettaglio di un rilascio (`#/p/AUD/releases/AUD-V7`)

Colonna di lettura fino a 960px.

- **Testata**: riga 12px «AUD-V7 · Releases» (link alla sezione); h1 =
  titolo della PR; riga di prosa «Merged by Laura Bianchi on Oct 27 at
  16:02 · **audin-app#208** → main · 7c2e91b» (PR link al pannello nella
  sezione; sha in code). A destra «⋯» (Copy link).
- **Now** (riquadro `ink/4`, l'unico fondo della pagina): frase 16px 600
  dalla tabella degli stati, dettagli 13px muted, azioni:
  - `failed`, nessuna task di riparazione: **Fix it with Claude**
    (primario) · «Ask Claude to explain» (secondario) · «Open the run on
    GitHub ↗» (link); sotto, 12px muted, la riga «Stubwise doesn't re-run
    pipelines…» **[R 1]**;
  - `failed`, task aperta: «Claude is fixing it in **AUD-140** · plan
    waiting for approval» (stato della task in parole) · **Open AUD-140**;
    «Fix it with Claude» non c'è più (un secondo clic arrivato da altrove
    apre la stessa task);
  - `failed`, senza `tickets.create`: «Someone who can create tasks in AUD
    can ask Claude to fix it.»; «Ask Claude to explain» resta (è una
    conversazione mia);
  - `unavailable`: la frase col perché e, con `environments.manage`, «Set
    up environments» (link alla parte Environments); senza, «Someone who
    manages AUD's environments can link the production server.»;
  - `running` / `succeeded` / `not_in_production` / `in_production`: solo
    la frase, nessuna azione.
- **Fix it with Claude** → dialogo 480px **[R 16] approvato 28 ott 2026**:
  anteprima della task che nasce — tipo **Bug**, titolo «Fix release
  AUD-V7: “Run migrations” failed», collegata a **#208** e «related to
  AUD-131», «The run's error is attached (step, last 40 lines, link).» —
  campo facoltativo «Anything Claude should know?»; bottoni «Cancel» ·
  **Create task and start Claude** (con `runs.start`) oppure **Create
  task** (senza: frase «The task will wait for someone who can start
  Claude in AUD.»). Chi non ha `plans.approve` legge anche «Claude will
  write a plan first; someone who can approve plans in AUD approves it.»
  Dopo: il dialogo si chiude, «Now» mostra la task; nessuna navigazione
  forzata.
- **Ask Claude to explain** → crea una conversazione nella destinazione
  Claude (area 3) con il rilascio come oggetto di contesto (gettone
  «AUD-V7» nella testata della conversazione: PR, diff, log) e il primo
  messaggio già inviato «Why did AUD-V7 fail?»; apre la conversazione.
  Un secondo clic della stessa persona **riapre la sua** conversazione
  invece di crearne un'altra **[R 17] approvato 28 ott 2026**. È privata come ogni
  conversazione dell'area 3.
- **Simula** (PROTOTYPE ONLY, tratteggiato, sotto «Now») **[R 15]**:
  - rilascio con run in corso: per ogni run in corso «Simulate outcome:
    Success · Failure»;
  - senza pipeline e `not_in_production`: «Simulate the commit appearing
    on SRV-2»;
  - frase: «These buttons pretend the pipeline or the server answered.
    They don't start anything.»
- **Runs** (`headline` + conteggio): una riga per run, ordine di partenza:
  glifo + nome («Deploy production») + parola di stato + durata («4 min
  12 s», tnum) + «Open on GitHub ↗». La run fallita è **aperta** di
  default, le altre chiuse; aperta mostra:
  - «Failed step: **Run migrations**» (14px);
  - **Log** **[R 7]**: blocco con filetto `rule`, raggio 6px, testo
    monospace 12px/18px (la sola eccezione dichiarata: log e comandi),
    numeri di riga tnum `ink-faint` in colonna 48px a destra-allineati, a
    capo morbido per le righe lunghe. Barra sopra: «Last 40 of 5,012
    lines» · **Show all** · «Copy» · «Open on GitHub ↗».
  - **Show all**: il blocco diventa alto fino a 70vh con scorrimento
    interno virtualizzato, posizionato in fondo (dove c'è l'errore); nella
    barra compare **Find in log** (⌘F col fuoco nel log): campo,
    «3 of 17», ↑/↓ (Enter / ⇧Enter), corrispondenze sottolineate e la
    corrente con fondo ink/10 — mai solo colore. «Show less» torna alle
    ultime 40. Nessuna evidenziazione inventata delle righe «di errore»:
    il passo fallito lo dice la piattaforma, il resto è testo **[R 18]**.
  - Senza `repos.view`: al posto del log la frase di §5; il passo resta.
- **Link alla release note**: se la nota di rilascio notturna (Docs) cita
  il merge, riga 13px «Release note: **Oct 27** in Docs ›» sotto la
  testata; altrimenti niente **[R 19]**.

### Impostazioni → Repositories (Progetto → Settings, prima di «Other»)

- `headline` «Repositories», frase «How Claude treats pull requests and how
  Stubwise follows releases, per repository.» Un blocco per repository
  separato da filetto: nome (`audin/audin-app`, code) + piattaforma.
- **Colleagues' pull requests** — radio verticale, ciascuna con la
  conseguenza in una riga muted:
  - **Analysis and fixes** (default) — «Claude analyses every pull request
    and pushes fixes on top, up to AUD's limit of 3 corrections.»
  - **Analysis only** — «Claude analyses but never pushes to colleagues'
    branches.»
  - **Off** — «No analysis: pull requests still appear in Releases, without
    Claude's notes.»
  Sotto, 12px muted: «Pull requests opened by Stubwise always follow AUD's
  review settings.» Scegliere **salva subito** (nessun bottone Salva);
  «Saved» compare solo dopo la conferma dello store e sparisce alla
  modifica successiva (la lezione del bug dell'area 6) **[R 20]**. Passare
  a «Analysis only» o «Off» con correzioni in volo: dialogo «1 correction in
  progress on #214 will stop before pushing.» · «Cancel» · **Change**.
  Con «Off» le analisi già fatte non si mostrano più (la PR dice «Analysis
  off») **[R 21]**.
- **Release pipeline**: radio **Automatic** («Every run started by the
  merge commit on the release branch counts.») / **Only these** (campo a
  gettoni con i nomi di workflow/pipeline; vuoto non salvabile). **Release
  branch**: campo testo precompilato col ramo di default, salvato
  all'uscita dal campo. Riga 12px: «No runs within 30 minutes of a merge?
  Stubwise follows the production server instead.»
- Senza `repos.manage`: gli stessi valori in sola lettura come frasi
  («Colleagues' pull requests: analysis only»), nessun controllo.

### Blocco Home «Releases» (`releases`)

- Nel catalogo per chi ha `release.merge` in almeno un progetto; aggiunto
  alla Home di default **solo alle Home nuove** di quelle persone, mai a
  Home già personalizzate **[R 22] approvato 28 ott 2026**.
- Contenuto, in quest'ordine: (1) rilasci **falliti che mi riguardano**
  (merge mio, o iscrizione «rilascio fallito») senza task di riparazione
  chiusa; (2) PR **pronte** nei progetti dove ho `release.merge`. Riga:
  codice (`AUD-V7` o `audin-app#212`) · titolo · codice progetto · glifo +
  parola. Nessun bottone «Release» nella Home: la riga apre la sezione con
  il pannello della PR (il merge si fa col contesto) **[R 23]**. 5 righe +
  «Show N more» in posto.
- Vuoto: «Nothing to release and no failed releases.» Guscio
  `BlockSection` con i suoi quattro stati.

### Avvisi e ⌘K

- Destinazioni: `release.*` → dettaglio del rilascio; `pr.opened`,
  `pr.analysis_issues`, `pr.corrected` → sezione con `?pr=`. Il testo degli
  avvisi e le iscrizioni stanno in `alerts.md`.
- ⌘K: gruppo **Releases** (codice `AUD-V7`, titolo PR) e gruppo **Pull
  requests** (`#214`, `audin-app#214`, titolo, autore). Righe: codice ·
  titolo · stato in parola. Invisibili non compaiono (R-G5). Nessuna azione
  nuova di palette in 8a.

### 1024×680 e tastiera

- Area 720px: con il pannello PR aperto la lista resta a ~360px: linea 2
  si accorcia a stato + rischio, l'autore diventa solo avatar; nel
  dettaglio i numeri di riga del log scendono a 36px; «Now» resta intero.
- J/K muovono la selezione nelle righe (PR e rilasci come una sola
  sequenza); Enter apre; Esc chiude il pannello o annulla il secondo tempo
  del merge; nel log aperto `/` porta a «Find in log» **[R 24]**.
- Accessibilità: elenchi `grid` con nomi completi («audin-app#214, Filtri
  salvati, by Marco Rossi, 3 problems, medium risk, checks running»); il
  secondo tempo del merge sposta il fuoco su «Confirm merge» e lo annuncia;
  gli errori `role="alert"`; la frase di «Now» `aria-live="polite"` (cambia
  con i «Simula»); il log è una regione etichettata «Log of Deploy
  production, 5,012 lines» con le righe in una lista, non un `pre` unico;
  stati sempre in parola.
- Movimento: espansione del due tempi 200ms, uscita di una riga mergiata
  150ms, run che si apre 200ms; zero con riduzione del movimento.

## 7. Vincoli e decisioni aperte

- Dati solo da `data/queries.ts` (`listOpenPrs`, `listReleaseQueue`,
  `listReleases`, `getRelease`, `listEnvironments`, `listMyReleases`,
  `getRepositorySettings`); orologio `now()` dello store; stati da
  `releaseStatus`/`prState`, mai ricalcolati in pagina.
- Le frasi (stati, perché di una correzione, motivi di non correggibilità)
  sono template i18n dai dati; solo **riassunto e problemi dell'analisi**
  sono testo di Claude, etichettati come tali.
- `api.releases` non esporta nulla che avvii una pipeline: la UI non ha
  dove attaccare un «Deploy» anche volendo.
- Nessuna notifica di sistema di Electron in 8a.
- en/it con parità; nessuna larghezza fissa sul testo: «Non ancora in
  produzione» va su due righe in lista prima di tagliare il titolo.
- **Collisione di nome** con la scheda «Releases» dei Docs (note di
  rilascio notturne, `docs.releases.*`): due cose diverse con la stessa
  parola nello stesso progetto **[R 25] approvato 28 ott 2026**: la scheda
  dei Docs si rinomina «Release notes / Note di rilascio».

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| h1 e parti | Releases · Pull requests · Releases · Environments | Rilasci · Pull request · Rilasci · Ambienti |
| gruppi | Needs attention · Ready to release · Not ready yet | Da guardare · Pronte per il rilascio · Non ancora pronte |
| sottotitolo | Pull requests on {{code}}'s repositories and what happened after the merge. Stubwise merges, the pipeline releases. | Le pull request dei repository di {{code}} e cosa è successo dopo il merge. Stubwise mergia, la pipeline rilascia. |
| merge | Release · Merge #{{n}} into {{branch}}? The pipeline will release it; Stubwise only follows it. · Confirm merge · Merging… · Merged. Following it as {{code}} | Rilascia · Mergiare #{{n}} in {{branch}}? La pipeline lo rilascia; Stubwise lo segue soltanto. · Conferma il merge · Merge in corso… · Mergiata. La seguiamo come {{code}} |
| senza permesso | Someone who can release in {{code}} can merge it. | Può mergiarla chi può rilasciare in {{code}}. |
| stati rilascio | In progress · Succeeded · Failed · Not in production yet · In production · Status unavailable | In corso · Riuscito · Fallito · Non ancora in produzione · In produzione · Stato non disponibile |
| stati PR | Analysing · No problems · {{n}} problems · Claude is fixing · Fixed by Claude · Correction discarded · Limit reached · Analysis only · Analysis off · Analysed | In analisi · Nessun problema · {{n}} problemi · Claude corregge · Corretta da Claude · Correzione scartata · Tetto raggiunto · Solo analisi · Analisi spenta · Analizzata |
| non correggibile | Claude can't fix this: it comes from a fork / the branch is protected / it's the default branch / it's the target branch / it belongs to another task | Claude non può correggere qui: viene da un fork / il ramo è protetto / è il ramo di default / è il ramo di destinazione / è il ramo di un'altra task |
| fallito | Failed at “{{step}}” in “{{run}}” · Fix it with Claude · Ask Claude to explain · Open the run on {{platform}} | Fallito a «{{step}}» in «{{run}}» · Fai sistemare a Claude · Chiedi a Claude di spiegarlo · Apri la run su {{platform}} |
| confine | Stubwise doesn't re-run pipelines. Fix the cause, merge the fix: it becomes a new release. | Stubwise non rilancia le pipeline. Si corregge la causa, si mergia la correzione: diventa un nuovo rilascio. |
| riparazione | Create task and start Claude · Create task · The task will wait for someone who can start Claude in {{code}}. · Claude is fixing it in {{task}} | Crea la task e avvia Claude · Crea la task · La task aspetterà qualcuno che può avviare Claude in {{code}}. · Claude lo sta sistemando in {{task}} |
| log | Last {{n}} of {{total}} lines · Show all · Show less · Find in log · {{i}} of {{n}} · The log is visible to people who can see {{code}}'s code. | Ultime {{n}} di {{total}} righe · Vedi tutto · Mostra meno · Cerca nel log · {{i}} di {{n}} · Il log lo vede chi può vedere il codice di {{code}}. |
| PR | Analysis only · Claude analyses this pull request but doesn't push to its branch. · {{used}} of {{cap}} automatic corrections used · Written by Claude | Solo analisi · Claude analizza questa PR ma non spinge sul suo ramo. · {{used}} di {{cap}} correzioni automatiche usate · Scritto da Claude |
| repository | Colleagues' pull requests · Analysis and fixes · Analysis only · Off · Release pipeline · Automatic · Only these · Release branch | PR dei colleghi · Analisi e correzioni · Solo analisi · Spento · Pipeline di rilascio · Automatica · Solo queste · Ramo di rilascio |
| prototipo | Prototype only · Simulate outcome · Simulate the commit appearing on {{server}} · Advance Claude's work · Simulate a push by the author · These buttons pretend the pipeline or the server answered. They don't start anything. | Solo prototipo · Simula l'esito · Simula la comparsa del commit su {{server}} · Fai avanzare il lavoro di Claude · Simula un push dell'autore · Questi bottoni fingono la risposta della pipeline o del server. Non avviano niente. |
| R-G5 | This release doesn't exist or you can't see it. | Questo rilascio non esiste o non puoi vederlo. |

## Scelte del brief (approvate dal maintainer, 28 ott 2026)

1. **[R 1]** La frase-confine «Stubwise non rilancia le pipeline…» sta nel
   sottotitolo della sezione e sotto «Now» di un rilascio fallito: rende
   visibile l'anti-obiettivo 1 dove si cercherebbe un «Riprova».
2. **[R 2] approvato 28 ott 2026 (confermato dal maintainer)** Una lista sola di PR, raggruppata in «Pronte per
   il rilascio» e «Non ancora pronte»: la coda è il primo gruppo, non una
   seconda lista con le stesse PR (lo spec dice «tre parti»; qui sono due
   gruppi della stessa parte, con «Rilascia» solo nel primo).
3. **[R 3] approvato 28 ott 2026** Una pagina che scorre (non schede), con le parti
   lunghe troncate e «Vedi tutte N» verso `?view=`.
4. **[R 4]** Riquadro «Da guardare» in testa solo per rilasci falliti senza
   task di riparazione e per commit di Claude sulle mie PR.
5. **[R 5]** PR nel pannello docked da 360px (`?pr=`), rilascio in una
   pagina sua.
6. **[R 6]** Punto «ti aspetta» sulla voce Releases solo per un rilascio
   fallito di cui sono destinatario obbligatorio e senza task di
   riparazione; il conteggio è delle PR aperte.
7. **[R 7]** Il log si apre con le ultime 40 righe; «Vedi tutto» in posto,
   virtualizzato, posizionato in fondo.
8. **[R 8]** Rischio, controlli, review e «su staging» sono prosa nella
   seconda riga, non badge; il rischio alto è l'unico in `critical`.
9. **[R 9]** Senza `release.merge` la frase «Può mergiarla chi…» compare
   una volta sotto il gruppo, non su ogni riga.
10. **[R 10]** Merge a due tempi in posto nella riga; il secondo tempo non
    scade, si richiude se il fuoco esce dalla riga o con Esc.
11. **[R 11]** Un ambiente mostra a quale rilascio corrisponde il commit che
    ci gira («= AUD-V6»), oltre allo sha.
12. **[R 12] approvato 28 ott 2026** Un solo ambiente di tipo Produzione per
    progetto (è quello che `releaseStatus` legge).
13. **[R 13]** Il pannello della PR mostra il contatore derivato «2 di 3
    correzioni automatiche usate».
14. **[R 14] approvato 28 ott 2026** «Solo analisi» sulla singola PR solo per le PR
    dei colleghi (sulle PR di Stubwise l'autore è Claude e vale la review
    di oggi).
15. **[R 15]** I «Simula…» in un riquadro tratteggiato «Solo prototipo»,
    visibili a ogni membro che vede l'oggetto, con una frase che dice che
    non avviano niente.
16. **[R 16] approvato 28 ott 2026** «Fai sistemare a Claude» apre un dialogo con
    l'anteprima della task e una nota facoltativa per Claude, invece di
    creare la task con un clic.
17. **[R 17] approvato 28 ott 2026** «Chiedi a Claude di spiegarlo» manda subito la
    prima domanda e, al secondo clic della stessa persona, riapre la sua
    conversazione invece di crearne una nuova.
18. **[R 18]** Nessuna evidenziazione euristica delle righe d'errore nel
    log: solo ricerca e il passo fallito dichiarato dalla piattaforma.
19. **[R 19]** Link alla nota di rilascio dei Docs dal dettaglio, solo se
    esiste.
20. **[R 20]** Le scelte del repository si salvano subito; «Salvato» solo
    dopo la conferma e mai con modifiche pendenti.
21. **[R 21]** Con il repository su «Spento» le analisi già fatte non si
    mostrano più.
22. **[R 22] approvato 28 ott 2026** Blocco Home «Rilasci» nella Home di default
    solo per le Home nuove di chi ha `release.merge`.
23. **[R 23]** Nessun «Rilascia» nel blocco Home: la riga porta alla
    sezione.
24. **[R 24]** Scorciatoia `/` per cercare nel log aperto.
25. **[R 25] approvato 28 ott 2026** Collisione di nome con la scheda «Releases»
    dei Docs (note di rilascio): la scheda si rinomina «Release notes /
    Note di rilascio» nella stessa costruzione (confermato dal maintainer).
