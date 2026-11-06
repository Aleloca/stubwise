# Shape brief — Dalla doc al backlog, e le bozze di schermata di Claude

> Shape scritto dal costruttore senza intervista (6 nov 2026), dalla spec
> dell'area 11 («Dalla doc al backlog», «Bozze di schermata di Claude»,
> «Claude nel riquadro», «Esportazione», decisione 3), dal piano 11b
> (Global Constraints «Classi del riquadro», «Il budget»; Task 7, Task 8,
> Task 12) e dagli shape `product-space.md`, `product-editor.md`,
> `claude-actions.md`, `claude-panel.md`, `claude-drafts.md`, che **non
> riscrive**. Ogni scelta che non viene dal maintainer è marcata *(scelta
> del costruttore)*; le regole sono numerate **[PB n]**. Il segno a
> margine e la fonte sono in `product-claude-mark.md`. Le domande aperte
> sono in fondo.

Superficie:
- `pages/productDocs/ProductSpace.tsx` — il «⋯» della pagina col gruppo
  CLAUDE («Propose backlog items», «Draw this screen»);
- `pages/productDocs/editor/BlockHandle.tsx` — la voce del menu di un
  titolo («Propose backlog items from this section»);
- `pages/claude/conversation/ProposalCard.tsx` — la scheda in blocco di
  oggi, con la frase della pagina per voce e la nota «already proposed»;
- `pages/productDocs/claude/LinkedRequests.tsx` — le voci collegate in
  fondo alla pagina;
- `pages/task/LinksSection.tsx` e `pages/requests/RequestDetail.tsx` —
  «From the doc: …»;
- `pages/productDocs/blocks/WireframeBlock.tsx`, `editor/SlashMenu.tsx`,
  l'esportazione.

Piano 11b: Task 7 (dati), Task 8 (riquadro), Task 12 (UI). Mondo:
«Catalogo numerato», modalità **Operate**; la bozza di schermata è
un'illustrazione **Read**. Codici: `ACQ-D11` Phases, `ACQ-D5` Sign-in;
richieste `ACQ-R…` segnaposto del seme.

## 1. Lavoro e pubblico

- **Laura Costa** (`docs.edit` e il permesso del backlog in ACQ) ha scritto
  in «Phases» cosa entra nella fase 2: vuole trasformare quelle voci in
  richieste del backlog senza ricopiarle, e ritrovare da ogni task la frase
  da cui è nata.
- **Marco Bellini** (sviluppatore) apre la task `ACQ-21`: vuole sapere da
  quale pagina di prodotto viene, per leggere il contesto.
- **Laura in VRD** (progetto nuovo) scrive «Booking screen: the user picks
  a class, a time and pays»: vuole uno schizzo per parlarne col cliente,
  non un design finito.
- **Sara Montanari** legge e non agisce.
- Stato d'animo: la doc deve diventare lavoro senza perdere il legame; una
  bozza di Claude non deve sembrare un design approvato.

## 2. Esito e prova

- **Successo**:
  - Laura in «Phases» → «⋯» → **Propose backlog items**: si apre il
    riquadro di Claude con la scheda «Claude proposes · 5 requests», ogni
    riga con la frase della pagina sotto; due voci già proposte non ci sono
    e una nota lo dice; Laura toglie una spunta, **Confirm 4**; in fondo a
    «Phases» compaiono le quattro richieste sotto **FROM THIS PAGE**;
  - dal titolo «Phase 2» → ⋮⋮ → **Propose backlog items from this
    section**: la scheda ha solo le voci di quella fase;
  - Marco apre `ACQ-21`: sotto la richiesta d'origine c'è «From the doc:
    **ACQ-D11** Phases», che apre la pagina;
  - Laura in VRD digita «/sketch» → **Screen sketch**: sotto il paragrafo
    compare uno schizzo in bianco e nero con «Claude's draft»; **Redraw** ne
    dà un altro; **Replace with an image** lo sostituisce con la schermata
    vera;
  - l'esportazione PDF e Word contiene lo schizzo come immagine, senza la
    sua etichetta.
