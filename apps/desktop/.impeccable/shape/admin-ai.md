# Shape brief — Amministrazione → AI (Providers, Models, Automation, Budget & language, Usage)

> Shape scritto dal controller senza intervista (30 ott 2026): le domande di
> discovery non sono state fatte al maintainer. Dove design e piano non
> bastavano la scelta è marcata **scelta del controller** e numerata
> **[AI n]** in fondo. Le decisioni del maintainer del 30 ott 2026 (piano
> 9b, Global Constraints) valgono come scritte.

Superficie: la voce **AI** di Amministrazione (`/admin/ai?tab=`) con le sue
cinque schede — **Providers**, **Models**, **Automation**, **Budget &
language**, **Usage** —, il dialogo **Add an AI account**, i dialoghi di
sostituzione della chiave e di eliminazione, il componente condiviso
**`SecretField`** (riusato da `admin-integrations.md`). Piano 9b: Task 8 e 9
(dati: Task 1, 2, 3). Spec area 9: «Istanza (9b) → AI», «Quanto è vero nel
prototipo», «Permessi». Inventario: sezione C. Web di riferimento (cosa si
porta, non come appare): `apps/web/src/components/{ai-providers-section,
model-settings-section,usage-panel}.tsx`, `apps/web/src/routes/settings/
{automation,usage}.tsx`, chiavi `settings.aiProviders.*`, `automation.*`,
`usage.*`, `notifications.monthlyBudget*`. Riconferma: dialogo di
`entry.md`. «Who?»: `WhoCanLink` di `admin-audit.md`. Mondo: «Catalogo
numerato», modalità **Operate**.

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi tiene in piedi Claude** (Roberta, full admin, o chi ha
    `ai_providers.manage`): aggiunge un abbonamento quando il primo è al
    limite, mette in testa quello con più margine, sostituisce una chiave
    scaduta. Lo fa poche volte al mese, spesso **perché qualcosa si è
    fermato**: arriva con fretta e vuole vedere subito quale account è al
    limite e fino a quando.
  - **Chi decide quanto si spende e come lavora Claude** (`settings.manage`):
    budget del mese, lingua dei contenuti, auto-fix per tipo di task, modello
    per operazione. Lo fa di rado e vuole sapere **l'effetto prima** di
    salvare.
  - **Chi guarda i conti** (l'«Auditor», `usage.view`; o Sara con una
    concessione di prova): «quanto abbiamo speso a ottobre, e dove?». Solo
    lettura, solo la scheda Usage.
- **Stato d'animo**: controllo. Le schede di scrittura devono dire in
  parole **cosa cambia per chi lavora** (cosa si ferma, da quando vale);
  Usage deve rispondere a una domanda di soldi in una schermata.

## 2. Esito e prova

- **Azioni primarie**: aggiungere, abilitare, riordinare, provare, sostituire
  ed eliminare un account AI; scegliere il modello di un'operazione;
  regolare l'automazione per tipo di task e la revisione delle PR;
  fissare il budget e la lingua dei contenuti; leggere i consumi per periodo
  e per dimensione.
- **Successo**, a 1440×900:
  - in Providers leggo la catena come un elenco numerato, «1 Team Max ·
    Subscription · week 41%», «2 Backup Max · ▲ Near the limit · week 87%»,
    «3 Billing key · API key · used only when no subscription is on», e
    sotto la riga «Above 90% of the week, background work waits for the
    reset.»;
  - trascino Backup Max in cima (o Alt+↑ da tastiera) e leggo «Backup Max
    moved to position 1 of 3»;
  - aggiungo un account con il setup-token, riconfermo, e la riga mostra
    solo «•••• 7f3a»; tornando sulla pagina il token non c'è più da nessuna
    parte;
  - in Models leggo, per «Fix plan», «Opus · set here», e per «Mail
    classification» «Haiku · from the server configuration»;
  - in Budget leggo «$412 spent in October · 69% of $600» e, prima di
    salvare, cosa si ferma quando il budget finisce;
  - in Usage scelgo «Last 30 days», leggo il totale, la serie per giorno e la
    tabella per progetto, con «Other projects» in fondo per chi non vede
    tutto.
