# Shape brief — Eliminare una task

> Shape scritto dal controller senza intervista (2 nov 2026): le domande di
> discovery non sono state fatte al maintainer. Dove design e piano non
> bastavano la scelta è marcata **scelta del controller** e numerata
> **[TD n]** in fondo. Valgono come scritte le decisioni del maintainer del
> 2 nov 2026 (spec area 10, «Eliminare una task»): l'azione esiste anche a
> mano, per tutti, dal menu della task; non si annulla; a mano apre un
> dialogo che nomina codice e titolo; non chiede la riconferma; l'unica
> eliminazione senza dialogo è l'«Undo» di una creazione fatta da Claude.

Superficie:
- la voce **Delete task…** nel menu «⋯» della task (`pages/task/
  TaskMoreMenu.tsx`, nella testata della task: pannello e pagina intera);
- il dialogo `pages/task/DeleteTaskDialog.tsx`;
- dopo: fuoco, toast, e le letture che nominavano la task — la richiesta
  d'origine, l'esecuzione d'automazione, le notifiche, i codici citati
  altrove.

Piano 10a: Task 10 (dati: Task 2). Spec area 10: «Eliminare una task»,
«Quando si rifiuta», «Cosa succede a ciò che le sta intorno», «Traccia».
Mondo: «Catalogo numerato», modalità **Operate**.

## 1. Lavoro e pubblico

- **Chi**:
  - **l'autore** che ha creato una task per sbaglio, doppia o di prova
    (Giulia con MKX-31 «Prova»): `tickets.edit` nel progetto;
  - **chi modera** il progetto (Laura in ACQ, `tickets.moderate`): toglie
    una task creata da altri, per esempio un doppione nato da
    un'automazione;
  - **chi non può** (Sara su una task non sua): deve capire perché e a chi
    chiedere.
- **Stato d'animo**: pulizia, raramente; teme di portarsi via figlie,
  collegamenti o il lavoro in corso di Claude. Il dialogo deve dire prima
  **cosa resta** e **cosa impedisce** l'eliminazione.

## 2. Esito e prova

- **Successo**, a 1440×900:
  - Giulia apre MKX-31, «⋯» → **Delete task…**; il dialogo dice «Delete
    MKX-31?», «MKX-31 “Prova”», «This can't be undone.»; premo **Delete
    MKX-31**: il pannello si chiude, il toast dice «MKX-31 was deleted.», la
    riga non c'è più, il fuoco è sulla riga che ha preso il suo posto;
  - ACQ-14 con Claude al lavoro: il dialogo dice «Claude is working on it.»
    e **Delete ACQ-14** è spento con la frase, senza «Who?»;
  - ACQ-20 con due figlie: «2 tasks stay, without a parent: ACQ-21, ACQ-22»;
  - Sara: la voce è spenta, con la frase e **Who?**.
- **Verità del prodotto**:
  - **un codice non si riusa mai**: dopo MKX-31 eliminata la task nuova è
    MKX-32;
  - **eliminata = inesistente** per chiunque: stesso aspetto di un codice
    che non è mai esistito, ovunque sia citato (R-G5);
  - **ciò che le sta intorno resta**: figlie (senza madre), richiesta,
    traguardo (senza di lei nei conteggi), notifiche, esecuzioni
    d'automazione;
  - **la pagina non decide**: `canDelete`, `whoAction`, `busy`, `children`
    dalla vista `getTaskDeletion`.

## 3. Direzione scelta

- **Tesi**: **un gesto raro e pesante, ma non drammatico**. Una voce
  `critical` in fondo al menu, separata da un filetto; un dialogo che
  elenca prima ciò che resta e ciò che blocca, poi il bottone rosso. Niente
  codice da scrivere né riconferma: il peso è quello dell'eliminazione di un
  commento altrui, non di un progetto **[TD 1]**.

### La voce nel menu «⋯»

- Il menu oggi ha il gruppo **Export**. Sotto, un filetto, poi **Delete
  task…** / **Elimina task…**, testo `critical`, senza intestazione di
  gruppo **[TD 2]**.
- **Attiva** quando `canDelete` (anche con `busy`: il `busy` lo dice il
  dialogo).
