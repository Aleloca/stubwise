# App desktop, area 9b: istanza — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Costruire nel prototipo `apps/desktop` la seconda parte dell'area 9,
l'istanza, in Amministrazione:
- AI: provider e quota, modelli per operazione, automazione, budget e lingua,
  consumi;
- integrazioni: account git, registro dei plugin, Google Workspace,
  archiviazione, webhook in uscita;
- le viste di tutta l'istanza: tutti i server (con i grafici a 30 e 90
  giorni), tutti i repository, lo Stato dell'istanza con Retry e Pause/Resume
  della coda di un progetto;
- gli **effetti visibili** delle impostazioni nelle altre aree (budget, coda
  in pausa, modello, provider, archiviazione).

**Architecture:**
- **Lo stato d'istanza** è una parte nuova dello store, `instance`
  (`data/instance/state.ts`), accanto ad `access` del 9a. Lo legge e lo scrive
  solo `data/instance/*`; le pagine passano da `data/queries/instance.ts`.
- **Le scritture** seguono l'ordine di `data/admin/common.ts`:
  `not_found` → `forbidden` → `invalid` → blocchi → `reauth_required` →
  scrittura + voce del registro. Rispondono `InstanceResult<T>`, come
  `AdminResult` del 9a.
- **I tre meccanismi del 9a si riusano senza toccarli:**
  - il registro (`registerChangeTypes` in `data/instance/changeTypes.ts`);
  - la riconferma (`REAUTH_REQUIRED` cresce con le funzioni +R);
  - il caveau dei segreti (`data/admin/secrets.ts`), con una funzione in più
    per i segreti **scritti da chi amministra** (`storeProvidedSecret`).
- **Gli effetti** passano da due funzioni sole del livello dati, che le altre
  aree chiamano: `aiBlockFor(projectId)` (budget e coda in pausa) e
  `modelFor(operation)`/`pickProvider()` (chi e con che modello gira un
  lavoro nuovo).
- **Lo Stato dell'istanza legge i lavori che esistono già** (sessioni di
  lavoro, correzioni, review, analisi e correzioni dei server, esecuzioni
  delle automazioni) e un seme del giro notturno, solo da guardare.

**Tech Stack:** quello delle aree 1–9a, senza dipendenze nuove. Operazioni e
modelli vengono da `@stubwise/shared` (`AI_OPERATION_GROUPS`,
`CONFIGURABLE_AI_OPERATIONS`, `AI_MODEL_CHOICES`), già dipendenza del desktop.

**Spec:** `docs/plans/2026-10-29-desktop-area9-admin-design.md` (approvato
il 29 ott 2026). Di quel documento valgono:
- tutto ciò che «Tre piani» assegna a 9b;
- «Il principio», «Anti-obiettivi», «Invarianti del CLAUDE.md che quest'area
  tocca» (in particolare «Stubwise non fa deploy» e le azioni dello Stato
  dell'istanza);
- la tabella «Amministrazione: com'è fatta» per le righe 9b;
- «Il registro delle modifiche» (voci di 9b), «Istanza (9b)», «Permessi»;
- «Quanto è vero nel prototipo» e «Il lavoro nella coda»;
- «Dati finti» per provider, account git, plugin, webhook, coda;
- «Parità con il web», C ed E;
- «Review Focus» 2 e 5.

Contesto da leggere:
- `apps/desktop/docs/area9-inventory.md`, sezioni C ed E: è il perimetro;
- `apps/desktop/docs/area9-parity.md` e `apps/desktop/docs/ossatura-follow-ups.md`
  («Area 8b — minori aperti», R-L6/R-L7; «Area 9a — minori aperti»; §9 delle
  invarianti da riscrivere);
- `docs/invariants/providers.md` e la voce «Quota degli account» di
  `docs/operations/deploy-log.md` (catena, «al limite», D3, soglia di sfondo
  90%); «Plugin e skill dell'agente» in `CLAUDE.md`;
- sul web: `apps/web/src/routes/settings/{automation.tsx,usage.tsx}` e
  `apps/web/src/components/{ai-providers-section,model-settings-section,git-accounts-section,plugins-section,plugin-inventory,google-workspaces-section,storage-section,notifications-section,usage-panel}.tsx`;
- `apps/desktop/DESIGN.md`.

## Global Constraints

- **Valgono tutte le Global Constraints delle aree 2–9a:**
  - nessuna rete;
  - en/it con parità;
  - temi;
  - niente monospace, salvo logo, codice, log, comandi, script, token e
    chiavi;
  - colore mai unico segnale;
  - movimento 150–250 ms, con reduced-motion;
  - pagine solo via `data/queries.ts` (e `data/queries/*`);
  - stati completi: caricamento, vuoto, errore con «Riprova», pieno, senza
    permessi. Eccezione: sullo Stato dell'istanza l'errore usa «Load again»
    / «Ricarica», shape [IS 6] (*ruling del controller (pre-flight)*);
  - orologio `now()` di `data/store.ts`;
  - R-G5: nascosto e inesistente sono identici;
  - commenti in italiano.
- **L'app fa tutto quello che fa il sito, e di più** (maintainer). Ogni voce C
  ed E di `area9-inventory.md` che non è «fuori» ha un posto e un test. Fuori:
  Slack, posta ammessa, regole della posta di progetto, «Rigenera il brief».
- **Amministrazione per tutti, ognuno la sua parte** (maintainer). Una voce
  dell'Amministrazione si vede solo col suo permesso (tabella sotto); dentro
  una voce, chi la vede senza il permesso di scrittura la legge in sola
  lettura. Senza nessuna voce, l'Amministrazione non compare.

  | Voce | Si vede con | Si scrive con |
  |---|---|---|
  | AI → Providers, Models, Automation, Budget & language | `ai_providers.manage` o `settings.manage` | Providers: `ai_providers.manage`; le altre: `settings.manage` |
  | AI → Usage | `usage.view` | — |
  | Git accounts | `git_accounts.view` o `.manage` | `git_accounts.manage` |
  | Plugins | `plugins.manage` | `plugins.manage` |
  | Google Workspace | `integrations.manage` | `integrations.manage` |
  | Storage, Outgoing webhooks | `settings.manage` | `settings.manage` |
  | Servers | `monitor.manage` | `monitor.manage` (come l'8b) |
  | Repositories | `repos.manage` in almeno un progetto | — (rimanda a Progetto → Settings) |
  | Instance status | `instance.status.view` o `settings.manage` | Retry, Pause/Resume: `settings.manage` |

- **«Who?» accanto a ogni bottone spento per permesso** (maintainer): è il
  `WhoCanLink` del 9a, con un'azione del catalogo `ACTIONS`. Nessun bottone
  spento senza la frase e il link.
- **Le impostazioni hanno effetti visibili** (maintainer), e solo quelli del
  design: budget raggiunto, coda in pausa, modello per operazione, provider
  della catena, archiviazione spenta. Auto-fix, soglie d'effort e
  approvazione da effort si salvano e basta.
- **Registro delle modifiche per ogni cambio** (maintainer). Ogni scrittura
  riuscita di questo piano scrive una voce da template i18n, con prima e
  dopo quando ha senso. Una scrittura rifiutata non ne scrive.
- **+R sulle azioni sensibili** (maintainer): ogni funzione che crea,
  sostituisce o cancella un segreto, una chiave o un token, più la
  registrazione e l'aggiornamento di un plugin (eseguono codice, *scelta del
  controller*). L'elenco esatto è nel Task 1; il test del registro di
  `reauth.test.ts` lo confronta.
- **I segreti si mostrano una sola volta** (maintainer). Un segreto scritto
  da chi amministra (chiave API, setup-token, token git, client secret,
  chiave S3) vive solo nel caveau: dopo il salvataggio non torna mai nel
  DOM, in una lettura, nel registro o in una notifica. Si vedono le ultime 4
  cifre e «Replace». Un valore generato da Stubwise (chiave dell'agente dei
  server) resta `SecretOnce` come nell'8b.
- **L'URL del webhook in uscita non è un segreto** (maintainer, 30 ott
  2026): si rilegge in chiaro come sul web (lo legge chi ha
  `settings.manage`), entra nel prima/dopo del registro, e cambiarlo non
  chiede la riconferma. Il webhook non ha altri segreti (niente chiave di
  firma, come sul web), quindi nessun suo salvataggio è +R.
- **Decisioni del maintainer del 30 ott 2026** sulle domande del piano:
  - Retry chiede `settings.manage` **e** `runs.start` nel progetto, parte a
    nome di chi riprova e passa dal gate del piano come «Avvia» (Task 5);
  - un passo d'automazione con il budget esaurito **resta fermo** e riparte
    da solo quando il budget torna disponibile, come il `budget_held` del
    web; non fallisce (Task 5, 6);
  - la pausa della coda **non** tocca «Chiedi a Claude» (la conversazione
    libera): la ferma solo il budget (Task 6).
- **Niente gerarchia, si dà solo ciò che si ha** (maintainer). Nel 9b nessuna
  scrittura dà permessi: se un task ne aggiunge una, passa da `escalationIn`
  di `data/admin/common.ts`.
- **«Stubwise non fa deploy».** Lo Stato dell'istanza ha solo Retry e
  Pause/Resume, che agiscono sulla coda di Stubwise. Nessun controllo
  riavvia, ridistribuisce o tocca un server o un processo. Le etichette non
  sono mai fra quelle vietate da `test/noDeploy.ts` (quindi niente
  «Rilancia»/«Riprova» in italiano: *scelta del controller*, «Rimetti in
  coda»).
