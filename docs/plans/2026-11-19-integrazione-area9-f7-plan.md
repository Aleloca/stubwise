# Integrazione area 9, F7 — le azioni di Claude dell'area 9: piano

> Design: `docs/plans/2026-11-16-integrazione-area9-design.md`, «F7 — azioni
> di Claude dell'area 9 (D-14)». Specifica dell'app: il prototipo,
> `apps/desktop/src/renderer/data/claude/catalog.ts` (le 26 voci dell'area 9,
> da `archiveProject` a `updateWebhook`), `claude/classes.ts` (la classe
> calcolata, la C da `REAUTH_REQUIRED`), `data/auth/reauth.ts`,
> `data/changelog/types.ts` (`via`, `undoOf`, `undoneEntry`). Invarianti:
> `docs/invariants/permissions.md`, `second-factor.md` (la riconferma, il
> PAT desktop), `change-log.md`, il catalogo chiuso (`claude-actions-never.test.ts`).
> Registro dei rimandi: «La classe C… arriva con l'area 9», «confirmEdited
> salta `reauth()`», «Gli insiemi `CLAUDE_*_PERMISSIONS`», «"By Claude" e la
> riga "Undid…" restano spenti fino a F7».
> Branch: `feat/area9-f7` da `feat/integrazione-area9` (dopo F6, che è già
> dentro: archivia e riapri hanno le loro rotte).

## Prima del codice

- Le **[DECIDE] M-1…M-8** in fondo. Il piano è scritto con le (a).
- **Fatti del codice che il design non dice**:
  - **la C non esiste sul server**: `CLAUDE_DECLARED_CLASS` è `"A" | "B"`
    (`packages/shared/src/schemas/claude-actions.ts`, «La C (riconferma) è
    la fetta 4»), e `POST /api/claude/proposals/:id/confirm` non chiede mai
    la riconferma. La riconferma del desktop (0132) e `requireReauth`
    (`partialReauth`, F3) ci sono già;
  - **ogni voce del catalogo del server dichiara la sua `route`**
    (`apps/server/src/claude-actions/catalog.ts`, `CatalogEntry.route`): il
    test d'accordo può leggere il `config.reauth` di quella rotta dal
    registro delle rotte (`route-access.test.ts`), senza una seconda lista;
  - **l'accesso di una voce è solo `project` o `user`**
    (`CatalogEntry.access`): le azioni d'istanza (modello, budget, provider,
    account git, plugin, webhook…) vogliono anche `instance`, valutato come
    nella rotta (`instancePermissions.has`);
  - **cinque rotte hanno la riconferma PARZIALE**, cioè solo se il corpo
    porta un segreto: `PATCH /api/ai-providers/:id`,
    `PATCH /api/git-accounts/:id`, `PATCH /api/settings/google-workspaces/:id`,
    `PATCH /api/settings/webhooks/:id` e `PUT /api/settings/instance`
    (storage, budget, allegati). Il design dice «senza segreti»: gli schemi
    degli argomenti di quelle voci omettono i campi segreti per costruzione
    (`strict`), quindi la riconferma parziale non scatta mai da Claude;
  - **le righe scritte da Claude sono già marcate**: `execute.ts` mette
    `stubwise.via_claude_action_id` nella transazione, e le colonne
    `via_claude_action_id` delle task e dei commenti la prendono di
    DEFAULT. `change_log` NON ha quella colonna: la voce di una scrittura di
    Claude oggi non si distingue da una a mano (il rimando «By Claude» di F2);
  - **«Annulla» c'è già** (`undo.ts`, gli inversi, `changed_after` con lo
    `stamp` dell'oggetto): le voci dell'area 9 ne riusano la forma, con lo
    stato di prima come argomenti dell'inverso (`was`, come il prototipo).