- **Verità del prodotto** (dal piano, mai ammorbidite):
  - **un segreto si vede solo mentre si scrive**: dopo il salvataggio le
    ultime 4 cifre e «Replace», mai il valore, in nessuna pagina, voce del
    registro o notifica (RF 1);
  - **la catena è l'ordine**: si prova dall'alto; la chiave API si usa solo
    quando **nessun abbonamento è abilitato**, non quando sono al limite
    (D3);
  - **l'ultimo account abilitato non si spegne né si elimina** (RF 4);
  - **il budget raggiunto ferma il lavoro nuovo, mai quello in corso**;
    alzarlo lo sblocca subito, e i passi d'automazione fermi ripartono da
    soli (decisione del maintainer del 30 ott 2026);
  - **auto-fix, soglie d'effort e approvazione da effort si salvano e
    basta**: il prototipo non li simula, e la scheda lo dice una volta;
  - **R-G5 nei consumi**: un progetto che chi guarda non vede non compare
    per nome né codice, si somma in «Other projects».

## 3. Direzione scelta

- **Tesi**: **una voce, cinque schede, ognuna una domanda**. «Chi lavora?»
  (Providers), «con che modello?» (Models), «quando parte da solo?»
  (Automation), «fino a quanto?» (Budget & language), «quanto è costato?»
  (Usage). La catena dei provider è l'unico elenco **ordinato** della
  pagina e si legge come una classifica: il numero di posizione a sinistra
  in cifre tabellari, grande come un codice **[AI 1]**.

### La voce e le schede

- Colonna di Amministrazione: gruppo **INSTANCE** / **ISTANZA** sotto i
  gruppi del 9a (ACCESS, RECORDS), con **AI** come prima voce; poi Git
  accounts, Plugins, Google Workspace, Storage, Outgoing webhooks (vedi
  `admin-integrations.md`). Gruppo **ACROSS PROJECTS** / **IN TUTTI I
  PROGETTI** con Servers, Repositories, Instance status (vedi
  `admin-instance.md`) **[AI 2]**, *scelta del controller* per i nomi dei
  gruppi.
- Testata: h1 «AI» · riga in prosa «The accounts Claude works with, the
  models it uses, when it starts on its own and how much it can spend.» /
  «Gli account con cui lavora Claude, i modelli che usa, quando parte da
  solo e quanto può spendere.»
- Sotto, una **barra di schede** (`tablist`, 36px, filetto sotto, scheda
  attiva in ink 600 con sottolineatura ink 2px): Providers · Models ·
  Automation · Budget & language · Usage / Provider · Modelli ·
  Automazione · Budget e lingua · Consumi. La scheda sta nell'indirizzo
  (`?tab=`).