- **Verità del prodotto**:
  - **il legame è con la pagina, non con la frase** (spec): «From the doc»
    nomina la pagina; la frase sta nella descrizione della richiesta;
  - **una voce già proposta non torna** (richiesta con lo stesso `pageId` e
    `anchorId`);
  - **la bozza è uno schizzo**: bianco e nero, fil di ferro, etichettato
    finché chi scrive non lo tiene;
  - la scheda è **B** (avvisa chi segue il backlog) come oggi; disegnare è
    **A** con «Undo» (decisione 3).

## 3. Direzione scelta

- **Tesi**: **i gesti di Claude vivono dove vive il gesto di chi scrive, e
  il risultato torna nella pagina**. Proporre le voci parte dalla pagina,
  si decide nel riquadro con la scheda che il team conosce, e torna in
  fondo alla pagina come un elenco di codici. Lo schizzo è un blocco della
  pagina come un'immagine, con una didascalia che dice chi l'ha disegnato
  **[PB 1]**.

### 3.1 Il gesto «Propose backlog items»

- **Nel «⋯» della pagina** **[PB 2]**, un gruppo nuovo dopo i gesti usciti
  dalla barra ([PS 10]) e **prima** di Copy link / Delete: `heading-group`
  **CLAUDE** e due voci, con l'anello fermo 14px a sinistra:
  - **Propose backlog items** / **Proponi le voci di backlog**;
  - **Draw this screen** / **Disegna questa schermata** (§3.6).
  *(scelta del costruttore: la barra non guadagna bottoni — è già piena a
  1024 — e il «⋯» c'è sempre.)*
- **Su un titolo di fase**: nel menu ⋮⋮ di un blocco **Heading 1/2/3**
  ([PE 4]), dopo «Comment», la voce **Propose backlog items from this
  section** / **Proponi le voci di backlog da questa sezione** (sezione =
  tutto ciò che sta sotto quel titolo fino al titolo dello stesso livello,
  decisione 4). Vale per ogni titolo, non solo in «Phases» *(scelta del
  costruttore: una «fase» è un titolo; il gesto non sa come si chiama la
  pagina)*.
- **Chi le vede**: chi ha `docs.edit` (chi legge soltanto ha nel «⋯» il
  solo Copy link, [PS 13], e nessun menu ⋮⋮). Il permesso del backlog lo
  controlla la scheda alla conferma, come oggi.
- **Spente** (voce con `aria-disabled` e la frase sotto, 12px `ink-muted`,
  come [PS 13]):
  - budget finito: «The monthly AI budget is used up» / «Il budget mensile
    per l'AI è esaurito» · **Who?** (`manageSettings`);
  - nessuna voce da proporre (`backlogCandidatesOf` vuota, nessuna nota):
    «No list items or to-dos on this page» / «Nessun elenco o lista di
    controllo in questa pagina» — senza «Who?» (è una regola);
  - dal titolo, sezione vuota: «No list items or to-dos in this section» /
    «Nessun elenco o lista di controllo in questa sezione».
- **Il clic**: il menu si chiude, si apre il **riquadro di Claude** (se era
  chiuso) col chip della pagina, e nella conversazione arriva la frase
  della persona «Propose backlog items from ACQ-D11 Phases» / «Proponi le
  voci di backlog da ACQ-D11 Phases» (o «…from the section “Phase 2” of
  ACQ-D11») e, sotto, la risposta di Claude con la scheda. **Il fuoco va al
  titolo della scheda** («Claude proposes · 5 requests»), non alla casella
  del riquadro *(scelta del costruttore: la scheda è ciò che chiede una
  decisione)*. Il gesto è anche una frase del riquadro (Task 8).
- **Tutte già proposte**: nessuna scheda; Claude risponde «Everything on
  this page is already in the backlog: **ACQ-R7**, **ACQ-R8**.» /
  «Tutto ciò che c'è in questa pagina è già nel backlog: **ACQ-R7**,
  **ACQ-R8**.» (i codici che chi guarda vede; gli altri non sono nominati,
  e restano contati: «…and 1 more» / «…e un'altra»).

### 3.2 La scheda in blocco (quella di oggi)

- È la scheda B di `createRequest` in blocco di `ProposalCard`, **invariata
  nella forma** ([CA], [SC 10]) **[PB 3]**:
  - intestazione «Claude proposes · 5 requests» / «Claude propone · 5
    richieste»;
  - una riga per voce, con la casella (tutte spuntate), il **titolo** della
    voce (la frase della pagina, senza segni);
  - sotto ogni riga, la **riga del perché** (`WhyLine`, 12px
    `ink-muted`): «From the page: “Customers download bills as PDF”» /
    «Dalla pagina: «Customers download bills as PDF»» — la frase intera,
    al più 2 righe con ellissi e `title`; e, se la pagina li dice, «·
    Urgency: high · Effort: M» / «· Urgenza: alta · Effort: M»;
  - dopo 5 righe «Show 3 more» / «Mostra altre 3» com'è oggi;
  - le righe dei motivi: «Notifies people who follow the backlog in ACQ»
    ([CA 4]) se c'è chi segue;
  - **le note sotto la scheda** (fuori dal contorno, come le note di 10b):
    «Already proposed from this page: **ACQ-R7**, **ACQ-R8**» / «Già
    proposte da questa pagina: **ACQ-R7**, **ACQ-R8**» (nota
    `already_proposed`; codici invisibili contati, non nominati);
  - bottoni Cancel · **Confirm 5** / «Confirm 4 of 5» come oggi; nessun
    «Edit» in blocco.
- **Senza il permesso del backlog**: la scheda di oggi col suo blocco e il
  suo «Who?» (area 2); Confirm spento con la frase.
- **Confermata**: «Done · 4 requests created» / «Fatto · 4 richieste
  create» con i codici e l'«Undo» del gruppo come oggi; in fondo alla
  pagina le voci compaiono subito (§3.3). Annullata: nulla cambia.
  - **Emendamento (7 nov 2026, P49):** dopo la conferma **non c'è
    «Undo»**: `createRequest` ha `undoable: false`, e la scheda B di oggi
    non lo offre. La scheda confermata dice «Done» coi codici delle
    richieste nate e «Can't be undone», come ogni scheda B senza inverso.
- Ogni descrizione creata cita la frase e il titolo della sezione:
  «From ACQ-D11 Phases › Phase 2: “Customers download bills as PDF”» —
  è testo della richiesta, si legge nella sua pagina.
  - **Emendamento (6 nov 2026, ruling del controller sul fix round 1 del
    Task 7: R-G5 prevale su questa riga).** La descrizione salvata è la
    sola frase della pagina, senza codice né titolo della pagina né della
    sezione: la legge anche chi la pagina non la vede (Docs spenti, senza
    `docs.view`). Il legame con la pagina è «From the doc: …» (§3.4),
    derivato a lettura e assente per chi non vede la pagina.

### 3.3 Le voci collegate in fondo alla pagina (`LinkedRequests`)

- Dopo l'ultimo blocco, separato da 32px e da un filetto `rule`: titolo
  `heading-group` **FROM THIS PAGE** / **DA QUESTA PAGINA** col numero
  (tnum) **[PB 4]**.
- Righe 32px: codice della richiesta (`CodeLink`, 600 tnum) · titolo ·
  a destra, 12px `ink-faint`, le task nate: «→ **ACQ-21**, **ACQ-22**»
  (al più 2 e «+N»), o lo stato della richiesta («Open» / «Aperta»,
  «Converted» / «Convertita») se non ce ne sono.
- Solo ciò che chi guarda vede (`listProductLinkedRequests`); nessuna voce
  visibile → la sezione **non c'è**. Non entra nell'esportazione, non si
  modifica da qui, non ha «Who?».
- Sta **fuori** dall'editor (non è un blocco): la tastiera la raggiunge
  con Tab dopo il corpo; il clic su un codice apre la richiesta o il
  pannello della task.
- Volumi: 0–40 righe; oltre 10 «Show all 23» / «Mostra tutte e 23».

### 3.4 «From the doc: <page>» su richiesta e task

- **Pagina della richiesta** (`RequestDetail`), nella sezione **Where it
  comes from** / **Da dove nasce** (quella di `RequestOrigin`), una riga
  13px `ink-muted`: «From the doc: **ACQ-D11** Phases» / «Dalla doc:
  **ACQ-D11** Phases» (`CodeLink` col nome). Una richiesta nata da una
  domanda di Claude dice lo stesso **[PB 5]**.
- **Pannello e pagina della task** (`LinksSection`): sotto la riga di
  «Origin request» / «Richiesta d'origine», la stessa riga «From the doc:
  **ACQ-D11** Phases». Una task senza richiesta d'origine non la ha.
- La riga porta alla pagina (`#/p/ACQ/docs/product/ACQ-D11`).
- **Pagina invisibile** per chi guarda (Docs spenti, eliminata,
  `productOriginOf` nullo): la riga **non c'è**, nessun codice tenue
  (R-G5; una pagina non è un oggetto che si può chiedere) *(scelta del
  costruttore)*.
- A 1024 la riga va a capo dopo «From the doc:».

### 3.5 Il blocco bozza di schermata (`WireframeBlock`)

- **Forma** **[PB 6]**: un blocco della pagina a tutta colonna, come
  l'immagine ([PE 9]): bordo 1px `rule`, raggio 8, fondo `surface`.
  - **Testata** 32px dentro il bordo, filetto sotto, 12px: l'anello fermo
    12px · «Claude's draft» / «Bozza di Claude» 600 `ink` · « · Screen
    sketch» / « · Bozza di schermata» `ink-muted`; a destra, per chi
    scrive, al passaggio o al fuoco: **Keep** / **Tieni** · **Redraw** /
    **Rifai** · **Replace with an image** / **Sostituisci con
    un'immagine** (bottoni testo).
  - **Lo schizzo**: l'SVG del seme, linee 1.5px in `currentColor` = `ink`,
    nessun riempimento colorato, testi segnaposto in grigio `ink-faint`;
    in tema scuro le stesse linee chiare sul fondo scuro (bianco e nero
    resta bianco e nero). Larghezza della colonna, altezza al più 360
    (`contain`), padding 16.
  - **Nome accessibile**: «Claude's draft: sketch of the booking screen» /
    «Bozza di Claude: schizzo della schermata di prenotazione» (dal
    `keywords` del disegno), `role="img"`.
- **Nessun segno a margine** sul blocco: l'etichetta «Claude's draft» è il
  suo segno finché qualcuno non la tiene. Il livello dati non dà segni per
  i blocchi `wireframe` (da allineare nel Task 3) *(scelta del
  costruttore)*.
- **Keep** / **Tieni** *(maintainer, 6 nov 2026)* **[PB 8]**: toglie
  l'etichetta, e da lì lo schizzo **è una figura come le altre**: bordo 1px
  `rule`, raggio 8, nessuna testata, nessun anello. Per chi scrive, al
  passaggio o al fuoco, in alto a destra dentro il bordo restano
  **Redraw** e **Replace with an image** (piccoli, `ink-muted`), come il
  «⋯» della tabella. Il nome accessibile diventa «Screen sketch: …» /
  «Bozza di schermata: …».
  - Chiede `docs.edit`. Senza (permesso perso fra lettura e clic, o un
    «vedi come» con chi scrive ma non qui): bottone spento con la frase
    12px sotto la testata «Keeping it is for people with Edit docs in ACQ ·
    Who?» / «Tenerla è di chi ha Modifica Docs in ACQ · Chi?»
    (`WhoCanLink`, `editDocs`). Chi legge soltanto non ha bottoni (sotto).
  - Lascia una revisione della **persona** (nessun «Claude on behalf
    of»): in cronologia «Laura Costa · Kept the screen sketch» / «Ha tenuto
    la bozza di schermata», con **Undo** / **Annulla** nella riga e gli
    stati di [PM 6] (spento con «Marco Bellini edited it afterwards» se lo
    schizzo è stato rifatto o sostituito dopo). «Undo» riporta
    l'etichetta.
  - In corso «Keeping…» / «Tengo…»; un doppio clic fa una sola scrittura.
    Fatto: annuncio `polite` «Kept · the sketch is now a figure of the
    page» / «Tenuta · ora è una figura della pagina»; il **fuoco** va al
    blocco, scelto come oggetto ([PE 5]). Errore: «Couldn't keep it ·
    Retry» / «Non sono riuscito a tenerla · Riprova», `role="alert"`.
  - **Redraw dopo Keep** rimette l'etichetta: lo schizzo nuovo è di nuovo
    una bozza di Claude, da tenere di nuovo.
- **Redraw**: la variante seguente (`redrawWireframeAs`), sul posto. In
  corso «Redrawing…» / «Ridisegno…» al posto dei bottoni e l'anello che
  pulsa nella testata; finito, lo schizzo nuovo in dissolvenza 150ms;
  annuncio `polite` «New sketch» / «Nuovo schizzo»; il fuoco resta su
  «Redraw». Lascia una revisione (cronologia: «Claude on behalf of Laura
  Costa · Redrew the screen sketch» / «Ha rifatto la bozza di
  schermata»). Errore: «Couldn't redraw · Retry» in riga, `role="alert"`.
- **Replace with an image**: la scelta del file del sistema (come «/image»);
  l'immagine prende **il posto** del blocco (stesso punto, blocco immagine
  con «Add a caption» e il fuoco sulla didascalia). Annullata la finestra:
  niente. Rifiuti come [PE 9] («larger than 5 MB», formati), sotto il
  blocco, la bozza resta.
- **Eliminare**: dal menu ⋮⋮ («Delete», come ogni blocco) o Esc + Canc
  ([PE 5]); ⌘Z dell'editor la riporta.
- **Chi legge soltanto**: testata con la sola etichetta (tenuta, la sola
  figura), nessun bottone,
  nessun «Who?» (come un'immagine, che non ha gesti per chi legge).
- **Disegno sconosciuto** (`wireframeId` non nel seme, dati vecchi): il
  riquadro col bordo e, al centro, 13px `ink-muted` «This sketch is no
  longer available» / «Questo schizzo non è più disponibile»; «Redraw»
  resta per chi scrive.

```
1440 · VRD, «Booking» (Laura), bozza appena disegnata ─────────────────────────────
│    │   Booking                                                                  │
│    │   The user picks a class, a time and pays with a card.                     │
│    │ ┌──────────────────────────────────────────────────────────────────────┐   │
│    │ │ ◌ Claude's draft · Screen sketch        Redraw  Replace with an image │   │
│    │ ├──────────────────────────────────────────────────────────────────────┤   │
│    │ │   ┌────────────────────────────┐                                      │   │
│    │ │   │ ▭▭▭▭  Classes   ⌕          │                                      │   │
│    │ │   │ [Yoga 18:00] [Pilates 19:…]│                                      │   │
│    │ │   │ ── time slots ──           │                                      │   │
│    │ │   │ [ Pay  ]                   │                                      │   │
│    │ │   └────────────────────────────┘                                      │   │
│    │ └──────────────────────────────────────────────────────────────────────┘   │
```

### 3.6 Disegnare: «/» e «Draw this screen»

- **Nel menu «/»** **[PB 7]**: in **INSERT** / **INSERISCI**, dopo
  «Decision», la voce **Screen sketch** / **Bozza di schermata** (glifo:
  un riquadro a fil di ferro), parole chiave «sketch, wireframe, screen,
  mockup» / «bozza, schizzo, schermata, wireframe». Sceglierla mette la
  bozza **al posto** del paragrafo vuoto da cui si è digitato «/».
- **Nel «⋯»** (gruppo CLAUDE, §3.1): **Draw this screen** mette la bozza
  **dopo il blocco che aveva il cursore** per ultimo, o in fondo alla
  pagina se nessuno l'ha avuto.
- **Mentre Claude disegna** (il copione ha un attimo d'attesa): al posto
  della bozza un riquadro della stessa forma alto 160, con l'anello che
  pulsa e «Claude is sketching…» / «Claude sta disegnando…»; poi lo
  schizzo. Il **fuoco** va al blocco nuovo, scelto come oggetto (anello di
  fuoco, [PE 5]), e scorre in vista. Annuncio `polite` «Sketch added» /
  «Bozza aggiunta».
- **Spente**:
  - budget finito: nel menu «/» la voce è spenta con la frase 12px «The
    monthly AI budget is used up» sotto il nome (nessun «Who?» dentro una
    `listbox`: il menu non ha link); nel «⋯» la stessa frase col «Who?»;
  - chi legge soltanto: né «/» né «⋯» con la voce.
- **Dal riquadro** («draw this screen» con la pagina nel chip): azione A,
  la riga eseguita «✓ Drew a screen sketch in **ACQ-D9** Screens · Undo» /
  «✓ Disegnata una bozza di schermata in **ACQ-D9** Screens · Annulla
  l'azione» ([CA]); «Undo» toglie il blocco, con gli stati di
  `UndoControl` («changed afterwards» se qualcuno l'ha rifatto o
  sostituito).
- Il riquadro non ruba il fuoco alla pagina e viceversa: dal «⋯» e da «/»
  il fuoco resta nella pagina.

### 3.7 Esportazione

- PDF e Word: lo schizzo entra **come immagine** (PNG per il Word,
  `svgToPng`; il PDF lo stampa com'è), a tutta larghezza. Uno schizzo
  **mai tenuto** ha sotto l'etichetta, in corsivo 10pt, «Claude's draft ·
  Screen sketch» / «Bozza di Claude · Bozza di schermata»; uno **tenuto**
  esce senza etichetta, come le altre figure *(maintainer, 6 nov 2026)*.
  La testata con i bottoni non c'è mai. Le voci «From this page» non
  entrano. Nessun segno a margine (spec).
- Nel tema scuro l'esportazione usa comunque linee nere su bianco.

## 4. Ambito e confini

- **Dentro**: i gesti nel «⋯» e sul titolo, la scheda con la frase e la
  nota, le voci in fondo alla pagina, «From the doc», il blocco bozza, «/»,
  «Draw this screen», l'esportazione.
- **Fuori**: le frasi del riquadro per gli altri sotto-casi (Task 8); le
  fasi come milestone (non obiettivo della spec); la bozza come design
  modificabile.
- **Anti-obiettivi**:
  - colori, ombre, fotografie o testo vero del cliente nello schizzo;
  - una voce proposta due volte dalla stessa frase;
  - «From the doc» col nome di una pagina che chi guarda non vede;
  - un bottone nuovo nella barra della pagina;
  - un segno a margine sopra l'etichetta della bozza;
  - uno schizzo tenuto che conserva l'etichetta, o uno rifatto che non la
    riprende.

## 5. Stati e intervalli, 1440 e 1024

- **Volumi**: 0–40 candidate per pagina (la scheda ne mostra 5, poi «Show
  N more»); frasi fino a 300 caratteri (titolo della richiesta tagliato a
  120 con «…», frase intera nella descrizione); 0–6 bozze per pagina, 1–4
  varianti per disegno.
- **1440**: il riquadro di Claude (400) si apre **sopra** l'area di lavoro
  ([CP 11]); con la colonna dei commenti agganciata, la copre senza
  rifletterla; la pagina resta viva sotto, e le voci compaiono in fondo
  alla pagina mentre il riquadro è aperto.
- **1024**: il riquadro è 360, a sinistra di ciò che è aperto a destra
  ([PE 22]); i gesti di Claude **non** aprono la colonna dei commenti. La
  testata della bozza va su due righe (l'etichetta sopra, i bottoni
  sotto, a sinistra) quando non ci sta; lo schizzo scala con la colonna.
- **Errore** della scheda: come oggi («Couldn't do it… Nothing was
  changed.»). **Errore** di lettura delle voci collegate: la riga «Couldn't
  load the linked requests · Retry» al posto della sezione.
- **Cambio di persona**: la scheda è della persona che l'ha chiesta (non
  nel DOM di Sara); «From this page» e «From the doc» si rileggono.

## 6. Tastiera e fuoco (riepilogo)

| Gesto | Dove va il fuoco |
|---|---|
| «⋯» → Propose backlog items | il titolo della scheda nel riquadro |
| ⋮⋮ di un titolo → Propose… from this section | idem |
| scheda chiusa (Cancel, Esc nel riquadro) | il riquadro come oggi ([CP]); chiuso il riquadro, il «⋯» o il titolo da cui è partito |
| «/» → Screen sketch, «⋯» → Draw this screen | la bozza nuova, scelta come oggetto |
| Redraw | resta su «Redraw» |
| Replace with an image | la didascalia del blocco immagine |
| voce spenta nel menu | resta nel menu, sulla voce (la frase è nel suo `aria-describedby`) |

Mai il body. La sezione «From this page» è una `region` col suo titolo;
la bozza un `figure` con `figcaption` = l'etichetta.

## 7. Movimento

- Riquadro come oggi (200ms); schizzo nuovo in dissolvenza 150ms; anello
  che pulsa mentre disegna; righe nuove di «From this page» in dissolvenza
  150ms.
- **Movimento ridotto**: niente dissolvenze, l'anello è fermo e la parola
  «sketching…» porta lo stato.

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| gesti | Claude · Propose backlog items · Propose backlog items from this section · Draw this screen | Claude · Proponi le voci di backlog · Proponi le voci di backlog da questa sezione · Disegna questa schermata |
| spenti | The monthly AI budget is used up · No list items or to-dos on this page · No list items or to-dos in this section | Il budget mensile per l'AI è esaurito · Nessun elenco o lista di controllo in questa pagina · Nessun elenco o lista di controllo in questa sezione |
| richiesta della persona | Propose backlog items from {{code}} {{title}} · …from the section “{{section}}” of {{code}} | Proponi le voci di backlog da {{code}} {{title}} · …dalla sezione «{{section}}» di {{code}} |
| scheda | From the page: “{{sentence}}” · Urgency: {{u}} · Effort: {{e}} · Already proposed from this page: {{codes}} · Everything on this page is already in the backlog: {{codes}} | Dalla pagina: «{{sentence}}» · Urgenza: {{u}} · Effort: {{e}} · Già proposte da questa pagina: {{codes}} · Tutto ciò che c'è in questa pagina è già nel backlog: {{codes}} |
| in fondo | From this page · Show all {{count}} · Couldn't load the linked requests · Retry | Da questa pagina · Mostra tutte e {{count}} · Voci collegate non caricate · Riprova |
| origine | From the doc: {{code}} {{title}} | Dalla doc: {{code}} {{title}} |
| bozza | Claude's draft · Screen sketch · Redraw · Replace with an image · Redrawing… · New sketch · Couldn't redraw · Claude is sketching… · Sketch added · This sketch is no longer available | Bozza di Claude · Bozza di schermata · Rifai · Sostituisci con un'immagine · Ridisegno… · Nuovo schizzo · Non sono riuscito a ridisegnarla · Claude sta disegnando… · Bozza aggiunta · Questo schizzo non è più disponibile |
| cronologia | Drew a screen sketch · Redrew the screen sketch | Ha disegnato una bozza di schermata · Ha rifatto la bozza di schermata |
| riquadro | Drew a screen sketch in {{code}} {{title}} | Disegnata una bozza di schermata in {{code}} {{title}} |
| tenere | Keep · Keeping… · Kept · the sketch is now a figure of the page · Keeping it is for people with Edit docs in {{code}} · Couldn't keep it · Kept the screen sketch | Tieni · Tengo… · Tenuta · ora è una figura della pagina · Tenerla è di chi ha Modifica Docs in {{code}} · Non sono riuscito a tenerla · Ha tenuto la bozza di schermata |
| esportazione | Claude's draft · Screen sketch (solo se mai tenuta) | Bozza di Claude · Bozza di schermata (solo se mai tenuta) |

## 9. Vincoli

- Nessun `can(` in `pages/productDocs/`: i gesti leggono
  `permissions.edit` e lo stato del budget dalla vista; la scheda legge
  `cls`, `reasons`, `notes` come oggi.
- La scheda in blocco non cambia componente: le righe del perché e le note
  sono i campi di oggi (`why`, `notes`) riempiti dal livello dati.
- Gli SVG sono del seme (`PRODUCT_WIREFRAMES`), solo `currentColor`;
  nessun colore letterale.
- Scatti `a11b-backlog-*` (menu, scheda, nota, voci in fondo, «From the
  doc» su richiesta e task, 1024) e `a11b-wireframe-*` (bozza, in
  disegno, Sara, «/», sostituita, chiaro e scuro).

## Decisioni del maintainer (6 nov 2026)

1. **L'etichetta della bozza si toglie con «Keep» / «Tieni»** *(maintainer,
   6 nov 2026)*: il bottone toglie «Claude's draft» / «Bozza di Claude» e
   lo schizzo diventa una figura come le altre. Chiede `docs.edit` (spento
   con la frase e il «Who?»), si annulla dalla cronologia, e un «Redraw»
   dopo «Keep» rimette l'etichetta. All'esportazione uno schizzo mai
   tenuto esce con l'etichetta, uno tenuto senza. → §3.5 [PB 8], §3.7.

Le altre scelte marcate *(scelta del costruttore)* sono da approvare col
brief.

## Emendamenti del Task 12 (7 nov 2026, scelte del costruttore)

- **Il seme di Phases ha tre voci da proporre, non cinque**: due delle
  cinque (la fase 2) sono già richieste del seme, e la nota lo dice. Gli
  esempi «5 requests» / «Confirm 4» di §2 e §3.2 restano illustrativi.
- **«Keep» rifiutato dal livello dati** (`forbidden`) mentre la vista dice
  ancora «scrive»: il bottone resta, spento, col fuoco su di sé, e sotto la
  testata la frase «Keeping it is for people with Edit docs in ACQ · Who?».
  Quando invece la lettura nuova arriva (il permesso perso davvero), la
  pagina torna in sola lettura con la sua riga e il suo «Who?» ([PS 13]), i
  bottoni della bozza se ne vanno e il fuoco va al titolo della pagina: mai
  sul body. Vale per ogni controllo dell'editor, non solo per la bozza.
- **Il nome accessibile si compone per disegno** (`wireframeId`: booking,
  membership, bills, sign-in, schizzo generico), non per variante: le
  varianti sono la stessa schermata disegnata di nuovo, e «New sketch» lo
  annuncia.
- **Un disegno che non riesce** (`drawWireframe` rifiutato, «/» su un
  paragrafo che nel frattempo ha del testo) e **una sostituzione che non
  riesce** lo dicono con un avviso («Couldn't draw the sketch. Nothing was
  changed.» / «Couldn't replace it»); il fuoco resta sul blocco. I rifiuti
  del file (formato, 5 MB) usano la riga di [PE 9] sotto la bozza, come
  dice §3.5.
- **«Draw this screen» nel «⋯»** è spenta col budget finito con la frase e
  il «Who?», come «Propose backlog items»; per chi legge soltanto il
  gruppo CLAUDE non c'è.
- **«From the doc:»** usa `CodeLink` col nome della pagina: il codice 600
  e il titolo, sottolineati insieme.
