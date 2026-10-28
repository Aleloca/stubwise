# Shape brief — Avvisi (Preferenze → Notifiche, popover «Alerts», «Non avvisarmi più»)

Superfici: **Preferenze** (`#/preferences`, oggi `Placeholder`) con la
cornice e la sola sezione **Notifiche** (`#/preferences/notifications`;
`/preferences` vi rimanda), il **popover «Alerts»** nella testata della
colonna del progetto (`layout/ProjectColumn.tsx`, `Header`), e l'azione
**«Don't alert me about this in <PRJ>»** con Annulla sulle voci del
pannello notifiche (`notifications/NotificationItem.tsx`). Piano 8a:
Task 7 (dati: Task 2–3). Spec area 8: «Notifiche: iscrizioni per
progetto», «Stati» (Iscrizione), «Quanto è vero nel prototipo» (Telefono),
Review Focus 6. Mondo: «Catalogo numerato», modalità **Operate**.
**[A n]** = scelta del brief, numerata in fondo; tutte **approvate dal
maintainer il 28 ott 2026**.

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi segue pochi progetti da vicino** (Laura, Project Lead di AUD):
    vuole sapere subito di un rilascio fallito e di una PR con problemi,
    non di ogni PR aperta. Arriva dal popover del progetto, quasi mai dalla
    pagina intera.
  - **Chi è in tanti progetti di passaggio** (Roberta admin, fino a ~50
    progetti): arriva alla pagina intera per **spegnere in blocco** il
    rumore dei progetti che non segue.
  - **Chi non è tecnico** (Matteo, Project Lead senza ruoli tecnici; Sara,
    Contributor): vede solo i tipi a cui può iscriversi; nessun nome di
    permesso, nessun `kind` a schermo.
  - **Chi è infastidito adesso**: ha appena ricevuto l'ennesima «New PR»
    nel pannello e vuole che smetta, senza andare da nessuna parte.
- **Stato d'animo**: sollievo dal rumore, senza la paura di perdersi
  qualcosa di importante. Ogni riga deve dire **che cosa** arriverà e
  **quando**; ogni avviso che non si può spegnere deve dire **perché**.

## 2. Esito e prova

- **Azioni primarie**: (1) accendere/spegnere un tipo in un progetto, per
  App e per Telefono; (2) spegnere tutto un progetto, o copiarne le
  impostazioni da un altro; (3) dal pannello, spegnere il tipo di un
  avviso appena ricevuto, con Annulla.
- **Successo**, a 1440×900:
  - aprendo Notifiche vedo prima i miei progetti fissati, già aperti, e per
    gli altri una riga di sintesi («6 on · 2 to phone · 1 paused») che mi
    dice se c'è da guardarci senza aprirli;
  - ogni riga si legge come una frase: «**Release failed** — When a release
    of AUD fails after the merge» e a destra due interruttori allineati in
    colonna, App e Phone;
  - una riga sospesa o obbligatoria **non** ha interruttori da toccare e
    dice in parole perché;
  - «Don't alert me about this in AUD» nel pannello lascia l'avviso dov'è e
    risponde con un toast «You won't get new PRs from AUD anymore» ·
    **Undo**.
- **Verità del prodotto** (dallo spec, mai ammorbidite in UI):
  - **spegnere vale solo per il futuro**: nessun avviso già ricevuto sparisce
    dal pannello, e la UI lo dice dove qualcuno se lo chiederebbe (toast,
    conferma di «Turn everything off»);
  - **i permessi contano adesso**: chi perde il permesso non riceve e non
    vede più; la riga resta, **sospesa**, e torna da sola se il permesso
    torna — non si cancella;
  - **gli obbligatori arrivano comunque** (autore della PR, chi ha fatto il
    merge, chi segue la conversazione): nessun interruttore, nemmeno «Turn
    everything off», li ferma, e la pagina lo scrive;
  - **le decisioni non sono avvisi**: piani da approvare e domande di
    Claude restano in Home → «Decide» e non compaiono qui (una riga lo
    dice);
  - **Phone nel prototipo** si salva ma non parte nulla: un'etichetta lo
    dice, una volta, accanto all'intestazione della colonna.

## 3. Direzione scelta