- **Chi vede quale** (`aiTabsFor`): Usage solo con `usage.view`; le altre
  quattro con `ai_providers.manage` o `settings.manage`. Una scheda non
  visibile non compare; un `?tab=` non visibile o sconosciuto apre la prima
  scheda visibile senza messaggio **[AI 3]**. Con una sola scheda visibile
  (l'Auditor) la barra non c'è: h1 «AI» e direttamente Usage.
- **Sola lettura**: una scheda vista senza il suo permesso di scrittura
  (Providers senza `ai_providers.manage`; Models, Automation, Budget senza
  `settings.manage`) mostra **una** riga 13px con ○ in testa: «You can read
  these settings. Changing them needs someone who can manage AI providers.
  **Who?**» / «Puoi leggere queste impostazioni. Per cambiarle serve chi può
  gestire i provider AI. **Chi?**» (Models, Automation, Budget: «…someone
  who can change the instance settings.» / «…chi può cambiare le
  impostazioni dell'istanza.»). I controlli restano visibili e spenti, e
  ogni bottone spento porta il suo «Who?» (azione `manageAiProviders` o
  `manageSettings`).

```
1440 ───────────────────────────────────────────────────────────────────────────
┌──────────────┬───────────────────────────────────────────────────────────────┐
│ ACCESS       │ AI                                                            │
│ People       │ The accounts Claude works with, the models it uses, when it   │
│ Departments  │ starts on its own and how much it can spend.                  │
│ Roles        │ Providers  Models  Automation  Budget & language  Usage       │
│ RECORDS      │ ━━━━━━━━━ ─────────────────────────────────────────────────── │
│ Change log   │ Claude works with these accounts, tried top to bottom.        │
│ Who can?     │ When one hits its limit, the next takes over.   [Add account] │
│ INSTANCE     │ ───────────────────────────────────────────────────────────── │
│ AI         ◂ │ ⠿ 1  Team Max        Subscription   5h 22% · week 41%   (on)  │
│ Git accounts │      •••• 7f3a · tested Oct 29 · works          [Test]  ⋯     │
│ Plugins      │ ⠿ 2  Backup Max      Subscription   ▲ Near the limit    (on)  │
│ Google Works.│      •••• 0c1d · read 4 min ago   5h 63% · week 87%  [Test] ⋯ │
│ Storage      │ ⠿ 3  Billing key     API key                            (on)  │
│ Outgoing web.│      •••• 9e2b · used only when no subscription is on  [Test] ⋯│
│ ACROSS PROJ. │ ───────────────────────────────────────────────────────────── │
│ Servers      │ ○ Above 90% of the week, background work (nightly Docs,       │
│ Repositories │   reports) waits for the weekly reset.                        │
│ Instance st. │ ┄ PROTOTYPE ONLY ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │
│              │ ┆ Next test of [Team Max ▾]: (•) Works ( ) Invalid ( ) Unreach.│
└──────────────┴───────────────────────────────────────────────────────────────┘
```

### `SecretField` (condiviso con `admin-integrations.md`)

- **Da scrivere**: campo password 14px con **Show** / **Hide** a destra
  (`aria-pressed`), etichetta sopra, sotto una riga 12px `ink-muted`:
  «Shown only while you type. Once saved, you'll see only the last 4
  characters.» / «Si vede solo mentre lo scrivi. Dopo il salvataggio restano
  solo gli ultimi 4 caratteri.» Il valore si digita in monospace (è una
  chiave).
- **Salvato**: niente campo. Testo «•••• 7f3a» (cifre tabellari) e
  **Replace** / **Sostituisci** (secondario). Replace riapre il campo vuoto
  sul posto con **Save** · **Cancel**; Save chiede la riconferma.
- **In sola lettura**: «•••• 7f3a» senza Replace.
- Il valore non passa mai da una query: dopo Save il campo si svuota prima
  che la risposta arrivi, e se la scrittura è rifiutata il campo resta con
  il valore scritto e l'errore sotto (il valore non viene ricaricato da
  nessuna parte).
- Il webhook in uscita **non** usa `SecretField`: l'URL è un campo normale
  (decisione del maintainer del 30 ott 2026).

### Providers (`?tab=providers`)

- Riga in prosa: «Claude works with these accounts, tried top to bottom.
  When one hits its limit, the next takes over.» / «Claude lavora con questi
  account, provati dall'alto in basso. Quando uno arriva al limite, passa al
  successivo.» A destra **Add account** / **Aggiungi account**
  (`ai_providers.manage`).
- **Riga di un account** (64px, due righe, filetto sotto):
  - maniglia ⠿ (solo con permesso) · **posizione** «1» 16px 600 cifre
    tabellari · **nome** 600 · tipo in parola «Subscription» / «Abbonamento»
    o «API key» / «Chiave API» · a destra l'**interruttore** On/Off con
    etichetta accessibile «Use Team Max» / «Usa Team Max»;
  - seconda riga 13px `ink-muted`: «•••• 7f3a» · ultima prova («tested Oct
    29 · works» / «provato il 29 ott · funziona»; «✕ invalid credentials» /
    «✕ credenziali non valide» e «✕ unreachable» / «✕ non raggiungibile» in
    `critical` con glifo; «not tested yet» / «non ancora provato») · a destra
    **Test** / **Prova** e «⋯».
  - **Quota** (solo abbonamenti), sulla prima riga prima dell'interruttore:
    «5h 22% · week 41%» / «5h 22% · settimana 41%» in cifre tabellari, con
    la **banda in parole**:
    - `ok`: nessuna parola;
    - `near` (da 80%): «▲ Near the limit» / «▲ Vicino al limite» in
      `warning`;
    - `limited`: «● At the limit until 16:00» / «● Al limite fino alle
      16:00» in `critical` («until Nov 2» oltre il giorno).
    - Sotto, nella seconda riga, «read 4 min ago» / «letta 4 min fa». Senza
      lettura: «No usage read yet» / «Nessuna lettura ancora».
  - **Chiave API con abbonamenti abilitati**: seconda riga «used only when no
    subscription is on» / «si usa solo quando nessun abbonamento è
    acceso» (D3). Con tutti gli abbonamenti spenti: «in use: no subscription
    is on» / «in uso: nessun abbonamento è acceso».
  - Disabilitato: riga in `ink-muted`, posizione «–» al posto del numero
    (resta al suo posto nella catena), «Off» / «Spento».
- **«⋯»**: Move up · Move down / Sposta su · Sposta giù · Replace token… (abbonamento) / Replace key… (chiave) · Delete… / Elimina….
- Sotto l'elenco, 13px con ○: «Above 90% of the week, background work
  (nightly Docs, reports) waits for the weekly reset.» / «Oltre il 90%
  della settimana, il lavoro di sfondo (Docs notturni, report) aspetta il
  reset settimanale.» (`BACKGROUND_WEEKLY_THRESHOLD`).
- **Avviso dei Termini** (parità col web), con due o più abbonamenti, una
  riga 13px ○: «Using several Claude subscriptions to get around usage
  limits is against Anthropic's terms. For more capacity, prefer an API
  key.» / «Usare più abbonamenti Claude per aggirare i limiti è contro i
  termini di Anthropic. Per avere più capacità, meglio una chiave API.»
- **Riordino** **[AI 4]**: trascinamento dalla maniglia (la riga si solleva
  con un filetto `rule-strong`, gli altri scorrono in 200ms); da tastiera,
  fuoco sulla maniglia e **Alt+↑ / Alt+↓**, oppure «⋯» → Move up/down. Si
  salva subito (`moveProvider`), annuncio `aria-live`: «Backup Max moved to
  position 1 of 3.» / «Backup Max spostato in posizione 1 di 3.» Nessuna
  riconferma.
- **Interruttore**: salva subito, toast «Backup Max is off. New work uses
  the next account.» / «Backup Max è spento. Il lavoro nuovo usa l'account
  successivo.» **Ultimo abilitato**: interruttore spento (non cliccabile) con
  sotto, 12px, «This is the only account on. Turn on another one first.» /
  «È l'unico account acceso. Accendine prima un altro.» (RF 4).
- **Test**: «Testing…» / «Prova in corso…» per 600 ms, poi l'esito nella
  seconda riga; toast solo se fallisce: «Billing key: invalid credentials.
  Replace the key and test again.» / «Billing key: credenziali non valide.
  Sostituisci la chiave e riprova.» L'esito lo decide il riquadro.
- **Riquadro «Prototype only»** (`PrototypeBox`, in fondo alla scheda,
  solo con `ai_providers.manage`): «Real accounts aren't contacted. Choose
  what the next test answers.» / «Gli account veri non vengono contattati.
  Scegli cosa risponde la prossima prova.» · menu dell'account · Works /
  Invalid credentials / Unreachable (gruppo segmentato).

#### Add an AI account (dialogo 480px)

- Titolo «Add an AI account» / «Aggiungi un account AI».
- **Type**, due righe a scelta con la loro frase:
  - «Claude subscription — paste the token you get by running `claude
    setup-token` on a computer with a browser.» / «Abbonamento Claude —
    incolla il token che ottieni lanciando `claude setup-token` su un
    computer con un browser.»;
  - «API key — a key from the Anthropic Console.» / «Chiave API — una chiave
    dalla Console di Anthropic.»
- **Name** (es. «Team Max 2»), **Token** o **Key** (`SecretField`).
- Riga 12px: «It goes to the bottom of the chain, turned on. You can move it
  after.» / «Va in fondo alla catena, acceso. Puoi spostarlo dopo.»
- **Add** / **Aggiungi** → riconferma → la riga compare in fondo per 2 s con
  lo sfondo `ink/6`, toast «Team Max 2 added at position 4. Test it to check
  the token.» / «Team Max 2 aggiunto in posizione 4. Provalo per
  controllare il token.»
- Errori sotto il campo: «Give it a name.» / «Dagli un nome.» · «Paste the
  token.» / «Incolla il token.» · «Paste the key.» / «Incolla la chiave.» ·
  «There's already an account called Team Max.» / «C'è già un account che
  si chiama Team Max.»

#### Replace e Delete

- **Replace token… / Replace key…**: dialogo 440px «Replace Billing key's
  key» / «Sostituisci la chiave di Billing key» · `SecretField` · riga
  «Work already running finishes with the old one.» / «Il lavoro già
  partito finisce con quella vecchia.» · **Replace** → riconferma → toast
  «Key replaced for Billing key.» / «Chiave sostituita per Billing key.» La
  riga torna a «not tested yet».
- **Delete…**: dialogo 440px «Delete Backup Max?» / «Eliminare Backup
  Max?» · «Work already running finishes with it. New work uses the next
  account in the chain.» / «Il lavoro già partito finisce con questo
  account. Il lavoro nuovo usa il successivo della catena.» · **Delete**
  (`critical`) → riconferma → toast «Backup Max deleted.» / «Backup Max
  eliminato.» Ultimo abilitato: voce del «⋯» spenta con la stessa frase
  dell'interruttore.

### Models (`?tab=models`)

- Riga in prosa: «Which model does each kind of work. A change applies from
  the next run: work in progress finishes with the model it started with.» /
  «Quale modello fa ogni tipo di lavoro. Un cambio vale dalla prossima
  esecuzione: il lavoro in corso finisce col modello con cui è partito.»
- **Gruppi** di `AI_OPERATION_GROUPS` senza «technical», con
  `heading-group`: TASKS / TASK · BACKLOG · NIGHTLY RUN / GIRO NOTTURNO ·
  DOCS · REPORTS / REPORT · MAIL / POSTA · CHAT.
- **Riga di un'operazione** (44px): nome in parole (dalle chiavi del web:
  «Ticket triage» diventa «Task triage» / «Smistamento delle task»; «Fix
  plan» / «Piano della correzione»; «Fix execution» / «Esecuzione della
  correzione»; «Docs chat» diventa «Chats with Claude» / «Conversazioni
  con Claude», perché `chat` copre anche «Chiedi a Claude») · a destra il
  **menu del modello** 200px · sotto il nome, 12px, la **fonte**:
  - `setting`: «Set here» / «Impostato qui» + link **Use default** / **Usa
    il predefinito**;
  - `env`: «From the server configuration» / «Dalla configurazione del
    server»;
  - `default`: «Default» / «Predefinito».
