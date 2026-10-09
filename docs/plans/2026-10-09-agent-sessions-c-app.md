# Sessioni degli agenti — Piano C: app mobile

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nell'app la tab **AGT** prende il posto di **MBX** (INB/PRJ/WISEY/BLG/AGT) e mostra gli agenti al lavoro e le sessioni concluse; la sessione si guarda come una chat dal vivo, un maintainer ci scrive, chi ha titolo risponde alle domande; posta e calendario si raggiungono dalla pagina del profilo; la notifica di una domanda dell'agente apre la sessione sulla domanda.

**Architecture:** l'app usa il gruppo tipato `client.agentSessions` di `@stubwise/api-client` (piano A) e il campo `questions[]` completo con `canAnswer` (piano B, Task 1). Lo stream SSE si legge con `XMLHttpRequest` e `onprogress` (il `fetch` di React Native è `whatwg-fetch` e non espone `response.body`), riconnesso col cursore `after` e riaperto ogni 1 MB per non far crescere `responseText`. La trascrizione la produce una funzione pura GEMELLA di quella del web (`apps/mobile/src/lib/agent-transcript.ts`), con un test di parità sui casi. Lo stack della posta resta lo stesso navigatore, spostato dalla barra delle schede allo stack radice, accanto a `Settings`.

**Tech Stack:** React Native 0.87.1 bare, React 19.2, `@bottom-tabs/react-navigation` + native stack, TanStack Query 5 con persistenza su AsyncStorage, Jest + `@testing-library/react-native` (`await render`), i18next (`apps/mobile/src/i18n/{it,en}.json`).

**Spec:** `docs/plans/2026-10-08-agent-sessions-design.md` (§8.1, §8.3, §8.4, §9, §10, §12). Dipende dal **piano A** e dal **Task 1 del piano B** (`docs/plans/2026-10-09-agent-sessions-b-web.md`), già sul branch quando questo piano parte.

## Global Constraints

- Branch `feat/agent-sessions`, dopo il piano B. Niente push, niente PR, niente deploy, niente build per gli store.
- Le cinque tab diventano **INB/PRJ/WISEY/BLG/AGT**: decisione del maintainer (design §8.1), da riportare in `CLAUDE.md` al posto di INB/PRJ/WISEY/BLG/MBX, come quando DOC uscì per Wisey.
- `canWrite`, `canInterrupt`, `canAnswer` li calcola il **server**: l'app li legge e basta.
- Server senza le rotte (`isAgentSessionsUnavailable`: 404 SENZA `code`) → la tab dice «non disponibile su questa istanza», con un test (design §9). L'app è UNA per tutte le istanze.
- Le query delle sessioni **non si persistono** su AsyncStorage: contengono il testo delle email e l'output dei tool. Filtro in `persistQueryClient` (`dehydrateOptions.shouldDehydrateQuery`).
- Ogni metodo nuovo del client entra nel **doppio** dei test (`makeClient`) PRIMA del test che lo usa, e le fixture sono complete; un test verde al primo colpo su una lettura nuova va fatto fallire apposta prima di crederci (CLAUDE.md, la terza trappola).
- `await render(...)` sempre; un `jest.mock` di `@react-navigation/native` fa lo spread di `requireActual`.
- I deep link esistenti `stubwise://mail/…` e `stubwise://calendar/…` (li emette il server nelle push) continuano a funzionare: cambia solo dove atterrano.
- Nessuna dipendenza npm nuova (lo stream usa `XMLHttpRequest` di React Native).
- Allineamenti dal preflight del piano B (9 ott 2026, `.superpowers/sdd/2026-10-09-agent-sessions-b-web/preflight.md`), validi anche qui: (P5) il messaggio `partial` porta un DELTA, non il testo accumulato — la trascrizione ACCODA per segmento e azzera a ogni `assistant_text`/`turn_end`; (P7) il segnaposto dei valori ignoti di `readerSchema` è quello di `isUnknown` (`"__unknown__"`), non la stringa `"UNKNOWN"`: chiavi i18n `unknown` e confronti con `isUnknown`; (P4) ogni frame dello stream passa da `readerSchema(...).safeParse` prima di entrare nella cache; (P1/P2) `questions[]` ha le opzioni anche per il backlog, e `canAnswer` tiene già conto dello stato del job (lo decide il server). Dove questo piano dice altro, vale il preflight e il codice del web già scritto: prima di ogni task, LEGGI il gemello web (`apps/web/src/lib/agent-transcript.ts`, `agent-session-stream.ts`) e allinea.
- La frase dell'ultima azione viene da `lastActivity` del server (`describeAgentActivity`, `@stubwise/shared`); l'app la mette solo in parole.

## Review Focus

