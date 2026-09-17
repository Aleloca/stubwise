# Piano — Spostare una proposta sul progetto giusto (17 set 2026)

Design: `2026-09-17-reassign-proposal-design.md`. Sei task. **Nessuna
migrazione, nessuna colonna, nessun enum di stato toccato**: l'unica cosa nuova
è l'azione, più un marcatore dentro un jsonb che già esiste.

Chiusura: `pnpm typecheck`, `pnpm test`, **`pnpm lint` dalla radice**.

---

## Task 1 — L'azione negli schemi condivisi

`reassign_project` entra in `inboxGoogleActionTypeSchema`
(`packages/shared/src/schemas/notification.ts`) e nel suo gemello
`storedActionSchema` (`apps/server/src/services/google-proposal.ts`). **I due
vanno tenuti allineati**: sono la stessa famiglia di `acknowledge_reminder`
della fase 7b, e il motivo per cui un'app vecchia non crasha è che entrambi i
punti di lettura degradano con `safeParse` — verificarlo, non assumerlo.

L'azione porta il `projectId` scelto. Come per le altre, il testo dell'opzione
viene da un **template i18n**, mai da prosa generata.

⚠️ **Non toccare `choose_project`.** Ha già due semantiche opposte (padre vs
figlio) che CLAUDE.md vieta esplicitamente di unificare: questa è una terza
cosa, con un nome suo. Chi è tentato di riusarla rilegga quell'invariante.

## Task 2 — L'esecuzione, in una transazione

In `dispatchAction` (`apps/server/src/services/google-proposal.ts`), un case
nuovo, valido **solo** per `source.source === "email"` — su `"calendar"` e
`"email_triage"` è un'anomalia, non un `target_gone`.

In una transazione sola:

1. **Rifiuto se il progetto scelto ha già una proposta APERTA** su questo
   messaggio → errore `already_proposed`. ⚠️ L'insert esistente ha
   `onConflictDoUpdate` su `(email_message_id, project_id)`: senza questo
   controllo l'azione sovrascriverebbe in silenzio una card legittima. **È il
   punto più facile da sbagliare di tutto il batch.**
2. chiude la proposta corrente: `status: "ignored"`, `outcome: { type:
   "reassigned_to", projectId }` — mai un `ignored` nudo.
3. inserisce la riga per il progetto scelto: `status: "classified"`,
   `proposal_notification_id: null`, `classification` = quella corrente più
   `{ reassignedFrom: <vecchio>, needsReclassification: true }`.
4. `email_messages`: **solo** `updated_at`. Mai `status`, mai `project_id`,
   mai `scope_project_ids`, mai `proposal_notification_id`.
5. registra la decisione con `recordDecision` e il template i18n
   (`decision.email.reassigned`), interpolato coi due nomi di progetto.

**Il tetto `GMAIL_MAX_PROJECTS_PER_MESSAGE` non si applica qui** (design §4):
contiene il fan-out automatico, non una scelta umana.

## Task 3 — Il worker riclassifica prima di pubblicare

In `runProposePhase` (`apps/worker/src/google/poller.ts`), prima di pubblicare
una proposta `classified`: se la sua `classification` porta
`needsReclassification: true`, rifà la classificazione **col contesto del solo
progetto della riga** (non del perimetro del padre), riscrive `classification`
senza il marcatore, poi pubblica.

Il run segue la dottrina di sempre (`classify.ts`): `permissionMode: "default"`,
cwd temporanea vuota, nessun tool, e **rivalidazione di ogni referente** che il
modello nomina. Se dalla rivalidazione non sopravvive nessuna proposta, la riga
si chiude `ignored` con un esito che lo dice — non resta appesa.

Le difese di costo della 6c valgono anche qui (`GMAIL_MAX_PER_DAY`, gate di
budget): una riattribuzione è un run in più, e va contata come gli altri.

## Task 4 — L'azione nell'app e sul web

Nella card di una proposta di posta: «Sposta su un altro progetto» apre la
scelta fra i progetti, poi conferma. La card sparisce al tap come ogni altra
azione (design §3.2) — **nessuno stato «in corso»**, nessun valore nuovo
nell'enum che l'app legge.

L'errore `already_proposed` va **mostrato**, non ingoiato: dice che su quel
progetto una card c'è già, ed è un'informazione utile, non un guasto.

⚠️ In questo repo `render` di RNTL va `await`ato, e le spie vanno azzerate in
`beforeEach`.

## Task 5 — I test, e cosa devono asserire

Il caso centrale, sui dati veri del 17 settembre: la mail «CARELLI — quattro
punti prima del passaggio» attribuita a Wilco, spostata su Carelli.

1. **Le SORELLE non si toccano**: due proposte sullo stesso messaggio, si
   riattribuisce la prima, la seconda resta identica (status, classification,
   notifica). È l'invariante della 6b, e questo batch è il candidato più
   probabile a incrinarla.
2. **Il PADRE non si tocca**: `status`, `project_id`, `scope_project_ids`,
   `proposal_notification_id` e `outcome` identici prima e dopo; solo
   `updated_at` cambia. Asserire i valori, non l'assenza di errori.
3. **Progetto già proposto → `already_proposed`**, e la proposta esistente è
   **invariata** (la prova che il conflitto non ha sovrascritto niente).
4. **Il marcatore fa riclassificare**: il worker vede
   `needsReclassification`, il run parte col contesto del progetto NUOVO
   (asserire quali progetti finiscono nel contesto, non solo che il run è
   avvenuto), e la classification finale non ha più il marcatore.
5. **Senza marcatore non si riclassifica**: una proposta normale viene
   pubblicata senza nessun run in più. È la guardia contro un batch che
   raddoppia la spesa AI di tutta la posta.
6. **Non è offerta dove non deve**: su `calendar` e su `email_triage` l'azione
   non compare, e se arriva lo stesso viene rifiutata.

## Task 6 — CLAUDE.md

Una voce di deploy (rebuild **server + worker + caddy**: il server esegue, il
worker riclassifica, il bundle disegna il bottone; nessuna migrazione, nessuna
env). E un'aggiunta all'invariante esistente su `choose_project`, che oggi
elenca due semantiche: va detto che ne esiste una TERZA cosa con un nome
diverso, e perché non è stata infilata lì dentro.

---

## Fuori perimetro

- **Nessun apprendimento**: spostare N mail non crea una regola di routing
  (design §6). Le regole restano una scelta esplicita dal web.
- **Il calendario non si tocca.**
- **`email_messages.project_id` e `scope_project_ids` non si riscrivono**: sono
  ciò che il routing aveva dedotto, e restano.