- **Menu**: prima voce «Default (Sonnet)» / «Predefinito (Sonnet)» — o
  «Server configuration (Haiku)» / «Configurazione del server (Haiku)» se
  c'è un env —, poi Opus · Sonnet · Haiku, poi `heading-group` SPECIFIC
  VERSIONS / VERSIONI PRECISE con gli id (`claude-opus-5-5`…, in codice).
- **Salva alla scelta** **[AI 5]** (*scelta del controller*: una voce del
  registro per operazione, come `model.changed`): «Saved» 12px accanto al
  menu per 2 s; **Use default** riporta alla fonte di prima (env o default)
  e la riga lo dice.

### Automation (`?tab=automation`)

- Riga in prosa: «When Claude starts on a task on its own, and how far it
  can go.» / «Quando Claude parte da solo su una task, e fin dove può
  arrivare.» E una riga 12px `ink-faint`: «Prototype: these are saved, but
  nothing here starts Claude on its own.» / «Prototipo: si salvano, ma qui
  niente fa partire Claude da solo.»
- **Per tipo di task**, una tabella con intestazioni 12px: Type · Auto-fix ·
  Up to effort · Plan approval from effort · Max cost per task / Tipo ·
  Auto-fix · Fino all'effort · Approvazione del piano da effort · Costo
  massimo per task. Righe Bug · Feature · Activity (i `TaskType`):
  interruttore · menu 1–5 («2 of 5» / «2 su 5») · menu «Never» / «Mai» e
  1–5 · campo $ con «No cap» / «Nessun tetto». Con auto-fix spento i due
  menu d'effort restano attivi ma la riga dice «only for runs started by
  hand» / «solo per le esecuzioni avviate a mano» sotto «Plan approval».
