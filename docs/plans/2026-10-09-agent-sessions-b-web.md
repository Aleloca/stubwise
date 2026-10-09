# Sessioni degli agenti — Piano B: web

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nella SPA una sezione «Agenti» (`/agents`) mostra cosa stanno facendo gli agenti ora e le sessioni concluse degli ultimi 14 giorni; la vista di una sessione è una chat dal vivo in cui un maintainer può scrivere all'agente o fermarlo e scrivere, e chiunque abbia titolo risponde alle domande dell'agente nel punto in cui sono state fatte.

**Architecture:** il web legge le rotte `/api/agent-sessions*` del piano A attraverso il gruppo tipato `client.agentSessions` di `@stubwise/api-client` (che PARSA, a differenza del resto di `lib/api.ts`). Lo stream SSE si consuma con un `fetch` GET in streaming (non `EventSource`: il web non ne ha precedenti e happy-dom non lo implementa), riconnesso con il cursore `after`. La trascrizione mostrata è il risultato di una funzione PURA (`buildTranscript`) su eventi, parziali, interventi e domande, così il componente disegna e basta. Un solo cambio server, additivo: il dettaglio della sessione porta le domande complete (opzioni) e `canAnswer` calcolato dal server.

**Tech Stack:** React 19, TanStack Router (code-based, `apps/web/src/router.tsx`) e Query, Tailwind v4, Vitest + happy-dom, i18next (`apps/web/src/i18n`). Server: Fastify + Zod, Vitest + testcontainers.

**Spec:** `docs/plans/2026-10-08-agent-sessions-design.md` (§6, §8, §9, §12). Dipende dal **piano A** (`docs/plans/2026-10-08-agent-sessions-a-backend.md`), già sul branch `feat/agent-sessions`. Il piano C (app) consuma lo stesso campo aggiunto nel Task 1.

## Global Constraints

- Branch `feat/agent-sessions`, worktree `.worktrees/agent-sessions`: si costruisce SOPRA il piano A. Niente push, niente PR, niente deploy.
- `canWrite`, `canInterrupt` e `canAnswer` li calcola il **server**; il client li legge e basta. Nessuna regola di ruolo ricopiata nel web.
- Sul web i campi additivi si difendono **nel punto di lettura** (`?? []`, `?? false`, `?? null`) anche se il client tipato parsa: un server più vecchio del Task 1 non li manda, e la fixture del test che copre la difesa resta SENZA quel campo (CLAUDE.md, «quella regola NON protegge il web»).
- Server senza le rotte (404 **senza** `code`, `isAgentSessionsUnavailable`) → la pagina dice «non disponibile su questa istanza»: né vuota né rotta.
- La durata «da quanto gira» la conta il **client** da `startedAt`, mai un numero dal server.
- La frase dell'ultima azione viene da `describeAgentActivity` di `@stubwise/shared` (già fatta in A) o dal `lastActivity` del sommario; il web la mette solo in parole (`agents:activity.*`).
- Rispondere a una domanda usa le rotte ESISTENTI (`POST /api/tickets/:id/questions/answer`, `POST /api/backlog/:id/questions/:questionId/answer`) e il componente esistente `QuestionPanel`: rispondere non è intervenire.
- La sezione è visibile anche ai `member` (`memberVisible: true`); il campo di scrittura c'è solo con `canWrite`.
- Testi: catalogo web `apps/web/src/i18n/locales/{en,it}.json`, namespace nuovo `agents` registrato in `NAMESPACES`; il test di parità deve restare verde.
- Nessuna dipendenza npm nuova.
- Il backend del piano A non si tocca, salvo il Task 1 (additivo).

## Review Focus

1. **Stream che cade** (proxy che chiude, laptop che si sospende): atteso che la vista si riconnetta da sola dal suo ultimo id, senza eventi doppi né buchi. Test in Task 3.
2. **Sessione enorme** (decine di migliaia di eventi): atteso che la pagina carichi solo gli ultimi 200 e il resto a richiesta, e che lo stream non rimandi tutto da capo (`after` = ultimo id caricato). Test in Task 3 e Task 6.
3. **Intervento non consegnato** (run finito un attimo prima, stdin chiuso dopo il primo `result` di un piano): atteso che il messaggio resti visibile con lo stato «non consegnato» e il motivo, mai sparito. Test in Task 4 e Task 7.
4. **Server vecchio** (rollback, istanza self-hosted senza piano A): atteso «non disponibile su questa istanza» su `/agents`, e nessun link «Guarda la sessione» rotto sul ticket. Test in Task 5 e Task 8.
5. **Member sulla stessa sessione di un admin**: atteso nessun campo di scrittura per il member, il campo per l'admin, sugli stessi dati — letto da `canWrite`, non dedotto dal ruolo. Test in Task 7.

---

## File structure

