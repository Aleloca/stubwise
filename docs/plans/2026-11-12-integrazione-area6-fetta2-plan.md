# Integrazione area 6, fetta 2: la classificazione nuova (piano)

> Design: `docs/plans/2026-11-12-integrazione-area6-design.md` (§Fette, D3 =
> a, D4 = a). Specifica: il prototipo (`apps/desktop/src/renderer/data/model.ts`
> 2385–2699, `data/mail/{classify,reads,proposals,visibility,writes}.ts`,
> `.impeccable/shape/mail.md`). Esecutori: stubwise-72 (server, worker,
> api-client), stubwise-94 (renderer). Branch `feat/area6-f2`, da
> `feat/area6-f1-fix` (966144ec). Invarianti: `docs/invariants/mail-calendar.md`
> (TUTTE: questa fetta ne riscrive la dottrina), `permissions.md`,
> `agent-sessions.md`.
> Registro, voci dell'area 6 che entrano qui: il blocco «Posta importante»
> della Home. Restano dopo: «bozza del corpo dell'email» (F3), i riferimenti
> a Google Drive (F5), il deep link `stubwise://google`.

## Cosa fa

1. **Ogni email al modello** (D3): via l'ammissione d'istanza e le regole
   della posta per progetto, anche dal web. Resta escluso solo ciò che la
   casella stessa ha mandato (non è una richiesta ricevuta) *(O)*.
2. **Una classificazione per email** (Message-ID), con importanza (`high`,
   `normal`, `low`), scadenza (una data), progetti certi e incerti.
3. **Proposte di tipo task** (nuovo, il caso normale) e richiesta, coi campi
   modificabili e la conferma parziale; l'incaricato fuori dal progetto entra
   come Contributor.
4. **Una proposta condivisa per email e progetto** (D4): una notifica per ogni
   destinatario in Stubwise membro del progetto, MAI agli admin non
   destinatari; il primo che decide la chiude per tutti.
5. **«Posta importante»** in Home e la vista «Importanti».

## 1. Il costo, prima di tutto

**Da sostituire con la misura** (le tre query di sola lettura su produzione,
`cost.sql`, autorizzate dal maintainer e da lanciare da lui; questa sezione e
la voce del deploy-log si aggiornano coi soli aggregati appena arrivano).

Stima dichiarata, oggi:

- per classificazione: input ≈ 6.000 token (istruzioni, i progetti candidati
  coi titoli aperti, l'estratto fino a 8.000 caratteri, il contesto del
  thread), output ≈ 400 token, più il prompt di sistema del CLI letto dalla
  cache; con i prezzi di listino di Haiku (da verificare al rilascio: 1 $ per
  milione in input, 5 $ in output) **≈ 0,008 $ per email**;
- volume: oggi l'ammissione tiene fuori la posta automatica e quella senza
  regole; con D3 entra tutta. Ipotesi da sostituire: 80 email ricevute al
  giorno per casella, 10 caselle → 800 al giorno, **≈ 6,4 $ al giorno, ≈ 190 $
  al mese**;
- ciò che lo riduce, già nel piano: una classificazione per Message-ID (la
  stessa email in N caselle si paga una volta), per thread solo l'ultimo
  messaggio (come oggi), il cooldown del thread, il tetto giornaliero per
  casella (`GMAIL_MAX_PER_DAY`, 200), il budget mensile d'istanza che ferma i
  run di sfondo, l'interruttore personale.

La regola di rilascio (D3): la classificazione nuova si accende solo dopo che
la misura vera è scritta qui e nel deploy-log.

## 2. `mailbox_owner` riscritta (D4)

- **Audience nuova `mail_recipients`** per `google.proposal` delle proposte
  nuove: i destinatari dell'email (mittente, `to`, `cc`; MAI `bcc`, che Gmail
  non mostra a chi riceve) che sono utenti di Stubwise (`users.email` o
  `google_accounts.email`, normalizzati) **e** membri del progetto della
  proposta. Un full admin è membro implicito di ogni progetto: riceve la
  proposta **solo se è anche destinatario**. Un admin non destinatario non la
  riceve, e non c'è un ramo `if (admin)` da sbagliare.
- `mailbox_owner` resta per le proposte di PRIMA (le righe già aperte si
  decidono come oggi) e per il calendario, che non ha destinatari in comune
  *(O)*.
- La notifica non porta lo stato della decisione: «Confermata da X», «2 di 3»,
  i codici nati si DERIVANO a lettura dalla proposta (la regola dei campi di
  una card).
- **Test negativi** (prima del codice): un admin non destinatario, un
  destinatario non membro, un membro non destinatario, un progetto invisibile
  a un destinatario, un `bcc` (non lo vediamo, quindi nessuna notifica): zero
  notifiche e 404 sulla proposta. La stessa email in due caselle collegate: UNA
  proposta, due notifiche. Il primo che conferma la chiude per l'altro (409
  `already_handled` con `decidedBy`).

