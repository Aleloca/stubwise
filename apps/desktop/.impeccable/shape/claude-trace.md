# Shape brief — «Claude on behalf of [persona]»: registro, commenti, storia, rassegna, notifiche

> Shape scritto dal controller senza intervista (2 nov 2026): le domande di
> discovery non sono state fatte al maintainer. Dove design e piano non
> bastavano la scelta è marcata **scelta del controller** e numerata
> **[CT n]** in fondo. Valgono come scritte le decisioni del maintainer del
> 2 nov 2026 (spec area 10, parte 3): la frase compare ovunque resti
> traccia di un'azione fatta dal riquadro; chi agisce è la persona
> (`actorId`), con il segno `via: "claude"`; il registro non si modifica;
> «Annullato da …» si deriva a lettura; annullare non manda una seconda
> notifica.

Superficie:
- `pages/admin/ChangeEntry.tsx`, `pages/admin/ChangeLogPage.tsx`,
  `pages/settings/ProjectChangeLog.tsx` — la voce col prefisso, la voce
  «Undid:», il filtro **Made with Claude**;
- `pages/task/ActivityFeed.tsx` — la testata del commento e le righe di
  cambio campo nella storia della task;
- la rassegna del giorno per persona (`people-activity.md`) e la storia del
  progetto (`pages/projects/ActivityFeed.tsx`);
- `notifications/NotificationItem.tsx` — il prefisso e «Undone by …».

Piano 10a: Task 11 (dati: Task 3 e 7). Spec area 10: parte 3
«Trasparenza», «Annullare quando altri hanno già visto». Mondo: «Catalogo
numerato», modalità **Operate**.

## 1. Lavoro e pubblico

- **Chi legge il registro** (Roberta in Amministrazione, Laura nel Change
  log di ACQ): vuole sapere chi ha cambiato cosa, e ora anche se l'ha fatto
  con Claude. Per i permessi e le responsabilità **la persona è chi ha
  agito**: il filtro «Person» = Roberta la trova.
- **Chi riceve l'effetto** (Marco, a cui Claude per conto di Giulia ha
  spostato una task): vuole sapere chi gliel'ha mandato e se vale ancora.
- **Chi scorre la giornata** (rassegna per persona): Giulia ha fatto quelle
  cose; alcune con Claude.

## 2. Esito e prova

- **Successo**:
  - nel registro di Amministrazione leggo «**Claude on behalf of Giulia
    Ferri** changed “Weekly brief” in **MKX**.» con «On → Off»; filtro
    **Made with Claude** e restano solo le voci col segno;
  - la voce dopo dice «**Claude on behalf of Giulia Ferri** changed “Weekly
    brief” in **MKX**.» con «Off → On» e sotto «Undid: Claude on behalf of
    Giulia Ferri changed “Weekly brief” in MKX · Oct 30, 10:12»;
  - Marco apre le notifiche: «You've been assigned OLV-12 · Claude on
    behalf of Giulia Ferri assigned you OLV-12.» e sotto «Undone by Giulia
    Ferri» (Marco non è in MKX: la scena del seme sta in OLV, *ruling del
    controller (pre-flight)*, P3; la notifica di una riassegnazione è
    `task.assigned`, *decisione del maintainer, 2 nov 2026*).
- **Verità del prodotto**:
  - **una frase, un template**: il prefisso sostituisce il solo nome di chi
    agisce, il resto della frase è quello di sempre; nessuna frase nuova
    per tipo di voce, nessun testo di Claude nel registro;
  - **il segno si deriva o si legge, mai si deduce**: `via` sulla voce,
    `viaClaude` sulla notifica, `undoneByName` e `undoOf` a lettura;
  - **le righe nate prima** (senza i campi) si leggono senza segno.

## 3. Direzione scelta

- **Tesi**: **il nome resta il soggetto, Claude è il modo**. La frase
  comincia con «Claude on behalf of» / «Claude per conto di» seguito dal
  nome in 600: chi legge in fretta vede comunque la persona, e chi cerca
  «fatto con Claude» trova le parole in testa **[CT 1]**.
- **Il segno di Claude** (dove serve un segno oltre alle parole): l'anello
  tratteggiato **fermo** da 12px, ink. Fermo vuol dire «fatto con Claude»;
  l'anello che pulsa resta «Claude sta lavorando» (Hue-Neutral Claude Rule)
  **[CT 2]**. Il segno ha sempre il testo accanto o il testo per lo screen
  reader («with Claude» / «con Claude»).

### Registro delle modifiche (Amministrazione e Progetto → Change log)

