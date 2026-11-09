# Area 10a — parità con il web (2 nov 2026)

Il web non ha un riquadro di Claude: non c'è una parità da chiudere. Claude
sul web vive nei run del worker (fix, refinement, review) e nelle chat Docs e
di progetto, nessuna delle quali scrive sull'app con i permessi di chi
chiede. Qui c'è una riga per ogni voce **nuova** del 10a: dove vive nel
prototipo e il test che la esercita (titolo fra virgolette, anche solo
l'inizio). Percorsi relativi a `src/renderer/`. Le scelte del costruttore e
del controller che reggono queste voci, ognuna col suo costo se sbagliata,
stanno in `ossatura-follow-ups.md` («Area 10a — minori aperti»); le regole
da scrivere prima del motore sono le §12–§15 di quel file.

Design: `docs/plans/2026-11-02-desktop-area10-claude-integration-design.md`.
Shape: `.impeccable/shape/{claude-panel,claude-actions,claude-trace,task-delete}.md`.

## Le voci nuove

| Voce | Dove vive ora | Test |
|---|---|---|
| Il riquadro di Claude (⌘J, il bottone del binario, ⌘K, «Ask Claude… ⌘J» nel menu dell'app) | `layout/claudePanel/ClaudePanel.tsx`, `ContextChip.tsx`, `pageContext.ts`; la rilettura del contesto con la visibilità in `data/claude/context.ts` | `layout/claudePanel/ClaudePanel.test.tsx` («⌘J da Tasks di ACQ col pannello della task: chip «ACQ-3 · task»…», «una task diventata invisibile perde il chip, e Claude risponde «Can't find»…», «budget esaurito, conversazione vuota: la fascia al posto della casella…», «il riquadro sta a sinistra del pannello, non sopra»); `emptyInstance.test.tsx` («il riquadro di Claude si apre e la conversazione nuova risponde») |
| Le classi A–D (la calcola il livello dati sui dati del momento; la pagina la legge) | `data/claude/classes.ts` (`classOf`, `classOfGroup`); resa in `pages/claude/conversation/ProposalCard.tsx` | `data/claude/classes.test.ts` («in AUD, dove Matteo segue le task nuove: B, «Notifies Matteo Conti»», «con un'automazione attiva su task_created nel progetto: B col motivo…», «una task non assegnata di Giulia in MKX, senza avvisi né automazioni: A»); `pages/claude/conversation/ProposalCard.classes.test.tsx` («in AUD «I'm asking first: …» e «Notifies Matteo Conti»», «Confirm → dialogo sopra il riquadro → 123456 → «Done» senza un secondo clic») |
| Il catalogo delle azioni (le forme `…As` delle scritture, i loro inversi, la classe di partenza) | `data/claude/catalog.ts`, `types.ts` (foglia, P10); le `…As` accanto alle pubbliche in `data/api-mutations.ts`, `data/instance/*`, `data/projectSettings/*` | `data/claude/catalog.test.ts` («ogni voce ha classe di partenza, «annullabile» e un «Who?»…», «la classe C viene SOLO da REAUTH_REQUIRED…», «nessuna voce che non si annulla parte in classe A»); `data/claude/syncWrites.test.ts` (pubblica e `…As` sullo stesso stato) |
| I divieti D («Cosa Claude non fa»: merge, deploy, approvare un piano, segreti, registrare una decisione al posto della persona) | `domain/claude/intents/refused.ts` (la riga D col link al posto vero); `data/claude/neverInCatalog.test.ts` sul sorgente | `data/claude/neverInCatalog.test.ts` («nessun riferimento di codice alle funzioni vietate», «CLAUDE_CATALOG non ha una voce per i gesti delle persone né per le scritture dei segreti»); `domain/claude/intents.10a.test.ts` («riga D: ogni tema, en e it, porta al posto vero», «la riga del deploy: la frase, senza link»); `pages/claude/conversation/ExecutedRow.test.tsx` («la frase del deploy, senza link e senza un controllo che faccia il deploy») |
| Il segno `via` («Claude on behalf of …»): voce del registro, attività, commento, notifica, eliminazione | `data/claude/via.ts` (`runAsClaude`, `currentVia`); letture in `pages/admin/ChangeEntry.tsx`, `notifications/NotificationItem.tsx`, `pages/projects/PeopleActivity.tsx`, `pages/projects/ActivityFeed.tsx` | `data/claude/via.test.ts` («il modulo espone solo runAsClaude e currentVia…», «nessuna funzione esportata da data/api.ts ha un parametro col segno…», «planTask verso Marco confermato da Giulia in un thread di OLV: via, viaClaude…»); `pages/admin/ChangeEntry.claude.test.tsx` («si legge «Claude on behalf of Giulia Ferri …» col prima e dopo, in en e in it») |
| «Annulla» (l'inverso come scrittura nuova, solo di chi l'ha chiesta, solo se nessuno ha scritto dopo) | `data/claude/actions.ts` (`executeGroup`; `undoClaudeActions` e `undoViewOf` per l'«Annulla»); resa in `pages/claude/conversation/UndoControl.tsx`, `ExecutedRow.tsx` | `data/claude/undo.test.ts` («Marco l'ha commentata prima: `changed_after`…», «solo chi l'ha chiesta: un'altra persona riceve `not_yours`…», «planTask verso Marco annullato: la sua notifica dice «Undone by Giulia Ferri»…»); `pages/claude/conversation/ExecutedRow.test.tsx` (««Created MKX-<n> “Prova”»: il codice apre la task, Undo la elimina…», «dopo un commento di Marco: la frase e il link, nessun Undo») |
| «Elimina task» (a mano e da Claude) | dati in `data/taskDelete.ts`; UI in `pages/task/TaskMoreMenu.tsx`, `DeleteTaskDialog.tsx`, `deleteFocus.ts`; letture di ciò che resta in `RequestDetail`, `LogEntryText`, `NotificationItem` | `data/taskDelete.test.ts` («le figlie restano senza madre; i collegamenti si tolgono da entrambe le parti», «il codice non si riusa…», «la voce task.deleted: la leggono chi gestisce il progetto e chi modera…»); `pages/task/DeleteTaskDialog.test.tsx` («Giulia elimina una sua task: … fuoco sulla riga che prende il posto», «una task con una sessione di Claude viva: …») |
| Il filtro «Made with Claude» del registro, e «Undid:» sotto l'inversa | `pages/admin/ChangeLogPage.tsx` (`?via=claude`), `pages/admin/ChangeEntry.tsx`; dati in `data/changelog/*` (`listChanges({ via })`) | `pages/admin/ChangeEntry.claude.test.tsx` (««Person» = Giulia trova le voci col segno; «Made with Claude» isola solo quelle, nell'indirizzo», «chi non legge nessuna voce col segno non vede il filtro…», «l'inversa ha il suo prima e dopo e sotto «Undid: …»…») |
| La notifica `task.assigned` (*decisione del maintainer*, 2 nov 2026) | scrittura in `data/api-mutations.ts` (`publishAssigned`), resa in `notifications/NotificationItem.tsx` | `data/claude/via.test.ts` («chi riceve una task la riceve; non chi la perde, non chi se la assegna da solo», «una task nata dalla conversione di una richiesta avvisa chi la riceve…»); `notifications/NotificationItem.claude.test.tsx` («titolo del tipo, corpo col prefisso e «Undone by Giulia Ferri», in en e in it») |

### `task.assigned` contro il web di oggi

Sul web, per quanto risulta, assegnare un ticket **non avvisa nessuno**: `patchTicket`
(`apps/server/src/services/tickets.ts`) scrive solo l'evento di ticket
`assignee_changed` (`{ from, to }`), e fra i `notification_kind` di
`packages/db/src/schema.ts` non ce n'è uno per l'assegnazione. La notifica del
prototipo è quindi una **cosa nuova**, non una parità: per il motore serve un
`notification_kind` nuovo, con la regola di rollback e quella dei cambi
additivi verso l'app (§5 dei follow-up). Le sue regole, decise qui: parte per
chiunque riceva una task, da una persona o da Claude per conto di qualcuno;
non parte per chi se la assegna da solo, per una task creata da
un'automazione (c'è già il suo avviso) né se l'assegnatario è Claude (R-K5);
quando `planTask` riassegna, il nuovo assegnatario riceve solo
`task.assigned`, non anche `planning.changed`; dentro un «Annulla» non parte
nessuna notifica, e quella di prima si legge «Undone by …».