- **PR review** / **Revisione delle PR**, sotto un filetto: interruttore
  «Review every pull request» / «Rivedi ogni pull request» · «Max cost per
  review» $ · frase «Claude reviews each pull request opened or updated in a
  connected repository and suggests approving or changing it.» / «Claude
  rivede ogni pull request aperta o aggiornata in un repository collegato e
  suggerisce se approvarla o cambiarla.»
- **Barra di salvataggio** agganciata in fondo (come Roles): «3 changes ·
  **Discard** · **Save**» → «Saved». Nessuna riconferma. Una voce sola per
  salvataggio, con prima e dopo delle righe cambiate.
- Errori sotto il campo: «Enter an amount of 0 or more, or leave it empty.»
  / «Inserisci un importo da 0 in su, o lascialo vuoto.»
- Lasciare la scheda con modifiche: «Discard 3 changes?» / «Scartare 3
  modifiche?»

### Budget & language (`?tab=budget`)

- **Monthly budget** / **Budget mensile**: campo $ (cifre tabellari, «No
  budget» / «Nessun budget» se vuoto) e sotto il **misuratore**: barra 6px
  ink su `rule` + frase «$412 spent in October · 69% of $600» / «$412 spesi
  a ottobre · 69% di $600». Al 100%: barra `critical` + «● Budget reached:
  new AI work is on hold until it's raised or the month ends.» / «● Budget
  raggiunto: il lavoro AI nuovo è fermo finché non lo alzi o finisce il
  mese.» Il colore non è mai il solo segnale.
