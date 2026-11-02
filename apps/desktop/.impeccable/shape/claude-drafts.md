# Shape brief — Le bozze di Claude nei campi della pagina, e il segno «Claude's draft» unico

> Shape scritto dal controller senza intervista (2 nov 2026): le domande di
> discovery non sono state fatte al maintainer (nessuno strumento di domanda
> in questa sessione). Dove design e piano non bastavano la scelta è
> marcata **scelta del controller** e numerata **[DR n]** in fondo. Valgono
> come scritte le decisioni del maintainer: **D1** i campi sono quattro
> (risposta di supporto, note di rilascio, corpo dell'email, descrizione
> di una task; la Chat no); una bozza non si salva e non si invia da sola;
> il segno resta finché il testo è identico a quello di Claude, sparisce
> alla prima modifica e all'invio, ed è uno solo per il riquadro, per «Ask
> Claude» della Posta e per la bozza del Supporto; «Edited from Claude's
> draft» sparisce; una bozza inviata è della persona; nessun toast per
> un'azione A.

Superficie:
- `tasks-ui/ClaudeDraftMark.tsx` — il segno e `useClaudeDraftMark`;
- `layout/claudePanel/fillable.ts` — il registro dei campi (nessuna UI
  propria);
- `pages/claude/conversation/DraftRow.tsx` — la riga `draft` nella
  conversazione;
- i quattro campi: `pages/support/ReplyComposer.tsx`,
  `pages/mail/{Composer,ClaudeDraftButton}.tsx`,
  `pages/task/DescriptionSection.tsx`, `pages/releases/ReleaseNotesField.tsx`
  (in `PrPanel.tsx` e, in lettura, in `ReleaseDetail.tsx`).

Parte da `support.md` (casella della risposta, «Claude prepared a draft»),
`mail-compose.md` («Ask Claude», «Replace or add below»), `releases.md`
(pannello della PR, dettaglio del rilascio) e `claude-actions.md` (forma
della riga e di «Undo»). Non li riscrive: qui ciò che cambia.

Piano 10b: Task 8 (dati), Task 10 (UI). Spec area 10: parte 1 «Le pagine
che si possono riempire», parte 7 tutta, S6, S6b, «Cosa cambia
deliberatamente» 4. Mondo: «Catalogo numerato», modalità **Operate** con un
tratto di **Read** (il testo della bozza).

## 1. Lavoro e pubblico

- **Davide** (supporto, `support.reply` in ACQ) su `ACQ-S2`, che aspetta
  il team: vuole un primo testo da ritoccare, non una risposta mandata da
  qualcun altro.
- **Laura** su una PR di ACQ nella coda di rilascio: le note di rilascio
  sono un lavoro noioso che vuole rileggere, non scrivere.
- **Laura** sulla task convertita di ACQ, descrizione vuota.
- **Giulia** nella sua Posta: la risposta a un cliente, o un'email nuova
  «per dire che slitta a giovedì».
- **Stato d'animo**: vuole il testo **dove lo userà**, non in una chat da
  copiare. Teme due cose: che parta da solo, e che copra quello che aveva
  già scritto.

## 2. Esito e prova

- **Successo**:
  - Davide, riquadro aperto su `ACQ-S2`: «write the reply» → nella casella
    della risposta il testo e sotto il segno «◌ Claude's draft · edit it
    before sending»; nella conversazione «✓ Put a draft in the reply to
    **ACQ-S2** · Undo». Tocca un tasto nel campo: il segno sparisce. Invia:
    il messaggio è suo, senza segno né «on behalf of»;
  - Davide aveva già scritto «Ciao Mario,»: la riga nella conversazione
    chiede «The reply already has text. Replace it, or add the draft
    below?» e il campo non cambia finché non sceglie;
  - Davide chiede la bozza da Tasks: la riga dice «The draft for the reply
    to **ACQ-S2** is ready · Put it in the field»; il clic porta a
    `ACQ-S2` e la mette lì, una volta sola;
  - Laura sulla PR: le note nel campo «Release notes», col segno, non
    salvate; preme **Save**; dopo il merge il rilascio le mostra;
  - Laura sulla task: la descrizione si apre in modifica col testo e il
    segno; la task non cambia finché non preme **Save**.
