# I link della nuova app in un posto (ritiro del web vecchio, punto 1)

27 nov 2026, ramo `feat/link-nuova-app`. È il primo buco del ritiro del web vecchio,
§1.1 dell'inventario (`docs/plans/2026-11-27-ritiro-web-inventario.md`). Copre:
- i link che server, worker, notifiche e MCP scrivono verso il web vecchio;
- il ritorno del consenso Google;
- le card che la nuova app apre come «Open in web».

## L'helper

`packages/shared/src/app-links.ts`:

- **`appRoute(target)`** dà il frammento dopo `#`.
- **`appPath(target)`** dà `/app/#/…`.
- **`appUrl(publicUrl, target)`** dà l'indirizzo intero. Senza radice pubblica il link resta relativo.
- **`APP_ENTRY = "/app/"`** è l'unica riga da cambiare quando `/app` passa alla radice.
- **`legacyWebPath`** raccoglie i soli percorsi del web vecchio che servono finché esiste:
  - `webHref` di task, richieste e decisioni (l'«Apri nel web» dell'app);
  - il ritorno di Google per chi l'ha avviato dal web vecchio;
  - il link di reset della password che il web vecchio mostra all'admin.

  Al ritiro si cancella il blocco, e il compilatore trova chi lo usava.

Dall'id al bersaglio leggono il DB i risolutori in `packages/notifications/src/app-link-targets.ts`, condivisi da server e worker:
- `ticketAppUrl`, `projectAppUrl`, `requestsAppUrl`, `backlogItemAppUrl`, `repositoryDocsAppUrl`, `serverAppUrl`, `taskTarget`;
- un oggetto che non c'è più ripiega sulla Home della nuova app, mai sul web vecchio.

L'MCP non può importare l'helper a runtime: il pacchetto su npm non ha `@stubwise/shared`. Il server gli dà quindi il percorso già fatto, come campo additivo:
- `appPath` sul ticket e sul dettaglio della voce di backlog;
- `ticketAppPath` sulla conversione;
- `resultItemAppPath` sul job dell'intake.

L'MCP ci aggiunge la sua `baseUrl`. Un server di prima non lo manda: niente riga «URL:», mai un percorso del web vecchio.

## La tabella delle rotte (dal router, confermata da 79)

Le route stanno in `apps/desktop/src/renderer/router.tsx` e `data/routes.ts`. Valgono tre regole:
- nessuna vuole lo UUID di un progetto, di una task, di un repository o di un server: servono i codici;
- l'unica eccezione è `?request=`, che vuole lo UUID della voce;
- i frammenti vanno dopo `/app/#`.

| Oggetto | Frammento | Se non c'è o non si vede |
|---|---|---|
| Task | `/p/ACQ/tasks?task=ACQ-7`. `?task=` vale su ogni pagina e vuole il codice; uno UUID si scarta in silenzio | il pannello lo dice; progetto ignoto: ProjectNotFound |
| Voce di backlog / richieste | `/p/ACQ/requests?request=<uuid>`, oppure `/p/ACQ/requests`. Un codice `ACQ-R14` dà 400 | il pannello lo dice |
| Progetto | `/p/ACQ/overview`; il brief: `?brief=<id>`, solo l'ultimo | ProjectNotFound; un archiviato va su `/archived/ACQ` |
| Roadmap | nessun equivalente; la più vicina è `/p/ACQ/planning`. Il brief porta alla panoramica col brief aperto | — |
| Docs | `/p/ACQ/docs(/<repoSlug>(/<pageSlug>))`, con lo slug del repository | DocNotFound; modulo spento: DocsTurnedOff |
| Pagina di prodotto | `/p/ACQ/docs/product/ACQ-D5` | — |
| Server | `/p/ACQ/servers/SRV-2`, oppure `/admin/servers/SRV-2` (con `monitor.manage`) | il pannello lo dice |
| Rilascio, PR | `/p/ACQ/releases/ACQ-V3`; `/p/ACQ/releases?pr=<repositoryId>%23<n>` | — |
| Chat | `/chat/<canale>?message=<id>` | — |
| Automazione | `/automations/AUD-A1(/runs/2)` | — |
| Preferenze | `/preferences/security`, `/preferences/account`, `/preferences/notifications`. Una sezione ignota va su notifications | — |
| Inbox | nessuna rotta, è il pannello della campanella: si linka l'oggetto della card | `/inbox` dà «Page not found» |
| Conversazione dell'agente | `/claude/<agentSessionId>` (non il jobId) | il pannello lo dice |
| Accesso, link nelle email | `/reset-password/<token>`, `/email-change/<token>`, `/desktop-google?outcome=&state=` | — |

Un test di parità del renderer verifica che ogni link dell'helper sia una rotta di `isAppRoute` (`apps/desktop/src/renderer/data/appLinks.parity.test.ts`). L'unica eccezione dichiarata è il pannello della PR, che il router apre ma `isAppRoute` non accetta.

## Chi è passato all'helper

