# Web vecchio contro nuova app: cosa manca prima del ritiro

27 nov 2026, in sola lettura, su `origin/main` @ `086acfcd2`.

## Come l'ho fatto

- **Funzioni del web.** Sono partito da `apps/web/src/router.tsx`: 64 pagine in `routes/` e 68 percorsi.
  - Le funzioni le ho prese dall'inventario `apps/desktop/docs/web-inventory.md` (24 ott). L'ho completato con le pagine nate dopo: `/credentials`, `/vault-pair`, `/settings/vault`, `/settings/vault/recovery`.
- **Rotte che il web chiama.** Le ho estratte da tutto `apps/web/src`, test esclusi, e le ho incrociate con le 171 rotte che l'app non chiama (`docs/plans/2026-11-26-mcp-parita-inventario.md`). Ne restano **109**, chiamate dal web e mai dall'app.
  - Per ognuna ho controllato se la funzione del web che la chiama è davvero usata da una pagina. Sei funzioni sono morte: `setTicketDesign/Plan`, `setBacklogDesign/Plan`, `getProjectBriefs`, `getProjectReviews`. Lo è anche la cronologia delle chat dei Docs (`getDocChatSessions`/`…Messages`). Queste le ho scartate.
- **Prove dalla parte dell'app.** Per ogni funzione rimasta ho cercato:
  - le rotte di `data/backend/real` e dell'api-client (dall'inventario MCP, più grep);
  - `INTEGRATED` in `data/integration.ts`;
  - le sezioni spente (`PROJECT_SETTINGS_SECTIONS` contro `INTEGRATED.projectSettings`);
  - gli `openInWeb(...)`, i testi «in the browser» e le note di parità (`apps/desktop/docs/area*-parity.md`, `integration-*.md`).
- **Gruppi.**
  - (a) c'è ed è integrata;
  - (b) c'è nel prototipo ma è spenta o finta nella build app;
  - (c) l'app rimanda al web vecchio;
  - (d) non c'è;
  - (e) tolta per decisione scritta.

---

## 1. Funzioni dei gruppi (b), (c), (d), per area

Stima: S fino a 1–2 giorni, M una fetta, L un design a sé.

### 1.1 Trasversale: link e ingresso

| Gr. | Funzione | Dove sta oggi | Rotta / punto | Stima |
|---|---|---|---|---|
| c | **Card dell'inbox che aprono il web.** Solo 5 kind aprono la task nell'app (`INTEGRATED_KINDS`: `decision.requested/answered`, `ticket.activity`, `planning.changed`, `task.assigned`). Gli altri, se non hanno una forma propria (chat, posta, automazioni, monitor, product doc, `member.added`, catalogo con `url` `/app/#/p/…`), diventano «Open in web» → `webHrefFor` → `/tickets/:id`, `/agents/job/:jobId?ticketId=` o `/inbox` del web vecchio. Sono `job.*` (piano, domanda, fallito, held, budget, PR aperta/chiusa), `review.completed`, `ticket.created`, `request.created`, `project.pulse`, `project.brief`, `docs.limit_paused`, `docs.nightly_attention`, `security.alert`, `google.proposal` | `real/notifications.ts` r.19 e r.64 | `GET /api/inbox` (campo `url`) | M |
| c | **Link scritti dal server, dal worker e dall'MCP verso i percorsi del web vecchio.** Finiscono in card, email, push, webhook in uscita, risposte dell'SDK e dei tool MCP | `apps/worker/src/pipeline/notify.ts:40`, `briefs/poller.ts:499`, `pulse/poller.ts:252`, `backlog/intake.ts:359`, `monitor/alerts.ts:152`, `docs/recursive/node-dispatch.ts:446`; `apps/server/src/ingest/shared.ts:39`, `ingest/processor.ts:401`, `routes/webhooks.ts:140`, `routes/backlog.ts:815`, `services/google-proposal.ts:1482`; `packages/notifications/src/actions.ts:494,502`, `nightly-attention.ts:20`; `packages/mcp/src/tools/write.ts:86,109,169,362` | `/tickets/:id`, `/backlog/:id`, `/backlog?projectId=`, `/projects/:id(/roadmap)`, `/docs/:repositoryId`, `/monitor/servers/:id`, `/settings/security` | M |
| c | **Ritorno del consenso Google dal browser.** Da `/app` web il callback rimanda a `/settings/account?google=<esito>`, una pagina del web vecchio. Il desktop invece torna su `/app/#/desktop-google` | `apps/server/src/routes/me-google.ts:170`, `GOOGLE_ACCOUNT_SETTINGS_PATH` in `packages/shared/src/schemas/google.ts:306` | `GET /api/me/google/callback` | S |
| c | **`/app` alla radice.** Oggi caddy serve il web vecchio su `/` e la nuova app su `/app/`. Resta aperto «Ritiro del web vecchio e passaggio di `/app` alla radice». Al ritiro vanno anche reindirizzati i vecchi percorsi a cui puntano link già inviati | `Caddyfile` r.85–101; registro r.2111 | — | M |