- **Verità del prodotto**:
  - **una bozza è un testo in un campo**, non un messaggio: nessuno lo
    vede finché la persona non invia o salva;
  - **il segno dice da dove viene il testo, finché è vero**: sparisce
    quando non è più quello di Claude, e non entra mai nel testo inviato;
  - **Claude scrive solo in un campo dichiarato della pagina aperta**:
    mai in un campo di un'altra pagina, mai in un campo non dichiarato;
  - **un testo che esce** (cliente, email) non nomina il team, non dà
    stime, non riporta commenti interni (`draftText`).

## 3. Direzione scelta

- **Tesi**: **il segno è una nota a piè del campo, non un'etichetta sul
  testo**. Sta sotto l'area di scrittura, dentro il bordo della casella,
  sopra la barra dei bottoni: dove la Posta oggi dice «Draft by Claude
  from…». Una riga sola, quieta, che si toglie da sola alla prima
  modifica. Nessun colore, nessun fondo, nessuna cornice intorno al testo
  **[DR 1]**.

### 3.1 Il segno (`ClaudeDraftMark`)

- **Forma**: riga 24px, 12px. L'anello di Claude **fermo** 12px (ink,
  [CT 2]) · «Claude's draft» / «Bozza di Claude» 600 ink · « · edit it
  before sending» / « · modificala prima di inviare» `ink-muted` (per le
  note e la descrizione: « · edit it before saving» / « · modificala
  prima di salvare»).
- **Fonti** (quando ci sono): stessa riga, dopo «·», «Used: **ACQ-R14**
  Export bookings» / «Usati: **ACQ-R14** Esporta le prenotazioni» — codici
  600 cifre tabellari, link, solo oggetti che chi guarda vede. Oltre 2
  fonti: le prime 2 e «+3» con `title` dell'elenco. Va a capo sotto se non
  sta.
- **Quando c'è**: finché il testo del campo è **identico** a quello messo
  da Claude (`current === placed`). Alla prima differenza sparisce, senza
  sostituto e senza animazione oltre 150ms di dissolvenza. All'invio e al
  salvataggio sparisce. Se la persona riporta il testo esattamente a com'era
  (⌘Z), il segno **non** torna **[DR 2]**.
- **Accessibilità**: il campo ha `aria-describedby` sulla riga; il testo
  per lo screen reader è «Claude's draft, not edited yet».
- **Un solo componente** nei quattro campi, per qualunque strada sia
  arrivata la bozza: il riquadro, «Ask Claude» della Posta, «Use draft» e
  il bottone della bozza del Supporto.

### 3.2 «Replace or add below?»

- Quando il campo ha già testo, **la riga nella conversazione** lo chiede
  prima di scrivere; il campo non cambia finché non si sceglie:
  - «The reply already has text. Replace it, or add the draft below?» /
    «La risposta ha già del testo. Lo sostituisco, o aggiungo la bozza
    sotto?» (per le note: «The release notes already have text…» / «Le
    note di rilascio hanno già del testo…»; per la descrizione: «The
    description already has text…» / «La descrizione ha già del
    testo…»);
  - bottoni **Add below** / **Aggiungi sotto** · **Replace** /
    **Sostituisci**, nell'ordine della Posta (primario a destra).
- «Add below»: il testo di prima resta in cima, una riga vuota, poi la
  bozza. Il segno c'è finché il campo è esattamente «prima + bozza».
- «Ask Claude» della Posta e «Use draft» del Supporto continuano a
  chiederlo **nella pagina**, con la riga di oggi: la domanda sta dove è
  partito il gesto **[DR 3]**.

### 3.3 La riga `draft` nella conversazione (`DraftRow`)