- **Le 26 voci, le rotte del server e la classe** (dal prototipo; la classe
  derivata dalle rotte):

  | Voce | Rotta | Classe | Annulla |
  |---|---|---|---|
  | `archiveProject` / `reopenProject` | `POST /api/projects/:projectId/archive` / `reopen` | B | l'una l'altra |
  | `addMember` / `removeMember` / `setMemberRole` | `PUT` / `DELETE /api/projects/:projectId/members/:userId` | **C** | l'inverso |
  | `updateProjectGeneral`, `setProjectAi`, `saveProjectAutomations` | `PATCH /api/projects/:projectId` | B | `was` |
  | `pauseQueue` / `resumeQueue` | `POST /api/projects/:projectId/queue/pause` / `resume` | B | l'una l'altra |
  | `retryJob` | `POST /api/instance/jobs/:id/retry` | B | no |
  | `setModel` | `PATCH /api/settings/models` | B | `was` |
  | `saveBudget`, `setAttachments`, `saveStorage` | `PUT /api/settings/instance` (parziale) | B (vedi M-1) | `was` |
  | `saveAutomation` | `PUT /api/settings/automation` | B | `was` |
  | `setProviderEnabled` | `PATCH /api/ai-providers/:id` (parziale) | B | `was` |
  | `moveProvider` | `POST /api/ai-providers/reorder` | B | `was` |
  | `updateGitAccount` | `PATCH /api/git-accounts/:id` (parziale) | B | `was` |
  | `setDefaultReviewer` | `PUT` / `DELETE /api/git-accounts/:id/default-reviewer` | B | l'inverso |
  | `updateGoogleApp` | `PATCH /api/settings/google-workspaces/:id` (parziale) | B | `was` |
  | `registerPlugin` / `updatePluginRef` | `POST /api/plugins` / `POST /api/plugins/:id/update` | **C** | no |
  | `rerunSmoke` / `removePlugin` | `POST /api/plugins/:id/smoke` / `DELETE /api/plugins/:id` | B | no |
  | `updateWebhook` | `PATCH /api/settings/webhooks/:id` (parziale) | B | `was` |

  Il design elenca anche `saveStorage` fra le C: sul server la sua rotta è
  a riconferma PARZIALE (solo col segreto), quindi senza segreti la classe
  derivata è B. È la M-1.
- **Primo numero libero**: 0195 (dopo la 0194 di F6).

## Regole di lavoro (le solite)

- TDD con le mutazioni (`mut.py`), che girano e danno l'esito sbagliato.
- I file di test toccati si lanciano INTERI, uno alla volta, e con loro i
  test che asseriscono le risposte toccate (grep in tutti i pacchetti, la
  lezione di F5); `pnpm -r typecheck` a ogni task (anche gli script).
- Commit su percorsi espliciti, lint + test + commit + push in una catena.
- Campi dei client solo additivi, coi default; nessun valore nuovo di un
  enum che il client vecchio non sa aprire.
- Container dei test tolti per id.
- Ogni scrittura lascia la sua voce nel registro, nella SUA transazione.

## Task

### Task 1 — La classe C e la conferma con la riconferma di chi conferma

- `CLAUDE_DECLARED_CLASS` diventa `"A" | "B" | "C"`. Il «chiede la
  riconferma» NON diventa un motivo nuovo di `claudeClassReasonSchema`
  (un'unione discriminata, che `readerSchema` non apre: un client vecchio
  fallirebbe il parse), ma un campo a sé della proposta, `reauth: boolean`,
  default false (M-3). La classe `C` nell'enum `cls` invece è sicura: gli
  enum `readerSchema` li apre.
- **Il test d'accordo** (`claude-actions-class.test.ts`): per ogni voce, la
  classe dichiarata è C se e solo se `config.reauth` della sua `route` è
  impostato (le rotte dal registro, come `route-access.test.ts`). Una voce
  con `partialReauth` è B, e i suoi argomenti NON hanno i campi segreti
  (asserito dallo stesso test: lo schema `strict` rifiuta il campo).
- **La conferma** (`POST /api/claude/proposals/:id/confirm`) dichiara
  `partialReauth`: se il gruppo (dopo `selected` ed `edited`) contiene una C,
  chiama `requireReauth` sulla richiesta di CHI CONFERMA (la sua finestra;
  il PAT desktop riconfermato vale come nelle altre rotte). Mai la
  riconferma di chi ha chiesto: la conferma è sempre di chi conferma.
  L'elenco chiuso delle `partialReauth` cresce di questa rotta.