### 1.2 Cassaforte (area 10)

| Gr. | Funzione del web | Rotta web | Rotte API | Stima |
|---|---|---|---|---|
| c | Creare la propria chiave della cassaforte con una passkey (PRF) e sigillarla | `/settings/vault`, `/credentials` | `POST /api/vault/keys`, `POST /api/vault/keys/:id/seals`, `GET /api/vault/keys/mine` | L (insieme) |
| c | Kit di recupero: anteprima e generazione della chiave di recupero | `/settings/vault/recovery` | `GET /api/vault/recovery-key/preview`, `POST /api/vault/recovery-key` | (sopra) |
| c | Recupero con prova di possesso del kit, e conferma del recupero di un altro da parte di chi può | `/settings/vault/recovery`, `/credentials` | `POST /api/vault/recovery/challenge`, `POST /api/vault/recovery/pending`, `POST /api/vault/recovery/confirm/:personKeyId` | (sopra) |
| c | Attivare la cassaforte dell'istanza (primo admin, regola V1). Nell'app c'è solo «Activate it in the browser» | `/settings/vault` | `POST /api/vault/activate` | (sopra) |
| c | Aprire, leggere, condividere e confermare le credenziali **dal browser**. Nella build `/app` web il bottone «Open the vault page» apre `/credentials` del web vecchio. Il percorso col Mac copre solo il desktop | `/credentials` | `POST /api/credentials/:id/reveal` e le altre via passkey; `GET /api/credentials/:id/recipients`, `GET /api/projects/:projectId/credentials/recipients` | (sopra) |
| c | Associare il Mac alla cassaforte. Il desktop apre il browser, ma la pagina che conferma con la passkey è del web vecchio | `/vault-pair` | `POST /api/vault/device-pairings/lookup`, `POST /api/vault/device-seals` | (sopra) |
| d | **«Manage {name}'s Macs in the browser».** Per un full admin il desktop apre `/admin/people/:id`, ma il web vecchio non ha quella rotta: si finisce sul fallback della SPA. Nemmeno il web chiama le rotte dei Mac degli altri: il link porta nel vuoto | — | `GET /api/vault/users/:userId/device-seals`, `DELETE /api/vault/users/:userId/device-seals/:id` (non le chiama nessun client) | S |

`vault.finishPairing`, `vault.listMacsOf` e `vault.removeMacOf` sono «in arrivo» nell'inventario MCP.

### 1.3 Repository e impostazioni di progetto

Sono le sezioni di `PROJECT_SETTINGS_SECTIONS` assenti da `INTEGRATED.projectSettings`. «Repositories» è accesa ridotta al solo blocco Releases, per decisione di 46.

