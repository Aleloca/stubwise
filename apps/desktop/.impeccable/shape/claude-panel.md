# Shape brief — Il riquadro di Claude (da ogni pagina)

> Shape scritto dal controller senza intervista (2 nov 2026): le domande di
> discovery non sono state fatte al maintainer. Dove design e piano non
> bastavano la scelta è marcata **scelta del controller** e numerata
> **[CP n]** in fondo. Valgono come scritte le decisioni del maintainer del
> 2 nov 2026 (spec area 10, «Il riquadro»): sempre a portata, sopra la
> pagina a destra, la pagina resta viva, Esc o la scorciatoia chiudono senza
> perdere niente, è la conversazione libera dell'area 3, sa cosa stai
> guardando.

Superficie:
- `layout/claudePanel/ClaudePanel.tsx` (host montato una volta in
  `AppLayout`), `ContextChip.tsx`;
- il bottone fisso in fondo al binario (`layout/Rail.tsx`);
- ⌘J / Ctrl+J (`layout/useShortcuts.ts`) e «Ask Claude: …» di ⌘K
  (`palette/commands.ts`);
- il flusso dentro il riquadro è `Conversation` (vedi `conversation.md`,
  variante pannello); righe eseguite, schede per classe e righe D sono in
  `claude-actions.md`.

Piano 10a: Task 8 (dati: Task 5 e 7). Spec area 10: parte 1 «Il
riquadro» (tranne «Le pagine che si possono riempire», 10b), «Stati del
riquadro», «Quanto è vero nel prototipo». Mondo: «Catalogo numerato»,
modalità **Operate** con un tratto di **Read** (il testo di Claude).

## 1. Lavoro e pubblico

- **Chi**: chiunque, mentre lavora su una pagina. Giulia su Tasks di MKX
  con MKX-31 aperta nel pannello («spostala alla prossima settimana»);
  Roberta su All projects («archivia OLV»); Laura su Settings → AI di ACQ
  («spegni il brief settimanale»); Sara che chiede una cosa che non può
  fare.
- **Stato d'animo**: è nel mezzo di un lavoro. Non vuole cambiare pagina né
  perdere il filtro, lo scorrimento o il testo che stava scrivendo. Vuole
  una risposta corta e, se Claude fa qualcosa, vederlo e poterlo annullare.

## 2. Esito e prova

- **Azione primaria**: aprire (⌘J o il bottone del binario), scrivere,
  leggere la risposta o la riga di ciò che Claude ha fatto, chiudere.
- **Successo**, a 1440×900:
  - da Tasks di ACQ con ACQ-14 nel pannello premo ⌘J: il riquadro si apre
    accanto al pannello della task, il fuoco è nella casella, il chip dice
    «You're looking at: ACQ-14 · task»; scrivo, Claude risponde; premo Esc:
    il riquadro si chiude, il fuoco torna dov'era, la lista e il pannello
    sono come li avevo lasciati; ⌘J: ritrovo la conversazione e il testo non
    inviato;
  - col riquadro aperto scrivo nel filtro di Tasks: la pagina sotto
    risponde;
  - la conversazione nata dal riquadro è in Claude → Mine, privata.
- **Verità del prodotto**:
  - **il riquadro è la conversazione libera**: stesse regole, stesso
    componente, stessa privacy;
  - **il contesto è un riferimento, non un contenuto**: il chip si rilegge
    con la visibilità di chi guarda; un oggetto diventato invisibile non ha
    chip, e Claude risponde «Can't find ACQ-14» come per un codice che non
    esiste;
  - **Claude agisce come chi chiede**: la casella non promette più «nothing
    without your confirmation» (con la classe A non è più vero, vedi
    [CP 9]).

## 3. Direzione scelta

- **Tesi**: **una colonna di lettura agganciata a destra**, che sta sopra
  l'area di lavoro come il pannello delle notifiche, senza ombra e con un
  filetto `rule-strong` a sinistra. È un pannello della pagina che rimane,
  non un popover che passa (Hairline-Not-Shadow Rule) **[CP 1]**.
- **Larghezza**: 400px da 1440px in su, 360px sotto. Fissa, non
  trascinabile nel 10a **[CP 2]**.