- **Tesi**: **il registro delle iscrizioni**. Una pagina di lettura in una
  colonna (fino a 760px), un **gruppo per progetto** con il codice in testa
  come in ogni intestazione del catalogo, dentro i tipi raggruppati per
  famiglia, e a destra **due colonne di interruttori** che restano allineate
  per tutta la pagina — si scorre in verticale leggendo i nomi e si
  confronta in colonna. Niente matrice progetti × tipi (50 × 20 non si
  legge), niente schede per progetto **[A 1]**.
- **Cornice delle Preferenze** — colonna personale (240px, nessun titolo,
  come Drive e Claude), voci 32px: **Notifications** (l'unica viva) ·
  Account · Security · Claude Code; Tema e lingua restano nel menu del
  profilo, la colonna non li duplica. Le voci non costruite portano alla
  pagina segnaposto di oggi con il loro h1 e «Arrives with a later area»
  **[A 2]**.
- **Sequenza della pagina**: h1 «Notifications» → riga in prosa
  `ink-muted`: «Choose, project by project, what you hear about. Decisions
  — plans to approve, Claude's questions — always reach you in Home.» →
  barra: campo «Find a project» (codice o nome) · «Expand all» /
  «Collapse all» → intestazione agganciata delle colonne «App» · «Phone ⓘ»
  → gruppi **Pinned** (`heading-group`), poi **Other projects** → in fondo
  «Not set here» **[A 3]**.
- **Momento focale**: il primo progetto fissato aperto, con la sua prima
  famiglia; gli interruttori accesi sono ink pieno, gli spenti contorno
  `rule-strong` — la colonna di destra si legge come una fila di stati in
  un colpo d'occhio.

```
┌──────────┬───────────────────────────────────────────────────────────────┐
│ Notific. │ Notifications                                                 │
│ Account  │ Choose, project by project, what you hear about. Decisions…   │
│ Security │ [Find a project…]                      Expand all · Collapse  │
│ Claude C.│                                        App   Phone ⓘ          │
│          │ PINNED                                                        │
│          │ ▾ AUD  Audin 2.0          7 on · 2 to phone        ⋯          │
│          │   PULL REQUESTS                                               │
│          │   New PR                                [ ]   [ ]             │
│          │   When a PR is opened in AUD, by Claude or a colleague        │
│          │   PR analysis found problems            [●]   [ ]             │
│          │   Always for the PR's author                                  │
│          │   Claude corrected your PR              Always for you        │
│          │   RELEASES                                                    │
│          │   Release failed                        [●]   [●]             │
│          │   Always when you did the merge                               │
│          │   SUPPORT                                                     │
│          │   Customer replied     Paused · you can no longer reply to    │
│          │                        AUD's customers. Resumes if you can.   │
│          │ OTHER PROJECTS                                                │
│          │ ▸ ACQ  Acquisti Rossi       3 on · 1 paused         ⋯          │
│          │ ▸ MKX  Campagne primavera   Everything off          ⋯          │
│          │ NOT SET HERE  Security alerts · Decisions · Chat · Automations│
└──────────┴───────────────────────────────────────────────────────────────┘
```

### Gruppo di progetto

- **Intestazione** (40px, bottone di espansione, `aria-expanded`):
  freccia · codice in cifre tabellari 600 · nome (ellissi, completo nel
  `title`) · sintesi `ink-faint` a destra · bottone «⋯» (menu del gruppo).
  Sintesi in parole: «7 on · 2 to phone», «3 on · 1 paused», «Everything
  off» (con gli obbligatori: «Everything off · 2 always on»).
- **Aperti di default**: i fissati; chiusi gli altri. Lo stato aperto/chiuso
  si ricorda per persona nel `localStorage` (comodità, non stato) **[A 4]**.
- **Ordine**: fissati nell'ordine del binario, poi gli altri in ordine
  alfabetico per nome (come il portafoglio).
- **Famiglie** dentro il gruppo, con `heading-group`: Pull requests ·
  Releases · Docs · Tasks · Support · Servers · Claude, nell'ordine del
  catalogo (`group` di `AlertType`). Una famiglia senza righe visibili non
  compare.
- **Menu «⋯»** del gruppo: «Same as another project…» (sottomenu con i
  progetti visibili, fissati prima, filtrabile digitando) · «Turn
  everything off in AUD» · separatore · «Open AUD». Niente «ripristina
  predefiniti» nella v1 **[A 5]**.

### Riga di un tipo

- Due righe di testo a sinistra, interruttori a destra:
  - **nome** 14px ink (sentence case, mai il `kind`): «Release failed»;
  - **quando** 13px `ink-muted`: «When a release of AUD fails after the
    merge»; se il tipo ha destinatari obbligatori, al posto o in coda:
    «Always when you did the merge» **[A 6]**.
- **Accesa / spenta**: due interruttori (`role="switch"`, 32×18) in
  colonna App e Phone, nome accessibile completo («Release failed in AUD,
  App»). **Phone richiede App**: accendere Phone accende App; spegnere App
  spegne anche Phone, e Phone resta spento e disattivato finché App è
  spenta **[A 7]**.
- **Sospesa** (permesso perso): niente interruttori; al loro posto, su due
  righe a destra, `ink-muted`: «Paused · you can no longer see AUD's
  repositories» / «It comes back if you get access again.» Il motivo dice
  **cosa** non si vede più, mai il nome del permesso (tabella delle frasi
  per permesso in i18n: `repos.view` → «AUD's repositories», `docs.view` →
  «AUD's docs», `tickets.view_all` → «all of AUD's tasks»,
  `backlog.view_all` → «AUD's requests», `support.reply` → «reply to
  AUD's customers»). Si mostra **solo** se l'iscrizione, esplicita o di
  default, sarebbe accesa; un tipo che non posso vedere e che non era
  acceso semplicemente non c'è **[A 8]**.
- **Obbligatoria** (tipo senza iscrizione, solo destinatari obbligatori,
  es. «Claude corrected your PR»): niente interruttori; a destra «Always
  for you» e sotto, come «quando», il motivo («When Claude pushes a
  correction to a PR you opened»). App e Phone per gli obbligatori: App
  sempre, Phone secondo il `defaultPhone` del catalogo e non modificabile
  nella v1 **[A 9]**.
- **Righe del catalogo con lo stesso significato** (`ticket.created` e
  `task.created`, `request.created` e `support.request`): una riga sola
  in UI; quale `kind` resta lo decide il Task 3 **[A 10]**.

### Salvataggio

- Ogni interruttore salva subito (ottimistico), nessun bottone «Save».
  Errore: l'interruttore torna com'era e toast d'errore «Couldn't save
  “Release failed” for AUD.» · **Retry**.
- Nessun toast al salvataggio riuscito di un singolo interruttore (il
  feedback è l'interruttore stesso); toast solo per le azioni in blocco.

### Azioni in blocco

- **«Turn everything off in AUD»**: niente dialogo; applica, poi toast
  «Everything off in AUD. Alerts you already got stay; you'll still get
  the ones meant only for you.» · **Undo** (ripristina lo stato
  precedente riga per riga, non i default) **[A 11]**.
- **«Same as another project…»**: scelto ACQ, dialogo 400px «Use ACQ's
  alert settings in AUD? 14 alerts change.» con l'elenco breve delle
  differenze (fino a 6 righe «Release failed: off → App and phone», poi
  «and 8 more») · **Copy settings**. I tipi che in AUD non posso vedere
  restano sospesi/assenti, e il dialogo lo dice in una riga. Dopo: toast
  con **Undo** **[A 12]**.

### «Not set here»

- Sezione finale, una riga di prosa con link: «Security alerts always
  reach you. Decisions are in Home → Decide. Chat and Automations notify
  you by their own rules.» Niente interruttori **[A 13]**.

### Popover «Alerts» nella testata del progetto

- **Controllo**: bottone icona 28px in alto a destra della testata della
  colonna, sulla riga del codice (campanella; campanella barrata quando il
  progetto è «Everything off» e non ha obbligatori), nome accessibile
  «Alerts for AUD», tooltip «Alerts for AUD · 7 on» **[A 14]**.
- **Popover** 340px sotto il bottone, superficie flottante (`rule-strong`,
  ombra del profilo menu, raggio 8px), non modale: Esc o clic fuori
  chiudono, il fuoco torna al bottone. Contenuto:
  - titolo 14px 600 «Alerts in AUD», a destra la sintesi `ink-faint`;
  - le stesse righe della pagina in forma compatta (solo il nome, il
    «quando» nel `title` e nel nome accessibile; interruttori App/Phone
    con le intestazioni in alto), famiglie con `heading-group`; altezza
    massima 420px con scorrimento interno;
  - in fondo, filetto, poi «Turn everything off» (stesso toast con Undo) e
    a destra «All notification settings» → `#/preferences/notifications`
    con AUD aperto e portato in vista.
- **Coerenza**: popover e pagina leggono la stessa query; un cambio in uno
  si vede nell'altro senza ricaricare.

### Pannello notifiche: «Don't alert me about this in AUD»

- Solo sulle voci dei **tipi del catalogo**. Le azioni in sovrimpressione
  (Mark read · Archive · Snooze) guadagnano un quarto bottone «⋯» (nome
  accessibile «More actions») con il menu: «Don't alert me about this in
  AUD» · «Alert settings for AUD» (apre la pagina col gruppo di AUD; il
  pannello si chiude) **[A 15]**.
- Clic su «Don't alert me…»: l'iscrizione di quel tipo si spegne (App e
  Phone) per gli avvisi futuri; l'avviso cliccato **resta** dov'è, letto o
  no come prima; toast «You won't get “New PR” alerts from AUD anymore.» ·
  **Undo**. Undo riaccende come prima (anche Phone).
- **Avviso obbligatorio**: nessuna voce «Don't alert me…»; la ragione è
  scritta **sempre** sotto il corpo dell'avviso, 12px `ink-faint`: «You get
  this because you did the merge» / «…because you opened this PR» /
  «…because you follow this conversation». Il menu «⋯» ha solo «Alert
  settings for AUD» **[A 16]**.
- **Già spento** (iscrizione spenta dopo l'avviso): la voce del menu
  diventa «Alerts like this are off in AUD» non cliccabile, più «Turn back
  on» **[A 17]**.

## 4. Ambito e confini

- **Dentro**: colonna delle Preferenze con le voci segnaposto; la pagina
  Notifiche intera (gruppi, righe nei quattro stati, ricerca, espandi/
  chiudi, azioni in blocco con Undo); il popover nella testata di ogni
  progetto; «⋯» e la ragione degli obbligatori nel pannello; ⌘K «Notification
  preferences» e «Alerts for <PRJ>» (apre il popover sul progetto corrente,
  o la pagina col gruppo).
- **Fuori**: le altre sezioni delle Preferenze (Account, Security, Claude
  Code, lingua e tema già nel profilo); notifiche di sistema di Electron
  (solo pannello in 8a); push vero; le righe dei server (8b, arrivano con
  `registerAlertTypes` e devono comparire senza toccare la UI); orari di
  silenzio, riepiloghi via email, DM Slack (tolto di proposito).
- **Anti-obiettivi**: una riga che mostra il nome di un permesso o un
  `kind`; un interruttore che sembra fermare un obbligatorio; un avviso che
  sparisce dal pannello perché si è spenta l'iscrizione; un tipo visibile in
  un progetto che chi guarda non vede (R-G5: il progetto invisibile non ha
  gruppo, nemmeno vuoto); un colore per «acceso» (lo stato è la forma
  dell'interruttore + nome accessibile, non il verde).

## 5. Stati e intervalli

- **Progetti**: 0 → «You're not in any project yet. Alerts are set project
  by project.»; tipico 5–15; massimo ~50 (Roberta): tutti presenti, nessuno
  perso; i chiusi costano una riga da 40px. Fissati 0–10; nessun fissato →
  niente gruppo «Pinned», «Other projects» diventa «Projects».
- **Tipi per progetto**: 0 visibili (Viewer senza permessi su un progetto
  con solo tipi a permesso) → il gruppo dice «Nothing to set up here»;
  tipico 10–14; massimo ~20 con 8b.
- **Ricerca**: filtra i gruppi per codice o nome, apre i gruppi trovati;
  nessun risultato → «No project matches “zz”» · «Clear».
- **Nomi**: progetti fino a ~50 caratteri (ellissi); nomi dei tipi in
  italiano più lunghi del 30% → il «quando» va a capo, gli interruttori
  restano in colonna.
- **Caricamento**: scheletro con la forma vera (3 intestazioni, 6 righe
  sotto la prima). **Errore** della pagina: messaggio + «Retry»; nel
  popover: una riga d'errore + «Retry», il resto della colonna intatto.
- **Cambio di persona** («Vedi come») con la pagina aperta: le righe si
  ricalcolano, i gruppi aperti restano aperti per i progetti che la nuova
  persona vede; il campo di ricerca resta.
- **Permesso perso con il popover aperto**: la riga passa a sospesa sul
  posto, senza chiudere il popover.

## 6. Interazione e layout

- **Pagina**: colonna di lettura fino a 760px allineata a sinistra con 32px
  di margine (come le pagine segnaposto); intestazione delle colonne App/
  Phone agganciata in alto durante lo scorrimento. A 1024×680 (720px utili)
  invariata: il «quando» va a capo prima degli interruttori.
- **Tastiera**: Tab percorre intestazioni e interruttori in ordine di
  lettura; **↑/↓ sulle intestazioni dei gruppi** salta da progetto a
  progetto (navigazione a rovescio sulle sole intestazioni), → apre, ←
  chiude; Spazio commuta un interruttore; `/` porta al campo di ricerca
  **[A 18]**.
- **Ancoraggio**: `#/preferences/notifications?project=AUD` apre AUD, lo
  porta in vista e mette il fuoco sulla sua intestazione (per il popover, il
  pannello e ⌘K).
- **Movimento**: apertura/chiusura del gruppo 200ms in altezza, popover
  150ms in dissolvenza + 4px; nessuno sotto reduced-motion.
- **Interruttori**: ink pieno con pallino ground se accesi; contorno
  `rule-strong` se spenti; disattivati al 40% con `aria-disabled` e
  tooltip («Turn on App first»).
- **Etichetta del prototipo**: «ⓘ» accanto a «Phone» nell'intestazione,
  tooltip e testo per i lettori di schermo: «Prototype: phone alerts are
  saved, but nothing is sent.» Nel popover la stessa frase in una riga
  `ink-faint` sotto le intestazioni.

## 7. Vincoli e decisioni aperte

- Pagine solo via `data/queries.ts` (`subscriptionRows`, `setSubscription`,
  `copySubscriptions`, `muteProject`, `muteFromNotification` del Task 3);
  la UI non calcola stati né destinatari, li legge.
- Testi en/it con parità; nessun testo cablato; le frasi «When…» e i motivi
  di sospensione/obbligo sono chiavi i18n per tipo e per permesso.
- Una riga aggiunta dal catalogo (8b) deve comparire nella famiglia giusta
  senza modifiche alla UI: la UI conosce le famiglie, non i tipi.
- Test che il Task 7 deve avere, oltre a quelli del piano: «Turn everything
  off» non tocca le righe obbligatorie; Undo di «Same as…» ripristina riga
  per riga; il popover e la pagina restano coerenti dopo un cambio in uno
  dei due.

### Scelte del brief (approvate dal maintainer, 28 ott 2026)

1. Un gruppo per progetto con colonne App/Phone allineate; niente matrice
   né schede.
2. Colonna delle Preferenze: Notifications · Account · Security · Claude
   Code; tema e lingua restano solo nel menu del profilo; le altre voci
   portano al segnaposto.
3. Intro fissa che rimanda le decisioni a Home; sezione finale «Not set
   here».
4. Fissati aperti, altri chiusi con riga di sintesi; aperto/chiuso
   ricordato in `localStorage`.
5. Niente «ripristina predefiniti» nella v1.
6. Il motivo dell'obbligo sta nella riga, sotto il nome, anche per i tipi
   che si possono spegnere.
7. Phone richiede App (accendere Phone accende App; spegnere App spegne
   Phone).
8. Sospesa solo se l'iscrizione (esplicita o di default) sarebbe accesa;
   motivo in parole su ciò che non si vede più, mai il permesso.
9. Phone degli obbligatori segue il default del catalogo, non modificabile
   nella v1.
10. I kind esistenti con lo stesso significato dei nuovi diventano una
    riga sola (scelta fine nel Task 3).
11. «Turn everything off» senza dialogo, con Undo nel toast.
12. «Same as another project…» con un dialogo che elenca le differenze.
13. Sicurezza, decisioni, Chat e Automazioni non si regolano qui.
14. Campanella nella testata del progetto, barrata se tutto spento e senza
    obbligatori.
15. «Don't alert me…» dietro un «⋯» fra le azioni del pannello, non come
    quarto bottone in chiaro.
16. La ragione di un avviso obbligatorio è scritta sempre sotto il corpo,
    non solo nel menu.
17. Su un avviso il cui tipo è già spento: «Alerts like this are off» +
    «Turn back on».
18. ↑/↓ fra le intestazioni dei gruppi, `/` per la ricerca.
