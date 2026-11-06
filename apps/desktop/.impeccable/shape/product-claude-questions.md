# Shape brief — Le domande di Claude, la prima versione e la riga dell'attesa

> Shape scritto dal costruttore senza intervista (6 nov 2026), dalla spec
> dell'area 11 («La regola di Claude», «Prima versione da Claude»,
> «Commenti», «Stati», decisioni 1, 6, 9, 10), dal piano 11b (Global
> Constraints «Le domande», «Il budget», «Classi del riquadro»; Task 4, 6,
> 10, 11; decisioni Q1 e Q2 del 6 nov 2026) e dagli shape
> `product-space.md`, `product-comments-history.md`, `claude-panel.md`,
> `claude-actions.md`, `home.md`, che **non riscrive**. Ogni scelta che non
> viene dal maintainer è marcata *(scelta del costruttore)*; le regole sono
> numerate **[PQ n]**. Il segno, la fonte (`SourceLine`) e la cronologia
> sono in `product-claude-mark.md`. Le domande aperte sono in fondo.

Superficie:
- `pages/productDocs/comments/QuestionThread.tsx` (e `CommentsColumn`, che
  lo ospita fra i fili);
- `pages/home/blocks/ClaudeDecisionItem.tsx` — il ramo `productQuestion`;
- `notifications/NotificationItem.tsx` — `composedOf` per
  `product_doc.question`;
- `pages/productDocs/ProductIndex.tsx` (`EmptySpace`), `claude/
  {FirstVersionDialog,FirstVersionProgress,FirstVersionBanner,
  ClaudeWaitingLine}.tsx`, `ProductSpace.tsx`;
- il riquadro di Claude: la riga «N questions to close».

Piano 11b: Task 4 e 6 (dati), Task 10 e 11 (UI). Mondo: «Catalogo
numerato», modalità **Operate**; la frase proposta e il prima e dopo sono
**Read**. VRD resta **vuoto** nel seme (Q2): gli scatti della prima
versione si fanno dopo averla lanciata. Nomi del seme: **Laura Costa** (il
piano scrive «Laura Conti»).

## 1. Lavoro e pubblico

- **Laura Costa** (`docs.edit` in ACQ e VRD): in VRD, progetto nuovo senza
  pagine, vuole partire dalle email e dalle note del kickoff invece che da
  un foglio bianco. In ACQ riceve le domande di Claude e le chiude in un
  gesto, dalla pagina o dalla Home.
- **Marco Bellini** risponde a una domanda prima di Laura.
- **Sara Montanari** (solo lettura) vede le domande aperte ma non risponde.
- Stato d'animo: Claude non deve decidere al posto suo. Una domanda è
  benvenuta se è chiara e si chiude in un clic; una prima versione è
  benvenuta se si può buttare tutta insieme.

## 2. Esito e prova

- **Successo**:
  - in «Bills» il filo di Claude accanto a «Bills are sent on the 1st»:
    la fonte («From a meeting of Laura Costa · Nov 3»), la domanda, il
    prima e dopo, **Update it** · **Leave it as is** · **Open a request**;
    Laura preme «Update it»: la frase cambia, il filo passa fra i risolti
    con «Answered by Laura Costa: Update it», in cronologia «Laura Costa,
    from Claude's question», nessun segno;
  - la stessa domanda è in «Decide» nella Home di Laura e sparisce quando
    risponde (da lì o dalla pagina);
  - Marco risponde dopo Laura: «Laura Costa answered first: Update it», e
    il filo si ricarica;
  - in VRD vuoto la prima strada è **Write the first version with
    Claude**; Laura sceglie un'email e incolla le note, **Write the first
    version**: le pagine compaiono una per una, poi ogni pagina ha in cima
    «First version written by Claude from: …» con **Accept** e **Undo the
    first version**;
  - col budget finito, in cima allo spazio di ACQ: «Claude will resume
    updating the doc when the budget is back · 2 updates waiting».
- **Verità del prodotto**:
  - **Claude consiglia, la persona sceglie**: una delle tre risposte è
    «Recommended» / «Consigliata» come nelle domande sui task *(maintainer,
    6 nov 2026)*, ma nulla cambia finché una persona non preme; la frase
    proposta è quella del fatto, parola per parola (anti-obiettivo
    «decisioni inventate»);
  - **una domanda ha una sola risposta**: `alreadyAnswered` per il secondo;
  - **la prima versione si butta tutta o niente**, finché nessuno l'ha
    toccata (decisione 9).

## 3. Direzione scelta

- **Tesi**: **una domanda è un commento con le risposte già scritte**. Sta
  nella stessa colonna dei commenti, nella stessa forma di filo, ancorata
  alla frase in dubbio; si distingue per l'autore (Claude) e per i tre
  bottoni, non per un colore o un riquadro diverso. La prima versione è
  **un lavoro con un inizio, un avanzamento e una firma in cima a ogni
  pagina**, che si toglie quando la si accetta **[PQ 1]**.

### 3.1 Il filo-domanda nella colonna (`QuestionThread`)

- **Posto**: fra i fili aperti, nell'ordine delle ancore ([PC 5]), allineato
  al suo blocco; il glifo del blocco ([PC 6]) conta anche le domande. Una
  domanda su un blocco poi cancellato va fra i «Sentence deleted» come ogni
  filo.