- **Altezza**: tutta la finestra, sotto la regione di trascinamento (i 36px
  dei semafori di macOS restano liberi).
- **Sequenza dall'alto**: testata (48px) → riga del chip (36px, filetto
  sotto) → flusso (scorre) → casella fissa in fondo.

### Testata

- A sinistra il **titolo della conversazione** (14px, 600, una riga con
  ellissi, `title` intero); per una conversazione nuova «New conversation» /
  «Nuova conversazione».
- A destra tre bottoni icona da 32px, con nome accessibile e tooltip:
  - **New** / **Nuova** (+): apre il compositore vuoto; la conversazione di
    prima resta in Claude → Mine;
  - **Open in Claude** / **Apri in Claude** (↗): porta la stessa
    conversazione a `#/claude/<id>` e chiude il riquadro; spento finché la
    conversazione non esiste (compositore vuoto), con il tooltip «Start the
    conversation first» / «Prima inizia la conversazione»;
  - **Close** / **Chiudi** (×), tooltip «Close · ⌘J» / «Chiudi · ⌘J».

### Il chip del contesto

- Riga 36px sotto la testata, 13px: «You're looking at:» / «Stai
  guardando:» in `ink-muted`, poi il **chip** (bordo `rule`, raggio 6px,
  24px): **codice** 600 in cifre tabellari + tipo in parola, e la × (nome
  accessibile «Don't use this page» / «Non usare questa pagina»).
- Le forme del chip (da `describeContext`):

| Contesto | en | it |
|---|---|---|
| task | ACQ-14 · task | ACQ-14 · task |
| richiesta | ACQ-R3 · request | ACQ-R3 · richiesta |
| supporto | ACQ-S4 · support conversation | ACQ-S4 · conversazione di supporto |
| PR | ACQ · pull request #42 | ACQ · pull request #42 |
| automazione | ACQ-A3 · automation | ACQ-A3 · automazione |
| rilascio | ACQ-R12 · release | ACQ-R12 · rilascio |
| impostazioni di progetto | ACQ · Settings → AI | ACQ · Impostazioni → AI |
| impostazioni d'istanza | Administration → Models | Amministrazione → Modelli |
| pagina con progetto | ACQ · Tasks | ACQ · Task |
| pagina senza progetto | Home | Home |

- Il chip **non è un link**: è il riferimento che parte col messaggio. Il
  `title` dice «Claude reads ACQ-14 with your permissions when you send.» /
  «Claude legge ACQ-14 con i tuoi permessi quando invii.»
- **× toglie il contesto** per i messaggi successivi: la riga diventa
  «Not using this page · Use it» / «Non uso questa pagina · Usala» (13px
  `ink-faint`, «Use it» è un bottone testo che lo rimette) **[CP 3]**.
  Cambiando pagina il chip torna da solo, col contesto nuovo.
- **Cambiando pagina** il chip si aggiorna (dissolvenza 150ms). I messaggi
  già inviati tengono il loro contesto: sotto ognuno, nella riga del nome,
  12px `ink-faint` «· on ACQ-14» / «· su ACQ-14» (codice in testo, non link)
  **[CP 4]**.
- **Oggetto invisibile o inesistente** (`describeContext` → `null`): la riga
  del chip non c'è, nessuna frase al suo posto. Nessun «non puoi vederlo»
  (R-G5).

### Il bottone del binario

- **In fondo al binario**, primo del gruppo sotto il filetto, **sopra**
  Notifiche: il segno di Claude, l'anello tratteggiato 2px su 20px, ink
  `ink-muted` a riposo **[CP 5]**.
- Tooltip (250ms) «Ask Claude · ⌘J» / «Chiedi a Claude · ⌘J»; nome
  accessibile «Ask Claude» / «Chiedi a Claude»; `aria-expanded` e
  `aria-controls` sul riquadro.
- **Aperto**: tinta d'inchiostro 10% e ink pieno, come la pagina corrente;
  l'anello resta fermo.
- **Chiuso mentre Claude risponde** (stream in corso nel riquadro nascosto):
  l'anello pulsa come «Claude working» (1 → 0.3 in 1.8s; fermo con
  movimento ridotto) e il nome accessibile diventa «Ask Claude — Claude is
  answering» / «Chiedi a Claude — Claude sta rispondendo». A risposta
  finita, il punto pieno «ti aspetta» in alto a destra finché non si riapre
  **[CP 6]**.
