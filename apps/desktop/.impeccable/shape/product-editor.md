# Shape brief — L'editor a blocchi delle pagine di prodotto e la scrittura dal vivo

> Shape scritto dal costruttore senza intervista (5 nov 2026), dalla spec
> dell'area 11 (decisioni 4 e 5), dal piano 11a (Global Constraints «Il
> documento a blocchi», Task 8, 9, 11; decisioni Q2 e Q3) e dagli shape
> `docs.md`, `drive.md`, `claude-drafts.md`. Non li riscrive. Ogni scelta
> che non viene dal maintainer è marcata *(scelta del costruttore)*; le
> regole sono numerate **[PE n]**. Lo spazio, la barra e la testata sono in
> `product-space.md`; commenti e cronologia in
> `product-comments-history.md`. Le domande aperte sono in fondo.

Superficie:
- `pages/productDocs/editor/{BlockEditor,RichBlock,RichView,SelectionBar,LinkField,SlashMenu,BlockHandle,useEditorSession}.tsx`;
- `pages/productDocs/editor/{ImageBlock,DriveBlock,DecisionBlock,TableBlock,LinkPicker,DrivePicker,DecisionPicker}.tsx`;
- `pages/productDocs/live/{PresenceAvatars,RemoteCursor,RemoteBlockNote}.tsx`;
- `styles/tokens.css` (i token della presenza, vedi le domande).

Piano 11a: Task 8, 9, 11. Mondo: «Catalogo numerato», modalità **Read**
per il corpo (si scrive **nella pagina già formattata**), **Operate** per
maniglie, menu e barre. I codici `ACQ-D3n` sono segnaposti del seme.

## 1. Lavoro e pubblico

- **Laura** scrive la pagina «Sign-in» come in Google Docs o Notion: titoli,
  elenchi, una tabella, una schermata incollata, il brief del cliente dal
  Drive, la decisione presa in riunione. Non ha mai visto il markdown e non
  deve vederlo.
- **Marco** scrive nello stesso momento in «Meter reading»: Laura deve
  vederlo arrivare senza che il suo testo salti.
- **Sara** legge: la pagina letta e la pagina scritta devono essere **la
  stessa pagina**, senza un «modo modifica».
- Stato d'animo: chi scrive teme di perdere testo (salvataggi, altri che
  scrivono); chi legge vuole una pagina che si legge bene.

## 2. Esito e prova

- **Successo**:
  - Laura scrive «## Rules» e il blocco diventa un titolo 2 «Rules»:
    nessun «#» resta in nessun punto della pagina;
  - sceglie «only with Google», ⌘B: grassetto; «Link» con
    `javascript:alert(1)` → «Only http and https links», nessuna scrittura;
  - incolla una schermata: un blocco immagine con «Add a caption»;
    un'immagine da 8 MB → «This image is larger than 5 MB», nessun blocco;
  - Invio a metà di un paragrafo commentato: due blocchi, il commento resta
    sul primo; Backspace in testa al secondo: tornano uno, col commento
    (Q3);
  - Marco scrive in «Rules»: Laura vede la sua barra con «Marco Bellini»;
    se Laura è nello stesso paragrafo, vede «Marco Bellini is writing here»
    e il suo testo non cambia finché non esce;
  - esce dal blocco: «Saving…» poi «Saved»; un errore dice «Couldn't save ·
    Retry», e Retry rimanda le stesse operazioni.
- **Verità del prodotto**:
  - **il documento è dati**: blocchi con id stabili, testo più segni; il
    DOM non è mai la fonte (un nodo estraneo sparisce al ridisegno);
  - **la UI non afferma ciò che il dato non dimostra**: «Saved» solo dopo la
    risposta, «is writing here» solo con una presenza viva su quell'ancora;
  - i link sono solo `http(s)` e si aprono nel browser di sistema.

## 3. Direzione scelta

- **Tesi**: **una pagina stampata in cui si può scrivere**. Nessuna
  cornice intorno ai blocchi, nessuna barra degli strumenti fissa: la
  tipografia dei Docs, e gli strumenti compaiono **solo dove è la mano** —
  la maniglia al passaggio, il menu «/» al cursore, la barra della
  selezione sopra la selezione **[PE 1]**. Per chi legge soltanto la stessa
  pagina, senza nessuno di quegli strumenti.