- **Il filo** (bordo 1px `rule`, raggio 8, padding 12, come [PC 5])
  **[PQ 2]**:
  1. la **frase citata** del blocco, 12/16 `ink-muted` fra virgolette;
  2. la **radice**: avatar di Claude 20px · «Claude» 13 600 · ora 12
     `ink-faint` tnum; a destra **nessun** «Resolve» (la domanda si chiude
     rispondendo);
  3. la **fonte** (`SourceLine`), 12px;
  4. **la domanda**, 14/20 `ink`, da un template per ragione (§3.2);
  5. **il prima e dopo** quando c'è `apply`: «Now» / «Ora» 12 600
     `ink-muted` e la frase com'è, 13/18 `ink-muted`; «Proposed» /
     «Proposta» e la frase del fatto, 13/18 `ink`, coi segni (`RichView`).
     Per la divergenza le etichette sono «The page says» / «La pagina dice»
     e «Was built» / «È stato fatto»;
  6. **le risposte**, una fila di bottoni che va a capo (la colonna è 296):
     **Update it** / **Aggiorna così** · **Leave it as is** / **Lascia
     com'è** · **Open a request** / **Apri una richiesta**, tutti e tre
     secondari piccoli, **della stessa misura**. Un bottone c'è solo se la
     sua strada c'è (`apply`, `request` non nulli); «Leave it as is» c'è
     sempre. **La risposta consigliata** (§3.2b) va **per prima** e ha il
     trattamento di `ClaudeAnswers` (`recommended`): bordo ink 60% e, nel
     bottone accanto al nome, «Recommended» / «Consigliata» 12px 600
     `ink-muted` *(maintainer, 6 nov 2026)*; le altre seguono nell'ordine
     Update it · Leave it as is · Open a request;
  7. le **risposte scritte** delle persone e «Reply…», come ogni filo:
     si può discutere prima di scegliere, con le @menzioni. Claude non
     risponde ai commenti *(scelta del costruttore: nel prototipo non c'è un
     modello; nel prodotto vero resta una scelta da fare)*.
- **Nome accessibile** del filo (`article`): «Claude's question on “Bills
  are sent on the 1st”» / «Domanda di Claude su «Bills are sent on the
  1st»»; il gruppo dei bottoni: «Answers to Claude's question» / «Risposte
  alla domanda di Claude».

### 3.2 Le domande, per ragione

La frase proposta (`{{apply}}`) è il testo del fatto, **mai** una citazione
dell'email; il nome è quello del titolare o di chi ha scritto la frase
**[PQ 3]**:

| Ragione | en | it |
|---|---|---|
| `vague` | The source isn't clear on this. Should the page say this? | La fonte non è chiara su questo. La pagina deve dire così? |
| `contradicts` | The source says something different from the page. Should I update it? | La fonte dice altro rispetto alla pagina. La aggiorno? |
| `contradicts_person` | The source says something different from what Marco Bellini wrote. Should I update it? | La fonte dice altro rispetto a ciò che ha scritto Marco Bellini. La aggiorno? |
| `diverges` | ACQ-14 was built differently from what the page says. Should I update the page, or open a request? | ACQ-14 è stata fatta diversamente da come dice la pagina. Aggiorno la pagina o apro una richiesta? |
| `no_permission` | This came from Sara Montanari, who can't edit the Docs, so I didn't change the page. Should it say this? | Viene da Sara Montanari, che non può modificare i Docs, quindi non ho cambiato la pagina. Deve dire così? |

- Il codice della task nella divergenza è un `CodeLink` (tenue se
  invisibile, senza nome).

### 3.2b La risposta consigliata

Claude consiglia **una** delle tre risposte *(maintainer, 6 nov 2026)*. Il
consiglio sta nel dato della domanda (`question.recommended`, facoltativo:
«apply» · «keep» · «request», da aggiungere nel Task 4); lo leggono il filo
e la Home, e la pagina non lo ricalcola **[PQ 12]**:

| Ragione | Consigliata |
|---|---|
| `vague` | **Leave it as is**; **Update it** solo se la fonte sostiene la frase proposta (lo dice il fatto del seme) *(maintainer)* |
| `diverges` (task chiusa) | la decide il seme, domanda per domanda *(maintainer)* |
| `contradicts` (una decisione del registro, o una fonte chiara, contro testo non scritto da una persona) | **Update it** *(scelta del costruttore)* |
| `contradicts_person` | **Leave it as is**: il testo di una persona non si scavalca su consiglio di Claude *(scelta del costruttore)* |
| `no_permission` | **Update it** se il fatto è chiaro, **Leave it as is** se è vago *(scelta del costruttore)* |

- Un consiglio senza la sua strada (consigliata «apply» con `apply` nullo)
  non si mostra: nessun bottone è segnato.
- Con «Update it» spento per `changed_after`, «Recommended» resta sul
  bottone spento: il consiglio era per la frase di prima, e la frase sotto
  lo spiega.
- Senza `recommended` (fixture vecchie) nessun bottone è segnato.

### 3.3 Rispondere

- **Update it** **[PQ 4]**: la frase cambia (una revisione `answer` di chi
  risponde, decisione 6), il filo si chiude in 150ms e va fra i risolti con
  la riga 12px `ink-muted` «Answered by Laura Costa: Update it» / «Ha
  risposto Laura Costa: Aggiorna così». Annuncio `polite` «Answered · the
  sentence is updated» / «Risposto · la frase è aggiornata». **Fuoco**: al
  blocco aggiornato (il gruppo `BlockShell`), che resta col filo attivo
  tinto finché non si sposta il fuoco *(scelta del costruttore: chi
  risponde vuole vedere la frase nuova)*.
- **Leave it as is**: nessuna revisione; il filo va fra i risolti con
  «Answered by Laura Costa: Leave it as is». Fuoco al filo successivo, o a
  «N resolved» se non ce n'è, come «Resolve» ([PC 13]).
