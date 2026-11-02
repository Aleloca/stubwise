# Shape brief — Gli scenari di Claude nella conversazione: risposte corte, risposta onesta, schede di scelta, schede in blocco, membri, azioni della pagina

> Shape scritto dal controller senza intervista (2 nov 2026): le domande di
> discovery non sono state fatte al maintainer (nessuno strumento di domanda
> in questa sessione: il controller ha sostituito l'intervista con il
> design, il piano 10b e gli shape del 10a). Dove design e piano non
> bastavano la scelta è marcata **scelta del controller** e numerata
> **[SC n]** in fondo. Valgono come scritte le decisioni del maintainer del
> 2 nov 2026: la forma delle risposte (prima riga che risponde, codice
> apribile per ogni fatto, «Hypothesis» mai nella prima riga, elenchi di 5,
> «Details» chiuso); le richieste che toccano l'invisibile si rispondono
> come se l'invisibile non esistesse; D4 (`member.added`); in italiano
> l'Undo di una riga è «Annulla l'azione»; il chip resta «task»; le schede
> del 10b hanno solo Conferma e Annulla.

Superficie (dentro `Conversation`, riquadro e destinazione):
- `pages/claude/conversation/AssistantMessage.tsx` — prima riga, elenco,
  «and N more · open the list», «Who?» d'istanza;
- `pages/claude/conversation/AsideRow.tsx` — «Hypothesis» e «Details»;
- `pages/claude/conversation/CapabilitiesList.tsx` — la risposta onesta S0;
- `pages/claude/conversation/QuestionCard.tsx` — la scheda di scelta nella
  libera;
- `pages/claude/conversation/ProposalCard.tsx` — `why` per riga, «Show N
  more», `notes` sotto la scheda, `blocked`;
- `pages/claude/conversation/PageActionRow.tsx` — filtro, lingua, tema;
- `notifications/NotificationItem.tsx` — `member.added`.

I nomi dei quattro progetti nuovi (`ORT` «Orto Social», `SPZ` «Spazio
Arredo», `LNT` «Lanterna», `BSC`) e le date d'ultima attività negli esempi
sono segnaposti: li fissa il seme del Task 1, e i test leggono il calcolo,
non questi testi.

Restano com'erano (10a): la riga eseguita, «Undo» e i suoi stati, le righe
dei motivi, la scheda C con la riconferma, le righe D (`claude-actions.md`);
la traccia «Claude on behalf of» (`claude-trace.md`); il riquadro
(`claude-panel.md`).

Piano 10b: Task 4, 6, 7, 9, 11 (UI di 7, 9, 11). Spec area 10: parte 4
«Rispondere sui dati», parte 5 (azioni in blocco e righe a parte), parte 9
S0, S2–S5, «Cosa cambia deliberatamente» 3. Mondo: «Catalogo numerato»,
modalità **Operate** con un tratto di **Read** (il testo delle risposte).

## 1. Lavoro e pubblico

- **Roberta** (admin, vede tutto): «quali progetti sono fermi e perché?»,
  «quanto abbiamo speso in AI questo mese?», «archivia i progetti senza
  attività da 3 mesi», da All projects.
- **Giulia** (Project Lead in MKX e ORT): le stesse domande, sullo stesso
  seme. Riceve risposte più corte, **senza** sapere che sono più corte.
- **Laura** (Project Lead in ACQ): «invita Luca come Developer in ACQ»;
  la spesa dei soli progetti di cui vede i consumi.
- **Sara** (Contributor): chiede cose che non può fare; deve capire in una
  riga che non può e a chi chiedere.
- **Chiunque** scriva qualcosa che il prototipo non sa fare: deve sapere
  cosa sa fare, non ricevere un testo plausibile.
- **Stato d'animo**: domanda veloce, risposta che si legge in un colpo
  d'occhio e di cui ci si può fidare. Diffida di un numero senza fonte e di
  un «forse» scritto come un fatto.

## 2. Esito e prova

- **Successo**, nel riquadro (400px) a 1440×900:
  - Roberta: «which projects are stuck?» → «3 projects have stalled
    tasks», tre righe che cominciano col codice, sotto una riga
    «Hypothesis» col suo segno e «Details» chiuso. Nessuna riga oltre la
    prima risponde a un'altra domanda;
  - Giulia, stessa frase: «MKX has 2 stalled tasks, the oldest for 9 days
    (no one assigned)» — una riga sola, nessun elenco, nessun accenno ad
    altri progetti;
  - Laura, «quanto abbiamo speso in AI questo mese?»: «In the projects
    whose usage you can see: $184», due righe, poi «The total is visible
    to people who can see usage · Who?»;
  - Roberta, «archivia i progetti senza attività da 3 mesi»: una frase, la
    scheda con tre progetti e il perché per riga, sotto la scheda «BSC has
    Claude working on BSC-3: it can be archived when that ends»;
  - Laura, «invita Luca come Developer in ACQ»: una frase, la scheda C con
    «Notifies Luca Bianchi» e «Asks for your two-step code»;
  - «scrivimi una poesia»: «In the prototype I can do these things:» e
    sette righe cliccabili; un clic scrive la frase nella casella e non la
    invia.