- **Spenta per permesso** (`canDelete: false`): la voce è spenta e sotto,
  12px `ink-muted`, una nota del menu con **Who?** (`WhoCanLink`, progetto
  della task):
  - `whoAction: "deleteTasks"`: «Only its author or someone who can
    moderate tasks in ACQ can delete it. · Who?» / «Possono eliminarla solo
    chi l'ha creata o chi può moderare le task in ACQ. · Who?»;
  - `whoAction: "editTasks"` (l'autrice senza `tickets.edit`): «You need to
    be able to edit tasks in ACQ to delete it. · Who?» / «Per eliminarla
    devi poter modificare le task in ACQ. · Who?».
- **In caricamento** (la vista non è ancora arrivata): la voce c'è, spenta,
  con la nota «Checking…» / «Verifica…»; **errore**: «Couldn't check if you
  can delete it.» / «Impossibile verificare se puoi eliminarla.» · **Retry**
  / **Riprova** nel menu (la forma del gruppo Export) **[TD 3]**.

### Il dialogo «Delete task» (480px)

- **Titolo**: «Delete MKX-31?» / «Eliminare MKX-31?»
- **La task**: riga 14px «**MKX-31** “Prova”» / «**MKX-31** «Prova»» (codice
  600 cifre tabellari, titolo su una riga con ellissi e `title` intero).
- **Prima riga d'avviso**, `critical` con ✕: «This can't be undone.» / «Non
  si può tornare indietro.»
- **GOES WITH IT** / **SE NE VA CON LEI** (`heading-group`), una riga:
  «Its comments, attachments and history.» / «I suoi commenti, gli allegati
  e la storia.»
- **STAYS** / **RESTA** (`heading-group`), righe 13px con ○, solo quelle
  vere:
  - figlie (`children`, una o più): «2 tasks stay, without a parent:» /
    «2 task restano, senza task madre:» e sotto una riga per figlia
    «**ACQ-21** “Export CSV”» (fino a 5, poi «and 3 more» / «e altre 3»);
    una sola: «1 task stays, without a parent: **ACQ-21** “Export CSV”» /
    «1 task resta, senza task madre: …»;
  - collegamenti (se la task ne ha, letti dalla task aperta): «Its links
    to other tasks are removed on both sides.» / «I suoi collegamenti con
    altre task si tolgono da entrambe le parti.»;
  - richiesta d'origine (se la task ne ha una): «The request it came from
    stays, and will say the task was deleted.» / «La richiesta da cui viene
    resta, e dirà che la task è stata eliminata.»;
  - sempre: «The code MKX-31 won't be used again.» / «Il codice MKX-31 non
    verrà più usato.»
- **Busy** (`busy` non vuoto): sopra STAYS, un blocco con ▲ `warning`:
  titolo 14px 600 «MKX-31 can't be deleted yet» / «MKX-31 non si può ancora
  eliminare», poi una riga per ragione:
  - `claude_session` con codice: «Claude is working on it.» / «Claude ci sta
    lavorando.» (link «Open the session» / «Apri la sessione»); con codice
    `null` (sessione non visibile): la stessa frase, senza link;
  - `open_pr`: «Pull request #42 in audin-web is open.» / «La pull request
    #42 in audin-web è aperta.»;
  - `server_fix`: «It's the fix for server **SRV-2**, still open.» / «È la
    correzione del server **SRV-2**, ancora aperta.»;
  - `release_fix`: «It's the fix for release **ACQ-R12**, still open.» / «È
    la correzione del rilascio **ACQ-R12**, ancora aperta.»;
  - poi: «Wait for it to finish, or close it from its page, then try
    again.» / «Aspetta che finisca, o chiudilo dalla sua pagina, poi
    riprova.» (plurale con più ragioni).
- **Bottoni**: **Cancel** / **Annulla** (il fuoco parte qui) · **Delete
  MKX-31** / **Elimina MKX-31** (`critical`). Con `busy` il bottone rosso è
  spento e sotto, 12px: «You can delete it when nothing is running on it.»
  / «Potrai eliminarla quando non ci gira niente sopra.» — senza «Who?» (è
  una regola, non un permesso).
- Nessuna riconferma (+R) e nessun codice da scrivere.

### Dopo

- **Riuscito**: il dialogo si chiude; se la task era nel **pannello**, il
  pannello si chiude e il fuoco va alla **riga che ha preso il suo posto**
  nella lista (la successiva; se era l'ultima, la precedente; lista vuota:
  l'h1 della pagina); dalla **pagina intera** della task si torna alla
  lista da cui si veniva (o a Tasks del progetto) con la stessa regola del
  fuoco **[TD 4]**.
- **Toast**: «MKX-31 was deleted.» / «MKX-31 è stata eliminata.» Nessun
  **Undo** nel toast (non si annulla).
- **Rifiuti** (dialogo aperto, niente cambia):
  - `busy` arrivato nel frattempo: il dialogo passa alla vista busy;
  - `forbidden`: «You can no longer delete MKX-31. Nothing was deleted. ·
    Who?» / «Non puoi più eliminare MKX-31. Non è stato eliminato niente. ·
    Who?»;
  - `not_found` (eliminata o diventata invisibile nel frattempo): «Can't
    find MKX-31.» / «Non trovo MKX-31.», il dialogo e il pannello si
    chiudono come dopo un'eliminazione, senza toast di successo;
  - errore del livello finto: «Couldn't delete MKX-31. Try again.» /
    «Impossibile eliminare MKX-31. Riprova.» · **Retry** / **Riprova** nel
    dialogo; un Retry riuscito porta lo stesso seguito (chiusura, toast,
    fuoco).
- **Cancel** o Esc: il fuoco torna su «⋯».

### Ciò che nominava la task

- **Richiesta d'origine** (`deletedTaskCodes`): dove oggi c'è il link alla
  task convertita, una riga 13px `ink-muted`: «Task MKX-31 was deleted» /
  «La task MKX-31 è stata eliminata», codice in testo, nessun link.
- **Esecuzione d'automazione** che l'aveva creata: l'effetto resta, «Created
  task MKX-31 · task deleted» / «Creata la task MKX-31 · task eliminata»,
  codice in testo, nessun link.
- **Notifiche** (`objectGone`): la notifica resta com'era, ma il codice
  nella colonna fissa diventa testo `ink-faint` (non link) e, sotto il
  corpo, 12px `ink-muted`: «Task deleted» / «Task eliminata». Clic sulla
  notifica: non apre niente; le azioni (Mark read, Archive, Snooze, «⋯»)
  restano **[TD 5]**.
- **Codici citati** in Chat, conversazioni di Claude, Docs, registro
  decisioni: si leggono **come un codice inesistente** — testo semplice,
  nessun link, nessuna anteprima, nessuna parola che dica «eliminata»
  (R-G5). Le righe del registro decisioni non si riscrivono.
- **Traguardo**: la task esce dai conteggi; nessuna riga.
- **Ricerca e ⌘K**: il codice non dà risultati.

```
1440 ── dialogo, task con figlie (Laura, ACQ-20) ─────────────────
│ Delete ACQ-20?                                                │
│ ACQ-20 “Bill download rework”                                 │
│ ✕ This can't be undone.                                       │
│ GOES WITH IT                                                  │
│ Its comments, attachments and history.                        │
│ STAYS                                                         │
│ ○ 2 tasks stay, without a parent:                             │
│     ACQ-21 “Export CSV”                                       │
│     ACQ-22 “PDF layout”                                       │
│ ○ Its links to other tasks are removed on both sides.         │
│ ○ The request it came from stays, and will say the task was   │
│   deleted.                                                    │
│ ○ The code ACQ-20 won't be used again.                        │
│                                  [Cancel]  [Delete ACQ-20]    │

1440 ── dialogo, busy (ACQ-14) ───────────────────────────────────
│ Delete ACQ-14?                                                │
│ ACQ-14 “Fix bill download”                                    │
│ ✕ This can't be undone.                                       │
│ ▲ ACQ-14 can't be deleted yet                                 │
│   Claude is working on it. Open the session                   │
│   Pull request #42 in audin-web is open.                      │
│   Wait for them to finish, or close them from their page,     │
│   then try again.                                             │
│ …                                                             │
│                                  [Cancel]  [Delete ACQ-14]░   │
│          You can delete it when nothing is running on it.     │
```

## 4. Ambito e confini

- **Dentro**: la voce del menu e i suoi stati; il dialogo con busy, figlie
  e ciò che resta; il seguito; le quattro letture che cambiano; la voce del
  registro e le righe di storia e rassegna.
- **Fuori**: eliminare più task insieme; un cestino o un ripristino;
  fermare il lavoro di Claude o chiudere la PR dal dialogo; eliminare da
  una riga della lista (solo dal menu della task) **[TD 6]**.
- **Anti-obiettivi**: un toast con «Undo»; «deleted» accanto a un codice
  citato in Chat o nei Docs (lo distinguerebbe da uno inesistente); un
  link a una task che non c'è; un bottone rosso spento senza frase; un
  «Who?» su un busy; una figlia eliminata a cascata.

## 5. Stati e intervalli

| Superficie | Caricamento | Vuoto | Errore |
|---|---|---|---|
| Voce del menu | spenta, «Checking…» | — | nota + **Retry** nel menu |
| Dialogo | titolo + 3 righe scheletro, bottone rosso spento | nessuna figlia, nessun link, nessuna richiesta: STAYS ha solo la riga del codice | «Couldn't load what would be deleted, so nothing can be deleted now.» / «Impossibile caricare cosa verrebbe eliminato, quindi ora non si può eliminare niente.» · **Retry** |

- **Intervalli**: titoli fino a ~120 caratteri (ellissi); 0–~30 figlie (5
  a vista, poi «and N more» — tutte visibili a chi guarda, perché stanno
  nello stesso progetto); 0–4 ragioni di busy.
- **Senza permessi**: voce spenta con frase e «Who?»; nessun dialogo.
- **Claude collega** non elimina (R-L9): non compare fra le persone di
  «Who?» per `deleteTasks`.

## 6. Interazione e layout

- Dialogo modale 480px, raggio 12px, `rule-strong`, scrim; entra in 150ms;
  il fuoco su **Cancel**; Tab cicla nel dialogo.
- **1440**: dialogo centrato; righe delle figlie rientrate sotto la loro
  frase.
- **1024** (e nel pannello sovrapposto): dialogo fino a `min(480px, 100vw −
  64px)`; i bottoni restano su una riga (Cancel a sinistra del rosso); la
  frase sotto il bottone spento va a capo allineata a destra. Il menu «⋯»
  si apre verso il basso a sinistra, la nota della voce spenta va a capo a
  280px.
- Annunci: il toast `polite`; il blocco busy `role="status"` quando compare
  nel dialogo già aperto.

## 7. Vincoli

- Solo via `data/queries.ts`: `useTaskDeletion(taskId)` (vista),
  `useDeleteTask()`; la scrittura passa da `useSettingsWrite(...).run` o la
  stessa forma, così il seguito arriva anche dopo un Retry.
- **«Who?»**: solo sulla voce spenta per permesso (`deleteTasks` o
  `editTasks`, progetto della task) e sul rifiuto `forbidden`. Mai sul busy.
- **+R**: nessuna. `deleteTask` non è in `REAUTH_REQUIRED`.
- **Voci del registro**: `task.deleted` (scope progetto, gruppo **Tasks** /
  **Task**, leggibile da chi gestisce il progetto e da chi ha
  `tickets.moderate` lì):
  - «**Giulia Ferri** deleted the task **MKX-31** “Prova”.» / «**Giulia
    Ferri** ha eliminato la task **MKX-31** «Prova».» — codice e titolo di
    allora, in testo, nessun link;
  - fatta dal riquadro: «**Claude on behalf of Giulia Ferri** deleted the
    task …» (`claude-trace.md`); come inverso di un Undo, con la riga
    «Undid:».
- **Storia del progetto e rassegna**: «Giulia Ferri deleted **MKX-31**
  “Prova”» / «Giulia Ferri ha eliminato **MKX-31** «Prova»» (codice in
  testo), per chi vedeva la task; nella sintesi della persona «1 deleted» /
  «1 eliminata».
- **L'Undo di una creazione fatta da Claude** elimina senza questo dialogo,
  con gli stessi permesso, busy e traccia; i suoi rifiuti stanno nella riga
  (`claude-actions.md`).
- Testi en/it con parità; it al femminile per la task («eliminata»).

## Scelte del brief (scelte del controller, da confermare)

1. **[TD 1]** Né codice da scrivere né riconferma: il peso è un dialogo con
   bottone rosso.
2. **[TD 2]** La voce sta in fondo al menu «⋯», dopo un filetto, in testo
   `critical`.
3. **[TD 3]** La voce aspetta la vista prima di attivarsi.
4. **[TD 4]** Dopo l'eliminazione il fuoco va alla riga che ne prende il
   posto, poi alla precedente, poi all'h1.
5. **[TD 5]** La notifica di una task eliminata resta, non apre niente, e
   dice «Task deleted» sotto il corpo.
6. **[TD 6]** Si elimina solo dal menu della task, non dalla lista né in
   blocco.

## Scelte confermate (2 nov 2026)

1. **[TD 1]** *(maintainer)*: a mano basta il dialogo col bottone rosso,
   senza codice da scrivere né riconferma.
2. Le altre scelte di questo brief sono approvate col brief.