- **Open a request**: apre il riquadro di Claude con la **scheda B** di
  `createRequest` (titolo e descrizione del fatto, `origin.product_doc`),
  e il fuoco va al titolo della scheda nel riquadro. Il filo resta aperto
  e mostra 12px `ink-muted` «A request is being prepared in Claude's
  panel» / «Una richiesta è in preparazione nel riquadro di Claude» finché
  la scheda è aperta. Confermata: il filo si chiude con «Answered by Laura
  Costa: Open a request · **ACQ-R14**» (`CodeLink`). Annullata: la riga
  sparisce, il filo resta aperto. Senza il permesso del backlog la scheda
  è quella di oggi col suo blocco e il suo «Who?» (area 2): il bottone nel
  filo non si spegne.
- **Doppio clic**: il primo clic spegne i tre bottoni («Answering…» /
  «Rispondo…» sul bottone premuto); un secondo arriva ad
  `alreadyAnswered` e non scrive.
- **Stati spenti e rifiuti** (frase 12px `ink-muted` sotto i bottoni,
  `aria-describedby`):
  - **Update it** con `changed_after` (la frase è cambiata dopo la
    domanda): spento, «The sentence changed after the question: **Marco
    Bellini** edited it» / «La frase è cambiata dopo la domanda: l'ha
    modificata **Marco Bellini**» (il nome è il link alla persona, nessun
    `WhoCanLink`); «Leave it as is» e «Open a request» restano;
  - **`alreadyAnswered`** (Marco dopo Laura, o un secondo clic): niente
    cambia; al posto dei bottoni «Laura Costa answered first: Update it» /
    «Laura Costa ha risposto prima: Aggiorna così», poi il filo si ricarica
    risolto; il fuoco va al filo (contenitore `tabIndex=-1`);
  - **`forbidden`** (permesso perso fra lettura e clic): «You can no
    longer answer in ACQ. · Who?» / «Non puoi più rispondere in ACQ. ·
    Chi?» (`editDocs`);
  - **errore**: «Couldn't send the answer · Retry» / «Risposta non inviata
    · Riprova», `role="alert"`, il fuoco resta sul bottone.
- **Chi legge soltanto** (Sara): il filo si legge intero (fonte, domanda,
  prima e dopo); **nessun** bottone e nessuna casella; al loro posto
  «Answering is for people with Edit docs in ACQ · Who?» / «Rispondere è di
  chi ha Modifica Docs in ACQ · Chi?» (`WhoCanLink`, `editDocs`). La riga di
  sola lettura in testa alla colonna ([PC 8]) resta.

```
1440 · «Bills» (Laura), colonna dei commenti agganciata 296 ──────────────────────────────────
│ … │   Bills                                          │ COMMENTS 2                      × │
│   │   Bills are sent on the 1st of each month.  ▢1   │┌ “Bills are sent on the 1st…” ──┐ │
│   │   …                                              ││ (CL) Claude · Nov 3            │ │
│   │                                                  ││ From a meeting of Laura Costa ·│ │
│   │                                                  ││ Nov 3                          │ │
│   │                                                  ││ The source isn't clear on this.│ │
│   │                                                  ││ Should the page say this?      │ │
│   │                                                  ││ Now                            │ │
│   │                                                  ││ Bills are sent on the 1st…     │ │
│   │                                                  ││ Proposed                       │ │
│   │                                                  ││ Bills are sent on the 5th…     │ │
│   │                                                  ││ [Update it] [Leave it as is]   │ │
│   │                                                  ││ Open a request                 │ │
│   │                                                  ││ [Reply…]                       │ │
│   │                                                  │└────────────────────────────────┘ │
```

### 3.4 La domanda in Home «Decide»

- Una voce `ClaudeDecision` di tipo `productQuestion`, **nella cornice delle
  domande di Claude sui task** (`ClaudeDecisionItem`, `Shell`) **[PQ 5]**:
  - testata: avatar di Claude · «Claude asks» / «Claude chiede» · tempo
    relativo;
  - la domanda (§3.2), 2 righe al più, intera nel `title`;
  - la riga 12px della fonte (`SourceLine`) e, con `apply`, una riga 13px
    `ink-muted`: «Proposed: “Bills are sent on the 5th…”» / «Proposta:
    «Bills are sent on the 5th…»», una riga con ellissi;
  - l'oggetto: **ACQ-D6** Bills (codice tnum 600 + titolo), che porta alla
    pagina con `?comment=<id>`;
  - le risposte: gli stessi tre bottoni del filo, nello stesso ordine e con
    **la stessa risposta consigliata** del filo («Recommended», la resa di
    `ClaudeAnswers`), senza «Other…».
- **Update it** parte **subito**: niente finestra dell'«Undo» di «Decide»
  (piano, Task 10, *scelta del costruttore*). La voce si chiude in 200ms e
  il toast dice «Updated ACQ-D6 · Bills. To undo it, open the page
  history.» / «Aggiornata ACQ-D6 · Bills. Per annullarla, apri la
  cronologia della pagina.» con l'azione **Open history** / **Apri la
  cronologia** (`?history=<revisione>`).
- **Leave it as is** segue la finestra dell'«Undo» di 5 s come le altre
  risposte di «Decide» (non scrive niente finché non scade): toast
  «Answered on ACQ-D6 · Undo».
- **Open a request** apre il riquadro con la scheda B, fuoco nella scheda;
  la voce resta in «Decide» finché la richiesta non è confermata.
- **Fuoco** dopo che la voce si chiude: la voce successiva di «Decide», o il
  titolo del blocco «Decide» se era l'ultima. Mai il body.
