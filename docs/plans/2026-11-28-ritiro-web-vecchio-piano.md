# Il taglio del web vecchio — piano

> 28 nov 2026, 72, per 46. Solo documento, nessun codice. Parte
> dall'inventario (`docs/plans/2026-11-27-ritiro-web-inventario.md`, §2 e §3
> punti 6–8) e dal registro dei rimandi
> (`docs/plans/integrazione-registro-rimandi.md`). Le decisioni che restano
> del maintainer sono **[D n]**, in fondo, ciascuna con opzioni e consiglio,
> pronte per AskUserQuestion.

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
| 7. Buchi minori (d) | #138 (brief, recenti ⌘K, coperti), #143 (immagini della posta); il grafo interattivo resta rimandato **[D 7]**. |

Una verifica utile, da fare una volta prima di R1: in ogni rotta della nuova
app nessun «Open in web» deve portare a una pagina che sparisce. Oggi
`openInWeb`/`webHref`/`legacyWebPath` hanno 14 chiamanti nel renderer
(`apps/desktop/src/renderer/platform/openWeb.ts`): ognuno o ha già il
suo equivalente nell'app (e la chiamata si toglie), o è un buco
dell'inventario.

## 1. I rilasci, in ordine

Quattro rilasci, ciascuno con il suo rollback. Ognuno parte quando il
precedente è stabile in produzione (almeno qualche giorno di uso vero).

### R1 — il taglio (solo `caddy`, più la cancellazione del codice)

- **Caddyfile**:
  - si accende il blocco «Ritiro del web vecchio», oggi commentato: i
    percorsi con un id (`/tickets/*`, `/backlog*`, `/projects/*`, `/docs/*`,
    `/monitor/servers/*`, `/agents/job/*`) vanno a `/go{uri}` sul server
    (302 alla nuova app), più i `redir` di `/settings/*` e `/inbox`;
  - il `handle` finale della SPA (`root * /srv/web`) diventa un `redir`
    di tutto il resto a `/app/` (308). Il browser tiene il frammento nei
    redirect, quindi anche un `/#/…` arriva a `/app/#/…`;
  - restano come sono `/api`, `/ingest`, `/webhooks`, `/widget/*`,
    `/widget.js`, `/monitor/ingest|config`, `/go/*`, `/guide/*` e `/app/*`;
  - l'eccezione `@graphHtml` al `X-Frame-Options` serviva solo all'iframe del
    grafo del web vecchio: la nuova app non lo mostra (grafo interattivo
    rimandato), quindi si toglie, o resta se [D 7] lo riporta.
- **`Dockerfile.caddy`**: via lo stage che builda `apps/web` e la sua copia in
  `/srv/web`; `scripts/caddy-csp.mjs` perde `--web` (e il suo test lo
  stesso caso). Restano l'app (`/srv/app`), la guida, il widget.
- **La cancellazione di `apps/web`** (vedi §2).
- **Server e worker non cambiano.**
- **Rollback**: si rimette l'immagine `caddy` di prima (va TENUTA: il codice
  del web non c'è più nel repo). Nessun dato toccato: sicuro in ogni
  momento.

### R2 — `/app` alla radice (se [D 1] lo vuole)

- `APP_ENTRY` (`packages/shared/src/app-links.ts`) da `"/app/"` a `"/"`:
  da qui ogni link nuovo (card, email, push, webhook, MCP) è `/#/…`.
- `base` di `apps/desktop/vite.app-web.config.ts` da `"/app/"` a `"/"`;
  `Dockerfile.caddy` copia l'app nella radice servita.
