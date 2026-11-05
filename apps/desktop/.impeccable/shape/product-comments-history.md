# Shape brief — Commenti, cronologia e «Segui» nelle pagine di prodotto

> Shape scritto dal costruttore senza intervista (5 nov 2026), dalla spec
> dell'area 11 («Commenti», «Il segno e la cronologia», «Avvisi — Chi
> riceve», decisione 4), dal piano 11a (Task 4, Task 10; decisioni Q1 e Q3)
> e dagli shape `docs.md`, `claude-trace.md` (forma di storia e notifiche),
> `claude-drafts.md` (la riga «Used:» che il 11b riusa). Non li riscrive.
> Ogni scelta che non viene dal maintainer è marcata *(scelta del
> costruttore)*; le regole sono numerate **[PC n]**. Le larghezze e la
> convivenza coi pannelli sono in `product-editor.md` §6 ([PE 19], [PE 20]).
> Le domande aperte sono in fondo.

Superficie:
- `pages/productDocs/comments/{CommentsColumn,CommentThread,CommentComposer,SelectionCommentButton}.tsx`;
- `pages/productDocs/history/HistoryPanel.tsx`;
- `pages/productDocs/FollowButton.tsx`;
- `notifications/NotificationItem.tsx` — la card `product_doc.mention`.

Piano 11a: Task 4 (dati), Task 10 (UI). Mondo: «Catalogo numerato»,
modalità **Operate**; il testo citato e i «Before/After» sono **Read**. I
codici `ACQ-D3n` sono segnaposti del seme.

## 1. Lavoro e pubblico

- **Laura** rilegge «Sign-in» e ha un dubbio su una frase: la seleziona, la
  commenta, menziona Marco. Vuole che Marco lo sappia e che il dubbio resti
  attaccato a **quella** frase.
- **Marco** riceve la menzione, apre la pagina sul filo, risponde, e Laura
  lo risolve.
- **Matteo** ha cancellato una frase commentata in «Phases»: il filo non
  deve sparire nel nulla.
- **Sara** legge i commenti per capire perché una regola è com'è; non può
  scrivere.
- **Chi controlla** (Laura il lunedì): «cosa è cambiato in questa pagina, e
  chi l'ha cambiato?».
- Stato d'animo: i commenti sono lavoro in corso, la cronologia è la
  garanzia che niente si perda.

## 2. Esito e prova

- **Successo**:
  - Laura sceglie «only with Google» in Sign-in → **Comment** → «@Mar» →
    Marco Bellini → **Comment**: il filo compare nella colonna, accanto al
    blocco, con la frase citata **senza segni** anche se era in grassetto;
  - Marco ha la card «Laura Costa mentioned you in ACQ-D31 · Sign-in»; il
    clic apre la pagina con la colonna aperta e il fuoco sul filo;
  - Backspace in testa a «with Google», che ha un filo: un blocco solo, il
    filo accanto a lui, nessun «Sentence deleted» (Q3);
  - in Phases il filo di Matteo dice «Sentence deleted» e la frase; si
    risponde ancora;
  - «Resolve» lo chiude in «1 resolved»; «Reopen» lo riporta;
  - History di Meter reading: «Marco Bellini · Edited 1 sentence» con
    «After» e il testo; un grassetto di Laura è «Formatting changed»;
  - Sara su Bills: «Follow» → «Following», premuto; ricaricata la pagina
    resta.
- **Verità del prodotto**:
  - un commento è ancorato a un **blocco** (o una cella), non a un
    intervallo di caratteri: la frase citata è memoria di cosa si guardava,
    non un'ancora (decisione 4);
  - «Sentence deleted» **solo** con `anchorGone` (blocco tolto, riga o
    colonna di tabella tolta), mai per un'unione;
  - la cronologia **non** è il registro decisioni: racconta modifiche, non
    fatti decisi.

## 3. Direzione scelta

- **Tesi**: **note a margine e un registro delle versioni, entrambi a
  lato del testo**. I commenti stanno accanto al blocco che commentano,
  come le note a matita nel margine di un documento stampato; la cronologia
  occupa lo stesso margine quando serve, e il testo resta al centro. Niente
  card con ombra, niente fumetti colorati: filetti e tipografia **[PC 1]**.

### 3.1 Commentare