- `alreadyAnswered`: toast «Already answered by Laura Costa.» (la chiave di
  oggi), la voce sparisce. Senza `docs.edit` o senza vedere la pagina la
  voce **non c'è** (Sara).

### 3.5 La card `product_doc.question`

- **Riga del codice**: **ACQ-D6** · «Product» / «Prodotto» · ora.
- **Titolo**: «Claude asks about ACQ-D6 · Bills» / «Claude chiede su ACQ-D6
  · Bills» (a lettura).
- **Corpo**: la domanda (§3.2) e, sotto, la fonte nella forma di chi
  riceve; 2 righe al più.
- **Nessun bottone** (Q1): il clic apre la pagina con `?comment=<id>` — la
  colonna si apre (a 1024 sovrapposta: è un gesto), il blocco scorre in
  vista, il fuoco va sul filo. Risposta già data: il filo si apre fra i
  risolti, e la card mostra 12px `ink-muted` «Answered by Laura Costa» /
  «Ha risposto Laura Costa» (derivato a lettura).
- **`objectGone`**: titolo «A question from Claude» / «Una domanda di
  Claude», corpo «This page is no longer available.», nessun codice né
  link. Fixture senza `productQuestion`: lo stesso.

### 3.6 La prima versione

**Lo spazio vuoto** (`EmptySpace`, [PS 15]) **[PQ 6]**:
- Chi scrive (Laura): le strade sono due righe 44px con filetto; **per
  prima** «Write the first version with Claude» / «Scrivi la prima
  versione con Claude» — a sinistra l'anello fermo 16px, il titolo 14 500,
  sotto 12px `ink-muted` «Claude drafts the pages from the emails, meetings,
  notes and files you choose. Anything unclear becomes a question.» /
  «Claude scrive le pagine dalle email, riunioni, note e file che scegli.
  Ciò che non è chiaro diventa una domanda.»; poi «Start from a blank
  page» com'è.
