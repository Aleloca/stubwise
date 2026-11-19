# Invarianti e trappole — Permessi, ruoli e membri di progetto (22 ott 2026)

> Design: `docs/plans/2026-10-22-permessi-progetto-design.md`. Voce di deploy
> e rollback: «Ruoli e membri di progetto» in `docs/operations/deploy-log.md`.
> I due divieti dell'operatore (`plans.approve`, `release.merge`) stanno in
> `CLAUDE.md`, sezione «Invarianti e trappole»: qui le regole che li
> reggono.

Il modello in breve: il catalogo dei permessi sta NEL CODICE
(`packages/shared/src/permissions.ts`, chiavi stabili in inglese, due livelli:
`instance` e `project`), i ruoli in DB (`roles`, ognuno di un solo livello).
Ogni utente ha UN ruolo d'istanza (`users.instance_role_id`); in un progetto
ha un ruolo se ne è membro (`project_members`). `instance.full_admin` implica
ogni permesso, d'istanza e di progetto, su ogni progetto. Un permesso nuovo
non è dato a nessun ruolo esistente salvo che la sua migrazione lo dica.

- **Ogni rotta dichiara `config.access`, anche quelle pubbliche.** Un solo
  hook globale (`accessPreHandler`, `apps/server/src/auth/access.ts`) legge
  la dichiarazione: `public`, `user`, `instance` (un permesso d'istanza) o
  `project` (un permesso nel progetto della risorsa, ricavato da un
  resolver di `project-resolvers.ts`, più un eventuale `resource` per la
  visibilità della singola risorsa). Nessuna rotta mette più `requireAuth` nel
  proprio `preHandler` (la chiama solo l'hook) e `requireAdmin` non esiste
  più. `apps/server/src/auth/route-access.test.ts` costruisce l'app, enumera
  ogni rotta registrata e fallisce per ognuna senza dichiarazione — senza
  elenco di eccezioni: `LEGACY_ROUTES`, l'elenco della transizione, è stato
  svuotato e tolto il 22 ott 2026 e non va reintrodotto. E l'hook è
  **chiuso per costruzione** (ruling R48): una rotta senza dichiarazione che
  sfuggisse al test (un plugin che registra rotte da sé) risponde 500
  `route_access_undeclared` con una riga d'errore nel log, e l'handler non
  gira. Fanno eccezione solo il metodo OPTIONS (preflight CORS; oggi
  `@fastify/cors` risponde già prima dell'hook, l'eccezione è una cintura in
  più) e il 404 di Fastify (`request.is404`: nessuna rotta, niente da
  dichiarare); `access.test.ts` lo verifica, preflight di inbound e ingest
  compresi. Le due difese si dividono il lavoro: il test del registro vede le
  rotte che `buildApp` registra con le opzioni di default (quelle che
  dipendono da un'opzione o da una configurazione assente nel test possono
  sfuggirgli), R48 prende a runtime tutto il resto. Una rotta pubblica
  che si autentica da sé (firma HMAC del webhook git e di Slack, chiave
  `sk_…` del monitor, token del widget, chiave d'ingestion, `state` OAuth
  di Google, token di reset/invito) dichiara `public` e **tiene** il suo
  controllo nel `preValidation` o nell'handler: `public` vuol dire «non
  serve una sessione», non «nessun controllo». Chi la porta a `user` per
  «stringere» la rompe (Slack, GitHub e gli agenti non hanno una sessione).
- **Un progetto che non si vede risponde 404 `not_found`, come uno che non
  esiste.** Vale per il progetto e per ogni risorsa che ci sta dentro
  (ticket, voce, repository, sessione, milestone...): un non membro non deve
  poter scoprire che un ticket c'è. Il codice è generico, `not_found`, non
  più `ticket_not_found`/`project_not_found`/`milestone_not_found` (ruling
  R15): un codice specifico dell'hook direbbe che cosa c'era. Il 403
  (`forbidden`) è SOLO per chi il progetto lo vede ma non ha il permesso. La
  visibilità della risorsa (`resource`) si valuta PRIMA del permesso della
  rotta: chi non vede un ticket altrui (senza `tickets.view_all`) riceve 404
  anche dove non avrebbe comunque il permesso. L'hook resta un `preHandler`,
  quindi gira DOPO la validazione: un 400 di formato non rivela nulla del
  progetto (la validazione non legge il DB, ruling R10).
- **Gli elenchi filtrano nella WHERE, prima di paginazione e conteggi.**
  Progetti, ticket, backlog, ricerca (e la sua cronologia), chat RAG dei
  Docs, polso, inbox, timeline, conteggi, utenti assegnabili, sessioni degli
  agenti, coda di rilascio: l'insieme dei progetti (`visibleProjectIds` o
  `projectIdsWithPermission`, `"all"` per un full admin) diventa una
  condizione SQL con `inProjects` (`access.ts`), mai un filtro in JS a valle
  di una pagina già tagliata — una pagina filtrata dopo il `limit` è corta,
  e un conteggio fatto prima dice quanti oggetti invisibili esistono. Senza
  `tickets.view_all` (o `backlog.view_all`) si vedono solo i ticket (le voci)
  che si sono aperti o richiesti, con la stessa regola su elenco, dettaglio e
  conteggi. I test di ogni elenco sono a DUE utenti sugli stessi dati
  (membro e non membro).
- **Il client legge i permessi calcolati dal server, non li deduce.**
  `GET /api/auth/me` restituisce `instancePermissions` e `projectPermissions`
  (mappa progetto → permessi effettivi), il dettaglio di progetto
  `myPermissions`, e i campi d'azione (`canMerge`, `canWrite`, `canAnswer`,
  `canIntervene`...) li calcola il server col permesso pertinente. Web e app
  non confrontano più `role === "admin"`: lo leggono da lì. La ragione è
  quella di `canMerge` (CLAUDE.md, i due divieti): una copia della regola
  nell'app sta dalla parte che si aggiorna dagli store. Il client usa i
  permessi solo per mostrare o nascondere; il server decide comunque per
  rotta (un menu sbagliato dà 403/404, mai un'azione riuscita). Nel web
  `instance.full_admin` vale ogni permesso e un permesso di progetto senza
  `projectId` vale «in almeno un progetto», solo per menu e guardie
  trasversali (ruling R43); nell'app i bottoni restano nascosti mentre `/me`
  carica o fallisce (fail-closed, ruling R46). I campi nuovi delle risposte
  nascono `.default([])` (regola dell'app in CLAUDE.md).
- **Nessuna escalation sul DARE; nessuna gerarchia fra persone** *(maintainer,
  30 ott 2026, confermato il 16 nov)*. In `apps/server/src/services/roles.ts`,
  in UN posto, `assertNoEscalation` (403 **`escalation`**, con la chiave
  mancante in `permission`): si assegna un ruolo, si rende effettivo un ruolo
  modificandone i permessi, si dà un permesso personale a un membro (o, con
  F8, a un reparto per un progetto), si invita, solo se ciò che si dà è
  incluso nei propri permessi nello stesso ambito. TOGLIERE non chiede
  niente: chi ha il permesso di gestione (`users.manage`,
  `project.members.manage`, `roles.manage`, `departments.manage`) modifica
  chiunque, anche chi ha più permessi di lui. Restano il rifiuto su sé stessi
  (ruolo d'istanza, reset, disattivazione) e «resta sempre un full admin».
  **Rischio accettato, scritto apposta**: chi ha `users.manage` può
  azzerare il secondo fattore di un full admin e generarne il link di reset,
  e quindi prenderne il posto. La difesa è la traccia, non il divieto:
  entrambe le azioni chiedono la riconferma, lasciano la voce nel registro
  delle modifiche (`person.second_factor_reset`,
  `person.password_reset_link`) e in `security_events`, e mandano un
  `security.alert` all'interessato. Chi dà `users.manage` a qualcuno sta
  dando questo potere.

  Un full admin passa sempre. Il codice è dedicato (ruling R44) perché la UI
  legge il codice, non il testo inglese. Un selettore che offre un ruolo che
  darà `escalation` è coerente con «il client non deduce», non un bug.
- **I permessi effettivi in un progetto sono UNA funzione**: ruolo ∪
  permessi personali (`project_member_permissions`) ∪ permessi del reparto
  per quel progetto (F8), più l'implicito del full admin. La calcolano
  `effectiveProjectPermissions` (`@stubwise/shared`) e
  `projectPermissionsFor` (`apps/server/src/auth/access.ts`). Ogni gate, ogni
  WHERE, `/api/auth/me` e «Chi può farlo?» passano da lì, e un test d'accordo
  lega `who-can` a `can()`. Un permesso personale vale esattamente come uno
  del ruolo; togliere un membro toglie i suoi permessi personali (cascade);
  Claude non ne riceve mai (insieme fisso). Un progetto non resta senza un
  `project.members.manage` fuori dai full admin (`last_manager`).
- **Una persona disattivata non entra da nessuna porta, e non si
  disattiva l'ultimo full admin.** Disattivare cancella nella stessa
  transazione sessioni, PAT e `device_tokens`, e revoca gli inviti
  pendenti che ha mandato; la lettura dell'identità la tratta come assente
  anche se una sessione sopravvivesse a una corsa. Il login risponde come a
  una password sbagliata. Riattivare non riporta i token di prima.
- **Un progetto archiviato è come uno che non c'è, tranne che per chi lo
  legge DI PROPOSITO.** `visibleProjectIds` e le WHERE lo escludono; lo
  leggono in sola lettura i suoi membri e i full admin solo dalle letture
  `archived=true`; nessuna scrittura (`409 archived`); il worker non reclama
  il suo lavoro. Si elimina SOLO un archiviato, SOLO un full admin, con la
  riconferma e il codice digitato; i suoi repository restano staccati.
  La regola sta in UN posto: `projectPermissionsFor` e
  `projectPermissionsByProject` danno `null`, e un full admin riceve
  `ProjectScope` (`{ all, archived }`), mai `"all"`, così ogni elenco
  decide degli archiviati (`inProjects`, `scopeIncludes`). Una lettura non
  dichiarata è 404, una scrittura 409 `archived` a chi lo vedrebbe; le
  eccezioni si dichiarano con `config.archived` (elenco chiuso in
  `route-access.test.ts`). Tre eccezioni volute: i consumi d'istanza
  (`usage.view`) contano la spesa degli archiviati senza nominarli; il
  registro delle modifiche mostra le loro voci a chi li vedrebbe; le
  approvazioni d'automazione senza progetto restano al full admin. Le
  superfici pubbliche (SDK, ingresso, widget, webhook git) trattano un
  archiviato come uno slug sconosciuto (401), e non nasce nessuna notifica
  per un archiviato. Limite accettato: archiviare non blocca i claim del
  worker, quindi un job reclamato a cavallo del commit finisce.
- **Di un progetto eliminato restano SOLO codice, nome e chi ne era membro
  (`deleted_projects`, `deleted_project_members`, 0193), e servono SOLO a
  dire «chi lo conosceva».** Gli ex membri e i full admin leggono
  l'etichetta `CODICE · Nome` di `project.deleted`, la provenienza
  (`formerProject`) e il nome intero di un repository staccato; gli altri
  leggono «un progetto che non vedi» (`hidden`), mai il codice, il nome né
  l'id. Un ex membro eliminato esce dalla memoria (cascata). Le voci del
  registro del progetto tengono il suo `project_id` (nessuna FK): non
  diventano voci senza progetto, e non le legge più nessuno tranne
  `project.deleted`. Un repository staccato non è di nessun progetto: lo
  elencano solo le rotte dei repository staccati, e nessuna lettura di
  progetto lo trova, nemmeno col `"all"` del full admin (le query uniscono
  `projects`).
- **Un invito non dà mai più di quanto ha chi invita, nemmeno per omissione
  né col passare del tempo** (ruling R51, `assertInviteGrants` e
  `applyInviteGrants` in `services/roles.ts`). Senza `instanceRoleId` il
  preset `User` si risolve nella transazione dell'invito, passa
  dall'anti-escalation come un ruolo scelto e il suo id si salva
  sull'invito: «nessun ruolo» non è una scorciatoia. L'invito ricorda chi
  l'ha creato (`invites.invited_by_user_id`, 0099) e all'accettazione ogni
  progetto promesso si RIVERIFICA coi permessi attuali dell'invitante
  (`project.members.manage` e i permessi del ruolo, lì): uno non più valido
  si scarta con una riga di log, l'utente nasce lo stesso. Invitante
  eliminato = nessun progetto.
- **Resta sempre un full admin.** `assertFullAdminRemains` (stesso file) gira
  in OGNI transazione che può togliere l'ultimo: cambio di ruolo d'istanza,
  modifica dei permessi di un ruolo, eliminazione di un ruolo, eliminazione di
  un utente (la funzione del servizio esiste e la guardia è testata lì, ma
  NON esiste una rotta `DELETE /api/users/:id`, ruling R27). Prima del
  conteggio prende un **lock advisory di transazione** (chiave fissa
  `FULL_ADMIN_LOCK_KEY`): due declassamenti concorrenti di due full admin
  diversi, ciascuno da solo legittimo, non lasciano l'istanza senza. Risposta
  409 `last_full_admin`. Il conteggio si fa DOPO la modifica, nella stessa
  transazione, così copre anche il caso indiretto (togliere
  `instance.full_admin` dal ruolo che ce l'ha).
- **I preset `Admin` e `User` non si eliminano finché esiste `users.role`.**
  Si rinominano e si modificano, ma `DELETE` risponde 409
  `role_required_by_system` (ruling R9): servono al trigger legacy (sotto) e
  agli inviti senza ruolo (`invites.instance_role_id` null = `User`). Il
  trigger, se li trova mancanti lo stesso, alza un errore che dice perché
  invece di un `NOT NULL` muto. Gli altri preset (`Project Lead`,
  `Developer`, `Contributor`, `Viewer`, `Legacy Member`) si eliminano come
  ogni ruolo, se nessuno lo usa (409 `role_in_use` col conteggio). I nomi dei
  preset sono in inglese e non si traducono.
- **`users.role` è DERIVATA, e la sua rimozione è un rilascio successivo.**
  La 0097 la tiene come colonna derivata dal ruolo d'istanza (trigger
  `users_role_derived`: `admin` se il ruolo ha `instance.full_admin`,
  altrimenti `member`), con una sincronizzazione **bidirezionale** (ruling
  R8): uno scrittore che conosce solo `role` (un'immagine vecchia dopo un
  rollback) ottiene il ruolo d'istanza del preset `Admin`/`User`
  corrispondente, e un INSERT senza ruolo d'istanza riceve quello del suo
  `role`. Cambiare i permessi di un ruolo d'istanza ricalcola `users.role`
  dei suoi utenti (`roles_sync_users`), e il tipo di un ruolo non cambia mai.
  Scrittori nuovi scrivono `instance_role_id`, MAI `role`; lettori nuovi
  leggono i permessi, MAI `role`. Il giorno in cui nessuno legge più `role`
  (server, worker, `packages/notifications`, web, app) la colonna, i due
  trigger e l'eccezione R9 si tolgono insieme, in un rilascio a sé.
- **La revoca si applica a LETTURA, senza riscrivere righe.** Tolto un utente
  da un progetto (o tolto un permesso al suo ruolo), card d'inbox, domande,
  proposte, ticket e sessioni di quel progetto smettono di essergli visibili
  e azionabili, senza toccare `notifications` né altro:
  `notificationVisibleToRecipient` (`packages/notifications/src/inbox-visibility.ts`)
  è la condizione SQL condivisa da inbox, conteggio, badge push e consegne
  del worker (stesso numero su campanella e telefono, ruling R25), e le
  azioni di una card invisibile rispondono come per una card che non esiste.
  Il progetto di una card è `coalesce(project_id, progetto del suo ticket)`:
  le card pubblicate prima della colonna hanno `project_id` nullo ma un
  ticket, e trattarle da eventi d'istanza le farebbe sfuggire alla revoca.
  Lo stream dal vivo di una sessione dell'agente rilegge a ogni giro utente
  e ruolo d'istanza (non la fotografia dell'apertura): una revoca lo chiude
  entro un giro di poll. Ogni
  decisione in sospeso resta azionabile da chi ha il permesso nel progetto
  (full admin compresi): non resta orfana. I ticket restano assegnati a lui,
  marcati «assegnatario senza accesso»; i follow restano in tabella e non
  producono nulla; una sessione dell'agente in corso non si ferma. Il worker
  non ricontrolla il permesso all'avvio di un turno già accettato (ruling
  R41): conta il controllo del server all'invio. La cronologia di ricerca
  nasconde allo stesso modo le voci di entità cancellate o non più visibili.
- **I full admin sono membri IMPLICITI di ogni progetto.** Non compaiono in
  `project_members` (la sezione Membri lo dice), ma ovunque si chieda «chi
  vede questo progetto» ci sono: assegnatari e menzioni, notifiche rivolte ai
  membri, utenti visibili a chi condivide un progetto (`projectViewerIds`,
  `userIsFullAdmin` in `packages/notifications/src/project-access.ts`, la
  stessa regola per server e worker). Chi scrive una query «membri del
  progetto» con la sola `project_members` dimentica i maintainer.
- **Le card d'inbox derivano a lettura ciò che dipende dai permessi.** È
  l'invariante del CLAUDE.md sui campi derivati delle card, applicata ai
  permessi: l'azione `hand_to_project` («Passa al progetto») di una proposta
  di posta non si scrive nell'evento, la offrono `listInbox`/`executeAction`
  coi permessi ATTUALI del proprietario (ruling R36), e lo stesso vale per i
  bottoni bloccati di una card. Le card pubblicate PRIMA della fase, senza
  `project_id`, restano azionabili: il progetto si ricava dal ticket della
  card (ruling R34). Le audience di prima diventano permessi nel progetto:
  `admins` → chi ha il permesso pertinente più i full admin (un piano da
  approvare, `job.held`, `job.budget_held` → `plans.approve`, ruling R32),
  `broadcast` → i membri, `requester` → il richiedente se vede ancora il
  progetto più chi ha il permesso; `mailbox_owner` invariata, e la proposta
  passata è una card nuova (`docs/invariants/mail-calendar.md`). Un permesso
  d'ISTANZA su una card CON progetto passa comunque dal filtro dei membri:
  `docs.limit_paused` e `docs.nightly_attention` (pubblicate col progetto
  del repository) vanno ai full admin e a chi ha `settings.manage` E vede
  quel progetto — chi non lo vede non ne aprirebbe i Docs (test in
  `packages/notifications/src/publish.test.ts`).
- **Le rotte NARRATIVE rispettano i permessi di lettura** (ruling R49).
  Timeline, review, report, brief e registro decisioni raccontano ticket, PR
  e codice: non devono dire a chi le legge ciò che non vedrebbe dalle rotte
  di quelle cose. Timeline (`buildProjectTimeline` con il `viewer`): voci di
  ticket solo con `tickets.view_all` o ticket propri, PR e report solo con
  `repos.view` (le PR seguono anche la regola dei ticket), brief solo con
  `tickets.view_all`; il brief settimanale del worker la chiama senza
  `viewer`, e vede tutto. `/reviews` e `/api/activity` vogliono `repos.view`
  (l'attività filtra i progetti per quel permesso); i brief
  (`/:projectId/briefs`, `/api/briefs/:id`) `tickets.view_all`, perché sono
  narrativa del progetto intero e non si filtrano frase per frase; il
  registro decisioni toglie `ticketId`/`ticketNumber` di un ticket altrui a
  chi non ha `tickets.view_all` (la decisione resta: è un fatto del
  progetto). Chi aggiunge una superficie narrativa si chieda quali di questi
  permessi le servono. Lo stato di un job del backlog
  (`GET /api/backlog/jobs/:jobId`) segue `backlog.view_all` allo stesso
  modo: senza, solo le proprie richieste.
- **Le sessioni degli agenti chiedono `repos.view`.** Elenco, dettaglio,
  eventi e stream di una sessione di progetto vogliono `repos.view` nel suo
  progetto (ruling R26: sono lavoro sul codice), più `tickets.view_all` per
  le sessioni di ticket altrui e `backlog.view_all` per quelle di voci altrui;
  senza, 404. Le sessioni di posta (senza progetto) restano del solo
  proprietario della casella. Scrivere: `docs/invariants/agent-sessions.md`.
  **Eccezione, 23 ott 2026: il refinement del backlog lo legge anche chi ci
  scrive (`backlog.edit`), senza `repos.view`** — un ruolo che lavora il
  backlog ma non vede il codice (il `Contributor` configurato così in
  produzione) avviava la sessione e la web lo portava su un 404. Il
  refinement è in sola lettura sul codice per costruzione, ma l'agente può
  citarne dei passaggi nella conversazione: è il prezzo accettato. La regola
  sta in UN posto, `canReadSessionKind` (`services/agent-sessions.ts`), con
  la sua copia SQL nell'elenco; le sessioni dei fix restano dietro
  `repos.view`.
- **`Legacy Member` è ESATTAMENTE il `member` di prima, e nient'altro.** La
  conversione (0097) mette ogni `member` in TUTTI i progetti esistenti con
  questo preset e gli dà il ruolo d'istanza `User` (che contiene le letture
  d'istanza aperte a ogni utente: `monitor.view`, `users.view_all`,
  `git_accounts.view`, `mail_admission.view`, ruling R1); gli `admin`
  diventano `Admin`. Il preset ha ogni permesso di progetto TRANNE quelli che
  prima stavano dietro `requireAdmin` o che non esistevano: `plans.approve`,
  `release.merge`, `project.settings.manage`, `project.members.manage`,
  `repos.manage`, `environments.manage`, `widget.manage`, `docs.generate`,
  `prs.adopt`, `tickets.moderate`, `agent_sessions.intervene`,
  `project.usage.view` (l'audit rotta per rotta è nel commento di
  `LEGACY_MEMBER_EXCLUDED`). Chi aggiunge una chiave di progetto nuova
  decida se il member di prima la aveva: se sì entra anche qui (e nella
  migrazione), se no in quell'elenco — «nessuno perde nulla, nessuno
  guadagna nulla». Un progetto creato DOPO la conversione non aggiunge
  nessuno da sé: il creatore ne diventa `Project Lead` (un full admin riceve
  anche la riga, ruling R29), gli altri li aggiunge chi ha
  `project.members.manage`. Il maintainer elimina `Legacy Member` quando non
  lo usa più nessuno.
- **Chi fa cosa, quando la mappa non è ovvia.** Le scelte dei task, da non
  rideducre dal nome della chiave: override del budget di correzione e del
  refinement → `plans.approve` (R16, R41); correggere o riprendere su una PR
  adottata → `prs.adopt`; caricare un allegato → `tickets.comment`;
  milestone → `tickets.edit`; modificare la decisione altrui, eliminare il
  progetto → `project.settings.manage` (R18); impostare l'account git di un
  repository → `repos.manage` E `git_accounts.manage` d'istanza (R19, R23);
  elenco e dettaglio dei repository con `docs.view` OPPURE `repos.view`, ma
  senza `repos.view` la risposta omette la configurazione (`config: false`,
  R20, R22) e la chat dei Docs non usa il grafo (R21); identità git e
  Bitbucket → `users.manage`, Slack → `integrations.manage` (R12);
  «richiesta da un collaboratore» (`request.created`) = richiedente senza
  `project.members.manage` nel progetto, su server e worker (R14); elenco
  utenti completo → `users.view_all` (R24). Un PAT agisce coi permessi del
  suo utente; Slack con quelli dell'utente collegato (un utente Slack non
  collegato non apre ticket, R42).