- Il destination «Claude» in alto nel binario non cambia: è la pagina
  intera; questo bottone è il riquadro.

### La scorciatoia

- **⌘J** su macOS, **Ctrl+J** su Windows, definitiva: Electron non la
  prende (il menu di `src/main/menu.ts` usa ⌘K e ⌘, ; gli strumenti di
  sviluppo sono ⌥⌘I) e il prototipo non la usa (⌘K, ⌘N, ⌘⇧H, ⌘1…9 sono
  presi; J/K senza modificatori restano la navigazione delle liste).
- Apre e chiude da qualunque pagina, anche con il fuoco in un campo della
  pagina; **non** scatta mentre è aperto un dialogo modale (palette,
  riconferma, dialoghi): lì il tasto è del dialogo.
- **Scelta del controller**: la voce «Ask Claude… ⌘J» / «Chiedi a Claude…
  ⌘J» entra anche nel menu dell'app accanto a «Search… ⌘K», così la
  scorciatoia si scopre dal menu **[CP 7]**.

### La conversazione vuota

Compositore nuovo (prima apertura, o dopo **New**):
- titolo 16px 600 «Ask Claude» / «Chiedi a Claude»;
- prosa 14px `ink-muted`, due frasi:
  - «Ask about what you're looking at, or ask Claude to do it for you.» /
    «Chiedi di ciò che stai guardando, o chiedi a Claude di farlo per te.»
  - «What only touches you happens right away and can be undone; anything
    that touches others asks you first.» / «Ciò che tocca solo te parte
    subito e si annulla; ciò che tocca altri ti chiede prima.»
- `heading-group` **TRY** / **PROVA** e tre righe di testo (32px) che
  **scrivono nella casella senza inviare**, scelte dal contesto **[CP 8]**:
  - con una task nel chip: «Summarize ACQ-14» / «Riassumi ACQ-14» · «Plan
    ACQ-14 for next week» / «Pianifica ACQ-14 per la prossima settimana» ·
    «Who's waiting on ACQ-14?» / «Chi aspetta ACQ-14?»;
  - con un progetto: «Where does ACQ stand?» / «A che punto è ACQ?» ·
    «What's stalled in ACQ?» / «Cosa è fermo in ACQ?» · «Create a task in
    ACQ…» / «Crea una task in ACQ…»;
  - senza contesto: le tre dell'atterraggio di oggi («What should I do
    today?», «Where do my projects stand?», «Explain <codice>»).
- La casella: segnaposto «Ask Claude…» / «Chiedi a Claude…», suggerimento
  «Enter to send · Shift+Enter for a new line».

```
1440 ── Tasks di ACQ, pannello della task aperto, riquadro aperto ─────────────────────────
│rail│ column 240 │ work area (vivo)        │ Claude 400              │ task panel 360   │
│    │ ACQ        │ Tasks              ▾    │ Brief ACQ-14       + ↗ ×│ ACQ-14           │
│    │ Overview   │ Filter… [   ]           │ You're looking at:      │ Fix bill download│
│    │ Tasks   42 │ ACQ-12 Login copy       │ [ACQ-14 · task ×]       │ Laura Costa · W45│
│    │ Board      │ ACQ-14 Fix bill dow…    │ ─────────────────────── │ DESCRIPTION      │
│    │ …          │ ACQ-15 Export CSV       │ GIULIA FERRI · on ACQ-14│ …                │
│    │            │ …                       │ ░ Move it to next week ░│ CLAUDE           │
│    │            │                         │ (CL) Claude · 10:41     │ …                │
│    │            │                         │ ✓ Moved ACQ-14 to W46   │                  │
│    │            │                         │   · Undo                │                  │
│ ◌  │            │                         │ ┌─────────────────────┐ │                  │
│ ◍  │            │                         │ │ Ask Claude…         │ │                  │
│ ⌕  │            │                         │ └─────────────────────┘ │                  │
```

## 4. Convivenza col pannello della task (`useDetailPanel`)