### 3.1 Il titolo

- L'h1 28px della testata è, per chi ha `docs.edit`, un campo della stessa
  tipografia (nessun bordo a riposo; al passaggio tinta ink 6%, al fuoco
  l'anello di fuoco). Invio porta al primo blocco; uscire salva
  (`renameProductPage`); vuoto torna al titolo di prima con il `title` «A
  page needs a title». Una pagina nuova si apre con il titolo «Untitled»
  **selezionato** **[PE 2]**.

### 3.2 La tipografia dei blocchi

Il corpo usa la prosa della pagina dei Docs (`DocPageView`): stessa
famiglia, stessa colonna. Il titolo della pagina è l'unico h1: i titoli dei
blocchi scalano da h2 **[PE 3]**.

| Blocco | Resa | Spazio sopra / sotto |
|---|---|---|
| Heading 1 | h2, 20/26 600 (`headline`) | 28 / 8 |
| Heading 2 | h3, 16/22 600 (`project-name`) | 20 / 6 |
| Heading 3 | h4, 14/20 600 | 16 / 4 |
| Text | 14/22 400, `ink` | 0 / 8 |
| Bulleted / Numbered | 14/22, rientro 24 per livello (0–2), «•» / cifre tnum `ink-muted` | 0 / 4 |
| To-do | casella 16px (`accent-color` ink) + testo; spuntata: testo `ink-muted`, **non** barrato *(scelta del costruttore: si legge ancora)* | 0 / 4 |
| Quote | 14/22 `ink-muted`, filetto **neutro** 2px `rule-strong` a sinistra + 12px *(neutro: non è il filetto colorato vietato)* | 8 / 8 |
| Divider | 1px `rule`, a tutta colonna | 16 / 16 |
| Table | griglia 1px `rule`, celle 8×12, 14/20; colonne ≥ 120, scorrimento orizzontale dentro la tabella | 12 / 12 |
| Image, Drive, Decision | §3.6–3.8 | 12 / 12 |

- Grassetto `<strong>` 600, corsivo `<em>`, link sottolineato `ink`
  (sottolineatura 1px, offset 2px; al passaggio 2px). Nessun colore per i
  link: ink è l'accento del sistema.
- I codici nel testo sono `CodeLink` (600, tnum) **fuori dal fuoco**; nel
  blocco col fuoco restano 600 tnum ma non sono link *(scelta del
  costruttore: un clic nel blocco che si scrive mette il cursore, non
  naviga)*. Un codice che chi legge non vede è il codice tenue di
  `CodeLink`, senza nome.

### 3.3 Maniglia, «+» e fuoco

- **Gutter** 48px a sinistra della colonna. Al passaggio su un blocco (o col
  fuoco dentro), nel gutter all'altezza della prima riga: «+» e ⋮⋮, 20px
  ciascuno, `ink-faint`, al passaggio `ink` con tinta 6% **[PE 4]**. Solo
  per `docs.edit`.
  - «+» inserisce un paragrafo vuoto **sotto** e ci apre il menu «/».
  - ⋮⋮ si trascina (linea 2px ink fra i blocchi alla destinazione, ombra
    come nell'albero, `product-space.md` [PS 12]); al **clic** apre il menu
    del blocco: Turn into ▸ (i tipi di testo) · Comment · Move up · Move
    down · Duplicate · divisore · Delete. Le voci impossibili spente con la
    frase («Already first»).
- **Fuoco** **[PE 5]**: in un blocco di testo il segno del fuoco è il
  **cursore**, senza anello (un anello su ogni paragrafo sarebbe rumore).
  I blocchi non di testo (immagine, file, decisione, separatore, tabella
  intera) prendono il fuoco come oggetti: anello di fuoco 2px, raggio 8.
  Esc in un blocco di testo **seleziona il blocco** (stesso anello); da lì
  Canc/Backspace lo elimina, ⌥⇧↑/↓ lo sposta, Invio torna a scrivere
  *(scelta del costruttore: serve a eliminare un'immagine da tastiera)*.

### 3.4 Il menu «/»

- «/» in un blocco **vuoto** (o «+» del gutter) apre il menu, 300px, sotto
  il cursore (sopra se non c'è spazio): fondo `surface`, bordo
  `rule-strong`, raggio 8, ombra del tooltip, padding 6 — la forma di
  `menu` **[PE 6]**.
- **Gruppi e voci**, nell'ordine di `SLASH_ITEMS`; ogni riga 32px: glifo
  16px · nome · a destra, in `ink-faint`, la scorciatoia in un tasto
  bordato quando c'è:

| Gruppo | Voce (en / it) | Scorciatoia |
|---|---|---|
| TEXT / TESTO | Heading 1 / Titolo 1 | `#` |
| | Heading 2 / Titolo 2 | `##` |
| | Heading 3 / Titolo 3 | `###` |
| | Text / Testo | — |
| | Bulleted list / Elenco puntato | `-` |
| | Numbered list / Elenco numerato | `1.` |
| | To-do list / Lista di controllo | `[]` |
| | Quote / Citazione | `>` |
| | Divider / Separatore | `---` |
| INSERT / INSERISCI | Table / Tabella | — |
| | Image / Immagine | — |
| | Drive file / File del Drive | — |
| | Link to… / Collega a… | — |
| | Decision / Decisione | — |

  *(Il 11b aggiunge «Screen sketch» in INSERT.)*
- **Filtro**: ciò che si scrive dopo «/» filtra (`filterSlashItems`, nome e
  parole chiave nella lingua dell'interfaccia); i gruppi senza voci
  spariscono; la prima voce è attiva. Nessuna voce: «No blocks match
  “xyz”» / «Nessun blocco per «xyz»».
- **Tastiera**: ↑/↓ (giro in fondo), Invio sceglie, Esc chiude **lasciando
  «/…» com'era** nel blocco, Backspace oltre «/» chiude. Il fuoco resta nel
  blocco (`aria-activedescendant`), il menu è `role="listbox"`.
- Le **scorciatoie digitate** («# », «- », «1. », «[] », «> », «---»)
  cambiano il tipo appena scritto lo spazio (o l'ultimo «-»), e i loro
  segni spariscono. ⌘Z subito dopo rimette i caratteri come testo
  (l'annulla dell'editor, [PE 21]).

### 3.5 La barra della selezione e il link

- Su una selezione **non vuota dentro un blocco** (o una cella), sopra la
  selezione, 8px di distanza: barra 32px, forma di `menu` **[PE 7]**:
  **B** (Bold / Grassetto, ⌘B) · *I* (Italic / Corsivo, ⌘I) · Link
  (Link) · divisore · **Comment** / **Commenta** (in parola, `product-comments-history.md`).
  B e I hanno `aria-pressed` se tutta la selezione ha già il segno.
  Una selezione a cavallo di due blocchi: nessuna barra.
- ⌘K **non** è il link: resta la palette.
- **Link** sostituisce il contenuto della barra con il campo (`LinkField`),
  320px: «Paste or type a link» / «Incolla o scrivi un link», **Apply** /
  **Applica**, e su un link esistente «Remove link» / «Togli il link».
  Invio applica, Esc torna alla selezione. Un indirizzo rifiutato da
  `safeLinkHref`: sotto il campo, 12px `critical` con icona, «Only http and
  https links» / «Solo link http e https», nessuna scrittura
  **[PE 8]**.
- **Il link letto**: clic (fuori dal fuoco, o per chi legge) apre il
  browser di sistema; il `title` mostra l'indirizzo. Col cursore dentro un
  link mentre si scrive, la barra compare con Link premuto e l'indirizzo
  nel campo *(scelta del costruttore)*.
- Chi legge soltanto: **nessuna barra** (non può né formattare né
  commentare).

### 3.6 Immagine

- «/image» apre la scelta del file del sistema; incollare un'immagine dagli
  appunti o trascinare un file sulla colonna fanno lo stesso **[PE 9]**:
  - trascinando, una linea 2px ink sotto il blocco su cui il file cadrà e
    la nota 12px «Drop to add the image» / «Rilascia per aggiungere
    l'immagine»; il blocco nuovo va **dopo** quel blocco;
  - incollando, dopo il blocco col fuoco.
- **Il blocco**: l'immagine a tutta colonna, altezza massima 480 (`contain`),
  bordo 1px `rule`, raggio 6. Sotto, la **didascalia** 13/18 `ink-muted`:
  campo senza bordo con il segnaposto «Add a caption» / «Aggiungi una
  didascalia» (`ink-faint`); uscire salva. Per chi legge, una didascalia
  vuota non occupa spazio.
- **Rifiuti**, come riga d'avviso al posto dove sarebbe andato il blocco,
  `role="alert"`, ▲ `warning` + testo, 6s o fino a «Dismiss»:
  - «This image is larger than 5 MB» / «Questa immagine supera i 5 MB»;
  - «Only PNG, JPEG, GIF and WebP images» / «Solo immagini PNG, JPEG, GIF e
    WebP».
- In lettura l'immagine non si ingrandisce nel 11a *(scelta del
  costruttore)*.

### 3.7 File del Drive

- «/drive» apre il selettore (`DrivePicker`): popover 400px nella forma di
  `pages/drive/Picker.tsx`, campo «Find a file in ACQ's Drive» / «Cerca un
  file nel Drive di ACQ», righe 36px (glifo del Drive · nome · codice tnum ·
  cartella 12px faint), solo i file che chi scrive vede. Vuoto: «No files
  in ACQ's Drive yet» **[PE 10]**.
- **Il blocco**: riga 48px, bordo 1px `rule`, raggio 8: glifo 20px · nome
  14 600 · codice `ACQ-F12` tnum `ink-muted` · tipo e dimensione 12px faint ·
  a destra **Open** / **Apri** (`useOpenDriveFile`, l'anteprima del Drive).
- **Non disponibile** per chi guarda (nascosto, tolto, di un progetto
  invisibile): glifo neutro, «This file is no longer available» / «Questo
  file non è più disponibile» `ink-muted` e il **solo codice**; nessun nome,
  nessun «Open» (R-G5).

### 3.8 Decisione del registro

- «/decision» apre `DecisionPicker`: popover 400px, campo «Find a decision
  in ACQ's register», righe titolo · «Laura Costa · Oct 21».
- **Il blocco** **[PE 11]**: riga 52px, bordo 1px `rule`, raggio 8: in alto
  12px `ink-muted` «Decision · from the register» / «Decisione · dal
  registro»; sotto il titolo 14 600 («Sign-in only with Google») e «decided
  by Laura Costa · Oct 21» 12px; a destra «Open in the register» /
  «Apri nel registro». Il blocco **cita** il registro: non è il registro e
  non si modifica da qui.
- Non visibile (`decisions[id] === null`): «A decision you can't see» /
  «Una decisione che non puoi vedere», nessun titolo, data o nome nel DOM.

### 3.9 «Link to…» e i codici

- «/link» apre `LinkPicker` al cursore: la forma del menu `#` (gruppi TASKS,
  REQUESTS, PAGES, PRODUCT PAGES, FILES; righe codice · nome), campo «Find
  a task, request, page or file» / «Cerca una task, una richiesta, una
  pagina o un file». Invio scrive **il codice** nel testo al cursore; fuori
  dal fuoco diventa `CodeLink` **[PE 12]**. Un codice scritto a mano vale
  uguale.

### 3.10 Tabella

- «/table» mette una tabella 2×2 al posto del blocco vuoto, fuoco nella
  prima cella.
- **Tab / ⇧Tab** fra le celle, a capo di riga; Tab sull'**ultima** cella esce
  dalla tabella al blocco dopo (nessuna riga aggiunta da sola) *(scelta del
  costruttore)*. ↑/↓ dalla prima/ultima riga escono dalla tabella.
- Al passaggio, «⋯» della tabella in alto a destra (fuori dalla griglia,
  20px): Add row · Add column · divisore · Remove row · Remove column. Le
  rimozioni agiscono sulla riga o colonna della cella col fuoco; con una
  riga (o colonna) sola sono spente con «A table keeps at least one row» /
  «…one column» **[PE 13]**.
- Rimuovere una riga con una cella commentata: il filo diventa «Sentence
  deleted» (`product-comments-history.md`), senza chiedere conferma.

### 3.11 Tastiera dentro il testo

| Tasto | Effetto |
|---|---|
| Invio | divide il blocco (il primo tiene l'id); su un elemento d'elenco vuoto lo riporta a paragrafo; un titolo diviso dà un paragrafo |
| ⇧Invio | a capo nello stesso blocco |
| Backspace in testa | unisce al blocco sopra (`merge`, Q3), cursore al punto d'unione; sopra un blocco non di testo lo seleziona invece di unire |
| ↑ / ↓ in prima / ultima riga | blocco sopra / sotto, alla stessa colonna |
| Tab / ⇧Tab | rientro dell'elenco (0–2); fuori da elenchi e tabelle non fa niente, il fuoco non esce *(scelta del costruttore)* |
| ⌥⇧↑ / ⌥⇧↓ | sposta il blocco |
| ⌘B / ⌘I | grassetto / corsivo sulla selezione |
| ⌘Z / ⇧⌘Z | annulla / rifà dell'editor, per pagina e per sessione, solo le operazioni di chi scrive ([PE 21]); non è l'«Annulla» del 11b |
| Esc | chiude menu e barre, poi seleziona il blocco |

- **Incollare** **[PE 14]**: una riga sola si inserisce al cursore coi suoi
  segni; più righe diventano paragrafi **dopo** il blocco corrente, un
  blocco per riga, righe vuote saltate; dall'HTML restano solo grassetto,
  corsivo e link `http(s)` (un link `javascript:` o relativo resta testo).
  Il testo incollato non diventa mai un elenco o un titolo.

### 3.12 Salvataggio

- Si salva all'uscita dal blocco, a ogni gesto di struttura e dopo 800ms
  senza tasti; le scritture vanno in fila **[PE 15]**.
- **Stato**, primo elemento a destra della barra della pagina, 12px
  `ink-faint`: «Saving…» / «Salvataggio…» → «Saved» / «Salvato» (resta fino
  al prossimo tasto). A riposo, niente.
- **Errore**: al posto dello stato, 12px `critical` con icona: «Couldn't
  save · Retry» / «Salvataggio non riuscito · Riprova»; annunciato
  `assertive` una volta. Retry rimanda **le stesse operazioni**; le
  modifiche successive restano in fila dietro. Uscire dalla pagina con
  scritture non salvate: dialogo «Some changes aren't saved yet» · Stay ·
  Leave without saving *(scelta del costruttore)*.

### 3.12b Annulla e rifà (⌘Z / ⇧⌘Z)

- Una pila **per pagina e per sessione dell'editor**, fatta delle stesse
  `ProductBlockOp` che l'editor ha salvato: ⌘Z rimanda l'operazione
  inversa con `saveProductBlocks` (lascia la sua revisione), ⇧⌘Z la rifà
  **[PE 21]** *(maintainer, 5 nov 2026)*.
- Contiene **solo** le operazioni di chi scrive in quella sessione: le
  scritture altrui (anche dal vivo) non entrano e non si annullano. Se il
  blocco da annullare è stato cambiato da altri dopo, quel passo si salta,
  si toglie dalla pila e lo stato dice «Changed by someone else, not
  undone» / «Cambiato da altri, non annullato».
- Un blocco eliminato (o assorbito da un'unione) torna con il **suo
  stesso id**, e i suoi fili tornano con lui *(ruling del controller, 5 nov
  2026: è lo stesso blocco che torna, non un riuso; «gli id non si
  riusano» vale fra blocchi diversi)*. Il livello dati lo permette solo a
  una scrittura con `undoOf` della stessa sessione e della stessa persona,
  per un id che quella sessione ha tolto.
- Si svuota cambiando pagina o persona. Pila vuota: ⌘Z non fa niente.

### 3.13 La scrittura dal vivo

- **Avatar** nella barra della pagina, dopo lo stato di salvataggio: gli
  **altri** presenti (non chi guarda), 24px, iniziali 11px 600, anello 2px
  nel colore della persona, sovrapposti di 4px; al più 4 e «+N». `title` e
  nome accessibile: «Marco Bellini · writing in Rules» / «Marco Bellini ·
  scrive in Rules», o «Matteo Conti · reading» / «Matteo Conti · legge»
  **[PE 16]**. Entrano e escono in dissolvenza 150ms. *Emendamento del
  controller (5 nov 2026, Task 11 fix round 1): la sovrapposizione è di
  **2 px**, non 4: con 4 px (più il filetto di fondo) la seconda iniziale
  restava coperta.*
- **Cursore altrui** nel testo letto: barra 2px nel colore della persona,
  alta la riga, all'offset; sopra, l'**etichetta col nome** (12px 600,
  fondo nel colore della persona, testo a contrasto ≥ 4.5:1, raggio 4). Il
  nome c'è **sempre**: il colore non è mai l'unico segnale. Una selezione
  altrui: fondo nel colore della persona al 20% **[PE 17]**. I colori sono
  i sei `--presence-1…6`, presi dalle tinte dei reparti 1–6 con nomi
  propri, **solo dentro l'editor** (cursore, etichetta, anello
  dell'avatar) e sempre accanto al nome *(maintainer, 5 nov 2026)*.
- **Stesso blocco di chi scrive**: nessuna barra dentro il blocco col
  fuoco. Sul bordo destro del blocco, alla prima riga, la nota 12px
  `ink-muted` col pallino del colore: «Marco Bellini is writing here» /
  «Marco Bellini sta scrivendo qui» (`polite`, una volta). Il testo e il
  cursore di chi guarda **non cambiano** mentre ha il fuoco; le scritture
  altrui su quel blocco arrivano all'uscita, e il salvataggio di chi guarda
  vale per ultimo (Review Focus 1) **[PE 18]**.
- Le scritture altrui sugli altri blocchi arrivano subito, senza spostare
  lo scorrimento di chi legge (si ancora al blocco in cima alla vista).
- **Movimento ridotto**: nessun lampeggio dei cursori, avatar senza
  dissolvenza.

## 4. Ambito e confini

- **Dentro**: titolo, blocchi di testo e segni, «/», scorciatoie, barra
  della selezione, link, immagini, Drive, decisioni, codici, tabelle,
  incolla, salvataggio, presenza.
- **Fuori (11b)**: il segno a margine di Claude, la bozza di schermata, le
  domande di Claude. Il gutter destro dei blocchi resta libero per il segno
  del 11b; la nota «is writing here» sta sul bordo destro **dentro** la
  colonna, non nel gutter *(scelta del costruttore)*.
- **Anti-obiettivi**: un «modo modifica» separato dalla lettura; una barra
  degli strumenti fissa in cima; markdown visibile in qualunque momento;
  colori, sottolineature colorate o caratteri diversi per i blocchi; un
  cursore altrui senza nome; un «Saved» prima della risposta.

## 5. Stati e intervalli

- **Volumi**: 1–400 blocchi per pagina; paragrafi fino a 2.000 caratteri;
  tabelle fino a 8 colonne × 50 righe; 0–10 immagini (≤ 5 MB ciascuna);
  0–8 persone presenti.
- **Pagina nuova**: un paragrafo vuoto con il segnaposto «Type / for
  blocks» / «Scrivi / per i blocchi» in `ink-faint` (solo nel blocco vuoto
  col fuoco, e nel primo blocco di una pagina vuota).
- **Chi legge soltanto**: nessun `contenteditable`, nessun gutter, nessun
  segnaposto; i blocchi vuoti non occupano spazio.
- **Pagina eliminata o permesso perso mentre si scrive**: la pagina dice
  «This page doesn't exist or you can't see it» (`product-space.md`
  [PS 20]); le scritture in fila si scartano; nessuna presenza resta.

## 6. Layout: 1440 e 1024

**Una regola: a destra della lettura c'è al più UNA colonna** — commenti,
oppure cronologia, oppure il pannello della task **[PE 19]** *(scelta del
costruttore)*.

| Finestra | Albero | Lettura | Colonna laterale (commenti / cronologia) | Pannello della task (da un `CodeLink`) | Riquadro di Claude |
|---|---|---|---|---|---|
| **1440** | 240 (200–360) | ≤ 720 + gutter 48; con la colonna laterale aperta, ≥ 520 | **agganciata 296**, filetto a sinistra | agganciato 360: **prende il posto** della colonna laterale, che torna alla chiusura del pannello | sovrapposto 400 a sinistra del pannello, come in `claude-panel.md` §4: copre senza riflettere |
| **1200** | 240 | ≥ 520; se la colonna laterale non ci sta, l'albero diventa cassetto | agganciata 296 | come a 1440 | 360 |
| **1024** | cassetto 280 | tutta l'area (≤ 720) | **sovrapposta 360** dal bordo destro, copre la lettura senza rifletterla ([PE 22]) | sovrapposto 400; con la colonna laterale **vince l'ultimo aperto** | 360, a sinistra di ciò che è aperto a destra |

- A 1440 con l'albero trascinato a 360 e i commenti aperti, la lettura
  scenderebbe sotto 520: l'albero passa a cassetto finché la colonna è
  aperta, e torna com'era chiudendola **[PE 20]**.
- *Emendamento del controller (5 nov 2026, Task 10 dell'area 11a).* A
  **1200**, con la colonna del progetto di 240, l'albero affiancato non ci
  sta mai insieme alla colonna dei commenti: 1200 − 64 (binario) − 240
  (colonna del progetto) − 240 (albero) − 296 (commenti) = 360 < 520. Per
  [PE 20] l'albero è quindi un cassetto («Pages») finché la colonna laterale
  è aperta, e torna affiancato chiudendola; la riga «1200 · albero 240» della
  tabella vale con la colonna laterale chiusa.
- A **1024** la colonna laterale (commenti o cronologia) è sovrapposta
  360 dal bordo destro; col pannello della task vince l'ultimo aperto,
  l'altro resta montato dietro; il riquadro di Claude sta alla loro
  sinistra **[PE 22]** *(maintainer, 5 nov 2026)*.

```
1440 · «Meter reading», Laura scrive, commenti aperti ────────────────────────────────────────────────
│rail│ ACQ        │ Product  Features › Meter reading   Saved (MB)(MC)  Follow  Comments 1  History  Export ▾ ⋯ │
│    │ …          ├──────────────┬──────────────────────────────────────────────────┬───────────────────────┤
│    │ Docs       │ PAGES 8 +New │   ACQ-D34 · Product                              │ COMMENTS 1          × │
│    │            │ ▾ Overview   │   Meter reading                                  │                       │
│    │            │ ▾ Features   │   Updated Nov 4 by Matteo Conti                  │                       │
│    │            │   Sign-in    │                                                  │                       │
│    │            │   Bills      │   Rules                                          │ “close on the 25th”   │
│    │            │  ▌Meter rea… │ +⋮⋮ Readings close on the 25th of each month.    │ Laura Costa · 10:02   │
│    │            │   Fault rep… │     Readings sent after the 25th c|ount          │ Is it the 25th also   │
│    │            │   Screens    │                          ▔Marco Bellini          │ in February?          │
│    │            │   …          │     Edge cases                                   │ [Reply…]              │
│    │            │              │     ┌──────────┬──────────┐                      │                       │
│    │            │              │     │ Case     │ Rule     │                      │                       │
```

```
1024 · stessa pagina, commenti chiusi, Laura nello stesso blocco di Marco ─
│rail│ ACQ        │ Pages  Product › Meter reading  Saved (MB)(MC) Follow ⋯ │
│    │ …          ├────────────────────────────────────────────────────────┤
│    │            │   Meter reading                                        │
│    │            │   Rules                                                │
│    │            │ ⋮⋮ Readings close on the 25th…  ● Marco Bellini is     │
│    │            │    Readings sent after|          writing here          │
│    │            │                                                        │
│    │            │   Edge cases                                           │
```

## 7. Tastiera e accessibilità

- Ogni blocco di testo è `role="textbox"` `aria-multiline` con un nome
  accessibile dal tipo («Heading 2», «Paragraph», «Bulleted list item, level
  1», «Table cell, row 2, column 1»); la pagina ha un solo h1.
- Il menu «/» e i selettori sono `listbox` con `aria-activedescendant`; il
  fuoco resta nel testo. Barra della selezione: `toolbar` con frecce ←/→
  fra i bottoni, raggiungibile con ⌥F10 dal testo *(scelta del
  costruttore)*.
- Dopo un menu, un selettore o un dialogo il fuoco torna nel blocco, al
  cursore di prima.
- Annunci: `polite` per «Saved», presenza («Marco Bellini joined» /
  «Marco Bellini è arrivato», una volta per arrivo), «is writing here»;
  `assertive` solo per «Couldn't save».

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| segnaposto | Type / for blocks · Add a caption | Scrivi / per i blocchi · Aggiungi una didascalia |
| menu «/» | Text · Insert · No blocks match “{{q}}” | Testo · Inserisci · Nessun blocco per «{{q}}» |
| selezione | Bold · Italic · Link · Comment | Grassetto · Corsivo · Link · Commenta |
| link | Paste or type a link · Apply · Remove link · Only http and https links | Incolla o scrivi un link · Applica · Togli il link · Solo link http e https |
| blocco | Turn into · Comment · Move up · Move down · Duplicate · Delete | Trasforma in · Commenta · Sposta su · Sposta giù · Duplica · Elimina |
| immagine | Drop to add the image · This image is larger than 5 MB · Only PNG, JPEG, GIF and WebP images · Dismiss | Rilascia per aggiungere l'immagine · Questa immagine supera i 5 MB · Solo immagini PNG, JPEG, GIF e WebP · Chiudi |
| Drive | Find a file in {{code}}'s Drive · Open · This file is no longer available | Cerca un file nel Drive di {{code}} · Apri · Questo file non è più disponibile |
| decisione | Decision · from the register · decided by {{name}} · {{date}} · Open in the register · A decision you can't see | Decisione · dal registro · decisa da {{name}} · {{date}} · Apri nel registro · Una decisione che non puoi vedere |
| collega | Find a task, request, page or file | Cerca una task, una richiesta, una pagina o un file |
| tabella | Add row · Add column · Remove row · Remove column · A table keeps at least one row | Aggiungi riga · Aggiungi colonna · Togli la riga · Togli la colonna · Una tabella tiene almeno una riga |
| annulla | Changed by someone else, not undone | Cambiato da altri, non annullato |
| salvataggio | Saving… · Saved · Couldn't save · Retry · Some changes aren't saved yet · Stay · Leave without saving | Salvataggio… · Salvato · Salvataggio non riuscito · Riprova · Alcune modifiche non sono ancora salvate · Resta · Esci senza salvare |
| titolo | Untitled · A page needs a title | Senza titolo · Una pagina ha bisogno di un titolo |
| dal vivo | {{name}} is writing here · {{name}} · writing in {{section}} · {{name}} · reading · {{name}} joined | {{name}} sta scrivendo qui · {{name}} · scrive in {{section}} · {{name}} · legge · {{name}} è arrivato |

## 9. Vincoli

- Nessuna libreria d'editor; `contenteditable` controllato per blocco; ogni
  `beforeinput` passa da `applyInput`.
- Immagini sempre `data:`; nessun `fetch` né `file://`.
- Il monospace non entra nell'editor (nessun blocco codice nel 11a).
- Token nuovi solo `--presence-1…6` (chiaro e scuro), usati solo
  nell'editor e sempre accanto al nome ([PE 17]; eccezione scritta in
  DESIGN.md).

## Decisioni del maintainer (5 nov 2026)

1. **Colori dei cursori altrui** *(maintainer, 5 nov 2026)*: sei colori
   della presenza `--presence-1…6`, solo dentro l'editor, sempre accanto al
   nome; l'eccezione è scritta in DESIGN.md. → [PE 17], §9.
2. **Commenti e cronologia a 1024** *(maintainer, 5 nov 2026)*: colonna
   sovrapposta 360 dal bordo destro; col pannello della task vince l'ultimo
   aperto; il riquadro di Claude sta alla sua sinistra. → [PE 22], §6.
3. **⌘Z nell'editor** *(maintainer, 5 nov 2026)*: annulla/rifà per pagina e
   per sessione dell'editor, sulle stesse `ProductBlockOp`. → [PE 21],
   §3.12b, §3.11.

Le scelte marcate *(scelta del costruttore)* sono approvate col brief.