- Stessa forma della riga eseguita (10a): segno · verbo al passato ·
  dove · a destra «Undo» / «Annulla l'azione».

| Stato | en | it |
|---|---|---|
| `pending` | Writing a draft for the reply to **ACQ-S2**… | Scrivo una bozza per la risposta ad **ACQ-S2**… |
| `placed` | ✓ Put a draft in the reply to **ACQ-S2** · Undo | ✓ Messa una bozza nella risposta ad **ACQ-S2** · Annulla l'azione |
| chiede | (le frasi del §3.2, con i due bottoni) | |
| `waiting` | The draft for the reply to **ACQ-S2** is ready · Put it in the field | La bozza per la risposta ad **ACQ-S2** è pronta · Metti nel campo |
| `undone` | ↺ Undone · the reply is as it was | ↺ Annullata · la risposta è com'era |
| `changed_after` | The field changed afterwards · can't undo from here | Il campo è cambiato dopo · non si annulla da qui |
| dopo un ricaricamento | Can't be undone anymore | Non si annulla più |

- **Dove**, per campo:

| `FieldRef` | en | it |
|---|---|---|
| `supportReply` | the reply to **ACQ-S2** | la risposta ad **ACQ-S2** |
| `releaseNotes` | the release notes of **ACQ** · pull request #42 | le note di rilascio di **ACQ** · pull request #42 |
| `mailBody` (risposta) | the reply to “Delivery dates” | la risposta a «Date di consegna» |
| `mailBody` (nuova) | the new email | la nuova email |
| `taskDescription` | the description of **ACQ-15** | la descrizione di **ACQ-15** |

- **`waiting`**: sotto la riga, il **testo della bozza** in un blocco 13px
  ink con un filetto `rule` a sinistra, chiuso a 4 righe con «Show all» /
  «Mostra tutto», per poterla leggere senza cambiare pagina. «Put it in
  the field» è un bottone testo; porta alla pagina del campo
  (`#/support/…/ACQ-S2`, `#/mail/<threadId>` o la nuova email,
  `#/p/ACQ/tasks?task=ACQ-15`, il pannello della PR) e mette la bozza
  appena il campo si dichiara, una volta sola; poi la riga diventa
  `placed` **[DR 4]**.
- `placed` non ripete il testo (è nel campo). «Show» / «Mostra» accanto a
  «Undo», se la pagina è aperta, porta il fuoco al campo.
- **Rifiuti e mancanze** (testo di Claude, nessuna riga `draft`):

| Caso | en | it |
|---|---|---|
| senza `support.reply` (Sara) | You can't reply to this conversation · Who? | Non puoi rispondere a questa conversazione · Who? |
| descrizione senza `tickets.edit` | You can't edit **ACQ-14** · Who? | Non puoi modificare **ACQ-14** · Who? |
| descrizione senza fonti | I have nothing to write **ACQ-14**'s description from: tell me what it should say. | Non ho da dove scrivere la descrizione di **ACQ-14**: dimmi cosa deve dire. |
| email nuova senza indicazione | What should the email say? | Cosa deve dire l'email? |
| contesto che non porta a un campo | Open the conversation, the email, the pull request or the task and ask me again. | Apri la conversazione, l'email, la pull request o la task e chiedimelo di nuovo. |
| … con un codice nella frase | (la stessa) + Open **ACQ-S2** → | (la stessa) + Apri **ACQ-S2** → |
| note senza permesso | You can't edit the release notes of this pull request · Who? | Non puoi modificare le note di rilascio di questa pull request · Who? |
| messaggio della Chat | In a channel, drafts are written by @Claude in the thread: mention @Claude there. | In un canale le bozze le scrive @Claude nel thread: menzionalo lì. |
| «scrivi e manda l'email» | la riga `draft`, poi la riga D `send` del 10a: «Sending is yours to do: I don't send emails or replies. Open the reply →» | la riga `draft`, poi «L'invio tocca a te: non mando email né risposte. Apri la risposta →» |