- **Spenta** (`aria-disabled`, la frase sotto al posto della descrizione):
  - budget finito: la frase del riquadro di oggi ([CP 12]) «The monthly AI
    budget is used up: Claude can't answer until it's raised or the month
    ends. · Who?» (`manageSettings`, d'istanza);
  - prima versione già in corso (lanciata da un altro): la riga non c'è,
    c'è l'avanzamento (sotto).
- **Chi legge soltanto** (Sara): sotto la frase «When someone writes the
  first page, it shows up here.» la sola riga «Write the first version with
  Claude», spenta, con «Writing the first version is for people with Edit
  docs in VRD · Who?» / «Scrivere la prima versione è di chi ha Modifica
  Docs in VRD · Chi?». «Start from a blank page» resta assente *(scelta del
  costruttore: il piano chiede la riga spenta col «Who?» per Sara; emenda
  [PS 15] solo per questa riga, perché qui c'è qualcosa da chiedere a
  qualcuno)*.

**La finestra delle fonti** (`FirstVersionDialog`) **[PQ 7]**:
- Dialogo modale 560px, raggio 12, `rule-strong`, scrim; titolo 20px «Write
  the first version with Claude»; frase 13px `ink-muted`: «Choose what
  Claude reads. It writes only what the sources say clearly; anything
  unclear becomes a question on the sentence.» / «Scegli cosa legge
  Claude. Scrive solo ciò che le fonti dicono chiaramente; ciò che non è
  chiaro diventa una domanda sulla frase.».
- **Quattro gruppi** (`heading-group`), ognuno con le sue righe 36px a
  casella:
  - **EMAILS** / **EMAIL**: le email del progetto che **chi chiede apre**
    (`firstVersionSourcesFor`): mittente 600 · oggetto · data 12px faint.
    Vuoto: «No emails in VRD that you can open» / «Nessuna email di VRD che
    puoi aprire»;
  - **MEETINGS** / **RIUNIONI**: titolo · data · «transcript» /
    «trascrizione» 12px faint se c'è. Vuoto: «No meetings in VRD» /
    «Nessuna riunione di VRD»;
  - **PASTED TEXT** / **TESTO INCOLLATO**: area di testo 4 righe che
    cresce, segnaposto «Paste notes, a brief or minutes…» / «Incolla note,
    un brief o un verbale…»;
  - **DRIVE FILES** / **FILE DEL DRIVE**: codice tnum · nome · tipo 12px.
    Vuoto: «No files in VRD's Drive yet».
  - Oltre 6 righe un gruppo scorre dentro sé (altezza massima 216).
- **Nota sulla riservatezza**, 12px `ink-muted` sopra i bottoni, sempre:
  «Everyone who reads VRD's docs will read what Claude writes from these
  sources. The emails themselves stay visible only to the people who
  received them.» / «Chi legge i Docs di VRD leggerà ciò che Claude scrive
  da queste fonti. Le email restano visibili solo a chi le ha ricevute.»
  (decisione 1, detta prima di partire).
- **Bottoni**: a sinistra «3 sources» / «3 fonti» 12px tnum; a destra
  Cancel · **Write the first version** / **Scrivi la prima versione**
  (primario).
  - Nessuna fonte (nessuna casella e testo vuoto): spento, con la frase
    sotto «Choose at least one source, or paste some text.» / «Scegli
    almeno una fonte, o incolla del testo.»;
  - in corso: «Starting…» / «Avvio…», tutto spento.
- **Rifiuti** (riga `role="alert"` sopra i bottoni, la finestra resta):
  - `space_not_empty`: «Someone added a page in the meantime: the first
    version starts only in an empty space.» / «Nel frattempo qualcuno ha
    aggiunto una pagina: la prima versione parte solo in uno spazio
    vuoto.» · **Close** (chiude e ricarica l'indice);
  - `ai_blocked`: la frase del budget col «Who?»;
  - `forbidden`: «You can no longer edit the docs in VRD. · Who?»;
  - errore: «Couldn't start · Retry» / «Avvio non riuscito · Riprova».
- **Tastiera**: il fuoco entra sulla prima casella; Tab nell'ordine dei
  gruppi; Esc chiude e il **fuoco torna** alla riga «Write the first
  version with Claude». Avviata, la finestra si chiude e il fuoco va al
  titolo dell'avanzamento.
- **1024**: 560 di larghezza (sta nella finestra), altezza al più 80vh con
  i gruppi che scorrono e i bottoni sempre a vista in fondo.

**L'avanzamento** (`FirstVersionProgress`) **[PQ 8]**:
- Al posto dello stato vuoto, nell'indice: titolo 20px «Claude is writing
  the first version» / «Claude sta scrivendo la prima versione» con
  l'anello che **pulsa** («Claude working»); riga 13px `ink-muted` «3 of 10
  pages · for Laura Costa» / «3 di 10 pagine · per Laura Costa» (tnum).
- Sotto, l'elenco delle pagine in righe 32px nell'ordine dell'albero:
  scritta → ✓ ink · codice · titolo (link); in scrittura → l'anello che
  pulsa · titolo · «writing…» / «sto scrivendo…» 12px; in attesa → titolo
  `ink-faint`. Le pagine scritte entrano anche nell'albero, una per una.
- Lo vedono **tutti** quelli che leggono lo spazio (Sara compresa): è lo
  stato dello spazio. Nessun bottone «Stop» *(scelta del costruttore: il
  piano non lo prevede; si annulla tutto alla fine)*.
- **Fine**: titolo «Claude wrote the first version» / «Claude ha scritto la
  prima versione», riga «10 pages · 3 questions to close» / «10 pagine · 3
  domande da chiudere» e **Open the first page** / **Apri la prima
  pagina**; dalla visita successiva l'indice torna normale. Annuncio
  `polite` a ogni pagina («Sign-up written» / «Scritta Iscrizione») e alla
  fine; il fuoco **non** si sposta da solo.
- Copione interrotto (pagina eliminata, store cambiato): l'elenco si ferma
  dov'è, senza errore; le pagine scritte restano con la riga in cima.
- **Movimento ridotto**: l'anello non pulsa; la parola «writing…» porta lo
  stato.

**La riga in cima alla pagina** (`FirstVersionBanner`) **[PQ 9]**:
- Sotto la riga meta della testata (dove sta [PS 16] per chi legge; per chi
  legge soltanto le due righe si seguono: prima questa, poi la sola
  lettura). 13px, filetto `rule` sopra e sotto, 8px di respiro:
  - l'anello fermo 12px · «First version written by Claude on behalf of
    Laura Costa, from: an email of Laura Costa · Nov 2, pasted text,
    **VRD-F1** Brief» / «Prima versione scritta da Claude per conto di
    Laura Costa, da: un'email di Laura Costa · 2 nov, testo incollato,
    **VRD-F1** Brief» (le fonti con `SourceLine` in forma breve, al più 2,
    poi «+N» col `title`);
  - le azioni, a sinistra sotto la frase: **Accept** / **Accetta**
    (secondario piccolo, solo questa pagina) · **Undo the first version** /
    **Annulla la prima versione** (bottone testo `critical`, tutto lo
    spazio).
- **Accept**: la riga sparisce da **questa** pagina per tutti; annuncio
  `polite` «Accepted» / «Accettata»; fuoco all'h1 della pagina
  (`tabIndex=-1`).
- **Undo the first version**: il dialogo «Undo the first version?» /
  «Annullare la prima versione?», corpo «All 10 pages Claude wrote are
  removed, with their comments and questions. Their codes aren't reused.
  This can't be undone.» / «Le 10 pagine scritte da Claude vengono tolte,
  con i commenti e le domande. I loro codici non si riusano. Non si può
  annullare.» · Cancel · **Undo the first version** (critico). In corso
  «Undoing…». Fatto: l'indice vuoto con le due strade, fuoco sulla riga
  «Write the first version with Claude». Cancel/Esc: fuoco di nuovo sul
  bottone.
- **Spento** dopo un tocco: «Undo the first version» con `aria-disabled` e
  sotto «**Marco Bellini** edited “Bills” afterwards» / «**Marco Bellini**
  ha modificato «Bills» dopo» (nome link alla persona, il titolo link alla
  pagina); senza `byId` «A page was edited afterwards». Accept resta.
- **Chi legge soltanto**: la frase senza bottoni e, sotto, «Accepting or
  undoing it is for people with Edit docs in VRD · Who?» / «Accettarla o
  annullarla è di chi ha Modifica Docs in VRD · Chi?».
- Accettata su tutte le pagine: nessuna riga più; la cronologia tiene la
  riga `first_version` ([PM 7]).

### 3.7 «N questions to close» nel riquadro di Claude

- Nel riquadro (`claude-panel.md`), **sotto la riga del chip**, quando il
  chip è una pagina o lo spazio Prodotto di un progetto con domande aperte
  che chi guarda può chiudere (`openProductQuestions`): una riga 36px con
  filetto sotto, 13px: «3 questions to close in VRD's docs» / «3 domande da
  chiudere nei Docs di VRD» e ▸ **[PQ 10]** *(scelta del costruttore: lì il
  contesto è già la doc; non entra nella conversazione come messaggio)*.
- Aperta (`aria-expanded`): al più 5 righe 32px — codice tnum · titolo
  della pagina · la frase citata 12px faint con ellissi — poi «Show all 8»
  / «Mostra tutte e 8». Clic: la pagina con `?comment=<id>`; il riquadro
  resta aperto.
- Zero domande, o chi non ha `docs.edit`: la riga non c'è.
- Lo chiede anche la conversazione: «what's left to answer in the doc?»
  risponde con lo stesso elenco (Task 8).

### 3.8 La riga dell'attesa in cima allo spazio (`ClaudeWaitingLine`)

- Quando ci sono fonti in attesa per questo progetto (budget finito o coda
  in pausa, area 9b): una riga **sotto la barra dello spazio**, a tutta
  larghezza (albero e lettura), 32px, fondo ink 5% come la fascia del
  budget ([CP 12]), filetto sotto, 13px `ink-muted` **[PQ 11]**:
  - budget: «Claude will resume updating the doc when the budget is back ·
    2 updates waiting · Who?» / «Claude riprenderà ad aggiornare la doc
    quando torna il budget · 2 aggiornamenti in attesa · Chi?»
    (`manageSettings`, d'istanza);
  - pausa: «Claude will resume updating the doc when Roberta Fontana
    resumes the queue · 2 updates waiting · Who?» / «Claude riprenderà ad
    aggiornare la doc quando Roberta Fontana riprende la coda · 2
    aggiornamenti in attesa · Chi?» (chi gestisce la coda);
  - entrambi: si dice il budget; quando torna e la coda è ancora in pausa,
    la riga passa alla frase della pausa (come «still waiting» del 9b).
- Senza fonti in attesa la riga **non c'è**, anche col budget finito
  *(scelta del costruttore: la riga spiega un ritardo, non annuncia il
  budget)*. Nessuna fonte è nominata (si contano soltanto). Non si chiude.
- La vedono tutti quelli che leggono lo spazio. Il simbolo è il segno
  d'attesa neutro (orologio 14px ink-muted), **non** ▲ `warning`: non è un
  errore della pagina.
- **1024**: va a capo su due righe al più; «Who?» resta in fondo alla frase.
- Al rilascio la riga sparisce (dissolvenza 150ms, zero con movimento
  ridotto) e arriva la card per pagina (`product-claude-mark.md` §3.7).

```
1440 · spazio di ACQ col budget finito ────────────────────────────────────────────────────────
│rail│ ACQ  │ Product  Features › Sign-in           Saved  Following  Comments  History  Export ▾ ⋯│
│    │      │ ◷ Claude will resume updating the doc when the budget is back · 2 updates waiting · Who?│
│    │      ├─────────────┬──────────────────────────────────────────────────────────────────────┤
│    │      │ PAGES 9     │   ACQ-D5 · Product                                                   │
```

```
1024 · VRD dopo la prima versione, «Overview» (Laura) ──────────────
│rail│ VRD        │ Pages  Product › Overview   Saved Following ⋯ │
│    │ …          ├───────────────────────────────────────────────┤
│    │            │   VRD-D1 · Product                            │
│    │            │   Overview                                    │
│    │            │   Updated Nov 6 by Laura Costa                │
│    │            │   ───────────────────────────────────────     │
│    │            │   ◌ First version written by Claude on behalf │
│    │            │   of Laura Costa, from: an email of Laura     │
│    │            │   Costa · Nov 2, pasted text +1               │
│    │            │   [Accept]  Undo the first version            │
│    │            │   ───────────────────────────────────────     │
```

## 4. Ambito e confini

- **Dentro**: il filo-domanda, le tre risposte e i loro stati, la voce in
  «Decide», la card `product_doc.question`, le due strade, la finestra delle
  fonti, l'avanzamento, la riga in cima alla pagina, «N questions to close»,
  la riga dell'attesa.
- **Fuori**: il segno e la cronologia (`product-claude-mark.md`); backlog e
  bozze (`product-claude-backlog.md`); le frasi del riquadro (Task 8).
- **Anti-obiettivi**:
  - la risposta consigliata applicata da sola, o la frase proposta
    presentata come già decisa;
  - una risposta consigliata diversa fra il filo e la Home;
  - bottoni di risposta nella card d'inbox (Q1);
  - una domanda che sparisce senza una risposta di una persona;
  - una prima versione che si annulla a pezzi, o dopo che qualcuno l'ha
    toccata;
  - un'email nella finestra delle fonti che chi chiede non può aprire;
  - un ▲ `warning` per un'attesa che non è un errore.

## 5. Stati e intervalli, 1440 e 1024

- **Volumi**: 0–20 domande aperte per pagina, 0–60 per spazio; frasi
  proposte fino a 600 caratteri (a capo nel filo, ellissi nella Home);
  prima versione 3–30 pagine, 0–40 fonti nella finestra.
- **1440 / 1200**: il filo nella colonna agganciata 296, che si apre da sola
  con fili aperti ([PC 14]); i bottoni del filo vanno a capo.
- **1024**: la colonna dei commenti è sovrapposta 360 e si apre **solo con
  un gesto** (il glifo del blocco, «Comments», la card, la Home, «N
  questions to close»); a 360 i tre bottoni stanno su due righe. Al più
  una colonna a destra: «See the question» dalla cronologia apre i
  commenti e chiude la cronologia, e «Open history» dalla Home apre la
  cronologia senza i commenti.
- **Caricamento**: il filo-domanda come gli altri (2 fili scheletro);
  la finestra delle fonti: 3 righe scheletro per gruppo. **Errore** di
  lettura delle fonti: dentro la finestra «Couldn't load the sources ·
  Retry».
- **Cambio di persona**: la finestra si chiude senza chiedere; fili e
  «Decide» si rileggono.

## 6. Tastiera e fuoco (riepilogo)

| Gesto | Dove va il fuoco |
|---|---|
| Update it (filo) | il blocco aggiornato |
| Leave it as is (filo) | il filo successivo, o «N resolved» |
| Open a request | il titolo della scheda nel riquadro; annullata, di nuovo il bottone nel filo |
| `alreadyAnswered` | il filo, ricaricato |
| risposta da «Decide» | la voce successiva, o il titolo di «Decide» |
| finestra: Esc / Cancel | la riga «Write the first version with Claude» |
| finestra: avvio | il titolo dell'avanzamento |
| Accept | l'h1 della pagina |
| Undo the first version, fatto | la riga «Write the first version with Claude» dell'indice vuoto |
| dialogo di conferma chiuso | il bottone «Undo the first version» |

Mai il body. Il gruppo dei bottoni del filo è un `group` con le frecce
←/→ fra i bottoni *(scelta del costruttore, come la barra della
selezione)*.

## 7. Movimento

- Filo che si chiude 150ms (altezza), voce di «Decide» 200ms, pagina
  nuova nell'albero in dissolvenza 150ms, anello che pulsa 1.8s.
- **Movimento ridotto**: nessuna di queste; l'anello è fermo.

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| risposte | Update it · Leave it as is · Open a request · Answering… | Aggiorna così · Lascia com'è · Apri una richiesta · Rispondo… |
| prima e dopo | Now · Proposed · The page says · Was built | Ora · Proposta · La pagina dice · È stato fatto |
| risposto | Answered by {{name}}: {{answer}} · {{name}} answered first: {{answer}} · A request is being prepared in Claude's panel | Ha risposto {{name}}: {{answer}} · {{name}} ha risposto prima: {{answer}} · Una richiesta è in preparazione nel riquadro di Claude |
| spento | The sentence changed after the question: {{name}} edited it · Answering is for people with Edit docs in {{code}} · You can no longer answer in {{code}}. | La frase è cambiata dopo la domanda: l'ha modificata {{name}} · Rispondere è di chi ha Modifica Docs in {{code}} · Non puoi più rispondere in {{code}}. |
| Home | Claude asks · Proposed: “{{text}}” · Updated {{code}} · {{title}}. To undo it, open the page history. · Open history | Claude chiede · Proposta: «{{text}}» · Aggiornata {{code}} · {{title}}. Per annullarla, apri la cronologia della pagina. · Apri la cronologia |
| card | Claude asks about {{code}} · {{title}} · A question from Claude · Answered by {{name}} | Claude chiede su {{code}} · {{title}} · Una domanda di Claude · Ha risposto {{name}} |
| strade | Write the first version with Claude · Claude drafts the pages from the emails, meetings, notes and files you choose. Anything unclear becomes a question. · Writing the first version is for people with Edit docs in {{code}} | Scrivi la prima versione con Claude · Claude scrive le pagine dalle email, riunioni, note e file che scegli. Ciò che non è chiaro diventa una domanda. · Scrivere la prima versione è di chi ha Modifica Docs in {{code}} |
| finestra | Emails · Meetings · Pasted text · Drive files · Paste notes, a brief or minutes… · {{count}} sources · Write the first version · Choose at least one source, or paste some text. · Starting… | Email · Riunioni · Testo incollato · File del Drive · Incolla note, un brief o un verbale… · {{count}} fonti · Scrivi la prima versione · Scegli almeno una fonte, o incolla del testo. · Avvio… |
| avanzamento | Claude is writing the first version · {{done}} of {{total}} pages · for {{name}} · writing… · Claude wrote the first version · {{pages}} pages · {{questions}} questions to close · Open the first page | Claude sta scrivendo la prima versione · {{done}} di {{total}} pagine · per {{name}} · sto scrivendo… · Claude ha scritto la prima versione · {{pages}} pagine · {{questions}} domande da chiudere · Apri la prima pagina |
| riga in cima | First version written by Claude on behalf of {{name}}, from: {{sources}} · Accept · Undo the first version · Undo the first version? · {{name}} edited “{{page}}” afterwards | Prima versione scritta da Claude per conto di {{name}}, da: {{sources}} · Accetta · Annulla la prima versione · Annullare la prima versione? · {{name}} ha modificato «{{page}}» dopo |
| riquadro | {{count}} questions to close in {{code}}'s docs · Show all {{count}} | {{count}} domande da chiudere nei Docs di {{code}} · Mostra tutte e {{count}} |
| attesa | Claude will resume updating the doc when the budget is back · Claude will resume updating the doc when {{name}} resumes the queue · {{count}} updates waiting | Claude riprenderà ad aggiornare la doc quando torna il budget · Claude riprenderà ad aggiornare la doc quando {{name}} riprende la coda · {{count}} aggiornamenti in attesa |

## 9. Vincoli

- Nessun `can(` in `pages/productDocs/`; i bottoni leggono la vista della
  domanda (`canAnswer`, `apply`, `request`, `answer`) e della prima versione
  (`undo: ProductUndoView`, `permissions`).
- La frase proposta è il testo del fatto: nessun componente la compone o
  la riassume.
- Scatti `a11b-questions-*` (filo, risposto, `alreadyAnswered`, Sara,
  divergenza, 1024), `a11b-home-*`, `a11b-inbox-question-*`,
  `a11b-first-*` su VRD (strade, finestra, durante, dopo, riga, conferma,
  spenta), `a11b-waiting-*` (budget, pausa).

## Decisioni del maintainer (6 nov 2026)

1. **Claude indica la risposta che preferisce** *(maintainer, 6 nov
   2026)*: sì, come nelle domande sui task. Una delle tre risposte è
   «Recommended» / «Consigliata», con la resa di `ClaudeAnswers`
   (`recommended`), la stessa nel filo e in Home «Decide»; i tre bottoni
   restano della stessa misura. Vaga → «Lascia com'è», salvo che la fonte
   sostenga «Aggiorna così»; divergenza da una task chiusa → la decide il
   seme, domanda per domanda. → §3.1, §3.2b [PQ 12], §3.4.

Le altre scelte marcate *(scelta del costruttore)* sono da approvare col
brief.

## Emendamenti (controller, 6 nov 2026, fix round 1 del Task 10)

1. **La divergenza ha tre righe** (§3.1.5): «The page says» / «La pagina
   dice» (la frase com'è), «Was built» / «È stato fatto» (`built`) e
   **«Proposed» / «Proposta»** con la frase del fatto (`apply`), quando c'è.
   «Update it» scrive quella, parola per parola: va mostrata.
2. **Il filo risolto non mostra più «Now» / «The page says»** (§3.1, §3.3):
   dopo «Update it» la frase di adesso è già quella proposta, e accanto
   direbbe il falso. Restano la frase citata in testa, «Was built» e
   «Proposed», poi «Answered by …».
3. **La divergenza senza richiesta da proporre non la offre** (§3.2): con
   `request` nullo la frase è «ACQ-14 was built differently from what the
   page says. Should I update the page?» / «ACQ-14 è stata fatta
   diversamente da come dice la pagina. Aggiorno la pagina?» (e la forma
   senza codice). Vale nel filo, in Home e nella card.
4. **«N questions to close» segue il chip `page` della sezione Docs del
   progetto** (§3.7): compare anche sulle pagine dei Docs generati, perché
   il contesto del riquadro non distingue lo spazio Prodotto (`ContextRef`
   ha solo `route: "docs"`). La frase («nei Docs di ACQ») resta vera a
   livello di progetto. Tolto il chip («×»), la riga non c'è.
5. **Nessuna tinta del «filo attivo» sul blocco dopo «Update it»** (§3.3):
   la tinta del 11a segue solo i fili aperti (`activeThread` fra gli
   aperti); il filo risolto non la porta. Il fuoco va al blocco aggiornato.

## Emendamenti (controller, 6 nov 2026, fix round 1 del Task 11)

1. **La riga in cima: le fonti su una riga a sé** ([PQ 9]). La frase è
   «First version written by Claude on behalf of Laura Costa» / «Prima
   versione scritta da Claude per conto di Laura Costa»; sotto, su una riga
   sua, la `SourceLine` delle fonti («From the email “…” · Oct 16 · From
   pasted text +1»). Le etichette di `sourceViewOf` cominciano già con
   «From…» / «Da…»: dopo «from:» si leggerebbero due volte.
2. **La prima versione interrotta** ([PQ 8], [PQ 9]): mai «wrote».
   Avanzamento: «Claude stopped the first version» / «Claude ha interrotto
   la prima versione», riga «2 of 10 pages written» / «2 di 10 pagine
   scritte» (· le domande da chiudere). Una pagina scritta e poi tolta resta
   nell'elenco con ✓ tenue, il titolo barrato e «removed» / «tolta» (non è
   «in attesa»). Riga in cima: dopo la frase, «Claude stopped after 2 of 10
   pages.» / «Claude si è fermato dopo 2 pagine su 10.».
3. **«Undo the first version» spento: una frase per tipo di tocco, e il
   «Who?»** ([PQ 9]; il «Who?» per ruling del controller, che segue il brief
   e la lezione vincolante «ogni controllo spento ha la sua frase e il
   Who?»). La frase nomina chi ha toccato (grassetto) e la pagina (link):
   - modifica: «**Marco Bellini** edited “Bills” afterwards» / «**Marco
     Bellini** ha modificato «Bills» dopo»;
   - commento: «… commented on “Bills” afterwards» / «… ha commentato
     «Bills» dopo»;
   - risposta di un altro a una domanda di Claude: «… answered a question on
     “Bills” afterwards» / «… ha risposto a una domanda su «Bills» dopo»;
   - pagina nuova: «… added “Marco's page” afterwards» / «… ha aggiunto
     «…» dopo»;
   - senza nome (pagina tolta, persona che chi guarda non vede): «A page was
     edited afterwards» / «Una pagina è stata modificata dopo»;
   poi, sempre, « · Who?» / « · Chi?» (`WhoCanLink`, `editDocs`).
4. **La finestra delle fonti** ([PQ 7]): il titolo è quello di ogni dialogo
   dell'app (18px, `Dialog` comune), non 20px. A 1024 la superficie sta in
   80vh (`scrollBody`): scorrono i gruppi, mentre la nota sulla riservatezza
   e la riga dei rifiuti (`role="alert"`) stanno in una fascia che non scorre,
   fra due filetti, subito sopra i bottoni: sempre a vista.
5. **La conferma «Undo the first version?»** vive nello spazio, non nella
   pagina (che sparisce con l'annullamento). Se l'indice non torna vuoto
   (una pagina nata nel frattempo), la conferma non resta su «Undoing…»: si
   chiude da sola dopo 1,5 s col fuoco sull'h1 dell'indice; chiusa a mano,
   stesso fuoco se il bottone da cui era partita non c'è più.
6. **A 1024 il cassetto dell'albero** si apre sopra la riga dell'attesa
   ([PQ 11]): è un pannello passeggero con l'ombra, copre già la lettura, e
   la riga torna appena si chiude.
7. **L'avanzamento che se ne va col fuoco dentro** (la prima versione
   annullata da un altro mentre si guarda l'indice): il fuoco passa all'h1 e
   poi alla prima strada dell'indice vuoto, mai al body.