## Le differenze deliberate del design

Dalla sezione «Cosa cambia deliberatamente» del design, le tre che toccano il
comportamento rispetto all'area 3 e al web:

1. **L'anti-obiettivo dell'area 3** («una modifica senza che l'utente l'abbia
   vista e confermata») è sostituito dalle tre regole di «L'anti-obiettivo
   dell'area 3 che cambia» *(maintainer)*: un'azione di classe A parte
   subito, ma è sempre una riga nella conversazione e una voce nel registro,
   e si annulla. Nel prototipo: `data/claude/actions.ts`, la riga
   `executed` (che «Ferma» non taglia, ruling T5) e `UndoControl`.
2. **«Le modifiche sono proposte da confermare»** dell'area 3 lascia il posto
   alle classi A–D, anche nella destinazione «Claude» *(maintainer)*. Fuori:
   la Chat (@Claude), dove le regole dell'area 4 restano — tutto proposte,
   niente «Annulla» — ma le conferme portano il segno (decisione 5 del
   piano).
6. **Una task si può eliminare** *(maintainer)*, anche a mano, con la voce
   `task.deleted` nel registro. Sul web oggi non c'è: nessuna rotta di
   `apps/server/src/routes/tickets.ts` elimina un ticket (le `DELETE` sono su
   collegamenti, design, piano e pre-approvazione). Cosa succede a figlie,
   collegamenti e codici: §15 dei follow-up.