- **Un altro lettore** (pubblica): chi non vede l'oggetto del campo legge
  «Claude put a draft in a field» / «Claude ha messo una bozza in un
  campo», senza codice, senza testo, senza stato; per una `mailBody`,
  chiunque non sia il proprietario della casella legge così.

### 3.4 Supporto — la risposta (`ReplyComposer`)

- Il campo si dichiara quando la casella c'è (chi ha `support.reply`).
- **La bozza già pronta** («Claude prepared a draft · Use draft · Show»,
  `support.md`) resta: «Use draft» la mette nel corpo **col segno**.
- **Il bottone della barra** oggi si chiama «Claude's draft», come il
  segno. Per non avere due cose diverse con le stesse parole, diventa
  **Ask Claude** / **Chiedi a Claude** (avatar CL + parola), come nella
  Posta; il comportamento non cambia **[DR 5]**.
- La riga «Draft by Claude from the conversation and ACQ-R14 · edit it
  before sending» di `support.md` **è** il segno: «◌ Claude's draft ·
  edit it before sending · Used: **ACQ-R14** Export bookings».
- **Send to customer** non cambia: è il solo modo di inviare. Il
  messaggio inviato non ha segno né «on behalf of».

### 3.5 Posta — il corpo (`Composer`, `ClaudeDraftButton`)

- Il campo `mailBody` si dichiara:
  - nella risposta aperta di una conversazione della **propria** casella
    (`threadId`);
  - nell'email nuova (`#/mail?compose=new`, `null`);
  - sulla pagina di una conversazione **senza** casella aperta, il campo è
    dichiarato lo stesso, e mettere la bozza apre **Reply** (al mittente
    dell'ultimo messaggio) col testo dentro **[DR 6]**.
- **Mai** in una conversazione di un'altra casella (`mailbox_owner`, admin
  compresi): lì il campo non c'è, e Claude risponde con la riga «Open the
  conversation…».
- **«Ask Claude»** resta com'è (indicazione facoltativa, streaming,
  «Replace or add below» nella pagina). A fine bozza la sua riga diventa
  il segno unico: «◌ Claude's draft · edit it before sending · Used: …» e,
  solo per questa strada, «Undo» e «Try again» a destra (il gesto è
  partito dalla pagina) **[DR 7]**.
- **«Edited from Claude's draft» / «Modificata dalla bozza di Claude» non
  c'è più**: alla prima modifica la riga sparisce intera. La chiave
  `mail.compose.edited` si toglie da en e it.
- **Send** non cambia; inviata, nessun segno e nessun «on behalf of».

### 3.6 Task — la descrizione (`DescriptionSection`)

- Il campo `taskDescription` si dichiara solo se chi guarda può modificare
  la task (`canEdit`), nel pannello o nella pagina intera della task.
- **Mettere la bozza apre il modo modifica** della descrizione, col testo
  di Claude e il segno sotto l'area («· edit it before saving»), e i
  bottoni di oggi: **Save** (⌘Enter) · **Cancel** (Esc).
- **Il fuoco resta nel riquadro**: la sezione scorre a vista nel pannello
  della task, e un annuncio `polite` dice «Claude's draft is in the
  description of ACQ-15. Save it to keep it.» / «La bozza di Claude è
  nella descrizione di ACQ-15. Salvala per tenerla.» **[DR 8]**.
- **Save** è della persona: `updateTask` a mano, attività «Laura Costa
  changed the description», **senza** «Claude on behalf of». Il segno
  sparisce.
- **Cancel / Esc**: la descrizione resta com'era, la bozza si butta, la
  riga nella conversazione passa a `changed_after`.
- **Con la descrizione già in modifica** (testo non salvato della
  persona): quello è il testo del campo, e vale «Replace or add below?».
- **Pannello di un'altra task aperto**: la riga è `waiting`, e la
  descrizione della task aperta non cambia.

