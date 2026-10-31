# Shape brief — Gli effetti delle impostazioni di progetto nelle altre aree

> Shape scritto dal controller senza intervista (31 ott 2026): le domande di
> discovery non sono state fatte al maintainer. Dove design e piano non
> bastavano la scelta è marcata **scelta del controller** e numerata
> **[PX n]** in fondo. Valgono come scritte le decisioni del maintainer del
> 31 ott 2026 (piano 9c):
> - **domanda 3 (a)**: il report giornaliero spento dice «off» e «Generate»
>   a mano resta; la discovery backlog spenta spegne il pulse e nient'altro;
> - **domanda 4 (a)**: le esecuzioni aperte delle automazioni di un
>   progetto archiviato si annullano con la nota «Project archived».
> Gli effetti sono **solo** quelli della lista del maintainer (Global
> Constraints): brief, Docs notturni, pulse, report, account AI, tetto alle
> correzioni, plugin, progetto archiviato. Grafo del codice, comandi, rami
> protetti, discovery (oltre al pulse) **non** hanno effetti visibili.

Superficie: nessuna pagina nuova. Frasi e righe che le impostazioni del 9c
producono **altrove**:
- la **BriefCard** dell'Overview (`pages/overview/BriefCard.tsx`);
- **DocsHome** e la pagina delle **note di rilascio** dei Docs;
- la **riga quieta del polso** nell'Overview (`pulseLine.ts`);
- la riga del **report giornaliero** in Activity (`PeopleActivity.tsx`);
- la **sezione Claude** della task (`ClaudeSection.tsx`, `task-claude.md`):
  account del progetto e riga **«Skills in this run»**; la stessa riga nella
  pagina della sessione;
- le **automazioni generali** (area 7) che puntano a un progetto archiviato;
- la **PR** con il tetto alle correzioni (8a: nessuna frase nuova).
Piano 9c: Task 6 (dati: Task 2, 4, 5). Spec area 9: «Quanto è vero nel
prototipo → Impostazioni». Forma dei blocchi: la stessa di
`instance-effects.md` (una frase sola, sempre nello stesso posto). Mondo:
«Catalogo numerato», modalità **Operate**.

## 1. Lavoro e pubblico

- **Chi**: chi lavora nel progetto e non ha cambiato l'impostazione — Sara
  che apre l'Overview di ACQ il lunedì e non trova il brief, Marco che avvia
  Claude su AUD-31 e vede un altro account, Elena che cerca la skill
  `brainstorming` in «/». Spesso **non sa che l'impostazione esiste**.
- **Stato d'animo**: sorpresa leggera. La frase dice **cosa è spento**,
  **per quale progetto** e **dove si cambia** (Settings → Automations, che
  ogni membro può leggere), senza nomi tecnici e senza allarmi: uno spento
  per scelta non è un guasto.

## 2. Esito e prova

- **Successo**:
  - MKX ha il brief spento: la BriefCard dice «The weekly brief is off for
    MKX.» al posto di «The first one arrives on Monday»; i brief già scritti
    si leggono ancora;
  - STW con i Docs notturni spenti: DocsHome non promette niente «every
    night» e dice che l'aggiornamento notturno è spento;
  - CBV col pulse spento: la riga quieta del polso dice «Nothing waiting,
    nothing stalled · restart proposals are off»;
  - un progetto col report spento: in Activity «Daily report: off for this
    project», e **Generate report** c'è ancora;
  - AUD-31, «Start»: la sezione Claude dice «Model: Sonnet · Account: Backup
    Max (subscription)»; con Backup Max al limite e «Use only this account»
    dice «Model: Sonnet · No account free: AUD uses only Backup Max»;
  - spenta `brainstorming` in STW, una sessione nuova su STW-14 ha «Skills in
    this run · 11» senza `brainstorming`; una sessione nata prima la elenca
    ancora (*ruling del controller (pre-flight)*, P28: 3 skill del plugin
    base più 8 di superpowers);
  - un'automazione generale che crea una task in ACQ, con ACQ archiviato:
    l'esecuzione dice «Step 2 not done: the project isn't available
    anymore.»