| Gr. | Funzione | Rotta web | Rotte API | Stima |
|---|---|---|---|---|
| b | **Aggiungere un repository.** Il wizard in 4 passi: account git, scelta del repo dall'account, ramo, verifica degli accessi, comandi di test e install. Senza, non si collega nessun repository nuovo | `/repositories/new`, `/projects/:id/repositories/new` | `POST /api/repositories`, `GET /api/git-accounts/:id/repositories`, `GET /api/git-accounts/:id/branches`, `GET /api/git-accounts/:id/validate-repo` | M |
| b | **Modificare un repository**: URL, account git, account di revisione, comandi, rami protetti. Oggi l'app fa la PATCH solo per il grafo e i rilasci | `/repositories/:slug` | `GET /api/repositories/:slug`, `PATCH /api/repositories/:slug` | S–M |
| b | **Webhook git**: stato e «Configure automatically» | `/repositories/:slug` | `GET /api/repositories/:slug/webhook`, `POST /api/repositories/:slug/configure-webhook` | S |
| b | **File d'ambiente**: elenco, nuovo file, import incollato, sostituisci e rimuovi variabile, elimina file | `/repositories/:slug` | `GET/POST /api/repositories/:id/env-files`, `POST …/:fileId/import`, `PUT/DELETE …/vars/:key`, `DELETE …/:fileId` | M |
| b | Elenco dei repository di un progetto (`listProjectRepositories` è in arrivo). L'elenco d'istanza di Amministrazione invece c'è | `/repositories` | `GET /api/repositories` | S |
| b | **Settings → General**: nome e descrizione del progetto (`updateProjectGeneral`) | `/projects/:id` (project form) | `PATCH /api/projects/:id` | S |
| b | **Settings → AI**: account AI preferito e «Use only this account» (`setProjectAi`, `reviewAccountChoices`) | `/projects/:id` | `PATCH /api/projects/:id` | S |
| b | **Settings → Usage**: consumi del progetto per chi ha `project.usage.view` senza `usage.view`. Il web lo apre in `/settings/usage` | `/settings/usage` | `GET /api/ai-usage/*` con `projectId` | S |

### 1.4 Inbox e pulse

| Gr. | Funzione | Rotta web | Rotte API | Stima |
|---|---|---|---|---|
| c/d | **Proposta del pulse** (`project.pulse`): scegli una voce e «Start», che crea il ticket e lancia il run con approvazione del piano. Nell'app non c'è né in «Da decidere» né nel pannello: la card porta a `/backlog?projectId=` del web vecchio, dove non si decide nemmeno. L'MCP la sta prendendo (`decide_pulse_proposal`, design della parità MCP r.163) | `/inbox` | `POST /api/inbox/:id/actions/:action` | S–M |
| c | Le altre azioni in linea delle card (`relaunch`, `answer`, `approve_plan`, `hand_to_project`) passano solo dall'apertura nel web. Le stesse cose l'app le fa altrove: «Da decidere», sezione Claude, Posta. Il buco vero è la sola via della card | `/inbox` | `POST /api/inbox/:id/actions/:action` | (in 1.1) |

### 1.5 Docs e grafo

| Gr. | Funzione | Rotta web | Rotte API | Stima |
|---|---|---|---|---|
| b | **Scarica una categoria come .zip.** Nella build app il bottone c'è ancora, ma produce lo «zip finto» del prototipo, cioè un indice di testo (`DocTree.tsx` r.181–192). È un difetto visibile, non solo un'assenza (`integration-area5-f1.md` r.72: «Export zip assente») | `/docs/:repositoryId` | `GET /api/repositories/:repositoryId/docs/export` | S |
| b | **Scarica `graph.json`.** L'app scarica un JSON composto dallo stato, non il file vero del server (`integration-area5-f1.md` r.68) | `/docs/:repositoryId/graph` | `GET /api/repositories/:id/graph/json` | S |
| d | Grafo interattivo (HTML di graphify, espandi e chiudi) | `/docs/:repositoryId/graph` | `GET /api/repositories/:id/graph/html` | S |
| d | Arricchimento semantico dei Docs nella ricerca globale («Refining…») | ⌘K | `GET /api/search/docs-semantic` | S |
| d | «What's new» e highlights a livello di progetto nella landing dei Docs. Quelli del repository ci sono | `/docs/project/:id` | `GET /api/projects/:projectId/docs/highlights` | S |

