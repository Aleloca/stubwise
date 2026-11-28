# Il taglio del web vecchio — piano

> 28 nov 2026, 72, per 46. Solo documento, nessun codice. Parte
> dall'inventario (`docs/plans/2026-11-27-ritiro-web-inventario.md`, §2 e §3
> punti 6–8) e dal registro dei rimandi
> (`docs/plans/integrazione-registro-rimandi.md`). Le decisioni del
> maintainer sono prese (28 nov 2026, §1); quelle della prima stesura, con le
> opzioni, restano in fondo come storia.

## 0. Prima del taglio: cosa deve essere già vero

Il taglio non porta funzioni nuove: toglie. Prima devono essere chiusi i
bloccanti dell'inventario (§3, punti 1–5) e decisi i punti 6–7. Stato di
oggi, 28 nov:

| Punto | Stato |
|---|---|
| 1. Link e card verso `/app/#/…`, callback Google | Su `main` (#136): `appUrl`/`appPath` di `@stubwise/shared/app-links`, rimandi `/go/…` già accesi sul server; il callback Google torna a `appPath(desktopGoogle)`. |
| 2. Cassaforte nel browser | Il lavoro di 79 (`fix/sicurezza-origine`, `feat/vault-session-tag`): **da verificare** con lui che creazione della chiave, kit, recupero, attivazione e `/vault-pair` vivano su `/app`. Senza, il taglio chiude fuori la cassaforte. |
| 3. Repository | #137, in PR. |
| 4. General, AI, Usage del progetto | #135, su `main`. |
| 5. Proposte del pulse | Su `main` (`pulse-proposals`). |
| 6. Zip dei Docs, `graph.json`, «Manage {name}'s Macs» | **Da verificare** (#140 per i Docs). |
| 7. Buchi minori (d) | #138 (brief, recenti ⌘K, coperti), #143 (immagini della posta); il grafo interattivo lo fa 79 (D7). |

Una verifica utile, da fare una volta prima di R1: in ogni rotta della nuova
app nessun «Open in web» deve portare a una pagina che sparisce. Oggi
`openInWeb`/`webHref`/`legacyWebPath` hanno 14 chiamanti nel renderer
(`apps/desktop/src/renderer/platform/openWeb.ts`): ognuno o ha già il
suo equivalente nell'app (e la chiamata si toglie), o è un buco
dell'inventario.

## 1. Le decisioni del maintainer (28 nov 2026)

- **D1**: `/app` alla radice INSIEME allo spegnimento, in un rilascio solo
  (R1 e R2 della prima stesura fusi).
- **D2**: `tickets.status` si toglie NELLO spegnimento: tutti i lettori e gli
  scrittori passano a `status_id` (blocco T, §1.2), colonna e trigger vanno
  nelle migrazioni.
- **D3**: una suite E2E minima sulla nuova app PRIMA dello spegnimento:
  login, Home, una task, posta, cassaforte.
- **D4**: si toglie TUTTO ciò che l'app non usa, anche se l'MCP lo espone (la
  parità MCP è «tutto ciò che fa l'app»). L'elenco lo dà lo script obbligatorio
  del registro contro i chiamanti (`scripts/route-callers.mjs`, §3).
- **D5, D6, D8, D9**: come i consigli: la mobile di oggi si accetta rotta;
  la guida si riscrive subito dopo, con un'avvertenza; le migrazioni due
  settimane dopo la pulizia; `design-tokens.ts` diventa la fonte.
- **D7**: il grafo NON è più rimandato: l'HTML di graphify dentro la tab
  Grafo della build web, lo fa 79. L'eccezione `@graphHtml` di Caddy
  **resta**.

## 1.1 I rilasci, in ordine

Quattro rilasci. Ognuno parte quando il precedente è stabile in produzione.

### R0 — gli stati senza l'enum (blocco T, solo codice)

Il lavoro su `tickets.status` (§1.2) senza toccare i dati: nessuno scrive
più l'enum, nessuno lo legge. Il trigger `tickets_status_sync` resta e
continua a tenere la colonna coerente da `status_id`, quindi un'immagine di
prima ritrova la colonna giusta.

- **Ordine**: `server` e `worker` insieme (la pipeline scrive, il server
  legge e risponde). Il mobile non cambia: `status` resta nelle risposte,
  derivato.
- **Rollback**: le immagini di prima. Sicuro: il trigger ha tenuto la colonna
  allineata per tutto il tempo.

### R1 — lo spegnimento, con `/app` alla radice (`server` + `caddy`)

- **Prerequisiti**:
  - §0 chiuso;
  - la suite E2E (D3) verde in CI CONTRO LA RADICE: si scrive sulla build
    `/app` e il rilascio la porta alla radice;
  - R0 stabile.
- **Caddyfile**:
  - l'app alla radice (`root * /srv/app`, CSP stretta, COOP, `no-store` sul
    documento), dopo i `handle` di `/api`, `/ingest`, `/webhooks`,
    `/widget/*`, `/widget.js`, `/monitor/ingest|config`, `/go/*` e
    `/guide/*`;
  - il blocco del ritiro, oggi commentato, si accende: i percorsi con un id
    (`/tickets/*`, `/backlog*`, `/projects/*`, `/docs/*`,
    `/monitor/servers/*`, `/agents/job/*`) vanno a `/go{uri}` (302), più i
    `redir` di `/settings/*` e `/inbox`;
  - `/app` e `/app/*` diventano `redir` 308 a `/`, **per sempre**. Il browser
    tiene il frammento, quindi i link già spediti (`/app/#/…`, dalla #136) e
    i Mac installati (`browserLogin.ts` apre `<istanza>/app/#/desktop-login`)
    arrivano dove devono;
  - l'eccezione `@graphHtml` resta (D7);
  - via il `handle` della SPA vecchia.
- **`APP_ENTRY`** (`packages/shared/src/app-links.ts`) da `"/app/"` a
  `"/"`, `base` di `vite.app-web.config.ts` da `"/app/"` a `"/"`:
  - da qui i link nuovi (card, email, push, webhook, MCP) sono `/#/…`;
  - il prossimo build del Mac apre `/#/desktop-login`.
- **`Dockerfile.caddy`**: via lo stage del web vecchio e `--web` di
  `scripts/caddy-csp.mjs`. L'app si copia nella radice servita.
- **La cancellazione di `apps/web`** (§2), nello stesso rilascio.
- **Ordine**: `server` e `caddy` nello stesso deploy. In nessuno dei due
  ordini c'è una finestra rotta:
  - col caddy prima, i link restano `/app/#/…` e passano dal redirect;
  - col server prima, il caddy vecchio serve `/app/` e i link `/#/…`
    finiscono sul web vecchio alla radice: la pagina sbagliata per qualche
    minuto, mai un errore.
- **Rollback**: le immagini di prima di `caddy` (va TENUTA: il codice del web
  non c'è più nel repo) e di `server`. Durante il rollback, un link `/#/…`
  scritto dopo R1 apre la Home del web vecchio invece della pagina: un
  degrado, non un errore, che dura finché non si risale.

### P — il plugin e i tool MCP sulle rotte dell'app (D10, prima di R2)

Decisione del maintainer (D10, b): PRIMA della pulizia, i comandi del plugin
(`/stubwise:run`, `/stubwise:start`) e i tool MCP dedicati che usano le 17
rotte che l'app non chiama passano alle rotte dell'app. Chi:
- design e piano di ticket e voci di backlog (`set_design`, `set_plan`,
  `delete_design`, `delete_plan`);
- `create_backlog_from_design`, `convert_backlog_to_ticket`;
- `get_backlog_item`, `list_backlog`;
- le azioni dell'inbox.

Il catalogo MCP (`/api/mcp/catalog`) è dell'MCP e resta.

- Dove l'app non ha ancora la rotta (Remove design e Remove plan,
  inventario 1.6), la si aggiunge prima, ADDITIVA, sulle rotte della nuova app.
- Una versione nuova del plugin, con il changeset di `@stubwise/mcp` e di
  `@stubwise/claude-plugin` (gruppo `fixed`), pubblicata dal workflow
  Release; si verifica con `npm view @stubwise/mcp version`.
- **Compatibilità**: un plugin vecchio deve continuare a funzionare finché le
  rotte vecchie esistono. Quindi l'ordine è: rotte dell'app (se mancano), poi
  plugin nuovo pubblicato e aggiornato, poi R2, che toglie le 17 rotte. Fra P
  e R2 passa abbastanza tempo perché l'avviso «plugin vecchio» del server MCP
  arrivi a chi lo usa.
- **Rollback**: P è additivo. Si torna alla versione precedente del plugin,
  o si lascia quella nuova, che funziona anche con le rotte vecchie
  presenti.

### R2 — la pulizia del server (solo codice)

- **Cosa si toglie** (§3):
  - TUTTE le rotte che l'app non chiama, dall'elenco dello script (D4): il
    gruppo (e), Slack, `saved_views`, `/api/projects/pulse`,
    `GET /api/auth/invites` e il resto che lo script trova;
  - con loro le azioni MCP corrispondenti, che il catalogo deriva da solo;
  - i DM Slack del worker;
  - le env `SLACK_*`.
- **La mobile di oggi** smette di funzionare dove legge le rotte tolte (D5).
- **Ordine**: `server` e `worker`, poi `caddy` se il renderer perde frasi.
- **Rollback**: le immagini di prima. Sicuro, nessun dato toccato.
- **Com'è andato** (28 nov 2026, branch `feat/taglio-r2`):
  - **`GET /api/projects/pulse` RESTA**: esce dal gruppo (e). La legge
    ancora la chat del worker (`apps/worker/src/claude-chat`, le letture del
    polso), e lo script delle rotte non guarda il worker: toglierla
    spegnerebbe una lettura della chat.
  - **I campi Slack nelle risposte restano, inerti, fino a R3**
    (`slackUserId`, `slackDm` delle preferenze, i flag `slack*Set`
    dell'istanza): l'app mobile li legge, e toglierli dagli schemi
    condivisi la farebbe smettere di compilare. Nessuno li scrive più
    (le richieste non li accettano); escono con le colonne in R3.
  - Le consegne `slack_*` rimaste in coda le chiude il poller come
    `skipped`, `channel_not_implemented`.
  - **Le 9 rotte della sola mobile** tolte anch'esse (D4): `POST
    /api/auth/mobile-login`, `PUT /api/me/devices`, `POST
    /api/me/devices/delete`, `GET /api/me/mail/:source/:id`, `GET
    /api/me/mail/rejections`, `GET /api/projects/:projectId/docs/highlights`,
    `GET /api/search/docs-semantic`, `GET /api/tickets/:id/history`, `GET
    /api/tickets/:id/questions`. Il catalogo MCP si restringe, ed è voluto:
    spariscono `mail.message`, `mail.rejections`, `docs.projectHighlights`,
    `docs.semanticSearch`, `tickets.history`, `tickets.questions`,
    `me.unregisterDevice`.
  - **Effetto sulla mobile (D5, accettato)**: niente login, niente
    registrazioni push nuove. Le push ai telefoni già registrati
    continuano, e reset e cambio della password revocano ancora i PAT
    `mobile` già emessi. I metodi dell'api-client restano, così la mobile
    compila.

### R3 — le migrazioni (due settimane dopo R2, D8; backup prima)

- **Slack**: le colonne di `users` (`slack_user_id`, `slack_avatar_url`) e le
  preferenze DM.
- **`saved_views`**: la tabella.
- **Inviti**: `invites.token` diventa un hash, calcolato sul posto (i link
  già spediti funzionano).
- **Stati** (blocco T, il passo dei dati):
  - `tickets_status_sync` si SOSTITUISCE con un trigger che fa le sue due
    cose senza l'enum: mantenere `closed_at` dalla famiglia, e scegliere lo
    stato di un ticket che cambia progetto dal ruolo dello stato di prima;
  - `DROP COLUMN tickets.status`;
  - `project_statuses.legacy_status` da enum a `text` con `CHECK` sugli
    stessi valori (resta il ruolo dello stato per la pipeline);
  - `stubwise_legacy_family` e `stubwise_status_for_legacy` ricreate con
    parametri `text`;
  - infine `DROP TYPE ticket_status`.
- Ogni `DROP` in uno statement a sé; nessun `ADD VALUE`.
- **Rollback**: dopo R3 si scende al massimo a R2, perché il codice di prima
  di R0 nomina la colonna. Per questo R3 aspetta.

## 1.2 Il blocco T: `tickets.status` fuori dal codice

Invariante (`docs/invariants/tasks.md`): lo stato vero è `status_id`, e la
mappatura fra «ruolo» (open, triaged, in_progress, in_review, done, closed) e
stato del progetto sta in UN posto, `stubwise_status_for_legacy`. Il blocco
non cambia la regola: sposta chi la usa.

- **Gli scrittori** smettono di scrivere `status`. Un aiuto solo,
  `statusIdForRole(role)` (in `packages/db`), restituisce il frammento SQL
  `stubwise_status_for_legacy(project_id, '<ruolo>', status_id)` per l'`UPDATE`.
  La mappatura resta in SQL, in un posto. Chi:
  - la pipeline del worker: fix (in_progress, in_review, done), triage
    (triaged), intake, classificazione (classify, classify-v2);
  - il server: il webhook git (PR mergiata → done), il rilascio, le
    adozioni, le correzioni dei server, i meeting, gli a-parte di Claude, i
    traguardi.
- **I lettori** leggono il ruolo dello stato corrente (`legacy_status` di
  `project_statuses`, via join o una funzione `stubwise_ticket_role(status_id)`)
  o la famiglia:
  - il polso (`project-pulse-summary`, `stall`);
  - la ricerca;
  - lo stato dell'istanza;
  - i traguardi;
  - `ticket-events`;
  - i filtri delle rotte (`GET /api/tickets?status=`).
- **L'API** continua a dare `status` nelle risposte, DERIVATO a lettura dal
  ruolo dello stato. È la regola «i campi che un client legge si derivano a
  lettura», e mobile e MCP non si accorgono di niente.
- **In ingresso**, `PATCH /api/tickets/:id` con `status` (MCP
  `set_ticket_status`, i comandi `/stubwise:run` e `/stubwise:start` del
  plugin) si traduce con `statusIdForRole`:
  - il tool e i comandi non cambiano;
  - l'MCP non scrive più la colonna;
  - nessun changeset del plugin serve per questo.
- **Le notifiche**: `format.ts` ridichiara i valori dell'enum (modulo puro).
  Restano, come nomi di ruolo.
- **La guardia**: un test sul sorgente, come quello dei lettori delle
  workspace, vieta `tickets.status` fuori da un elenco chiuso (lo schema e
  la migrazione), così un lettore nuovo non lo reintroduce fra R0 e R3.
- **Test**:
  - le transizioni della pipeline, che diventano uno stato del progetto
    giusto per ogni ruolo;
  - le risposte con `status` derivato;
  - il cambio di progetto;
  - `closed_at`;
  - la guardia.
- **Stima**: M. Una ventina di file fra server, worker e notifiche, nessuna
  UI.

## 2. La cancellazione di `apps/web`: cosa dipende da lui

| Cosa | Dove | Cosa si fa |
|---|---|---|
| Il pacchetto | `apps/web/` | si cancella; `pnpm-workspace.yaml` usa `apps/*`, niente da toccare |
| CI, E2E | `.github/workflows/ci.yml`, job `e2e` (Playwright di `apps/web/e2e`) | il job passa alla suite nuova sulla nuova app (D3: login, Home, una task, posta, cassaforte), scritta e verde PRIMA di R1 |
| Build dell'immagine | `Dockerfile.caddy` (stage `web-build`, `COPY … /srv/web`), `scripts/caddy-csp.mjs --web` e test | come in R1 |
| Changesets | `.changeset/config.json` (il pacchetto fra gli ignorati) | si toglie la voce |
| Il link del web | `openInWeb`, `webHref`, `legacyWebPath` nel renderer (14 chiamanti), `open:web` del main del Mac | si tolgono i rami che portano al web; `legacyWebPath` resta solo se serve ai rimandi |
| Token di design | `packages/shared/src/design-tokens.ts` dice che la fonte vera è Tailwind di `apps/web` (`styles.css`), allineata da `apps/web/src/theme-parity.test.ts` | la fonte diventa `design-tokens.ts` stesso (D9; l'unico lettore è `apps/mobile`, da rifare); si aggiorna il docblock |
| La guida utente | `apps/docs` (`/guide`): descrive le schermate del web vecchio (notifiche, webhook in ingresso, la landing) | si riscrive sulla nuova app subito dopo R1, con un'avvertenza in testa finché non è pronta (D6); `/guide` come percorso resta |
| Documentazione | `README.md`, `CONTRIBUTING.md`, `docs/invariants/*` (citano file di `apps/web`), commenti nel codice «come `apps/web/…`» | i riferimenti normativi si aggiornano nello stesso rilascio; i commenti storici si ripuliscono dopo, non bloccano |
| CLAUDE.md | 9 citazioni di `apps/web` (architettura, deploy, trappole del web) | **le aggiorna il maintainer** (non si tocca da una sessione) |
| `Dockerfile.agent` | un commento che cita `apps/web/.../server-admin.tsx` | commento da aggiornare |

## 3. La pulizia del server (R2, e i dati in R3)

L'elenco lo dà lo script del registro contro i chiamanti
(`apps/server/scripts/route-callers.ts`, D4): ogni rotta del server che nessun client
dell'app chiama (gli adattatori veri del desktop, l'api-client, il main del
Mac, il widget, l'agente di monitoraggio, i webhook in ingresso) si toglie,
anche se l'MCP la espone.

**Il primo giro dello script** (28 nov 2026, base `docs/ritiro-web-piano`,
rapporto in `docs/plans/2026-11-28-rotte-senza-chiamanti.md`): 722 rotte; 539
usate dall'app; 35 esterne per dichiarazione (webhook in ingresso, login,
infra, stream); 48 dubbi (il percorso compare nel codice dell'app o in una
risposta del server, come `avatarUrl`, senza una chiamata tracciata); **100
senza chiamanti**. Le 100, divise:

- **24 sono IN ARRIVO** da rami non ancora uniti, e spariranno dall'elenco:
  - 11 della #137 (repository, file d'ambiente, rami);
  - 1 della #138 (i recenti);
  - 11 di 79 (la cassaforte nel browser, il grafo);
  - 1 della #140 (lo zip dei Docs).

  Lo script si rilancia sulla base del taglio.
- **16 sono il gruppo (e)**, già deciso: Slack, `saved_views`, posta
  ammessa, regole della posta, «Rigenera il brief», adozione, webhook unico.
- **17 le usano i tool DEDICATI dell'MCP**, cioè i comandi del plugin
  (`/stubwise:run` e `/stubwise:start`: design e piano di ticket e voci di
  backlog, `from-design`, `convert`, le azioni dell'inbox, il catalogo MCP
  stesso). Toglierle rompe quei tool: o il tool passa a una rotta dell'app,
  o la rotta resta.
  - Il catalogo MCP (`/api/mcp/catalog`) è l'infrastruttura dell'MCP e
    **resta**.
  - Per design e piano l'app non ha ancora «Remove design» e «Remove plan»
    (inventario 1.6).

  Deciso (D10, b): passano alle rotte dell'app nel blocco P, prima di R2.
- **9 le usa solo la mobile di oggi**: si accetta (D5).
- **34 sono le candidate vere**, da rivedere una per una prima di togliere:
  - alcune arrivano forse per un'altra strada, per esempio le azioni sulle
    esecuzioni delle automazioni e le rotte dei Docs di prodotto toccate da
    Claude;
  - altre sono del web vecchio e basta, per esempio `GET /api/servers/:id`,
    `/api/projects/:id/timeline` e le sessioni della chat dei Docs.

**Il secondo giro, rivisto a mano** (28 nov 2026, base `152916dfd`, con #137,
#141 e #145 in main; il dettaglio è nello stesso rapporto, «Revisione a
mano»). Lo script aveva sei classi di falsi negativi: i percorsi con un
segmento variabile, le funzioni definite fuori dall'oggetto, gli aiuti a
catena o passati nudi, le funzioni col verbo con un altro nome, le virgolette
dentro un'interpolazione. Due le aveva trovate 79. Corrette quelle, delle
34 «candidate vere» molte erano usate davvero (le decisioni sulle esecuzioni
delle automazioni, `GET`/`PATCH`/`DELETE /api/servers/:id`, `server-fix`,
`freeBusy`, la ricerca della chat e dei rilasci, lo zip dei Docs). Le **67**
senza chiamanti:

- 2 in arrivo (#138, `feat/cassaforte-browser`);
- **9 della cassaforte nel browser ancora senza chiamante** (attivare,
  chiave, kit e recupero, lookup dell'accoppiamento): le chiama solo il web
  vecchio e **non si tolgono**, sono la funzione che la nuova app deve
  ancora avere (§1.2 dell'inventario: la fase 2 della cassaforte, a 79);
- 16 del gruppo (e), 12 dei tool dedicati dell'MCP (blocco P), 9 solo della
  mobile;
- 2 dei Docs di prodotto toccati da Claude: restano, per la parità MCP
  (deciso il 28 nov 2026);
- **17 da togliere con R2**, tutte del web vecchio e basta: nell'app la
  funzione c'è con un'altra rotta, o era già morta nel web.

Le voci già note:

- **Slack** (registro, «Togliere Slack dal server»):
  - rotte `/api/slack/*`, `/slack/*`, `PUT/DELETE /api/users/:id/slack`,
    `GET /api/slack/workspace-users`;
  - `apps/server/src/slack/` (14 file);
  - `resolveSlackActor` e i servizi che lo usano (14 file in
    `services`, 14 in `routes`, 11 in `notifications`);
  - i DM e la riscrittura dei DM nel worker (`slack_dm`, `slack_update` nel
    compose);
  - `slackDm` delle preferenze, le env `SLACK_*`;
  - nel renderer, le poche frasi rimaste.

  R3: le colonne. L'app mobile ha una sezione Slack nelle impostazioni, e
  si accetta che smetta di funzionare (D5).
- **`saved_views`**: la rotta `/api/saved-views` (e quindi le azioni MCP
  `savedViews.*`, che il catalogo deriva da sola). R3: la tabella.
- **`/api/projects/pulse`**: la nuova app usa `/api/projects/pulses`. La
  rotta vecchia la legge ancora l'**app mobile** (3 file): si accetta (D5).
- **Il token degli inviti in chiaro**: via `GET /api/auth/invites`
  (l'elenco col token). Restano `POST /api/auth/invites` (creare, lo usa
  People) e `GET /api/auth/invites/:token` (accettare). R3: il token come
  hash.
- **Le altre rotte del gruppo (e)**:
  - posta ammessa: `/api/settings/mail-admission`;
  - regole della posta del progetto: `/api/projects/:id/email-routes`,
    `email-labels`;
  - «Rigenera il brief»: `POST …/briefs/generate`;
  - adozione delle PR: `…/adoption`;
  - webhook unico delle notifiche: `/api/settings/notifications` e `…/test`.

  Si tolgono con R2, insieme a quelle che trova lo script.
- **`tickets.status`**: non è più una voce di questa pulizia, è il blocco T
  (§1.2), con R0 e R3.

## 4. Riassunto dell'ordine

1. **Prerequisiti** (§0): la cassaforte su `/app` (79), #137, il punto 6,
   gli «Open in web» rimasti; il grafo di 79; lo script delle rotte e il suo
   elenco rivisto.
2. **R0**, gli stati senza l'enum (blocco T): `server` e `worker`.
   Rollback: le immagini di prima.
3. **La suite E2E** (D3) verde in CI.
4. **R1**, lo spegnimento con `/app` alla radice: `server` e `caddy`, e la
   cancellazione di `apps/web`. Rollback: le immagini di prima (quella di
   caddy TENUTA).
5. **P**, il plugin e i tool MCP sulle rotte dell'app (D10), pubblicato
   PRIMA di R2.
6. **R2**, la pulizia del server dall'elenco dello script: `server`,
   `worker`, `caddy`. Rollback: le immagini di prima.
7. La guida riscritta (D6), subito dopo R1.
8. **R3**, due settimane dopo R2, con il backup: le colonne Slack,
   `saved_views`, l'hash degli inviti, e il passo dei dati del blocco T
   (trigger sostituito, colonna, enum). Rollback: solo fino a R2.

R0 e la suite E2E sono indipendenti e possono andare in parallelo. R2 dopo
R1, perché le rotte del web servono finché il web è acceso.

## Le decisioni della prima stesura (decise il 28 nov 2026, vedi §1)

Con le opzioni come erano state proposte. Dove la scelta è diversa dal
consiglio, vale §1.

- **[D 1] `/app` alla radice** (registro, r.2121: decisione aperta della
  fetta 1).
  - (a) **Sì, in un rilascio a sé dopo il taglio (R2)** — *consigliata*:
    l'indirizzo dell'app diventa quello dell'istanza, e i `redir` da `/app`
    tengono vivi i link spediti e i Mac già installati. Separarlo dal taglio
    tiene piccolo ciascun rollback.
  - (b) Sì, insieme al taglio: un rilascio in meno, ma un rollback più
    grosso, perché tocca anche il server per `APP_ENTRY`.
  - (c) No, l'app resta su `/app`: la radice rimanda a `/app/` per sempre.
- **[D 2] L'enum `tickets.status`.**
  - (a) **Fuori dal taglio, come progetto a sé** — *consigliata*: lo usano
    pipeline, MCP, plugin, notifiche e mobile, e toglierlo non c'entra col
    web.
  - (b) Nel taglio: allunga di molto R3 e tocca il comportamento della
    pipeline.
- **[D 3] I test end-to-end.** Con `apps/web` sparisce l'unica suite
  Playwright.
  - (a) **Prima del taglio, una suite minima su `/app`** (login, una task,
    Home, ⌘K, impostazioni) — *consigliata*.
  - (b) Dopo il taglio, con un periodo senza E2E.
  - (c) Niente E2E: ci si affida ai test del renderer e a quelli del server.
- **[D 4] Le rotte che l'app non usa ma l'MCP espone** (dopo lo script di
  §3).
  - (a) **Si tolgono solo quelle del gruppo (e)**; le altre restano per
    l'MCP — *consigliata*: la parità MCP l'ha decisa il maintainer.
  - (b) Si tolgono tutte quelle che l'app non usa: meno superficie, ma
    l'MCP perde azioni.
- **[D 5] L'app mobile di oggi** (`/api/projects/pulse`, la sezione
  Slack, l'enum se un giorno sparisce).
  - (a) **Si accetta che smetta di funzionare dove legge le rotte tolte**
    (lista progetti, Slack) — *consigliata*: un solo utente, e si rifà come
    la nuova app (memoria del 23 nov).
  - (b) Le rotte restano finché esiste la mobile nuova.
- **[D 6] La guida utente (`/guide`).**
  - (a) **Riscriverla sulla nuova app subito dopo il taglio**, con
    un'avvertenza in testa finché non è pronta — *consigliata*.
  - (b) Prima del taglio (il taglio aspetta la guida).
  - (c) Toglierla.
- **[D 7] Il grafo interattivo** (rimandato dai buchi minori).
  - (a) **Resta rimandato**: col taglio sparisce la sua sola vista e
    l'eccezione `@graphHtml` di Caddy — *consigliata*.
  - (b) Una fetta prima del taglio, per non perderlo.
- **[D 8] Quando R4.**
  - (a) **Due settimane dopo R3**, con il backup — *consigliata*.
  - (b) Subito dopo R3.
  - (c) Mai: le colonne restano inutilizzate.
- **[D 10] Le rotte che solo i tool dedicati dell'MCP usano** (nuova, dal
  primo giro dello script): design e piano di ticket e voci di backlog,
  `from-design`, `convert`, le azioni dell'inbox.
  - (a) **Restano, e i tool non cambiano, finché l'app non ha le sue rotte
    per le stesse cose** (Remove design e Remove plan, inventario 1.6) —
    *consigliata*: sono il flusso dei comandi `/stubwise:run` e
    `/stubwise:start`.
  - (b) I tool passano alle rotte dell'app prima del taglio, e queste
    rotte si tolgono con R2.
- **[D 9] La fonte dei token di design.**
  - (a) **`packages/shared/src/design-tokens.ts` diventa la fonte** —
    *consigliata*.
  - (b) Prenderli dal Tailwind del renderer del desktop, con un test di
    parità nuovo.