- **Cosa succede**, in righe 13px sotto il campo, sempre visibili:
  - «Counts every AI cost on the instance, in every project. It starts again
    on Nov 1.» / «Conta ogni costo AI dell'istanza, in tutti i progetti.
    Riparte il 1° novembre.»
  - «When it's reached, new work waits: starting Claude on a task, asking
    for changes, server analyses and fixes. Automation steps that use Claude
    wait and start again on their own when the budget is available.» /
    «Quando è raggiunto, il lavoro nuovo aspetta: avviare Claude su una task,
    chiedere modifiche, analisi e correzioni dei server. I passi delle
    automazioni che usano Claude aspettano e ripartono da soli quando il
    budget torna disponibile.»
  - «Ask Claude stops too. Work already running finishes.» / «Si ferma anche
    “Chiedi a Claude”. Il lavoro già partito finisce.»
- **Content language** / **Lingua dei contenuti**: due righe radio English ·
  Italiano, frase «The language of what Claude writes for the team:
  comments, pull request reports, notifications. Your own interface
  language is in Preferences.» / «La lingua di ciò che Claude scrive per il
  team: commenti, report delle pull request, notifiche. La lingua della tua
  interfaccia è nelle Preferenze.»
- **Save** unico → «Saved» (voci separate per budget e lingua). Se il salvataggio
  porta il budget sopra lo speso mentre era raggiunto: toast «Budget saved.
  Work waiting for the budget starts again.» / «Budget salvato. Il lavoro in
  attesa del budget riparte.» Un budget ancora sotto lo speso: «Saved. The
  budget is still reached: $412 spent, $400 budget.» / «Salvato. Il budget è
  ancora raggiunto: spesi $412, budget $400.»
- Errore: «Enter an amount of 0 or more, or leave it empty for no budget.»
  / «Inserisci un importo da 0 in su, o lascialo vuoto per non avere un
  budget.»
- **Riquadro «Prototype only»**: interruttore «Simulate budget reached» /
  «Simula il budget raggiunto» · «See what everyone sees when the budget
  runs out. Turning it off lets waiting work start again.» / «Vedi cosa vedono
  tutti quando il budget finisce. Spegnendolo, il lavoro in attesa riparte.»
  Nessuna voce del registro.

### Usage (`?tab=usage`)

- Riga in prosa: «What Claude cost, in every project you can see, over a
  period.» / «Quanto è costato Claude, in tutti i progetti che vedi, in un
  periodo.»