| File | Responsabilità |
|---|---|
| `packages/shared/src/schemas/agent-session.ts` | (mod) `agentSessionQuestionSchema` con opzioni e `canAnswer`, additivo |
| `apps/server/src/services/agent-sessions.ts` | (mod) carica opzioni e calcola `canAnswer` nel dettaglio |
| `apps/web/src/lib/api.ts` | (mod) funzioni sottili sul gruppo `client.agentSessions` |
| `apps/web/src/lib/queries.ts` | (mod) `agentSessionKeys`, `agentSessionsQueryOptions`, `agentSessionQueryOptions` |
| `apps/web/src/lib/agent-session-stream.ts` | nuovo: GET in streaming dello SSE, parsing, riconnessione con `after` |
| `apps/web/src/lib/agent-transcript.ts` | nuovo, PURO: eventi + parziali + interventi + domande → elementi della chat |
| `apps/web/src/lib/elapsed.ts` | nuovo: `elapsedParts` (puro) e `useNow` |
| `apps/web/src/routes/agents/index.tsx` | nuovo: pagina d'insieme (Al lavoro ora / Concluse) |
| `apps/web/src/routes/agents/$id.tsx` | nuovo: vista di una sessione |
| `apps/web/src/routes/agents/by-job.tsx` | nuovo: `/agents/job/$jobId` → risolve la sessione del job e reindirizza |
| `apps/web/src/components/agent-session/*.tsx` | nuovi: `SessionRow`, `Transcript`, `ToolCard`, `Composer`, `SessionQuestion` |
| `apps/web/src/router.tsx` | (mod) tre rotte nuove |
| `apps/web/src/components/app-layout.tsx` | (mod) voce `AGT` |
| `apps/web/src/routes/tickets/$id.tsx` | (mod) «Guarda la sessione» |
| `apps/web/src/components/inbox-item.tsx` | (mod) «Apri» di `job.awaiting_input` → sessione |
| `apps/web/src/i18n/index.ts`, `locales/{en,it}.json` | (mod) namespace `agents`, `common.nav.agents`, codici d'errore |
| `apps/docs/src/content/docs/ai-pipeline/agent-sessions.md` | nuovo: guida utente |
| `CLAUDE.md` | (mod) voce di deploy del piano A: il caddy ora porta la UI |

---

### Task 1: Le domande complete nel dettaglio della sessione (server, additivo)

Oggi `detail.questions[]` ha solo `{ id, source, question, askedAt, answered }`: senza le opzioni il web non può disegnare la card coi bottoni, e senza `canAnswer` dovrebbe ricopiare la regola «il richiedente o un maintainer», che vive in `actorAllows` (`packages/notifications/src/actions.ts`).

**Files:**
- Modify: `packages/shared/src/schemas/agent-session.ts:205-211`
- Modify: `apps/server/src/services/agent-sessions.ts` (`loadAgentSession`, blocco `questions`)
- Test: `packages/shared/src/schemas/agent-session.test.ts`, `apps/server/src/services/agent-sessions.test.ts`

**Interfaces:**
- Produces: `AgentSessionQuestion = { id, source: "agent"|"backlog", question, askedAt, answered, round?: number, options: AgentQuestionOption[], recommendedIndex?: number, allowFreeText: boolean, canAnswer: boolean, ticketId: string|null, backlogItemId: string|null }`. I campi nuovi sono `.default(...)`/`.optional()`/`.nullable().default(null)`.

- [ ] **Step 1: test dello schema (RED)** — in `agent-session.test.ts`:

```ts
it("una domanda senza i campi nuovi (server del piano A) si legge coi default", () => {
  const q = agentSessionQuestionSchema.parse({
    id: crypto.randomUUID(), source: "agent", question: "Quale DB?", askedAt: new Date().toISOString(), answered: false,
  });
  expect(q).toMatchObject({ options: [], allowFreeText: false, canAnswer: false, ticketId: null, backlogItemId: null });
  expect(q.recommendedIndex).toBeUndefined();
});
```

- [ ] **Step 2:** `pnpm --filter @stubwise/shared test -- agent-session` → FAIL (i campi non esistono).
- [ ] **Step 3: schema.**

```ts
import { agentQuestionOptionSchema } from "./notification.js"; // se crea un ciclo, vedi la nota sotto

export const agentSessionQuestionSchema = z.object({
  id: z.string().uuid(),
  source: z.enum(["agent", "backlog"]),
  question: z.string(),
  askedAt: z.string(),
  answered: z.boolean(),
  /** Additivi (piano B): un server del solo piano A non li manda. */
  round: z.number().int().optional(),
  options: z.array(agentQuestionOptionSchema).default([]),
  recommendedIndex: z.number().int().optional(),
  allowFreeText: z.boolean().default(false),
  /** Calcolato dal server col viewer (`actorAllows`): mai dedotto dal client. */
  canAnswer: z.boolean().default(false),
  /** Dove si risponde: il ticket per `agent`, la voce per `backlog`. */
  ticketId: z.string().uuid().nullable().default(null),
  backlogItemId: z.string().uuid().nullable().default(null),
});
export type AgentSessionQuestion = z.infer<typeof agentSessionQuestionSchema>;
```

  Nota: `load-isolated.test.ts` deve restare verde (`pnpm --filter @stubwise/shared build && pnpm --filter @stubwise/shared test`). Se l'import da `notification.ts` crea un ciclo, sposta `agentQuestionOptionSchema` in `schemas/base-enums.ts` (foglia) e ri-esportalo da `notification.ts`, come fu fatto per `gitProviderKindSchema`.
- [ ] **Step 4:** test shared → PASS.
- [ ] **Step 5: test del servizio (RED)** — in `agent-sessions.test.ts`, con lo stesso seed che i test del dettaglio usano già (job con `requestedByUserId` = un member M, un admin A, un altro member O), e una riga `agent_questions` con `options` a due voci e `allowFreeText: true`:

