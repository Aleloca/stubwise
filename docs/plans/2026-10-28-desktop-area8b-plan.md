# App desktop, area 8b: server — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Costruire nel prototipo `apps/desktop` la seconda metà dell'area 8:
la sezione Servers del progetto portata dal web (elenco, dettaglio con
grafici, servizi, dischi, controlli, soglie, impostazioni, nuovo server e
chiave dell'agente); gli avvisi dei server nel catalogo dell'8a; l'analisi
automatica di Claude in **sola lettura** che apre una task con la diagnosi;
la correzione da task con `servers.operate` e piano **sempre** approvato;
i due accessi SSH (lettura e correzione) collegati dall'app.

**Architecture:** Regole pure in `domain/servers/` (salute e lavoro di un
server, stato di un accesso SSH, script da incollare, progetto dell'analisi,
cancello della correzione, controllo «nessun comando di correzione prima
dell'approvazione»), un modulo dati `data/servers/*` (visibilità, letture,
monitor, accessi, analisi, correzione, simulazioni, chiavi private in un
modulo che nessuna lettura raggiunge) con `gate()`, `storeGeneration`,
`failNext` e `resetApi` come nelle aree 5–8a. Gli avvisi passano da
`registerAlertTypes` e `publishAlert` dell'8a; la correzione è una sessione
`task_run` dell'area 3 marcata `serverFix`, con tre punti del percorso di
oggi (`planGateFor`, `preApprovePlan`, `decidePlan`) che la riconoscono.
Le pagine leggono solo da `data/queries.ts`.

**Tech Stack:** quello delle aree 1–8a; nessuna dipendenza nuova (i grafici
sono SVG inline, niente uPlot).

**Spec:** `docs/plans/2026-10-28-desktop-area8-releases-support-servers-design.md`
(approvato 28 ott 2026), solo ciò che «Due piani: 8a e 8b» assegna a 8b:
«Server» (avviso, analisi automatica, correzione, accessi SSH), «Permessi»
(`servers.operate`, `servers.ssh.manage`, `monitor.manage`), invarianti
cambiate §1–2, «Quanto è vero nel prototipo», «Codici», «Stati», «Dati
finti», «Lasciato al costruttore», «Review Focus» 1–4 e 9. Forma: piano 8a
(`docs/plans/2026-10-28-desktop-area8a-plan.md`); contesto:
`apps/desktop/docs/area8-parity.md` («Server → area 8b»),
`apps/desktop/docs/ossatura-follow-ups.md` («Area 8a — minori aperti»), web
`apps/web/src/routes/monitor/*` (cosa si porta), `apps/desktop/DESIGN.md`.

## Global Constraints

- Tutte le Global Constraints delle aree 2–8a restano (nessuna rete; en/it con parità; temi; niente monospace salvo logo, codice e **log/comandi/script**; colore mai unico segnale; movimento 150–250 ms con reduced-motion; pagine solo via `data/queries.ts`; stati completi — caricamento, vuoto, errore con «Riprova», pieno, senza permessi; orologio `now()` di `data/store.ts`; Impeccable obbligatorio con shape approvati vincolanti; R-G5: nascosto e inesistente identici; commenti in italiano).
- **Anti-obiettivo 2 — due condizioni, sempre**: la correzione di un server parte solo da una task legata a quel server (`serverRef`), avviata da chi ha `servers.operate` nel progetto della task, e **nessun comando di correzione** (azione `server.fix`) precede un evento `plan` con `status: "approved"` deciso da una persona con `plans.approve` — anche se chi avvia ha `plans.approve`. Niente pre-approvazione, niente «parte subito». Nessun altro percorso (analisi automatica, «Avvia» con `runs.start`, automazioni, «Fai sistemare a Claude», conversazione libera) usa l'accesso di correzione.
- **Anti-obiettivo 3**: le chiavi private non escono da `data/servers/secrets.ts`: nessuna lettura, nessun evento di conversazione, nessuna notifica, nessun comando mostrato le contiene. Gli script mostrano solo chiavi pubbliche.
- **Sola lettura vera**: l'analisi usa solo l'accesso `read` e solo comandi di `READ_COMMANDS`; `stubwise-read` non entra nel gruppo `docker`, `docker inspect` è escluso, «Verifica» controlla anche che non possa scrivere (`sudo -n true` deve fallire); un accesso di lettura che scrive è un errore e spegne entrambi gli accessi finché una verifica non riesce.
- **Anti-obiettivo 1 resta**: l'accesso di correzione non rilascia. «Fai sistemare a Claude» di un rilascio non crea mai una task con `serverRef`; la scheda del piano di una correzione server dice che un piano che rilascia (pull, aggiornamento d'immagine, deploy) va rifiutato.
- **Un server appartiene a un progetto attraverso gli ambienti** (`ProjectEnvironment.serverCode`): la sezione Servers mostra i server di tutti gli ambienti del progetto; avvisi del catalogo e analisi solo per i progetti il cui ambiente di **produzione** usa il server.
- **Permessi** (`data/viewer.ts`, `data/types.ts`): `servers.operate` è `LocalProjectPermission` **senza preset** (implicito per il full admin, dato nel seme persona × progetto); `servers.ssh.manage` è `LocalInstancePermission` del solo preset Admin; `monitor.manage` (d'istanza, di `@stubwise/shared`) per server, chiave dell'agente, soglie, controlli e progetto principale; la sezione e lo stato degli accessi li vede ogni membro del progetto.
- **Codici**: server `SRV-<n>` d'istanza, mai riusati (`serverCodeSeq`, i nuovi partono da `SRV-5`); i codici scritti a mano diventano link solo se visibili.
- **Limiti (scelta del piano)**, in `domain/servers/limits.ts`: `ANALYSIS_MAX_MINUTES = 20`, `ANALYSIS_MAX_COST_USD = 2`, `COMMAND_OUTPUT_MAX_LINES = 40`, `RECOVERED_SHOWN_HOURS = 24`, `METRIC_POINTS_MAX = 300`.
- **Prototipo**: nessun SSH, nessuna chiave vera (le chiavi sono «generate dal prototipo» e lo dicono); ogni «Simula …» (allarme, rientro, esito della verifica, server irraggiungibile, esito del controllo finale) esiste solo nel prototipo e sta nel riquadro «Prototype only» dell'8a.
- **Comandi**: un file `pnpm --filter @stubwise/desktop test -- <file>`; prima di ogni commit suite desktop, `pnpm --filter @stubwise/desktop typecheck` e `pnpm lint` dalla radice. Trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` e `Claude-Session: https://claude.ai/code/session_01C9DcEFDJAasjVWKkutyVLm`. Verifica UI: `pnpm --filter @stubwise/desktop preview:web` + `apps/desktop/scripts/capture.mjs`, 1440 e 1024, chiaro/scuro, en/it.
- **File di altri**: il catalogo dell'8a (`domain/alerts/catalog.ts`, `data/alerts/*`, `data/seed/alerts.ts`) non si modifica; 8b lo estende solo con `registerAlertTypes` da `data/servers/alertTypes.ts`.

## Review Focus

1. **L'accesso di correzione per un solo percorso** (spec RF 1): senza `servers.operate` anche con `runs.start` e `plans.approve` (Laura su ACQ) → rifiutato e nessuna sessione; con entrambi (Roberta) → ferma su «piano da approvare» e zero `server.fix`; con `servers.operate` senza `plans.approve` (Marco) → non approva il proprio piano; `preApprovePlan` sulla sessione → rifiutato; accesso revocato mentre il piano aspetta → approvazione spenta col motivo, zero comandi; revocato durante l'esecuzione → la sessione si ferma. Asserzioni sullo stato (sessioni, `fixCommandsBeforeApproval`), non sui bottoni. → Task 6.
2. **Le chiavi private non escono** (RF 2): serializzando ogni lettura di `api.servers`, ogni evento di ogni sessione e ogni notifica dopo collega/verifica/rigenera/revoca/analisi/correzione non compare `PRIVATE KEY` né alcun segreto di `secrets.ts`. → Task 4 e Task 6.
3. **`stubwise-read` di sola lettura** (RF 3): lo script non aggiunge `stubwise-read` al gruppo `docker` né ammette `docker inspect`; ogni comando dell'analisi è in `READ_COMMANDS` e gira con `read`; «lettura scrive» → stato `read_writes`, nessuna analisi, nessuna correzione. → Task 2, 4, 5.
4. **Episodi ai bordi**: secondo allarme durante l'analisi (si aggiunge, una task sola), rientro durante l'analisi («rientrato alle …»), nessun accesso di lettura (nessuna analisi, l'avviso lo dice e offre «Collega l'accesso SSH» solo a `servers.ssh.manage`), SSH irraggiungibile (task lo stesso), server in due produzioni (task nel progetto principale), server solo di staging (nessun avviso del catalogo), Claude mai destinatario (R-K5). → Task 5.
5. **Contenuti estremi**: metriche di 7 giorni a 30 s (≤ `METRIC_POINTS_MAX` punti, `truncated`), 200 servizi, uscita di un comando da 5000 righe (troncata a 40 con «vedi tutto»), nome di server lunghissimo; rigenera che tiene valide le vecchie chiavi finché la verifica delle nuove non riesce. → Task 3, 4, 7, 8, 9.

---

### Task 0 (controller): shape di Impeccable

Brief `shape`, approvati dal maintainer, in `apps/desktop/.impeccable/shape/`: `servers.md` (sezione Servers del progetto: elenco con salute e lavoro in parole, ambiente e progetto principale; dettaglio con intervallo 1h/24h/7d, grafici CPU, memoria, disco, rete, carico, servizi, dischi, controlli con selezione, soglie, impostazioni, «Nuovo server» con la chiave dell'agente mostrata una volta; stati in salute / in difficoltà / non risponde / rientrato / analisi in corso / diagnosi pronta / correzione in corso; voce Servers della colonna), `server-access.md` (pannello «Accesso SSH»: i tre passi collega → comando → «Verifica», la frase «questo utente può fare tutto sul server» accanto a `stubwise-fix`, esiti della verifica per accesso, Rigenera, Revoca col comando di rimozione, ultimo uso per accesso; i sette stati; chi non ha `servers.ssh.manage` vede lo stato senza azioni), `server-task.md` (blocco «Server» nella task: diagnosis, episodio, «Avvia la correzione sul server» con le due condizioni scritte, scheda del piano della correzione, registro dei comandi con uscita troncata, controllo finale risolto/non risolto; sessione d'analisi nella destinazione Claude; avviso senza accesso con «Collega l'accesso SSH»). Nessun codice.

### Task 1: Modello, permessi e seme

**Files:** Modify `data/model.ts` (`TaskSource` :121, `Task` :138-179, `ConversationKind` :603, `Conversation` :622-693, `work_result.kind` del `ConversationEvent` :818-826), `data/types.ts` (`LocalProjectPermission` :51-59, `LocalInstancePermission` :68-73, `ConversationPermissions` :293), `data/viewer.ts` (`LOCAL_INSTANCE_PERMISSIONS` :35, `instancePermsOf` :89, `buildViewer` :188), `data/seed/grants.ts`, `data/store.ts` (State, `freshState`, `ApiFnName`, `AUTOMATIC_KINDS` :1062), `data/seed/notifications.ts` (`LOCAL_NOTIFICATION_KINDS` :30, concatenazione degli avvisi dei server), `data/seed/conversations.ts`, `data/seed/tasks.ts`, `data/seed/releases/environments.ts` (solo il commento sulla numerazione); Create `data/seed/servers/{servers.ts,metrics.ts,episodes.ts,access.ts,analysis.ts,alerts.ts}`; Test `data/seed.test.ts`, `data/viewer.test.ts`.

**Interfaces — Produces (`model.ts`):**
```ts
export interface ServerThresholds { cpuPct: number | null; memPct: number | null; diskPct: number | null; sustainedMinutes: number }
export interface ServerCheck { id: string; serverCode: string; name: string; type: "http" | "tcp" | "process" | "postgres" | "mysql"; target: string; intervalSeconds: number; enabled: boolean; status: "up" | "down" | "unknown"; latencyMs: number | null; lastError: string | null }
export interface ServerService { name: string; source: "docker" | "pm2"; state: string; cpuPct: number | null; memBytes: number | null; restarts: number | null; image?: string }
export interface ServerDisk { mount: string; usedBytes: number; totalBytes: number }
export interface MetricPoint { ts: string; cpuPct: number; memPct: number; diskPct: number; load1m: number; netRxBytes: number; netTxBytes: number }
export interface MonitoredServer { id: string; code: string /* SRV-1 */; name: string; hostname: string | null; status: "online" | "offline" | "never_connected"; agentVersion: string | null; lastSeenAt: string | null; sampleIntervalSeconds: number; thresholds: ServerThresholds; services: ServerService[]; disks: ServerDisk[]; primaryProjectId: string | null; createdAt: string; /** solo prototipo */ sshReachable: boolean }
export type EpisodeReason = { kind: "cpu" | "memory" | "disk"; valuePct: number; thresholdPct: number } | { kind: "check"; checkId: string } | { kind: "agent_silent"; since: string };
export interface ServerEpisode { id: string; serverCode: string; severity: "trouble" | "down"; reasons: EpisodeReason[]; startedAt: string; recoveredAt: string | null; analysisId: string | null }
export interface ServerAnalysis { id: string; serverCode: string; episodeId: string; projectId: string; conversationId: string; outcome: "running" | "diagnosed" | "unreachable" | "timed_out"; taskId: string | null; startedAt: string; endedAt: string | null }
export type SshAccessKind = "read" | "fix";
export interface SshPublicKey { publicKey: string /* ssh-ed25519 AAAA… stubwise-read@SRV-1 */; fingerprint: string; createdAt: string }
export interface SshUse { at: string; ref: { kind: "analysis"; analysisId: string } | { kind: "task"; taskId: string } }
export interface ServerSshAccess { serverCode: string; keys: Record<SshAccessKind, SshPublicKey> | null; pending: Record<SshAccessKind, SshPublicKey> | null; verification: { at: string; read: "ok" | "failed" | "writes"; fix: "ok" | "failed"; reason: string | null; ofPending: boolean } | null; lastUse: Partial<Record<SshAccessKind, SshUse>>; revokedAt: string | null }
// TaskSource: + "server"   Task: + serverRef?: { serverCode: string; episodeId: string | null }
// ConversationKind: + "server_analysis" (in AUTOMATIC_KINDS)   Conversation: + serverFix?: { serverCode: string }
// work_result.kind: + "server_diagnosis" | "server_check"
// ConversationPermissions: + planBlockedReason: "fix_access_revoked" | "fix_access_unverified" | null
```
- `types.ts`: `LocalProjectPermission` + `"servers.operate"` (nessuna voce in `LOCAL_PROJECT_PERMISSIONS`); `LocalInstancePermission` + `"servers.ssh.manage"`, in `LOCAL_INSTANCE_PERMISSIONS` e in `instancePermsOf("admin")`. `grants.ts`: `SEED_PROJECT_GRANTS: Record<personId, Record<projectCode, readonly LocalProjectPermission[]>> = { "p-marco": { ACQ: ["servers.operate"] } }`, applicato da `buildViewer` sulle righe del progetto e ripristinato da `resetApi` come `SEED_INSTANCE_GRANTS`.
- Store: `servers`, `serverChecks`, `serverMetrics: Map<serverCode, MetricPoint[]>`, `serverEpisodes`, `serverAnalyses`, `serverAccess: Map<serverCode, ServerSshAccess>`, `serverCodeSeq` (4), più gli stati di simulazione `sshVerifyNext: Map<serverCode, VerifyOutcome>` e `fixCheckNext: Map<serverCode, "resolved" | "not_resolved">`.
- Seme (spec «Dati finti», scelta del controller 29 ott: `SRV-1…3` di R-K3 più il secondo server di ACQ, `SRV-4`): **SRV-1** (ACQ, produzione) accesso verificato su entrambi, episodio memoria del seme (inizio 52 h fa, rientro 50 h fa, coerente con le righe `monitor.alert`/`monitor.recovered` esistenti), analisi `diagnosed` con la sessione `server_analysis` (comandi di lettura con uscite, ultimo uso `read` = l'analisi) e la task ACQ (prossimo codice libero) `bug`, senza incaricato, `source: "server"`, `serverRef`, `createdById: "p-claude"`, descrizione con diagnosi, «rientrato alle …» e proposta, avviso `server.diagnosis_ready`; **SRV-2** (STW) accesso **non collegato** ed episodio disco aperto (`trouble`) senza analisi, avviso `server.trouble` che lo dice; **SRV-3** (AUD) in salute, accesso **in attesa del comando** (chiavi generate, mai verificate); **SRV-4** (ACQ, secondo server della produzione di ACQ, non principale) in salute, accesso **non collegato**: su ACQ convivono un server con accesso e uno senza (il commento di `data/seed/releases/environments.ts` resta vero). Metriche 7 giorni a 30 s deterministiche (`metrics.ts`, generatore con seme per server, la serie di SRV-1 mostra il picco di memoria); servizi, dischi, controlli (uno `down` su SRV-2), soglie di default del web (95/90/90, 5 min). Chiavi private del seme scritte in `secrets.ts` (Task 4) da una funzione `seedSecrets()` chiamata al reset.
- I kind nuovi sono locali: `server.trouble`, `server.down`, `server.recovered`, `server.diagnosis_ready`; ognuno compare almeno una volta nel seme (lo pretende `seed.test.ts:471-473`).
- [ ] Tests (scrivili prima): ogni caso del seme; codici `SRV-<n>` unici; ogni server è su un ambiente; Marco ha `servers.operate` solo su ACQ, Laura e Matteo no, Roberta sì (full admin); `servers.ssh.manage` solo a Roberta; nessun preset di progetto contiene `servers.operate` (per ogni chiave di `LOCAL_PROJECT_PERMISSIONS`); `resetApi` rimette le concessioni; i test delle aree 2–8a restano verdi (suite intera).
- [ ] Commit `feat(desktop): modello e seme dell'area 8b`.

### Task 2: Server — regole pure

**Files:** Create `domain/servers/{limits.ts,health.ts,sshAccess.ts,installScript.ts,projects.ts,fixGate.ts,commands.ts,metrics.ts}` (+ `domain/servers/servers.test.ts`, `installScript.test.ts`).

**Interfaces — Produces:**
- Tipi esportati (li usano i Task 1 e 3–9): `ServerHealth`, `ServerWork`, `AccessState`, `ServerTaskState` (i valori di ritorno qui sotto, con nome) e `VerifyOutcome = "ok" | "read_fails" | "fix_fails" | "read_writes" | "unreachable"`.
- `serverHealth(s: MonitoredServer, episodes: ServerEpisode[], now: string): { health: "healthy" | "trouble" | "down" | "recovered"; since: string | null; reasons: EpisodeReason[] }` — `down` se un episodio aperto è `down` o `status: "offline"`; `trouble` se aperto; `recovered` se l'ultimo è rientrato da meno di `RECOVERED_SHOWN_HOURS`.
- `serverWork(input: { analyses: ServerAnalysis[]; serverTasks: { task: Task; liveFix: boolean }[] }): "none" | "analyzing" | "diagnosis_ready" | "fixing"` — precedenza `fixing` > `analyzing` > `diagnosis_ready` (una task di server aperta).
- `accessState(a: ServerSshAccess | undefined): "not_linked" | "awaiting_command" | "verified" | "verify_failed" | "read_writes" | "regenerating" | "revoked"` e `accessUsable(a, kind: SshAccessKind): boolean` — `regenerating` = `pending` presente con le vecchie verificate (usabili); `read_writes` rende inutilizzabili **entrambi** (scelta del piano); `verify_failed` dice quale e perché.
- `installScript(input: { serverCode: string; read: SshPublicKey; fix: SshPublicKey; instanceAddress: string | null }): string`, `removalScript(serverCode: string): string`, `READ_SUDO_COMMANDS: readonly string[]` = `journalctl`, `docker ps`, `docker logs`, `docker stats --no-stream`, `systemctl status` (percorsi assoluti nelle regole `sudo`); `df`, `free`, `ps`, `uptime`, `ss -tlnp` senza `sudo`. Lo script crea `stubwise-read` e `stubwise-fix`, scrive `authorized_keys` con `no-port-forwarding,no-agent-forwarding,no-X11-forwarding` e `from="<instanceAddress>"` se noto, `stubwise-fix ALL=(ALL) NOPASSWD: ALL`.
- `READ_COMMANDS` e `isReadCommand(cmd: string): boolean` (prefissi ammessi all'analisi, coerenti con `READ_SUDO_COMMANDS`).
- `alertProjectsOf(serverCode: string, envs: ProjectEnvironment[]): string[]` (solo `kind: "production"`), `analysisProjectOf(serverCode, envs, primaryProjectId: string | null): string | null` (il principale se è fra quelli, altrimenti il primo; `null` senza produzione → niente analisi, scelta del piano).
- `fixStartBlock(input: { hasOperate: boolean; task: Task; access: ServerSshAccess | undefined; liveRun: boolean }): null | "no_permission" | "not_server_task" | "no_fix_access" | "fix_access_unverified" | "closed" | "run_live"`.
- `fixCommandsBeforeApproval(events: ConversationEvent[]): number` — le azioni `tool: "server.fix"` che non hanno prima, nello stesso flusso, un `plan` `approved` con `decidedById` (un `pre_approved` non vale).
- `serverTaskState(task: Task, run: { c: Conversation; events: ConversationEvent[] } | null): "diagnosis_ready" | "fix_planning" | "plan_awaiting" | "plan_rejected" | "fixing" | "stopped" | "resolved" | "not_resolved" | "closed"`.
- `truncateOutput(text: string): { text: string; truncated: boolean }` (ultime `COMMAND_OUTPUT_MAX_LINES` righe), `downsample(points: MetricPoint[], max = METRIC_POINTS_MAX): { points: MetricPoint[]; truncated: boolean }` (media per finestra, primo e ultimo punto conservati).
- [ ] Tests: ogni ramo di `serverHealth` (offline senza episodio → `down`; rientrato da 23 h → `recovered`, da 25 h → `healthy`); i sette stati di `accessState` e `accessUsable` per ognuno (`read_writes` → nessuno dei due; `regenerating` → le vecchie sì); RF 3 sullo script (nessun `usermod -aG docker`/`gpasswd … docker` per `stubwise-read`, nessun `docker inspect`, nessun `curl`/`wget`/`| sh`, nessun `PRIVATE KEY`, `from=` presente solo con indirizzo, le due chiavi pubbliche dentro); `isReadCommand` vero per ogni `READ_COMMANDS`, falso per `docker inspect x`, `docker restart x`, `rm -rf /tmp/x`, `sudo -n true`; `analysisProjectOf` con due produzioni (principale, poi primo) e con solo staging (`null`); `fixStartBlock` per ogni motivo; `fixCommandsBeforeApproval` conta un `server.fix` dopo un `pre_approved` e dopo un `rejected`, zero dopo un `approved`; `truncateOutput` su 5000 righe; `downsample` di 20 160 punti → 300 con `truncated`.
- [ ] Commit `feat(desktop): regole pure dei server`.

### Task 3: Server — letture e monitor

**Files:** Create `data/servers/{visibility.ts,reads.ts,monitor.ts,index.ts}` (+`data/servers/servers.test.ts`); Modify `data/api.ts` (`export * as servers from "./servers"`), `data/queries.ts` + Create `data/queries/servers.ts`, `data/store.ts` (`ApiFnName`), `data/routes.ts` (`#/p/<CODE>/servers/SRV-<n>`).

**Interfaces — Produces:**
- Visibilità: `serversVisibleTo(personId): Set<string>` (server di un ambiente qualunque di un progetto visibile), `serverFor(me, code)` → `not_found` se invisibile o inesistente (R-G5).
- Reads: `listProjectServers(projectId): ServerRow[]` con `ServerRow = { code; name; hostname; status; health: ReturnType<typeof serverHealth>; work: ServerWork; access: AccessState; environments: { projectCode: string; name: string; kind: ProjectEnvironment["kind"] }[]; primaryProjectCode: string | null; recentCpu: number[] }`; `getServer(code): ServerDetail` (`ServerRow` + `thresholds`, `services`, `disks`, `checks`, `episodes` con `analysis` e `taskCode` visibile, `productionProjects`, `canManage: boolean` da `monitor.manage`); `getServerMetrics(code, range: "1h" | "24h" | "7d", checkId?: string): { points: MetricPoint[]; truncated: boolean }`; `searchServers(q): { code; name; projectCode }[]` (⌘K).
- Monitor (`monitor.manage`; `forbidden` altrimenti): `createServer(input: { name: string; environmentId: string })` → `{ server: ServerRow; agentKey: string }` (scelta del piano: dalla sezione di un progetto un server nasce collegato a un ambiente di quel progetto senza server, quindi serve anche `environments.manage` lì; la chiave `sk_…` c'è **solo** in questo risultato e in `regenerateAgentKey(code): { agentKey: string }`, mai in una lettura); `updateServer(code, { name?; sampleIntervalSeconds?; primaryProjectId? })` (`primaryProjectId` fra `alertProjectsOf`, altrimenti `invalid: primaryProjectId`; intervallo 10–300 come il web); `deleteServer(code)` (toglie `serverCode` dagli ambienti; il codice non si riusa); `setThresholds(code, t: ServerThresholds)` (1–100 o `null`, minuti 1–60); `createCheck`/`updateCheck`/`deleteCheck` (intervallo 10–3600, tipi del web).
- [ ] Tests: Marco vede SRV-1 da ACQ e non SRV-3 se non vede AUD (usa una persona senza AUD); R-G5 su `getServer("SRV-99")` e su un server di un progetto invisibile (stesso errore); RF 5 (`getServerMetrics("SRV-1", "7d")` ≤ 300 punti e `truncated`; 200 servizi restituiti tutti); `createServer` senza `monitor.manage` (Laura) → `forbidden` e nessun server; con Roberta → `SRV-5`, l'ambiente lo porta, `agentKey` assente da `getServer` e `listProjectServers`; `deleteServer` poi `createServer` → `SRV-6`; validazioni di soglie, controlli e principale; `failNext`; `storeGeneration`; `resetApi` ripulisce.
- [ ] Commit `feat(desktop): dati e monitor dei server`.

### Task 4: Accessi SSH — livello dati

**Files:** Create `data/servers/{secrets.ts,access.ts}` (+`data/servers/access.test.ts`); Modify `data/servers/index.ts`, `data/servers/reads.ts` (vista dell'accesso), `data/store.ts` (`ApiFnName`).

**Interfaces — Produces:**
- `secrets.ts` (non esportato da `index.ts`; lo importano solo `access.ts`, `analysis.ts`, `fix.ts`): `storeKeyPair(serverCode, kind, pending: boolean): SshPublicKey` (genera una coppia finta deterministica dal contatore, privata cifrata in una `Map` del modulo), `promotePending(serverCode)`, `forget(serverCode)`, `hasKey(serverCode, kind): boolean`, `seedSecrets()`; `onStoreReset` ripulisce e riscrive il seme.
- Vista: `SshAccessView = { state: AccessState; read: SshPublicKey | null; fix: SshPublicKey | null; pending: { read: SshPublicKey; fix: SshPublicKey } | null; verification: ServerSshAccess["verification"]; lastUse: { read: SshUseView | null; fix: SshUseView | null }; canManage: boolean }` con `SshUseView = { at: string; label: { kind: "analysis" | "task"; code: string | null } }` (codice della task solo se visibile). Sta in `ServerDetail.access`.
- Scritture (`servers.ssh.manage` d'istanza; `forbidden` altrimenti, `not_found` per un server che non si vede): `linkSshAccess(code): { command: string }` (da `not_linked`/`revoked` → `awaiting_command`); `getInstallCommand(code): { command: string }` (solo chiavi pubbliche: si può rivedere); `verifySshAccess(code): SshAccessView` (esito da `sshVerifyNext`, di base `ok`; con `pending`, un esito tutto `ok` promuove le nuove e dimentica le vecchie, altrimenti le vecchie restano); `regenerateSshAccess(code): { command: string }` (solo da `verified`/`verify_failed`/`read_writes`); `revokeSshAccess(code): { removalCommand: string }` (dimentica le chiavi, `revokedAt`, ferma una correzione viva sul server — Task 6 aggancia `onAccessRevoked`).
- `onAccessRevoked(fn: (serverCode: string) => void): void` e `markUsed(serverCode, kind, ref: SshUse["ref"]): void` per Task 5–6.
- `simulate.ts` (creato qui): `simulateSshVerifyOutcome(code, outcome: "ok" | "read_fails" | "fix_fails" | "read_writes" | "unreachable")`.
- [ ] Tests: i tre passi (collega → comando con le due chiavi pubbliche → verifica `ok` → `verified`); ogni esito simulato → stato e motivo giusti (`read_writes` è un errore: `accessUsable` falso per entrambi); RF 5 rigenera (vecchie usabili durante `regenerating`; verifica fallita → restano le vecchie; riuscita → le nuove, le vecchie dimenticate da `secrets`); revoca → `removalCommand` con `userdel stubwise-read` e `stubwise-fix`, stato `revoked`, ricollegabile; Laura e Marco → `forbidden` su ogni scrittura, nessun cambiamento; Sara (membro ACQ) vede lo stato, `canManage` falso; **RF 2**: dopo ogni scrittura, `JSON.stringify` di `getServer`, `listProjectServers`, `getInstallCommand` e delle notifiche non contiene `PRIVATE KEY` né alcun valore privato di `secrets` (letto con un helper solo-test esportato da `secrets.ts` come `__privateValuesForTest()`); R-G5; `failNext`; `resetApi`.
- [ ] Commit `feat(desktop): accessi SSH dei server`.

### Task 5: Avvisi dei server e analisi automatica

**Files:** Create `data/servers/{alertTypes.ts,analysis.ts,scripts.ts}` (+`data/servers/analysis.test.ts`); Modify `data/servers/simulate.ts`, `data/servers/index.ts` (importa `alertTypes.ts` staticamente), `data/store.ts`, i18n (`alerts.types.server_*`, testi delle sessioni come `Utterance`).

**Interfaces — Consumes:** `registerAlertTypes(rows: AlertType[])` e `AlertType` da `domain/alerts/catalog.ts`; `publishAlert(input: AlertInput)` da `data/alerts/publish.ts` (verifica, al momento dell'esecuzione, che le firme siano ancora queste: il catalogo è in lavorazione in parallelo).

**Interfaces — Produces:**
- `alertTypes.ts`, al caricamento: `server.trouble` (`group: "monitor"`, `subscribe: { perm: "member" }`, `defaultOn: perms => perms("servers.operate")`, `defaultPhone: true`, `mandatory: []`), `server.down` e `server.recovered` con `sameRowAs: "server.trouble"` (stesso default; `server.recovered` `defaultPhone: false`), `server.diagnosis_ready` (riga sua, stesso default, telefono acceso); **scelta del piano**: `monitor.alert` e `monitor.recovered` si ri-registrano identici ma con `sameRowAs: "server.trouble"` (una riga sola per lo stesso significato, shape [A 10]; il default di prima — tutti i membri — resta).
- `analysis.ts`: `raiseEpisode(serverCode, reasons: EpisodeReason[], severity): ServerEpisode` — se c'è un episodio aperto, aggiunge i motivi (e l'analisi in corso li legge) senza nuovo avviso né nuova analisi; altrimenti apre l'episodio, pubblica `server.trouble`/`server.down` per ogni progetto di `alertProjectsOf` (corpo diverso senza accesso di lettura usabile) e, se `accessUsable(read)` e `analysisProjectOf` non è `null`, apre l'analisi: sessione `server_analysis` (owner `p-claude`, `projectId` dell'analisi, visibilità `project`), comandi di `scripts.ts` come azioni `tool: "server.read"` con `input` e uscita troncata, `markUsed(read)`; a fine script crea la task (`createTaskAs("p-claude", …)`, `bug`, senza incaricato, `source: "server"`, `serverRef`), `work_result` `server_diagnosis`, pubblica `server.diagnosis_ready` nel progetto dell'analisi. SSH irraggiungibile (`sshReachable: false`) → task lo stesso con «non raggiungibile» e i tentativi, `outcome: "unreachable"`. `recoverEpisode(serverCode)` → `recoveredAt`, `server.recovered`; se l'analisi è in corso finisce e la task scrive «rientrato alle HH:MM».
- `scripts.ts`: `analysisScript(server, episode): { steps: ScriptStep[]; diagnosis: { title: string; body: string; proposal: string } }` deterministico per motivo (`cpu`, `memory`, `disk`, `check`, `agent_silent`); `ANALYSIS_MAX_*` scritti nei metadati della sessione (`usage`), e `simulateServerAlert(…, { overrun: true })` chiude con `timed_out` aprendo la task con ciò che c'è.
- `simulate.ts`: `simulateServerAlert(code, reason: EpisodeReason["kind"], opts?: { severity?: "trouble" | "down"; overrun?: boolean })`, `simulateServerRecovery(code)`, `simulateSshUnreachable(code, on: boolean)`.
- [ ] Tests: RF 4 per ogni caso (secondo allarme durante l'analisi → un'analisi, una task, i due motivi nella diagnosi; rientro durante → «recovered at» nella task; SRV-2 senza accesso → nessuna sessione, avviso col corpo «no access»; irraggiungibile → task con «not reachable»; SRV-1 anche in produzione di un secondo progetto creato nel test → task nel principale, il secondo ha l'avviso ma non la task; server solo di staging → nessun avviso del catalogo e nessuna analisi); RF 3 (ogni `action` delle sessioni `server_analysis` ha `tool: "server.read"` e `isReadCommand(input)`; con `read_writes` nessuna analisi); destinatari: Marco riceve `server.trouble` di ACQ per default, Laura e Matteo no, `p-claude` mai (R-K5); `subscriptionRows` mostra una riga «server» sola con `monitor.alert` confluito; l'ultimo uso `read` è l'analisi; `storeGeneration` (un'analisi in corso dopo `resetApi` non scrive); `resetApi` rimette il catalogo.
- [ ] Commit `feat(desktop): avvisi e analisi automatica dei server`.

### Task 6: La correzione da task

**Files:** Create `data/servers/fix.ts` (+`data/servers/fix.test.ts`), `data/architecture.servers.test.ts`; Modify `data/api-mutations.ts` (`planGateFor` :1523, `decidePlan` :2108, `preApprovePlan` :2214, export di `newConversation`/`follow` come `openWorkConversationAs`/`followScripts`), `data/store.ts` (`conversationPermissions` :1114, `runPreconditions` non cambia), `data/servers/scripts.ts` (`fixPlan`, `fixExecution`, `fixCheck`), `data/servers/reads.ts` (`getServerTaskInfo`), `data/servers/index.ts`.

**Interfaces — Produces:**
- `startServerFix(taskId: string): Promise<Conversation>` — `gate("startServerFix")`; `need(me, "servers.operate", task.projectId)` **prima** di ogni altra cosa (`forbidden`, nessuna sessione); poi `fixStartBlock` (→ `invalid: <motivo>`); apre una `task_run` con `serverFix: { serverCode }`, scrive il piano in sola lettura (azioni `server.read`, `markUsed(read)`) e si ferma **sempre** su `plan` `pending` / `awaiting_approval`.
- `planGateFor`: con `c.serverFix` restituisce sempre `{ status: "awaiting", by: c.ownerId }` (né il `plans.approve` di chi avvia né `preApprovedPlans` contano). `preApprovePlan`: con `c.serverFix` → `invalid: kind`. `conversationPermissions`: `canPreApprovePlan` falso con `serverFix`; `canDecidePlan` falso e `planBlockedReason` valorizzato se `!accessUsable(fix)` (revocato → `fix_access_revoked`, altrimenti `fix_access_unverified`). `decidePlan("approve")` con `serverFix` ricontrolla `accessUsable(fix)` (→ `invalid: fix_access`), poi segue `fixExecution(c, task)` invece di `scripts.execution`: azioni `tool: "server.fix"` (comando, ora, esito, uscita `truncateOutput`), `markUsed(fix, { kind: "task" })`, poi `fixCheck` in sola lettura con esito da `fixCheckNext` (di base `resolved`) → `work_result` `server_check`; la task resta aperta (la chiude una persona). Rifiuto con indicazioni → nuovo piano, di nuovo `awaiting`.
- `onAccessRevoked` (Task 4): una sessione `serverFix` viva su quel server si ferma (`interruptScripts` + fase `stopped` col motivo); in attesa del piano resta ferma e l'approvazione si spegne.
- `getServerTaskInfo(taskId): { server: { code; name } | null; episode: ServerEpisode | null; state: ServerTaskState; startBlock: ReturnType<typeof fixStartBlock>; fixAccess: AccessState } | null` (null per una task senza `serverRef`).
- `simulate.ts`: `simulateFixCheck(code, outcome: "resolved" | "not_resolved")`.
- [ ] Tests (RF 1, asserendo su `state.conversations`, sugli eventi e su `fixCommandsBeforeApproval`): Laura su ACQ (`runs.start` + `plans.approve`, senza `servers.operate`) → `forbidden`, nessuna sessione nuova; Roberta → sessione `awaiting_approval`, zero `server.fix`, poi approva lei stessa (gesto esplicito) e i comandi partono; Marco → avvia, `decidePlan` → `forbidden`, zero comandi; Laura approva il piano di Marco → partono; `preApprovePlan` prima del piano → `invalid: kind` e il piano arriva comunque `pending`; revoca con piano in attesa → `canDecidePlan` falso con `fix_access_revoked`, `decidePlan` rifiutato, zero comandi; revoca durante l'esecuzione → fase fermata, nessun comando dopo; `stop` di una persona → `stopped`, nessun comando dopo; task senza `serverRef` → `not_server_task`; accesso `awaiting_command` → `fix_access_unverified`; `startRun` («Avvia», `runs.start`) su una task di server → sessione senza `serverFix` e nessun `server.fix`; «Fai sistemare a Claude» (`api.releases.fixRelease`) → task senza `serverRef`; esiti del controllo finale; RF 2 sugli eventi; `failNext`, `storeGeneration`, `resetApi`. **Architettura** (`architecture.servers.test.ts`): la stringa `"server.fix"` compare nei sorgenti di `src/renderer` (esclusi i test) solo in `data/servers/` e `domain/servers/`; dopo ogni scenario del file `fix.test.ts`, `fixCommandsBeforeApproval` è 0 su ogni sessione dello store.
- [ ] Commit `feat(desktop): correzione dei server da task`.

### Task 7: Servers — UI della sezione e del dettaglio

**Files:** Create `pages/servers/{ServersPage.tsx,ServerList.tsx,ServerDetail.tsx,MetricsCharts.tsx,ServicesTable.tsx,DisksPanel.tsx,ChecksPanel.tsx,ThresholdsPanel.tsx,ServerSettings.tsx,NewServerDialog.tsx,AgentKeyPanel.tsx}` (+`Servers.test.tsx`, `ServerDetail.test.tsx`); Modify `router.tsx` (sezione `servers` al posto del `Placeholder` :653-670, figlia `/p/$code/servers/$server`), `layout/Column.tsx` (voce Servers: il punto quando un server del progetto è in difficoltà o non risponde), `palette/CommandPalette.tsx` (server per codice), i18n (`servers.*`, rimuovere `placeholder.sections.servers`).

Da shape `servers.md`.
- [ ] Tests: elenco coi server di ACQ (SRV-1 e SRV-4) nei loro stati in parole (colore mai unico segnale); dettaglio con intervallo 1h/24h/7d e la nota `truncated`; RF 5 (200 servizi: tabella intera e scorrevole; nome lunghissimo con ellissi e titolo intero); selezione di un controllo filtra il grafico; soglie, controlli, impostazioni e «Nuovo server» solo con `monitor.manage` (Laura: valori come frasi, nessun controllo); «Nuovo server» → pannello della chiave con «mostrata solo ora», copia, e la chiave non c'è più alla riapertura; progetto principale solo fra le produzioni; R-G5 su `/p/ACQ/servers/SRV-99` e su un server invisibile; ⌘K `SRV-1` porta al dettaglio; caricamento/errore con «Riprova»/vuoto (progetto senza server).
- [ ] Commit `feat(desktop): sezione Servers`.

### Task 8: Accesso SSH — UI

**Files:** Create `pages/servers/{SshAccessPanel.tsx,InstallCommand.tsx,VerifyResult.tsx}` (+`SshAccess.test.tsx`); Modify `pages/servers/ServerDetail.tsx`, `palette/CommandPalette.tsx` (azione «Collega l'accesso SSH» sul server corrente, solo `servers.ssh.manage`), i18n.

Da shape `server-access.md`.
- [ ] Tests: i tre passi con Roberta (collega → comando in monospace, copia, «questo utente può fare tutto sul server» accanto a `stubwise-fix` → «Verifica»); ogni esito simulato in parole (quale accesso e perché; «lettura scrive» come errore, non come successo); Rigenera mostra che le vecchie restano valide fino alla verifica; Revoca con conferma e comando di rimozione; ultimo uso per accesso col link all'analisi o alla task; Laura vede stato e ultimo uso senza azioni; il pannello non mostra mai una chiave privata (testo del DOM senza `PRIVATE KEY`); ogni «Simula» nel riquadro «Prototype only»; errore della verifica con «Riprova».
- [ ] Commit `feat(desktop): accessi SSH nell'app`.

### Task 9: Task di server, sessione d'analisi, avvisi — UI

**Files:** Create `pages/task/ServerSection.tsx` (+`ServerSection.test.tsx`); Modify `pages/task/TaskDetail.tsx` (sezione «Server» per le task con `serverRef`), `pages/task/ClaudeSection.tsx` / `ClaudeRunParts.tsx` (scheda del piano della correzione: niente «approva in anticipo», motivo dell'approvazione spenta, riga «un piano che rilascia va rifiutato»; registro dei comandi `server.fix`/`server.read` con uscita troncata e «vedi tutto»), `tasks-ui/SourceMark.tsx` (sorgente «server»), `pages/claude/marks.tsx` (`claude.destination.kinds.server_analysis`), `notifications/NotificationItem.tsx` («Collega l'accesso SSH» sull'avviso senza accesso, solo a `servers.ssh.manage`), i18n.

Da shape `server-task.md`.
- [ ] Tests: la task di SRV-1 mostra server, episodio, diagnosi e stato; «Avvia la correzione sul server» c'è per Marco e Roberta, non per Laura (con chi può farlo in grigio); avviata, la scheda dice «piano da approvare» anche a Roberta e non offre l'anticipo; Marco legge chi deve approvare; accesso revocato → bottone d'approvazione spento col motivo; RF 5 (uscita da 5000 righe: si apre con le ultime 40, «vedi tutto» disegna solo una finestra); controllo finale risolto/non risolto in parole; la sessione d'analisi compare nella destinazione Claude come automatica e in sola lettura; l'avviso di SRV-2 offre «Collega l'accesso SSH» a Roberta e non a Marco; cambio di persona con la task aperta.
- [ ] Commit `feat(desktop): task di server e correzione nell'app`.

### Task 10: Documenti, screenshot, follow-up

`apps/desktop/docs/area8-parity.md`: la sezione «Server → area 8b» diventa le tabelle vere (forma delle altre: voce, dove vive, test fra virgolette) per sezione Servers e monitor del web (grafici, servizi, dischi, controlli, soglie, impostazioni, nuovo server e chiave), avvisi, analisi, correzione, accessi SSH, progetto principale; fra i non portati la vista complessiva dei server (area 9) e l'assegnazione di `servers.operate` dalla pagina Membri (non esiste ancora: solo seme). `capture.mjs`: scatti `a8b-*` (Servers, dettaglio di SRV-1 a 7d, pannello SSH nei passi 2 e 3, task di SRV-1 col piano da approvare e col registro dei comandi, avviso di SRV-2) chiaro/scuro, en/it a 1440 e uno a 1024; vite ucciso. `ossatura-follow-ups.md`: «Area 8b — minori aperti» con le scelte del piano da confermare e, sotto «Invarianti del CLAUDE.md da riscrivere prima del motore», §1–2 marcate «costruite nel prototipo (8b), da riscrivere prima del motore» con le stesse parole dello spec. Suite, typecheck, lint, build verdi. Commit `docs(desktop): note dell'area 8b`.

Dopo il Task 10: revisione finale del branch (area 8b) e revisione visiva di Impeccable.

## Decisioni prese (29 ott 2026)

1. **Secondo server di ACQ** (scelta del controller, come chiede lo spec): sì, `SRV-4` nel seme, senza accesso SSH (Task 1); i server creati dall'app partono da `SRV-5`.
2. **Pagina Membri** (maintainer): non in 8b. `servers.operate` si assegna solo nel seme; la pagina Membri del progetto è dell'area 9.
