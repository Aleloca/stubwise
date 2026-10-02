---
stubwise:
  project: stubwise
  backlogItem: 756cf96c-0b02-48a1-8a8f-0a32aa79a880 # https://stubwise.thecove.it/backlog/756cf96c-0b02-48a1-8a8f-0a32aa79a880
---

# App: la pagina del ticket a tab — piano di implementazione

Data: 2 ott 2026. Design: `docs/plans/2026-10-02-app-ticket-tabs-design.md`.
Solo `apps/mobile`. **Server, web e `packages/*` non si toccano** (verificato
sotto, §1: tutto ciò che serve è già nella risposta del dettaglio ticket e
dell'inbox, o è una funzione già esportata da `@stubwise/shared`).

## 1. Verifica delle premesse del design

Ogni premessa è stata letta sul codice al commit `0e939d7a`. Le FALSE sono
marcate **FALSA**; quelle vere nel fatto ma con un dettaglio che cambia il
piano sono marcate **VERA, CON RISERVA**.

### a) Ordine delle sezioni di `WorkScreen` (§1) — VERA, CON RISERVA

`apps/mobile/src/screens/work/WorkScreen.tsx`, `WorkBody` righe 312-416:

```
314  <View style={styles.metaRow}> <StatusBadge …/> <Text>#{number}</Text>
326  {ticket.body.trim() === "" ? … : <SafeMarkdown>{ticket.body}</SafeMarkdown>}
334  {isWorking && <WorkingPill …/>}
340  {openQuestion !== undefined && <QuestionBlock …/>}
347  <PlanSection …/>
362  <RunWorkButton …/>
378  {hasPrToShow(...) && <PrCycleSection …/>}
385  <TicketFields …/>
389  <Timeline …/>
392  <CommentsSection …/>
395  <Text>{t("mobile.work.releaseNote")}</Text>
397  {isAdmin && <TechLevel …/>}
410  <DestructiveActions …/>
```

L'ordine è esattamente quello del design. Tre riserve che cambiano il piano:

1. **Il titolo non è nel corpo**: sta in `ScreenHeader` (riga 214,
   `titleNumberOfLines={3}`), che oggi è l'header ANCORATO dello `ScrollView`
   (`stickyHeaderIndices={[0]}`, riga 207). L'«intestazione fissa» del design
   è quindi `ScreenHeader` + `metaRow` + `WorkingPill` + barra delle tab.
2. **Il piano NON è un documento intero in pagina.** `PlanSection`
   (`components/work/PlanSection.tsx` righe 112-140) mostra il riassunto
   (`planSummary`) o le prime 4 righe del piano (`numberOfLines={4}`), più
   «Leggi il piano completo» che apre il testo intero in un `SheetModal`.
   Il documento intero in pagina è solo la DESCRIZIONE. E `PlanSection`
   contiene AZIONI: Approva/Rifiuta (`canDecide`, riga 187), pre-approva e
   revoca (admin). Vedi §3, punto 1, per la conseguenza.
3. Il nome del branch che il design §5 fa «sparire» dalla card **non c'è
   oggi** in `PrCycleSection` (header righe 115-135: nome repository + «Apri
   la PR →»). Sta già solo in `TechLevel` (riga 399, `branch`), solo admin.
   Nessuna perdita da gestire.

### b) `prCycleLineFor`, i suoi consumatori e il test di parità — VERA, CON RISERVA

Consumatori (`grep prCycleLineFor|prCycleText`):

- app: `apps/mobile/src/components/work/PrCycleSection.tsx:107` (riga) e
  `:139` (`prCycleText(line, t)`); definizione in
  `apps/mobile/src/lib/pr-cycle.ts:195` e `:246`;
- web: `apps/web/src/components/pr-cycle-row.tsx:97`, definizione in
  `apps/web/src/lib/pr-cycle-line.ts:158`.

Il test di parità sta in `apps/mobile/src/lib/pr-cycle.test.ts`, blocco
`describe("parità dei testi con il web")` (righe ~516-640). Importa i
cataloghi del web PER PERCORSO (`../../../web/src/i18n/locales/{it,en}.json`,
righe 4-5) e confronta **STRINGHE, chiave per chiave**:

- `LINE_KEYS` (26 chiavi): `app.mobile.work.pr.cycle[key] ===
  web.tickets.cycle[key]`;
- «l'app non ha chiavi della riga che il web non ha (salvo `unknown`)»:
  `Object.keys(app.mobile.work.pr.cycle)` ⊆ `web.tickets.cycle`;
- `ERROR_KEYS` e `PANEL_KEYS` (errori e testi del pannello);
- l'esaustivo «ogni chiave che `prCycleLineFor` può produrre esiste» con
  `i18n.exists`.

Il nodo per lo spezzare in pezzi: **molte frasi del web contengono già « · »
dentro UNA chiave** (`approved` = «Approvata dalla review · pronta per il
merge», `correctingRound` = «Giro {{round}} di {{max}} · correzione in
corso», `heldBudgetNeedsMaintainerRound` ha quattro pezzi). Il chip e il
dettaglio non sono quindi chiavi esistenti: sono PEZZI di chiavi esistenti, e
in `correctingRound`/`held*Round` il chip è il SECONDO pezzo, non il primo.
`stoppedAtCap_*` non ha « · » affatto.

Adattamento (Task 2): nuove chiavi SOLO dell'app sotto
`mobile.work.pr.card.*` (fuori da `mobile.work.pr.cycle`, così il test
«nessuna chiave in più» resta com'è), e una tabella nel test che per ogni
chiave di riga del web elenca i pezzi dell'app NELL'ORDINE del web e il
separatore; il test ricompone e confronta con il testo del web, in it ed en,
ignorando solo la maiuscola iniziale di ogni pezzo (il chip è maiuscolo per
`textTransform`, e «Correzione in corso» compare minuscolo dentro
`correctingRound`). **Il web non cambia**: il test legge i suoi JSON per
percorso e basta; nessun file in `apps/web` né in `packages/*` va toccato.

### c) La card inbox naviga a `Ticket` — **FALSA**

- Il tipo della rotta è locale all'app:
  `apps/mobile/src/app/navigation.tsx:153`
  `Ticket: { id: string; backLabel?: string };` (in `ProjectsStackParamList`).
  Aggiungere `tab?:` è un cambio solo dell'app. Il deep link
  `tickets/:id` (`app/linking.ts:151`) accetterebbe `?tab=…` come parametro
  di query senza modifiche.
- **Nessuna card dell'inbox naviga alla schermata `Ticket`.** Il bottone
  «Apri» delle card è `Linking.openURL(item.url)`
  (`components/inbox/FailedCard.tsx:44`, `PrReadyCard.tsx:52`,
  `QuestionCard.tsx:63`, `InfoCard.tsx:89`). `item.url` lo calcola il server
  (`openUrl`, `packages/notifications/src/actions.ts:364-392`): per
  `job.pr_opened`/`review.completed` è l'URL della PR sulla piattaforma, per
  gli altri kind di ticket è `ticketUrl` =
  `${publicUrl}/tickets/${id}` (`apps/server/src/ingest/shared.ts:37`),
  cioè **la pagina WEB**: tocca «Apri» e si apre il browser. `PlanReviewCard`
  non ha nemmeno «Apri».
- Le push non vanno al ticket: `deepLinkFor`
  (`packages/notifications/src/push/payload.ts:118`) manda
  `stubwise://inbox/<notificationId>` per ogni kind tranne le proposte
  Google. Quindi push → card in inbox (vero), card → ticket in app (falso).
- Però l'item porta già `ticketId: z.uuid().nullable()`
  (`packages/shared/src/schemas/notification.ts:672`): **aprire il ticket
  in app dalla card si può fare senza toccare il server**, è lavoro nuovo
  dell'app (Task 9).

Tutti gli altri punti che navigano a `Ticket` (nessuno passa `tab`, quindi
cadono su Stato com'è giusto):

| Punto | File:riga |
|---|---|
| hub progetto, tab Adesso (`destination.kind === "ticket"`) | `screens/projects/ProjectDetailScreen.tsx:141` |
| hub progetto, tab Lavoro | `screens/projects/hub/WorkTab.tsx:160` |
| elenco ticket del progetto | `screens/projects/ProjectTicketsScreen.tsx:83` |
| ricerca globale | `components/GlobalSearchSheet.tsx:184` |
| backlog → ticket convertito (`navigateToTicketWork`) | `lib/backlog-mutations.ts:475-480` |
| deep link `stubwise://tickets/:id` (sospeso al login) | `app/navigation.tsx:478` e `app/linking.ts:151` |

### d) I kind di notifica — **FALSA per i commenti**, vera per gli altri

`notificationKindSchema` (`packages/shared/src/schemas/notification.ts:30-46`):
`ticket.created`, `job.pr_opened`, `job.pr_closed`, `job.held`,
`job.plan_review`, `job.budget_held`, `review.completed`, `job.failed`,
`docs.limit_paused`, `monitor.alert`, `monitor.recovered`,
`job.awaiting_input`, `project.pulse`, `project.brief`, `google.proposal`.

- I cinque citati (`job.awaiting_input`, `job.plan_review`,
  `review.completed`, `job.pr_opened`, `job.failed`) esistono con quei nomi.
- **Non esiste nessun kind per i commenti.** «Le notifiche di commento →
  Attività» (§3) descrive una cosa che oggi non c'è: nessuna notifica porta
  ad Attività. Il valore `activity` del parametro resta utile (deep link,
  futuro), ma nessun kind lo produce.
- Tre kind legati al ticket che il design non nomina: `job.pr_closed`,
  `job.held`, `job.budget_held` (e `ticket.created`). Il piano li manda tutti
  a Stato.

### e) `canAnswer`, `canDecide` e i campi del ciclo — VERA, CON RISERVA

- `canAnswer` e `canDecide` **non arrivano dal server: l'app li DEDUCE dal
  ruolo** (`WorkScreen.tsx:302-305`):
  `canAnswer = isAdmin || requesterId === currentUserId` e
  `canDecide = isAdmin && latestJob.status === "awaiting_plan_approval"`,
  con `isAdmin` da `user.role` (riga 192). Il commento di riga 299 dice che
  l'autorità resta `actorAllows` lato server. «Solo dati che lo schermo ha
  già» è quindi vero (nessun campo nuovo), ma per questi due l'indicatore
  eredita una deduzione locale, non un permesso calcolato dal server. È la
  situazione di oggi e il piano non la cambia; va solo saputo.
- Il ciclo invece è tutto del server (`prCycleSchema`,
  `packages/shared/src/schemas/pr-correction.ts:22-95`):
  `state` ∈ `reviewing | correcting | approved | changes_requested |
  stopped_at_cap | correction_failed | idle`; `canRequestCorrection`
  (obbligatorio), `heldReason` (`.default(null)`), `canResume`
  (`.default(false)`), `heldJobId` (`.default(null)`),
  `lastRequest: { via, platform, name, at } | null` — `lastRequest.at` è una
  stringa ISO (riga 67), quindi c'è.
- «La review chiede modifiche e il ciclo automatico è spento»: il valore è
  `state === "changes_requested"`, che però copre DUE casi (commento righe
  28-31: «tetto a 0, **o in attesa di una richiesta umana**»). Non esiste un
  valore che dica «ciclo spento» da solo, e non serve: in entrambi i casi
  tocca a una persona.
- «In pausa per budget» è `state === "correcting" && heldReason ===
  "budget"`: `heldReason` non è uno stato, è un campo accanto. **Il design
  dimentica `heldReason === "other"`** (gate dell'automazione, tetto per
  ticket), che oggi ha tono `signal` («vuole qualcuno», `toneFor`,
  `lib/pr-cycle.ts:176-185`) ed è riprendibile con `canResume`. E per
  `heldReason === "limit"` `canResume` può essere vero (`canResumeCorrection`
  esclude solo il budget per un member) ma la correzione riparte da sola: lì
  il pallino NON va. Regola del piano: pallino se `canResume && heldJobId !==
  null && heldReason !== "limit"`.
- **Le tinte del §5.2 non sono «il tono di oggi».** Oggi (`TONE_BY_STATE`,
  `lib/pr-cycle.ts:51-59`): `reviewing`/`correcting` = `sky` (azzurro, non
  giallo), `approved` = `ok`, `changes_requested` e **`stopped_at_cap` =
  `signal`** (ambra, non rosso), `correction_failed` = `danger`, `idle` =
  `faint`; ferma per budget/altro = `signal`, per limite = `sky`. Il piano
  tiene i toni di oggi (sono gemelli del web).

### f) Il numero di «Attività · N» — VERA

`commentsQuery` (`WorkScreen.tsx:126-134`) chiama `client.tickets.comments(id)`
→ `Reader<TicketComment>[]`, con `authorType ∈ user|ai|system`
(`packages/shared/src/schemas/ticket.ts:319-326`). `CommentsSection` li
mostra tutti (`components/work/CommentsSection.tsx:67`), quindi N =
`comments.length`. È una lettura ACCESSORIA (fuori dai gate, riga 173): se
fallisce o non ha risposto, `comments` è `undefined` → l'etichetta resta
«Attività» senza numero (mai «· 0» inventato).

### g) Componente tab riusabile — VERA (esiste, RN puro)

- Nessuna libreria di tab di contenuto in `apps/mobile/package.json`: niente
  `@react-navigation/material-top-tabs`, `react-native-pager-view`,
  `react-native-tab-view`. Solo `@react-navigation/native`,
  `native-stack` e `@bottom-tabs/react-navigation` (la barra in basso).
- **Esiste già `HubTabBar`** (`components/projects/HubTabBar.tsx`), in RN
  puro (`Pressable`/`View`), usata dalle tre tab del dettaglio progetto
  (`ProjectDetailScreen.tsx:162-180`): `accessibilityRole="tablist"`/`"tab"`,
  `accessibilityState.selected`, un `badge` numerico ambra e un `alert`
  (pallino ROSSO, «qualcosa di rotto»). testID fissi `hub-tab-<key>`.
- Da estendere in modo additivo (Task 3): un `dot` ambra («serve un'azione
  tua», diverso dal rosso «rotto») e un prefisso di testID; il numero di
  Attività va nell'etichetta come testo.
- Nessuna dipendenza nativa nuova: tab in RN puro, quattro `ScrollView`
  montate e nascoste con `display: "none"` per conservare lo scroll. ⚠️
  `@testing-library/react-native` 14 ESCLUDE gli elementi nascosti dalle query
  per default (i test di Wisey passano `includeHiddenElements: true` apposta,
  `screens/wisey/WiseyScreen.test.tsx:19`): i test esistenti che cercano
  commenti, campi, piano, livello tecnico o cancellazioni devono prima
  premere la tab giusta.
- ⚠️ Larghezza: `HubTabBar` divide la riga in parti uguali (`flex: 1`), con
  etichette mono maiuscole 12 pt e `letterSpacing: 1`. Con quattro tab su un
  telefono da 375 pt ogni tab ha ~80 pt: «CONTENUTO» ci sta a filo,
  «ATTIVITÀ · 12» no. Il piano tiene il numero in un contatore compatto
  neutro accanto all'etichetta (stessa forma del `badge`, colore `faint`) e
  verifica su device; vedi §3, punto 4.

### h) Un helper per il tempo relativo — **FALSA nel riferimento**, vera nel criterio

`apps/mobile/src/lib/stalled.ts` ha solo `stalledDays` (giorni interi) e
`stalledReasonKey`: nessun tempo relativo «2 h fa». Il criterio (il server
manda la data, il conto lo fa il telefono al render) è quello giusto, ma
l'helper da riusare è **`relativeTimeCompact`** (`lib/format.ts:20`, →
`now | minutes | hours | days` + `count`) con le chiavi `mobile.work.time.*`
e `mobile.work.plan.timeAgo` («{{time}} fa»), lo stesso abbinamento di
`approvedTimeText` in `components/work/PlanSection.tsx:22-27`. Il Task 1 lo
estrae in `lib/format.ts` per non copiarlo una seconda volta.

## 2. Altri fatti verificati che il piano usa

- **Il numero della PR non è nella risposta** (`ticketRepositorySchema`,
  `packages/shared/src/schemas/ticket.ts:67-88`: `prUrl`, `prState`, `cycle`,
  niente `prNumber`). C'è `prNumberFromUrl(url): number | null` già
  esportata da `@stubwise/shared` (`packages/shared/src/pr-number.ts:16`,
  `index.ts:42`), la stessa regola di `derivePrCycle`. Il titolo della card
  usa quella; con `null` dice solo «PR», mai un numero inventato.
- `prState` ∈ `open | merged | closed_unmerged`
  (`packages/shared/src/schemas/ticket.ts:56`): l'etichetta «mergiata» /
  «chiusa» accanto al titolo è per i due valori diversi da `open`.
- Il doppio del client dei test (`makeClient`, `WorkScreen.test.tsx:122-168`)
  elenca già `tickets.get/jobs/questions/activity/comments/…`,
  `projects.reviews/milestones`, `users.list`. La fixture `ticket()` è un
  cast (`as Reader<TicketDetail>`, riga 59): campi come `planSummary`,
  `planApprovedAt` possono mancare senza che il compilatore lo dica.

## 3. Decisioni (confermate dal maintainer il 2 ott 2026)

Dove il design e il codice non tornavano, il piano ha scelto così e il
maintainer ha confermato; il design è stato corretto di conseguenza (§1, §2,
§3, §4, §5). Ogni scelta è nel task che la implementa.

1. **`PlanSection` resta in STATO; il piano INTERO va in CONTENUTO.** Il
   design mette il piano in Contenuto ma accende il pallino di Stato per «un
   piano da approvare»: con Approva/Rifiuta dentro `PlanSection`, il pallino
   indicherebbe una tab dove l'azione non c'è. `PlanSection` è già compatta
   (riassunto o 4 righe + modale). Quindi: Stato = domanda → `PlanSection`
   → run → PR → nota rilascio; Contenuto = descrizione → piano completo in
   `SafeMarkdown` (o «nessun piano»). Il «Leggi il piano completo» di
   `PlanSection` porta alla tab Contenuto invece di aprire la modale
   (`onReadFull` facoltativa; senza, resta la modale — `PlanSection` è usata
   solo qui, ma il default protegge da un riuso).
2. **Riga «chi ha chiesto» con i testi del web** (tempo relativo con
   `relativeTimeCompact`, attraverso `relativeTimeAgo` del Task 1): «Modifiche richieste da
   {{name}} su Bitbucket · 2 h fa», non «ultima richiesta: …» del design §5.4.
   Il testo esiste già, gemello del web e coperto dal test di parità; una
   frase nuova sarebbe una terza formulazione della stessa cosa. Si mostra
   ogni volta che `lastRequest !== null`; con `pendingRequest` le si accoda
   «in coda · parte quando finisce il lavoro in corso sul ticket».
3. **Pallino di Stato per le PR solo se un'azione è DAVVERO offerta**:
   `stopped_at_cap`, `correction_failed` o `changes_requested` con
   «Chiedi modifiche» offerto (PR aperta e `canRequestCorrection`), oppure una
   correzione ferma con «Riprendi» offerto e `heldReason !== "limit"`
   (`other` incluso). `canAnswer`/`canDecide` dalla deduzione dal ruolo già
   presente in `WorkScreen`. Colori dei chip: i toni di oggi. Un
   pallino su una tab dove i bottoni sono spenti (job in volo) chiede
   un'azione che non si può fare.
4. **Il numero di Attività è un contatore neutro accanto all'etichetta**, non
   « · N» nel testo: quattro etichette mono maiuscole non stanno in 375 pt
   (§1 g). Se sul telefono «ATTIVITÀ · 4» ci sta, si torna alla forma del
   design cambiando solo il rendering.
5. **Notifiche → tab**: in OGNI card che riguarda un ticket
   (`ticket.created`, `job.pr_closed`, `job.held`, `job.plan_review`,
   `job.budget_held`, `job.failed`, `job.awaiting_input`, e anche le card PR
   `job.pr_opened` e `review.completed`) «Apri» porta alla schermata `Ticket`
   dell'app con `ticketTabForKind(kind)` (oggi sempre `"status"`) quando
   `item.ticketId !== null`; senza `ticketId` resta `Linking.openURL` di
   oggi. Le card PR NON guadagnano un secondo bottone: la PR si apre dal
   titolo della sua card nella tab Stato. `PlanReviewCard` guadagna «Apri»
   quando ha un `ticketId`. Le card che non riguardano un ticket (posta,
   pulse, monitor, brief…) restano invariate. Nessuna notifica porta ad
   Attività.

## 4. Regole per ogni task

- Si lavora SOLO in `/Users/aleloca/git/stubwise/.worktrees/app-ticket-tabs`,
  branch `feat/app-ticket-tabs`. Prima di ogni task: `git rev-parse
  --show-toplevel` e `git branch --show-current`.
- TDD: il test si scrive PRIMA e si vede FALLIRE per il motivo giusto; poi il
  codice; poi la mutazione indicata, che deve far tornare rosso il test (e
  girare, non esplodere: CLAUDE.md, mutation testing punto b), poi si
  ripristina.
- Le tre trappole dell'app (CLAUDE.md, «Invarianti e trappole»):
  1. **fixture complete**: ogni fixture tipata ha tutti i campi dello schema
     (un ciclo con `heldReason`/`canResume`/`heldJobId`; un ticket con
     `planSummary`, `planApprovedAt`, `planApprovedBy`, `planApprovalStale`);
     dove un campo manca APPOSTA (server vecchio) lo si dice nel test e si
     passa da `readerSchema(…).parse`;
  2. **metodi nel doppio prima del test**: se una schermata guadagna una
     chiamata, si aggiunge a `makeClient()` prima; un test verde al primo
     colpo su una lettura nuova si fa fallire apposta togliendo il
     `mockResolvedValue`;
  3. **`await render(...)`** sempre, e `jest.mock` di
     `@react-navigation/native` con lo spread di `requireActual`.
- Ogni task si chiude con `pnpm --filter @stubwise/mobile test -- <file>`,
  `pnpm --filter @stubwise/mobile typecheck` e un commit suo.
- Setup una tantum del worktree: `pnpm install` e `pnpm --filter
  @stubwise/mobile... build` (con i tre puntini: costruisce `shared` e
  `api-client`, i cui `dist/` l'app legge).

## 5. Task

### Task 1 — `relativeTimeAgo`: il tempo relativo in parole, una volta sola

- **File**: `apps/mobile/src/lib/format.ts`, `lib/format.test.ts`,
  `components/work/PlanSection.tsx`.
- **Cosa**: estrarre `approvedTimeText` di `PlanSection` (righe 22-27) in
  `relativeTimeAgo(iso, t, now?)` dentro `lib/format.ts`, e usarla in
  `PlanSection` (stesso testo di oggi).
- **Test prima**: in `format.test.ts` — «adesso» sotto il minuto, «12 min
  fa», «2 h fa», «1 g fa», una data nel futuro → «adesso», una data
  illeggibile non lancia. I test esistenti di `PlanSection` («approvato da …
  · 1 h fa») restano verdi senza modifiche.
- **Mutazione**: in `relativeTimeAgo` togliere il ramo `now` (passare sempre
  da `mobile.work.time.*`) → il caso «adesso» deve fallire.
- **Done**: nuovi test verdi, `PlanSection.test.tsx` invariato e verde.

### Task 2 — `prCycleCardFor`: la riga del ciclo spezzata in pezzi, e la parità sui pezzi

- **File**: `apps/mobile/src/lib/pr-cycle.ts`, `lib/pr-cycle.test.ts`,
  `src/i18n/it.json`, `src/i18n/en.json`.
- **Cosa**: una funzione pura nuova accanto a `prCycleLineFor`:

  ```ts
  export interface PrCycleCard {
    tone: PrCycleTone;              // = toneFor(cycle), invariato
    chip: PrCycleSegment;           // lo stato, il pezzo che si legge per primo
    details: PrCycleSegment[];      // «pronta per il merge», «Giro 2 di 3», «budget esaurito», …
    request: PrCycleSegment | null; // requester(lastRequest), riusato tale e quale
    requestAt: string | null;       // lastRequest.at, ISO: il tempo lo calcola il render
    queued: boolean;                // pendingRequest && lastRequest !== null
  }
  export function prCycleCardFor(cycle: Cycle): PrCycleCard
  ```

  Chiavi nuove SOLO sotto `mobile.work.pr.card.*` (mai sotto
  `mobile.work.pr.cycle`, che il test «nessuna chiave in più» presidia):
  `chip.approved` («Approvata dalla review»), `chip.correctionHeld`
  («Correzione ferma»), `chip.stoppedAtCap` («Ciclo fermo»),
  `detail.readyToMerge`, `detail.round` («Giro {{round}} di {{max}}»),
  `detail.budget`, `detail.askMaintainer`, `detail.limit`,
  `detail.stoppedAtCap_one/_other` («dopo {{count}} correzione/i
  automatica/he»). Gli stati di una frase sola (`reviewing`, `correcting`,
  `changesRequested`, `correctionFailed`, `idle`, `unknown`) usano come chip
  la chiave `mobile.work.pr.cycle.*` di oggi. `queued` riusa
  `mobile.work.pr.cycle.queued`. Tutte le regole di `prCycleLineFor` restano
  (giro 0 vs giro N, `heldReason ?? null`, `canResume ?? false`, stato
  grezzo sconosciuto → `unknown`, ruolo mai in input). L'unica differenza
  voluta: `request` c'è ogni volta che c'è `lastRequest` (decisione §3.2).
- **Test prima** (`pr-cycle.test.ts`, nuovo `describe("prCycleCardFor")`):
  - un caso per ogni stato noto, più `correcting` con `heldReason` `budget`
    (con e senza `canResume`), `limit`, `other`, e con `round` 0 e 2;
  - `pendingRequest` con `lastRequest` di un'altra persona: `request` è
    quella in attesa e `queued` è vero, il chip resta lo stato corrente;
  - una fixture con SOLO i campi nuovi del ciclo popolati (`heldReason`,
    `canResume`, `heldJobId`) e una da server vecchio (`oldServerCycle`,
    senza quei campi, parsata con `readerSchema`);
  - stato grezzo sconosciuto (`rawUnknownStateCycle`) → chip `unknown`, non
    lancia;
  - esaustivo: ogni chiave che `prCycleCardFor` può produrre esiste in it ed
    en (stessa griglia del test esistente di riga ~611).
- **Parità adattata** (stesso file, `describe("parità dei testi con il
  web")`): una tabella `CARD_PIECES` che per ogni chiave di riga del web dice
  quali pezzi dell'app, in quale ORDINE, la ricompongono, e con quale
  separatore:

  ```ts
  const CARD_PIECES = [
    ["approved",            [["card.chip.approved"], ["card.detail.readyToMerge"]], " · "],
    ["correctingRound",     [["card.detail.round"], ["cycle.correcting"]],          " · "],
    ["heldBudgetNeedsMaintainerRound",
      [["card.detail.round"], ["card.chip.correctionHeld"], ["card.detail.budget"], ["card.detail.askMaintainer"]], " · "],
    ["stoppedAtCap_other",  [["card.chip.stoppedAtCap"], ["card.detail.stoppedAtCap_other"]], " "],
    // … una riga per OGNI chiave di LINE_KEYS che il chip/dettaglio usa
  ];
  ```

  Il test, in it ed en: interpola i segnaposto con valori fissi, unisce i
  pezzi col separatore e confronta con il testo del web, ignorando la sola
  maiuscola iniziale di ciascun pezzo. Un secondo test verifica che ogni
  chiave `card.*` compaia in almeno una riga della tabella (nessun pezzo
  orfano, cioè nessun testo dell'app senza gemello sul web). I test di parità
  esistenti restano tutti: `LINE_KEYS` copre ancora le chiavi `cycle.*`
  (`requested*`, `queued`, `needsMaintainer` restano in uso), e il commento
  «se fallisce su main si allineano le copie» vale anche per la tabella.
- **Mutazioni** (una alla volta, ciascuna deve far fallire almeno un test):
  1. cambiare `card.detail.readyToMerge` in it.json in «pronta al merge» →
     la parità ricomposta di `approved` deve fallire;
  2. in `prCycleCardFor`, con `pendingRequest` prendere il chip da
     `requester` → il test dell'attribuzione deve fallire;
  3. togliere il ramo `heldReason === "limit"` → il caso `limit` deve
     fallire.
- **Done**: `pr-cycle.test.ts` verde in tutte le sue parti, nessun file fuori
  da `apps/mobile` modificato (`git diff --stat` lo mostra).

### Task 3 — `HubTabBar`: pallino d'azione, contatore e testID configurabili

- **File**: `apps/mobile/src/components/projects/HubTabBar.tsx`, nuovo
  `HubTabBar.test.tsx` accanto.
- **Cosa** (additivo, il dettaglio progetto non cambia): prop facoltative su
  `HubTab` — `dot?: boolean` + `dotLabel?: string` (pallino AMBRA, `signal`,
  «serve una tua azione»; il rosso `alert` resta «rotto»), `count?: number`
  (contatore neutro `faint`, non compare se assente; a 0 compare «0» solo se
  il chiamante lo passa) — e sul componente `testIDPrefix?: string`
  (default `"hub-tab"`, così `navigation.test.tsx:672-690` resta valido).
  Etichetta con `numberOfLines={1}`.
- **Test prima**: rende quattro tab, premere una chiama `onSelect` con la sua
  chiave, `accessibilityState.selected` sulla attiva; `dot` compare solo con
  `true` e ha `accessibilityLabel`; `count` compare col numero; senza
  `testIDPrefix` i testID sono `hub-tab-<key>`, con `"work-tab"` sono
  `work-tab-<key>`.
- **Mutazione**: rendere il pallino con `dot !== undefined` invece di
  `dot === true` → il caso `dot: false` deve fallire.
- **Done**: test verdi; `ProjectDetailScreen` e `navigation.test.tsx`
  invariati e verdi.

### Task 4 — `ticketTabAttention`: quando Stato chiede un'azione

- **File**: nuovo `apps/mobile/src/lib/ticket-tabs.ts` e
  `lib/ticket-tabs.test.ts`.
- **Cosa**: funzioni pure, nessun React:

  ```ts
  export type TicketTab = "status" | "content" | "activity" | "details";
  export function parseTicketTab(value: unknown): TicketTab;      // ignoto/assente → "status"
  export function statusNeedsViewer(input: {
    hasOpenQuestion: boolean; canAnswer: boolean; canDecide: boolean;
    repositories: readonly Reader<TicketRepository>[];
  }): boolean;
  export function ticketTabForKind(kind: string): TicketTab;        // per il Task 9
  ```

  `statusNeedsViewer` è vero se (a) domanda aperta e `canAnswer`, (b)
  `canDecide`, (c) almeno una PR con un'azione OFFERTA secondo §3.3: PR
  aperta (`prState === "open"`) con `cycle.canRequestCorrection` e stato in
  `stopped_at_cap | correction_failed | changes_requested`; oppure
  `canResume ?? false` e `heldJobId ?? null` non nullo e `heldReason !==
  "limit"`. `cycle: null` → nessun contributo. Le azioni offerte si leggono
  da UNA funzione: si esporta `actionsOf` da `PrCycleSection.tsx` (oggi
  privata, righe 223-231) in `lib/pr-cycle.ts` e la usano entrambi, così
  pallino e bottoni non possono divergere.
  `ticketTabForKind`: tutti i kind di ticket → `"status"`; nessun kind dà
  `"activity"` oggi (§1 d, confermato: nessuna notifica porta ad Attività),
  e un test lo dice.
- **Test prima** (`ticket-tabs.test.ts`):
  - `parseTicketTab`: ciascuno dei quattro valori, `undefined`, `"foo"`,
    `42` → `"status"` per gli ultimi tre;
  - `statusNeedsViewer` vero nei casi del design: domanda + `canAnswer`;
    `canDecide`; `stopped_at_cap`; `correction_failed`; `changes_requested`;
    ferma per `budget` con `canResume` e `heldJobId`; ferma per `other`;
  - falso: niente di tutto ciò; domanda SENZA `canAnswer`; ferma per `limit`
    con `canResume`; `canResume` senza `heldJobId`; `stopped_at_cap` con
    `canRequestCorrection: false`; `stopped_at_cap` su PR `merged`;
    `approved`; `cycle: null`; ciclo da server vecchio (parsato, senza i
    campi nuovi);
  - `ticketTabForKind` per i cinque kind del design e per `job.held`,
    `job.budget_held`, `job.pr_closed`, `ticket.created` → `"status"`; un
    kind sconosciuto → `"status"`.
- **Mutazioni**: togliere `&& heldReason !== "limit"` → il caso `limit`
  fallisce; togliere `canAnswer` dalla condizione (a) → il caso «domanda
  senza permesso» fallisce.
- **Done**: test verdi; `PrCycleSection.test.tsx` verde dopo lo spostamento
  di `actionsOf`.

### Task 5 — `PrCycleCard`: una card per PR

- **File**: `apps/mobile/src/components/work/PrCycleSection.tsx` (si
  riscrive il corpo della riga), `PrCycleSection.test.tsx`, it/en.json
  (etichette «mergiata», «chiusa», «PR #{{number}}», «PR»).
- **Cosa**: per ogni PR una card (`colors.ink900`, bordo `line`, raggio
  `card`):
  1. titolo toccabile «<repository> · PR #N ↗» (`prNumberFromUrl` da
     `@stubwise/shared`; `null` → «<repository> · PR ↗»), che apre
     `repo.prUrl` solo se `isSafeWebUrl` (oggi `pr-cycle-open-*`; il testID
     resta); etichetta «mergiata»/«chiusa» se `prState` non è `open` (o è
     `UNKNOWN`: nessuna etichetta);
  2. chip maiuscolo col tono di `prCycleCardFor` (`textTransform:
     "uppercase"`, colore `colors[tone]`), testID `pr-cycle-chip-<repo>`;
  3. dettagli in grigio uniti da « · », solo se ce ne sono,
     `pr-cycle-detail-<repo>`;
  4. riga della richiesta in grigio: `t(request)` + « · » +
     `relativeTimeAgo(requestAt)`, e con `queued` la chiave `cycle.queued`,
     `pr-cycle-request-<repo>`;
  5. bottone a tutta larghezza «Chiedi modifiche» / «Riprendi la
     correzione» con le condizioni di OGGI (`actionsOf`, `disabled` come
     righe 146-160), testID invariati.
  Sparisce l'eyebrow «Pull request» (`mobile.work.pr.title`: la chiave
  resta se usata altrove, altrimenti si toglie — verificare con grep). Non
  cambiano: le due mutazioni condivise, `CorrectionSheet`, l'errore di
  ripresa sotto la card che l'ha prodotto, la riga offline, il `key` sul
  `ticketId`. `cycle: null` → card con solo titolo (e etichetta), niente
  chip né bottoni, come oggi.
- **Test prima** (`PrCycleSection.test.tsx`; i test di oggi che leggono
  `pr-cycle-line-*` come frase intera si riscrivono sui pezzi, gli altri
  restano):
  - una card per ogni stato del ciclo: chip con il testo atteso e il colore
    del tono; dettaglio presente solo dove serve (`approved` → «pronta per il
    merge»; `reviewing` → nessun `pr-cycle-detail-*`);
  - titolo con «PR #10» per l'URL Bitbucket `…/pull-requests/10` e «PR #4»
    per GitHub `…/pull/4`; URL non riconosciuto → «PR» senza numero;
    `javascript:` → nessun link;
  - etichetta su `merged` e `closed_unmerged`, assente su `open`;
  - richiesta con tempo relativo: `jest.useFakeTimers().setSystemTime(...)`
    e `lastRequest.at` due ore prima → «… · 2 h fa»; con `pendingRequest`
    compare anche «in coda · …»;
  - fixture con SOLO i campi nuovi del ciclo e una da server vecchio
    (`cycle: null`, e un ciclo senza `heldReason/canResume/heldJobId` passato
    da `readerSchema`);
  - bottoni: le condizioni di oggi coperte dai test esistenti, che devono
    restare verdi (in particolare «Riprendi» solo con `canResume` +
    `heldJobId`).
- **Mutazione**: nel titolo usare `repo.repositorySlug` al posto di
  `prNumberFromUrl(...)` → il test «PR #10» fallisce; mostrare il dettaglio
  anche quando `details` è vuoto (un `View` vuoto con testID) → il caso
  `reviewing` fallisce.
- **Done**: `PrCycleSection.test.tsx` e `CorrectionSheet.test.tsx` verdi.

### Task 6 — `WorkScreen`: intestazione fissa e quattro tab

- **File**: `apps/mobile/src/screens/work/WorkScreen.tsx`,
  `WorkScreen.test.tsx`, `components/work/PlanSection.tsx` (prop
  `onReadFull?`), it/en.json (`mobile.work.tabs.{status,content,activity,
  details}`, `mobile.work.tabs.needsYou`, `mobile.work.planFull.empty`).
- **Cosa**:
  - struttura: `View` (flex 1) → intestazione FUORI da ogni `ScrollView`
    (`ScreenHeader` come oggi, `metaRow`, `WorkingPill` quando `isWorking`,
    `HubTabBar` con `testIDPrefix="work-tab"`) → sotto, il corpo. Skeleton,
    «non trovato» ed errore restano dov'erano rispetto all'intestazione
    (sopra le tab: con un errore le tab NON si mostrano, design §6);
  - quattro `ScrollView`, una per tab, montate insieme; la non attiva ha
    `style={{ display: "none" }}`. Ognuna ha `refreshControl` (lo stesso
    `usePullToRefresh`) e il `paddingBottom` di oggi; solo Attività (che ha
    il campo del commento) e Dettagli (campi modificabili) hanno
    `KEYBOARD_AWARE_SCROLL_PROPS`. testID `work-panel-<tab>`; il testID
    `keyboard-aware-scroll` passa alla `ScrollView` di Attività;
  - contenuto: **Stato** = `QuestionBlock` → `PlanSection` (con
    `onReadFull={() => setTab("content")}`) → `RunWorkButton` →
    `PrCycleSection` → nota sul rilascio; **Contenuto** = descrizione
    (`SafeMarkdown` / «nessuna descrizione») → piano completo
    (`SafeMarkdown` di `ticket.implementationPlan`, testID
    `work-plan-full`, o il testo `mobile.work.planFull.empty`);
    **Attività** = `CommentsSection` → `Timeline`; **Dettagli** =
    `TicketFields` → `TechLevel` (admin) → `DestructiveActions`;
  - indicatori: `dot` su Stato = `statusNeedsViewer(...)` (Task 4) con
    `dotLabel` `mobile.work.tabs.needsYou`; `count` su Attività =
    `comments?.length` (assente se `undefined`);
  - stato della tab: `useState<TicketTab>(parseTicketTab(route.params.tab))`
    — il parametro arriva al Task 7; qui si legge già con `parseTicketTab`
    da un `route.params` ancora senza `tab`, quindi vale sempre `"status"`;
  - lo stato della tab e lo scroll sono DEL TICKET: il blocco tab+corpo è
    keyato su `id` (memoria «Stato stantio senza key React»: la schermata
    può ricevere un altro `id` senza smontarsi).
  - `canAnswer`, `canDecide`, `isHeldCorrectionJob` e la regola del rilancio
    generico non cambiano (si calcolano come oggi, una volta, e si passano
    giù).
- **Test prima** (`WorkScreen.test.tsx`):
  - si apre su Stato: `work-tab-status` selezionata, `work-panel-status`
    visibile, `work-panel-content` NON trovabile con le query di default
    (nascosta);
  - premere `work-tab-activity` mostra i commenti, poi tornare su Stato e di
    nuovo su Attività: la `ScrollView` di Attività è lo STESSO nodo (non
    rimontata: si confronta l'istanza, o si fa `fireEvent.scroll` con un
    `contentOffset` e si verifica che dopo il giro di tab l'`onScroll`/la
    prop `contentOffset` letta dal nodo sia quella — il test deve fallire se
    la tab viene renderizzata con `{tab === "activity" && …}`);
  - pallino su Stato presente nei quattro casi (domanda + richiedente; piano
    in `awaiting_plan_approval` per admin; PR `stopped_at_cap`; correzione
    ferma per budget con `canResume` + `heldJobId`; `changes_requested`) e
    ASSENTE: ticket senza niente da fare, domanda vista da un member che non
    l'ha chiesta, piano in approvazione visto da un member;
  - «Attività» con `count` 3 quando i commenti sono 3; senza numero quando
    `comments` fallisce (il resto della schermata intero);
  - i test esistenti che cercano elementi di altre tab si aggiornano
    premendo prima la tab (`within(screen.getByTestId("work-panel-…"))`):
    commenti, campi, etichette, cancellazioni, livello tecnico, tastiera;
    domanda, piano, run, PR restano su Stato senza modifiche. Nessun test si
    cancella; se uno non trova più il suo elemento, si sposta il test, non
    `includeHiddenElements`;
  - «Leggi il piano completo» porta su Contenuto e `work-plan-full` mostra
    il piano; senza `onReadFull` `PlanSection` apre ancora la modale
    (`PlanSection.test.tsx` invariato).
  - Prima di tutto: `ticket()` della fixture completata con i campi del
    piano (`planSummary: null`, `planApprovedAt: null`, `planApprovedBy:
    null`, `planApprovalStale: false`) e `makeClient()` controllato contro le
    chiamate della schermata (nessuna nuova in questo task).
- **Mutazioni**: (1) rendere le tab con `{tab === "x" && <ScrollView …>}`
  invece di `display: "none"` → il test dello scroll conservato fallisce; (2)
  passare `dot={true}` fisso → il caso «niente da fare» fallisce; (3)
  togliere il `key` su `id` → un test che cambia `route.params.id` con
  `rerender` (Attività → altro ticket) deve trovare di nuovo Stato.
- **Done**: `WorkScreen.test.tsx` verde, nessun test cancellato (conteggio
  `it(`/`test(` ≥ quello di prima, scritto nel messaggio di commit).

### Task 7 — Il parametro `tab` sulla rotta

- **File**: `apps/mobile/src/app/navigation.tsx` (riga 153),
  `screens/work/WorkScreen.tsx`, `WorkScreen.test.tsx`,
  `lib/backlog-mutations.ts` (`navigateToTicketWork`, parametro `tab?`
  facoltativo), `app/navigation.test.tsx` se serve.
- **Cosa**: `Ticket: { id: string; backLabel?: string; tab?: TicketTab }`.
  `WorkScreen` parte da `parseTicketTab(route.params.tab)` e, se il
  parametro CAMBIA con la schermata montata (stesso `id`, navigazione da una
  card a un ticket già aperto), passa a quella tab con un `useEffect` su
  `route.params.tab` — non ogni render, così una scelta manuale resta finché
  il parametro non cambia di nuovo. Nessun chiamante esistente passa `tab`:
  lista, ricerca, hub, backlog e deep link aprono Stato.
- **Test prima**: `renderScreen` accetta `tab`; un test per ognuno dei
  quattro valori (la tab giusta selezionata e visibile), uno con `tab`
  assente, uno con `"foo"` (→ Stato); uno con `rerender` che cambia
  `route.params.tab` da `"status"` a `"activity"` sulla stessa schermata.
- **Mutazione**: sostituire `parseTicketTab` con un cast `route.params.tab ??
  "status"` → il caso `"foo"` fallisce (nessuna tab selezionata); togliere
  l'effetto → il caso `rerender` fallisce.
- **Done**: test verdi, `typecheck` verde (il tipo della rotta è usato da
  `ProjectDetailScreen`, `WorkTab`, `ProjectTicketsScreen`,
  `GlobalSearchSheet`).

### Task 8 — Deep link con la tab (facoltativo, piccolo)

- **File**: `apps/mobile/src/app/linking.ts`, `linking.test.ts`(se esiste) o
  `navigation.test.tsx`.
- **Cosa**: `stubwise://tickets/<id>?tab=activity` arriva già come parametro
  dal parser di react-navigation (`Ticket: "tickets/:id"`); il caso «link in
  sospeso al login» passa da `resolveDeepLinkTarget`, che oggi butta la
  query. Estendere `DeepLinkTarget` di `tickets` con `tab?` letto con
  `parseTicketTab` e passarlo in `navigation.tsx:478`.
- **Test prima**: `resolveDeepLinkTarget("stubwise://tickets/abc?tab=activity")`
  → `{ area: "tickets", id: "abc", tab: "activity" }`; senza query → nessun
  `tab`; `?tab=foo` → `tab: "status"` o assente (scegliere e fissarlo).
  Nessun mittente produce oggi questi link: è solo per non perdere il
  parametro quando ci sarà.
- **Mutazione**: lasciare la query nell'`id` (`abc?tab=activity`) → il primo
  test fallisce.
- **Done**: test verdi. Si può saltare senza effetti sugli altri task.

### Task 9 — Dalla card d'inbox al ticket nell'app (decisione §3.5, confermata)

- **File**: `apps/mobile/src/components/inbox/{InfoCard,FailedCard,
  QuestionCard,PrReadyCard,PlanReviewCard}.tsx`, nuovo hook
  `lib/open-ticket.ts` (`useOpenTicket()` → `(ticketId, tab) => void`,
  `navigate("Main", { screen: "Projects", params: { screen: "Ticket",
  params: { id, tab } } })`, stessa forma di `GlobalSearchSheet.tsx:182`),
  test delle card (`InboxCard.test.tsx`), it/en.json
  (`mobile.inbox.openTicket`).
- **Cosa**: per ogni kind di ticket (card PR comprese), «Apri» naviga in app
  con `ticketTabForKind(kind)` se `item.ticketId !== null`, altrimenti
  `Linking.openURL(item.url)` come oggi. Nessun bottone «Ticket» in più: sulle
  card PR «Apri» porta alla tab Stato, dove la PR si apre dal titolo della sua
  card. `PlanReviewCard` guadagna «Apri» (solo con `ticketId`). Le card che
  non riguardano un ticket non cambiano. L'azione `open` resta decisa dal
  server (`can(item, "open")`) dove c'è oggi: il client cambia DOVE porta,
  non SE c'è.
- **Test prima** (in `InboxCard.test.tsx`, con `jest.mock` di
  `@react-navigation/native` che fa lo spread di `requireActual` e sostituisce
  solo `useNavigation`): per ogni kind di ticket, «Apri» chiama `navigate`
  con `{ id: ticketId, tab: "status" }` e NON `Linking.openURL`; con
  `ticketId: null` chiama `Linking.openURL(item.url)`; sulle card PR «Apri»
  naviga al ticket su Stato e non apre la PR; `PlanReviewCard` con `ticketId`
  ha «Apri», senza no; una card non di ticket (pulse/monitor) apre come oggi;
  `kind` sconosciuto (UNKNOWN) non lancia.
- **Mutazione**: ignorare `ticketId` e navigare sempre → il caso `ticketId:
  null` fallisce; passare `tab` fisso `"activity"` → i casi con `"status"` falliscono.
- **Done**: test delle card verdi; `InboxScreen.test.tsx` e
  `InboxCardScreen.test.tsx` verdi.

### Task 10 — Verifica finale

- Dal worktree:
  - `pnpm --filter @stubwise/mobile typecheck`
  - `pnpm --filter @stubwise/mobile lint` e `pnpm lint` (radice: la CI
    fallisce su lint anche con test verdi)
  - `pnpm --filter @stubwise/mobile test` intero, catturando l'esito PRIMA
    di filtrare l'output (`; echo "exit=$?"`, mai solo `| tail`)
  - il test di parità da solo: `pnpm --filter @stubwise/mobile test --
    src/lib/pr-cycle.test.ts`
  - `git diff --stat main...HEAD`: SOLO file sotto `apps/mobile/` e i due
    documenti in `docs/plans/`. Un file in `apps/web`, `apps/server`,
    `apps/worker` o `packages/` è un errore del piano, non un dettaglio.
- Mutazione di controllo sulla parità, a mano e poi ripristinata: cambiare
  in `apps/web/src/i18n/locales/it.json` il testo di `tickets.cycle.approved`
  → `pr-cycle.test.ts` deve fallire (prova che il confronto sui pezzi legge
  davvero il web). Ripristinare e verificare con `git diff` che `apps/web`
  non risulti modificato.
- **Verifica sul telefono** (build Release, memoria «Build iOS Release sul
  telefono»), un test alla volta: le quattro etichette su un iPhone da
  375 pt senza troncamenti; lo scroll di Attività conservato cambiando tab;
  il pull-to-refresh su ogni tab; la tastiera sopra il campo del commento;
  una card d'inbox «Apri» che porta al ticket su Stato. Nessuna dipendenza
  nativa è stata aggiunta, quindi niente `pod install` nuovo.
- **Done**: tutto verde, nessun test cancellato o saltato, CLAUDE.md
  aggiornato con le decisioni del §3, confermate (una riga
  nella sezione dell'app: «la pagina del ticket è a tab; il pallino di Stato
  lo decide `statusNeedsViewer`»).

## 6. Deploy

Solo l'app (build sul telefono / store). Nessuna rotta, nessuno schema,
nessuna migrazione; server, worker, caddy e web invariati.