- **Verità del prodotto**:
  - **la UI non afferma ciò che il dato non dimostra**: «off» solo con
    l'interruttore spento; «Skills in this run» solo per una sessione nata
    dopo il 9c (con `skills` scritto alla nascita), mai ricalcolata;
  - **i contenuti già scritti restano** (brief, note di rilascio, report);
  - **un progetto archiviato non si nomina** a chi non lo vede: la frase
    dell'automazione è la stessa per archiviato, eliminato o invisibile.

## 3. Direzione scelta

- **Tesi**: **uno spento si dice nel posto in cui si sarebbe promesso il
  contrario**, con la stessa riga ○ 13px `ink-muted`, e un link a «Settings →
  Automations» del progetto (leggibile da ogni membro; nessun «Who?»: non è
  un permesso che manca, è una scelta). Acceso, niente di nuovo **[PX 1]**.

### Brief settimanale spento (BriefCard)

- **Nessun brief ancora**: al posto di «The first one arrives on Monday» /
  «Il primo arriva lunedì»: «○ The weekly brief is off for MKX.» / «○ Il
  brief settimanale è spento per MKX.» + link **Settings → Automations** /
  **Impostazioni → Automazioni**.
- **Con brief già scritti**: la card mostra l'ultimo come oggi, e sotto la
  data una riga 12px «The weekly brief is off: no new ones arrive. This one
  stays readable.» / «Il brief settimanale è spento: non ne arrivano di
  nuovi. Questo resta leggibile.» con lo stesso link.
- Riacceso: torna «The first one arrives on Monday» (o niente, con brief).
- Cambia **senza ricaricare** dopo un salvataggio in Automations
  (`useProjectSwitches` invalidata).

### Docs notturni spenti (DocsHome, note di rilascio)

- **DocsHome**: sotto la prosa della testata, sempre quando è spento, 13px
  «○ The nightly update is off for STW: pages don't change with new commits,
  and no release notes are written.» / «○ L'aggiornamento notturno è spento
  per STW: le pagine non cambiano con i commit nuovi, e non si scrivono note
  di rilascio.» + link **Settings → Automations**.
- **Note di rilascio**, vuote: al posto di «No release notes yet: they're
  written every night from new commits.» → «No release notes yet: the
  nightly update is off for STW.» / «Nessuna nota di rilascio: per STW
  l'aggiornamento notturno è spento.»; con note già scritte, in testa
  all'elenco 12px «The nightly update is off: no new notes are written.» /
  «L'aggiornamento notturno è spento: non si scrivono note nuove.»
- In **nessun** punto la parola «every night» / «ogni notte» con
  l'interruttore spento (un test cerca la stringa).

### Pulse spento (riga quieta del polso, Overview)