- **Voce col segno** (`via: "claude"`): la parte `<actor>` del template
  diventa «Claude on behalf of **Giulia Ferri**» / «Claude per conto di
  **Giulia Ferri**»:
  - «**Claude on behalf of Roberta Fontana** archived **OLV**.» /
    «**Claude per conto di Roberta Fontana** ha archiviato **OLV**.»;
  - «**Claude on behalf of Giulia Ferri** changed “Weekly brief” in
    **MKX**.» · seconda riga «On → Off» / «**Claude per conto di Giulia
    Ferri** ha cambiato “Brief settimanale” in **MKX**.» · «Acceso →
    Spento»;
  - «**Claude on behalf of Giulia Ferri** deleted the task **MKX-31**
    “Prova”.» / «**Claude per conto di Giulia Ferri** ha eliminato la task
    **MKX-31** «Prova».»
- Nella colonna dell'ora, sotto l'ora, l'anello fermo da 12px con `title`
  «Made with Claude» / «Fatta con Claude» **[CT 3]**. Il codice del
  progetto a destra resta com'è.
- **Voce di un «Undo»** (`undoOf`): è una voce normale del tipo inverso, col
  prefisso, e in più una riga 13px `ink-muted` sotto il prima/dopo:
  - «Undid: Claude on behalf of Giulia Ferri changed “Weekly brief” in MKX ·
    Oct 30, 10:12» / «Ha annullato: Claude per conto di Giulia Ferri ha
    cambiato “Brief settimanale” in MKX · 30 ott, 10:12»;
  - la frase dopo «Undid:» è la frase della voce annullata (stesso
    template, letta con la visibilità di chi guarda); la data è un link che
    porta alla voce annullata nel giornale (scorre e la evidenzia per 1,5s)
    **[CT 4]**;
  - chi non legge la voce annullata (`undoOf` = `null`): la riga «Undid:»
    non c'è; la voce si legge come una voce normale col prefisso (R-G5).
- **Filtro «Made with Claude»** / **«Fatte con Claude»**: un interruttore a
  bottone nella barra dei filtri, **dopo Type e prima di Period**, con
  l'anello fermo e la parola; premuto ha la tinta d'inchiostro 10% e
  `aria-pressed="true"`. Nell'indirizzo (`?via=claude`); «Clear filters» lo
  toglie. Compare **solo** se `choices.claude` (chi guarda legge almeno una
  voce col segno); un indirizzo con `?via=claude` senza voci leggibili apre
  il registro senza filtro e senza messaggio **[CT 5]**.
- **Combinazioni**: «Person = Giulia Ferri» trova anche le sue voci col
  segno; con «Made with Claude» restano solo quelle. Vuoto con filtri: «No
  changes match these filters.» · **Clear filters** (come oggi).
- **Gruppo nuovo** `tasks` / «Tasks» / «Task» in fondo al menu Type, per
  `task.deleted` (`task-delete.md`).

### Commenti (storia della task)

- **Testata** di un commento col segno: avatar della persona · «**Claude on
  behalf of Giulia Ferri**» / «**Claude per conto di Giulia Ferri**» · ora.
  L'avatar è quello di Giulia, senza anello (non sta lavorando) **[CT 6]**.
- Il commento è di Giulia: «Edit» e «Delete» come per ogni suo commento;
  dopo la modifica la testata resta col prefisso e aggiunge «edited» /
  «modificato» come oggi; eliminato, il segno resta sulla riga «Comment
  deleted» **[CT 7]**.

### Righe di cambio nella storia della task

- La riga di un cambio di campo: «**Claude on behalf of Giulia Ferri** moved
  **MKX-31** to W46 · 10:41» / «**Claude per conto di Giulia Ferri** ha
  spostato **MKX-31** in S46 · 10:41»; assegnazione «…assigned it to Marco
  Bellini» / «…l'ha assegnata a Marco Bellini».
- **L'inverso** di un Undo (scritto con `undoOf` nel registro) nella storia
  della task è una riga normale col prefisso: «**Claude on behalf of
  Giulia Ferri** moved **MKX-31** back to W45» — nessuna frase «undid» qui:
  la storia della task mostra i cambi, non la loro relazione **[CT 8]**.

### Storia del progetto e rassegna del giorno per persona

- **Rassegna** («By person»): le azioni contano per la persona. La sintesi
  della riga persona non cambia («2 closed · 5 moved · 1 deleted»); dentro,
  le righe fatte con Claude hanno in fondo, 12px `ink-faint`, l'anello fermo
  e «with Claude» / «con Claude»: «**MKX-31** Prova · moved to W46 · with
  Claude» **[CT 9]**. La voce nuova «deleted» / «eliminata» (da `task-
  delete.md`) entra nella sintesi solo se > 0.
