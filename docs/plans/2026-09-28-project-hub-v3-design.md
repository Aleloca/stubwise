# Dettaglio progetto v3, a tre tab — design

28 set 2026. Il maintainer ha ridisegnato con Claude Design la pagina di
dettaglio di un progetto nell'app, perché quella di oggi non gli piaceva.
Riferimento: `docs/design/project-detail/Dettaglio Progetto v3.dc.html`, da
leggere per intero (colori, misure, tipografia). La pagina diventa a **tre
tab**: **Adesso** · **Lavoro** · **Progetto**.

Decisioni del maintainer:
1. **I bottoni di «Tocca a te» portano dove si decide**, non agiscono dalla
   riga:
   - Rispondi apre la domanda;
   - Approva apre il ticket col piano;
   - Mergia apre una conferma.

   Approvare un piano senza leggerlo toglierebbe senso al cancello.
2. **Il merge si fa dall'app**, con una conferma in due passi, come la coda
   di rilascio del web. Oggi nell'app il merge non esiste.

## §1 — Premesse (verificate su `main` 477ba31d)

- L'hub di oggi è `apps/mobile/src/screens/projects/ProjectDetailScreen.tsx`,
  una colonna unica. In ordine: la riga del polso (`pulseLineFor`), i secchi
  (in attesa, in esecuzione, backlog pronto, fermi), poi le sezioni
  Tickets, Backlog, Inbox, Repository, Docs, Roadmap, Monitor e Impostazioni.
  Ogni sezione ha la sua `useQuery`, indipendente.
- **Il polso ha già i dati di «Adesso»**
  (`packages/shared/src/schemas/project.ts:241-441`):
  - `waitingForYou`: `kind` `question`|`plan_approval`, `notificationId`,
    numero, priorità;
  - `waitingForMerge`: `canMerge` calcolato dal SERVER col ruolo;
  - `waitingForOthers`: `who.kind` `requester`|`maintainer`;
  - `running`: `sinceMinutes`;
  - `stalled`: `stalledSince` e `reason`; i giorni li conta il client
    (`lib/stalled.ts`);
  - `backlogReadyCount`: voci in stato `ready`.
- Dove si decide, oggi, nell'app:
  - una domanda dell'agente si risponde dalla sua card d'inbox
    (`InboxCardScreen`, con il `notificationId`);
  - un piano si approva dal ticket (`useTicketAction` →
    `client.tickets.approvePlan`, `lib/work-mutations.ts:130`).
- ⚠️ **Il merge nell'app non esiste.** Nessuna schermata lo offre, e
  `api-client` non ha il metodo per `POST
  /api/tickets/:id/repositories/:repositoryId/release`
  (`apps/server/src/routes/release.ts:38`, `requireAdmin`, e un secondo
  controllo dentro `releasePullRequest`). Le risposte d'errore sono 403, 404
  `not_found`, 409 `already_closed`/`checks_failed`/`checks_unreadable` e 502.
  E `waitingForMerge` **non porta il repository** che la rotta richiede
  (query in `packages/notifications/src/project-pulse-summary.ts:508-528`).

## §2 — Server: il repository nella voce di merge (additivo)

`pulseWaitingForMergeItemSchema` guadagna `repositoryId` e `repositoryName`,
entrambi **`.optional()`**. La query li legge con un join su `repositories`.
Nessun altro campo cambia. È additivo verso l'app (CLAUDE.md), e c'è un test
di parse senza i due campi. Un'app con un server più vecchio non ha
`repositoryId`: il bottone Mergia **non compare** e la riga resta premibile
verso il ticket.

`api-client`: `tickets.release(ticketId, repositoryId)` →
`releaseResultSchema`, che è già in shared.

## §3 — L'intestazione e le tab

- La stessa intestazione di oggi: «‹ Projects», il nome del progetto grande,
  la ricerca e l'avatar di `ScreenHeader`.
- **Tre tab** sotto, in mono maiuscolo, a tutta larghezza; quella attiva ha
  la sottolineatura ambra.
  - **Adesso** ha un **badge ambra** col numero di «Tocca a te»
    (`waitingForYou` + le PR con `canMerge`), che non compare a zero.
  - **Progetto** ha un **pallino rosso** quando un server del progetto è giù.
- Si apre sempre su **Adesso**. La tab scelta resta finché la schermata è
  montata, quindi tornando da un ticket si ritrova quella di prima.
- Pull-to-refresh su ogni tab, con le stesse chiavi di oggi.

## §4 — Tab «Adesso»

Dall'alto, e ogni blocco solo se ha qualcosa:
1. **Il banner del monitor**, se un server è giù: bordo rosso, «MONITOR ·
   SERVER DOWN» e «prod-eu-1 · 1 check down». Il tap porta alla tab
   Progetto, come nel design.