- **Le azioni d'istanza**: `CatalogEntry.access` accetta anche
  `{ kind: "instance", permission }`, valutato come la rotta (403
  `forbidden` col permesso nel «Who?»).
- *Test*: la conferma di un gruppo con una C senza riconferma → 403
  `reauth_required` e niente eseguito; con la riconferma → eseguito; un
  gruppo di sole B non la chiede; la riconferma di chi ha chiesto non basta
  a chi conferma (due persone).

### Task 2 — Le C: membri e plugin

- `addMember`, `removeMember`, `setMemberRole`: gli argomenti della rotta
  (`projectId`, `userId`, `roleId`), l'accesso `project.members.manage`, il
  servizio dei membri (le stesse regole: `escalation`, `last_manager`,
  Claude mai membro a mano). Annulla: l'inverso col ruolo di prima.
- `registerPlugin`, `updatePluginRef`: gli argomenti della rotta più
  `trusted: true` OBBLIGATORIO (M-6, «Mi fido»): la scheda dice che
  registrare un plugin ne esegue il codice (CLAUDE.md, «Registrare un
  plugin ne ESEGUE già il codice»). Nessun «Annulla» (irreversibile: lo
  smoke run parte subito).
- *Test*: ogni voce col suo NEGATIVO di permesso (403, niente cambia) e la
  classe C; `trusted` assente → 400 `invalid`.

### Task 3 — Le B del progetto

- `archiveProject`, `reopenProject` (i servizi di F6: `busy` col suo motivo,
  le esecuzioni annullate); `updateProjectGeneral`, `setProjectAi`,
  `saveProjectAutomations` (il `PATCH` del progetto, le voci di
  `recordProjectChanges`, `pulse_needs_backlog`); `pauseQueue`,
  `resumeQueue`; `retryJob` (irreversibile).