- **Worker**, link alla task (`ticketUrl` della pipeline: fix, triage, correzione, review e lo status di commit):
  - brief: la panoramica col brief aperto;
  - pulse: le richieste del progetto;
  - intake: la voce;
  - limite dei Docs: lo spazio del repository;
  - monitor: il server;
  - i link `/app/#` già esistenti di rilasci, PR, note di rilascio e diagnosi dei server.
- **Server**:
  - `ticketUrl` di ingest, inbound, webhook, job, Slack e ticket;
  - la risposta di `POST /api/backlog/from-design`;
  - le proposte passate al progetto (posta);
  - le citazioni dei Docs nelle risposte Slack;
  - PR e rilasci, il cambio dell'email, il ritorno di Google;
  - i `webHref` e il reset, che usano `legacyWebPath`.
- **Notifiche**:
  - `openUrl` (security.alert, decisioni, chat, `member.added`, doc di prodotto, automazioni);
  - l'avviso del giro notturno, gli avvisi di Support;
  - gli eventi d'esempio delle anteprime, la notifica di prova dei webhook.
- **MCP**: tutti i link dei tool di scrittura.

Il test di registro `apps/server/src/app-links-registry.test.ts` legge i sorgenti di server, worker, notifiche, shared, MCP e SDK. Fallisce su un percorso del web vecchio scritto a mano, o su un `/app/#` fuori da `app-links.ts`.

## Scelte (ruling)

- **Le card di una task si derivano a lettura.** `openUrl` riceve il codice della task dalla riga (`notifications.ticket_id`): decisioni, attività, `job.*` e `ticket.created` aprono la task nella nuova app.
  - Vale anche per le card già in inbox, che nel jsonb hanno `/tickets/:id`.
  - Lo fanno inbox e DM; senza codice resta il link dell'evento.
  - Le email e i webhook già spediti restano coi link vecchi (vedi sotto).
- **Il monitor scrive `serverId` nell'evento** (additivo). L'inbox ricavava il server dall'id dentro l'URL del web vecchio: ora lo legge da lì, con l'URL come ripiego per le card di prima.
- **Il ritorno di Google** decide dalla riga dello state, mai dalla query:
  - `client: "web"` è la nuova app nel browser e torna a `/app/#/preferences/account?google=<esito>`;
  - senza `client` è il web vecchio, che torna a `/settings/account`;
  - il desktop non cambia;
  - nessuna migrazione: `web` era già nel CHECK.
  - Va bene anche se la build web non legge `?google=`: aspetta da sé, rileggendo le caselle. Va però fatta mandare `client: "web"` (79).
- **Due link `/app` che erano già rotti:**
  - `member.added` portava a `#/projects/<id>/members`, ora va a `#/p/<CODE>/settings/members`;
  - la task della diagnosi di un server portava a `#/p/X/tasks/X-12`, ora va a `?task=`.
- **Support usa lo UUID della voce.** Il bersaglio «per codice» (`ACQ-R14`) avrebbe dato 400 e non esiste: l'evento d'esempio lo usava, gli avvisi veri no.

## Al ritiro: i link già spediti (rimandi fatti, regole di Caddy spente)