2. **«Tocca a te · N»**, in ambra. Contiene le domande e i piani di
   `waitingForYou` e le PR con `canMerge`. Ogni riga ha:
   - una riga mono «#27 · urgente · domanda», con la priorità urgente in
     rosso;
   - il titolo;
   - un bottone contornato ambra: **Rispondi**, **Approva** o **Mergia**.

   Dove portano:
   - Rispondi → la card d'inbox della domanda;
   - Approva → il ticket;
   - Mergia → la conferma del §6;
   - il tap sulla riga fuori dal bottone → il ticket.
3. **«In esecuzione · N»**: pallino azzurro, «#44 titolo», i minuti a destra
   in azzurro (`sinceMinutes`).
4. **«Aspetta altri · fermi · N»**: `waitingForOthers`, poi le PR senza
   `canMerge`, poi `stalled`. A destra:
   - «→ requester» o «→ maintainer» per chi aspetta;
   - «waiting for merge» per le PR;
   - «stalled 9d · to prepare» per i fermi, coi giorni e il MOTIVO.
     ⚠️ Corretto dopo la review della #61: la prima stesura diceva che il
     motivo «resta raggiungibile dal ticket», ma nell'app nessuna schermata
     lo mostra.
5. **Tutto vuoto**: al posto dei blocchi, la frase del polso di oggi
   (`pulseLineFor`), per esempio «All quiet» o «Idle for 3 days». Non si
   perde, cambia posto.

## §5 — Tab «Lavoro»

Tre blocchi. Ognuno ha il titolo col conteggio in grigio e «all ›» a destra:
- **Ticket · N open**: le 3 righe più recenti con l'età a destra («today»,
  «5d»). Il tap apre il ticket; «all ›» apre la lista dei ticket del
  progetto.
- **Backlog · N items**: la **barra** verde delle voci pronte su tutte, con
  sotto «3 ready · 8 to prepare». Pronte = `status ready`; «da preparare» =
  le altre voci aperte, cioè né convertite né archiviate. Il tap sulla barra e
  «all ›» aprono il backlog del progetto. Da verificare: da dove si ottiene
  il totale delle voci aperte. Se l'elenco non porta un totale, si conta la
  pagina: vedi il piano.
- **Notifications · N to handle**: le 2 più recenti dell'inbox del progetto.
  Il tap apre la card; «all ›» apre l'inbox del progetto.

## §6 — Il merge dall'app

- Tap su **Mergia** → un pannello `SheetModal`:
  - titolo «Merge the PR of #38?»;
  - sotto, repository e titolo del ticket, e un link «Open PR ›» (`prUrl`);
  - due bottoni affiancati, **Merge** primario e **Cancel** ghost
    (`besidePrimary`).
- **Merge** chiama `tickets.release`. In attesa il bottone mostra lo
  spinner; al successo il pannello si chiude, e polso e ticket si
  ricaricano. Il ticket si chiude col webhook del provider, come per un
  merge fatto a mano: la fase 8 non scrive su `ticket_repositories`.
- **Errori**, mostrati nel pannello e mai ingoiati:
  - `checks_failed`: «The provider's checks are failing»;
  - `already_closed`: «This PR is no longer open»;
  - `checks_unreadable` e 502: «Couldn't reach the provider, try again»;
  - 403: non dovrebbe capitare, perché il bottone c'è solo con `canMerge`.
- Il bottone compare **solo** su una voce con `canMerge` e `repositoryId`.
  Il cancello vero resta sul server: questo è solo ciò che si mostra.

## §7 — Tab «Progetto»

- Il banner del monitor, lo stesso di Adesso, qui premibile verso il
  Monitor.
- Una sola scheda con cinque righe, ognuna col riassunto a destra in mono e
  «›»:
  - **Repository** → i nomi, «web-app · api»;
  - **Documentazione** → «2 spaces · 33 pages»;
  - **Roadmap** → «2 open»;
  - **Monitor** → «2 servers · 1 down», in rosso se c'è un server giù;
  - **Impostazioni** → «4 automations».

  Il tap porta alle schermate che l'hub apre già oggi. Le automazioni sono i
  toggle accesi del progetto, contati dal client sui campi di `projectSchema`
  (backlog, pulse, brief settimanale, report giornaliero e gli altri booleani
  di automazione); l'elenco esatto sta nel piano.
- Letture ACCESSORIE, ognuna fuori dai gate: una che fallisce mostra «—» al
  posto del riassunto, e la riga resta premibile.

## §8 — Cosa sparisce e cosa resta

Spariscono la colonna unica e le sezioni lunghe (anteprime di repository,
docs, roadmap e monitor): diventano le righe della tab Progetto. **Restano**
tutte le schermate di destinazione e le loro rotte. La riga del polso non si
perde (§4.5).

## §9 — Rilascio

Solo il **server**, per i due campi additivi: il web non cambia e il worker
non c'entra. L'app si aggiorna a parte. Rollback innocuo: senza `repositoryId` il bottone Mergia
non compare.