Una regola sola a ogni larghezza: **il pannello della task sta sempre al
bordo destro; il riquadro di Claude sta subito alla sua sinistra**, sopra
l'area di lavoro **[CP 10]**. Così il chip «ACQ-14 · task» e la task che
nomina restano entrambi a vista.

| Finestra | Pannello della task | Riquadro di Claude | Cosa resta a vista |
|---|---|---|---|
| **1440** | agganciato, 360 (o la larghezza scelta, 320–640) | 400, sopra l'area di lavoro, a sinistra del pannello | colonna intera + ~376px dell'area di lavoro (filtro, codici e titoli delle righe) |
| **1200** | agganciato, 360 | 360, a sinistra del pannello | colonna + ~176px dell'area di lavoro (il filtro) |
| **1024** | sovrapposto, 400 | 360, a sinistra del pannello sovrapposto | binario + colonna (240); l'area di lavoro è coperta ma montata |
| **800** | sovrapposto | 360 | **non stanno insieme**: vince l'ultimo aperto; l'altro resta montato dietro e torna a vista chiudendo il primo |

- **Chi vince il tasto Esc**: chi ha il fuoco. Esc nel riquadro chiude il
  riquadro; Esc nel pannello della task chiude il pannello (come oggi);
  dentro il riquadro, prima si chiudono i menu «#», «@», «/», poi il
  riquadro.
- **Chi sta sopra** (z-order): riquadro sopra il pannello sovrapposto, e
  sotto palette, dialoghi, riconferma e toast. Le notifiche (400px dal
  bordo destro) coprono entrambi finché sono aperte.
- **Con le route che forzano il sovrapposto** (Planning): stessa regola
  della riga 1024.
- Il riquadro **non stringe** l'area di lavoro: la copre. Il suo contenuto
  non si riflette e non perde lo scorrimento **[CP 11]**.
- Planning e Board a 1440 restano usabili sulla parte scoperta; chi vuole
  la pagina intera chiude il riquadro (⌘J) e lo ritrova com'era.

```
1024 ── stessa situazione ────────────────────────────────────────────────
│rail│ column 240 │ Claude 360               │ task panel 400 (overlay) │
│    │ ACQ        │ Brief ACQ-14        + ↗ ×│ ACQ-14 Fix bill download │
│    │ Overview   │ You're looking at:       │ Laura Costa · W45 · M    │
│    │ Tasks   42 │ [ACQ-14 · task ×]        │ DESCRIPTION              │
│    │ …          │ ──────────────────────── │ …                        │
│    │            │ GIULIA FERRI · on ACQ-14 │                          │
│    │            │ ░ Move it to next week  ░│                          │
│    │            │ ✓ Moved ACQ-14 to W46    │                          │
│    │            │   · Undo                 │                          │
│ ◌  │            │ ┌──────────────────────┐ │                          │
│    │            │ │ Ask Claude…          │ │                          │
```

## 5. Ambito e confini

- **Dentro**: apertura (⌘J, binario, ⌘K), chiusura (Esc, ⌘J, ×), testata,
  chip, conversazione vuota, convivenza col pannello, stati, «vedi come»,
  memoria dell'ultima conversazione.
- **Fuori** (10b o altrove): le righe «Claude can help you…» e i campi
  riempibili; la bozza nei campi col segno «Claude's draft»; «Back to
  <page>» dopo l'apertura del costruttore; il ridimensionamento a
  trascinamento.
- **Anti-obiettivi**: perdere il testo non inviato chiudendo; smontare la
  conversazione; un chip che nomina un oggetto che chi guarda non vede; la
  bozza di Giulia visibile dopo il passaggio a Sara; una scheda di Giulia
  confermabile da Sara; un'ombra da popover su un pannello che resta;
  stringere l'area di lavoro.

## 6. Stati e intervalli

Valgono quelli della conversazione dell'area 3 (`conversation.md`, variante
pannello: niente colonna avatar, gruppi d'azione sempre chiusi, bottoni
delle schede che vanno a capo). In più:

- **In diretta**: il testo cresce nel riquadro anche quando è chiuso; il
  bottone del binario pulsa ([CP 6]). Riaprendo si è in fondo, o sulla
  pillola «New messages ↓» se si era scorso su.