- Solo nella riga quieta (quando c'è niente in attesa e niente fermo):
  «Nothing waiting, nothing stalled · restart proposals are off» / «Niente
  in attesa, niente fermo · le proposte per ripartire sono spente»
  **[PX 2]**. Con altro nel polso, nessuna frase (il polso dice già il
  resto). Acceso, la riga di oggi.
- Il pulse spento perché la discovery è spenta usa la stessa frase (è il
  pulse che è spento).

### Report giornaliero spento (Activity)

- Riga del report del progetto: «Daily report: off for this project» /
  «Report giornaliero: spento per questo progetto» al posto di «Daily
  report: not generated»; **Generate report** / **Genera il report** resta,
  con `title` «Make today's report by hand. The nightly one stays off.» /
  «Fai il report di oggi a mano. Quello notturno resta spento.»
- Un report già pronto per quel giorno si legge come oggi («Daily report:
  ready»), anche se l'interruttore è spento.

### Account AI del progetto (sezione Claude)

- La riga `ProviderLine` sotto lo stato resta quella dell'area 9b,
  «Model: Sonnet · Account: Backup Max (subscription)», con l'account
  scelto da `pickProvider(projectId)` alla nascita della sessione.
- **«Use only this account» e nessun account libero** (`provider: null`
  con `exclusive`): «Model: Sonnet · No account free: AUD uses only Backup
  Max» / «Modello: Sonnet · Nessun account libero: AUD usa solo Backup Max»,
  12px `ink-muted` (non `critical`: la sessione parte comunque nel
  prototipo, ruling del Task 2). `title`: «It's set in AUD's Settings → AI.»
  / «Si imposta in Impostazioni → AI di AUD.» **[PX 3]**
- Senza progetto, o senza esclusività: come oggi («none available» /
  «nessuno disponibile» se la catena è vuota).
- La stessa riga nella testata della pagina della sessione (`#/claude/<id>`)
  e nella storia del lavoro («Run started · Sonnet · Backup Max»).

### «Skills in this run» (sezione Claude e pagina della sessione)

- Una riga a disclosure, **chiusa** di base, sotto la `ProviderLine`: «▸
  Skills in this run · 11» / «▸ Skill di questa esecuzione · 11» (12px,
  cifre tabellari, `aria-expanded`). Aperta: un blocco per plugin, «stubwise
  · stubwise, init, start» e «superpowers · writing-plans, …» (*ruling del
  controller (pre-flight)*, P28: le skill del plugin base sono quelle del
  seme, e `run` non c'è)
  (nomi in 13px, separati da virgola, a capo), nell'ordine di `skillsForRun`.
- È **l'elenco scritto alla nascita della sessione** (`Conversation.skills`):
  un cambio successivo in Settings → Plugins non lo tocca, e nessuna frase
  dice «changed since» (la UI non lo può dimostrare) **[PX 4]**.
- Una sessione senza `skills` (nata prima del 9c, seme) **non ha la riga**.
- Il plugin base c'è sempre; un plugin `failed` non c'è mai.

### Automazioni generali e progetto archiviato

- **Builder** dell'automazione generale (area 7): un'azione il cui progetto
  è archiviato, eliminato o invisibile si legge «A project that's no longer
  available» / «Un progetto che non è più disponibile» (risolto a lettura,
  come il ruling T7 I1 del 9b), con **Choose another project** / **Scegli un
  altro progetto**; nessun codice.
- **Esecuzione**: il passo che agisce su quel progetto non si fa; il
  registro dell'esecuzione dice «✕ Step 2 not done: the project isn't
  available anymore.» / «✕ Passo 2 non fatto: il progetto non è più
  disponibile.» L'esecuzione finisce come **non riuscita** e compare in
  «Needs attention» per chi gestisce l'automazione **[PX 5]**.
- **Esecuzioni annullate all'archiviazione** (automazioni **del**
  progetto): restano nel registro del progetto, leggibili da archiviato, con
  la riga «Cancelled: project archived» / «Annullata: progetto archiviato»
  (domanda 4 (a)); non compaiono in «Needs attention» di nessuno.

### Tetto alle correzioni (PR, 8a)

- Nessuna frase nuova: la PR usa `capOf`, quindi «Cycle stopped after 1
  automatic correction» e, con 0, il ciclo automatico non parte (le frasi
  dell'8a). Solo test.

### Progetto archiviato, altrove

- Binario, fissati, All projects (fuori da Archived), ⌘K, Home, La mia
  settimana, notifiche, «Who can?», Usage d'istanza, Stato dell'istanza,
  Repositories d'istanza, filtri del registro, elenco dei progetti di
  Claude: **niente**, nessuna frase («nascosto» si legge come «non c'è»). Le
  notifiche spariscono a lettura e tornano alla riapertura, senza annunci.
- Amministrazione → Servers: «Only in archived projects»
  (`project-archive.md`).

## 4. Ambito e confini

- **Dentro**: le frasi di brief, Docs notturni, pulse, report spenti; account
  del progetto ed esclusività nella sezione Claude; «Skills in this run»;
  automazioni generali verso un progetto non disponibile; le esecuzioni
  annullate dall'archiviazione.
- **Fuori**: effetti della discovery oltre al pulse; grafo del codice,
  comandi, rami protetti (si salvano e basta); generare davvero brief,
  report, Docs o proposte; un'attesa per quota (ruling del Task 2).
- **Anti-obiettivi**: «every night» con i Docs notturni spenti; «off» con
  l'interruttore acceso; «Skills in this run» su una sessione senza elenco
  scritto alla nascita, o ricalcolata; il codice o il nome di un progetto
  archiviato in una frase letta da chi non lo vede; uno spento detto come
  errore (`critical`); «Generate report» sparito col report spento.

## 5. Stati e intervalli

- **Combinazioni**: brief spento con o senza brief scritti; Docs spenti con
  o senza note; pulse spento con o senza altro nel polso; report spento con
  o senza report del giorno; esclusivo con l'account libero, al limite,
  spento, eliminato (eliminato: la sessione usa la catena, nessuna frase
  speciale; la frase sta in Settings → AI).
- **Caricamento / errore**: le frasi sono parte della risposta di ogni
  pagina (`useProjectSwitches`); se la lettura degli interruttori fallisce,
  la card mostra il suo errore normale, mai «off» né «every night» «per
  sicurezza».
- **Intervalli**: 0–80 skill in una sessione (aperta, la lista va a capo; il
  pannello scorre); nomi di progetto e account lunghi vanno a capo, mai
  tagliati nella frase.

## 6. Interazione e layout

- La riga ○ sta **dove stava la promessa**: sotto la prosa della testata
  (DocsHome), al posto della frase vuota (BriefCard, note di rilascio),
  in coda alla riga quieta (polso), al posto della parola (report).
- Il link **Settings → Automations** apre `/p/<CODE>/settings/automations`;
  il fuoco va all'h1 della sezione.
- **1440×900**: nella BriefCard (colonna destra dell'Overview) la frase su
  due righe; la riga quieta del polso su una; «Skills in this run» nel
  pannello agganciato a 360px, l'elenco aperto va a capo.
- **1024×680**: il pannello è sovrapposto (400px), la riga «No account free:
  AUD uses only Backup Max» va su due righe sotto lo stato; la riga quieta
  del polso va a capo dopo «·»; la frase di DocsHome su tre righe.

## 7. Vincoli

- Le pagine leggono `useProjectSwitches(projectId)` (da `projectSwitchOn`),
  `Conversation.provider`, `Conversation.skills`, e mai una regola propria.
- `runIdentity(operation, projectId)` scrive `provider`, `model`, `skills`
  alla nascita della sessione.
- Nessuna voce del registro nasce da questi effetti (le scrive chi cambia
  l'impostazione); l'annullamento delle esecuzioni all'archiviazione sta nel
  registro dell'esecuzione, non nel registro delle modifiche.
- Testi en/it con parità.

## Scelte del brief (scelte del controller, da confermare)

1. **[PX 1]** Uno spento si dice dove si sarebbe promesso il contrario, con
   una riga ○ e il link a Settings → Automations; nessun «Who?».
2. **[PX 2]** Il pulse spento si dice solo in coda alla riga quieta del
   polso.
3. **[PX 3]** «No account free: AUD uses only Backup Max» al posto
   dell'account, in `ink-muted`, non in `critical`.
4. **[PX 4]** «Skills in this run» è l'elenco della nascita, chiuso di base,
   senza «changed since»; assente sulle sessioni senza elenco.
5. **[PX 5]** Un passo d'automazione verso un progetto non disponibile
   finisce l'esecuzione come non riuscita, con la frase neutra, in «Needs
   attention».

## Scelte confermate dal maintainer (31 ott 2026)

1. **[PX 5]** Un passo d'automazione verso un progetto non disponibile
   chiude l'esecuzione come non riuscita, con la frase neutra, e la mette in
   «Needs attention».