- **Verità del prodotto**:
  - **le risposte sono calcolate**: ogni numero esce dal calcolo sulle
    letture di chi chiede; dopo un'archiviazione, «quali progetti sono
    fermi?» lo sa;
  - **un fatto ha la sua fonte apribile**: il codice in testa alla riga;
  - **una deduzione è un'altra cosa**: sta in una riga sua col segno, mai
    nella prima riga, mai mescolata a un fatto;
  - **l'invisibile non esiste**: nessuna frase cambia a seconda di quanto
    chi chiede non vede; nessun «solo quelli che vedi».

## 3. Direzione scelta

- **Tesi**: **una riga che risponde, il resto si apre**. La risposta è
  testo di Claude nella gerarchia dell'area 3 (14px ink), non una scheda:
  le schede restano l'unico contorno del flusso e dicono «decidi tu».
  Elenchi, ipotesi e dettagli sono righe di catalogo sotto la prima riga,
  ognuna con la sua forma **[SC 1]**.
- **Ordine fisso** dentro un turno di Claude, dall'alto:
  1. prima riga (`say`), la risposta;
  2. elenco (fino a 5 righe) e «and N more · open the list»;
  3. «Hypothesis» (`aside` `hypothesis`), se c'è;
  4. «Details» (`aside` `details`), chiuso;
  5. riga del rifiuto o del limite con «Who?», se c'è;
  6. la scheda (B/C, scelta), se c'è, con le righe a parte sotto.

### 3.1 La risposta corta (S2, S3)

- **Prima riga**: 14px ink, una frase, risponde alla domanda col numero
  calcolato. Mai una deduzione, mai «Ecco i…».