- **Caddyfile**: il blocco dell'app (CSP stretta, COOP, `no-store` sul
  documento) passa alla radice, dopo i `handle` di API, widget, guida e
  `/go`. `/app` e `/app/*` diventano `redir` 308 a `/`, **per sempre**:
  - i link già spediti con `/app/#/…` (dalla #136 in poi) continuano ad
    aprirsi, col frammento;
  - l'app Mac già installata apre `<istanza>/app/#/desktop-login`
    (`apps/desktop/src/main/browserLogin.ts`): arriva al login grazie al
    redirect. Il prossimo build del Mac punta a `/#/desktop-login`, ma i
    vecchi restano installati per mesi.
- I percorsi del web vecchio restano rediretti come in R1: l'app è a hash,
  quindi `/tickets/x` (un percorso) e `/#/p/…` (un frammento) non si
  scontrano.
- **Ordine**: `server` (i link nuovi) e `caddy` INSIEME, nello stesso
  deploy. Con il caddy prima, `/` servirebbe già l'app ma i link resterebbero
  `/app/#/…` (funzionano, via redirect): innocuo. Con il server prima, i
  link `/#/…` cadrebbero sul `redir` di R1 a `/app/` col frammento: innocuo
  anche quello. Nessuna finestra rotta in nessuno dei due ordini.
- **Rollback**: le immagini di prima di `server` e `caddy`. I link `/#/…`
  scritti durante R2 cadono sul `redir` di R1 verso `/app/`, frammento
  compreso: sicuro.

### R3 — la pulizia del server, gruppo (e) (codice, nessuna migrazione)

Vedi §3. Le colonne e le tabelle restano: si smette solo di usarle.

- **Ordine**: `server` e `worker` (i DM Slack stanno nel worker), poi `caddy`
  se il renderer perde qualcosa (le frasi di Slack nelle impostazioni).
- **Rollback**: le immagini di prima. Nessun dato toccato: sicuro.

### R4 — le migrazioni (DOPO R3, quando è stabile)

- Via le colonne Slack (`users.slack_user_id`, `users.slack_avatar_url`, le
  preferenze DM), la tabella `saved_views`, e il token degli inviti in
  chiaro: `invites.token` diventa un hash, come i link di reset. La
  migrazione calcola l'hash dei token esistenti sul posto, così i link già
  spediti continuano a funzionare.
- Ogni `DROP` in uno statement a sé. Nessun `ALTER TYPE … ADD VALUE` (vedi
  la trappola delle migrazioni in batch in CLAUDE.md).
- **Backup del DB prima** (le colonne tolte non si riprendono).
- **Rollback**: dopo R4 NON si scende sotto R3, perché il codice di prima
  nomina colonne che non ci sono più. Si scende solo a R3, che non le usa.
  Per questo R4 aspetta che R3 sia stabile **[D 8]**.

## 2. La cancellazione di `apps/web`: cosa dipende da lui

| Cosa | Dove | Cosa si fa |
|---|---|---|
| Il pacchetto | `apps/web/` | si cancella; `pnpm-workspace.yaml` usa `apps/*`, niente da toccare |
| CI, E2E | `.github/workflows/ci.yml`, job `e2e` (Playwright di `apps/web/e2e`) | il job sparisce; la copertura end-to-end si perde **[D 3]** |
| Build dell'immagine | `Dockerfile.caddy` (stage `web-build`, `COPY … /srv/web`), `scripts/caddy-csp.mjs --web` e test | come in R1 |
| Changesets | `.changeset/config.json` (il pacchetto fra gli ignorati) | si toglie la voce |
| Il link del web | `openInWeb`, `webHref`, `legacyWebPath` nel renderer (14 chiamanti), `open:web` del main del Mac | si tolgono i rami che portano al web; `legacyWebPath` resta solo se serve ai rimandi |
| Token di design | `packages/shared/src/design-tokens.ts` dice che la fonte vera è Tailwind di `apps/web` (`styles.css`), allineata da `apps/web/src/theme-parity.test.ts` | la fonte diventa `design-tokens.ts` stesso (l'unico lettore è `apps/mobile`, da rifare); si aggiorna il docblock **[D 9]** |
| La guida utente | `apps/docs` (`/guide`): descrive le schermate del web vecchio (notifiche, webhook in ingresso, la landing) | va riscritta sulla nuova app **[D 6]**; `/guide` come percorso resta |
| Documentazione | `README.md`, `CONTRIBUTING.md`, `docs/invariants/*` (citano file di `apps/web`), commenti nel codice «come `apps/web/…`» | i riferimenti normativi si aggiornano nello stesso rilascio; i commenti storici si ripuliscono dopo, non bloccano |
| CLAUDE.md | 9 citazioni di `apps/web` (architettura, deploy, trappole del web) | **le aggiorna il maintainer** (non si tocca da una sessione) |
| `Dockerfile.agent` | un commento che cita `apps/web/.../server-admin.tsx` | commento da aggiornare |

## 3. La pulizia del server (gruppo (e))

Ciascuna voce è codice in R3 e dati in R4.

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

  R4: le colonne. L'app mobile ha una sezione Slack nelle impostazioni
  **[D 5]**.
- **`saved_views`**: la rotta `/api/saved-views` (e quindi le azioni MCP
  `savedViews.*`, che il catalogo deriva da sola). R4: la tabella.
- **`/api/projects/pulse`**: la nuova app usa `/api/projects/pulses`. La
  rotta vecchia la legge ancora l'**app mobile** (3 file) **[D 5]**.
- **Il token degli inviti in chiaro**: via `GET /api/auth/invites`
  (l'elenco col token). Restano `POST /api/auth/invites` (creare, lo usa
  People) e `GET /api/auth/invites/:token` (accettare). R4: il token come
  hash.
- **Le altre rotte del gruppo (e)**:
  - posta ammessa: `/api/settings/mail-admission`;
  - regole della posta del progetto: `/api/projects/:id/email-routes`,
    `email-labels`;
  - «Rigenera il brief»: `POST …/briefs/generate`;
  - adozione delle PR: `…/adoption`;
  - webhook unico delle notifiche: `/api/settings/notifications` e `…/test`.

  Si tolgono con R3, una per una, dopo aver controllato che nessun altro
  client le chiami (desktop, api-client, mobile, MCP).
- **Rotte che resterebbero usate solo dal web e dall'MCP**: con la parità MCP
  (26 nov) ogni rotta del server è anche un'azione MCP, quindi «solo web»
  non vuol dire «nessuno». Uno script una tantum confronta il registro delle
  rotte con i chiamanti (api-client, adattatori del desktop, mobile) e dà
  l'elenco: cosa farne lo decide il maintainer **[D 4]**.
- **`tickets.status` (l'enum)**: il registro lo mette «col ritiro, se
  nessuno lo legge più». **Lo leggono e lo scrivono ancora** la pipeline del
  worker (fix, triage, intake, classificazione), l'MCP (`set_ticket_status`
  e i comandi `/stubwise:run` e `/stubwise:start` del plugin), le notifiche
  e l'app mobile (`docs/invariants/tasks.md`: «colonna di compatibilità
  perché … la leggono e la scrivono»). Toglierlo è un lavoro a sé: portare
  quei lettori su `status_id` e sulle famiglie, poi la migrazione. **Non è
  nel taglio** **[D 2]**.

## 4. Riassunto dell'ordine

1. **Prerequisiti** (§0): la cassaforte su `/app` (79), #137, il punto 6,
   gli «Open in web» rimasti.
2. **R1**, il taglio: solo `caddy` più la cancellazione. Rollback:
   l'immagine di prima.
3. **R2**, `/app` alla radice ([D 1]): `server` e `caddy` insieme.
   Rollback: le immagini di prima.
4. **R3**, la pulizia del server: `server`, `worker`, `caddy`. Rollback:
   le immagini di prima.
5. **R4**, le migrazioni ([D 8]), con il backup. Rollback: solo fino a R3.

R2 e R3 sono indipendenti fra loro e si possono scambiare. R1 viene prima di
entrambi.

## Decisioni da prendere (per AskUserQuestion)

Le prime quattro sono quelle che cambiano il piano; le altre ne fissano i
dettagli.

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
- **[D 9] La fonte dei token di design.**
  - (a) **`packages/shared/src/design-tokens.ts` diventa la fonte** —
    *consigliata*.
  - (b) Prenderli dal Tailwind del renderer del desktop, con un test di
    parità nuovo.