```ts
it("canAnswer: il richiedente e un maintainer sì, un altro member no — stessi dati", async () => {
  const forM = await loadAgentSession(db, member(M), sessionId);
  const forA = await loadAgentSession(db, admin(A), sessionId);
  const forO = await loadAgentSession(db, member(O), sessionId);
  expect(forM!.detail.questions[0]).toMatchObject({ canAnswer: true, options: [{ label: "Postgres" }, { label: "SQLite" }], allowFreeText: true, ticketId });
  expect(forA!.detail.questions[0]!.canAnswer).toBe(true);
  expect(forO!.detail.questions[0]!.canAnswer).toBe(false);
});
it("una domanda già risposta non è rispondibile da nessuno", async () => { /* answered_at valorizzato → canAnswer false per A e M */ });
it("domanda del backlog: rispondibile da ogni utente autenticato finché aperta, con backlogItemId", async () => { /* stessa regola della rotta: requireAuth, nessun controllo di ruolo in answerBacklogQuestion */ });
```

  (Usa gli helper di attore già presenti nel file; se non ci sono, `{ id, role: "member" }`/`{ id, role: "admin" }` come `Actor`.)
- [ ] **Step 6:** `pnpm --filter @stubwise/server test -- agent-sessions` → FAIL.
- [ ] **Step 7: servizio.** Nel blocco `questions` di `loadAgentSession`, per le domande dell'agente leggi anche `round`, `options`, `recommendedIndex`, `allowFreeText` e il `requestedByUserId` del job (una query sola: `aiJobs` per `row.aiJobId`, prima della map), e il `ticketId` della sessione; `canAnswer = !answered && actorAllows({ kind: "job.awaiting_input", requestedByUserId }, "answer", viewer)` importato da `@stubwise/notifications` — la STESSA funzione che `answerQuestion` riapplica (`apps/server/src/services/questions.ts`). Per il backlog: `canAnswer = !answered` (la rotta è `requireAuth` e `answerBacklogQuestion` non controlla il ruolo: lo scrivi nel commento), `backlogItemId: row.backlogItemId`. Mappa `recommendedIndex: q.recommendedIndex ?? undefined`.
- [ ] **Step 8:** test → PASS; suite server completa con output salvato.
- [ ] **Step 9:** commit `feat(server): il dettaglio della sessione porta le domande complete e canAnswer` + changeset `@stubwise/shared` minor (aggiorna `.changeset/shared-agent-sessions.md` invece di crearne un secondo).

---

### Task 2: Accesso ai dati, durata, testi

**Files:**
- Modify: `apps/web/src/lib/api.ts` (vicino a `getTicketHistory`, ~l.1074)
- Modify: `apps/web/src/lib/queries.ts`
- Create: `apps/web/src/lib/elapsed.ts`, `apps/web/src/lib/elapsed.test.ts`
- Modify: `apps/web/src/i18n/index.ts`, `apps/web/src/i18n/locales/en.json`, `it.json`

**Interfaces:**
- Produces (api.ts): `listAgentSessions(filters?: AgentSessionListQuery)`, `getAgentSession(id)`, `getAgentSessionEvents(id, page?: { before?: string; after?: string; limit?: number })`, `sendAgentMessage(id, body: { text: string; interrupt: boolean })`, `agentSessionStreamPath(id, after?)` — ognuna `return client.agentSessions.<metodo>(...)`; ri-esporta `isAgentSessionsUnavailable` da `@stubwise/api-client`.
- Produces (queries.ts): `agentSessionKeys = { all: ["agent-sessions"], list: (f) => [...all, "list", f ?? {}], detail: (id) => [...all, "detail", id] }`, `agentSessionsQueryOptions(filters?)` (`refetchInterval: 5_000`, `staleTime: 2_000`: la riga «ultima azione» dell'elenco si aggiorna così, lo stream c'è solo nella vista di una sessione), `agentSessionQueryOptions(id)` (nessun polling: lo aggiorna lo stream).
- Produces (elapsed.ts): `elapsedParts(startedAt: string, now: number): { hours: number; minutes: number }` (mai negativo), `useNow(intervalMs = 30_000): number`.

- [ ] **Step 1: test (RED)** — `elapsed.test.ts`:

```ts
it("conta da startedAt, mai negativo", () => {
  const start = "2026-10-09T10:00:00.000Z";
  expect(elapsedParts(start, Date.parse("2026-10-09T11:05:00.000Z"))).toEqual({ hours: 1, minutes: 5 });
  expect(elapsedParts(start, Date.parse("2026-10-09T09:00:00.000Z"))).toEqual({ hours: 0, minutes: 0 });
});
it("useNow avanza col timer", () => { vi.useFakeTimers(); /* renderHook(() => useNow(1000)); advanceTimersByTime(1000) → valore maggiore */ });
```