- **L'utente di sistema «Claude» (10 nov 2026, integrazione area 3, fetta 3e,
  migrazione 0125).** Uno per istanza (`users.is_agent`, indice unico
  parziale). **Non entra mai**: login (`verifyCredentials`), sessione
  (`findSessionUser`), PAT (`findPatUser`) e reset della password lo
  rifiutano nella query, per costruzione — la password è un segnaposto che non
  è un hash. **Non riceve mai una notifica**: `publishNotification` lo toglie
  dai destinatari di QUALUNQUE audience, un punto solo (anche se finisse fra
  membri o follower). **Non è una persona da gestire**: fuori dal Team
  (`/api/users`), 404 sulle rotte `/api/users/:id` e sull'aggiunta come membro
  di un progetto, mai l'autore di un ticket ingerito. Il suo ruolo d'istanza è
  il preset `User`, **mai il full admin**: lo conterebbe fra gli
  amministratori («resta sempre un full admin») e fra i destinatari degli admin.
  E se un admin ALLARGA il preset `User` fino al full admin, Claude comunque non
  conta: `assertFullAdminRemains` esclude `is_agent` (review dell'area 3, punto
  9 — scelto al posto di un ruolo d'istanza dedicato, che vorrebbe una
  migrazione e un preset in più da proteggere); gli altri effetti di un preset
  allargato sono calcoli su chi GUARDA, e Claude non guarda mai, e i destinatari
  li esclude già `publishNotification`.
  Vede le task che gli si assegnano per una regola esplicita
  (`canUserSeeTicket`), non per un permesso. **Assegnarlo AVVIA il lavoro**
  da OGNI porta — le rotte nuove (PATCH, in blocco, Planning, creazione:
  `services/task-writes.ts`) e quelle vecchie del web vecchio, dell'app e
  dell'MCP (`POST /api/tickets`, `PATCH /api/tickets/:id`) —, con la regola
  in UN posto (`services/claude-assign.ts`: `claudeAssignGuard`,
  `startClaudeRuns`); quindi chiede `runs.start` nel progetto (403
  `claude_assign_forbidden`, niente scritto) — nel Planning al posto di
  `planning.others`, che riguarda le persone, ma insieme a `tickets.edit` e
  su una task aperta (altrimenti 403 `forbidden`, come la PATCH) —, e il run parte con `startRun` a nome di chi assegna: stesse
  precondizioni e stesso gate del piano di run-ai. Toglierlo non annulla niente
  (resta «Annulla il lavoro»). `/api/people` lo mostra a tutti (`isClaude`), così
  il nome di una task assegnata a lui si legge sempre; dove chi guarda può
  assegnarlo lo dice il server (`claudeAssignableProjectIds`). Sul web vecchio
  e nell'app, che leggono i nomi da `/api/users` (dove Claude NON entra: il
  Team, i conteggi degli admin e i selettori ne resterebbero sporcati), il
  ticket porta `assigneeIsAgent` (additivo, facoltativo) e il client scrive
  «Claude»; e non è mai «assegnatario senza accesso» (`assigneeWithoutAccess`
  lo esclude: non è membro per costruzione, non per revoca). L'impostazione
  iniziale dell'istanza non lo conta fra gli utenti.