- **Dalla selezione**: «Comment» / «Commenta» nella barra della selezione
  (`product-editor.md` [PE 7]), su una selezione dentro **un** blocco o una
  cella. Ancora = quell'id; `quote` = il solo testo scelto, senza segni,
  tagliato a 200 caratteri con «…» **[PC 2]**.
- **Da tastiera / senza selezione**: menu del blocco (⋮⋮ → Comment): la
  frase **intera** del blocco come `quote`.
- Si apre la **casella** nella colonna (che si apre se era chiusa),
  allineata al blocco: in cima la frase citata, poi il campo multilinea
  «Add a comment… Type @ to mention someone» / «Aggiungi un commento…
  Scrivi @ per menzionare qualcuno», poi Cancel · **Comment** / **Commenta**
  (⌘Invio). Comment è spento a casella vuota con il `title` «Write something
  first» / «Scrivi qualcosa prima». In corso «Posting…»; errore in riga
  «Couldn't post the comment · Retry», il testo resta nella casella.
- Dopo l'invio il fuoco va sul filo nuovo, e il blocco resta col suo segno
  (§3.4).

### 3.2 Le @menzioni

- «@» nella casella apre `SuggestionMenu` di `MentionMenu.tsx`
  (`useProductMentionCandidates`): righe 32px con iniziali 20px · nome; solo
  chi legge i Docs del progetto, mai Claude, mai chi scrive **[PC 3]**.
  In testa al menu 12px `ink-faint`: «People who can read ACQ's docs» /
  «Chi può leggere i Docs di ACQ». Nessuno: «Nobody here matches “xyz”» /
  «Nessuno qui corrisponde a «xyz»».
- ↑/↓, Invio o Tab scelgono, Esc chiude lasciando «@…» com'era. Scelto, il
  nome entra come «@Marco Bellini» in 600 `ink` (è testo, non un gettone);
  nel commento letto la menzione è 600 `ink`.
- Sotto la casella, quando c'è almeno una menzione, 12px `ink-faint`:
  «Marco Bellini will be notified.» / «Marco Bellini riceverà un avviso.»
  (più nomi: «Marco Bellini and Matteo Conti will be notified.»).

### 3.3 La colonna dei commenti

- **Larghezza 296** agganciata con filetto a sinistra (1440 e 1200; a 1024
  sovrapposta 360, `product-editor.md` [PE 22]). Testata 40px: `heading-group`
  «COMMENTS» / «COMMENTI» col numero degli aperti, a destra × (chiude;
  stesso effetto di «Comments» nella barra) **[PC 4]**.