- **Riga dell'elenco**: 14px, altezza minima 28px, rientro 0 (nessun
  punto elenco: il codice fa da segno). Forma: **codice** 600 cifre
  tabellari (link all'oggetto) · trattino lungo · il fatto in ink. Va a
  capo a parole; il codice non si spezza.
- **«and N more · open the list»**: 13px `ink-muted`, sotto la quinta riga;
  «open the list» / «apri l'elenco» è un link alla pagina filtrata. N conta
  solo ciò che chi chiede vede (lo calcola il livello dati).
- **Una sola voce**: niente elenco. La prima riga diventa la frase
  completa («ACQ has 4 stalled tasks, the oldest for 12 days (waiting for
  an answer to Claude)»).
- **Zero**: una riga («No project has stalled tasks» / «Nessun progetto ha
  task ferme»). Nessun «Details».

### 3.2 «Hypothesis» e «Details» (`AsideRow`)

- **Hypothesis**: una riga a sé, sotto l'elenco, con un **filetto
  tratteggiato** verticale di 2px a sinistra (`ink-faint`, lo stesso
  tratteggio dell'anello di Claude: «non è un fatto») e rientro di 12px.
  In testa la parola **Hypothesis** / **Ipotesi** 12px 600 `ink-muted`,
  poi « · » e il testo 13px `ink-muted`. Anche la deduzione cita il codice
  su cui ragiona **[SC 2]**. Il segno è doppio (filetto + parola): mai
  solo forma, mai solo colore. Per lo screen reader la riga comincia con
  «Hypothesis:».
- **Details**: un bottone testo 13px `ink-muted` con chevron ▸ («Details»
  / «Dettagli»), chiuso di default, `aria-expanded`; si apre con Invio o
  Spazio. Aperto (▾) mostra prosa 13px `ink-muted` rientrata di 12px, con
  un filetto `rule` a sinistra (continuo, non tratteggiato: è un fatto,
  il metodo). Si chiude allo stesso modo; nessuna animazione d'altezza
  oltre 150ms, nulla con movimento ridotto.
- Una risposta ha al massimo **una** Hypothesis e **un** Details.

### 3.3 S2 — «Quali progetti sono fermi e perché?»

| Parte | en | it |
|---|---|---|
| prima riga (più di uno) | {{count}} projects have stalled tasks | {{count}} progetti hanno task ferme |
| prima riga (uno) | ACQ has 4 stalled tasks, the oldest for 12 days ({{reason}}) | ACQ ha 4 task ferme, la più vecchia da 12 giorni ({{reason}}) |
| prima riga (uno, una task) | ACQ has 1 stalled task, for 12 days ({{reason}}) | ACQ ha 1 task ferma, da 12 giorni ({{reason}}) |
| zero | No project has stalled tasks | Nessun progetto ha task ferme |
| riga | **ACQ** — 4 stalled tasks, the oldest for 12 days ({{reason}}) | **ACQ** — 4 task ferme, la più vecchia da 12 giorni ({{reason}}) |
| oltre 5 | and {{count}} more · open the list | e altri {{count}} · apri l'elenco |
| ipotesi (`idle` senza settimana) | Hypothesis · **ACQ-14** may have fallen out of planning: it has no week | Ipotesi · **ACQ-14** forse è uscita dalla pianificazione: non ha una settimana |
| Details | A task counts as stalled when it hasn't changed for longer than its project's threshold (ACQ: 7 days). Only open projects. Read at 10:41. | Una task è ferma quando non cambia da più della soglia del suo progetto (ACQ: 7 giorni). Solo progetti aperti. Letto alle 10:41. |

- **Il motivo** fra parentesi è quello di `stallOf`, con le parole del
  blocco «Stalled» del polso (`overview.md`), al minuscolo:

| `reason.kind` | en | it |
|---|---|---|
| `manual` | marked stuck: {{reason}} | segnata ferma: {{reason}} |
| `decision` | waiting for Elena Moretti's decision | aspetta una decisione di Elena Moretti |
| `claude_question` | waiting for an answer to Claude | aspetta una risposta a Claude |
| `blocked_by` | blocked by **ACQ-9** | bloccata da **ACQ-9** |
| `unassigned` | no one assigned | senza assegnatario |
| `idle` | no changes | nessun cambiamento |

- «open the list» porta a All projects → scheda **Stalled**, con
  l'indirizzo che quella pagina usa già.
- I «Details» nominano la soglia del solo progetto della prima riga
  dell'elenco; con soglie diverse fra i progetti: «Thresholds differ by
  project: see each project's Settings → Stalled.» / «Le soglie cambiano
  da progetto a progetto: le trovi in Impostazioni → Fermo di ognuno.»
  **[SC 3]**.

### 3.4 S3 — «Quanto abbiamo speso in AI questo mese?»

| Vista | Prima riga (en / it) | Sotto |
|---|---|---|
| `instance` con budget | We've spent $412 on AI this month, of a $600 budget. / Questo mese abbiamo speso $412 in AI, su un budget di $600. | heading-group **MOST SPENT** / **SPENDONO DI PIÙ**, poi 3 righe «**ACQ** — $120» (l'ultima può essere «Other projects — $40» / «Altri progetti — $40», senza codice); poi «Open Usage →» / «Apri Consumi →» |
| `instance` senza budget | We've spent $412 on AI this month. There's no monthly budget. / Questo mese abbiamo speso $412 in AI. Non c'è un budget mensile. | come sopra |
| `projects` | In the projects whose usage you can see: $184. / Nei progetti di cui vedi i consumi: $184. | una riga per progetto «**ACQ** — $120», ordinate dalla più alta, fino a 5 con «and N more · open the list»; poi «The total is visible to people who can see usage · Who?» / «Il totale lo vede chi può vedere i consumi · Who?» |
| `none` | You can't see the usage of any project · Who? / Non vedi i consumi di nessun progetto · Who? | niente |
| dato che manca | I don't have usage per person. / Non ho i consumi per persona. | niente: nessuna stima, nessuna cifra |

- Le cifre con `i18n/money.ts`, in cifre tabellari. Il mese è dal 1° a
  `now()`; i «Details» lo dicono: «From Nov 1 to Nov 2, 10:41. The same
  totals as Usage.» / «Dal 1° nov al 2 nov, 10:41. Gli stessi totali di
  Consumi.»
- **Nessuna percentuale** del budget nella prima riga: i due numeri
  bastano, e una percentuale sarebbe un terzo numero da verificare
  **[SC 4]**.
- «Other projects» solo nella vista `instance`. Nella vista `projects`
  nessun numero coincide col totale d'istanza, e nessuna frase dice «di
  più» o «in tutto».

### 3.5 S0 — La risposta onesta (`CapabilitiesList`)

- Prima riga: «In the prototype I can do these things:» / «Nel prototipo
  so fare queste cose:». Sotto, l'evento `capabilities`: un elenco di righe
  32px, ognuna un **bottone testo** a tutta larghezza (14px ink, hover
  tinta 6%, raggio 6px), con a destra 12px `ink-faint` la freccia ↵ e la
  scritta «Write it» / «Scrivila» visibile solo al passaggio e al fuoco.
- **Un clic scrive la frase d'esempio nella casella, senza inviare**, col
  cursore sul primo segnaposto selezionato (vedi sotto); il fuoco va nella
  casella. Se la casella aveva testo, lo sostituisce e ⌘Z lo riporta (come
  [CP 14]).
- Le nove voci **[SC 5]** *(maintainer, 2 nov 2026: nove, con email e descrizione di D1)*:

| `id` | Riga (en / it) | Frase scritta (en / it) |
|---|---|---|
| `automation` | Build an automation and test it / Costruire un'automazione e provarla | When an urgent support request arrives, create a task and notify the department / Quando arriva una richiesta di supporto urgente, crea una task e avvisa il reparto |
| `stalled` | Tell you which projects are stalled, and why / Dirti quali progetti sono fermi, e perché | Which projects are stalled and why? / Quali progetti sono fermi e perché? |
| `spend` | Tell you this month's AI spend / Dirti quanto si è speso in AI questo mese | How much have we spent on AI this month? / Quanto abbiamo speso in AI questo mese? |
| `archive` | Archive projects with no activity / Archiviare i progetti senza attività | Archive the projects with no activity for 3 months / Archivia i progetti senza attività da 3 mesi |
| `addMember` | Add someone to a project / Aggiungere qualcuno a un progetto | Add [person] to [project] as [role] / Aggiungi [persona] a [progetto] come [ruolo] |
| `supportReply` | Write the reply to a support conversation / Scrivere la risposta a una conversazione di supporto | Write the reply / Scrivi la risposta |
| `releaseNotes` | Write a pull request's release notes / Scrivere le note di rilascio di una pull request | Write the release notes / Scrivi le note di rilascio |
| `mailBody` | Write an email or a reply in Mail / Scrivere un'email o una risposta nella Posta | Write an email to [person] saying [what] / Scrivi un'email a [persona] per dire che [cosa] |
| `taskDescription` | Write a task's description / Scrivere la descrizione di una task | Write the description of [task] / Scrivi la descrizione di [task] |

- **Segnaposti**: le frasi non nominano mai persone o progetti del seme
  (sarebbero codici che chi guarda può non vedere, e un'istanza
  self-hosted non li ha). Dove serve un oggetto c'è una parola fra
  parentesi quadre; inserita la frase, il primo segnaposto è selezionato e
  Tab passa al successivo. Con un progetto nel chip, `[project]` è già il
  suo codice **[SC 6]**.
- **Nella Chat** (@Claude in un thread) lo stesso elenco, come testo
  normale: righe senza bottone e senza ↵, prefisso «·». Le frasi d'esempio
  non compaiono (non c'è una casella da riempire) **[SC 7]**.
- **Destinazione a pagina intera**: come nel riquadro; la colonna è più
  larga, le righe restano su una linea.
- Nessuna riga dice che Claude «chiede sempre conferma»: la frase
  dell'atterraggio è già stata sostituita nel 10a ([CP 9]).

### 3.6 La scheda di scelta nella libera (`QuestionCard`, variante «free»)

- È la scheda della domanda dell'area 3: intestazione «Claude asks» /
  «Claude chiede» col punto «ti aspetta», il testo della domanda 14px,
  le opzioni come righe 40px a tutta larghezza, la **consigliata per
  prima** con l'etichetta «Recommended» / «Consigliata» (12px `ink-muted`
  a destra della riga).
- **Differenze dalla domanda dell'agente**:
  - nessuna riga «… or someone who can approve plans in ACQ can answer»:
    risponde solo chi ha aperto la conversazione;
  - nessun «Other…»: le opzioni sono tutte quelle possibili, e chi vuole
    altro scrive un messaggio nuovo **[SC 8]**;
  - un messaggio nuovo non chiude la scheda: resta rispondibile finché non
    scade (20 messaggi o 24 ore, area 3).
- **Le domande**:

| Caso | Testo (en / it) | Opzioni |
|---|---|---|
| S1, reparto | Which department should get the task and the notice? / A quale reparto vanno la task e l'avviso? | i reparti, nell'ordine configurato, ognuno con la striscia 3px del reparto e il nome; **Support** «Recommended» quando l'evento viene dal supporto |
| S1, reparto che non vede | Nobody in Marketing sees ACQ: which department should I notify? / Nessuno di Marketing vede ACQ: quale reparto avviso? | i reparti in cui almeno una persona vede il progetto; nessuna consigliata |
| S1, progetto | Which project is the automation for? / Per quale progetto è l'automazione? | i progetti in cui chi chiede gestisce le automazioni, codice 600 + nome; consigliato il progetto del chip, se c'è fra questi |
| S5, più persone | Which Luca should I add to ACQ? / Quale Luca aggiungo ad ACQ? | le sole persone che chi chiede vede: nome + reparto («Luca Bianchi · Sales»); **nessuna consigliata** |
| S5, ruolo inesistente | Which role should Luca Bianchi have in ACQ? / Che ruolo deve avere Luca Bianchi in ACQ? | i ruoli di progetto, nell'ordine dei preset; nessuno consigliato |
| assegna senza a chi (Task 4) | Who should I assign MKX-31 to? / A chi assegno MKX-31? | le persone del progetto che chi chiede vede; nessuna consigliata |

  Una persona non si consiglia mai: sarebbe una scelta di Claude presentata
  come un fatto **[SC 9]**.
- **Dopo la risposta**: la scheda si riduce a una riga 13px `ink-muted`,
  come la domanda dell'agente: «Which department should get the task and
  the notice? — Answered by Laura Costa: **Support** · 10:42». Il fuoco va
  sulla riga; la richiesta riprende da sola e il turno di Claude continua
  sotto, senza un messaggio nuovo della persona.
- **Terza mancanza** nella stessa richiesta (dopo due schede): niente
  scheda, una riga «I still need the department to build it: tell me which
  one.» / «Mi serve ancora il reparto per costruirla: dimmi quale.».
- **Altri lettori** (pubblica): la scheda è chiusa, con le opzioni in sola
  lettura e la riga «Laura Costa can answer» / «Può rispondere Laura
  Costa»; risposta: la stessa riga ridotta.
- **Nessuna voce del registro decisioni**: è una scelta della
  conversazione, non una decisione del progetto. Nessun segno lo dice: è
  il default.

### 3.7 La scheda in blocco di S4 (`ProposalCard`)

- Prima riga del turno:
  - più candidati: «3 projects have had no activity for 3 months:» / «3
    progetti sono senza attività da 3 mesi:» (il periodo ripete quello
    chiesto: «90 days» / «90 giorni» se chiesto in giorni);
  - uno: «ORT has had no activity for 3 months:» / «ORT è senza attività
    da 3 mesi:»;
  - nessuno: «No project you manage has been inactive for 3 months.» /
    «Nessun progetto che gestisci è senza attività da 3 mesi.» — niente
    scheda; sotto, le righe a parte se ci sono.
- **La scheda**: intestazione «Claude proposes · 3 changes» / «Claude
  propone · 3 modifiche». Una riga per progetto:
  - casella di spunta a sinistra (spuntata), poi «Archive **ORT** Orto
    Social» / «Archivia **ORT** Orto Social» (codice 600 tnum, nome
    accanto);
  - sotto, 12px `ink-muted`, rientrata sotto il testo, il **perché in un
    fatto**: «last activity: Jul 24» / «ultima attività: 24 lug» (data
    breve; `title` con data e ora intere).
  - Togliere la spunta toglie la riga dalla scelta: il testo della riga
    passa a `ink-faint` col nome accessibile «Not included» / «Esclusa»;
    il bottone primario diventa «Confirm 2 selected» / «Conferma le 2
    selezionate». Con nessuna spunta, Confirm è spento con la frase
    «Choose at least one project.» / «Scegli almeno un progetto.».
  - **Oltre 5 righe**: le prime 5, poi un bottone testo 13px «Show 3
    more» / «Mostra altri 3» (per i progetti; «altre» per le task)
    **[SC 10]**. Aperto, tutte le righe e «Show fewer» / «Mostra meno». Le
    righe nascoste **restano nella scelta** (spuntate): il primario dice
    sempre il numero vero, «Confirm all 8» / «Conferma tutti e 8».
- **Righe dei motivi** (dentro la scheda, 10a): nessuna per l'archiviazione
  oggi (non avvisa e non fa partire automazioni); se il livello dati ne
  manda, valgono le regole del 10a.
- **Bottoni**: **Cancel** / **Annulla** · **Confirm all 3** / **Conferma
  tutti e 3**. Nessun «Edit» (decisione del maintainer).
- **Righe a parte sotto la scheda** (fuori dal contorno, 13px `ink-muted`,
  ognuna con un segno 16px a sinistra, nell'ordine):
  1. **non gestibili** (segno: lucchetto aperto): «On 2 of these you can't
     archive · Who?» / «Su 2 di questi non puoi archiviare · Who?». Senza
     candidati: «2 inactive projects you can't archive · Who?» / «2
     progetti inattivi che non puoi archiviare · Who?». «Who?» apre il
     `WhoCanLink` (`manageProjectSettings`) del progetto; con più progetti
     apre prima un piccolo menu coi codici e i nomi (solo progetti che chi
     chiede vede, dal campo `codes` della nota) e poi il «Who?» di quello
     scelto **[SC 11]**;
  2. **busy** (segno: l'anello di Claude **fermo**), una riga per
     progetto, con le ragioni di `busyReasonsOf`:

| `reason.kind` | en | it |
|---|---|---|
| `claude_session` | **BSC** has Claude working on **BSC-3**: it can be archived when that ends | **BSC** ha un lavoro di Claude in corso su **BSC-3**: si archivia quando finisce |
| `claude_session` + `waiting` | **BSC** has Claude waiting for an answer on **BSC-3**: it can be archived when that ends | **BSC** ha Claude che aspetta una risposta su **BSC-3**: si archivia quando finisce |
| `open_pr` | **BSC** has an open pull request (shop#18): it can be archived when it's closed | **BSC** ha una pull request aperta (shop#18): si archivia quando si chiude |
| `server_fix` | **BSC** has a fix open on **SRV-2**: it can be archived when that ends | **BSC** ha una correzione aperta su **SRV-2**: si archivia quando finisce |
| `release_fix` / `release` | **BSC** has release **BSC-V3** in progress: it can be archived when that ends | **BSC** ha il rilascio **BSC-V3** in corso: si archivia quando finisce |

     Un codice di task nella ragione che chi chiede non vede: la frase
     senza codice («…has Claude working: it can be archived when that
     ends»).
  Nessuna riga nomina o conta progetti invisibili: Giulia non vede né
  «SPZ» né un «+2».
- **Conferma**: tutti i progetti spuntati insieme, o nessuno
  (`executeGroup`). La scheda si riduce a «Done · 3 projects archived» /
  «Fatto · 3 progetti archiviati», poi le tre righe eseguite «✓ Archived
  **ORT**» / «✓ Archiviato **ORT**» e **un solo** controllo «Undo all 3» /
  «Annulla tutte e 3 le azioni» ([CA 3]; le chiavi `undoAll`/`undo` del 10a
  esistono già) **[SC 12]**.
- **Esito negativo** (un permesso perso, un progetto diventato `busy` fra
  proposta e conferma): «Couldn't do it: **BSC** has Claude working.
  Nothing was changed.» / «Non è stato possibile: **BSC** ha un lavoro di
  Claude in corso. Non è cambiato nulla.» — nulla a metà (area 3).

### 3.8 S5 — Aggiungere un membro, e la scheda C bloccata

- **Un Luca, non membro**: prima riga «Luca Bianchi is already in
  Stubwise, so there's no invite to send.» / «Luca Bianchi è già in
  Stubwise, quindi non serve un invito.» Sotto la scheda C (10a):
  - riga d'azione «Add **Luca Bianchi** to **ACQ** as Developer» /
    «Aggiungi **Luca Bianchi** ad **ACQ** come Developer»;
  - motivi: (campanella) «Notifies Luca Bianchi» / «Avvisa Luca Bianchi»
    *(D4)*; (lucchetto) «Asks for your two-step code» / «Chiede il codice
    a due fattori»;
  - **Cancel** · **Confirm**. Conferma → «Confirm it's you» sopra il
    riquadro, con «To add Luca Bianchi to ACQ as Developer, enter a code
    from your authenticator app.» (10a). Fatto: «Done · Luca Bianchi added
    to **ACQ**» / «Fatto · Luca Bianchi aggiunto ad **ACQ**», riga eseguita
    «✓ Added **Luca Bianchi** to **ACQ** as Developer» con «Undo» e, se la
    grazia è scaduta, «asks for your code» / «chiede il codice».
  - Le frasi non usano pronomi per la persona aggiunta (nessun «him»,
    «lo»): l'istanza è di chiunque, il nome dice abbastanza **[SC 13]**.
- **Già membro**: una riga «Luca Bianchi is already in ACQ as Viewer.» /
  «Luca Bianchi è già in ACQ come Viewer.» Nessuna scheda.
- **Più Luca**: la scheda di scelta (§3.6); risposto, la scheda C.
- **Nessuna persona col nome**: riga D (10a, tema `secret`): «I can't find
  Pietro in Stubwise. An invite sends a link, and the app creates it, not
  me. Open the invite to ACQ as Developer →» / «Non trovo Pietro in
  Stubwise. Un invito manda un link, e lo crea l'app, non io. Apri l'invito
  ad ACQ come Developer →». Il link apre Amministrazione → Persone col
  dialogo «Invite» compilato con progetto e ruolo e l'**email vuota**. Né
  il testo né l'indirizzo contengono un link d'invito o un token.
- **ACQ invisibile o inesistente**: «Can't find the project ACQ.» / «Non
  trovo il progetto ACQ.» Identica nei due casi.
- **Ruolo con permessi che chi agisce non ha** (`blocked: escalation`):
  la scheda nasce bloccata.
  - Sopra i bottoni, al posto della riga della riconferma, una riga 13px
    con il segno ⊘ in `critical` e testo ink: «You can't give the
    Developer role in ACQ: it has permissions you don't have there.» /
    «Non puoi dare il ruolo Developer in ACQ: ha permessi che tu lì non
    hai.»
  - **Confirm** è spento, con quella riga come `aria-describedby`;
    **Cancel** resta. Nessun «Who?» (non è un permesso che manca a te: è
    un tetto) **[SC 14]**.
  - Il colore non è l'unico segnale: ⊘ e la frase.

### 3.9 La notifica `member.added` (D4)

| Parte | en | it |
|---|---|---|
| titolo | You've been added to **ACQ** as Developer | Sei stato aggiunto ad **ACQ** come Developer |
| corpo, a mano | Laura Costa added you to **ACQ** as Developer. | Laura Costa ti ha aggiunto ad **ACQ** come Developer. |
| corpo, con Claude (`viaClaude`) | Claude on behalf of Laura Costa added you to **ACQ** as Developer. | Claude per conto di Laura Costa ti ha aggiunto ad **ACQ** come Developer. |
| annullata (derivato a lettura) | ↺ Undone by Laura Costa | ↺ Annullato da Laura Costa |

- Forma del pannello notifiche (`claude-trace.md`): nella colonna fissa il
  **codice del progetto** «ACQ» (non c'è un oggetto con codice), poi «·
  Oct 30» e il titolo; il link porta all'Overview del progetto.
- Il nome del ruolo si legge **a lettura**: rinominato il ruolo, la
  notifica dice il nome nuovo; un ruolo eliminato si legge «a role that no
  longer exists» / «un ruolo che non esiste più» **[SC 15]**.
- **Annullata** (Luca non è più membro): la notifica resta con «Undone by
  Laura Costa»; il codice resta come testo ma **non è più un link** (Luca
  non vede più ACQ) **[SC 16]**. Nessuna seconda notifica.
- Non parte per chi si aggiunge da solo, per Claude collega, né per un
  cambio di ruolo.

### 3.10 Le azioni della pagina: filtro, lingua, tema (`PageActionRow`)

- Stessa forma della riga eseguita del 10a: segno ✓ · verbo al passato ·
  oggetto · a destra il controllo «Undo» / «Annulla l'azione». Nessun
  toast (decisione del maintainer).

| Azione | en | it |
|---|---|---|
| lingua → it | Switched the interface to Italian | Interfaccia passata all'italiano |
| lingua → en | Switched the interface to English | Interfaccia passata all'inglese |
| tema scuro / chiaro / sistema | Switched to the dark theme · light theme · system theme | Passato al tema scuro · chiaro · come il sistema |
| filtro | Filtered **ACQ** tasks: assigned to Marco Bellini · open | Filtrate le task di **ACQ**: assegnate a Marco Bellini · aperte |
| filtro salvato (catalogo, riga eseguita) | Saved the filter “Marco in ACQ” · only you see it | Salvato il filtro «Marco in ACQ» · lo vedi solo tu |
| già così | The theme is already dark. | Il tema è già scuro. |

- La riga della lingua si scrive **nella lingua nuova** (l'interfaccia è
  cambiata prima che la riga si disegni), e le righe vecchie si rileggono
  nella lingua nuova come sempre (`Utterance`).
- Il filtro **cambia l'indirizzo della pagina sotto** (Tasks di ACQ coi
  criteri). Se chi chiede era su un'altra pagina, la pagina cambia: è ciò
  che ha chiesto. La riga ha anche «Show» / «Mostra» se chi chiede ha poi
  lasciato quella pagina.
- **Stati di «Undo»**:

| Stato | en | it |
|---|---|---|
| disponibile | Undo | Annulla l'azione |
| annullata | ↺ Undone | ↺ Annullata |
| cambiata dopo | You changed it afterwards · can't undo from here | L'hai cambiata dopo · non si annulla da qui |
| dopo un ricaricamento | Can't be undone anymore | Non si annulla più |
| fallita | ✕ Didn't run: {{reason}} | ✕ Non eseguita: {{reason}} |

- **«Vedi come»**: la riga si esegue solo per la persona della sessione;
  un altro lettore della pubblica la vede chiusa, senza «Undo» né stato.

```
1440 ── riquadro 400px, Roberta, All projects ─────────────
│ ROBERTA FONTANA                                           │
│ ░ which projects are stuck?                              ░│
│ (CL) Claude · 10:41                                       │
│ 7 projects have stalled tasks                             │
│ ACQ — 4 stalled tasks, the oldest for 12 days (waiting    │
│       for an answer to Claude)                            │
│ AUD — 3 stalled tasks, the oldest for 10 days (no one     │
│       assigned)                                           │
│ MKX — 2 stalled tasks, the oldest for 9 days (no changes) │
│ OLV — 2 stalled tasks, the oldest for 8 days (blocked by  │
│       OLV-9)                                              │
│ BRN — 1 stalled task, for 7 days (no changes)             │
│ and 2 more · open the list                                │
│ ┊ Hypothesis · MKX-12 may have fallen out of planning:    │
│ ┊ it has no week                                          │
│ ▸ Details                                                 │
│ ROBERTA FONTANA                                           │
│ ░ archive the projects with no activity for 3 months     ░│
│ Claude · 10:43                                            │
│ 3 projects have had no activity for 3 months:             │
│ ┌ ● Claude proposes · 3 changes ────────────────────────┐ │
│ │ ☑ Archive ORT Orto Social                             │ │
│ │   last activity: Jul 24                               │ │
│ │ ☑ Archive SPZ Spazio Arredo                           │ │
│ │   last activity: Jul 2                                │ │
│ │ ☑ Archive LNT Lanterna                                │ │
│ │   last activity: Jun 26                               │ │
│ │                    [Cancel] [Confirm all 3]           │ │
│ └───────────────────────────────────────────────────────┘ │
│ ◉ BSC has Claude working on BSC-3: it can be archived     │
│   when that ends                                          │
```

```
1024 ── riquadro 360px, Laura, S5 bloccata ─────────
│ LAURA COSTA · on ACQ                               │
│ ░ add Luca to ACQ as Admin                        ░│
│ (CL) Claude · 11:02                                │
│ Luca Bianchi is already in Stubwise, so there's no │
│ invite to send.                                    │
│ ┌ ● Claude proposes · 1 change ──────────────────┐ │
│ │ Add Luca Bianchi to ACQ as Admin               │ │
│ │ (bell) Notifies Luca Bianchi                   │ │
│ │ ⊘ You can't give the Admin role in ACQ: it has │ │
│ │   permissions you don't have there.            │ │
│ │                        [Cancel] [Confirm]░░░   │ │
│ └────────────────────────────────────────────────┘ │
```

## 4. Ambito e confini

- **Dentro**: le risposte di S0, S2, S3 e del dato che manca; la scheda di
  scelta nella libera; la scheda in blocco di S4 con le righe a parte; S5
  con tutte le sue strade e la scheda bloccata; la notifica
  `member.added`; le righe delle azioni della pagina e del filtro salvato.
- **Fuori**: S1 e la prova (`claude-automations.md`); le bozze e la riga
  `draft` (`claude-drafts.md`); i suggerimenti (`claude-suggestions.md`);
  la riga eseguita, «Undo» e la scheda C già fatte nel 10a.
- **Anti-obiettivi**:
  - un numero, un codice, un nome o un «di più» che conti l'invisibile,
    nel testo, nella scheda, nelle righe a parte o nel «Who?»;
  - un'ipotesi nella prima riga, o scritta come una riga dell'elenco;
  - un elenco di 8 righe senza «and 3 more»;
  - una frase plausibile al posto della risposta onesta;
  - una persona «consigliata» in una scelta;
  - un link d'invito o un token nel testo, negli eventi o nell'indirizzo;
  - un «Edit» nelle schede del 10b;
  - un toast per un'azione della pagina.

## 5. Stati e intervalli

- **Elenchi**: 0, 1, 2–5, oltre 5 (8 nei test). Righe fino a ~120
  caratteri in it, a capo a parole.
- **Scheda in blocco**: da 1 a ~20 progetti; con 20, 5 righe e «Show 15
  more». Righe a parte: 0, 1, 2 (una per tipo, più una per ogni progetto
  `busy`, fino a 5, poi «and N more busy» / «e altri N con lavoro in
  corso» senza codici).
- **Scheda di scelta**: 2–8 opzioni; oltre 8, la lista scorre dentro la
  scheda con altezza massima 320px. Una sola opzione: niente scheda, la si
  usa e la riga di Claude lo dice («I used Support, the only department
  that sees ACQ.»).
- **Caricamento**: le risposte arrivano con lo stream di `data/stream.ts`;
  l'elenco cresce riga per riga, «Hypothesis» e «Details» arrivano per
  ultimi.
- **Istanza vuota**: S0 risponde; S2 «No project has stalled tasks»; S3
  `none` o i totali a zero («We've spent $0 on AI this month.»).
- **Vedi come**: cambiando persona il riquadro rinasce (10a); una scheda
  di scelta aperta di Giulia non è nel DOM di Sara.
- **Coda in pausa, budget esaurito**: come nel 10a (il budget ferma il
  riquadro; la coda no).

## 6. Interazione e layout

- **1440, riquadro 400px**: elenchi su una o due linee, la scheda con i
  bottoni a destra; righe a parte a tutta larghezza.
- **1440, destinazione a pagina intera** (colonna ≤ 720px): le righe
  dell'elenco stanno su una linea; la scheda come sopra.
- **1024, riquadro 360px**: il fatto va a capo sotto il codice, rientrato;
  nella scheda il `why` resta sotto la sua riga; i bottoni vanno a capo
  col primario per ultimo a destra (area 3). La scheda di scelta resta a
  tutta larghezza.
- **Tastiera**: nella scheda in blocco Tab passa per le caselle, «Show 3
  more», poi i bottoni; Spazio spunta. Nella scheda di scelta ↑/↓ fra le
  opzioni, Invio sceglie. In `CapabilitiesList` ↑/↓ fra le righe, Invio
  scrive.
- **Annunci**: la prima riga di una risposta finita `polite`; una scheda
  che chiede a me `assertive` (area 3); «Undone» `polite`.
- **Movimento**: dissolvenza 150ms degli eventi; «Show 3 more» apre senza
  animazione d'altezza oltre 150ms; nulla con movimento ridotto.

## 7. Vincoli

- **Dove compare «Who?»**:
  - S3 `projects` («The total is visible to people who can see usage ·
    Who?», `who:seeUsage`, d'istanza) e `none`;
  - S4, la riga dei non gestibili (`manageProjectSettings`, per progetto);
  - S5 e le altre richieste rifiutate per permesso («You can't add members
    to ACQ · Who?», `manageMembers`);
  - **non** nella scheda bloccata da `escalation`, nelle righe `busy`,
    nella scheda di scelta, nella risposta onesta, nelle azioni della
    pagina.
- **Dove compare +R**: solo S5 (`addMember` alla conferma, `removeMember`
  all'«Undo» con la grazia scaduta), con la riconferma sopra il riquadro
  (10a). Archiviare non è +R. Le azioni della pagina e il filtro salvato
  no.
- **Voci del registro delle modifiche**:
  - S4: una voce per progetto, «**Claude on behalf of Roberta Fontana**
    archived **ORT**.» / «**Claude per conto di Roberta Fontana** ha
    archiviato **ORT**.»; l'«Undo» scrive una `project.reopened` per
    progetto, con «Undid: …» (`claude-trace.md`);
  - S5: «**Claude on behalf of Laura Costa** added Luca Bianchi to **ACQ**
    as Developer.» / «**Claude per conto di Laura Costa** ha aggiunto Luca
    Bianchi ad **ACQ** come Developer.» (`member.added`); l'«Undo» scrive
    `member.removed` con «Undid: …»;
  - filtro salvato, lingua, tema: **nessuna voce**, come a mano;
  - S0, S2, S3 e la scheda di scelta: nessuna (sono letture e una scelta
    della conversazione). Nessuna voce del registro decisioni.
- Si leggono `say`, `aside`, `capabilities`, `notes`, `blocked`, `why`,
  `resume`, `undo[groupId]`; mai `can()` né `viewer` nei file di
  `pages/claude/conversation/`.
- Testi en/it con parità; cifre tabellari per codici, date, somme e
  conteggi; nessun monospace.

## Scelte del brief (scelte del controller, da confermare)

1. **[SC 1]** Le risposte sui dati sono testo con righe di catalogo, non
   una scheda.
2. **[SC 2]** «Hypothesis»: filetto tratteggiato + parola, e la deduzione
   cita il codice su cui ragiona (la riga del piano non lo diceva).
3. **[SC 3]** «Details» di S2 con la soglia di un progetto, o la frase
   «le soglie cambiano» quando differiscono.
4. **[SC 4]** S3 senza percentuale del budget nella prima riga.
5. **[SC 5]** Le etichette delle sette voci di S0 e le loro frasi.
6. **[SC 6]** Le frasi di S0 non nominano oggetti del seme: segnaposti fra
   parentesi quadre, il primo selezionato, il progetto dal chip.
7. **[SC 7]** Nella Chat l'elenco di S0 senza bottoni e senza frasi.
8. **[SC 8]** Nessun «Other…» nella scheda di scelta della libera.
9. **[SC 9]** Una persona non è mai «consigliata».
10. **[SC 10]** In it «Mostra altri 3» per i progetti (accordo col nome),
    «altre» per le task. Costo se sbagliata: una chiave.
11. **[SC 11]** «Who?» dei non gestibili per progetto, con un menu dei
    codici visibili quando sono più d'uno. Serve che la nota porti i
    codici visibili oltre al numero (campo facoltativo `codes` su
    `not_manageable`, cambio additivo al Task 7).
12. **[SC 12]** L'Undo di gruppo di S4 riusa le chiavi del 10a («Undo all
    3» / «Annulla tutte e 3 le azioni»): nessuna frase nuova.
13. **[SC 13]** Nessun pronome per la persona aggiunta.
14. **[SC 14]** La scheda bloccata non ha «Who?».
15. **[SC 15]** Il ruolo eliminato si legge «un ruolo che non esiste più».
16. **[SC 16]** Dopo l'annullamento il codice del progetto nella notifica
    di Luca non è più un link.

## Scelte confermate (2 nov 2026)

1. **[SC 5]** *(confermata dal maintainer il 2 nov 2026)*: l'elenco «so fare
   queste cose» ha **nove** voci: le sette del piano più `mailBody` (email
   e risposte nella Posta) e `taskDescription` (descrizione di una task).
2. **[SC 11]** *(confermata dal maintainer il 2 nov 2026)*: la nota
   `not_manageable` porta il campo facoltativo `codes` con i soli codici
   visibili a chi chiede; il numero resta `count`.
3. Le altre scelte di questo brief sono approvate col brief.