- [ ] **Step 2:** `pnpm --filter @stubwise/web test -- elapsed` → FAIL.
- [ ] **Step 3:** implementa `elapsed.ts` (`Math.max(0, now - Date.parse(startedAt))`, poi ore e minuti interi; `useNow` con `useState(Date.now())` + `setInterval` pulito all'unmount).
- [ ] **Step 4: testi.** Aggiungi `"agents"` a `NAMESPACES` (`apps/web/src/i18n/index.ts`). In `en.json`/`it.json`: `common.nav.agents` («Agents»/«Agenti») e il namespace `agents` con queste chiavi (it qui, en equivalente):

```json
"agents": {
  "title": "Agenti",
  "subtitle": "Cosa stanno facendo gli agenti, e cosa hanno fatto negli ultimi 14 giorni",
  "live": "Al lavoro ora",
  "recent": "Concluse",
  "emptyLive": "// nessun agente al lavoro",
  "emptyRecent": "// nessuna sessione negli ultimi 14 giorni",
  "unavailable": "Le sessioni degli agenti non sono disponibili su questa istanza.",
  "elapsed": "da {{hours}} h {{minutes}} min",
  "elapsedMinutes": "da {{minutes}} min",
  "filters": { "project": "Progetto", "allProjects": "Tutti i progetti", "outcome": "Esito", "allOutcomes": "Tutti" },
  "state": { "queued": "in coda", "working": "al lavoro", "waiting_input": "aspetta una risposta", "awaiting_approval": "aspetta l'approvazione del piano", "held": "fermo", "ended": "conclusa", "UNKNOWN": "stato sconosciuto" },
  "outcome": { "completed": "completata", "failed": "fallita", "skipped": "saltata", "UNKNOWN": "esito sconosciuto" },
  "kind": { "ai_job": "Fix", "pr_review": "Review PR", "backlog_item": "Chat del backlog", "backlog_job": "Backlog", "doc_generation": "Docs", "email_message": "Posta", "project_brief": "Brief", "daily_report": "Report", "UNKNOWN": "Sessione" },
  "segment": { "triage": "Triage", "plan": "Piano", "plan_resume": "Ripreso dopo la risposta", "execute": "Esecuzione", "self_repair": "Auto-riparazione", "correction": "Correzione", "correction_self_repair": "Correzione", "review": "Review", "plan_summary": "Riassunto del piano", "failure_summary": "Riassunto del fallimento", "pr_summary": "Riassunto della PR", "deep_dive": "Deep dive", "chat_turn": "Chat", "intake": "Intake", "estimate": "Stima", "email_classify": "Classificazione", "docs": "Docs", "brief": "Brief", "daily_report": "Report", "UNKNOWN": "Passo" },
  "activity": { "edit": "sta modificando {{target}}", "read": "sta leggendo {{target}}", "run": "sta lanciando {{target}}", "search": "sta cercando {{target}}", "web": "sta consultando {{target}}", "ask": "sta facendo una domanda", "subagent": "ha affidato un compito: {{target}}", "write": "sta scrivendo", "other": "usa {{target}}", "none": "—" },
  "tool": { "showInput": "Input", "showResult": "Risultato", "truncated": "(troncato)", "error": "errore" },
  "segmentEnd": { "ok": "Fine del passo", "failed": "Il passo è finito con un errore", "timedOut": "Il passo è scaduto" },
  "interrupted": "Fermato da un maintainer",
  "input": { "pending": "in consegna…", "delivered": "consegnato", "undelivered": "non consegnato", "reason": { "session_not_live": "la sessione non era più attiva", "stdin_closed": "l'agente non accettava più messaggi" } },
  "loadOlder": "Carica i precedenti",
  "reconnecting": "Riconnessione…",
  "composer": { "placeholder": "Scrivi all'agente…", "send": "Scrivi", "interruptAndSend": "Ferma e scrivi", "hint": "Il messaggio arriva all'agente appena finisce l'azione in corso. «Ferma e scrivi» interrompe prima.", "readOnly": "Questo passo si può solo guardare." },
  "question": { "title": "L'agente chiede", "answered": "Risposta data" },
  "watch": "Guarda la sessione",
  "replay": "Rivedi la sessione",
  "notFound": "Sessione non trovata (o non visibile per te).",
  "byJobFallback": "Nessuna sessione registrata per questo lavoro: ti porto al ticket."
}
```

  E in `errors`: `not_found`, `session_ended` («La sessione non è più attiva»), `not_interactive` («Questo passo non accetta messaggi»), `interrupt_unsupported` («Questo agente non si può interrompere»), con l'en equivalente.
- [ ] **Step 5: api e query.** Le funzioni di `api.ts` come in Interfaces, ognuna con un docblock di una riga che dice che questo gruppo PARSA (via `readerSchema`) a differenza del resto del file, e che i tipi restituiti sono `Reader<…>` (enum con `"UNKNOWN"`): per questo le chiavi i18n hanno una voce `UNKNOWN`.
- [ ] **Step 6:** `pnpm --filter @stubwise/web test -- elapsed i18n` e `pnpm --filter @stubwise/web typecheck` → PASS (il test di parità copre le chiavi nuove).
- [ ] **Step 7:** commit `feat(web): dati, durata e testi della sezione Agenti`.

---

### Task 3: Lo stream dal vivo

**Files:**
- Create: `apps/web/src/lib/agent-session-stream.ts`, `apps/web/src/lib/agent-session-stream.test.ts`

**Interfaces:**
- Consumes: `agentSessionStreamPath(id, after?)` (Task 2), `errorFromResponse` di `@stubwise/api-client` (se esportato; altrimenti la stessa lettura `{code,message}` di `postDocChatStream`).
- Produces:

```ts
export type StreamMessage =
  | { type: "events"; events: AgentSessionEvent[] }
  | { type: "partial"; segmentId: string; text: string }
  | { type: "session"; detail: AgentSessionDetail };

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export function openAgentSessionStream(opts: {
  sessionId: string;
  after: string | null;                 // ultimo id già caricato: mai null se la pagina ha eventi
  onMessage: (m: StreamMessage) => void;
  onStatus?: (s: StreamStatus) => void;
  onFatal?: (e: ApiError) => void;      // 404/401: niente riconnessione
  fetchImpl?: typeof fetch;             // default globalThis.fetch, per i test
  backoffMs?: (attempt: number) => number; // default min(1000 * 2 ** attempt, 15_000)
}): { close(): void };
```

  Regole: GET `credentials: "include"`, `accept: text/event-stream`; frame separati da `\n\n`, solo le righe `data:` (i `: ping` si ignorano da soli); JSON non valido → frame scartato, lo stream continua; ogni `events` aggiorna il cursore all'ultimo `id`; alla chiusura o a un errore di rete si riconnette con `after` = cursore e il backoff; un 404/401 chiama `onFatal` e si ferma; `close()` interrompe con `AbortController` e non riconnette più. Il messaggio `session` passa così com'è (porta `inputs` e `canWrite` aggiornati).

- [ ] **Step 1: test (RED).** Con un `fetchImpl` finto che restituisce `Response` costruite da un `ReadableStream` (copia `sseResponse`/`sse` da `components/docs-chat.test.tsx:46-65` in un helper `src/test/sse.ts` e usalo anche lì): 
  - frame `events` + `partial` + `session` arrivano in ordine a `onMessage`;
  - un frame `data: {non json` è ignorato e il successivo arriva;
  - **riconnessione**: il primo stream manda eventi `id` "5" e "6" e poi si chiude; la seconda chiamata a `fetchImpl` ha `after=6` nell'URL; nessun evento doppio arriva a `onMessage` (il server non li rimanda: il test verifica l'URL e che `onStatus` sia passato da `reconnecting` a `open`);
  - `after` iniziale: la prima URL contiene `after=<valore passato>`; con `after: null` la URL non ha `after`;
  - 404 → `onFatal` chiamato una volta e `fetchImpl` NON richiamato;
  - `close()` durante l'attesa del backoff → nessuna nuova chiamata (usa `vi.useFakeTimers()`).