### 3.7 PR e rilascio — le note di rilascio (`ReleaseNotesField`)

- **Nel pannello della PR** (`releases.md`, 360px), una sezione nuova
  **RELEASE NOTES** / **NOTE DI RILASCIO** (`heading-group`), **tra
  «Corrections» e le azioni**: le note si preparano prima del rilascio, e
  stanno accanto al bottone che rilascia **[DR 9]**.
  - **Chi può modificarle** (`canEditReleaseNotes`: `tickets.edit` sulla
    task della PR o `release.merge`): un'area di testo 14px, 4 righe che
    crescono fino a 12, segnaposto «What changes for the people who use
    it. One line per task.» / «Cosa cambia per chi lo usa. Una riga per
    task.»; sotto, 12px `ink-muted`, «Shown in the release after the
    merge.» / «Compaiono nel rilascio dopo il merge.».
  - **Save** / **Salva** (⌘Enter) e **Cancel** / **Annulla** compaiono
    solo con modifiche non salvate; stato «Saving…» / «Salvataggio…»,
    «Saved» / «Salvate» (2 s), «Couldn't save · Retry» / «Non salvate ·
    Riprova» col testo intatto. Nessun salvataggio automatico: le note
    sono un dato condiviso **[DR 10]**.
  - **In sola lettura** (senza permesso): le note in prosa 14px; vuote,
    «No release notes yet.» / «Ancora nessuna nota di rilascio.» in
    `ink-faint`, nessun «Who?» nel pannello.
  - Il segno sotto l'area, con le fonti: «Used: **ACQ-12** · **ACQ-14**».
- **La bozza** (`releaseNotesDraftFor`): una riga per task, «- **ACQ-12**:
  Export bookings to CSV»; ogni riga ha il suo codice; un commit senza
  codice, o con un codice invisibile o eliminato, non dà righe.
- **Nel dettaglio del rilascio** (`#/p/ACQ/releases/ACQ-V7`): una sezione
  **Release notes** / **Note di rilascio** (`headline`) **dopo «Now» e
  prima di «Runs»**, in prosa 14px, colonna di lettura; i codici sono link
  se chi guarda li vede, altrimenti testo `ink-faint` (R-E9). Senza note,
  la sezione non c'è. Sola lettura: nessun campo, nessun segno.

```
1440 ── Support di ACQ, ACQ-S2, riquadro aperto ─────────────────────────────────────
│rail│ ACQ col │ list (380)        │ reading (~356 a vista) │ Claude 400              │
│    │ …       │ WAITING ON US 1   │ ACQ-S2 Mario Bianchi   │ You're looking at:      │
│    │ Support●│● ACQ-S2 Mario …   │ …                      │ [ACQ-S2 · support conv…]│
│    │         │                   │ ┌ Reply to Mario Bian… │ DAVIDE PELLEGRINI       │
│    │         │                   │ │ Ciao Mario, l'abbia… │ ░ write the reply      ░│
│    │         │                   │ │ …                    │ ✓ Put a draft in the    │
│    │         │                   │ │ ◌ Claude's draft · e…│   reply to ACQ-S2  Undo │
│    │         │                   │ │ [Ask Claude]   [Send…│                         │
```

```
1024 ── task convertita di ACQ, pannello della task sovrapposto, riquadro ──
│rail│ column 240 │ Claude 360               │ task panel 400 (overlay) │
│    │ ACQ        │ LAURA COSTA · on ACQ-15  │ ACQ-15 Export bookings   │
│    │ Tasks      │ ░ write the description ░│ DESCRIPTION              │
│    │ …          │ ✓ Put a draft in the     │ ┌──────────────────────┐ │
│    │            │   description of ACQ-15  │ │ The customer asked…  │ │
│    │            │   · Undo                 │ │ …                    │ │
│    │            │                          │ │ ◌ Claude's draft ·   │ │
│    │            │                          │ │ edit it before saving│ │
│    │            │                          │ └──────────────────────┘ │
│    │            │                          │        [Cancel] [Save]   │
```