1. **Posta aperta fuori dalla barra delle schede**: le quattro schermate della posta chiamano `useBottomTabBarHeight()`, che LANCIA fuori da una scena delle tab. Atteso: aperte dal profilo e dai deep link si vedono, senza crash. Test in Task 2.
2. **Stream su una sessione lunga**: `responseText` di XHR cresce senza fine. Atteso: oltre 1 MB la connessione si riapre dal cursore, senza eventi doppi né persi. Test in Task 4.
3. **App in background**: lo stream resta aperto e consuma batteria e dati. Atteso: si chiude quando la schermata perde il fuoco o l'app va in background, e si riapre dal cursore al ritorno. Test in Task 6.
4. **Token scaduto durante lo stream**: un 401 sull'XHR. Atteso: stessa reazione del client (sessione pulita, evento «sessione scaduta»), nessun ciclo di riconnessioni. Test in Task 4.
5. **Push di una domanda con server senza sessioni** (rollback, istanza vecchia, `AGENT_STREAMING=false`): atteso che la notifica apra comunque la card della domanda, come oggi. Test in Task 8.

---

## File structure

| File | Responsabilità |
|---|---|
| `apps/mobile/src/lib/tab-bar-height-safe.ts` | `useBottomTabBarHeightSafe()`: 0 fuori dalle tab |
| `apps/mobile/src/app/navigation.tsx` | (mod) tab AGT, stack `Agents`, posta sullo stack radice (`Mail`), schermate di sessione negli stack di Inbox e Projects |
| `apps/mobile/src/app/linking.ts` | (mod) `agents`, `agents/:id`, `mail/…` e `calendar/…` sotto la radice |
| `apps/mobile/src/screens/settings/*` | (mod) righe «Posta» e «Calendario» nel profilo |
| `apps/mobile/src/lib/query-keys.ts` | (mod) `agentSessionKeys` |
| `apps/mobile/src/app/providers.tsx` | (mod) le sessioni fuori dalla persistenza |
| `apps/mobile/src/lib/client.ts` | (mod) export di `handleUnauthorized()` riusato dallo stream |
| `apps/mobile/src/lib/agent-session-stream.ts` | nuovo: SSE su XHR, parsing, riconnessione, rotazione a 1 MB |
| `apps/mobile/src/lib/agent-transcript.ts` | nuovo, puro: gemello di `apps/web/src/lib/agent-transcript.ts` |
| `apps/mobile/src/lib/elapsed.ts` | nuovo: `elapsedParts`, gemello del web |
| `apps/mobile/src/screens/agents/AgentsScreen.tsx` | nuovo: al lavoro ora / concluse |
| `apps/mobile/src/screens/agents/AgentSessionScreen.tsx` | nuovo: la chat dal vivo |
| `apps/mobile/src/screens/agents/AgentSessionByJobScreen.tsx` | nuovo: job → sessione, o ripiego |
| `apps/mobile/src/components/agents/*` | nuovi: `SessionRow`, `TranscriptItemView`, `ToolCard`, `AgentComposer`, `SessionQuestion` |
| `apps/mobile/src/screens/work/WorkScreen.tsx` | (mod) «Guarda la sessione» nella tab Stato |
| `apps/mobile/src/lib/open-ticket.ts`, `components/inbox/QuestionCard.tsx`, `lib/push-actions.ts`, `screens/inbox/InboxCardScreen.tsx` | (mod) la domanda apre la sessione |
| `apps/mobile/assets/icons/agent.svg` | nuovo: icona Android della tab |
| `apps/mobile/src/i18n/{it,en}.json` | (mod) `mobile.agents.*`, `mobile.settings.mail/calendar` |
| `CLAUDE.md`, `apps/docs/src/content/docs/getting-started/mobile-app.md` | (mod) le cinque tab, la posta nel profilo |

---

### Task 1: Altezza della barra che non lancia