### 1.6 Task, richieste, brief, ricerca

| Gr. | Funzione | Rotta web | Rotte API | Stima |
|---|---|---|---|---|
| d | «Remove design» e «Remove plan» sul ticket | `/tickets/:id` | `DELETE /api/tickets/:id/design`, `DELETE /api/tickets/:id/plan` | S |
| d | «Remove design» e «Remove plan» sulla voce di backlog | `/backlog/:id` | `DELETE /api/backlog/:id/design`, `DELETE /api/backlog/:id/plan` | S |
| d | Leggere un brief che non è l'ultimo. Il web ha `/briefs/:id`; l'app apre il lettore solo sull'ultimo e per gli altri dice «non è più l'ultimo» (`BriefCard.tsx` r.221–229), anche se la cronologia li elenca. Non ho trovato una decisione scritta | `/briefs/:id` | `GET /api/briefs/:briefId` | S |
| d | Ricerche recenti salvate sul server (Clear all, togli una) | ⌘K | `GET/POST/DELETE /api/search/history`, `DELETE /api/search/history/:type/:entityId` | S |

### 1.7 Già coperto, per trasparenza

Queste rotte il web le chiama e l'app no, ma la funzione nell'app c'è con un'altra rotta (a):

- **Ticket.** `/api/tickets*` (elenco, crea, PATCH, activity, comments, jobs, questions) → `/api/tasks*`, `/work`, storia del lavoro.
- **Backlog.** `/api/backlog*` → `/api/requests*`, compresi i suggerimenti e la fusione.
- **Progetti.** `/api/projects/pulse` → `/pulses`; `timeline` → `projects.chronology`; conversazioni del widget → `/api/support/*`.
- **Persone.** `/api/users`, `/roles`, `PATCH /users/:id/role` e gli inviti → `/api/admin/*` e `/api/people`.
- **Varie.**
  - Viste salvate → filtri salvati (`/api/me/pinned-filters`).
  - Calendario: `/api/me/calendar` → `/range`; «Remove configuration» di una serie → PUT spenta.
  - Posta: dettaglio per sorgente e sommario → thread e proposte.
  - Consumi d'istanza: `ai-usage/breakdown|costs` → `summary|snapshots`.
  - Login, secondo fattore, invito, reset e primo avvio nella web «app» (`real/entry.ts`, `webLogin.ts`).
  - Le passkey nella web «app».
  - PAT e Claude Code.
  - Monitor e server.
  - Activity per persona.
  - Coda di rilascio.

---

## 2. Gruppo (e): tolte per decisione

| Funzione del web | Dove sta la decisione |
|---|---|
| Slack d'istanza (`/settings/slack`), identità Slack sulle persone, DM Slack, «Invita da Slack», ticket da comando Slack (`/api/slack/*`, `PUT/DELETE /api/users/:id/slack`, `GET /api/slack/workspace-users`) | `apps/desktop/docs/area9-parity.md` r.264–271 («Voci fuori, decisione del maintainer, 29 ott 2026»); registro r.2037 «Togliere Slack dal server *(M, 16 nov 2026)*», da fare INSIEME al ritiro del web; `area4-parity.md` r.17–20 |
| Posta ammessa (`/settings/google`, `GET/PATCH /api/settings/mail-admission`) | `area9-parity.md` r.272; `area6-parity.md` r.84 |
| Regole della posta del progetto (`/api/projects/:id/email-routes`, `email-labels`) | `area9-parity.md` r.273; `area6-parity.md` r.83 |
| «Rigenera il brief» (`POST /api/projects/:id/briefs/generate`) | `area9-parity.md` r.274; `area3-parity.md` r.150 («deciso: no») |
| Adozione delle PR altrui, «Let Stubwise fix it» e «Stop correcting» (`POST/DELETE /api/tickets/:id/repositories/:repositoryId/adoption`) | `area8-parity.md` r.122 («Sostituita…, decisione 14») |
| DM Slack nelle preferenze di notifica (`slackDm` di `/api/me/notification-prefs`) | `area8-parity.md` r.123 (decisione 4) |
| Webhook unico delle notifiche (`/settings/notifications`, `GET/PUT /api/settings/notifications`, `POST …/test`), sostituito dai webhook in uscita di Amministrazione | registro r.2016 (0188 migra il webhook di oggi; niente più proposte della posta); area 9 F3 |
| Hub trasversale `/docs` | `area5-parity.md` r.16 (la voce Docs sta nella colonna del progetto) |
| «Riprova la pipeline» e «Deploy» | `area8-parity.md` r.125 (anti-obiettivo: il merge è il confine) |

