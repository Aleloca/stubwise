# Appartenenza ai progetti, ruoli e permessi granulari — design

Data: 22 ott 2026. Primo di tre progetti in sequenza: (1) appartenenza e
permessi, (2) secondo fattore sul login, (3) cassaforte delle credenziali
cifrata nel browser. Questo documento copre solo il (1); gli altri due lo
presuppongono.

## Perché

Oggi Stubwise ha due ruoli d'istanza (`admin`, `member`) e nessuna
appartenenza ai progetti: chiunque abbia un account vede tutto. Finora
andava bene perché gli utenti lavorano tutti su tutti i progetti. Il
maintainer sta per aggiungere tutti i reparti (sviluppo, commerciale,
marketing, amministrazione) e deve poter decidere, progetto per progetto,
**cosa vede** e **cosa può fare** ciascuno. È anche la base della cassaforte
delle credenziali: lì l'accesso è per tipo di credenziale e lo decide il
responsabile del progetto.

## Obiettivi

- Un utente vede un progetto, e tutto ciò che gli appartiene, solo se ne è
  **membro** (o se è admin d'istanza).
- I permessi sono **granulari**, in un catalogo fisso definito dal codice, a
  due livelli: **d'istanza** e **di progetto**.
- I **ruoli** sono insiemi di permessi con un nome, in un **catalogo unico**
  per tutta l'istanza, creati e modificati dagli utenti autorizzati. Due tipi:
  - **ruolo d'istanza**: uno per utente, permessi globali;
  - **ruolo di progetto**: uno per membro per progetto, permessi in quel
    progetto.
- Stubwise parte con **ruoli già pronti** (preset), con nomi in **inglese**
  (progetto open source): si modificano, duplicano ed eliminano come quelli
  creati dagli utenti — non sono speciali.
- Chi ha il permesso d'istanza «amministrazione completa» (preset `Admin`)
  vede e fa tutto su tutti i progetti, senza essere membro.
- **Approvare un piano** e **mergiare/rilasciare** smettono di essere
  riservati al ruolo admin: diventano permessi di progetto assegnabili.
- Al rilascio **nessuno perde né guadagna nulla** (conversione sotto).

## Non obiettivi

- Più ruoli per lo stesso membro nello stesso progetto, gruppi o team di
  utenti, eredità fra ruoli.
- Permessi per singolo ticket o per singola pagina di documentazione.
- La cassaforte delle credenziali e il 2FA (progetti successivi).
- Cambiare la posta e il calendario personali: restano del proprietario della
  casella (`mailbox_owner` non cambia).
- Il widget pubblico del customer service: resta com'è.

## Anti-obiettivi (fallimento anche se «funziona»)

- **Una superficie dimenticata che fa vedere dati di un progetto a chi non
  ne è membro**: una rotta, la ricerca, la chat RAG, una notifica, un tool
  MCP, Slack, un conteggio, un elenco di utenti. È il rischio principale.
- Un rilascio che chiude fuori qualcuno (admin compreso) o che allarga i
  permessi di qualcuno.
- Restare senza nessun utente con «amministrazione completa».
- Un utente che si dà da solo più permessi di quanti ne ha (escalation
  tramite assegnazione di ruoli o modifica del ruolo che possiede).
- Il client che deduce i permessi da sé: li calcola il server (stesso
  principio di `canMerge` nel `CLAUDE.md`).

## Il modello

- `permissions`: catalogo **nel codice** (`packages/shared`), non nel DB.
  Ogni permesso ha una chiave stabile in inglese, un livello
  (`instance`/`project`) e un'etichetta i18n. Aggiungere un permesso è una
  modifica di codice; un permesso nuovo non è dato a nessun ruolo
  esistente salvo che la sua migrazione lo dica esplicitamente.
- `roles`: id, nome (testo libero, unico per tipo), tipo
  (`instance`/`project`), elenco di chiavi di permesso del suo livello.
- `users.instance_role_id` (obbligatorio) sostituisce `users.role`.
- `project_members(project_id, user_id, role_id)`, chiave
  `(project_id, user_id)`.
- Il permesso d'istanza `instance.full_admin` è speciale: implica ogni
  permesso d'istanza e di progetto su ogni progetto. Vincolo: deve sempre
  esistere almeno un utente che lo ha (oggi c'è una guardia «ultimo admin»
  in `users.ts:142`: va generalizzata a cambio ruolo utente, modifica di un
  ruolo, eliminazione di un ruolo, eliminazione di un utente).

### Catalogo iniziale dei permessi (bozza, da raffinare nel piano)

**D'istanza:** `instance.full_admin`, `projects.create`, `users.invite`,
`users.manage` (ruolo d'istanza, disattivazione, reset password),
`roles.manage`, `settings.manage` (automazione, modelli, budget, notifiche),
`ai_providers.manage`, `git_accounts.manage`, `plugins.manage`,
`integrations.manage` (Slack, Google Workspace), `monitor.manage` (server
del monitor), `usage.view` (consumi di tutta l'istanza).

**Di progetto:** `project.view` (implicito per ogni membro),
`project.settings.manage`, `project.members.manage`,
`tickets.view_all` (senza: solo i ticket che ha aperto o richiesto),
`tickets.create`, `tickets.edit`, `tickets.comment`, `runs.start`,
`plans.approve`, `release.merge`, `corrections.request`,
`backlog.view_all` (senza: solo le voci che ha richiesto), `backlog.edit`, `docs.view`, `docs.edit`,
`repos.view` (codice, grafo, sessioni, PR), `repos.manage` (repository,
file d'ambiente, webhook), `agent_sessions.intervene`, `decisions.record`,
`environments.manage`, `widget.manage`, `project.usage.view`.

### Ruoli già pronti

| Nome | Tipo | Contenuto |
| --- | --- | --- |
| Admin | istanza | `instance.full_admin` |
| User | istanza | nessun permesso globale |
| Project Lead | progetto | tutti i permessi di progetto |
| Developer | progetto | tutti tranne `plans.approve`, `release.merge`, `project.members.manage`, `project.settings.manage` |
| Contributor | progetto | `docs.view`, `tickets.create`, `tickets.comment` (vede solo i propri ticket e le proprie richieste di backlog) |
| Viewer | progetto | tutti i `*.view` e `*.view_all`, nessuna scrittura |
| Legacy Member | progetto | esattamente ciò che un `member` può fare oggi |

## Regole

- **Chi gestisce cosa.** I ruoli li gestisce chi ha `roles.manage`; i membri
  di un progetto chi ha `project.members.manage` in quel progetto. *Scelta
  mia:* si può assegnare (o rendere effettivo modificando un ruolo) solo un
  ruolo i cui permessi sono **inclusi** nei propri — niente escalation.
- **Chi crea un progetto** ne diventa membro con `Project Lead`. *Scelta mia.*
- **Il server decide, il client legge.** Ogni rotta dichiara il permesso
  che richiede e il livello (istanza o progetto, e da dove ricava il
  progetto: path, ticket, voce di backlog, repository, sessione...). Un
  unico helper risolve `can(actor, permission, projectId?)`. Le risposte che
  servono alla UI portano i permessi effettivi dell'utente (per progetto),
  calcolati dal server; web e app smettono di confrontare `role ===
  "admin"` (oggi 162 punti nel web, 26 nell'app).
- **Gli elenchi filtrano, non solo i dettagli.** Progetti, ticket, backlog,
  ricerca, chat RAG dei Docs, polso, inbox, timeline, conteggi, utenti
  assegnabili: mostrano solo i progetti visibili. Un dettaglio di un
  progetto non visibile risponde **404**, non 403 (non conferma che esiste).
  *Scelta mia.*
- **Notifiche.** Le audience di oggi si traducono in permessi nel progetto:
  `admins` → chi ha il permesso pertinente in quel progetto (es.
  `plans.approve` per un piano da approvare) più i full admin; `broadcast`
  → solo membri; `requester` → il richiedente se è ancora membro, più chi
  ha il permesso pertinente; `mailbox_owner` invariato. Un `follow` vale
  solo su progetti visibili.
- **I due divieti dell'operatore** diventano: un piano lo approva solo chi
  ha `plans.approve` nel progetto; il merge solo chi ha `release.merge`. Il
  gate «un run avviato senza `plans.approve` passa sempre dall'approvazione»
  resta identico nella forma. I test negativi esistenti (`jobs.test.ts`,
  `tickets.test.ts`, `release.test.ts`, `project-pulse-summary.test.ts`)
  vanno riscritti sui permessi, non cancellati. La sezione del `CLAUDE.md`
  va riscritta.
- **Token personali e MCP**: un PAT agisce con i permessi del suo utente,
  come oggi (nessuno scope per token in questa fase).
- **Slack**: agisce con i permessi dell'utente collegato; `/docs` e il
  modale del ticket elencano solo i progetti visibili all'utente.
- **Utenti visibili**: l'elenco completo solo con `users.manage`; agli altri
  gli utenti con cui condividono almeno un progetto (servono per assegnatari
  e menzioni). *Scelta mia.*
- **I full admin contano come membri impliciti di ogni progetto**, non solo
  per l'accesso: compaiono fra assegnatari e menzioni, ricevono le notifiche
  rivolte ai membri, e chi condivide un progetto li vede. *Scelta mia*, per
  coerenza con «vedono e fanno tutto» e perché dopo la conversione nessuno
  perda i maintainer dagli elenchi.
- **Posta e calendario verso progetti non visibili** (deciso dal
  maintainer: «tutti i progetti, azione limitata»). La classificazione
  continua a considerare tutti i progetti, e il proprietario della casella
  vede la proposta col nome del progetto. Confermarla richiede il permesso
  pertinente in quel progetto (`tickets.create` / `backlog.edit`). Senza,
  la card offre di **passarla al progetto**: la proposta diventa una card per
  chi in quel progetto ha il permesso (più i full admin), che la conferma o
  la scarta; il proprietario resta proprietario della mail e vede l'esito,
  non il ticket. Può sempre spostarla su un progetto che vede
  (`reassign_project`). Il contenuto della mail arriva così ai membri di quel
  progetto: è l'effetto voluto di «passarla». Le invarianti in
  `docs/invariants/mail-calendar.md` vanno rilette contro questa regola nel
  piano (in particolare `mailbox_owner` non include MAI gli admin: resta
  vero per la card del proprietario; la card «passata» è una card nuova con
  un'audience di progetto).
- **Revoca dell'accesso** (deciso dal maintainer: «sparisce per lui, resta
  agli altri»). Tolto un utente da un progetto, o tolto un permesso, il
  filtro è **a lettura**: card d'inbox, domande, proposte e ticket di quel
  progetto smettono di essergli visibili e azionabili, senza riscrivere
  righe. Ogni decisione in sospeso resta azionabile da chi ha il permesso
  nel progetto (full admin compresi), quindi non resta mai orfana. I ticket
  restano assegnati a lui ma la UI li segnala «assegnatario senza accesso»; i
  follow restano in tabella e non producono nulla. Una sessione dell'agente
  in corso non viene fermata; chi ha perso l'accesso non la vede più.
- **Letture d'istanza che oggi ha ogni utente** (es. i server del monitor):
  il catalogo ha anche le chiavi `*.view` d'istanza (`monitor.view`, ...) e il
  preset `User` contiene esattamente le letture d'istanza che un `member` ha
  oggi, così la conversione non toglie nulla. *Scelta mia.* Un server del
  monitor è visibile con `monitor.view` oppure tramite un progetto visibile
  a cui è collegato.

## Conversione al rilascio

- `admin` → ruolo d'istanza `Admin`.
- `member` → ruolo d'istanza `User` + membro di **tutti** i progetti
  esistenti con `Legacy Member`.
- Inviti pendenti: portano il ruolo d'istanza al posto di `role`; un
  invitato da `member` diventa `User` senza progetti (*scelta mia*: lo
  aggiunge poi un responsabile). 
- Il maintainer poi toglie le persone dai progetti dove non servono ed
  elimina `Legacy Member` quando non lo usa più nessuno.

## Rilascio a tappe

*Scelta mia.* `users.role` non si toglie nella stessa migrazione: resta come
colonna **derivata** (`admin` se il ruolo d'istanza ha `instance.full_admin`,
altrimenti `member`), aggiornata insieme al ruolo d'istanza, finché tutti i
lettori (server, worker, `packages/notifications`, web, app) non sono passati
ai permessi. Così server e worker si aggiornano in tempi diversi e un
rollback d'immagine resta possibile; la rimozione è un rilascio successivo.

## Verifica

- Test negativi per ogni permesso che protegge una scrittura (stato
  invariato, non solo 403), come quelli dei due divieti di oggi.
- **Un test che enumera tutte le rotte registrate** e fallisce se una rotta
  autenticata non dichiara il suo permesso e come ricava il progetto: è la
  difesa contro la superficie dimenticata.
- Test a due utenti sugli stessi dati per ogni elenco (membro / non membro).
- Test della conversione su una copia della produzione.

## Lasciato al builder

Nomi esatti delle chiavi e loro granularità finale, forma delle tabelle e
dell'helper, UI di gestione (pagina ruoli, tab Membri del progetto, ruolo
d'istanza nella pagina Team), ordine dei task, come esporre i permessi
effettivi al client, quale permesso serve per ogni azione esistente.