```
1440 ── pannello della PR (360) col riquadro alla sua sinistra ─────
│ … work area │ Claude 400              │ PR panel 360              │
│             │ ✓ Put a draft in the    │ acq/site#42 · Open on Gi… │
│             │   release notes of ACQ  │ CORRECTIONS …             │
│             │   · pull request #42    │ RELEASE NOTES             │
│             │   Undo                  │ - ACQ-12: Export bookings │
│             │                         │ - ACQ-14: Fix bill down…  │
│             │                         │ ◌ Claude's draft · edit it│
│             │                         │ before saving · Used: …   │
│             │                         │ Shown in the release afte…│
│             │                         │            [Cancel] [Save]│
│             │                         │ [Release]                 │
```

## 4. Ambito e confini

- **Dentro**: il segno unico nei quattro campi; «Replace or add below?»
  nella conversazione; la riga `draft` in tutti gli stati e i rifiuti; il
  campo delle note nel pannello della PR e la sezione nel rilascio; la
  descrizione aperta dalla bozza; la Posta dal riquadro e da «Ask Claude»;
  il rinomina del bottone del Supporto.
- **Fuori**: la casella della Chat (D1); i suggerimenti che fanno partire
  S6 (`claude-suggestions.md`); «Ask Claude to explain» dei rilasci
  (area 8a, invariato).
- **Anti-obiettivi**:
  - il segno dentro il testo inviato o salvato, o un «on behalf of» su un
    messaggio della persona;
  - il segno che resta dopo una modifica, o che sparisce senza;
  - un testo scritto sopra quello della persona senza chiedere;
  - una bozza in un campo di un'altra pagina, o nella casella di un'altra
    persona;
  - un'email partita senza «Send», una descrizione salvata senza «Save»;
  - un «Undo» che cancella le modifiche della persona.

## 5. Stati e intervalli