**Files:**
- Create: `apps/mobile/src/lib/tab-bar-height-safe.ts`, `apps/mobile/src/lib/tab-bar-height-safe.test.tsx`
- Modify: `apps/mobile/src/screens/mbx/{MbxScreen,MailDetailScreen,ThreadDetailScreen,MailRejectionsScreen}.tsx` (l'import di `useBottomTabBarHeight` → `useBottomTabBarHeightSafe`)

**Interfaces:**
- Produces: `export function useBottomTabBarHeightSafe(): number` — `useContext(BottomTabBarHeightContext) ?? 0` (`BottomTabBarHeightContext` è esportato da `react-native-bottom-tabs`, `src/index.tsx:13`).

- [ ] **Step 1: test (RED)** — fuori da qualunque provider il hook restituisce 0; dentro `<BottomTabBarHeightContext.Provider value={83}>` restituisce 83. Un secondo test monta `MailRejectionsScreen` (con il doppio del client che il suo test già usa) SENZA il contesto delle tab e verifica che renda (oggi lancia).
- [ ] **Step 2:** `pnpm --filter @stubwise/mobile test -- tab-bar-height-safe` → FAIL.
- [ ] **Step 3:** implementa il hook con un docblock che rimanda a `app/tab-bar-height.tsx` (perché quello originale lancia) e sostituiscilo nelle quattro schermate della posta. `TabScreenKeyboardAvoider` NON si tocca: lo usano solo schermate dentro le tab.
- [ ] **Step 4:** test → PASS, e i test esistenti di `screens/mbx/` verdi.
- [ ] **Step 5:** commit `refactor(mobile): le schermate della posta non dipendono dalla barra delle schede`.

---

### Task 2: AGT al posto di MBX, posta e calendario dal profilo

**Files:**
- Modify: `apps/mobile/src/app/navigation.tsx`, `apps/mobile/src/app/navigation.test.tsx`, `apps/mobile/src/app/linking.ts`, `apps/mobile/src/app/linking.test.ts`, `apps/mobile/src/screens/settings/SettingsScreen.tsx`, `apps/mobile/src/screens/settings/SettingsScreen.test.tsx`, `apps/mobile/src/screens/inbox/GoogleProposalScreen.tsx` (+test), `apps/mobile/src/components/GlobalSearchSheet.tsx` (+test), `apps/mobile/src/i18n/{it,en}.json`
- Create: `apps/mobile/assets/icons/agent.svg`, `apps/mobile/src/screens/agents/AgentsScreen.tsx` (segnaposto in questo task: titolo e niente altro; il contenuto è il Task 5)

**Interfaces:**
- Produces (navigation.tsx):
  - `MbxStackParamList.List` diventa `{ view?: "mail" | "calendar"; day?: string; eventId?: string } | undefined` (additivo: `view` apre direttamente la vista chiesta; `day` continua a implicare il calendario).
  - `RootStackParamList` guadagna `Mail: NavigatorScreenParams<MbxStackParamList>` (lo STESSO `MbxNavigator`, registrato con `RootStack.Screen name="Mail"`, `headerShown: false`).
  - `MainTabParamList`: `Mbx` sostituito da `Agents: NavigatorScreenParams<AgentsStackParamList>`.
  - `AgentsStackParamList = { List: undefined } & AgentSessionParamList & TicketParamList`, con `AgentSessionParamList = { AgentSession: { id: string; focus?: "question" }; AgentSessionByJob: { jobId: string; ticketId?: string } }` (le due schermate si registrano qui nel Task 6/8; in questo task basta `List`).
  - Tab: `<Tab.Screen name="Agents" component={AgentsNavigator} options={{ tabBarLabel: "AGT", tabBarIcon: () => nativeTabIcon("terminal.fill", agentIcon) }} />` al posto di Mbx, stessa posizione.
- Produces (linking.ts): `Mail: { screens: { MailDetail: "mail/:source/:id", List: "calendar/:day/:eventId?" } }` spostato al livello di `Main` (figlio della radice); in `Main`: `Agents: { screens: { List: "agents", AgentSession: "agents/:id" } }`. `DeepLinkArea` aggiunge `"agents"`.
- Produces (Settings): `SettingsScreen` riceve `onOpenMail(view: "mail" | "calendar")`; `SettingsRoute` la implementa con `navigation.navigate("Mail", { screen: "List", params: { view } })`.

  Punti di ingresso alla posta da riportare (tutti, nessuno escluso):
  - `navigation.tsx` ~l.502-514: i deep link pendenti `mail`/`calendar` → `navigationRef.navigate("Mail", { screen: "MailDetail" | "List", params })` invece di `navigate("Main", { screen: "Mbx", … })`;
  - `GoogleProposalScreen.tsx` ~l.562-568 → `navigate("Mail", { screen: "MailDetail", params: { source: "email", id } })`;
  - `GlobalSearchSheet.tsx` ~l.276-283 → `navigate("Mail", { screen: "ThreadDetail", params: { threadId, highlightMessageId } })` (la navigazione parte già dopo la chiusura del foglio, come vuole CLAUDE.md: non cambia l'ordine);
  - `MbxScreen` usa `route.params?.view` prima di `day`.

  Profilo: due righe nuove in un gruppo «Posta e calendario» di `SettingsScreen` (non sezioni di `SETTINGS_GROUPS`: aprono uno stack, non `SettingsSection`), testID `settings-row-mail` e `settings-row-calendar`.

- [ ] **Step 1: test (RED)**:
  - `navigation.test.tsx` «la barra delle schede»: chiavi `["Inbox","Projects","Wisey","Backlog","Agents"]`, titoli `["INB","PRJ","","BLG","AGT"]` (aggiorna i due test esistenti, l.1022-1041);
  - deep link `stubwise://mail/email/xyz` → `mail-detail-screen` (il test esistente di l.478 cambia solo se cerca la tab Mbx: deve restare verde con la posta sullo stack radice); `stubwise://calendar/2026-10-09` → `calendar-panel` (l.523); il test del cerchio di Wisey (l.1087) verde;
  - `stubwise://agents` → la schermata Agenti nella tab AGT;
  - `linking.test.ts`: `leafOf("mail/email/x")` → `["Mail","MailDetail"]`; `leafOf("agents")` → `["Main","Agents","List"]`; `leafOf("agents/<uuid>")` → `["Main","Agents","AgentSession"]`;
  - `SettingsScreen.test.tsx`: le righe Posta e Calendario chiamano `onOpenMail("mail")` e `onOpenMail("calendar")`;
  - `GoogleProposalScreen.test.tsx` (l.456) e `GlobalSearchSheet.test.tsx` (l.432): asserzioni sul nuovo target `Mail`.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** implementa. Icona `assets/icons/agent.svg`: un glifo terminale (`>_`) 24×24 nello stile delle altre svg della cartella (stesse dimensioni e `fill`). i18n: `mobile.settings.mailGroup`, `mobile.settings.mail`, `mobile.settings.calendar` con le descrizioni, `mobile.tabs.agents`.
- [ ] **Step 4:** test → PASS; suite mobile completa con output salvato; `pnpm --filter @stubwise/mobile typecheck`.
- [ ] **Step 5:** commit `feat(mobile): la tab AGT prende il posto di MBX, posta e calendario dal profilo`.

---

### Task 3: Dati, chiavi, persistenza, durata, testi

**Files:**
- Modify: `apps/mobile/src/lib/query-keys.ts`, `apps/mobile/src/app/providers.tsx`, `apps/mobile/src/i18n/{it,en}.json`
- Create: `apps/mobile/src/lib/elapsed.ts`, `apps/mobile/src/lib/elapsed.test.ts`, `apps/mobile/src/app/providers.persist.test.ts`

**Interfaces:**
- Produces: `agentSessionKeys = { all: ["agent-sessions"] as const, list: (f?: AgentSessionListQuery) => [...all, "list", f ?? {}] as const, detail: (id: string) => [...all, "detail", id] as const }`; `shouldPersistQuery(query): boolean` esportata da `providers.tsx` (falsa per `queryKey[0] === "agent-sessions"`, altrimenti il default di TanStack: `query.state.status === "success"`), passata a `persistQueryClient({ …, dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery } })`; `elapsedParts(startedAt, now): { hours; minutes }` identica a quella del web (Task 2 del piano B: stesso codice, stessi test).

- [ ] **Step 1: test (RED)** — `shouldPersistQuery` falsa per `["agent-sessions","detail","x"]` e vera per `["work","ticket","x"]` con stato `success`; `elapsedParts` con gli stessi casi del web.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** implementa; testi `mobile.agents.*` con le stesse chiavi e frasi del namespace `agents` del web (piano B, Task 2: `title`, `live`, `recent`, `empty*`, `unavailable`, `elapsed*`, `state.*`, `outcome.*`, `kind.*`, `segment.*`, `activity.*`, `tool.*`, `segmentEnd.*`, `interrupted`, `input.*`, `loadOlder`, `reconnecting`, `composer.*`, `question.*`, `watch`, `replay`, `notFound`, `byJobFallback`) più `mobile.agents.errors.{session_ended,not_interactive,interrupt_unsupported,not_found}`. Le frasi sono le stesse del web: copiale dal catalogo web, non riscriverle.
- [ ] **Step 4:** test → PASS (parità i18n compresa).
- [ ] **Step 5:** commit `feat(mobile): chiavi, persistenza e testi delle sessioni degli agenti`.

---

### Task 4: Lo stream su XMLHttpRequest

**Files:**
- Modify: `apps/mobile/src/lib/client.ts` (export di `handleUnauthorized(): Promise<void>` = `clearSession()` + `emitSessionExpired()`, la stessa cosa che fa oggi il ramo 401 di `createSessionAwareFetch`, che la chiama)
- Create: `apps/mobile/src/lib/agent-session-stream.ts`, `apps/mobile/src/lib/agent-session-stream.test.ts`

**Interfaces:**
- Produces:

```ts
export type StreamMessage =
  | { type: "events"; events: Reader<AgentSessionEvent>[] }
  | { type: "partial"; segmentId: string; text: string }
  | { type: "session"; detail: Reader<AgentSessionDetail> };
export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export function openAgentSessionStream(opts: {
  sessionId: string;
  after: string | null;
  onMessage: (m: StreamMessage) => void;
  onStatus?: (s: StreamStatus) => void;
  onFatal?: (status: number) => void;            // 404: niente riconnessione
  loadSession?: () => Promise<{ baseUrl: string; token: string } | null>; // default lib/storage
  createXhr?: () => XMLHttpRequest;               // default new XMLHttpRequest(), per i test
  backoffMs?: (attempt: number) => number;        // default min(1000 * 2 ** attempt, 15_000)
  rotateAfterBytes?: number;                      // default 1_000_000
}): { close(): void };
```

  Regole: URL `${baseUrl}${client path}` — il path lo costruisce `streamPath` del client tipato (`agentSessions.streamPath(id, after)`), header `Authorization: Bearer <token>` e `Accept: text/event-stream`; `onprogress` legge `responseText.slice(offset)` e avanza `offset`; frame separati da `\n\n`, solo righe `data:`; JSON non valido → frame scartato; il messaggio `session` e gli eventi si parsano con gli schemi di `@stubwise/shared` passati da `readerSchema` (come fa il client), un frame che non parsa si scarta; il cursore è l'ultimo `id` di `events`; `onload`/`onerror`/`ontimeout` → riconnessione con backoff e `after` = cursore; `status === 401` → `handleUnauthorized()` e `closed`, nessuna riconnessione; `status === 404` → `onFatal(404)`, nessuna riconnessione; oltre `rotateAfterBytes` di `responseText` → `abort()` e riapertura immediata dal cursore (senza backoff); `close()` → `abort()` e niente più riconnessioni.

- [ ] **Step 1: test (RED)** con un XHR finto (classe nel file di test: `open`, `setRequestHeader`, `send`, `abort`, campi `responseText`/`status`, e metodi del test `emit(text)`, `finish(status)`, `fail()`):
  - due frame arrivati in UN solo `onprogress` e un frame spezzato a metà fra due `onprogress` → tre messaggi, in ordine;
  - riconnessione dopo `finish(200)`: la seconda `open` ha `after=<ultimo id>`;
  - rotazione: con `rotateAfterBytes: 50` la connessione viene abortita e riaperta dal cursore, e nessun evento arriva due volte;
  - 401 → `handleUnauthorized` chiamata una volta (mock del modulo `./client`), nessuna seconda `open`;
  - 404 → `onFatal(404)`, nessuna seconda `open`;
  - header `Authorization: Bearer <token>` dalla sessione;
  - `close()` durante il backoff → nessuna nuova `open` (timer finti).
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** implementa.
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5:** commit `feat(mobile): stream dal vivo di una sessione su XMLHttpRequest`.

---

### Task 5: La tab AGT — al lavoro ora e concluse

**Files:**
- Modify: `apps/mobile/src/screens/agents/AgentsScreen.tsx` (dal segnaposto del Task 2)
- Create: `apps/mobile/src/components/agents/SessionRow.tsx`, `apps/mobile/src/screens/agents/AgentsScreen.test.tsx`

**Interfaces:**
- Consumes: `client.agentSessions.list(filters)`, `isAgentSessionsUnavailable` (`@stubwise/api-client`), `agentSessionKeys`, `elapsedParts`, `ScreenHeader`, `ProjectRowsCard` o `PulseRow` come stile delle righe, `SectionLabel`, `usePullToRefresh`.

  Contenuto:
  - Query della lista con `refetchInterval: 5_000` solo quando la schermata è a fuoco (`useScreenFocused()`): fuori fuoco nessun polling.
  - «Al lavoro ora»: tipo, titolo, progetto e `#numero`, stato, «da X» (con `elapsedParts` e un `now` che si aggiorna ogni 30 s), la riga dell'ultima azione da `lastActivity ?? null` (`mobile.agents.activity.*`). Tap → `navigate("AgentSession", { id })`.
  - «Concluse»: esito (`mobile.agents.outcome.*`, niente se `null`) e quando. Filtro esito sul client (chip come quelli già usati nelle liste); niente filtro progetto nell'app v1 (la lista è già limitata a 14 giorni e 50 concluse; le sessioni di un progetto si raggiungono dal suo ticket).
  - Errore `isAgentSessionsUnavailable` → solo `mobile.agents.unavailable` (testID `agents-unavailable`).
  - Pull-to-refresh sulla chiave `agentSessionKeys.all`.

- [ ] **Step 1: test (RED)**, col doppio del client che ha `agentSessions: { list, get, events, send, streamPath }` tutti `jest.fn()` (aggiungili PRIMA, CLAUDE.md):
  - riga live con «sta modificando routes/tickets.ts» e stato;
  - fixture SENZA `lastActivity`/`outcome`/`aiJobId` → nessun crash, riga mostrata (qui il client è un doppio: la fixture è passata così com'è, ed è il punto);
  - `list` che rifiuta con `new ApiError(404, "not found")` (senza `code`) → `agents-unavailable`, nessuna riga; con `new ApiError(404, "x", "not_found")` → NON è «non disponibile» (è un errore normale);
  - filtro «fallita» → resta la sola sessione `failed`;
  - tap su una riga → `navigate("AgentSession", { id })`.
- [ ] **Step 2:** test → FAIL. **Step 3:** implementa. **Step 4:** PASS. 
- [ ] **Step 5:** commit `feat(mobile): tab AGT con gli agenti al lavoro e le sessioni concluse`.

---

### Task 6: La sessione come chat

**Files:**
- Create: `apps/mobile/src/lib/agent-transcript.ts` (+test), `apps/mobile/src/screens/agents/AgentSessionScreen.tsx` (+test), `apps/mobile/src/components/agents/{TranscriptItemView,ToolCard}.tsx`
- Modify: `apps/mobile/src/app/navigation.tsx` (registra `AgentSession` in `AgentsNavigator`, `InboxNavigator` e `ProjectsNavigator`; `AgentSessionParamList` intersecato in `TicketParamList` così esiste ovunque c'è un ticket), `apps/mobile/src/app/linking.ts` (già fatto il path nel Task 2: verifica)

**Interfaces:**
- Produces: `buildTranscript` e `mergeEvents` con la STESSA firma e le STESSE regole di `apps/web/src/lib/agent-transcript.ts` (piano B, Task 4); il test copia i casi del web uno per uno (sono gemelli deliberati come i due `pulse-line.ts`: il docblock lo dice e rimanda all'altro).
- Produces: `useAgentSession(id)` come sul web (prima pagina di eventi, poi stream con `after` = ultimo id; `partials` ACCODATI per segmento (delta, P5) e azzerati su `assistant_text`/`turn_end`; `session` → `setQueryData` del dettaglio; `loadOlder()` con `before`), più due regole del web (`apps/web/src/lib/agent-session-view.ts`, review del Task 6 del piano B): (i) quando la sessione smette di essere viva (o è già `ended` al primo caricamento) si fa UN recupero `after = ultimo id`, a pagine con tetto 20, prima di chiudere — il server manda il frame `session` PRIMA degli ultimi eventi, e chiudere al primo `ended` li perde; (ii) nessun retry sui 4xx; (iii) una sessione `ended` può tornare viva (la chat del backlog fra un turno e l'altro, la ripresa dopo una domanda): finché la schermata è a fuoco e la sessione è `ended`, il dettaglio si rilegge ogni 10 s, e se torna viva lo stream si riapre dal cursore (review finale del piano B). In più la regola dell'app: lo stream è aperto **solo** quando la schermata è a fuoco e l'app è attiva (`useScreenFocused()` e `AppState`), e si riapre dal cursore al ritorno.

  Disegno: `ScreenHeader` con titolo, `onBack`, sottotitolo (stato e durata o esito); `FlatList` **invertita** (`inverted`) della trascrizione, così si parte dal fondo e scorrendo all'indietro `onEndReached` chiama `loadOlder()` (design §8.3: «gli ultimi eventi e il resto scorrendo all'indietro»); testo in `SafeMarkdown`; `ToolCard` compatta che si espande (input e risultato in testo monospazio, «troncato» se `truncated`); interventi a destra col nome e lo stato; divisori di segmento; riga «Riconnessione…» quando lo stream è `reconnecting`; 404 → `mobile.agents.notFound`. Il link al ticket nell'intestazione naviga a `"Ticket"` nello stesso stack.

- [ ] **Step 1: test (RED)** — trascrizione: i casi del web. Schermata (doppio del client + `createXhr` finto passato con un provider o un parametro di modulo — scegli UNA delle due e scrivila nel docblock):
  - prima pagina → testo, card e divisore;
  - stream aperto con `after=<ultimo id>`;
  - due parziali (delta) dello stesso segmento si accodano, e spariscono all'arrivo dell'`assistant_text`;
  - `session` con `state: "ended"` aggiorna l'intestazione;
  - `session` con `ended` seguito dal recupero: l'evento finale compare (richieste `after=[null, <ultimo id>]`, come il test del web);
  - schermata non a fuoco → lo stream viene chiuso (`abort` chiamato), a fuoco di nuovo → riaperto dal cursore;
  - dettaglio SENZA `questions`/`inputs`/`canWrite` → nessun crash.
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS, suite mobile completa salvata.
- [ ] **Step 5:** commit `feat(mobile): la sessione di un agente come chat dal vivo`.

---

### Task 7: Scrivere all'agente e rispondere dalla sessione

**Files:**
- Create: `apps/mobile/src/components/agents/{AgentComposer,SessionQuestion}.tsx`
- Modify: `apps/mobile/src/screens/agents/AgentSessionScreen.tsx` (+test)

**Interfaces:**
- Consumes: `client.agentSessions.send`, `useAnswerQuestion(ticketId)` (`lib/work-mutations.ts`), `client.backlog.answerQuestion(id, questionId, answer)`, `QuestionForm` (`components/inbox/QuestionForm.tsx`), `useIsOnline()`, `TabScreenKeyboardAvoider`.

  Regole (le stesse del web, piano B Task 7):
  - composer solo con `detail.canWrite`; «Ferma e scrivi» solo con `detail.canInterrupt`; vuoto → disabilitato; max 4000; offline → disabilitato con il testo che le altre schermate usano già;
  - (dal Task 7 del web) bozza ed errore vivono nella SCHERMATA, non nel composer: con un 409 `session_ended`/`not_interactive` il refetch porta `canWrite: false` e il composer si smonta — senza, si perdono testo ed errore. Un blocco «Non inviato: <motivo>» mostra il testo selezionabile. Il testo si svuota solo quando la bolla pending è comparsa; fino ad allora bottoni disabilitati e campo `editable={false}`. Il test riproduce la condizione VERA (la seconda risposta del dettaglio ha `canWrite: false`), non una fixture ferma a `true`;
  - dopo l'invio il testo si svuota e la bolla arriva da `detail.inputs` (pending → delivered/undelivered dal messaggio `session`); errori 409 tradotti (`mobile.agents.errors.*`), il testo resta;
  - domanda aperta con `canAnswer` → `QuestionForm` con `{ questionId: q.id, round: q.round, question: q.question, options: q.options, recommendedIndex: q.recommendedIndex, allowFreeText: q.allowFreeText }`; `source: "agent"` → `useAnswerQuestion(q.ticketId)`; `source: "backlog"` → `client.backlog.answerQuestion(q.backlogItemId, q.id, body)`; al successo invalidano il dettaglio della sessione, `workKeys.all(ticketId)` e `inboxKeys.all`;
  - `focus: "question"` nei parametri → la lista scorre alla prima domanda aperta.

- [ ] **Step 1: test (RED)**:
  - stessi dati, `canWrite` vero e falso → composer sì/no (la differenza nel test è SOLO il campo, non il ruolo dell'utente);
  - «Ferma e scrivi» assente con `canInterrupt: false`;
  - invio → `send(id, { text, interrupt: false })`; `session` con l'input `undelivered`/`stdin_closed` → «non consegnato — l'agente non accettava più messaggi»;
  - 409 `session_ended` → messaggio tradotto, testo nel campo;
  - domanda dell'agente con `canAnswer: true` → `client.tickets.answerQuestion(ticketId, qid, { optionIndex: 0 })`; con `canAnswer: false` nessun bottone; domanda di backlog → `client.backlog.answerQuestion`;
  - con `focus: "question"` la schermata scorre fino alla domanda (verifica `scrollToIndex` sul ref della lista, mockato).
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(mobile): scrivere all'agente e rispondere alle domande dalla sessione`.

---

### Task 8: Dal ticket e dalla notifica alla sessione

**Files:**
- Create: `apps/mobile/src/screens/agents/AgentSessionByJobScreen.tsx` (+test)
- Modify: `apps/mobile/src/app/navigation.tsx` (registra `AgentSessionByJob` dove c'è `AgentSession`), `apps/mobile/src/screens/work/WorkScreen.tsx` (+test), `apps/mobile/src/lib/open-ticket.ts` (+test), `apps/mobile/src/components/inbox/QuestionCard.tsx`, `apps/mobile/src/lib/push-actions.ts` (+test), `apps/mobile/src/app/linking.ts` (+test), `apps/mobile/src/screens/inbox/InboxCardScreen.tsx` (+test)

**Interfaces:**
- Produces:
  - `AgentSessionByJobScreen`: `client.agentSessions.list({ aiJobId: jobId })` → sessione trovata (`live[0] ?? recent[0]`) → `navigation.replace("AgentSession", { id, focus: "question" })`; nessuna sessione, rotte assenti (`isAgentSessionsUnavailable`) o errore → `navigation.replace("Ticket", { id: ticketId, tab: "status" })` se c'è `ticketId`, altrimenti `goBack()`; mentre risolve, uno `Skeleton`.
  - `openActionFor(item, onOpenTicket, options)` guadagna `options.onOpenSessionForJob?: (jobId: string, ticketId: string | null) => void`: per `item.kind === "job.awaiting_input"` con `jobId` e la callback presente, «Apri» la chiama; senza callback o senza `jobId`, comportamento di oggi (il ticket). I quattro chiamanti (`InboxScreen`, `InboxCardScreen`, `ProjectInboxScreen`, `BacklogItemScreen`) passano `(jobId, ticketId) => navigation.navigate("AgentSessionByJob", { jobId, ticketId: ticketId ?? undefined })`.
  - **Push**: in `handlePushAction`, per `kind === "job.awaiting_input"` e azione `open`/tap, `openCard` apre `stubwise://inbox/<id>?session=1` invece di `stubwise://inbox/<id>`. `resolveDeepLinkTarget` legge `session=1`; `InboxCardScreen` riceve `openSession?: boolean` nei parametri e, quando la card caricata ha `jobId`, fa `navigation.replace("AgentSessionByJob", { jobId, ticketId })`. Se la card non ha `jobId` o il caricamento fallisce resta sulla card: il ripiego di oggi (Review Focus 5). L'azione «Rispondi» della push (`answer`) NON cambia: apre la card con il foglio della risposta, come oggi.
  - **Ticket**: nella tab Stato, una riga «Guarda la sessione»/«Rivedi la sessione» quando `client.agentSessions.list({ aiJobId: latestJob.id })` trova una sessione (query NON bloccante: errore o server vecchio → niente riga, nessun impatto sul resto). Dal Task 8 del web: lo STATO del job entra nella chiave della query, così il passaggio coda → esecuzione (che il polling dei job già esistente vede) rifà la ricerca — senza, con la pagina aperta da prima, il link mancava proprio col run vivo; e nessuna query quando il ticket non ha job (`enabled: false`). Test: job `queued` → `triaging`, la riga compare. `WorkTabs` riceve `onOpenSession(id)` da `WorkScreen`, che naviga ad `"AgentSession"` nello stesso stack.

- [ ] **Step 1: test (RED)**:
  - `AgentSessionByJobScreen`: sessione trovata → `replace("AgentSession", { id, focus: "question" })`; nessuna → `replace("Ticket", …)`; `ApiError(404)` senza codice → `replace("Ticket", …)`;
  - `openActionFor` con la callback per `job.awaiting_input` → chiama la callback con `jobId`; per un altro kind → ticket come prima; senza callback → ticket come prima;
  - `handlePushAction` tap su `job.awaiting_input` → `Linking.openURL("stubwise://inbox/<id>?session=1")`; su un altro kind → URL di oggi;
  - `resolveDeepLinkTarget("stubwise://inbox/<id>?session=1")` → target inbox con `openSession: true`;
  - `InboxCardScreen` con `openSession: true` e card con `jobId` → `replace("AgentSessionByJob", …)`; card senza `jobId` → resta sulla card;
  - `WorkScreen`: con sessione viva la riga «Guarda la sessione» naviga ad `AgentSession`; con `list` che rifiuta (404 senza codice) nessuna riga e i test esistenti della schermata verdi (aggiungi `agentSessions.list` al doppio PRIMA: senza, la query accessoria fallisce in silenzio e il test passa per il motivo sbagliato).
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS, suite mobile completa salvata.
- [ ] **Step 5:** commit `feat(mobile): dal ticket e dalla notifica di una domanda alla sessione`.

---

### Task 9: Documentazione e verifica finale

**Files:**
- Modify: `CLAUDE.md` (tutte le frasi che elencano le cinque tab: «le cinque sono INB/PRJ/WISEY/BLG/MBX» → INB/PRJ/WISEY/BLG/AGT, con la data e il motivo come per DOC; posta e calendario dal profilo; la voce di deploy delle sessioni: l'app si aggiorna dagli store e senza server nuovo mostra «non disponibile»; la regola «le sessioni non si persistono su AsyncStorage»), `apps/docs/src/content/docs/getting-started/mobile-app.md` (tab, posta nel profilo, sessioni), `apps/mobile/README.md` se elenca le tab.

- [ ] **Step 1:** documentazione come sopra; `grep -rn "MBX\|Mbx" CLAUDE.md apps/docs apps/mobile/README.md` non deve trovare frasi che descrivono ancora MBX come tab.
- [ ] **Step 2:** `pnpm typecheck && pnpm lint`; test per pacchetto (`mobile`, `shared`, `api-client`, `web` per sicurezza) con output salvato; `pnpm --filter @stubwise/docs build`.
- [ ] **Step 3:** **Verifica sul telefono: NON eseguibile in questo giro** (niente build né simulatore). Scrivi nel ledger e nel report finale l'elenco di cosa va provato a mano prima del rilascio dell'app: (a) lo stream arriva dal vivo attraverso Caddy (`encode zstd gzip`: se Caddy comprime e bufferizza `text/event-stream` su questa piattaforma, i parziali arrivano a blocchi); (b) la posta aperta dal profilo su iOS e Android, tastiera compresa; (c) tap su una push di domanda → sessione sulla domanda; (d) app in background e ritorno: lo stream riparte senza doppioni.
- [ ] **Step 4:** commit `docs: AGT al posto di MBX, sessioni degli agenti nell'app`.

---

## Self-review

- §8.1 AGT al posto di MBX, posta e calendario dal profilo, ogni percorso verso `Mbx` riportato (deep link, proposta posta, ricerca, CLAUDE.md) → Task 1, Task 2, Task 9. «Guarda la sessione» dalla tab Stato → Task 8.
- §8.2 nell'app: stati, esito, durata dal client, ultima azione → Task 5 (filtro progetto deliberatamente solo sul web: dichiarato).
- §8.3 chat: markdown, card dei tool, interventi col nome e lo stato, confini, domande nel punto in cui sono state fatte con la stessa rotta, composer solo per chi può, eventi vecchi scorrendo all'indietro → Task 6, Task 7.
- §8.4 la notifica di una domanda apre la sessione: la push (`handlePushAction` → card con `session=1` → sessione), l'«Apri» della card in inbox → Task 8, con ripiego alla card.
- §9 server vecchio → «non disponibile» (Task 5), nessuna riga sul ticket (Task 8), ripiego della push (Task 8).
- §10 `canWrite` a due valori sugli stessi dati → Task 7; fixture e doppi completi → in ogni task.
- Privacy: niente sessioni su AsyncStorage → Task 3.