- **Caricamento** dell'ultima conversazione: testata con il titolo, tre
  righe scheletro nel flusso, casella già scrivibile.
- **Errore di caricamento**: nel flusso «Couldn't load this conversation.» /
  «Impossibile caricare questa conversazione.» · **Retry** / **Riprova** ·
  **New** / **Nuova**; testata e casella restano.
- **Budget mensile esaurito** (9b): la casella è sostituita da una fascia
  13px con ▲ `warning`: «The monthly AI budget is used up: Claude can't
  answer until it's raised or the month ends.» / «Il budget mensile per
  l'AI è esaurito: Claude non può rispondere finché non viene alzato o non
  finisce il mese.» · **Who?** (`WhoCanLink`, azione `manageSettings`,
  d'istanza). Il testo già scritto resta nella fascia, in sola lettura, e
  torna nella casella quando il budget c'è di nuovo **[CP 12]**. Nessun
  invio parte.
- **Coda del progetto in pausa** (9b): il riquadro risponde come sempre.
  Solo il lavoro che farebbe partire entra in coda, e la sua riga lo dice
  (`claude-actions.md`).
- **Sola lettura**: la conversazione dell'ultima volta è stata archiviata o
  eliminata dalla destinazione → il riquadro apre il compositore vuoto, con
  una riga 13px `ink-faint` in cima «Your last conversation was archived.» /
  «La tua ultima conversazione è stata archiviata.» (eliminata: niente
  frase). Le altre sole letture dell'area 3 (finita, interrotta) mostrano la
  fascia col motivo, come a pagina intera.
- **«Vedi come» appena cambiato**: il riquadro rinasce con la persona nuova
  (chiave per persona): la sua ultima conversazione o il compositore vuoto.
  In cima, per 4 secondi e finché non si scrive, una riga 13px `ink-muted`:
  «Now showing Sara Montanari's conversations.» / «Ora vedi le conversazioni
  di Sara Montanari.» **[CP 13]**. Nessun evento, scheda o testo non inviato
  di Giulia resta nel DOM. Il riquadro resta aperto se lo era.
- **Istanza vuota**: si apre, il compositore funziona, nessun chip
  (nessun oggetto), le prove «senza contesto».
- **Intervalli**: titolo fino a ~80 caratteri (ellissi); chip fino a ~40
  caratteri (il tipo si accorcia a «settings» prima di troncare il codice:
  il codice non si tronca mai); conversazione 1–~400 eventi come nell'area
  3; testo non inviato di qualunque lunghezza (la casella cresce fino a 8
  righe, poi scorre).

## 7. Interazione

- **Apertura**: entra da destra in 200ms (traslazione 16px + dissolvenza,
  ease-out esponenziale; nessun movimento con movimento ridotto); il fuoco
  va nella casella. **Chiusura**: 150ms; il riquadro diventa `hidden` e
  `inert`, **non smontato**; il fuoco torna a chi l'ha aperto (il bottone
  del binario, o l'elemento che aveva il fuoco prima di ⌘J).
- **Da ⌘K**: «Ask Claude: “riassumi ACQ”» apre il riquadro con il testo
  nella casella, **non inviato**, cursore in fondo. Se la casella aveva già
  testo non inviato, il testo nuovo lo **sostituisce** e il vecchio resta
  annullabile con ⌘Z nella casella **[CP 14]**. «Ask Claude…» senza testo
  apre il riquadro e basta.
- **Ultima conversazione**: per persona, in memoria; riaprendo si ritrova
  finché non si preme **New**. Un reset del prototipo la dimentica.
- **Open in Claude**: naviga alla pagina intera e chiude il riquadro; la
  conversazione a pagina intera è la stessa (stessi eventi); il testo non
  inviato resta nella casella del riquadro e non passa alla pagina
  **[CP 15]**.
- **Annunci**: `role="complementary"`, nome «Claude»; i messaggi finiti di
  Claude `aria-live="polite"`; una scheda che chiede a me «assertive», come
  nell'area 3.
- **Tastiera**: Tab cicla dentro il riquadro e ne esce verso la pagina (non
  è modale); ⌘J da dentro chiude.

## 8. Vincoli

- Solo via `data/queries.ts`: la conversazione con le query dell'area 3,
  `describeContext` per il chip, `useCreateConversation`/`sendMessage` con
  `{ context }`. Nessun `can()` nel riquadro.
- I consumi di ogni turno sono operazione `chat`, sul progetto del chip se
  c'è, altrimenti senza progetto (Task 8).
- **«Who?»** nel riquadro: nella fascia del budget (`manageSettings`), e in
  tutte le righe di `claude-actions.md` (rifiuti, «Didn't run», «Undo»
  rifiutato). Nessun «Who?» nel chip o nella testata.
- **+R**: nessuna azione del riquadro in sé; la riconferma si apre **sopra**
  il riquadro dalle schede C e dagli «Undo» con `needsReauth`
  (`claude-actions.md`). Il riquadro resta montato sotto e il fuoco ci
  torna.
- **Voci del registro**: aprire, chiudere, cambiare chip non scrivono
  niente. Le voci nascono solo dalle azioni (`claude-trace.md`).
- Testi en/it con parità; codici in cifre tabellari; nessun monospace.
- **Il testo dell'atterraggio della destinazione** («Claude reads what you
  can read and changes nothing without your confirmation.») non è più vero
  con la classe A: si sostituisce, nel riquadro e nella destinazione, con la
  coppia di frasi della conversazione vuota qui sopra **[CP 9]**.