Card, email, push, DM e webhook già inviati restano coi percorsi vecchi. Il web vecchio li serve finché esiste. Al ritiro servono **due pezzi**:
1. **Un rimando lato server per id.** Caddy non può tradurre `/tickets/<uuid>` in `#/p/ACQ/tasks?task=ACQ-12`: non conosce i codici. Va una rotta del server, per esempio `GET /go/tickets/:id`, `/go/backlog/:id`, `/go/projects/:id(/roadmap)`, `/go/docs/:repositoryId(/:slug)`, `/go/monitor/servers/:id`. Risolve l'id con i risolutori di `app-link-targets.ts` e risponde 302 all'`appPath`. Un oggetto sparito va sulla Home.
   - Con la sessione: un id che chi apre non vede va sulla Home, così il rimando non svela il codice di un progetto invisibile.
   **Fatto** (ramo `feat/link-go-routes`): `apps/server/src/routes/go.ts`, `GET /go/…`
   per `tickets/:id`, `agents/job/:jobId` (anche col solo `?ticketId=`), `backlog/:id`,
   `backlog?projectId=`, `projects/:id`, `projects/:id/roadmap`, `projects/:id/backlog`,
   `docs/:repositoryId(/:slug)`, `monitor/servers/:id`.
   - Senza una sessione completa si va all'ingresso della nuova app, che chiede il login.
     Non c'è un «torna a» dopo il login: si atterra sulla Home.
   - Un oggetto invisibile, inesistente o un id non valido portano alla Home, con la stessa
     risposta.
   - `config.access` `public` (la sessione la legge l'handler), `config.mcp` `infra`.
   - `/go/*` è già proxato da Caddy (`@backend`).
2. **Le regole di Caddy.** Scritte nel `Caddyfile`, **commentate**: si accendono al ritiro.
   Validato con `caddy validate` sia spento sia acceso, e provato dal vivo acceso (i percorsi
   arrivano al server su `/go/…` con la query intatta, le impostazioni rimandano). Le regole
   sono: `/tickets/*`, `/backlog/*`, `/projects/*`, `/docs/*` (la sezione Docs del web vecchio, non `/guide`), `/monitor/servers/*` vanno sulle rotte `/go/…`. Poi `/settings/security` va su `/app/#/preferences/security`, `/settings/account` su `/app/#/preferences/account`, e il resto del web vecchio su `/app/`.

## Le card «Open in web» (per 79)

Il server dà già, a lettura, `taskCode`, `serverCode` e `objectGone`. Con questo ramo:

| Kind | Cosa serve all'app | Lato server |
|---|---|---|
| `job.plan_review`, `job.awaiting_input`, `google.proposal` | `#/home` (si decide lì) | niente |
| `job.failed`, `job.held`, `job.budget_held`, `job.pr_opened`, `review.completed`, `ticket.created` | `#/p/X/tasks?task=CODE`: basta metterli in `INTEGRATED_KINDS` | `taskCode` c'è già |
| `request.created` | il `url` è `/app/#/p/X/requests?request=<uuid>`, che `appLinkFor` accetta già | fatto in questo ramo |
| `project.brief` | `projectUrl` è `/app/#/p/X/overview?brief=<id>`, e `briefId` è nell'evento | fatto; `appLinkFor` va allargato a `overview?brief=` |
| `docs.limit_paused`, `docs.nightly_attention` | `docsUrl` è `/app/#/p/X/docs/<slug>` | fatto; `appLinkFor` va allargato allo spazio |
| `security.alert` | `#/preferences/security` | il link è già quello |
| `monitor.*` | `serverCode` (c'era già) | `serverId` nell'evento |
| aprire la conversazione di un run | `agentSessionId` sulla card | non fatto: da chiedere se serve |

## La revisione di `feat/link-nuova-app` (27 nov 2026)

- **I1, il codice di un progetto ha una regola sola.** È `projectCodeSchema`,
  `^[A-Z][A-Z0-9]{1,5}$`, esportata come `PROJECT_CODE_PATTERN` da
  `app-links.ts` e usata da `projectCodeSchema` stesso.
  - Le 53 copie di `[A-Z]{2,4}` nel renderer (rotte, `TASK_CODE_RE`,
    `appLinkFor`, i parser di Claude, Drive, Posta, automazioni, rilasci,
    membri) seguono quella regola. Prima la nuova app non apriva le task di
    progetti come `TRI2` o `WIL2`.
  - `CODE_TOKEN_RE` della doc di prodotto pure.
  - Resta stretta, apposta, solo la PROPOSTA dei codici nuovi
    (`PROJECT_CODE_RE` in `shared/tasks/project-code.ts`).
  - Un test nel renderer vieta `[A-Z]{2,4}` (`appLinks.parity.test.ts`). La
    parità copre tutti i bersagli dell'helper, coi codici `ACQ`, `TRI2`,
    `STU2` e `WILLY2`.
- **I2:** `appPath` è anche sullo schema base della voce di backlog, e le
  scritture di design e piano lo danno.
- **I3, il test di registro.** Riconosce il prefisso dei percorsi vecchi in
  ogni stringa: concatenazioni, liste senza id, tutto `/settings/`, `/inbox`.
  Riconosce anche ogni frammento `#/`. Salta solo:
  - le stringhe che iniziano con `/api/`;
  - i pattern e le rotte registrate (`app.get("…")`);
  - i moduli;
  - le basi che non sono la nostra radice (`${GMAIL_API_BASE}`).

  Legge `.ts`, `.tsx` e `.mjs` di tutte le app e i pacchetti, tranne il web
  vecchio, il desktop e la guida. La ricerca (`search.ts`) usa `appRoute`.
- **I4, derivati a lettura.** I link di `project.pulse`, `project.brief`,
  `docs.limit_paused`, `docs.nightly_attention`, `request.created`,
  `google.proposal_handed` e `server.diagnosis_ready` vengono da
  `linkContextsFor`. Sono poche query per pagina e danno i codici di
  progetto, task, repository e server. Valgono anche per le card di prima:
  il repository si ricava anche dall'id nel link Docs del web vecchio. Li
  usano sia l'inbox sia i DM.
- **Minor.**
  - M1, M2 e M8: `ticketUrl`, il link del monitor e le citazioni Slack non
    lanciano mai; ripiegano sulla Home.
  - M3: un codice di progetto vuoto dà la Home, mai `/p//`.
  - M4: gli slug riservati, con un suffisso (`RESERVED_REPOSITORY_SLUGS`,
    `RESERVED_DOC_PAGE_SLUGS`): repository creati, pagine manuali e
    generate, anche con lo slug dall'orientamento.
  - M5: la parità è completa.
  - M6: il rinomina del codice è nel registro dei rimandi.
  - M9: accettato com'è, su decisione di 46 nella revisione.