- [ ] **Step 2:** `pnpm --filter @stubwise/web test -- agent-session-stream` → FAIL.
- [ ] **Step 3:** implementa secondo le regole sopra (parser ripreso da `backlog-chat-api.ts`, riscritto per un GET).
- [ ] **Step 4:** test → PASS, e `docs-chat.test.tsx` ancora verde dopo lo spostamento dell'helper.
- [ ] **Step 5:** commit `feat(web): stream dal vivo di una sessione, con ripresa dal cursore`.

---

### Task 4: La trascrizione come funzione pura

**Files:**
- Create: `apps/web/src/lib/agent-transcript.ts`, `apps/web/src/lib/agent-transcript.test.ts`

**Interfaces:**
- Produces:

```ts
export type TranscriptItem =
  | { kind: "segment"; id: string; label: string; at: string }                       // segment_start
  | { kind: "segment_end"; id: string; exitCode: number | null; timedOut: boolean; at: string }
  | { kind: "text"; id: string; text: string; at: string; live: boolean }            // assistant_text o parziale
  | { kind: "tool"; id: string; name: string; input: unknown; result: { isError: boolean; content: string; truncated: boolean } | null; at: string }
  | { kind: "input"; id: string; text: string; interrupt: boolean; authorName: string | null; status: "pending" | "delivered" | "undelivered" | "UNKNOWN"; reason: string | null; at: string }
  | { kind: "interrupted"; id: string; at: string }                                 // turn_end con subtype error_during_execution
  | { kind: "question"; id: string; question: AgentSessionQuestion; at: string };

export function buildTranscript(input: {
  events: AgentSessionEvent[];            // ascendenti per id, senza doppi
  partials: Record<string, string>;        // segmentId → testo parziale corrente
  inputs: AgentSessionInput[];             // detail.inputs ?? []
  questions: AgentSessionQuestion[];       // detail.questions ?? []
}): TranscriptItem[];

export function mergeEvents(current: AgentSessionEvent[], incoming: AgentSessionEvent[]): AgentSessionEvent[]; // per id numerico, ascendente, senza doppi
```

  Regole (ognuna ha un test):
  1. `tool_use` e `tool_result` con lo stesso `toolUseId` diventano UNA card; un `tool_use` senza risultato ha `result: null` (in corso).
  2. Un evento `input` (consegnato) diventa una bolla col nome; gli interventi di `inputs` che NON hanno un evento `input` con lo stesso `inputId` (pending o undelivered) si inseriscono per `createdAt` con il loro stato e motivo. Un intervento delivered ha lo stato dall'elenco `inputs` se presente, altrimenti `delivered`.
  3. Il parziale di un segmento compare come `text` `live: true` in coda; sparisce appena arriva un `assistant_text` o un `turn_end` dello stesso segmento DOPO di lui (il chiamante azzera `partials[segmentId]` su quegli eventi: lo fa il componente, il test copre `buildTranscript` con e senza parziale).
  4. `turn_end` con `subtype: "error_during_execution"` → `interrupted`; gli altri `turn_end` non producono elementi.
  5. Le domande si inseriscono dopo l'ultimo elemento con `at <= askedAt` (nel punto in cui l'agente le ha fatte, design §8.3), mai in testa per caso.
  6. Tipi d'evento sconosciuti (`UNKNOWN`) si saltano senza lanciare.
  7. `mergeEvents` confronta gli id come `BigInt` (sono bigserial in stringa: "10" > "9").

- [ ] **Step 1:** scrivi i 7 gruppi di test (RED), con eventi costruiti a mano (helper `ev(id, type, data, at)` nel file di test).
- [ ] **Step 2:** `pnpm --filter @stubwise/web test -- agent-transcript` → FAIL.
- [ ] **Step 3:** implementa.
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5:** commit `feat(web): trascrizione di una sessione come funzione pura`.

---

### Task 5: La pagina d'insieme `/agents` e la voce di menu

**Files:**
- Create: `apps/web/src/routes/agents/index.tsx`, `apps/web/src/components/agent-session/session-row.tsx`, `apps/web/src/routes/agents/index.test.tsx`
- Modify: `apps/web/src/router.tsx` (rotta `agentsRoute`, `path: "/agents"`, figlia di `authedRoute`, loader `ensureQueryData(agentSessionsQueryOptions()).catch(() => undefined)`, aggiunta a `authedRoute.addChildren`), `apps/web/src/components/app-layout.tsx` (`{ to: "/agents", labelKey: "common:nav.agents", code: "AGT", memberVisible: true }` dopo `/inbox`), `apps/web/src/components/app-layout.test.tsx`