## Scelte del brief (scelte del controller, da confermare)

1. **[CP 1]** Pannello con filetto `rule-strong` a sinistra e nessuna
   ombra, come le notifiche: resta aperto mentre si lavora.
2. **[CP 2]** 400px da 1440, 360 sotto; non trascinabile nel 10a. Costo se
   sbagliata: un `useDetailPanel`-like da aggiungere, nient'altro.
3. **[CP 3]** Dopo la ×, «Not using this page · Use it» invece del vuoto,
   per poter rimettere il contesto senza cambiare pagina.
4. **[CP 4]** «· on ACQ-14» nella riga del nome di un messaggio inviato con
   un contesto, per non far sembrare che parli della pagina di adesso.
5. **[CP 5]** Il bottone sta **sopra** Notifiche, primo del gruppo in fondo.
6. **[CP 6]** Riquadro chiuso con Claude che risponde: l'anello del bottone
   pulsa; a risposta finita, il punto «ti aspetta».
7. **[CP 7]** «Ask Claude… ⌘J» nel menu dell'app accanto a «Search… ⌘K»
   (tocca `src/main/menu.ts`, che il piano non elenca).
8. **[CP 8]** Tre righe di prova scelte dal contesto, che scrivono e non
   inviano.
9. **[CP 9]** La frase dell'atterraggio «changes nothing without your
   confirmation» si sostituisce anche nella destinazione.
10. **[CP 10]** Pannello della task al bordo destro, riquadro alla sua
    sinistra, a ogni larghezza; a 800 vince l'ultimo aperto.
11. **[CP 11]** Il riquadro copre l'area di lavoro, non la stringe.
12. **[CP 12]** Col budget esaurito il testo scritto resta e torna nella
    casella quando il budget c'è.
13. **[CP 13]** Una riga di 4 secondi dopo il «vedi come».
14. **[CP 14]** Il testo da ⌘K sostituisce quello non inviato (recuperabile
    con ⌘Z).
15. **[CP 15]** «Open in Claude» porta la conversazione, non il testo non
    inviato.

## Scelte confermate (2 nov 2026)

1. **[CP 7]** *(controller, accettata)*: «Ask Claude… ⌘J» entra nel menu
   dell'app (`src/main/menu.ts`, canale `MENU_ASK_CLAUDE`), Task 8.
2. **[CP 9]** *(controller, accettata)*: la frase dell'atterraggio «changes
   nothing without your confirmation» si sostituisce con le due frasi
   della conversazione vuota, nel riquadro e nella destinazione, Task 8.
3. *(maintainer)*: le azioni partite subito non hanno toast; il riquadro
   chiuso non mostra niente sulla pagina oltre al segno del bottone
   ([CP 6]).
4. Le altre scelte di questo brief sono approvate col brief.