Da togliere col ritiro, già scritto nel registro:

- l'enum `tickets.status`, `saved_views` e `/api/projects/pulse` (r.2111–2113);
- il token degli inviti in chiaro in `GET /api/auth/invites` (r.2000–2006);
- Slack dal server (r.2037).

---

## 3. Cosa blocca il ritiro, e in che ordine chiuderlo

**Bloccanti**: senza queste cose, togliere il web rompe un flusso o lascia un dato non gestibile.

1. **Link e card (1.1), M + M.**
   - Portare su `/app/#/…` ogni URL scritto da server, worker, notifications e MCP.
   - Allargare `presentInboxItem` ai kind che oggi cadono su «Open in web».
   - Il callback Google (S).
   - Caddy: `/app` alla radice e redirect dei percorsi vecchi.

   Va per primo perché è trasversale: ogni avviso già inviato punta al web vecchio, e senza redirect diventa un 404.
2. **Cassaforte nel browser (1.2), L.** Senza il web nessuno può:
   - creare la propria chiave, fare il kit di recupero o recuperare;
   - attivare l'istanza;
   - associare un Mac (`/vault-pair`);
   - aprire le credenziali da `/app` web.

   Serve un design a sé (passkey PRF dentro `/app`). Non va su una corsia separata dalla 1: la pagina che associa il Mac deve vivere su `/app` prima che `/vault-pair` sparisca.
3. **Repository (1.3, primi quattro), M.** Wizard, modifica, webhook git e file d'ambiente. Senza, nessun progetto nuovo può avere un repository, e quindi niente fix né Docs.
4. **Impostazioni di progetto General, AI e Usage (1.3, ultimi tre), S ciascuna.** Spegnerle lascerebbe nome, descrizione e account AI immodificabili, e chi ha solo `project.usage.view` senza consumi.
5. **Proposte del pulse (1.4), S–M.** Oggi si decidono solo nell'inbox del web (e domani dall'MCP). Va messa in «Da decidere» o nel pannello. In alternativa si decide di toglierla: allora va scritta in (e).

**Non bloccanti, ma da chiudere o decidere prima del taglio**:

6. **Difetti visibili della build app**:
   - lo zip finto dei Docs e il `graph.json` composto (1.5), S;
   - il link rotto «Manage {name}'s Macs» (1.2), S.
7. **Buchi minori (d)**:
   - Remove design e Remove plan su task e richieste;
   - brief passati;
   - ricerche recenti;
   - Docs semantici in ⌘K;
   - grafo interattivo;
   - highlights di progetto.

   Per ognuno: o una fetta S, o una riga di decisione nel registro.
8. **Pulizia del server col ritiro**: le voci del gruppo (e) qui sopra. Slack, `saved_views`, `tickets.status`, `/api/projects/pulse` e il token degli inviti vanno nello stesso rilascio, con le migrazioni in un rilascio dopo.

**Ordine proposto**:

- **Corsia 1 (bloccanti 1, 3, 4 e 5):** prima il punto 1 (sblocca tutto ed è senza design nuovo), poi 4, 3 e 5 (piccole e indipendenti).
- **Corsia 2, in parallelo:** il design della cassaforte su `/app` (punto 2), che è il pezzo più lungo.
- **Alla fine:** i punti 6–7, poi il taglio con la pulizia del punto 8.