- **Periodo** (gruppo segmentato, nell'indirizzo `?range=`): Last 7 days ·
  Last 30 days · Last 90 days · This month · Custom… / Ultimi 7 giorni ·
  Ultimi 30 giorni · Ultimi 90 giorni · Questo mese · Intervallo…. Custom
  apre due date From / To accanto. Di base 30 giorni.
- **Totali**, una riga di cinque numeri (20px 600, etichetta 12px sopra):
  Cost · Runs · Input tokens · Output tokens · Cache read / Costo ·
  Esecuzioni · Token in ingresso · Token in uscita · Letti dalla cache.
- **Per giorno**: istogramma a colonne, una serie in ink (nessun colore di
  reparto o di stato), asse y in $ con 3 tacche, asse x con le date ogni
  settimana; passaggio o fuoco su una colonna → «Oct 28 · $14.20 · 46
  runs». Sotto, **Show as table** / **Mostra come tabella** apre la tabella
  giorno · costo · esecuzioni (la serie è leggibile senza il grafico). Il
  costruttore segue la skill `dataviz`.
- **Tabella per dimensione**: «Group by [Project ▾] then by [— ▾]» /
  «Raggruppa per [Progetto ▾] poi per [— ▾]», dimensioni Day · Model ·
  Project · Provider · Operation / Giorno · Modello · Progetto · Provider ·
  Operazione. Colonne Name · Cost · Tokens · Runs, ordinate per costo.
  Con «then by» ogni riga ha ▸ e si apre in posto sui figli, rientrati
  16px; la somma dei figli è la riga.
  - Nomi: progetto «ACQ · Portale utenti…» (codice + nome); senza progetto
    «No project» / «Nessun progetto» (posta, conversazioni libere);
    operazioni da `usage.operations.<op>`, anche le tecniche («Plugin smoke
    tests» / «Smoke test dei plugin», «Account tests» / «Prove degli
    account», «Quota readings» / «Letture della quota»).
  - **Other projects** / **Altri progetti** sempre ultima, `ink-muted`, con
    sotto 12px «Projects you can't see, added together.» / «Progetti che non
    vedi, sommati.» (R-G5). Con un raggruppamento diverso da Project non c'è:
    i loro consumi sono nei totali senza nome.

## 4. Ambito e confini

- **Dentro**: le cinque schede con tutte le azioni del Task 3; `SecretField`;
  i due riquadri «Prototype only» (esito della prova, budget raggiunto);
  sola lettura per permesso; i consumi d'istanza con le cinque dimensioni e
  la vista a due livelli.
- **Fuori**: l'account AI preferito del progetto e i consumi del progetto
  (9c); il parser della quota del web e il suo «Show raw output»
  (strumento per sviluppatori); la simulazione di auto-fix e soglie; la
  quota «letta» dal vivo (nel prototipo è il seme).
- **Anti-obiettivi**: un segreto rivisto; una catena senza numeri di
  posizione; una banda di quota detta solo col colore; un interruttore che
  spegne l'ultimo account; un salvataggio del budget senza dire cosa
  ferma; un codice di progetto invisibile in Usage.

## 5. Stati e intervalli

| Scheda | Caricamento | Vuoto | Errore |
|---|---|---|---|
| Providers | 3 righe scheletro da 64px | «No AI accounts yet. Claude can't work until you add one.» / «Nessun account AI. Claude non può lavorare finché non ne aggiungi uno.» + **Add account**; senza permesso «Someone who can manage AI providers can add one. **Who?**» | «Couldn't load the AI accounts.» / «Impossibile caricare gli account AI.» · **Retry** / **Riprova** |
| Models | 7 gruppi scheletro | — (le operazioni ci sono sempre) | «Couldn't load the models.» · **Retry** |
| Automation | tabella scheletro | — | «Couldn't load the automation settings.» · **Retry** |
| Budget | campo + misuratore scheletro | nessun budget: misuratore senza barra, «$412 spent in October · no budget» | «Couldn't load the budget.» · **Retry** |
| Usage | totali + grafico + 6 righe scheletro | «No AI usage in this period.» / «Nessun consumo AI in questo periodo.» (totali a 0, grafico assente) | «Couldn't load the usage.» · **Retry** |

- **Senza permessi**: la voce AI non c'è senza nessuno dei tre permessi;
  `/admin/ai` per indirizzo è «not found» (R-G5). Sola lettura come sopra.
- **Istanza vuota**: Providers vuoto come in tabella; Models tutti
  «Default»; Automation tutto spento; Budget «No budget»; Usage vuoto.
- **Rifiuti** (in parole, nel punto dell'azione, stato invariato):
  - `forbidden` (permesso perso nel frattempo): «You can no longer change
    this.» / «Non puoi più cambiarlo.» e la scheda passa in sola lettura;
  - `last_enabled_provider`: la frase dell'interruttore;
  - `invalid`: le frasi sotto i campi;
  - `reauth_required` annullato: toast «Nothing was changed.» / «Non è
    cambiato niente.», il dialogo resta aperto con i valori;
  - errore del livello dati: «Couldn't save. Try again.» / «Impossibile
    salvare. Riprova.» · **Retry**.
- **Intervalli**: 0–8 account (oltre 2 abbonamenti l'avviso dei Termini);
  16 operazioni configurabili; 3 tipi di task; budget da 0 a 100 000 $;
  Usage: 1–90 giorni, 0–50 progetti visibili più «Other projects», fino a
  ~20 righe per dimensione (oltre, la tabella scorre dentro la scheda).

## 6. Interazione e layout

- Contenuto fino a 880px; Usage fino a 1040px (il grafico ha bisogno di
  larghezza).
- Cambio scheda senza animazione di contenuto (solo la sottolineatura scorre
  in 150ms); il fuoco va al primo controllo della scheda.
- **1440×900**: tutte le righe a una colonna dentro 880px; in Automation la
  tabella ha 5 colonne; in Usage i cinque totali in fila.
- **1024×680** (720px utili):
  - la barra delle schede scorre in orizzontale se non ci sta (le
    etichette italiane sono più lunghe), con un'ombra di bordo `rule`;
  - in Providers la quota scende sulla seconda riga, l'interruttore resta a
    destra della prima;
  - in Automation ogni tipo di task diventa un blocco a due righe: «Bug ·
    Auto-fix (on)» sopra, i tre controlli sotto con l'etichetta accanto;
  - in Models il menu scende sotto il nome (220px);
  - in Usage i totali vanno su due righe (3 + 2), il grafico prende la
    larghezza piena, la tabella perde la colonna Tokens (resta nel `title`
    della riga).

## 7. Vincoli

- Solo via `data/queries/instance.ts` (`listProviders`, `createProvider`,
  `setProviderEnabled`, `moveProvider`, `testProvider`,
  `replaceProviderCredential`, `deleteProvider`, `simulateNextTest`,
  `listModels`, `setModel`, `getAutomation`, `saveAutomation`, `getBudget`,
  `saveBudget`, `simulateBudgetReached`, `getUsage`).
- `SecretField` non riceve mai un valore da una query; `__secretValuesForTest`
  per RF 1 sul DOM dopo la navigazione.
- Le scelte spente (ultimo abilitato, sola lettura) leggono la risposta del
  livello dati, non una regola nella pagina.
- Testi en/it con parità; `usage.operations.<op>` per ogni `AiOperation`.
- **Voci del registro** (gruppo `ai`, template i18n; chi agisce in 600):
  - `provider.created`: «**Roberta Fontana** added the AI account **Team
    Max 2** (subscription).» / «**Roberta Fontana** ha aggiunto l'account
    AI **Team Max 2** (abbonamento).»
  - `provider.updated`: «…turned off the AI account **Backup Max**.» /
    «…ha spento l'account AI **Backup Max**.» (prima/dopo «On → Off»;
    rinomina «Backup → Backup Max»)
  - `provider.reordered`: «…changed the order of the AI accounts.» /
    «…ha cambiato l'ordine degli account AI.» (prima/dopo «Team Max, Backup
    Max, Billing key → Backup Max, Team Max, Billing key»)
  - `provider.credential_replaced`: «…replaced the key of **Billing key**.» /
    «…ha sostituito la chiave di **Billing key**.» (nessun prima/dopo)
  - `provider.deleted`: «…deleted the AI account **Backup Max**.» /
    «…ha eliminato l'account AI **Backup Max**.»
  - `model.changed`: «…changed the model for **Fix plan**.» / «…ha cambiato
    il modello per **Piano della correzione**.» («Default (Sonnet) → Opus»)
  - `automation.changed`: «…changed the AI automation.» / «…ha cambiato
    l'automazione AI.» («Bug: auto-fix up to effort 2 → 3 · PR review cap
    $2 → $3»)
  - `budget.changed`: «…changed the monthly AI budget.» / «…ha cambiato il
    budget AI mensile.» («$600 → $800»; «No budget → $600»)
  - `content_language.changed`: «…changed the language of generated
    content.» / «…ha cambiato la lingua dei contenuti generati.» («English
    → Italiano»)
- **+R**: aggiungere un account, sostituirne la chiave, eliminarlo. Non:
  abilitare, riordinare, provare, modelli, automazione, budget, lingua.

## Scelte del brief (scelte del controller, da confermare)

1. **[AI 1]** La catena dei provider è un elenco numerato con la posizione
   in cifre tabellari, disabilitati al loro posto con «–».
2. **[AI 2]** I gruppi della colonna si chiamano INSTANCE / ISTANZA e ACROSS
   PROJECTS / IN TUTTI I PROGETTI.
3. **[AI 3]** Una scheda non visibile chiesta per indirizzo apre la prima
   visibile, senza messaggio (la voce esiste, quindi non è «not found»).
4. **[AI 4]** Riordino con trascinamento, Alt+↑/↓ e «⋯», salvato subito e
   annunciato; nessuna riconferma.
5. **[AI 5]** Models salva alla scelta, una voce per operazione; il web ha
   un «Save models» unico.
6. **[AI 6]** Automation e Budget salvano con un bottone (barra di
   salvataggio in Automation); il prototipo dice una volta che auto-fix e
   soglie non si simulano.
7. **[AI 7]** L'avviso dei Termini sugli abbonamenti multipli si porta dal
   web, come riga ○ e non come avviso colorato.