**Decisioni del maintainer *(M)*, 12 nov 2026: A = (a), B = (b)** (sotto le
opzioni com'erano poste). Con B = (b) il publish NON filtra per interruttore:
la notifica arriva a tutti i destinatari membri, anche a chi le ha spente; un
test lo fissa, e restano i negativi sugli admin non destinatari.

**[DECIDE] A — un destinatario membro che NON ha collegato la casella.**
- (a, consigliata) Vede la proposta con l'estratto (era destinatario), e il
  messaggio intero solo se è nella SUA casella; la Posta resta personale.
- (b) Solo chi ha la casella collegata riceve la proposta.

**[DECIDE] B — l'interruttore «Proposte attive per questa casella» e le
notifiche.** L'email si classifica se almeno una casella che la contiene ha le
proposte accese (il prototipo).
- (a, consigliata) Chi le ha spente non riceve la notifica di una proposta
  condivisa, anche se un altro destinatario le ha accese; la vede comunque
  accanto all'email nella sua Posta.
- (b) L'interruttore decide solo se classificare: la notifica arriva a tutti i
  destinatari membri.

## 3. Togliere ammissione e regole senza rompere nessuno

Verso i client solo cambi additivi (`.default()`, `readerSchema`). L'ordine:

1. **Worker** (task 2): l'ingestione non chiama più `admit`; tutta la posta
   ricevuta entra (`admitted = true`), il contesto del thread resta com'è. Non
   si scrivono più righe `email_rejections`; la potatura dei 30 giorni le
   svuota da sola.
2. **Server**: `GET /api/me/mail/rejections` resta e risponde con la stessa
   forma (vuota in 30 giorni): la schermata «Le mail tenute fuori» dell'app
   mobile non si rompe. `GET/PUT /api/projects/:id/email-routes`,
   `GET /api/projects/:id/email-labels`, `GET/PATCH /api/settings/mail-admission`
   restano un rilascio, ignorate dal worker; si tolgono col rilascio dopo.
3. **Web** (stesso rilascio del caddy): via `project-email-routes-section`
   dalla pagina del progetto e `mail-admission-section` da Impostazioni →
   Google, con i loro test e le chiavi i18n.
4. **Dopo** (registro): le colonne di `instance_settings` dell'ammissione e
   `project_email_routes`, insieme alle rotte.

Le invarianti che parlano di ammissione e regole («Il cancello dell'ammissione
si allarga col THREAD…», `admitted`) si riscrivono nel task 9: `admitted`
resta il confine fra «classificabile» e «contesto», ma non lo decide più
`admit`.

## 4. Le forme per il renderer (risposta a stubwise-94)

Tutte additive con default; gli enum nuovi via `readerSchema`.

**Righe di `threads()`**:
- `importance: "high"|"normal"|"low"|null`, `dueDate: "YYYY-MM-DD"|null`,
  `analysing: boolean`, `failed: boolean`, `projectIds: uuid[]` accanto a
  `projectNames`, `snippet: string`;
- filtri `threads({ importance, project, noProject, important })`, dove
  `important: true` vuol dire almeno un messaggio `high` NON letto, dalla più
  recente. Il blocco «Posta importante» usa `threads({ important: true,
  limit: 5 })`.

**Messaggi di `thread()`**: `classification: { state:
"off"|"pending"|"failed"|"done", projectIds, importance, dueDate,
uncertainProjectIds }`.

**Proposte**: `GET /api/me/mail/proposals?message=&status=` e `GET
/api/me/mail/proposals/:id`. La riga è quella che hai proposto:
- `id`, `messageId`, `projectId`, `status: open|confirmed|ignored|handed|failed`,
  `createdAt`, `excerpt`;
- `actions: [{ type, args, label }]`, con `args` per tipo:
  - `create_task` {title, description, assigneeId|null, dueDate|null}
  - `create_backlog_item` {title, description}
  - `update_ticket` {ticketId, patch}
  - `comment_ticket` {ticketId, body}
  - `create_milestone` {name, dueDate}
  - `record_decision` {ticketId?}
  - `choose_project` {projectIds}
- calcolati dal server: `canConfirm`, `canHand`, `canReassign`,
  `blockedIndices`, `outsiders`;
- `decidedBy`, `decidedAt`, `confirmedIndices`, `results: [{kind, id, code}]`,
  `error`, `handedAt`, `handedBy`, `sharedWith`, `origin`.

`update_ticket.patch` porta i campi che `patchTicket` accetta oggi; li fisso al
task 7.

**Decidere**:
- `POST /api/me/mail/proposals/:id/confirm { indices?, edits? }`
- `POST /api/me/mail/proposals/:id/confirm-with-members { indices?, edits?,
  addOutsiders }`. Rotta a sé con `config.reauth` *(O)*: la riconferma si
  dichiara per rotta, e non deve pesare su ogni conferma.
- `POST …/:id/ignore`, `…/:id/hand`, `…/:id/reassign { projectId }`,
  `…/:id/choose-project { projectId }`.

Esiti e codici: quelli che hai elencato (`already_handled` con `decidedBy`,
`forbidden`, `invalid_selection`, `invalid_edits`, `invalid_assignee`,
`invalid_target`, `reauth_required`, `escalation`, `target_above`); con un
rifiuto non cambia niente. Le azioni di `/api/inbox` sulle card restano e
passano dallo stesso servizio (l'app mobile le usa).

## Il modello (tecnico)

- **Migrazione** (il primo numero libero, oggi 0151, da ricontrollare):
  - `email_messages.rfc_message_id`, `classification_state`, `importance`,
    `due_date`, `uncertain_project_ids`;
  - `email_proposals`:
    - `rfc_message_id` (unique con `project_id` per le righe nuove; null nelle
      vecchie);
    - `decided_by_user_id`, `decided_at`, `confirmed_indices`, `results`,
      `handed_at`, `handed_by_user_id`, `audience` (`mailbox_owner` |
      `mail_recipients`);
  - `email_proposal_recipients (proposal_id, user_id, notification_id)`.
- **Destinatari**: un helper `resolveRecipients(addresses) → userIds`
  (`users.email` e `google_accounts.email`, normalizzati con
  `normalizeAddress`), usato da classificatore, publish e letture.
- **Progetti candidati** (il prototipo): un progetto è candidato se almeno un
  destinatario in Stubwise ne è membro, archiviati esclusi; il modello sceglie
  fra i candidati, e con più di uno incerto nasce `choose_project`.
- **Classificazione per Message-ID**: la prima casella che ingerisce l'email
  la classifica; le altre la trovano già classificata (stesso
  `rfc_message_id`) e non pagano. Senza Message-ID la chiave è
  `gmail:<account>:<id>` *(O)*.
- **Il task**: `create_task` crea una task nel progetto (`tickets.create`),
  con incaricato e scadenza; incaricato fuori dal progetto senza
  `addOutsiders` → `invalid_assignee`.

## Task (in ordine, ognuno col suo test rosso e le mutazioni)

1. **Migrazione e schema condiviso**: le colonne e la tabella; i campi
   additivi in `packages/shared` (thread, messaggio, proposta), coi test che
   parsano una risposta SENZA i campi nuovi.
2. **Ingestione senza ammissione**: niente `admit`, `rfc_message_id`
   salvato, `email_rejections` non più scritte; test negativo (una newsletter
   entra).
3. **Classificatore nuovo**: prompt e schema (importanza, scadenza,
   progetti fra i candidati, `create_task`), una classificazione per
   Message-ID, la regola dell'interruttore, budget e tetti di oggi. Golden
   nuovo `mail-classify-v2` (manuale) su 10 email finte, prima di ACCENDERE
   il flag (non prima del merge: col flag spento il prompt non gira); è nel
   task 9.
   Fatto (task 3) *(O)*: candidati dai membri ESPLICITI (`project_members`:
   i full admin, membri impliciti di tutto, renderebbero candidato ogni
   progetto), al più 10 per nome; con un progetto certo gli incerti si
   scartano; «Quale progetto?» nasce senza azioni, che arrivano dopo la
   scelta (si riclassifica per il progetto scelto); la stessa email in
   un'altra casella copia la classificazione del gemello `done`.
4. **Proposta condivisa e audience `mail_recipients`**: publish per
   destinatario membro, i test negativi della §2, la chiusura per tutti.
5. **Letture**: righe e filtri di `/threads`, `classification` sui messaggi,
   `GET /api/me/mail/proposals` (elenco e per id) coi campi calcolati.
6. **Decidere**: confirm (parziale, con `edits`), confirm-with-members
   (reauth, Contributor solo se tutto riesce), ignore, hand, reassign,
   choose-project; le azioni di `/api/inbox` sullo stesso servizio.
7. **`create_task`** e la `patch` di `update_ticket`.
8. **Via regole e ammissione dal web** (§3).
9. **Chiusura**: le invarianti riscritte (`mailbox_owner`, ammissione, «una
   proposta per richiesta»; in «Nessuna scrittura verso Google senza un
   gesto» che APRIRE una conversazione è il gesto che la segna letta, *(O)*
   dalla review del renderer), il deploy-log (la misura, l'ordine server →
   worker → caddy, il rollback: un worker vecchio torna all'ammissione, un
   server vecchio non vede le proposte condivise), il registro.

## Global Constraints

- Posta personale: l'id di chi guarda nella WHERE; una proposta si vede solo
  da destinatario membro (o, passata, da chi ha i permessi di ogni azione).
- Il testo di un'email è contenuto NON fidato: il classificatore resta senza
  tool, e le proposte confermate passano dagli esecutori di oggi.
- Il registro decisioni non è mai scritto dall'AI (`record_decision` resta da
  template).
- Nessuna scrittura verso Google in questa fetta.
- Verso i client solo campi additivi con default; test filtrati; mutazioni sui
  test verdi al primo colpo.

## Review Focus

- L'audience `mail_recipients`: admin non destinatario, destinatario non
  membro, progetto invisibile, la stessa email in due caselle.
- La conferma parziale e i Contributor: niente aggiunto se un'azione fallisce.
- Il costo: una classificazione per Message-ID, davvero.