- **Claude** non riceve nessun permesso d'amministrazione e non legge nessuna
  voce 9b del registro.
- **Simulazioni** solo nel riquadro «Prototype only» (`PrototypeBox` di
  `pages/automations/shared.tsx`): esito delle prove di provider, git, S3,
  webhook e plugin; budget raggiunto.
- **Istanza vuota** (9a): `resetToEmptyInstance()` svuota anche `instance`
  (nessun provider, account, plugin, app Google; archiviazione e webhook
  spenti), e ogni voce nuova ha il suo stato vuoto.
- **Impeccable obbligatorio per la UI**, con gli shape del Task 0 approvati e
  vincolanti, e la revisione visiva di Impeccable dopo l'ultimo task.
- **Comandi.**
  - Un singolo file di test: `pnpm --filter @stubwise/desktop test --
    <file>`.
  - Prima di ogni commit: la suite desktop (`pnpm --filter @stubwise/desktop
    test`), `pnpm --filter @stubwise/desktop typecheck` e `pnpm lint` dalla
    radice. Alla fine anche `pnpm --filter "@stubwise/desktop..." build`.
  - Commit `feat(desktop): …` / `fix(desktop): …` in italiano, con i trailer
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` e
    `Claude-Session: https://claude.ai/code/session_01C9DcEFDJAasjVWKkutyVLm`.
  - Verifica UI: `pnpm --filter @stubwise/desktop preview:web` +
    `apps/desktop/scripts/capture.mjs`, a 1440 e 1024, chiaro e scuro, en e
    it, scatti `a9b-*`.
  - Uccidere vite alla fine. Mai `pkill` su vitest.

## Review Focus

1. **Un segreto che ricompare.** Dopo ogni creazione o sostituzione (chiave
   API, setup-token, token git, client secret Google, chiave S3), la
   serializzazione di ogni lettura di `api.instance`, di
   `api.changelog` e delle notifiche non contiene il valore
   (`__secretValuesForTest()`), e il DOM dopo la navigazione nemmeno. →
   Task 3, 4, 8, 10, 11.
2. **R-G5 nelle viste di tutta l'istanza.** Un progetto che chi guarda non
   vede non compare per nome, codice o link in:
   - Usage (si somma in «Other projects»);
   - Instance status (una riga «Other projects» coi soli conteggi);
   - la colonna dei progetti di Servers;
   - Repositories;
   - il rifiuto «in uso» di un account git (i repository nascosti sono solo
     contati);
   - le voci di progetto del registro (coda e Retry).

   → Task 2, 4, 5, 7.
3. **Coda in pausa.**
   - Il lavoro già partito finisce.
   - Un «Avvia» a mano entra in attesa e parte **una volta sola**, alla
     ripresa, nell'ordine d'arrivo. Un secondo «Avvia» in attesa è
     `conflict`.
   - `resetApi` durante l'attesa non fa partire niente.
   - Correzioni, analisi e correzioni dei server e automazioni aspettano
     anche loro.
   - Chi ha messo in pausa si legge per nome anche se poi è disattivato.

   → Task 5, 6.
4. **Budget e catena dei provider ai bordi.**
   - Con tutti gli abbonamenti al limite la chiave API non si usa finché c'è
     un abbonamento abilitato (D3).
   - Disabilitare o eliminare l'ultimo provider abilitato è rifiutato con una
     frase.
   - Il budget raggiunto ferma il lavoro nuovo, mai quello in corso; alzare
     il budget lo sblocca subito.
   - I passi d'automazione fermi per budget ripartono **una volta sola** e
     solo quando il budget torna disponibile (budget alzato o simulazione
     spenta); un altro salvataggio (la lingua, un budget ancora sotto lo
     speso) non li fa ripartire. Se nel frattempo la coda del progetto è in
     pausa, ripartendo restano fermi per la pausa.

   → Task 3, 5, 6.
5. **Le azioni leggere restano leggere.**
   - Retry su una correzione ferma è `unavailable` (`pr-corrections.md`).
   - Retry su un lavoro la cui task ha già un lavoro vivo è `conflict`.
   - Nessun controllo dello Stato dell'istanza passa da `expectNoDeploy` come
     vietato, in en e in it.

   → Task 5, 13.

---

### Task 0 (controller): shape di Impeccable

Brief `shape`, approvati dal maintainer, in `apps/desktop/.impeccable/shape/`.
Nessun codice.

- **`admin-ai.md`:**
  - la voce AI con le sue schede (Providers, Models, Automation, Budget &
    language, Usage) e chi vede quale;
  - Providers: catena ordinata, aggiungi (chiave o setup-token), abilita,
    riordina, prova, sostituisci la chiave, elimina, quota con «near» e
    «limited»;
  - Models: per gruppo di `AI_OPERATION_GROUPS`, con la fonte del valore;
  - Automation: righe per tipo di task, revisione delle PR;
  - Budget & language: budget, speso del mese, lingua dei contenuti;
  - Usage: periodo, totali, serie per giorno, tabella per dimensione e vista
    a due dimensioni, «Other projects».
- **`admin-integrations.md`:**
  - Git accounts (crea, valida, revisore predefinito, «in uso»);
  - Plugins (registra con l'avviso «registrare esegue il codice», stati,
    pagina del plugin con inventario, aggiorna a ref, smoke, rimuovi);
  - Google Workspace, Storage, Outgoing webhooks (con l'anteprima del
    messaggio; l'URL è un campo normale, in chiaro, come sul web);
  - `SecretField` (scrivi, poi solo «•••• 1a2b» e «Replace»), che il webhook
    non usa;
  - **quali tipi d'avviso del catalogo 8a/8b entrano fra gli eventi del
    webhook**, oltre ai 13 del web: è la scelta che il design rimanda allo
    shape. Mai `google.proposal` né eventi di posta.
- **`admin-instance.md`:**
  - Servers d'istanza (la riga dell'8b più la colonna dei progetti, i server
    orfani, «New server» senza ambiente, il dettaglio con 30d e 90d);
  - Repositories per progetto;
  - Instance status: coda per progetto e tipo, worker, quota, ultimi errori,
    i lavori in attesa col loro motivo (coda in pausa, **budget esaurito**),
    Retry e Pause/Resume con conferma, l'aggiornamento ogni 10 secondi.
- **`instance-effects.md`:**
  - come dicono budget raggiunto e coda in pausa la sezione Claude della
    task e la riga del progetto;
  - «Chiedi a Claude», che dice solo il budget (la pausa non la tocca);
  - un'esecuzione d'automazione con un passo fermo per budget: cosa dice,
    e che ripartirà da sola quando il budget torna disponibile;
  - dove si legge il modello e l'account di un lavoro;
  - cosa dicono Drive e allegati con l'archiviazione spenta.

### Task 1: Lo stato d'istanza, le voci, i segreti scritti