- **Un permesso nuovo dato a un preset si dà anche ai ruoli che lo
  contenevano (decisione del maintainer, 10 nov 2026).** La guardia
  anti-escalation confronta i permessi (dal 16 nov 2026, area 9, solo sul
  DARE: la guardia sul bersaglio, `target_above` R28, non c'è più; la regola
  resta perché tiene i ruoli fatti a mano coerenti coi preset). Se una
  migrazione dà un permesso nuovo al solo preset, un ruolo fatto a mano che
  stava SOPRA quel preset (per esempio il preset User più `users.manage`) si
  ritrova sotto, e non gestisce più chi ha il preset.
  **La regola**: la migrazione che dà un permesso nuovo a un preset lo dà,
  nello stesso `UPDATE`, anche a ogni ruolo dello stesso scope che conteneva
  già TUTTI i permessi di quel preset (`permissions @> ARRAY[…]::text[]`,
  con l'elenco del preset DI PRIMA), con `distinct unnest` per restare
  idempotente. Un ruolo che non lo conteneva non riceve niente.
  Applicazioni:
  - 0133, `claude.public.view` (User);
  - 0135, i permessi `chat.*` (Project Lead, Developer, User).

  Ciascuna ha il suo test in `packages/db/src/roles-migration.test.ts`.
  Nei test, un ruolo creato OGGI che deve stare sopra un preset si
  costruisce dal preset di adesso (`PRESET_ROLES`), non da un elenco scritto
  a mano.