Le altre tre (3, 4 e 5 del design: la risposta onesta, il segno delle bozze
di Posta e Supporto, i due dati nuovi del motore delle automazioni) sono
state costruite nel 10b e stanno nella sezione che segue. L'elenco di ciò
che il piano 10a rinviava (scenari S0–S6b, automazioni dal riquadro, pagine
da riempire, «Claude può aiutarti a…», righe «Filtro» e «Bozza in un
campo», «Bozza di Claude», lingua e tema, azioni in blocco di S4) sta in
«Rinviati al 10b» di `ossatura-follow-ups.md`.

# Area 10b — parità con il web (5 nov 2026)

Stesso schema del 10a: il web non ha un riquadro di Claude, quindi una riga
per ogni voce **nuova**, dove vive e il test che la esercita (titolo fra
virgolette, anche solo l'inizio). Percorsi relativi a `src/renderer/`. Le
scelte del costruttore e del controller, ognuna col suo costo se sbagliata,
stanno in `ossatura-follow-ups.md` («Area 10b — minori aperti»); le regole da
scrivere prima del motore sono le §16–§18 di quel file.

Piano: `docs/plans/2026-11-02-desktop-area10b-plan.md`. Shape:
`.impeccable/shape/{claude-scenarios,claude-automations,claude-drafts,claude-suggestions}.md`.

| Voce | Dove vive ora | Test |
|---|---|---|
| S0, la risposta onesta (nove voci, un clic scrive la frase nella casella) *(differenza 3)* | `domain/claude/intents/general.ts`, `data/claude/answersData.ts`; resa in `pages/claude/conversation/CapabilitiesList.tsx` | `domain/claude/intents.10b.data.test.ts` («S0, la risposta onesta»); `pages/claude/conversation/Scenarios.test.tsx` («S0, la risposta onesta»); `emptyInstance.test.tsx` («S0 risponde, S2 dice «No project has stalled tasks»…») |
| S1, un'automazione dal riquadro: la scheda di scelta del reparto, la bozza spenta e senza proprietario, la riga della prova | `domain/claude/intents/automation.ts`, `data/claude/catalogMore.ts`, `data/claude/trial.ts`, `domain/automations/draftFlow.ts`; resa in `pages/claude/conversation/QuestionCard.tsx`, `TrialRow.tsx` | `data/claude/automationTurn.test.ts` («S1: Laura dalla pagina Support di ACQ»); `data/claude/automations.test.ts` («createAutomation dal catalogo», «trialAs: la prova senza effetti»); `pages/claude/conversation/TrialRow.test.tsx` («S1: la riga della prova»); `data/claude/neverInCatalog.test.ts` |
| Il costruttore che si apre da sé dopo la prova (D2) e «Back to <pagina>» | `layout/claudePanel/ClaudePanel.tsx`, `pages/automations/builder/BuilderPage.tsx` | `pages/claude/conversation/Scenarios.test.tsx` («S1 nel riquadro: il costruttore si apre da sé (D2)», «nessun esempio passa (`openSimId` `null`)…») |
| La prova (anche a mano) dice «Wouldn't start» quando il filtro non passa (D3) | `data/automations/simulate.ts`, `pages/automations/test/*` | `pages/automations/test/Test.test.tsx` («un esempio scritto a mano che il filtro esclude: «Wouldn't start»…»); `pages/claude/conversation/TrialRow.test.tsx` |
| «Avvisa» un reparto e i due dati di `request_created` (urgenza, dal supporto) *(differenza 5)* | `data/automations/plans.ts` (`planNotify`), `sources.ts`, `domain/automations/triggerFields.ts`, `validate.ts` | `data/automations/people.test.ts` («planNotify»); `domain/automations/validate.test.ts` («department_cant_see: «Avvisa» un reparto di cui nessuno vede il progetto»); `data/automations/simulate.test.ts` |
| S2, i progetti fermi (ipotesi e «Details», ristretto al progetto del contesto) | `domain/claude/intents/stalled.ts`, `data/claude/answersData.ts` (`stalledProjectsFor`); resa in `AsideRow.tsx`, `AssistantMessage.tsx` | `domain/claude/intents.10b.data.test.ts` («S2, i progetti fermi», «S2 ristretto al progetto del contesto»); `Scenarios.test.tsx` (««Hypothesis» e «Details»») |
| S3, la spesa del mese (solo con `usage.view`, per gli altri la somma dei loro progetti) | `domain/claude/intents/spend.ts`, `answersData.ts` (`spendThisMonthFor`) | `domain/claude/intents.10b.data.test.ts` («S3, la spesa del mese»); `data/claude/answersData.test.ts` («spendThisMonthFor») |
| S4 e le schede in blocco (5 righe e «Show N more», righe a parte con «Who?») | `domain/claude/intents/archive.ts`, `answersData.ts` (`archiveCandidatesFor`); resa in `ProposalCard.tsx` | `data/claude/bulk.test.ts` («S4 Roberta: archiviare in blocco»); `Scenarios.test.tsx` («S4, la scheda in blocco») |
| S5, aggiungere una persona a un progetto (scheda C con la riconferma, o bloccata dall'escalation) | `domain/claude/intents/member.ts`, `data/admin/members.ts` | `Scenarios.test.tsx` («S5, la scheda bloccata»); `pages/claude/conversation/ProposalCard.classes.test.tsx` («scheda C: la riconferma») |
| `member.added` *(D4, maintainer)*: «You've been added to ACQ as Developer», a mano e da Claude per conto di qualcuno, mai per chi aggiunge sé stesso; «Undone by …» derivato a lettura | `data/admin/members.ts` (`memberAddedRecipientOf`, `writeJoin`), `notifications/NotificationItem.tsx` | `data/admin/memberAdded.test.ts`; `notifications/NotificationItem.memberAdded.test.tsx` |
| Bozze nei campi e segno unico «Bozza di Claude» *(differenza 4)*: risposta di supporto, note di rilascio, corpo dell'email, descrizione di una task *(D1)*; la riga `draft` («Put it in the field», «Undo» solo a pagina aperta) | `layout/claudePanel/fillable.ts`, `data/claude/drafts.ts`, `domain/claude/intents/draft.ts`; `tasks-ui/ClaudeDraftMark.tsx`; resa in `pages/claude/conversation/DraftRow.tsx` | `layout/claudePanel/fillable.test.tsx` («il runner delle bozze»); `data/claude/drafts.test.ts`; `pages/claude/conversation/DraftRow.test.tsx` («La riga `draft`»); `tasks-ui/ClaudeDraftMark.test.tsx` |
| Note di rilascio sulla PR (modificabili da chi può, «Save» a mano) | `data/releases/notes.ts`, `visibility.ts` (`canEditReleaseNotes`), `writes.ts` | `data/releases/notes.test.ts` («releaseNotesDraftFor», «setPrReleaseNotes») |
| Azioni della pagina: filtro, filtro salvato, lingua, tema, ciascuna con «Undo» | `layout/claudePanel/pageActions.ts`, `domain/claude/intents/page.ts`, `data/api-mutations.ts` (`saveFilterAs`); resa in `PageActionRow.tsx` | `layout/claudePanel/pageActions.test.tsx` («il filtro della pagina sotto», «il filtro salvato nella riga eseguita»); `data/claude/savedFilter.test.ts` |
| «Claude può aiutarti a…» in cinque pagine (con «Not now» per oggetto) | `data/claude/suggestions.ts`; resa in `tasks-ui/ClaudeSuggestionRow.tsx` | `data/claude/suggestions.test.ts` («le cinque righe di partenza», «il «mai se»»); `tasks-ui/ClaudeSuggestionRow.test.tsx` (««Not now»») |

## Le differenze deliberate del design (3, 4, 5) e dove sono costruite

3. **La risposta onesta** *(maintainer)*: una domanda non riconosciuta non
   riceve più una risposta generica e plausibile, ma l'elenco delle nove cose
   che Claude sa fare, con una frase d'esempio per voce. Nel prototipo: S0,
   riga 1 della tabella. Sul web non c'è un confronto: le chat Docs e di
   progetto rispondono con il modello a ogni domanda.
4. **Il segno delle bozze di Posta e Supporto** *(scelta del costruttore)*:
   «Bozza di Claude» è un segno unico, per tutti e quattro i campi, e resta
   finché il testo è quello di Claude (§16). Nel Supporto il bottone «Claude's
   draft» diventa «Ask Claude» *([DR 5], maintainer)* e sparisce
   `support.reply.editedFrom` (P12).
5. **Il motore delle automazioni** *(scelta del costruttore)*: due dati
   nuovi su `request_created` (urgenza, dal supporto) e l'avviso a un reparto
   (`NotifyPlan.personIds`, P23). Per il motore sono cambi additivi agli
   schemi dell'evento e del passo «Avvisa»: i campi nuovi nascono opzionali
   (regola dei cambi additivi verso l'app), e un'automazione scritta prima
   resta valida.

## Cosa fa il web oggi, per le due voci che lo toccano

- **Note di rilascio** *(per quanto risulta da CLAUDE.md)*: sul web la nota
  di rilascio è del giro notturno del worker, per progetto
  (`projects.doc_auto_update`): la scrive il modello dai commit, non una
  persona, e non è un campo della singola PR. Quella del prototipo è un campo
  della PR che una persona scrive o si fa preparare da Claude: è una
  funzione **nuova**, non una parità; per il motore serve un posto dove
  salvarla (un campo sulla PR o sul rilascio) e il permesso
  `canEditReleaseNotes` (`tickets.edit` o `release.merge`).
- **`member.added`** *(D4)*: come `task.assigned` nel 10a, per quanto
  risulta, sul web aggiungere un membro a un progetto **non avvisa
  nessuno**, e fra i
  `notification_kind` di `packages/db/src/schema.ts` non c'è un tipo per
  l'aggiunta. È una cosa nuova, non una parità: per il motore serve un
  `notification_kind` nuovo, con la regola di rollback (scendere d'immagine
  sul server finché ne esistono righe dà 500 su `/api/inbox`) e quella dei
  cambi additivi verso l'app (§5 dei follow-up: campi nuovi opzionali,
  `readerSchema` per l'enum). Le sue regole, decise qui: parte quando una
  persona aggiunge qualcuno, quando lo fa Claude per conto di qualcuno e
  dalle proposte della posta (`writeJoin`, P25); non parte per chi aggiunge
  sé stesso né se il destinatario è Claude (P8); il ruolo si legge a lettura
  (`roleId`, mai il nome salvato); dopo un «Annulla» la notifica resta con
  «Undone by …» e il codice del progetto diventa testo.