**Files:**
- Create: `data/instance/{state.ts,types.ts,seed.ts,common.ts,changeTypes.ts,index.ts}`, con il test `data/instance/instance.test.ts`.
- Modify:
  - `data/store.ts` (`State.instance`, `freshState`, `ApiFnName` con i nomi `instance.*` dei Task 2–7, `onInstanceEmptied`);
  - `data/admin/secrets.ts` (`SecretKind`, `storeProvidedSecret`);
  - `data/architecture.secrets.test.ts` (importatori ammessi: anche `data/instance/*`);
  - `data/auth/reauth.ts` e `reauth.test.ts` (`REAUTH_REQUIRED`);
  - `data/routes.ts` (`ADMIN_SECTIONS`, `AI_TABS`);
  - `data/adminSections.ts` (`sees`, `administersSomething`, `aiTabsFor`);
  - `domain/access/actions.ts` (azioni nuove) e i18n `whoCan.actions.*`;
  - `data/changelog/types.ts` (`ChangeObjectLink`), `data/changelog/visibility.ts` (`GROUP_ORDER`);
  - `data/changelog/reads.ts` (`objectLinkOf` per i link `admin` e `server`; `diffOf` con `values` per i kind 9b che hanno prima/dopo) e `pages/admin/ChangeEntry.tsx` (i rami dei link nuovi: oggi l'ultimo ramo dà per scontato `member`) — *ruling del controller (pre-flight)*;
  - i18n `changelog.kinds.*` dei kind 9b e `changelog.groups.{ai,integrations,servers,queue}`, e l'import `./instance/changeTypes` in `data/adminSections.ts`, accanto a quello di `./admin/changeTypes` — *ruling del controller (pre-flight)*;
  - `data/api.ts` (`export * as instance from "./instance"`).
- **Confini d'import** (*ruling del controller (pre-flight)*):
  - `data/instance/seed.ts` non importa `data/admin/secrets.ts`, perché `store.ts` lo raggiungerebbe e con lui le letture del registro (`architecture.secrets.test.ts`);
  - i segreti del seme hanno `secretId`/`last4` fissi, senza valore nel caveau, oppure li semina un hook `onStoreReset` di `data/instance/*` registrato dopo quello di `secrets.ts`;
  - `aiBlockFor`, `queuePauseOf`, `budgetReached` e `storageAllowsUploads` stanno in un modulo foglia (`data/instance/blocks.ts`) che importa solo lo store e lo stato d'istanza, così `servers/visibility.ts` li legge senza raggiungere `api-mutations` né `servers/secrets.ts` (`architecture.test.ts`);
  - `retryJob` sta in un file a parte (`data/instance/retry.ts`), l'unico che importa `startRunAs`.

**Interfaces, prodotte:**

```ts
// data/instance/state.ts
export type TestOutcome = "ok" | "invalid_credentials" | "unreachable";
export interface AiProvider { id: string; name: string; kind: "subscription" | "api_key"; enabled: boolean; secretId: string; last4: string; quota: { fiveHourPct: number; weeklyPct: number; readAt: string; limitedUntil: string | null } | null /* solo subscription */; lastTest: { at: string; outcome: TestOutcome } | null; createdAt: string }
export interface AutomationRule { taskType: TaskType; autoFix: boolean; maxEffort: 1 | 2 | 3 | 4 | 5; planApprovalMinEffort: 1 | 2 | 3 | 4 | 5 | null; maxCostUsd: number | null }
export interface GitAccount { id: string; name: string; provider: "bitbucket" | "github"; workspace: string | null; secretId: string; last4: string; defaultReviewer: boolean; lastValidation: { at: string; outcome: TestOutcome } | null; createdAt: string }
export interface RegisteredPlugin { id: string; slug: string; name: string; url: string; ref: string; sha: string | null; subdir: string | null; status: "materializing" | "ready" | "failed"; smoke: "running" | "passed" | "failed" | null; error: string | null; inventory: { skills: { name: string; description: string }[]; hooks: { key: string /* SessionStart#0 */; event: string; command: string }[] } | null; registeredById: string; updatedAt: string }
export interface StorageSettings { endpoint: string; region: string; bucket: string; accessKeyId: string; secretId: string | null; last4: string | null; attachmentsEnabled: boolean; lastTest: { at: string; outcome: TestOutcome } | null }
export interface OutgoingWebhook { enabled: boolean; format: "slack" | "discord" | "generic"; url: string | null /* in chiaro: non è un segreto */; events: Record<string, boolean>; lastTest: { at: string; outcome: TestOutcome } | null }
export interface QueuePause { projectId: string; byId: string; at: string }
/** Una riga di consumo (letta dal Task 2, scritta anche dal Task 6). */
export interface UsageRecord { id: string; at: string; operation: AiOperation; model: string; projectId: string | null; providerId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; conversationId: string | null }
/** Una riga del giro notturno, solo da guardare (Task 5). */
export interface NightlyRow { id: string; projectId: string; repositoryName: string; phase: "commit_summary" | "release_note" | "docs"; state: "running" | "waiting" | "failed" | "done"; at: string; summary: string | null }
export interface InstanceState {
  providers: AiProvider[];           // l'ordine dell'array È la catena
  models: Partial<Record<AiOperation, AiModelChoice>>;
  automation: { rules: AutomationRule[]; prReview: { enabled: boolean; maxCostUsd: number | null } };
  budget: { monthlyUsd: number | null; contentLanguage: "en" | "it" };
  gitAccounts: GitAccount[];
  plugins: RegisteredPlugin[];
  storage: StorageSettings;
  webhook: OutgoingWebhook;
  queuePauses: QueuePause[];
  usage: UsageRecord[];              // seme nel Task 2
  nightly: NightlyRow[];             // seme nel Task 5
  /** `nextTest`: chiave = id del provider o dell'account git, oppure "storage" / "webhook". */
  simulate: { nextTest: Record<string, TestOutcome>; budgetReached: boolean };
}
// data/instance/types.ts
export type InstanceRefusal = AdminRefusal | { ok: false; error: "conflict" } | { ok: false; error: "in_use"; usedBy: { label: string; projectCode: string | null }[]; hiddenCount: number };
export type InstanceResult<T extends object = object> = ({ ok: true } & T) | InstanceRefusal;
// data/admin/secrets.ts
// ruling del controller (pre-flight): un tipo a parte, così `valueOf`/`storeSecret` restano sui kind generati.
export type ProvidedSecretKind = "provider_credential" | "git_token" | "google_client_secret" | "storage_secret";
export type SecretKind = /* quelli del 9a */ | ProvidedSecretKind;
export function storeProvidedSecret(kind: ProvidedSecretKind, ownerId: string, value: string): { id: string; last4: string };
// data/routes.ts
export const AI_TABS = ["providers", "models", "automation", "budget", "usage"] as const;
// data/adminSections.ts
export function aiTabsFor(viewer: Viewer): (typeof AI_TABS)[number][];
```

- `GoogleWorkspace` (`data/me/types.ts`) si allarga a `clientId: string;
  secretId: string; last4: string; createdAt: string`. È la stessa riga che
  le Preferenze leggono per collegare una casella: un'app registrata in 9b
  compare lì senza altro codice.
- `Repository` (`data/model.ts`) prende `gitAccountId?: string | null`.
- `ADMIN_SECTIONS` aggiunge, dopo quelle del 9a:
  - gruppo `instance`: `ai`, `git-accounts`, `plugins`, `google`, `storage`,
    `webhooks`;
  - gruppo `estate`: `servers`, `repositories`, `status`.

  Le regole di `sees` sono quelle della tabella delle Global Constraints.
  `aiTabsFor` dà `usage` solo con `usage.view`, le altre solo con
  `ai_providers.manage` o `settings.manage`.
  `administersSomething` conta `git_accounts.manage`, mai `git_accounts.view`
  (*ruling del controller (pre-flight)*): il preset User lo dà a tutti, e
  contarlo chiamerebbe «Administration» la voce del profilo di ogni utente
  (rompe `People.test.tsx`, Marco).
- `ACTIONS` aggiunge `manageAiProviders` (`ai_providers.manage`),
  `manageGitAccounts` (`git_accounts.manage`), `managePlugins`
  (`plugins.manage`), `viewInstanceStatus` (`instance.status.view`).
- `ChangeObjectLink` aggiunge `{ to: "admin"; section: AdminSection; id?:
  string }` e `{ to: "server"; code: string }`.
- `changeTypes.ts` registra i tipi dei Task 3–7 (tutti qui, così un task non
  scrive mai un tipo non registrato):
  - gruppo `ai`: `provider.created`, `provider.updated`,
    `provider.reordered`, `provider.credential_replaced`, `provider.deleted`
    (`ai_providers.manage`); `model.changed`, `automation.changed`,
    `budget.changed`, `content_language.changed` (`settings.manage`);
  - gruppo `integrations`: `git_account.created`, `.updated`,
    `.token_replaced`, `.deleted`, `.default_reviewer_changed`
    (`git_accounts.manage`); `plugin.registered`, `.ref_updated`,
    `.smoke_rerun`, `.removed` (`plugins.manage`); `google_app.created`,
    `.updated`, `.secret_replaced`, `.deleted` (`integrations.manage`);
    `storage.changed`, `storage.secret_replaced`, `webhook.changed` (con
    l'URL nel prima/dopo) (`settings.manage`);
  - gruppo `servers`: `server.created`, `.updated`, `.deleted`,
    `.agent_key_regenerated`, `.thresholds_changed`, `.check_changed`,
    `.ssh_access_changed` (`monitor.manage`). *Scelta del controller*: le voci
    SSH le legge chi gestisce il monitor, che vede tutti i server; chi ha solo
    `servers.ssh.manage` non le legge senza `changelog.view`;
  - gruppo `queue`, di **progetto**: `queue.paused`, `queue.resumed`,
    `job.retried` (`settings.manage`).

  `GROUP_ORDER` diventa `[…9a, "ai", "integrations", "servers", "queue"]`.
- `REAUTH_REQUIRED` aggiunge: `instance.createProvider`,
  `instance.replaceProviderCredential`, `instance.deleteProvider`,
  `instance.createGitAccount`, `instance.replaceGitToken`,
  `instance.deleteGitAccount`, `instance.registerPlugin`,
  `instance.updatePluginRef`, `instance.createGoogleApp`,
  `instance.replaceGoogleSecret`, `instance.deleteGoogleApp`,
  `instance.saveStorage` (solo con una chiave nuova: la funzione chiede la
  riconferma quando `secretAccessKey` c'è). `instance.saveWebhook` **non** c'è
  (maintainer, 30 ott 2026: l'URL non è un segreto).

Seme (`seed.ts`, dal design «Dati finti»):
- provider: «Team Max» (abbonamento, settimana 41%), «Backup Max»
  (abbonamento, settimana 87%: vicino alla soglia), «Billing key» (chiave
  API, abilitata, ultima). *Scelta del controller*: la chiave c'è perché le
  sessioni del seme (`seed/runs.ts`) la nominano già;
- modelli: `fix_plan` = `opus` come impostazione; `mail_classify` = `haiku`
  da env (`ENV_MODELS`); il resto di default;
- automazione: bug con auto-fix fino a effort 2, feature e activity spente;
  revisione delle PR accesa, tetto 2 $;
- budget 600 $ al mese, lingua dei contenuti `en`;
- account git: «Bitbucket Audin» (workspace `audin`) e «GitHub Stubwise»
  (revisore predefinito); i repository del seme si legano a uno dei due;
- plugin: `superpowers` `ready` con inventario, `lint-helpers` `failed` con
  l'errore;
- app Google: quelle di oggi in `state.googleWorkspaces`, con client id e una
  chiave;
- archiviazione S3 configurata, allegati accesi;
- webhook Slack acceso su 4 eventi;
- coda di STW in pausa da Roberta, ieri alle 18:00;
- un lavoro fallito ieri: una sessione `task_run` di ACQ con `outcome:
  "failed"` e il suo `failureSummary` (si aggiunge a `seed/runs.ts` se il
  seme non ne ha una di ieri).

Test (`instance.test.ts`):
- [ ] Voci e sezioni per permesso:
  - il full admin vede tutte le voci, in tre gruppi;
  - una persona a cui il test dà il ruolo Auditor (`au-1`: `usage.view` +
    `changelog.view`; nel seme non ce l'ha nessuno) vede solo AI, con la
    sola scheda Usage, più Git accounts dal preset User — *ruling del
    controller (pre-flight)*;
  - Sara (User, quindi con `git_accounts.view` dal preset, senza
    concessioni) vede fra le voci 9b solo Git accounts, in sola lettura, e
    `administersSomething` resta falso; con `git_accounts.manage` diventa
    vero — *ruling del controller (pre-flight)*;
  - Giulia (Project Lead) vede Repositories; Sara (Contributor, senza
    `repos.manage`) non la vede — *ruling del controller (pre-flight)*;
  - Claude non vede nessuna voce 9b.
- [ ] Ogni tipo registrato qui ha frase e gruppo in en e it (riusa il test del
  9a in `Audit.test.tsx`, che li enumera).
- [ ] Claude non legge nessuna voce dei gruppi `ai`, `integrations`,
  `servers`, `queue`.
- [ ] `storeProvidedSecret` restituisce le ultime 4 cifre e non il valore; il
  valore è in `__secretValuesForTest()`.
- [ ] Il registro della riconferma: `REAUTH_REQUIRED` è l'elenco del 9a più
  quello scritto sopra (test di `reauth.test.ts`).
- [ ] Istanza vuota: dopo `resetToEmptyInstance()`, `instance` è vuoto come
  dicono le Global Constraints; `resetApi()` torna al seme.
- [ ] Commit `feat(desktop): stato d'istanza, voci e segreti del 9b`.

### Task 2: Consumi — livello dati

**Files:** Create `data/instance/usage.ts` e `data/seed/usage.ts`, con il test `data/instance/usage.test.ts`. Modify `data/instance/index.ts`, `data/queries/instance.ts` (nuovo), `data/queries.ts` (`export * from "./queries/instance"`, *ruling del controller (pre-flight)*).

**Interfaces, prodotte:**

```ts
// UsageRecord è del Task 1 (data/instance/state.ts).
export type UsageDimension = "day" | "model" | "project" | "provider" | "operation";
export type UsageRange = { days: 7 | 30 | 90 } | { month: true } | { from: string; to: string };
export interface UsageRow { key: string | null; label: string; costUsd: number; tokens: number; runs: number }
export interface UsageView { totals: { costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; runs: number }; byDay: { day: string; costUsd: number }[]; rows: (UsageRow & { children: UsageRow[] })[] }
export function getUsage(input: { range: UsageRange; groupBy: UsageDimension; thenBy?: UsageDimension }): Promise<UsageView>; // usage.view, altrimenti forbidden
export function spentThisMonthUsd(): number;      // per il budget (Task 3), tutti i progetti
export function recordUsage(r: Omit<UsageRecord, "id">): void; // per il Task 6
```

- Il seme copre 90 giorni, deterministico (`seededRandom`): una voce per ogni
  sessione di `seed/runs.ts` con le sue cifre, più voci sintetiche per le
  operazioni notturne, i report, la classificazione della posta e la chat.
  Il mese in corso resta sotto il budget del seme (circa 410 $ su 600).
- R-G5: le voci di progetti che chi guarda non vede diventano una riga sola,
  `key: "other"`, «Other projects»; con `groupBy` diverso da `project` contano
  nei totali senza rivelare niente.
- I `label` di modello, provider e operazione sono nomi; le parole delle
  operazioni le mette la UI (`usage.operations.<op>`).

Test:
- [ ] Totali di 7, 30, 90 giorni e del mese, con `now()` fermo: somme esatte
  su un seme piccolo costruito nel test.
- [ ] `groupBy: "project"` per Sara: solo i suoi progetti, più «Other
  projects»; nessun codice d'altri nella risposta serializzata (RF 2).
- [ ] `thenBy` dà i figli e la loro somma è la riga.
- [ ] Senza `usage.view` → `forbidden`; `failNext`.
- [ ] Commit `feat(desktop): consumi d'istanza nel livello dati`.

### Task 3: AI — livello dati

**Files:** Create `data/instance/{providers.ts,models.ts,automation.ts,budget.ts}`, con il test `data/instance/ai.test.ts`.

**Interfaces, prodotte** (le scritture rispondono `InstanceResult`; +R come
nel Task 1):
- **Providers** (`ai_providers.manage`; lettura anche con `settings.manage`):
  - `listProviders(): Promise<ProviderView[]>`, con `ProviderView = Omit<AiProvider, "secretId" | "quota"> & { position: number; quota: QuotaView | null }`
  - `QuotaView = { fiveHourPct: number; weeklyPct: number; readAt: string; band: "ok" | "near" | "limited"; limitedUntil: string | null }`: `limited` se `limitedUntil > now()`, `near` da `QUOTA_NEAR_PCT = 80`. La soglia di sfondo `BACKGROUND_WEEKLY_THRESHOLD = 90` (deploy-log) si mostra come riga.
  - `createProvider({ name; kind; credential })` **+R**
  - `setProviderEnabled(id, enabled)`
  - `moveProvider(id, toIndex)`
  - `testProvider(id): InstanceResult<{ outcome: TestOutcome }>`, con l'esito da `simulateNextTest(target: string, outcome)` (default `ok`)
  - `replaceProviderCredential(id, credential)` **+R**
  - `deleteProvider(id)` **+R**
  - Disabilitare o eliminare l'ultimo provider abilitato →
    `invalid: "last_enabled_provider"` (*scelta del controller*: un'istanza
    senza AI non è uno stato che il prototipo deve reggere).
  - `pickProvider(): RunProvider | null`: il primo abbonamento abilitato e
    non al limite, nell'ordine; la chiave API solo se nessun abbonamento è
    abilitato (D3).
  - `RunProvider` (`data/model.ts`) prende `id?: string`, l'id
    dell'`AiProvider`, e `subscription` diventa `kind: "account"`. Così
    `recordUsage` ha il `providerId` (*ruling del controller (pre-flight)*).
- **Models** (`settings.manage`):
  - `listModels(): Promise<{ operation: AiOperation; group: AiOperationGroupKey; model: AiModelChoice; source: "setting" | "env" | "default" }[]>`, solo `CONFIGURABLE_AI_OPERATIONS`
  - `setModel(operation, model: AiModelChoice | null)` (`null` = torna a env o default)
  - `modelFor(operation: AiOperation): { model: AiModelChoice; source: "setting" | "env" | "default" }`
  - `DEFAULT_MODELS`: `haiku` per `daily_report`, `commit_summary`, `summary`; `sonnet` per il resto.
- **Automation** (`settings.manage`):
  - `getAutomation()`
  - `saveAutomation({ rules; prReview })`: `invalid` per un costo negativo o un effort fuori da 1–5. Una voce sola per salvataggio, con prima e dopo delle righe cambiate.
- **Budget e lingua** (`settings.manage`):
  - `getBudget(): Promise<{ monthlyUsd: number | null; spentUsd: number; reached: boolean; contentLanguage: "en" | "it" }>`, con `reached = simulate.budgetReached || (monthlyUsd !== null && spentUsd >= monthlyUsd)`
  - `saveBudget({ monthlyUsd; contentLanguage })`: voci separate per budget e lingua
  - `simulateBudgetReached(on: boolean)`: riquadro «Prototype only», senza voce
  - `budgetReached(): boolean`, per il Task 5.

Test:
- [ ] Ogni scrittura senza permesso → `forbidden`, stato invariato, nessuna
  voce; ogni +R senza riconferma → `reauth_required`.
- [ ] RF 1: dopo `createProvider` e `replaceProviderCredential`, nessuna
  lettura, voce o notifica contiene la chiave; la voce dice «replaced».
- [ ] Catena: `moveProvider` cambia `pickProvider()`; con Team Max e Backup
  Max al limite `pickProvider()` è `null` e non «Billing key» (RF 4);
  disabilitati entrambi, è «Billing key».
- [ ] RF 4: l'ultimo abilitato non si disabilita né si elimina, con la frase.
- [ ] `testProvider` dà l'esito simulato e lo salva in `lastTest`.
- [ ] `modelFor`: `fix_plan` da impostazione, `mail_classify` da env,
  `triage` di default; `setModel(op, null)` torna alla fonte di prima.
- [ ] Budget: `reached` col simulatore e con `monthlyUsd` sotto lo speso;
  alzarlo lo spegne.
- [ ] Commit `feat(desktop): impostazioni AI nel livello dati`.

### Task 4: Integrazioni — livello dati

**Files:** Create `data/instance/{git.ts,plugins.ts,google.ts,storage.ts,webhook.ts}`, con i test `data/instance/integrations.test.ts` e `plugins.test.ts`. Modify `data/me/google.ts` (legge le app con la forma nuova).

**Interfaces, prodotte:**
- **Git accounts** (lettura `git_accounts.view` o `.manage`, scrittura `.manage`):
  - `listGitAccounts(): Promise<GitAccountView[]>`, con `GitAccountView = Omit<GitAccount, "secretId"> & { repositories: { name: string; projectCode: string }[]; hiddenRepositories: number }`
  - `createGitAccount({ name; provider; workspace; token })` **+R**: `invalid: "workspace"` per Bitbucket senza workspace
  - `updateGitAccount(id, { name?; workspace? })`
  - `replaceGitToken(id, token)` **+R**
  - `validateGitAccount(id)`, con l'esito simulato
  - `deleteGitAccount(id)` **+R**: `in_use` con i repository visibili e `hiddenCount`
  - `setDefaultReviewer(id, on): InstanceResult<{ replaced: string | null }>`: uno per ambito (provider + workspace); ne sostituisce un altro e lo dice.
- **Plugins** (`plugins.manage`):
  - `listPlugins()`, `getPlugin(id)`
  - `registerPlugin({ url; ref; subdir; trusted: true })` **+R**:
    - `invalid: "not_trusted"` senza `trusted: true` (la casella «Mi fido di
      questo repository e di questo commit», **confermata dal maintainer il
      30 ott 2026**), controllato prima della riconferma come ogni
      `invalid`;
    - `invalid` per un URL non `https`, con credenziali o non pubblico;
    - `invalid: "slug"` se lo slug non rispetta `^[a-z0-9][a-z0-9-]{0,63}$`;
    - `invalid: "duplicate"` per un URL già registrato.
  - `updatePluginRef(id, { ref; trusted: true })` **+R**, con lo stesso
    `invalid: "not_trusted"`; `rerunSmoke(id)`, `removePlugin(id)` (senza
    casella: non eseguono codice nuovo)
  - `simulateNextPluginOutcome(outcome: "ready" | "failed")`
  - Ciclo: `materializing` → dopo `PLUGIN_STEP_MS = 800` `ready` (con `sha`,
    inventario e smoke `running` → `passed`) o `failed` (con `error`). Il
    timer è annullato da `resetApi` (generazione dello store), come gli
    script delle conversazioni.
- **Google Workspace** (`integrations.manage`):
  - `listGoogleApps()`
  - `createGoogleApp({ name; domains; clientId; clientSecret })` **+R**: `invalid` per un dominio malformato o già di un'altra app
  - `updateGoogleApp(id, { name?; domains?; clientId? })`
  - `replaceGoogleSecret(id, secret)` **+R**
  - `deleteGoogleApp(id)` **+R**: `in_use` se ci sono caselle collegate (le persone che chi guarda vede, per nome; le altre contate)
- **Storage** (`settings.manage`):
  - `getStorage()`
  - `saveStorage({ endpoint; region; bucket; accessKeyId; secretAccessKey?: string })`: **+R** solo con `secretAccessKey`
  - `setAttachments(on)`, `testStorage()`
  - `storageAllowsUploads(): boolean`, per il Task 6: vero se configurato, allegati accesi e l'ultima prova non fallita.
- **Webhook** (`settings.manage`):
  - `WEBHOOK_EVENTS: readonly { id: string; source: "web" | "catalog" }[]`: i 13 del web (`ticket.created`, `job.pr_opened`, `job.pr_closed`, `job.held`, `job.plan_review`, `job.budget_held`, `review.completed`, `job.failed`, `docs.limit_paused`, `monitor`, `job.awaiting_input`, `project.pulse`, `project.brief`) più 8 del catalogo 8a/8b (`release.merged`, `release.succeeded`, `release.failed`, `pr.analysis_issues`, `docs.release_note`, `task.created_by_automation`, `support.request`, `server.diagnosis_ready`), 21 in tutto, come la tabella dello shape `admin-integrations.md` (**confermata dal maintainer il 30 ott 2026**). `monitor` copre anche `server.trouble`, `server.down`, `server.recovered`. Esclusi: `pr.opened`, `task.created`, `pr.corrected`, **`support.customer_replied`** (le risposte dei clienti non escono col webhook, maintainer), `google.proposal`, posta, `security.alert`
  - `getWebhook()`: con `url` in chiaro, come sul web (maintainer, 30 ott 2026)
  - `saveWebhook({ enabled; format; url: string | null; events })`: senza riconferma; `invalid: "url"` per un URL non `https`, o mancante con `enabled`; la voce `webhook.changed` ha l'URL nel prima/dopo
  - `testWebhook()`, con l'esito simulato
  - `previewWebhook(eventId, format): string`: il messaggio d'esempio, come la `LivePreview` del web.

Test:
- [ ] `forbidden` e `reauth_required` per ogni scrittura, come nel Task 3.
- [ ] RF 1 su token git, client secret e chiave S3.
- [ ] `saveWebhook` con un URL nuovo e nessuna riconferma recente va a buon
  fine; `getWebhook()` restituisce l'URL salvato.
- [ ] RF 2: eliminare «Bitbucket Audin» da Sara-con-`git_accounts.manage`
  (concessione nel test) → `in_use` con i repository dei suoi progetti e
  `hiddenCount` per gli altri, senza nomi.
- [ ] Revisore predefinito: impostarlo su un secondo account dello stesso
  ambito sostituisce il primo; su un altro ambito convivono.
- [ ] Plugin (`plugins.test.ts`, timer finti):
  - registrato → `materializing`; dopo 800 ms `ready` con inventario e
    smoke `passed`;
  - con `failed` simulato → `failed` con l'errore;
  - `resetApi` a metà non fa arrivare la transizione;
  - URL `http://`, `https://user:pw@…`, `git@…` → `invalid`;
  - `registerPlugin` e `updatePluginRef` senza `trusted: true` →
    `invalid: "not_trusted"`, nessun plugin nuovo né cambiato, nessuna
    voce, e nessuna riconferma chiesta.
- [ ] Un'app Google nuova compare in `listMyMailboxes()` fra quelle da
  collegare; un'app con caselle non si elimina.
- [ ] `storageAllowsUploads()` falso con gli allegati spenti o dopo una prova
  fallita.
- [ ] Webhook: `WEBHOOK_EVENTS` ha esattamente i 21 eventi dello shape
  (13 `web`, 8 `catalog`); nessun evento di posta, né `google.proposal`, né
  `support.customer_replied`; `previewWebhook` per Slack, Discord e JSON.
- [ ] Commit `feat(desktop): integrazioni d'istanza nel livello dati`.

### Task 5: Coda e Stato dell'istanza — livello dati

**Files:** Create `data/instance/{queue.ts,status.ts,retry.ts}` e `data/seed/nightly.ts`, con il test `data/instance/queue.test.ts`. Modify `data/model.ts` (il tipo `AiBlock`), `data/instance/blocks.ts` (`aiBlockFor`, `queuePauseOf`: il modulo foglia del Task 1), `data/instance/budget.ts` (`saveBudget` e `simulateBudgetReached` chiamano `releaseBudgetHolds`). *Ruling del controller (pre-flight)*: `TaskWork` sta in `data/types.ts`, non in `data/model.ts`.

**Interfaces, prodotte:**

```ts
export type JobKind = "task_run" | "correction" | "pr_review" | "server_analysis" | "server_fix" | "automation" | "nightly";
// AiBlock sta in data/model.ts (lo usano Conversation e TaskWork) e queue.ts lo riesporta:
// export type AiBlock = { reason: "monthly_budget" } | { reason: "queue_paused"; byId: string; byName: string; since: string };
export function aiBlockFor(projectId: string | null): AiBlock | null; // il budget vale ovunque, la pausa solo per un progetto
export function queuePauseOf(projectId: string): QueuePause | null;
/**
 * Un lavoro che partirebbe ma è fermo: su una coda in pausa (ogni avvio del
 * progetto) o per il budget (solo i passi d'automazione, decisione del
 * maintainer del 30 ott 2026). `start` lo fa partire quando il blocco cade.
 */
export interface HeldJob { id: string; projectId: string; kind: Exclude<JobKind, "nightly">; taskId: string | null; conversationId: string | null; automationRunId: string | null; starterId: string; block: AiBlock; since: string; start: () => Promise<void> }
export function holdJob(job: Omit<HeldJob, "id" | "since">): HeldJob;
/** ruling del controller (pre-flight): Stop su un lavoro in attesa (EF 2) lo toglie dalla lista. Anche `start` riparte solo se la sessione è ancora in attesa. */
export function dropHeld(conversationIdOrRunId: string): void;
/** Fa ripartire i lavori fermi per budget, se `budgetReached()` è falso; altrimenti non fa niente. */
export function releaseBudgetHolds(): void;
// ruling del controller (pre-flight): `code` (task «ACQ-57», esecuzione «ACQ-A2 #7», server «SRV-2») al posto di `taskCode`; niente `provider_limit` (nessuno lo produce).
export interface InstanceJob { id: string; kind: JobKind; projectId: string; projectCode: string; title: string; code: string | null; state: "running" | "waiting" | "failed"; waiting: AiBlock | null; since: string; workerId: "worker-1" | "worker-2" | null; retry: ActionAvailability; href: string | null }
export interface InstanceStatusView {
  queues: { projectId: string; code: string; name: string; paused: { byName: string; at: string } | null; running: number; waiting: number; failed: number; pause: ActionAvailability }[];
  otherProjects: { running: number; waiting: number; failed: number } | null;
  jobs: InstanceJob[];
  /** ruling del controller (pre-flight): `hidden` = occupato in un progetto che chi guarda non vede, e allora `jobId` è null (R-G5). */
  workers: { id: "worker-1" | "worker-2"; jobId: string | null; hidden: boolean }[];
  quota: { providerId: string; name: string; quota: QuotaView }[];
  errors: { jobId: string; at: string; summary: string; href: string | null }[];
  refreshedAt: string;
}
export function getInstanceStatus(): Promise<InstanceStatusView>; // instance.status.view o settings.manage
export function retryJob(jobId: string): Promise<InstanceResult<{ conversationId: string }>>;
export function pauseQueue(projectId: string): Promise<InstanceResult>;
export function resumeQueue(projectId: string): Promise<InstanceResult>;
```

- I lavori si leggono da ciò che c'è (design «Il lavoro nella coda»):
  - sessioni `task_run` vive o fallite negli ultimi 7 giorni (`correction` se
    la fase corrente è una correzione);
  - `pr_review`, `server_analysis`, le correzioni dei server;
  - le esecuzioni delle automazioni che aspettano Claude, comprese quelle
    con un passo fermo per budget (`waiting: { reason: "monthly_budget" }`);
  - i lavori di `holdJob`, `waiting` col loro `block`;
  - `NIGHTLY_ROWS` del seme, solo da guardare.
- Il seme `NIGHTLY_ROWS` (`data/seed/nightly.ts`) ha 4 righe della notte
  scorsa (una `failed`) e va in `instance.nightly`.
- I due worker prendono i due lavori `running` più vecchi.
- I lavori fermi di `holdJob` stanno in una lista del modulo, fuori dallo
  stato clonabile (contengono funzioni), svuotata da `onStoreReset`.
- Quando un blocco cade, i lavori ripartono nell'ordine d'arrivo, ognuno
  una volta. Prima di `start` si rilegge `aiBlockFor`: se un altro blocco
  vale ancora (budget sbloccato ma coda in pausa, o il contrario), il
  lavoro resta in lista col blocco nuovo e il suo posto. Il budget cade
  solo con `releaseBudgetHolds`, che `saveBudget` e
  `simulateBudgetReached(false)` chiamano dopo la scrittura. Gli altri
  salvataggi non lo chiamano, e lui non fa niente se il budget è ancora
  raggiunto.
- R-G5: i lavori di progetti che chi guarda non vede stanno solo in
  `otherProjects`, coi conteggi (*scelta del controller*, come «Other
  projects» dei consumi).
- `retryJob`:
  - chiede `settings.manage` **e** `runs.start` nel progetto (**confermato
    dal maintainer il 30 ott 2026**). Chi riprova è chi avvia, a suo nome,
    e il gate del piano vale come per «Avvia»;
  - solo su un `task_run` fallito: altrimenti `unavailable` nella vista e
    `invalid: "not_retryable"` alla scrittura. Una correzione ferma non si
    tocca (`pr-corrections.md`);
  - passa da `startRunAs` del livello dati; un lavoro vivo nel frattempo →
    `conflict`;
  - scrive `job.retried`.
- `pauseQueue` / `resumeQueue`:
  - chiedono `settings.manage` su un progetto visibile;
  - una pausa già messa → `invalid: "already_paused"`;
  - alla ripresa i lavori fermi per la pausa di quel progetto ripartono
    con la regola qui sopra;
  - scrivono `queue.paused` / `queue.resumed`.
- Nessuna delle due funzioni tocca server, ambienti o processi (§9 dei
  follow-up).

Test:
- [ ] Lo stato del seme: STW in pausa da Roberta, un lavoro fallito ieri fra
  gli errori col link alla task, i due worker, la quota dei tre provider.
- [ ] RF 2: Sara con `instance.status.view` (concessione nel test) non trova
  codici o titoli di progetti che non vede; le loro righe sono in
  `otherProjects`.
- [ ] RF 3: con STW in pausa, `holdJob` di due lavori, poi `resumeQueue` →
  partono nell'ordine, ognuno una volta; `resetApi` prima della ripresa →
  non parte niente.
- [ ] Un lavoro in attesa fermato con Stop (`dropHeld`) non parte alla
  ripresa; l'altro sì (*ruling del controller (pre-flight)*).
- [ ] RF 4, «alzare il budget fa ripartire i passi fermi»: col budget
  raggiunto, due lavori `holdJob` con `monthly_budget`; `saveBudget` con un
  budget sopra lo speso → ripartono nell'ordine, ognuno una volta, e
  spariscono dai `waiting` di `getInstanceStatus()`. Lo stesso con
  `simulateBudgetReached(false)`.
- [ ] RF 4, «senza modifiche al budget restano fermi»: col budget raggiunto,
  `saveBudget` che cambia solo la lingua, `saveBudget` con un budget ancora
  sotto lo speso, `advanceNow` di un giorno e `releaseBudgetHolds()`
  chiamato a mano → nessuno riparte, e lo Stato dell'istanza li mostra
  ancora fermi per budget.
- [ ] Due blocchi: un lavoro fermo per budget in STW in pausa; alzato il
  budget resta fermo, ora per la pausa; `resumeQueue` lo fa partire.
- [ ] RF 5: Retry su una correzione ferma → `not_retryable`; su una task con
  un lavoro vivo → `conflict`; con `settings.manage` ma senza `runs.start`
  → `forbidden`; Marco (Developer in ACQ: `runs.start` senza
  `plans.approve`), con una concessione di `settings.manage` nel test,
  riprova → la sessione si ferma al gate del piano (*ruling del controller
  (pre-flight)*: Laura è Project Lead e ha `plans.approve`).
- [ ] `aiBlockFor`: budget raggiunto ovunque; pausa solo in STW, col nome di
  chi l'ha messa anche dopo averla disattivata.
- [ ] Voci `queue.paused`, `queue.resumed`, `job.retried` leggibili da chi
  gestisce STW, non da chi non lo vede.
- [ ] Commit `feat(desktop): coda e stato dell'istanza nel livello dati`.

### Task 6: Gli effetti visibili nelle altre aree

**Files:**
- Modify:
  - `data/api-mutations.ts` (`openRun`, `startRunAs`, `relaunchWithInstructions`, `resumeCorrection`, la richiesta di modifiche, `sendMessage` di una conversazione libera);
  - `data/servers/analysis.ts` e `fix.ts` (l'avvio);
  - `data/automations/runner.ts` (il passo che avvia Claude);
  - `data/drive/writes.ts` (`uploadFiles`) e gli allegati del composer;
  - il punto in cui una sessione passa a `finished` (`recordUsage`);
  - `data/model.ts` (`Conversation.model?: string`, `Conversation.waiting?: AiBlock | null`) e `data/types.ts` (`TaskWork.blocked: AiBlock | null`; *ruling del controller (pre-flight)*: `TaskWork` sta lì);
  - `data/queries/instance.ts`: `useAiBlock(projectId)` (testata della colonna, «Chiedi a Claude», automazioni) e `useStorageAllowsUploads()` (Drive, composer) — *ruling del controller (pre-flight)*;
  - le pagine dello shape `instance-effects.md`: `pages/task/ClaudeSection.tsx`, il composer di Claude, la testata della colonna del progetto (`layout/ProjectColumn.tsx`), la riga del progetto in «All projects», le esecuzioni delle automazioni, Drive;
  - i18n.
- Test: `data/instance/effects.test.ts`, `pages/task/ClaudeSection.test.tsx`, `pages/drive/*.test.tsx`, `layout/Column.test.tsx` (la testata di `ProjectColumn`), `pages/projects/AllProjectsPage.test.tsx` e un test delle esecuzioni delle automazioni in `pages/automations/` (*ruling del controller (pre-flight)*).

**Interfaces:**
- Consumes: `aiBlockFor`, `holdJob` (Task 5); `modelFor`, `pickProvider`, `budgetReached` (Task 3); `recordUsage` (Task 2); `storageAllowsUploads` (Task 4).
- Produces: `OPERATION_OF_KIND: Record<ConversationKind, AiOperation>` in `data/instance/models.ts`:
  - `task_run` → `fix_plan`, poi `fix_execute` all'esecuzione;
  - `pr_review` → `pr_review`;
  - `docs` → `docs_generation`;
  - `brief` → `weekly_brief`;
  - `daily_report` → `daily_report`;
  - `mail_classify` → `mail_classify`;
  - `intake` → `backlog_intake`;
  - `refine` → `backlog_refine`;
  - `free` → `chat`;
  - `server_analysis` → `fix_plan` (*scelta del controller*: non c'è
    un'operazione del web per l'analisi dei server).

Regole:
- **Budget raggiunto:**
  - «Avvia», «Rilancia con indicazioni», «Chiedi modifiche», «Riprendi la
    correzione» (*ruling del controller (pre-flight)*), l'avvio
    dell'analisi e della correzione di un server → `invalid:
    "monthly_budget"`;
  - `TaskWork.blocked` lo dice prima, e il bottone è spento con la frase e il
    «Who?» di `manageSettings`;
  - «Chiedi a Claude» (conversazione libera) rifiuta il messaggio col motivo
    in parole;
  - un passo d'automazione che avvierebbe Claude **resta fermo**, non
    fallisce (maintainer, 30 ott 2026, come il `budget_held` del web):
    - l'esecuzione resta viva al confine di quel passo, con una nota nel
      suo registro («Waiting: monthly AI budget reached»);
    - `holdJob` la registra con `block: { reason: "monthly_budget" }`;
    - riparte da quel passo quando `releaseBudgetHolds` fa cadere il
      blocco, una volta sola;
    - la pagina dell'esecuzione e lo Stato dell'istanza la mostrano ferma
      per budget;
    - lo stato dell'esecuzione resta `running`, con una voce di registro
      `outcome: "waiting"` e un reason code. Non è in «Needs attention», e
      «Pass time» non la sblocca (*ruling del controller (pre-flight)*,
      shape EF 6);
  - il lavoro già partito continua.
- **Coda in pausa:**
  - gli stessi avvii (e la review di una PR, dove il prototipo la avvia;
    «Riprendi la correzione» compresa, *ruling del controller
    (pre-flight)*), in un progetto in pausa, **non** sono rifiutati: la
    sessione nasce con `waiting = { reason: "queue_paused", … }`, senza
    eventi, e `holdJob` la fa partire alla ripresa;
  - Stop su una sessione in attesa chiama `dropHeld`: non parte più alla
    ripresa (*ruling del controller (pre-flight)*, EF 2);
  - ogni task del progetto dice «Queue paused by Roberta» in
    `TaskWork.blocked` (con «Start» acceso); quella in attesa dice
    «Waiting: queue paused by Roberta»;
  - la testata della colonna del progetto dice «‖ Queue paused by Roberta
    Fontana» sotto il tipo, col «Who?» di `manageSettings`, e la riga del
    progetto in «All projects» porta «‖ Queue paused» sulla seconda linea
    (**confermata dal maintainer il 30 ott 2026**, shape
    `instance-effects.md` [EF 4]); le tessere del rail non cambiano;
  - un secondo «Avvia» è `conflict`, perché la sessione è viva;
  - le automazioni del progetto aspettano allo stesso modo;
  - la conversazione libera («Chiedi a Claude») non è nella coda di un
    progetto: la pausa non la tocca (**confermato dal maintainer il 30 ott
    2026**), la ferma solo il budget.
- **Modello e provider:**
  - `openRun` scrive `provider: pickProvider()` (non più `TEAM_ACCOUNT`) e
    `model: modelFor(op).model`;
  - con `pickProvider()` nullo (istanza vuota, abbonamenti tutti al
    limite) la sessione parte lo stesso con `provider: null`: nessuna
    attesa, nessuno stato `provider_limit` (*ruling del controller
    (pre-flight)*);
  - a fine sessione `recordUsage` registra i consumi con quel modello;
  - la sezione Claude della task mostra modello e account.
- **Archiviazione:** senza `storageAllowsUploads()`, il caricamento nel
  Drive e gli allegati sono spenti con la frase dello shape, e
  `uploadFiles` → `invalid: "storage_off"`.

Test:
- [ ] Budget (simulato): «Start» della task spento con la frase e «Who?»;
  `startRun` → `monthly_budget`; una sessione in corso finisce; alzato il
  budget, «Start» torna.
- [ ] Coda in pausa (STW): «Start» → la task dice «Waiting: queue paused by
  Roberta Fontana»; `resumeQueue` → la sessione parte e il piano arriva.
- [ ] Coda in pausa (STW): la testata della colonna di STW dice «Queue paused
  by Roberta Fontana» con «Who?», e la riga di STW in «All projects» dice
  «Queue paused»; ACQ (non in pausa) non dice niente; dopo `resumeQueue` le
  due righe spariscono.
- [ ] Un'automazione di STW con un passo di Claude aspetta la ripresa.
- [ ] Budget raggiunto, un'automazione di ACQ con un passo di Claude:
  l'esecuzione non fallisce, resta ferma a quel passo con la frase, ed è fra
  i lavori fermi per budget dello Stato dell'istanza; alzato il budget
  riparte da quel passo e finisce; senza modifiche al budget resta ferma.
- [ ] «Chiedi a Claude» con STW come contesto, coda in pausa: Claude
  risponde; col budget raggiunto il messaggio è rifiutato con la frase.
- [ ] `setModel("fix_plan", "haiku")`, poi «Start» → la sezione Claude dice
  Haiku, e alla fine i consumi della task e quelli d'istanza (`groupBy:
  "model"`) lo contano.
- [ ] Team Max disabilitato → una sessione nuova gira con «Backup Max».
- [ ] Allegati spenti → il Drive dice che non si può caricare.
- [ ] La suite delle aree 2–9a resta verde.
- [ ] Commit `feat(desktop): le impostazioni d'istanza hanno effetto`.

### Task 7: Server e repository d'istanza — livello dati

**Files:**
- Modify:
  - `data/servers/reads.ts` (`listAllServers`, `MetricRange`);
  - `pages/servers/MetricsCharts.tsx`: solo le voci `30d`/`90d` di `RANGE_MS`, perché il typecheck regga a questo commit; `RANGES` resta al Task 12 (*ruling del controller (pre-flight)*);
  - `data/servers/monitor.ts` e `access.ts` (`createServer` senza ambiente, `recordChange` in ogni scrittura);
  - `data/servers/visibility.ts` (`ServerDetail` senza progetto);
  - `data/seed/servers/metrics.ts` (90 giorni).
- Create `data/instance/repositories.ts`.
- Test: `data/servers/servers.test.ts`, `data/instance/repositories.test.ts`.

**Interfaces, prodotte:**
- `listAllServers(): Promise<(ServerRow & { projects: { code: string; name: string }[]; orphan: boolean })[]>` (`monitor.manage`, altrimenti `forbidden`): tutti i server, i progetti solo se visibili, gli orfani (R-L7).
- `CreateServerInput.environmentId: string | null`: `null` solo da Amministrazione, con `monitor.manage`; il server nasce orfano, senza progetto principale. Da Amministrazione un server nasce **sempre** senza progetto (**confermata dal maintainer il 30 ott 2026**): il dialogo non offre ambienti, e lo si collega dagli ambienti del progetto.
- `type MetricRange = "1h" | "24h" | "7d" | "30d" | "90d"`. Il seme copre `METRIC_DAYS = 90`: passo di 30 s negli ultimi 7 giorni, `METRIC_COARSE_STEP_SECONDS = 900` prima. I grafici restano sotto `METRIC_POINTS_MAX`.
- `listAllRepositories(): Promise<{ projectId: string; projectCode: string; projectName: string; repositories: { id: string; name: string; fullName: string | null; gitAccountName: string | null; href: string }[] }[]>`:
  - per chi ha `repos.manage` in almeno un progetto;
  - elenca i progetti dove chi guarda ha `repos.view`;
  - `href` porta a `#/p/<CODE>/settings/repositories`.
- Le scritture dell'8b scrivono le voci `server.*` del Task 1.

Test:
- [ ] Roberta vede tutti i server, compresi gli orfani; Marco (senza
  `monitor.manage`) → `forbidden`; un monitor-manager che non vede AUD non
  trova AUD nella colonna (RF 2).
- [ ] `createServer({ environmentId: null })` → orfano, visibile solo a
  `monitor.manage`; dal progetto resta come nell'8b.
- [ ] 30d e 90d: punti ≤ `METRIC_POINTS_MAX`, il primo punto di 90d ha più di
  89 giorni.
- [ ] Ogni scrittura dei server scrive la sua voce; una rifiutata no.
- [ ] Repository: raggruppati per progetto, solo i progetti con `repos.view`.
- [ ] Commit `feat(desktop): server e repository di tutta l'istanza`.

### Task 8: AI — UI (Providers, Models, Automation, Budget & language)

**Files:**
- Create:
  - `pages/admin/ai/{AiPage.tsx,ProvidersPanel.tsx,AddProviderDialog.tsx,ModelsPanel.tsx,AutomationPanel.tsx,BudgetPanel.tsx}`;
  - `components/SecretField.tsx`;
  - il test `pages/admin/ai/Ai.test.tsx`.
- Modify:
  - `pages/admin/AdminLayout.tsx` (`AdminSectionPage` e la colonna con i gruppi nuovi);
  - `router.tsx` (`/admin/ai?tab=`);
  - `data/queries/instance.ts`;
  - i18n.

Segue lo shape `admin-ai.md`. `SecretField` (riusato dai Task 10–11):
- in scrittura è un campo password con «Show»;
- salvato, mostra `•••• <last4>` e «Replace», che riapre il campo con la
  riconferma;
- il valore non passa mai da una query.

Test:
- [ ] Le schede per permesso (solo `aiTabsFor` e la barra delle schede; il
  contenuto di Usage è del Task 9, *ruling del controller (pre-flight)*):
  il full admin le vede tutte; una persona a cui il test dà il ruolo
  Auditor (`au-1`) ha la sola scheda Usage, quindi niente `tablist` e h1
  «AI»; chi ha solo `settings.manage` legge Providers senza azioni, coi
  bottoni spenti, la frase e il «Who?».
- [ ] Aggiunge un provider con la riconferma; dopo la navigazione il DOM non
  contiene la chiave (RF 1), solo le ultime 4.
- [ ] Riordina (tastiera e trascinamento, come lo shape), abilita, prova con
  l'esito scelto nel riquadro «Prototype only».
- [ ] L'ultimo abilitato: l'interruttore è spento con la frase (RF 4).
- [ ] Quota: «near» su Backup Max, in parole e non solo col colore.
- [ ] Models: la fonte di ogni valore; cambiato e riportato a default.
- [ ] Automation e Budget: salva, «Saved», errori sotto il campo; «Simulate
  budget reached» nel riquadro.
- [ ] Istanza vuota: Providers dice che non c'è nessun account.
- [ ] Commit `feat(desktop): impostazioni AI dell'istanza`.

### Task 9: Usage — UI

**Files:** Create `pages/admin/ai/UsagePanel.tsx`, con il test `pages/admin/ai/Usage.test.tsx`. Modify i18n (`usage.operations.<op>` per ogni `AiOperation`) e `router.tsx`: la chiave `range` (oggi `^(1h|24h|7d)$`) accetta anche `30d|90d|month|custom`, più le chiavi `from`, `to` e `then` (*ruling del controller (pre-flight)*).

Segue lo shape `admin-ai.md` (Usage), e la skill `dataviz` per la serie
per giorno.

Test:
- [ ] Periodo 7/30/90 giorni, mese, intervallo libero, nell'indirizzo.
- [ ] Totali; serie per giorno leggibile anche senza colore (valori al
  passaggio e in tabella).
- [ ] Tabella per dimensione; vista a due dimensioni con i figli.
- [ ] Sara (con `usage.view` nel test): «Other projects», nessun codice
  d'altri nel DOM (RF 2).
- [ ] Ogni operazione ha il suo nome in en e it.
- [ ] Commit `feat(desktop): consumi dell'istanza`.

### Task 10: Git accounts e Plugins — UI

**Files:** Create `pages/admin/integrations/{GitAccountsPage.tsx,GitAccountDialog.tsx,PluginsPage.tsx,PluginPage.tsx,RegisterPluginDialog.tsx}`, con il test `pages/admin/integrations/GitPlugins.test.tsx`. Modify `router.tsx` (`/admin/plugins/$pluginId`), i18n.

Segue lo shape `admin-integrations.md`.

Test:
- [ ] Git:
  - crea un account con il token (riconferma, poi solo le ultime 4);
  - valida, con l'esito simulato;
  - revisore predefinito, col toast che dice chi ha sostituito;
  - elimina un account in uso: il dialogo elenca i repository e «2 in
    projects you can't see». Il test gira come Sara con la concessione di
    `git_accounts.manage`, come nel Task 4: Roberta vede tutto
    (*ruling del controller (pre-flight)*).
- [ ] Con il solo `git_accounts.view`: elenco senza azioni, bottoni spenti con
  «Who?».
- [ ] Plugin:
  - il dialogo dice in parole che registrare esegue il codice;
  - «Register» è spento finché la casella «I trust this repository and
    this commit» non è spuntata; lo stesso in «Update to ref…»;
  - dopo la riconferma la riga è «Materializing», poi «Ready» (timer finti);
  - la pagina del plugin mostra skill e hook;
  - aggiorna a un ref, rilancia lo smoke, rimuovi;
  - con `failed` simulato, l'errore in parole.
- [ ] Commit `feat(desktop): account git e plugin dell'istanza`.

### Task 11: Google Workspace, Storage, Outgoing webhooks — UI

**Files:** Create `pages/admin/integrations/{GooglePage.tsx,GoogleAppDialog.tsx,StoragePage.tsx,WebhooksPage.tsx}`, con il test `pages/admin/integrations/GoogleStorageWebhooks.test.tsx`. Modify i18n.

Segue lo shape `admin-integrations.md`.

Test:
- [ ] Google: registra un'app (secret con la riconferma, poi le ultime 4);
  l'app compare in Preferenze → Account fra le caselle da collegare; un'app
  con caselle non si elimina, e il dialogo dice perché.
- [ ] Storage: salva, prova con l'esito simulato, allegati spenti, e la riga
  di stato di Storage lo dice. La frase del Drive resta un test del Task 6
  (*ruling del controller (pre-flight)*).
- [ ] Webhook:
  - formato e URL: salvato senza riconferma, riaprendo la pagina l'URL si
    rilegge in chiaro;
  - un interruttore per ognuno dei 21 eventi, nei sei gruppi dello shape;
    nessuna riga per le risposte dei clienti;
  - anteprima per formato;
  - invio di prova con l'esito simulato.
- [ ] RF 1 sul DOM dopo la navigazione, per i tre segreti.
- [ ] Commit `feat(desktop): Google, archiviazione e webhook dell'istanza`.

### Task 12: Servers e Repositories d'istanza — UI

**Files:**
- Create `pages/admin/instance/{ServersAdminPage.tsx,RepositoriesAdminPage.tsx}`, con il test `pages/admin/instance/Estate.test.tsx`.
- Modify:
  - `pages/servers/{ServerList.tsx,ServerDetail.tsx,MetricsCharts.tsx,NewServerDialog.tsx}` (colonna dei progetti, `projectCode: string | null`, `RANGES` con 30d e 90d, nuovo server senza ambiente);
  - `router.tsx` (`/admin/servers/$server`; la regex di `range` accetta anche `30d|90d`, *ruling del controller (pre-flight)*);
  - i18n.

Segue lo shape `admin-instance.md`.

Test:
- [ ] Tutti i server, con la colonna dei progetti e gli orfani; il dettaglio
  da Amministrazione è quello dell'8b.
- [ ] 30d e 90d nel dettaglio, anche dalla sezione di progetto.
- [ ] «New server» senza ambiente: chiave dell'agente in `SecretOnce`, la
  riga orfana.
- [ ] Il «New server» di Amministrazione chiama sempre `createServer` con
  `environmentId: null`: il dialogo non ha il campo dell'ambiente
  (spostato dal Task 7, *ruling del controller (pre-flight)*).
- [ ] Repositories per progetto, col link alla pagina del repository.
- [ ] Senza `monitor.manage` la voce Servers non c'è, e l'indirizzo è «not
  found».
- [ ] Commit `feat(desktop): server e repository dall'amministrazione`.

### Task 13: Instance status — UI

**Files:** Create `pages/admin/instance/{InstanceStatusPage.tsx,QueueTable.tsx}`, con il test `pages/admin/instance/InstanceStatus.test.tsx`. Modify `data/queries/instance.ts` (`refetchInterval: 10_000`), i18n, `router.tsx` (le chiavi dei filtri di WORK: stato, progetto, tipo; *ruling del controller (pre-flight)*).

*Ruling del controller (pre-flight)*: lo stato d'errore di questa pagina usa
«Load again» / «Ricarica» invece di «Riprova» (shape [IS 6], perché
`noDeploy` vieta «Riprova»). È l'eccezione dichiarata nelle Global
Constraints.

Segue lo shape `admin-instance.md`.

Test:
- [ ] Coda per progetto e tipo, con età e stato; i worker; la quota; gli
  ultimi errori col link.
- [ ] STW dice «Queue paused by Roberta Fontana»; Resume con conferma → la riga
  cambia, la voce è nel registro.
- [ ] Retry con conferma sul lavoro fallito di ieri → la task ha una sessione
  nuova, avviata da chi ha riprovato.
- [ ] Con il solo `instance.status.view`: Retry e Pause spenti con «Who?»;
  con `settings.manage` ma senza `runs.start` in quel progetto, Retry è
  spento con «Who?» di `startRun`.
- [ ] Budget raggiunto, un passo d'automazione fermo: la riga dice «Waiting:
  monthly AI budget reached»; alzato il budget da AI → Budget, dopo 10 s la
  riga non è più fra i lavori fermi.
- [ ] Aggiornamento: dopo un cambio fatto altrove, con i timer finti avanti
  di 10 s, la riga compare.
- [ ] RF 5: `expectNoDeploy()` in en e in it.
- [ ] Commit `feat(desktop): stato dell'istanza`.

### Task 14: Documenti, screenshot, follow-up

- `apps/desktop/docs/area9-parity.md`:
  - il titolo diventa «Area 9a e 9b»;
  - righe per tutte le voci C ed E di `area9-inventory.md` (voce, dove vive,
    test fra virgolette);
  - «Setup iniziale» passa a «fatto in 9a», «Sorgenti e webhook in arrivo» e
    «Accessi SSH» restano «fatti»;
  - le voci fuori col motivo (Slack, posta ammessa).
- `capture.mjs`, scatti `a9b-*`:
  - AI Providers e Models;
  - Usage;
  - Git accounts;
  - Plugin con inventario;
  - Webhooks con anteprima;
  - Servers d'istanza;
  - Instance status con STW in pausa;
  - la task di STW «Waiting: queue paused».

  Tutto a 1440 e 1024, chiaro e scuro, en e it. Vite ucciso.
- `ossatura-follow-ups.md`:
  - «Area 9b — minori aperti», con le scelte del controller di questo piano
    e, a parte, le quattro decisioni del maintainer del 30 ott 2026 (URL del
    webhook in chiaro, permessi di Retry, passi fermi per budget, pausa che
    non tocca «Chiedi a Claude»);
  - §9 riscritto come «costruita nel prototipo (9b), da riscrivere prima del
    motore», con le regole del Task 5 (cosa aspetta, cosa finisce, Retry
    solo su una sessione fallita e con `settings.manage` + `runs.start`);
  - per il motore: un passo d'automazione fermo per budget riparte da solo
    come il `budget_held` del web.
  - la voce «§9 dei follow-up» di «Area 9a — minori aperti» si chiude.
- `emptyInstance.test.tsx` copre le voci nuove (le rotte di
  `ADMIN_SECTIONS`).
- Suite, typecheck, lint e build verdi.
- Commit `docs(desktop): note dell'area 9b`.

Dopo il Task 14: revisione finale del branch (area 9b) e revisione visiva di
Impeccable.