- **Storia del progetto**: «Giulia Ferri deleted **MKX-31** “Prova”» /
  «Giulia Ferri ha eliminato **MKX-31** «Prova»», col segno se c'è; il
  codice non è un link (la task non c'è più).
- Claude non diventa una persona della rassegna (regola dell'area 3).

### Notifiche

- **Notifica nata da un'azione di Claude** (`viaClaude`): il corpo comincia
  col prefisso, il titolo resta quello del tipo:
  - assegnazione (tipo `task.assigned`, *decisione del maintainer, 2 nov
    2026*: lo riceve chiunque riceva una task, da una persona o da Claude,
    mai chi se la assegna da solo): titolo «You've been assigned
    **ACQ-14**» / «Ti è stata assegnata **ACQ-14**»; col segno, corpo
    «Claude on behalf of Giulia Ferri assigned you **ACQ-14**.» / «Claude
    per conto di Giulia Ferri ti ha assegnato **ACQ-14**.»; senza segno, il
    corpo dice la persona («Giulia Ferri assigned you **ACQ-14**.»);
  - pianificazione: titolo «Your week changed» / «La tua settimana è
    cambiata», corpo «Claude on behalf of Giulia Ferri planned **MKX-12**
    for W46.» / «Claude per conto di Giulia Ferri ha pianificato **MKX-12**
    per S46.»
- **«Undone by»** (`undoneByName`, derivato a lettura): una riga 12px
  `ink-muted` sotto il corpo, col segno ↺: «Undone by Giulia Ferri» /
  «Annullato da Giulia Ferri». Nessuna data (l'azione annullata ha la sua;
  la riga dice solo che non vale più) **[CT 10]**. La notifica resta letta o
  non letta com'era, e il link porta ancora all'oggetto. **Nessuna seconda
  notifica** per l'annullamento.
- Il punto «non letta» e le azioni (Mark read, Archive, Snooze, «⋯») non
  cambiano.

```
1440 ── Amministrazione → Change log, filtro «Made with Claude» (Roberta) ───────────
│ Change log                                                                        │
│ Every change to access and settings: who made it, when, and what changed.        │
│ Person ▾   Project ▾   Type ▾   [◌ Made with Claude]   Period ▾   Clear filters   │
│ TODAY ─────────────────────────────────────────────────────────────────────────── │
│ 10:14  Claude on behalf of Giulia Ferri changed “Weekly brief” in MKX.      MKX   │
│  ◌     Off → On                                                                   │
│        Undid: Claude on behalf of Giulia Ferri changed “Weekly brief” in MKX ·    │
│        Oct 30, 10:12                                                              │
│ OCT 30 ────────────────────────────────────────────────────────────────────────── │
│ 10:12  Claude on behalf of Giulia Ferri changed “Weekly brief” in MKX.      MKX   │
│  ◌     On → Off                                                                   │

1440 ── pannello notifiche (Marco) ──────────────────
│ ● MKX-12 · MKX · Oct 30                           │
│   Your week changed                               │
│   Claude on behalf of Giulia Ferri planned MKX-12 │
│   for W46.                                        │
│   ↺ Undone by Giulia Ferri                        │
```

## 4. Ambito e confini

- **Dentro**: prefisso nel registro, voce «Undid:», filtro, testata del
  commento, righe della storia, rassegna, storia del progetto, notifiche
  con «Undone by».
- **Fuori**: un registro delle conversazioni di Claude; il segno sulle
  bozze inviate dalla persona (non lo portano: spec parte 3).
- **@Claude nella Chat** *(maintainer, 2 nov 2026)*: le proposte confermate
  in un thread **portano il prefisso** nel registro, nella storia e nelle
  notifiche, come quelle del riquadro («Claude on behalf of Giulia Ferri
  planned **MKX-12** for W46.»). In Chat restano proposte (area 4) e non c'è
  «Undo», quindi nessuna di quelle righe avrà «Undone by» né «Undid:»
  **[CT 11]**.
- **Anti-obiettivi**: «Claude» come autore al posto della persona; una voce
  che contiene testo scritto da Claude; «Undid:» con la frase di una voce
  che chi guarda non legge; una seconda notifica a Marco; «Undone by» su
  una notifica il cui gruppo non è annullato; il filtro visibile a chi non
  ha voci col segno.

## 5. Stati e intervalli

- Registro: stati di oggi (caricamento, vuoto, errore con **Retry**). Con
  «Made with Claude» e nessuna voce nel periodo: «No changes match these
  filters.» · **Clear filters**.
- Nomi lunghi: il prefisso va a capo come il resto della frase; in it il
  prefisso è più lungo di ~4 caratteri, nessun troncamento.
- Persona disattivata: «Claude on behalf of Marco Bellini (deactivated)» —
  il suffisso di oggi resta sul nome.
- Righe senza campi nuovi (prima del 10a): nessun segno, nessuna riga
  «Undid:», nessun «Undone by».

## 6. Interazione e layout

- **1440**: voce del registro con l'ora a sinistra (colonna fissa) e
  l'anello sotto l'ora; riga «Undid:» rientrata come il prima/dopo.
- **1024** (720px utili): la barra dei filtri va su due righe; **Made with
  Claude** resta sulla prima, subito dopo Type, Period e Clear filters
  scendono; la riga «Undid:» va a capo dopo «·», la data sulla riga dopo.
  Notifiche (400px) invariate a ogni larghezza.
- Il link della data in «Undid:» porta alla voce annullata: se è fuori dai
  filtri attivi, li toglie prima (toast «Filters cleared to show the
  change.» / «Filtri tolti per mostrare la modifica.») **[CT 4]**.

## 7. Vincoli

- Solo `via`, `undoOf` (o `null`), `viaClaude`, `undoneByName` dalla vista;
  le frasi si compongono a lettura dai template i18n esistenti, con le
  chiavi nuove `changelog.via.actor`, `changelog.via.undid`,
  `notifications.viaClaude.*`, `activity.viaClaude`.
- **«Who?»**: nessuno in queste superfici (si legge, non si agisce).
- **+R**: nessuna.
- **Voci del registro** che questo shape mostra col prefisso nel 10a: ogni
  voce scritta da un'azione del catalogo (progetto: `project.archived`,
  `project.reopened`, `project.switch_changed` e le altre del 9c; membri:
  `member.added`, `member.removed`, `member.role_changed`; istanza: le voci
  del 9b delle scritture senza segreto; `task.deleted`), e le loro inverse
  con `undoOf`. Le iscrizioni agli avvisi non scrivono nel registro (la
  loro storia è nella riga dell'iscrizione).
- Testi en/it con parità; il prefisso funziona perché in tutte e due le
  lingue il verbo segue il soggetto.

## Scelte del brief (scelte del controller, da confermare)

1. **[CT 1]** Il prefisso sta al posto del nome, che resta in 600.
2. **[CT 2]** L'anello **fermo** = «fatto con Claude»; quello che pulsa =
   «sta lavorando».
3. **[CT 3]** L'anello sotto l'ora nel registro, non accanto al nome.
4. **[CT 4]** La voce di un Undo è la voce inversa col prefisso più una
   riga «Undid: <frase della voce annullata> · data», con la data che porta
   alla voce. Alternativa scartata: una frase unica «… undid: …» al posto
   della frase dell'inversa, che perde il prima/dopo.
5. **[CT 5]** Filtro come interruttore dopo Type; un `?via=claude` senza
   voci si ignora in silenzio.
6. **[CT 6]** Nel commento l'avatar è della persona, senza anello.
7. **[CT 7]** Il segno resta su un commento eliminato.
8. **[CT 8]** La storia della task non dice «undid», mostra solo il cambio
   inverso.
9. **[CT 9]** Nella rassegna «with Claude» in coda alla riga, e la sintesi
   non distingue.
10. **[CT 10]** «Undone by» senza data.
11. **[CT 11]** ~~Le proposte confermate in Chat (@Claude) non portano il
    prefisso~~: sostituita dalla decisione del maintainer qui sotto.

## Scelte confermate (2 nov 2026)

1. **[CT 11]** *(maintainer)*: le conferme di @Claude nella Chat portano
   «Claude on behalf of …» nel registro e nelle notifiche, come il
   riquadro. Le regole dell'area 4 restano (tutto proposte, niente Undo in
   Chat).
2. Le altre scelte di questo brief sono approvate col brief.
3. **[CT 4]** *(ruling del controller (pre-flight), P2)*: il piano si
   allinea a questo brief. La voce di un Undo è l'inversa col prefisso e il
   suo prima/dopo, più la riga «Undid: … · data»; non una frase unica
   «… undid: …».
4. *(decisione del maintainer, 2 nov 2026)*: la notifica di assegnazione è
   il tipo nuovo `task.assigned`, «You've been assigned ACQ-14» / «Ti è
   stata assegnata ACQ-14». La ricevono tutti quelli a cui arriva una task,
   con o senza Claude; chi si assegna da solo no.