- **Testo della bozza**: da 1 riga a ~3.000 caratteri (un'email lunga);
  le note da 1 a ~30 righe.
- **Fonti**: 0–2 a vista, poi «+N».
- **Streaming**: il riquadro scrive la bozza nel campo **intera**, senza
  streaming nel campo (lo stream è nella conversazione, sulla riga
  `pending`); «Ask Claude» della Posta e del Supporto mantengono il loro
  streaming **[DR 11]**.
- **Campo occupato** dallo streaming di «Ask Claude» quando arriva una
  bozza dal riquadro: la riga resta `pending` finché lo streaming finisce,
  poi chiede «Replace or add below?».
- **Errore del livello finto** nel salvare le note: «Couldn't save ·
  Retry», testo intatto.
- **Vedi come**: il runner mette nei campi solo le bozze della persona
  della sessione; cambiando persona, una bozza `placed` di Giulia resta
  nel campo della pagina (è testo della pagina) ma il segno sparisce,
  perché il segno è della persona che l'ha chiesto **[DR 12]**.
- **Istanza vuota**: nessun campo da riempire; le richieste ricevono la
  riga «Open the conversation…».

## 6. Interazione e layout

- **1440**: il riquadro (400) sopra l'area di lavoro; il pannello della
  task o della PR al bordo destro e il riquadro alla sua sinistra
  ([CP 10]). Il campo resta a vista mentre si legge la riga.
- **1024**: il pannello della task (o della PR) sovrapposto 400 al bordo
  destro, il riquadro (360) alla sua sinistra: campo e riga insieme. Il
  Supporto a 1024 ha l'elenco chiuso e la lettura coperta in parte dal
  riquadro: la casella della risposta resta in fondo, a vista sotto i
  ~300px scoperti; chi vuole tutta la casella chiude il riquadro (⌘J) e
  lo ritrova com'era **[DR 13]**.
- **Fuoco**: mettere una bozza non sposta mai il fuoco dalla casella del
  riquadro; «Show» lo porta al campo; «Put it in the field» naviga e lo
  porta al campo.
- **Movimento**: il testo compare nel campo in 150ms (dissolvenza); il
  segno entra insieme; nulla con movimento ridotto.

## 7. Vincoli

- **Dove compare «Who?»**: solo nelle righe di rifiuto del §3.3 (Sara sul
  Supporto `replyCustomers`, la descrizione `editTasks`, le note
  `editTasks`). Mai nel segno, mai nel campo delle note in sola lettura.
- **Dove compare +R**: da nessuna parte. Nessuna bozza, nessun salvataggio
  delle note o della descrizione è in `REAUTH_REQUIRED`.
- **Voci del registro delle modifiche**: **nessuna**. Mettere una bozza
  non scrive dati. Salvare le note di una PR non scrive nel registro (non
  è un'impostazione); salvare la descrizione scrive l'attività della task
  della persona, senza `via`. Inviare una risposta o un'email resta come
  oggi.
- Il segno si decide **solo** confrontando il testo del campo con quello
  messo (`useClaudeDraftMark`); nessuna pagina lo decide in un altro modo.
- Nessun `can()` nelle pagine: `canEdit`, `canEditReleaseNotes`, la
  visibilità della casella arrivano dalle viste.
- **⌘J**: nel 10a è il riquadro, ovunque. Le scorciatoie ⌘J di «Ask
  Claude» della Posta e del Supporto descritte in `mail-compose.md` e
  `support.md` sono quindi superate: «Ask Claude» resta un bottone, e le
  due caselle **non intercettano più ⌘J** (un test lo verifica: ⌘J con il
  fuoco nella casella apre o chiude il riquadro, e non scrive una bozza)
  **[DR 14]**.
- Testi en/it con parità; codici in cifre tabellari; nessun monospace.

## Scelte del brief (scelte del controller, da confermare)

1. **[DR 1]** Il segno è una riga sotto l'area di scrittura, dentro la
   casella, senza fondo né cornice sul testo.
2. **[DR 2]** Un testo riportato a com'era con ⌘Z non riaccende il segno.
3. **[DR 3]** «Replace or add below?» lo chiede la riga per le bozze del
   riquadro, la pagina per «Ask Claude» e «Use draft».
4. **[DR 4]** La riga `waiting` mostra il testo della bozza (4 righe).
5. **[DR 5]** Il bottone «Claude's draft» del Supporto diventa «Ask
   Claude», perché le parole «Claude's draft» restino solo del segno.
6. **[DR 6]** Sulla pagina di una conversazione della Posta senza casella
   aperta, la bozza apre «Reply».
7. **[DR 7]** «Undo» e «Try again» nel segno solo per «Ask Claude» della
   Posta.
8. **[DR 8]** La descrizione aperta dalla bozza non prende il fuoco.
9. **[DR 9]** Le note nel pannello della PR stanno fra «Corrections» e le
   azioni.
10. **[DR 10]** Le note si salvano con «Save», non da sole.
11. **[DR 11]** Dal riquadro la bozza arriva intera nel campo, senza
    streaming nel campo.
12. **[DR 12]** Con il «vedi come» il testo resta nel campo ma il segno
    sparisce.
13. **[DR 13]** A 1024 il Supporto non si riorganizza per il riquadro.
14. **[DR 14]** ⌘J resta del riquadro anche nelle caselle di Posta e
    Supporto.

## Scelte confermate (2 nov 2026)

1. **[DR 5]** *(confermata dal maintainer il 2 nov 2026)*: nel Supporto il
   bottone «Claude's draft» / «Bozza di Claude» diventa «Ask Claude» /
   «Chiedi a Claude»; le parole «Bozza di Claude» restano solo del segno.
2. **[DR 14]** *(confermata dal maintainer il 2 nov 2026)*: ⌘J resta al
   riquadro; Posta e Supporto non lo intercettano più, con un test.
3. Le altre scelte di questo brief sono approvate col brief.