- Su un archiviato tutte rispondono `conflict` (F6), tranne `reopenProject`.
- *Test*: per voce, esecuzione + voce del registro + «Annulla» col
  `changed_after` (un salvataggio a mano dopo Claude → l'annulla rifiuta);
  i NEGATIVI di permesso.

### Task 4 — Le B dell'istanza

- `setModel`, `saveBudget`, `saveAutomation`, `setProviderEnabled`,
  `moveProvider`, `updateGitAccount` (senza token), `setDefaultReviewer`,
  `updateGoogleApp` (senza secret), `rerunSmoke`, `removePlugin`,
  `setAttachments`, `saveStorage` (senza segreti), `updateWebhook` (senza
  segreto). Gli argomenti sono gli schemi delle rotte MENO i campi segreti,
  `strict` (M-4).
- *Test*: per voce, esecuzione e annulla; un argomento segreto → 400
  `invalid` (lo schema), mai una riconferma parziale; NEGATIVO di permesso.

### Task 5 — Il registro sa che è stato Claude (0195)

- **0195**: `change_log.via_claude_action_id` (uuid, DEFAULT dalla stessa
  variabile delle task; senza FK, perché il trigger append-only lascia passare
  solo le `SET NULL` delle FK di oggi) e `change_log.undo_of_action_id`
  (l'azione che una voce annulla, dalla variabile nuova
  `stubwise.undo_of_claude_action_id` che `undo.ts` mette nella sua
  transazione).
- A lettura (M-5): `via: "claude" | null` e `undoOf` (la voce annullata, solo
  se chi guarda la legge) con `undoneEntry`, come il prototipo; i campi sono
  additivi in `changeEntrySchema`. `claudeActionId` non esce.
- *Test*: una voce scritta da Claude ha `via: "claude"`, una a mano no; la
  voce dell'annulla porta la voce annullata, e non la porta a chi non legge
  quella.

### Task 6 — Il catalogo chiuso e il client

- `claude-actions-never.test.ts` cresce dei divieti del design: PAT,
  inviti, segreti, decisioni, merge, approvazioni dei piani, il ruolo
  d'istanza, i reset, disattivare; e nessun modulo nomina le rotte di un
  segreto (`/ingestion-key`, `/webhook-secret`, `/secret`, `/identity-secret`).
- `claudeActionSignatures` (le firme che il modello vede) include le voci
  nuove, coi permessi di chi chiede (le voci che non può proporre non
  compaiono, come oggi).
- I `CLAUDE_*_PERMISSIONS` del prototipo: ridotti all'elenco proponibile del
  server (con 94; il rimando).
- Il renderer (94): `confirmEdited` passa da `reauth()` come Confirm.

### Task 7 — Il deploy-log, la review

- Deploy-log: server (0195) poi caddy; niente worker. Rollback: il server
  vecchio non conosce le voci nuove del catalogo; una proposta con una voce
  nuova ancora aperta la rifiuta (`invalid`) alla conferma; le colonne della
  0195 restano e il server vecchio le ignora.
- Review con un revisore fresco. Review Focus:
  - una C eseguita senza la riconferma di chi conferma (anche via `edited`,
    o con la C non selezionata e poi riselezionata);
  - un segreto che passa da Claude (argomenti, `edited`, l'inverso);
  - una voce dell'istanza eseguita senza il permesso d'istanza;
  - un «Annulla» che sovrascrive una modifica a mano;
  - una voce del registro di Claude senza `via`, o un `undoOf` letto da chi
    non legge la voce annullata.

## [DECIDE]

- **M-1 — La classe di `saveStorage`.**
  - **(a) consigliata**: B. Senza segreti la sua rotta non chiede la
    riconferma (`PUT /api/settings/instance` è parziale), e la C si deriva
    dalla rotta (il test d'accordo, una sola regola).
  - (b) C come dice il design: un'eccezione dichiarata al test d'accordo.
- **M-2 — Dove si chiede la riconferma di una C.**
  - **(a) consigliata**: sulla conferma (`partialReauth`, `requireReauth` se
    il gruppo ha una C), con la finestra di chi conferma.
  - (b) una rotta a sé `…/confirm-reauth` per i gruppi con una C.
- **M-3 — Come la proposta dice «chiede la riconferma».**
  - **(a) consigliata**: un campo `reauth: boolean` della proposta (e della
    scheda), default false: additivo, il client vecchio lo ignora.
  - (b) un motivo `{ kind: "reauth" }` in `claudeClassReasonSchema`: è
    un'unione discriminata, che `readerSchema` non apre, e un client vecchio
    fallirebbe il parse della proposta.
- **M-4 — I segreti nelle voci a riconferma parziale.**
  - **(a) consigliata**: gli argomenti omettono i campi segreti (`strict`):
    Claude non può nemmeno proporli.
  - (b) ammessi, e la voce diventa C quando ne porta uno.
- **M-5 — «By Claude» e «Undid…» nel registro.**
  - **(a) consigliata**: con F7 (0195), derivati a lettura come il
    prototipo.
  - (b) dopo, con l'area 10.
- **M-6 — «Mi fido» sui plugin.**
  - **(a) consigliata**: `trusted: true` obbligatorio negli argomenti, e la
    scheda dice cosa vuol dire; Claude lo propone solo se la persona l'ha
    scritto (la regola nella descrizione della voce).
  - (b) niente argomento: basta la conferma.
- **M-7 — L'annulla delle impostazioni modificate nel frattempo.**
  - **(a) consigliata**: rifiuta (`changed_after`), come le task: non
    sovrascrive una modifica a mano.
  - (b) sovrascrive.
- **M-8 — Le voci irreversibili** (`retryJob`, `rerunSmoke`,
  `removePlugin`, `registerPlugin`, `updatePluginRef`).
  - **(a) consigliata**: B (o C) senza «Annulla», col motivo `irreversible`
    nella scheda, come il prototipo.
  - (b) fuori dal catalogo.

## Cosa F7 non fa

- Le azioni di Claude delle altre aree (10: automazioni; 11: Docs).
- La cassaforte (D-12): nessuna voce.
- I permessi dei reparti (F8).

## Stima

Sette task; il più largo è il 4 (tredici voci con i loro inversi). Le
voci dell'istanza riusano i servizi delle rotte: nessuna logica nuova di
dominio.