**Interfaces:**
- Consumes: `agentSessionsQueryOptions`, `isAgentSessionsUnavailable`, `elapsedParts`/`useNow`, `projectsQueryOptions` (costante già esistente in `queries.ts:399`, non una funzione).
- Produces: `SessionRow({ session, now })` — usata anche dalla pagina del ticket? No: solo qui.

  Contenuto:
  - **Al lavoro ora**: una riga per sessione `live`: tipo (`agents:kind.*`), titolo, progetto e `#numero` del ticket, stato (`agents:state.*`), «da X» (dalla durata), e la riga dell'ultima azione da `session.lastActivity ?? null` → `agents:activity.<kind>` con `target`, `agents:activity.none` se assente. La riga è un `Link` a `/agents/$id`.
  - **Concluse**: stesse righe senza durata, con esito (`agents:outcome.*`, niente se `null`) e data (`formatRelativeTime`). Filtro **progetto** (manda `?projectId=` al server: chiave di query diversa) e filtro **esito** (sul client, sull'elenco ricevuto, design §8.2).
  - Errore `isAgentSessionsUnavailable` → solo il testo `agents:unavailable`. Altri errori → `RouteError`/messaggio tradotto come le altre pagine.

- [ ] **Step 1: test (RED)** in `index.test.tsx`, col pattern di `routes/release.test.tsx` (`mockApi` su `fetch`, router vero con `createMemoryHistory({ initialEntries: ["/agents"] })`):
  - una sessione live con `lastActivity: { kind: "edit", target: "routes/tickets.ts" }` mostra «sta modificando routes/tickets.ts» e lo stato;
  - fixture di una sessione SENZA `lastActivity`, `aiJobId`, `outcome` (server del piano A più vecchio, campi `.default`): la pagina mostra la riga senza lanciare;
  - `GET /api/agent-sessions` che risponde `404` con body `{"message":"Route GET:/api/agent-sessions not found","error":"Not Found","statusCode":404}` (nessun `code`) → «non disponibile su questa istanza», nessuna lista;
  - filtro esito «fallita» → resta solo la sessione `failed`; filtro progetto → la richiesta parte con `?projectId=<id>`;
  - un member vede la voce di menu `AGTAgents` (in `app-layout.test.tsx`, accanto ai test esistenti delle voci).
- [ ] **Step 2:** `pnpm --filter @stubwise/web test -- agents app-layout` → FAIL.
- [ ] **Step 3:** implementa pagina, riga, rotta e voce di menu.
- [ ] **Step 4:** test → PASS; `pnpm --filter @stubwise/web typecheck`.
- [ ] **Step 5:** commit `feat(web): sezione Agenti — al lavoro ora e concluse`.

---

### Task 6: La vista di una sessione (sola lettura)

**Files:**
- Create: `apps/web/src/routes/agents/$id.tsx`, `apps/web/src/components/agent-session/transcript.tsx`, `apps/web/src/components/agent-session/tool-card.tsx`, `apps/web/src/routes/agents/$id.test.tsx`
- Modify: `apps/web/src/router.tsx` (`agentSessionRoute`, `path: "/agents/$id"`, loader `ensureQueryData(agentSessionQueryOptions(params.id)).catch(() => undefined)`)

**Interfaces:**
- Consumes: Task 2 (`getAgentSession`, `getAgentSessionEvents`), Task 3 (`openAgentSessionStream`), Task 4 (`buildTranscript`, `mergeEvents`), `Markdown` (`components/markdown.tsx`), `CollapsibleSection` (`components/collapsible-section.tsx`).
- Produces: `useAgentSession(id)` (hook nel file della rotta o in `lib/agent-session-view.ts`): `{ detail, events, partials, status, loadOlder, hasOlder }`. Il hook:
  1. carica il dettaglio (query) e la PRIMA pagina di eventi (`getAgentSessionEvents(id)` senza cursori = gli ultimi 200);
  2. apre lo stream con `after` = id dell'ultimo evento caricato (o `null` se non ce ne sono) — mai prima di avere la prima pagina, altrimenti il server rimanda tutto da capo;
  3. su `events` → `mergeEvents`, e azzera `partials[segmentId]` per ogni `assistant_text`/`turn_end` ricevuto; su `partial` → `partials[segmentId] = text`; su `session` → `queryClient.setQueryData(agentSessionKeys.detail(id), detail)`;
  4. `loadOlder()` chiede `before` = il `before` dell'ultima pagina e antepone; `hasOlder = before !== null`;
  5. chiude lo stream all'unmount.

  Disegno: intestazione (tipo, titolo, progetto, ticket con `Link` a `/tickets/$id`, stato, durata o esito); bottone `agents:loadOlder` in cima se `hasOlder`; la trascrizione: `segment` come divisore con `agents:segment.<label>`, `text` come messaggio dell'agente in `<Markdown>` (il `live` con un cursore lampeggiante), `tool` come `ToolCard` (riga compatta «`describeAgentActivity`» + nome, che si apre su input e risultato in `<pre>`, testo di `agents:tool.truncated` se `truncated`), `input` come bolla a destra col nome e lo stato, `interrupted` come riga di sistema, `segment_end` solo se fallito o scaduto; indicatore `agents:reconnecting` quando lo stream è `reconnecting`. 404 dal dettaglio → `agents:notFound`.

- [ ] **Step 1: test (RED)** in `$id.test.tsx`. Per lo stream, il `fetch` mockato risponde a `GET /api/agent-sessions/:id/stream` con un `ReadableStream` controllato dal test (un helper `controlledSse()` in `src/test/sse.ts` che espone `push(message)` e `close()`):
  - la pagina mostra testo, una card tool e un divisore di segmento dalla prima pagina;
  - lo stream viene aperto con `after=<ultimo id della prima pagina>` (asserisci l'URL);
  - un `partial` compare dal vivo e sparisce quando arriva l'`assistant_text` dello stesso segmento;
  - un messaggio `session` con `state: "ended"` aggiorna l'intestazione senza ricaricare;
  - con `before` non nullo compare «Carica i precedenti» e il click chiede `?before=<valore>`;
  - un dettaglio SENZA `questions`, `inputs`, `canWrite` (server del piano A) non fa lanciare la pagina.
- [ ] **Step 2:** `pnpm --filter @stubwise/web test -- agents/\\$id` → FAIL.
- [ ] **Step 3:** implementa hook, componenti e rotta.
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5:** commit `feat(web): vista di una sessione dal vivo`.

---

### Task 7: Scrivere all'agente e rispondere alle domande

**Files:**
- Create: `apps/web/src/components/agent-session/composer.tsx`, `apps/web/src/components/agent-session/session-question.tsx`
- Modify: `apps/web/src/routes/agents/$id.tsx`, `apps/web/src/routes/agents/$id.test.tsx`

**Interfaces:**
- Consumes: `sendAgentMessage` (Task 2), `answerTicketQuestion`, `answerBacklogQuestion` (esistenti in `lib/api.ts`), `QuestionPanel` (`components/question-panel.tsx`), `translateApiError`, `answerErrorMessage`.
- Produces: `Composer({ sessionId, canInterrupt, onSent })`, `SessionQuestion({ question })`.

  Regole:
  - Il `Composer` compare SOLO se `detail.canWrite ?? false`; altrimenti, se la sessione è viva ma il passo non è interattivo, la riga `agents:composer.readOnly`; a sessione conclusa niente.
  - Due azioni: «Scrivi» (`interrupt: false`) e, solo con `detail.canInterrupt ?? false`, «Ferma e scrivi» (`interrupt: true`). Testo vuoto o solo spazi → bottoni disabilitati (il server lo rifiuterebbe con 400). Massimo 4000 caratteri (`maxLength`).
  - Dopo il 202 il testo si svuota e si invalida il dettaglio; la bolla compare da `detail.inputs` come `pending` e passa a `delivered`/`undelivered` coi messaggi `session` dello stream — il client non inventa lo stato.
  - Errori 409 (`session_ended`, `not_interactive`, `interrupt_unsupported`) mostrati con `translateApiError`, il testo resta nel campo (non si perde quello che si è scritto).
  - `SessionQuestion`: domanda aperta con `canAnswer` → `QuestionPanel` con `question = { questionId: q.id, round: q.round, question: q.question, options: q.options ?? [], recommendedIndex: q.recommendedIndex, allowFreeText: q.allowFreeText ?? false }`; `onSubmit` chiama `answerTicketQuestion(q.ticketId, q.id, answer)` per `source: "agent"` o `answerBacklogQuestion(q.backlogItemId, q.id, answer)` per `backlog`; al successo invalida il dettaglio della sessione, `ticketKeys.questions(ticketId)` e `inboxKeys.all`. Domanda aperta senza `canAnswer` → solo il testo. Domanda risposta → testo con `agents:question.answered`. Server del piano A senza opzioni (`options` assente) e `canAnswer` assente → solo testo, nessun bottone.

- [ ] **Step 1: test (RED)** in `$id.test.tsx`:
  - **due ruoli sugli stessi dati**: lo stesso dettaglio servito con `canWrite: true` all'admin e `canWrite: false` al member → il campo c'è solo per l'admin (il test cambia SOLO `canWrite` e il `/me`, così prova che la UI legge il campo e non il ruolo: con `canWrite: false` e `role: "admin"` il campo NON c'è);
  - «Ferma e scrivi» assente con `canInterrupt: false`;
  - invio → `POST /api/agent-sessions/:id/messages` con `{ text, interrupt }`; poi un messaggio `session` con `inputs: [{ status: "undelivered", reason: "stdin_closed", … }]` mostra «non consegnato — l'agente non accettava più messaggi»;
  - 409 `session_ended` → messaggio tradotto, testo ancora nel campo;
  - domanda dell'agente aperta con `canAnswer: true` → bottoni; il click manda `POST /api/tickets/<ticketId>/questions/answer` con `{ optionIndex: 0, questionId }`; con `canAnswer: false` nessun bottone;
  - domanda di backlog → `POST /api/backlog/<itemId>/questions/<qid>/answer`.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** implementa.
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5:** commit `feat(web): scrivere all'agente e rispondere alle sue domande dalla sessione`.

---

### Task 8: Dal ticket e dalla notifica alla sessione

**Files:**
- Create: `apps/web/src/routes/agents/by-job.tsx`, `apps/web/src/routes/agents/by-job.test.tsx`
- Modify: `apps/web/src/router.tsx` (`agentSessionByJobRoute`, `path: "/agents/job/$jobId"`, registrata PRIMA di `/agents/$id` con un commento che dice perché), `apps/web/src/routes/tickets/$id.tsx` (dopo `<AIJobTimeline jobs={jobs} />`, ~l.735), `apps/web/src/routes/tickets/$id.test.tsx` (`mockDetailApi`), `apps/web/src/components/inbox-item.tsx` (~l.757), il suo test

**Interfaces:**
- Consumes: `listAgentSessions({ aiJobId })`, `isAgentSessionsUnavailable`.
- Produces: rotta `/agents/job/$jobId?focus=question`.

  Comportamento:
  - **Ticket**: con un `latestJob`, una `useQuery(agentSessionsQueryOptions({ aiJobId: latestJob.id }))` (NON suspense: un errore o un server vecchio non devono toccare la pagina del ticket — errore → nessun link). Se c'è una sessione (`live[0] ?? recent[0]`): `Link` «Guarda la sessione» se non `ended`, «Rivedi la sessione» se `ended`, verso `/agents/$id`.
  - **`/agents/job/$jobId`**: chiama `listAgentSessions({ aiJobId: jobId })`; sessione trovata → `navigate({ to: "/agents/$id", params: { id }, hash: "question", replace: true })`; nessuna sessione, rotte assenti o errore → va al ticket della query `?ticketId=` (il link dell'inbox la passa sempre; il web non ha una lettura del job per id, verificato) con `replace`, mostrando per un attimo `agents:byJobFallback`. La vista della sessione con `#question` scorre alla prima domanda aperta.
  - **Inbox**: per `item.kind === "job.awaiting_input"` con `item.jobId` e `item.ticketId`, «Apri» punta a `/agents/job/<jobId>?ticketId=<ticketId>` invece di `item.url` (design §8.4: cambia solo dove porta «apri»). Rispondere dalla card resta com'è.

- [ ] **Step 1: test (RED)**:
  - ticket con sessione viva → link «Guarda la sessione» a `/agents/<id>`; con sessione `ended` → «Rivedi la sessione»; con `GET /api/agent-sessions` che risponde 404 senza `code` → nessun link e il resto della pagina intero (aggiungi l'handler a `mockDetailApi`: senza, `mockApi` lancia per costruzione);
  - `/agents/job/<jobId>?ticketId=<t>` con una sessione → finisce su `/agents/<id>`; senza sessioni → finisce su `/tickets/<t>`; con 404 senza `code` → `/tickets/<t>`;
  - card inbox `job.awaiting_input` → l'«Apri» ha `href` `/agents/job/<jobId>?ticketId=<ticketId>`; una card di un altro kind tiene `item.url`.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** implementa; senza `?ticketId=` e senza sessione la rotta va a `/agents` (scrivilo nel docblock).
- [ ] **Step 4:** test → PASS; suite web completa con output salvato.
- [ ] **Step 5:** commit `feat(web): dal ticket e dalla domanda in inbox alla sessione`.

---

### Task 9: Guida utente, CLAUDE.md, verifica finale

**Files:**
- Create: `apps/docs/src/content/docs/ai-pipeline/agent-sessions.md`
- Modify: `CLAUDE.md` (voce di deploy «Sessioni degli agenti dal vivo»: il caddy ora porta la UI `/agents`; invariante: chi decide scrittura e risposta è il server — `canWrite`/`canInterrupt`/`canAnswer`), la sidebar della guida, che è elencata a mano: `apps/docs/astro.config.mjs`, gruppo `ai-pipeline` (~l.143), voce `{ label: "Agent sessions", slug: "ai-pipeline/agent-sessions" }` dopo «How it works».

- [ ] **Step 1:** pagina della guida (inglese, come le altre di `ai-pipeline/`): cos'è una sessione (un lavoro, non un processo), dove la si trova, cosa vuol dire ogni stato, chi può scrivere e su quali passi (piano, esecuzione, correzione, deep dive, chat del backlog; review e Docs solo da guardare), «Scrivi» contro «Ferma e scrivi», perché un messaggio può risultare «non consegnato», che il messaggio diventa anche un commento sul ticket, e la retention di 14 giorni.
- [ ] **Step 2:** CLAUDE.md come sopra.
- [ ] **Step 3:** `pnpm typecheck && pnpm lint`, poi i test per pacchetto (`shared`, `server`, `web`) con output salvato; `pnpm --filter @stubwise/docs build`.
- [ ] **Step 4:** e2e Playwright: NON si aggiungono (le sessioni le produce il worker e l'e2e non ha seed: CLAUDE.md, «I test E2E… eseguili a mano per modifiche UI rilevanti»). Si lancia la suite esistente una volta (`pnpm --filter @stubwise/web e2e`) per vedere che la voce di menu nuova non rompa i nomi accessibili usati da `core-flows.spec.ts`.
- [ ] **Step 5:** commit `docs: guida e note di deploy della sezione Agenti`.

---

## Self-review

- Spec §8.1 (voce «Agenti» visibile ai member; «Guarda la sessione» dal ticket) → Task 5, Task 8. La parte app (AGT al posto di MBX) è del piano C.
- §8.2 (stati derivati dal server, esito, filtri progetto ed esito, durata dal client, riga dell'ultima azione da una funzione condivisa, `?aiJobId=`) → Task 2, Task 5, Task 8.
- §8.3 (markdown dal vivo, card dei tool, interventi col nome e lo stato, confini fra segmenti, domande nel punto in cui sono state fatte con la stessa rotta, campo solo per un maintainer sui passi abilitati, replay senza campo) → Task 4, Task 6, Task 7.
- §8.4 (la notifica di una domanda apre la sessione) → Task 8 per il web; il push è del piano C.
- §9 (server vecchio → «non disponibile») → Task 5 e Task 8.
- §10 (`canWrite` a due ruoli) → Task 7; «la frase dell'ultima azione è la stessa funzione su web e app» → Task 5 usa `lastActivity` del server, prodotto da `describeAgentActivity`.
- R1–R6 (§12): review e Docs in sola lettura → arrivano da `canWrite` del server, e la guida lo dice (Task 9); input non consegnati visibili → Task 4 e Task 7.