- **Quando si apre** **[PC 14]** *(maintainer, 5 nov 2026)*: aprendo una
  pagina **con fili aperti** la colonna si apre da sola; senza fili resta
  chiusa. Aprirla o chiuderla a mano («Comments», ×) si ricorda **per
  persona** (non per pagina) e prevale sull'apertura automatica; la
  memoria sta in `localStorage` dentro try/catch, e senza archivio vale la
  regola automatica. La cronologia non si apre mai da sola.
  - *Emendamento del controller (6 nov 2026, revisione Impeccable finale
    dell'area 11a).* L'apertura automatica e il gesto ricordato valgono
    **da 1200**, dove la colonna si aggancia: la domanda al maintainer era
    «La colonna dei commenti **a 1440**». A 1024 la colonna è sovrapposta
    (360, [PE 22]) e coprirebbe da sola il testo che si sta scrivendo:
    si apre **solo con un gesto** («Comments», il segno del blocco,
    «Comment» sulla selezione, ⌥⌘M, `?comment=`). Barra della selezione,
    menu «/» e selettori dell'editor stanno sempre **sopra** la colonna
    sovrapposta. *Se sbagliata*: a 1024 chi apre una pagina con fili aperti
    non li vede finché non preme «Comments» (il numero nella barra lo dice).
- **Ordine e posizione** **[PC 5]**:
  1. i **fili aperti** con l'ancora viva, nell'ordine delle ancore nella
     pagina, ciascuno con il bordo alto **allineato** alla prima riga del
     suo blocco; se il filo prima è più lungo, il successivo si accoda 8px
     sotto (mai sovrapposti). Il filo **attivo** (fuoco, clic, `?comment=`)
     si allinea esattamente al suo blocco e gli altri si spostano, 200ms;
  2. sotto un filetto, i fili con **«Sentence deleted»** (§3.5), in ordine
     di `seq`;
  3. in fondo, chiuso, «2 resolved» / «2 risolti» ▸ (bottone; aperto
     mostra i fili risolti nella forma letta, ciascuno con «Reopen»).
- **Il filo** (bordo 1px `rule`, raggio 8, padding 12; attivo `rule-strong`;
  nessuna ombra):
  - la **frase citata**, 12/16 `ink-muted` fra virgolette tipografiche, al
    più 2 righe con «…» e il `title` intero;
  - la **radice**: nome 13 600 · ora 12 `ink-faint` tnum («10:02», «Nov 3»),
    a destra **Resolve** / **Risolvi** (bottone testo con spunta) per
    `docs.edit`; poi il testo 14/20;
  - le **risposte** in fila sotto, stessa forma senza «Resolve», separate da
    8px; più di 3 risposte: le prime 1 e le ultime 2, con «Show 2 more
    replies» / «Mostra altre 2 risposte» in mezzo;
  - la casella «Reply…» / «Rispondi…» a una riga, che si allarga al fuoco,
    con @menzioni; Invio va a capo, ⌘Invio invia.
- I commenti non si modificano né si eliminano nel 11a *(scelta del
  costruttore: il piano non li prevede; detto nei follow-up)*.

### 3.4 Il segno del blocco commentato

- Un blocco con fili aperti ha, sul bordo **destro** della colonna di
  lettura, all'altezza della prima riga, il glifo del commento 14px
  `ink-faint` col numero dei fili (tnum, 12px) **[PC 6]**. Clic: apre la
  colonna sul primo filo di quel blocco. Nome accessibile «2 comments on
  this paragraph» / «2 commenti su questo paragrafo».
- Col filo attivo, il blocco ha la tinta ink 6% a tutta larghezza (non un
  colore, non la sola frase: l'ancora è il blocco).
- Il segno sta **dentro** la colonna di lettura, così il gutter destro resta
  al segno a margine di Claude del 11b *(scelta del costruttore)*.

### 3.5 «Sentence deleted»

- Il filo il cui blocco non c'è più: in testa, al posto dell'allineamento,
  l'etichetta 12px `ink-muted` con l'icona del taglio: «Sentence deleted» /
  «Frase eliminata», e sotto la frase citata come sempre **[PC 7]**.
- Si legge, si risponde, si risolve; nessun segno nel testo (non c'è
  blocco). Non sparisce mai dalla colonna da solo.
- Un filo su una cella di una riga tolta è «Sentence deleted» come un
  blocco tolto; un filo su un blocco **unito** a quello sopra (Q3) passa al
  blocco unito con la sua frase e **non** lo è.

### 3.6 Chi legge soltanto

- I fili si leggono, aperti e risolti; **nessuna** casella, nessun «Reply»,
  nessun «Resolve», nessun «Reopen», nessun «Comment» sulla selezione
  **[PC 8]**.
- In testa alla colonna, sotto la testata, una riga 13px `ink-muted`: «You
  can read the comments. Commenting is for people with Edit docs in ACQ» /
  «Puoi leggere i commenti. Commentare è di chi ha Modifica Docs in ACQ» +
  `WhoCanLink` (`editDocs`).

### 3.7 La cronologia

- **History** nella barra apre la cronologia **nella stessa colonna** (296)
  e chiude i commenti, e viceversa: una colonna alla volta ([PE 19])
  **[PC 9]**. Testata: «HISTORY» / «CRONOLOGIA», ×.
- **Righe**, dalla più recente, raggruppate per giorno (`heading-group`
  «TODAY» / «OGGI», «NOV 3»); ogni riga 13px: iniziali 20px · **nome** 600 ·
  cosa · a destra l'ora tnum. Fra le iniziali e il nome, per una riga del
  11b, verrà «Claude on behalf of …» (`claude-trace.md`): nel 11a non c'è.

| Tipo | en | it |
|---|---|---|
| `create` | Created the page | Ha creato la pagina |
| `edit` | Edited 1 sentence · Edited {{count}} sentences | Ha modificato 1 frase · Ha modificato {{count}} frasi |
| `rename` | Renamed from “{{before}}” | Ha rinominato da «{{before}}» |
| `move` | Moved under {{parent}} · Moved to the top level | Ha spostato sotto {{parent}} · Ha spostato al primo livello |

- «Frase» qui è un'**ancora** (blocco o cella), come nella decisione 4.
- **Aperta** (clic sulla riga o Invio; ▸/▾ a sinistra dell'ora), sotto la
  riga, per ancora, **in verticale** (la colonna è stretta) **[PC 10]**:
  - un'etichetta 12px `ink-muted` per il tipo quando non è un paragrafo
    («Heading 2», «Table cell», «Image»);
  - «Before» / «Prima» 12 600 `ink-muted` e il testo di prima, 13/18
    `ink-muted`, con i segni (`RichView`);
  - «After» / «Dopo» e il testo di dopo, 13/18 `ink`;
  - una frase **tolta**: solo «Before», con l'etichetta «Removed» /
    «Tolta»; **aggiunta**: solo «After», con «Added» / «Aggiunta»;
  - solo i segni cambiati: «Formatting changed» / «Formattazione cambiata»
    e «After» col testo;
  - immagine: «Image: {{caption}}» / «Immagine: {{didascalia}}» (senza
    didascalia: «Image without a caption»);
  - più di 5 ancore: le prime 5 e «Show 7 more» / «Mostra altre 7».
  - Le parole cambiate **non** si evidenziano dentro la frase nel 11a
    *(scelta del costruttore: prima e dopo bastano; un diff per parola è un
    lavoro a sé)*.
- **Stati**: caricamento 4 righe scheletro; errore «Couldn't load the
  history · Retry»; una sola riga `create` è la cronologia di una pagina
  nuova (nessuno stato vuoto). Una revisione senza `via` né `sessionId`, o
  con blocchi senza `marks`, si disegna come le altre.
- La cronologia **si legge**: niente «Restore» né «Undo» nel 11a (l'«Annulla»
  delle modifiche di Claude è del 11b, nella stessa riga).
- Chi legge soltanto vede la cronologia uguale.

```
1440 · «Sign-in», colonna dei commenti (Laura) ──────────────────────────────────────────────────────
│rail│ ACQ       │ Product  Features › Sign-in       Saved (MB)  Follow  Comments 2  History  Export ▾  ⋯ │
│    │ …         ├─────────────┬────────────────────────────────────────────────┬─────────────────────────┤
│    │           │ PAGES 8     │   ACQ-D31 · Product                            │ COMMENTS 2            × │
│    │           │ ▾ Features  │   Sign-in                                      │                         │
│    │           │  ▌Sign-in   │   Updated Nov 4 by Laura Costa                 │                         │
│    │           │   Bills     │░░ Login only with Google. Customers with an ▢2 │┌ “only with Google” ────┐│
│    │           │   …         │░░ email account sign in with a link.           ││ Laura Costa · 10:02  ✓ ││
│    │           │             │                                                ││ @Marco Bellini does the││
│    │           │             │   Rules                                        ││ app support it?        ││
│    │           │             │   A session lasts 30 days. …                   ││ Marco Bellini · 10:20  ││
│    │           │             │                                                ││ Yes, since 2.3.        ││
│    │           │             │                                                ││ [Reply…]               ││
│    │           │             │                                                │└────────────────────────┘│
│    │           │             │                                                │ ─────────────────────── │
│    │           │             │                                                │ 1 resolved ▸            │
```

```
1024 · cronologia di «Meter reading» (Laura), colonna sovrapposta 360 ([PE 22])
│rail│ ACQ       │ Pages  Product › Meter reading │ HISTORY                 × │
│    │ …         ├────────────────────────────────┤ TODAY                     │
│    │           │   Meter reading                │ MB Marco Bellini  11:40 ▾ │
│    │           │   Rules                        │    Edited 1 sentence      │
│    │           │   Readings close on the 25th…  │    Added                  │
│    │           │   Readings sent after the 25th │    After                  │
│    │           │   count for the next bill.     │    Readings sent after the│
│    │           │                                │    25th count for the …   │
│    │           │                                │ NOV 3                     │
│    │           │                                │ LC Laura Costa    16:05 ▸ │
│    │           │                                │    Renamed from “Readings”│
│    │           │                                │ LC Laura Costa    09:12 ▸ │
│    │           │                                │    Created the page       │
```

### 3.8 Seguire

- **Follow** / **Segui** nella barra della pagina (`product-space.md`
  [PS 8]); seguita: **Following** / **Segui già**, con l'icona dell'occhio
  piena, `aria-pressed="true"` e tinta ink 10% — la stessa forma del
  «Following» del pannello della task **[PC 11]**.
- Per **chiunque legga** la pagina, anche senza `docs.edit` (spec «Avvisi»).
  Seguono **solo** chi ha creato la pagina e chi preme «Follow»: commentare,
  rispondere o essere menzionati **non** fanno seguire *(maintainer, 5 nov
  2026)*.
- `title`: «Follow this page to hear when it changes» / «Segui questa
  pagina per sapere quando cambia»; seguita: «You're following this page.
  Click to stop.» / «Segui questa pagina. Clic per smettere.». Nel 11a
  seguire non manda ancora avvisi (li porta il 11b); le menzioni arrivano
  comunque, anche a chi non segue.
- Ottimistico: lo stato cambia subito; un errore lo rimette e dice «Couldn't
  follow this page · Retry» nell'avviso del prototipo. Annunci `polite`:
  «Following this page» / «Segui questa pagina», «Stopped following this
  page» / «Non segui più questa pagina».

### 3.9 La notifica di menzione (`product_doc.mention`, Q1)

- La card dell'elenco delle notifiche, nella forma di oggi **[PC 12]**:
  - riga del codice: **ACQ-D31** (tnum 600) · «Product» · ora;
  - titolo: «Laura Costa mentioned you in ACQ-D31 · Sign-in» / «Laura
    Costa ti ha menzionato in ACQ-D31 · Sign-in» (composto **a lettura**);
  - corpo: il testo del commento, al più 2 righe, con la menzione in 600.
- Clic: `#/p/ACQ/docs/product/ACQ-D31?comment=<id radice>` — la colonna si
  apre, il blocco scorre in vista, il fuoco va sul filo (contenitore con
  `tabindex="-1"`, nome «Comment by Laura Costa on “only with Google”»).
  Il filo risolto nel frattempo: il gruppo dei risolti si apre su di lui.
- `objectGone` (pagina o commento eliminati, o chi riceve non legge più i
  Docs): titolo «A comment you were mentioned in» / «Un commento in cui eri
  menzionato», corpo «This comment is no longer available.» / «Questo
  commento non è più disponibile.», nessun codice né titolo di pagina,
  nessun link (R-G5).
- Un `?comment=` di un filo che non c'è più (link vecchio): la colonna si
  apre e in testa una riga 12px `ink-faint` «This comment is no longer
  here» / «Questo commento non c'è più».

## 4. Ambito e confini

- **Dentro**: commentare, menzioni, risposte, risolvere e riaprire, «Sentence
  deleted», sola lettura, cronologia, seguire, la card di menzione.
- **Fuori (11b)**: le domande di Claude come commenti con le risposte a
  scelta («Update it like this», «Leave it», «Open a request»), il segno a
  margine con «Looks good» / «Undo», «Claude on behalf of» e la fonte nella
  cronologia, `product_doc.updated` e `product_doc.question`. Questo shape
  lascia loro il posto: le domande saranno fili della stessa colonna, le
  righe di Claude righe della stessa cronologia.
- **Anti-obiettivi**: commenti in popover che coprono il testo a 1440; un
  filo che sparisce perché il blocco è stato tolto; la cronologia come
  pannello di ripristino; un evidenziatore colorato sulla frase commentata;
  menzioni di persone che non vedono la pagina.

## 5. Stati e intervalli

- **Volumi**: 0–40 fili per pagina, 0–30 risposte per filo, commenti fino a
  4.000 caratteri (a capo, nessun taglio nella colonna), revisioni 1–500
  (le prime 50, poi «Show older» / «Mostra le precedenti»).
- **Colonna vuota** (chi scrive): «No comments yet. Select a sentence and
  choose Comment.» / «Ancora nessun commento. Seleziona una frase e scegli
  Commenta.»; (chi legge): «No comments on this page.» / «Nessun commento
  su questa pagina.».
- **Caricamento** della colonna: 2 fili scheletro; **errore**: «Couldn't
  load the comments · Retry».
- **Cambio di persona**: casella e risposte non inviate si scartano senza
  chiedere; la colonna si ricarica coi permessi nuovi.

## 6. Tastiera e fuoco

- La colonna è una `region` «Comments» / «Commenti»; ogni filo un
  `article`. Nell'ordine di Tab la colonna viene **dopo il corpo** (l'ordine
  di lettura) *(scelta del costruttore)*; ⌥⌘M dal blocco col fuoco porta al suo primo filo, o apre
  la casella se non ne ha *(scelta del costruttore, la scorciatoia di Google
  Docs)*.
- Dentro un filo: Tab fra «Resolve», i link, «Reply»; Esc nella casella la
  svuota se non è stata toccata e riporta il fuoco al blocco.
- **Resolve**: il filo si chiude (altezza a zero 150ms, niente con
  movimento ridotto) e il fuoco va al filo successivo, o a «N resolved» se
  non c'è; **Reopen**: il filo torna al suo posto e il fuoco va al suo
  «Resolve». Dopo × della colonna il fuoco torna a «Comments» nella barra
  **[PC 13]**.
- Cronologia: ↑/↓ fra le righe (`listbox`), Invio o → apre, ← chiude; il
  fuoco torna a «History» chiudendo.
- Annunci `polite`: «Comment posted», «Resolved», «Reopened»; la menzione
  scelta legge il nome.

## 7. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| colonna | Comments · {{count}} resolved · No comments yet. Select a sentence and choose Comment. · No comments on this page. | Commenti · {{count}} risolti · Ancora nessun commento. Seleziona una frase e scegli Commenta. · Nessun commento su questa pagina. |
| casella | Add a comment… Type @ to mention someone · Comment · Cancel · Write something first · Posting… · Couldn't post the comment · Retry | Aggiungi un commento… Scrivi @ per menzionare qualcuno · Commenta · Annulla · Scrivi qualcosa prima · Invio… · Commento non inviato · Riprova |
| filo | Reply… · Resolve · Reopen · Show {{count}} more replies | Rispondi… · Risolvi · Riapri · Mostra altre {{count}} risposte |
| menzioni | People who can read {{code}}'s docs · Nobody here matches “{{q}}” · {{names}} will be notified. | Chi può leggere i Docs di {{code}} · Nessuno qui corrisponde a «{{q}}» · {{names}} riceverà un avviso. |
| eliminata | Sentence deleted | Frase eliminata |
| sola lettura | You can read the comments. Commenting is for people with Edit docs in {{code}} | Puoi leggere i commenti. Commentare è di chi ha Modifica Docs in {{code}} |
| segno | {{count}} comments on this paragraph | {{count}} commenti su questo paragrafo |
| cronologia | History · Before · After · Removed · Added · Formatting changed · Image: {{caption}} · Show older · Couldn't load the history · Retry | Cronologia · Prima · Dopo · Tolta · Aggiunta · Formattazione cambiata · Immagine: {{caption}} · Mostra le precedenti · Cronologia non caricata · Riprova |
| seguire | Follow · Following · Follow this page to hear when it changes · Couldn't follow this page · Retry | Segui · Segui già · Segui questa pagina per sapere quando cambia · Non sono riuscito a seguire la pagina · Riprova |
| notifica | {{name}} mentioned you in {{code}} · {{title}} · A comment you were mentioned in · This comment is no longer available. | {{name}} ti ha menzionato in {{code}} · {{title}} · Un commento in cui eri menzionato · Questo commento non è più disponibile. |
| link vecchio | This comment is no longer here | Questo commento non c'è più |

## 8. Vincoli

- Tutto con `docs.edit` (commentare, rispondere, risolvere, riaprire);
  seguire con la sola lettura. La pagina legge i permessi dalla vista.
- `quote` senza segni; i commenti non entrano nell'esportazione.
- Il kind `product_doc.mention` in parità con la regola di rollback e i
  cambi additivi verso l'app; una fixture con `kind` ignoto non rompe
  l'elenco.

## Decisioni del maintainer (5 nov 2026)

1. **La colonna dei commenti a 1440** *(maintainer, 5 nov 2026)*: si apre
   da sola se la pagina ha fili aperti, chiusa altrimenti; il gesto a mano
   si ricorda per persona. → [PC 14].
2. **Commentare o essere menzionati non fa seguire** *(maintainer, 5 nov
   2026)*: seguono solo chi ha creato la pagina e chi preme «Follow». →
   [PC 11], §3.8.

Le scelte marcate *(scelta del costruttore)* sono approvate col brief.
