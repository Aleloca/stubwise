# Sessioni di refinement del backlog — Piano B: web e app

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dalla pagina di una voce di backlog (web e app) si avvia o si riprende la sessione di refinement e la si apre nella vista delle sessioni degli agenti, dove chi può scrive anche a sessione ferma, la chiude con «Chiudi sessione» e vede design, piano e metadati della voce aggiornarsi mentre l'agente li scrive.

**Architecture:** solo client, più un campo additivo nel dettaglio di una sessione (`backlogItemId`) che serve al riquadro della voce. I permessi (`canWrite`, `canClose`, `canInterrupt`) li calcola il server (Piano A, Task 12): i client li LEGGONO, mai li deducono. La rotta d'avvio è del Piano A (Task 11), il client `backlogRefine` anche (Task 13).

**Tech Stack:** web React + Vite + TanStack Router/Query, Tailwind v4, Vitest + happy-dom; app React Native bare, `@testing-library/react-native`, Jest; `@stubwise/api-client`.

**Spec:** `docs/plans/2026-10-14-backlog-refine-sessions-design.md` (§6). Prerequisito: Piano A (`docs/plans/2026-10-14-backlog-refine-sessions-a-backend.md`) completo. Modelli: `docs/plans/2026-10-09-agent-sessions-b-web.md`, `docs/plans/2026-10-09-agent-sessions-c-app.md`.

## Global Constraints

- I client leggono i permessi dal server: `canWrite`, `canIntervene`, `canInterrupt`, `canClose`. Nessuna regola di ruolo o di kind copiata nei client.
- Web: `apps/web/src/lib/api.ts` fa un CAST per quasi tutte le rotte; il gruppo `agentSessions` parsa (`readerSchema`). Ogni campo nuovo letto dal web va difeso nel punto di lettura (`?? null`, `?? false`), e la fixture del test che lo copre resta SENZA il campo.
- App: le fixture dei test vanno COMPLETATE coi campi nuovi (il doppio del client non parsa); il doppio del client (`makeClient()`) guadagna i metodi nuovi PRIMA di scrivere il test che li usa; `render` si `await`a.
- App: niente su AsyncStorage per le sessioni (`shouldPersistQuery`), stream vivo solo a schermata a fuoco: valgono le regole di `docs/invariants/mobile-app.md` e `docs/invariants/agent-sessions.md`.
- App contro un server senza la funzione: la rotta d'avvio risponde 404 SENZA `code` (`isAgentSessionsUnavailable`) e il bottone sparisce.
- Testi da i18n, in `en` e `it` (il test di parità del web lo pretende); ogni enum letto ha la voce `unknown`.
- La chat a bottoni, il deep dive e la modalità CODE non cambiano.
- Frontend toccato → al deploy si ribuilda `caddy` (Piano A, voce di deploy).

## Review Focus

1. **Server più vecchio sotto un'app nuova**: niente `refineSession` nel dettaglio della voce, niente `canClose`, niente stato `idle`. Atteso: nessun bottone di refinement, nessun crash, la vista sessione come oggi. Test in Task B3 (fixture senza i campi) e Task B4.
2. **Sessione `idle` aperta da un member**: atteso il campo scrivibile (`canWrite`) anche senza turno vivo, niente «Ferma», «Chiudi sessione» presente. Test in Task B2 e B4.
3. **Messaggio rifiutato per budget** (`budget_exceeded`): atteso sotto il messaggio un testo che spiega perché, mai la chiave grezza; «Rimanda» presente. Test in Task B2 e B4.
4. **Voce convertita mentre la vista è aperta**: l'invio risponde 409 `item_closed`. Atteso un errore in parole, il testo scritto NON sparisce. Test in Task B2 e B4.
5. **L'agente salva il design mentre la vista è aperta**: atteso il riquadro della voce aggiornato senza ricaricare la pagina. Test in Task B2 (invalidazione al nuovo dettaglio).

---

### Task B1: `backlogItemId` nel dettaglio di una sessione

**Files:**
- Modify: `packages/shared/src/schemas/agent-session.ts` (`agentSessionSummarySchema`)
- Modify: `apps/server/src/services/agent-sessions.ts` (`toSummary`)
- Test: `packages/shared/src/schemas/agent-session.test.ts`, `apps/server/src/routes/agent-sessions.test.ts`
- Create: `.changeset/shared-session-backlog-item-id.md`

**Interfaces:**
- Produces: `AgentSessionSummary.backlogItemId: string | null` (`.nullable().default(null)`). Lo usano B2 e B4 per il riquadro della voce.

- [ ] **Step 1: test che falliscono**

```ts
// agent-session.test.ts
it("summary senza backlogItemId (server più vecchio): null", () => {
  const detail = agentSessionDetailSchema.parse(OLD_DETAIL); // la fixture minima del file, SENZA il campo
  expect(detail.backlogItemId).toBeNull();
});
```

```ts
// routes/agent-sessions.test.ts — con una sessione backlog_refine seminata come nel Piano A Task 12
it("il dettaglio di una sessione di refinement porta backlogItemId; quello di un ai_job null", async () => {
  // GET /api/agent-sessions/:id → backlogItemId === itemId; per jobSession → null
});
```

- [ ] **Step 2: implementazione**

In `agentSessionSummarySchema`, dopo `aiJobId`:

```ts
  /** La voce di backlog della sessione (chat o refinement), null altrimenti. Additivo. */
  backlogItemId: z.string().uuid().nullable().default(null),
```

In `toSummary`: `backlogItemId: row.backlogItemId ?? null,`.

- [ ] **Step 3: verificare e committare**

Run: `pnpm --filter @stubwise/shared build && pnpm --filter @stubwise/shared test -- agent-session && pnpm --filter @stubwise/server test -- agent-sessions`
Expected: PASS.

Changeset `@stubwise/shared` minor: «`agentSessionSummarySchema` guadagna `backlogItemId` (`.nullable().default(null)`).»

```bash
git add packages/shared apps/server/src/services/agent-sessions.ts apps/server/src/routes/agent-sessions.test.ts .changeset/shared-session-backlog-item-id.md
git commit -m "feat(agent-sessions): la voce di backlog nel dettaglio di una sessione"
```

---

### Task B2: Web — vista della sessione

**Files:**
- Modify: `apps/web/src/routes/agents/$id.tsx` (riquadro della voce, «Chiudi sessione»)
- Create: `apps/web/src/components/agent-session/refine-item-panel.tsx`
- Modify: `apps/web/src/lib/api.ts` (`startRefineSession`, `closeRefineSession`, accanto alle funzioni delle sessioni ~L1084-1117)
- Modify: `apps/web/src/i18n/locales/en.json`, `it.json` (sezione `agents` ~L2826-2930, mappa degli errori ~L288)
- Test: `apps/web/src/routes/agents/$id.test.tsx`

**Interfaces:**
- Consumes: `canClose`, stato `idle`, motivi `turn_failed`/`budget_exceeded`, errore `item_closed` (Piano A); `backlogItemId` (B1); `client.backlogRefine.close` (Piano A Task 13); `backlogItemQueryOptions` e `backlogKeys` (`apps/web/src/lib/queries.ts`).
- Produces: `startRefineSession(itemId, message?)` e `closeRefineSession(itemId)` in `api.ts` (B3 usa la prima).

Cosa cambia:
1. **Campo**: nessuna modifica di logica. `composerMounted` monta già il campo con `canWrite`, che il server dà vero anche a sessione `idle`. Va solo coperto da un test.
2. **«Chiudi sessione»**: con `detail.canClose ?? false`, un bottone nell'intestazione; al click una conferma (stessa `ConfirmDialog`/`ModalShell` del backlog, o il pattern di conferma già usato nella vista — `grep -rn "ConfirmDialog\|confirm" apps/web/src/components/agent-session`); confermato: `closeRefineSession(detail.backlogItemId!)`, poi invalidazione di `agentSessionKeys.detail(id)` e di `backlogKeys.detail(itemId)`. Errore: messaggio in parole sotto il bottone.
3. **Riquadro della voce** (`RefineItemPanel`), SOLO per `kind === "backlog_refine"` con `backlogItemId` non nullo, in testa alla trascrizione: titolo (link a `/backlog/$id`), metadati (effort, rischio + nota, urgenza), e due sezioni richiudibili «Design» e «Piano» col markdown (lo stesso renderer della pagina della voce). Si aggiorna quando l'agente scrive: a ogni nuovo dettaglio della sessione (`detailQuery.dataUpdatedAt`, il ponte notifica la sessione e lo stream SSE rimanda il dettaglio) si invalida `backlogKeys.detail(itemId)`. Errore di caricamento: una riga, mai la pagina.
4. **Testi**: `agents.state.idle` («ready — write to continue» / «pronta — scrivi per continuare»), `agents.kind.backlog_refine` («Refinement»), `agents.segment.refine` («Refinement»), `agents.input.reason.turn_failed` («The agent could not start: send it again» / «L'agente non è riuscito a partire: rimandalo»), `agents.input.reason.budget_exceeded` («The monthly AI budget is used up: a maintainer can still write» / «Il budget AI del mese è esaurito: può scrivere solo un maintainer»), `agents.close.*` (bottone, titolo e testo della conferma, errore), `agents.refineItem.*` (etichette del riquadro), e nella mappa degli errori `item_closed` («The backlog item is converted or archived» / «La voce è convertita o archiviata»).

- [ ] **Step 1: test che falliscono**

In `$id.test.tsx`, con i doppi e le fixture del file (che restano SENZA i campi nuovi dove non servono: è la prova della difesa):

```tsx
describe("sessione di refinement", () => {
  const refineDetail = (over: Partial<SessionDetail> = {}) => ({
    ...baseDetail(), kind: "backlog_refine", state: "idle", backlogItemId: ITEM_ID,
    canWrite: true, canIntervene: true, canInterrupt: false, canClose: true, ...over,
  });

  it("idle: campo scrivibile, niente «Ferma», «Chiudi sessione» presente, stato «pronta»", async () => {
    mockDetail(refineDetail());
    renderPage();
    expect(await screen.findByRole("textbox")).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: /ferma|stop/i })).toBeNull();
    expect(screen.getByRole("button", { name: /chiudi sessione|close session/i })).toBeInTheDocument();
    expect(screen.getByText(/pronta|ready/i)).toBeInTheDocument();
  });

  it("dettaglio di un server più vecchio (niente canClose): nessun «Chiudi sessione»", async () => {
    const { canClose: _omit, ...old } = refineDetail();
    mockDetail(old);
    renderPage();
    await screen.findByRole("textbox");
    expect(screen.queryByRole("button", { name: /chiudi sessione|close session/i })).toBeNull();
  });

  it("«Chiudi sessione»: conferma, poi DELETE della sessione della voce", async () => {
    mockDetail(refineDetail());
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /chiudi sessione|close session/i }));
    await userEvent.click(screen.getByRole("button", { name: /conferma|confirm/i }));
    expect(closeRefineSessionMock).toHaveBeenCalledWith(ITEM_ID);
  });

  it("riquadro della voce: titolo, design e piano; si rilegge a ogni nuovo dettaglio", async () => {
    mockDetail(refineDetail());
    getBacklogItemMock.mockResolvedValueOnce(itemFixture({ document: "# Design v1" }))
      .mockResolvedValueOnce(itemFixture({ document: "# Design v2" }));
    renderPage();
    expect(await screen.findByText("Design v1")).toBeInTheDocument();
    pushDetail(refineDetail({ lastEventAt: "2026-10-14T10:05:00.000Z" })); // come farebbe lo stream
    expect(await screen.findByText("Design v2")).toBeInTheDocument();
  });

  it("messaggio non consegnato per budget: il motivo in parole, mai la chiave", async () => {
    mockDetail(refineDetail({ inputs: [inputFixture({ status: "undelivered", reason: "budget_exceeded" })] }));
    renderPage();
    expect(await screen.findByText(/budget/i)).toBeInTheDocument();
    expect(screen.queryByText(/budget_exceeded/)).toBeNull();
  });

  it("409 item_closed all'invio: errore in parole, il testo resta nel campo", async () => {
    mockDetail(refineDetail());
    sendAgentMessageMock.mockRejectedValueOnce(new ApiError(409, "item_closed", "closed"));
    renderPage();
    const field = await screen.findByRole("textbox");
    await userEvent.type(field, "ancora una cosa");
    await userEvent.click(screen.getByRole("button", { name: /invia|send/i }));
    expect(await screen.findByText(/convertita o archiviata|converted or archived/i)).toBeInTheDocument();
    expect(field).toHaveValue("ancora una cosa");
  });
});
```

I nomi degli helper (`baseDetail`, `mockDetail`, `pushDetail`, `renderPage`, `inputFixture`, i mock di `api.ts`) vanno presi da come il file costruisce già i suoi casi (`grep -n "function \|vi.mock" apps/web/src/routes/agents/\$id.test.tsx`); quelli che mancano (`pushDetail`: `queryClient.setQueryData(agentSessionKeys.detail(id), next)`, che è ciò che fa lo stream) si aggiungono in testa al file. La costruzione di `ApiError` segue il costruttore vero (`packages/api-client/src/errors.ts`).

- [ ] **Step 2: verificare che falliscano**

Run: `pnpm --filter @stubwise/web test -- routes/agents`
Expected: FAIL nei test nuovi.

- [ ] **Step 3: implementazione**

`api.ts`:

```ts
/** Avvia o riprende la sessione di refinement della voce; con `message` è il primo turno. */
export function startRefineSession(itemId: string, message?: string) {
  return client.backlogRefine.start(itemId, message !== undefined ? { message } : {});
}

/** «Chiudi sessione»: idempotente. */
export function closeRefineSession(itemId: string): Promise<void> {
  return client.backlogRefine.close(itemId);
}
```

`refine-item-panel.tsx`:

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { backlogItemQueryOptions, backlogKeys } from "../../lib/queries";

/**
 * La voce di una sessione di refinement (design 2026-10-14 §6.1): titolo,
 * metadati, design e piano ATTUALI. `refreshKey` cambia a ogni dettaglio
 * nuovo della sessione (il ponte dei tool notifica la sessione a ogni
 * scrittura): qui diventa un'invalidazione della voce.
 */
export function RefineItemPanel({ itemId, refreshKey }: { itemId: string; refreshKey: number }) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const item = useQuery(backlogItemQueryOptions(itemId));
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: backlogKeys.detail(itemId) });
  }, [queryClient, itemId, refreshKey]);
  if (item.isError) return <p className="text-sm text-fg-muted">{t("refineItem.loadError")}</p>;
  if (item.data === undefined) return null;
  const data = item.data;
  return (
    <section aria-label={t("refineItem.label")} className="rounded-sm border border-line p-4">
      <Link to="/backlog/$id" params={{ id: itemId }} className="font-medium hover:underline">{data.title}</Link>
      {/* metadati: effort, rischio (+ nota), urgenza — stesse etichette della pagina della voce */}
      <details className="mt-3">
        <summary>{t("refineItem.design")}</summary>
        {/* lo stesso renderer markdown della pagina della voce, su data.document */}
      </details>
      <details className="mt-2">
        <summary>{t("refineItem.plan")}</summary>
        {/* data.implementationPlan ?? t("refineItem.noPlan") */}
      </details>
    </section>
  );
}
```

(Il renderer markdown e il blocco dei metadati: riusare i componenti che `apps/web/src/routes/backlog/$id.tsx` usa per le sezioni «Design» (~L342) e «Piano» (~L369), importandoli; se sono locali a quel file, estrarli in `apps/web/src/components/backlog/` in questo stesso task senza cambiarli.)

In `AgentSessionView`, dopo `<SessionHeader …/>`:

```tsx
        {detail.kind === "backlog_refine" && (detail.backlogItemId ?? null) !== null && (
          <div className="mt-4">
            <RefineItemPanel itemId={detail.backlogItemId!} refreshKey={session.detailUpdatedAt} />
          </div>
        )}
```

`useAgentSession` espone `detailUpdatedAt: detailQuery.dataUpdatedAt` (una riga in `apps/web/src/lib/agent-session-view.ts`). Il bottone «Chiudi sessione» è un componente `CloseSessionButton({ itemId, sessionId })` nello stesso file, montato accanto all'intestazione con `(detail.canClose ?? false) && detail.backlogItemId`: `useMutation(closeRefineSession)`, conferma prima, `onSuccess` invalida `agentSessionKeys.detail(sessionId)` e `backlogKeys.detail(itemId)`.

Testi in `en.json`/`it.json` come elencati sopra.

- [ ] **Step 4: verificare e committare**

Run: `pnpm --filter @stubwise/web test -- routes/agents i18n && pnpm --filter @stubwise/web typecheck && pnpm lint`
Expected: PASS.

```bash
git add apps/web
git commit -m "feat(web): sessione di refinement nella vista delle sessioni (chiudi, riquadro della voce)"
```

---

### Task B3: Web — pagina della voce

**Files:**
- Modify: `apps/web/src/routes/backlog/$id.tsx` (`ActionsPanel` ~L651-830)
- Create: `apps/web/src/components/backlog/refine-session-card.tsx`
- Modify: `apps/web/src/i18n/locales/en.json`, `it.json` (sezione `backlog`)
- Test: `apps/web/src/routes/backlog/$id.test.tsx`

**Interfaces:**
- Consumes: `refineSession` del dettaglio della voce (Piano A Task 1/11); `startRefineSession` (B2); `isAgentSessionsUnavailable`.

Comportamento (spec §6.1):
- Voce `converted` o `archived` (`isLocked`): niente.
- `refineSession ?? null` è `null` o `status === "closed"`: un bottone «Inizia sessione» / «Riprendi sessione» (secondo che la sessione esista) che apre un pannello con un campo facoltativo per il primo messaggio e «Avvia». Avvio riuscito → `navigate({ to: "/agents/$id", params: { id: agentSessionId } })`. 409 `item_closed` → errore in parole e rilettura della voce. 404 senza `code` (server senza la funzione) → «non disponibile su questa istanza».
- `status === "active"`: una riga di stato («Sessione di refinement aperta») e il link «Apri la sessione» a `/agents/$id`. Lo stato fine («al lavoro» / «pronta») NON si deduce dalla voce: è nella vista della sessione.

- [ ] **Step 1: test che falliscono**

```tsx
describe("sessione di refinement sulla pagina della voce", () => {
  it("dettaglio SENZA refineSession (server più vecchio): «Inizia sessione», nessun crash", async () => {
    mockItem(itemFixture()); // la fixture del file, senza il campo
    renderPage();
    expect(await screen.findByRole("button", { name: /inizia sessione|start session/i })).toBeInTheDocument();
  });

  it("avvio col primo messaggio: POST e navigazione alla sessione", async () => {
    mockItem(itemFixture());
    startRefineSessionMock.mockResolvedValue({ agentSessionId: SESSION_ID, inputId: INPUT_ID });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /inizia sessione|start session/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /primo messaggio|first message/i }), "partiamo dal formato");
    await userEvent.click(screen.getByRole("button", { name: /avvia|start$/i }));
    expect(startRefineSessionMock).toHaveBeenCalledWith(ITEM_ID, "partiamo dal formato");
    expect(navigateMock).toHaveBeenCalledWith({ to: "/agents/$id", params: { id: SESSION_ID } });
  });

  it("sessione chiusa: «Riprendi sessione»; attiva: link alla sessione", async () => {
    mockItem(itemFixture({ refineSession: { agentSessionId: SESSION_ID, status: "closed", closedReason: "idle", lastActivityAt: NOW } }));
    renderPage();
    expect(await screen.findByRole("button", { name: /riprendi sessione|resume session/i })).toBeInTheDocument();
    cleanup();
    mockItem(itemFixture({ refineSession: { agentSessionId: SESSION_ID, status: "active", closedReason: null, lastActivityAt: NOW } }));
    renderPage();
    expect(await screen.findByRole("link", { name: /apri la sessione|open the session/i })).toHaveAttribute("href", `/agents/${SESSION_ID}`);
  });

  it("voce convertita: niente bottone", async () => {
    mockItem(itemFixture({ status: "converted" }));
    renderPage();
    await screen.findByText(itemFixture().title);
    expect(screen.queryByRole("button", { name: /sessione|session/i })).toBeNull();
  });

  it("server senza la funzione (404 senza code): «non disponibile», niente navigazione", async () => {
    mockItem(itemFixture());
    startRefineSessionMock.mockRejectedValue(new ApiError(404, undefined, "Route not found"));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /inizia sessione|start session/i }));
    await userEvent.click(screen.getByRole("button", { name: /avvia|start$/i }));
    expect(await screen.findByText(/non disponibile|not available/i)).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
```

(Helper e mock dal file: `grep -n "vi.mock\|function " apps/web/src/routes/backlog/\$id.test.tsx`.)

- [ ] **Step 2: implementazione**

`RefineSessionCard({ item })` in `components/backlog/refine-session-card.tsx`: legge `item.refineSession ?? null`, `useMutation({ mutationFn: (message?: string) => startRefineSession(item.id, message) })`, `onSuccess` → `navigate`, `onError` → `isAgentSessionsUnavailable(error)` ? «non disponibile» : `error.code === "item_closed"` ? testo + `invalidateQueries(backlogKeys.detail(item.id))` : errore generico. Montata in `ActionsPanel` dentro il ramo `!isLocked`, dopo il bottone del deep dive. Testi in `backlog:refine.*` (en/it): `start`, `resume`, `firstMessage` (etichetta del campo), `firstMessageHint` («Facoltativo: se lo scrivi, l'agente parte subito»), `launch`, `active`, `open`, `unavailable`, `itemClosed`, `error`.

- [ ] **Step 3: verificare e committare**

Run: `pnpm --filter @stubwise/web test -- routes/backlog i18n && pnpm --filter @stubwise/web typecheck && pnpm lint`
Expected: PASS.

E2E (non in `pnpm test`, a mano perché è una modifica UI rilevante): `pnpm --filter @stubwise/web exec playwright test` sui file che toccano backlog e sessioni; nessun test nuovo obbligatorio, ma quelli esistenti devono restare verdi.

```bash
git add apps/web
git commit -m "feat(web): avvio e ripresa della sessione di refinement dalla pagina della voce"
```

---

### Task B4: App — schermata della voce e schermata della sessione

**Files:**
- Modify: `apps/mobile/src/app/navigation.tsx` (tipo composto `BacklogItemScreenProps`, come `TicketScreenProps` ~L169)
- Modify: `apps/mobile/src/screens/backlog/BacklogItemScreen.tsx` (bottone e stato)
- Modify: `apps/mobile/src/screens/agents/AgentSessionScreen.tsx` («Chiudi sessione», riquadro della voce)
- Create: `apps/mobile/src/components/agents/RefineItemPanel.tsx`
- Modify: `apps/mobile/src/lib/agent-session-errors.ts` (`item_closed`)
- Modify: `apps/mobile/src/i18n/en.json`, `it.json` (`mobile.agents.*`, `mobile.backlog.*`)
- Test: `apps/mobile/src/screens/backlog/BacklogItemScreen.test.tsx`, `apps/mobile/src/screens/agents/AgentSessionScreen.test.tsx`

**Interfaces:**
- Consumes: `client.backlogRefine.start/close` (Piano A Task 13), `refineSession`, `canClose`, `idle`, motivi nuovi, `backlogItemId` (B1); `openAgentSession` (`apps/mobile/src/lib/open-agent-session.ts`).

Regole dell'app che contano qui:
- **Doppio del client prima dei test**: `makeClient()` di ENTRAMBI i file di test guadagna `backlogRefine: { start: jest.fn(), close: jest.fn() }` (e in `AgentSessionScreen.test.tsx` anche `backlog.get` per il riquadro) PRIMA di scrivere i test che li usano. Un test che passa al primo colpo su una lettura nuova va fatto fallire apposta togliendo il `mockResolvedValue`, prima di crederci.
- **Fixture complete**: la fixture del dettaglio di una voce guadagna `refineSession: null`; quella del dettaglio di una sessione `canClose: false` e `backlogItemId: null`. Il caso «server più vecchio» nell'app lo copre già `readerSchema` in produzione; nei test si prova con un client che RIFIUTA lo start con un 404 senza `code`.
- **Foglio nativo che porta a un'altra schermata**: se l'avvio usa un foglio (campo del primo messaggio), chiudere, smontare, POI `openAgentSession` (invariante dell'app, 5 ott 2026).
- `BacklogItemScreen` sta in uno stack delle schede: `openAgentSession` ha bisogno del tipo composto per salire al root stack (`navigation.navigate("AgentSession", …, { pop: true })`), come `WorkScreen`.

Comportamento: lo stesso del web (B2, B3). In `BacklogItemScreen`, accanto a «Raffina in chat» (`backlog-item-refine`), un bottone `backlog-item-refine-session` («Inizia sessione» / «Riprendi sessione») che apre un foglio col campo facoltativo e «Avvia»; con una sessione attiva, «Apri la sessione» (`backlog-item-open-session`). Nascosto su voce chiusa e — dopo il primo tentativo — su `isAgentSessionsUnavailable` (lo stato si tiene in memoria della schermata: niente persistenza). In `AgentSessionScreen`: «Chiudi sessione» (`agent-session-close`) con `Alert`-free conferma (lo stesso componente di conferma che l'app usa per le azioni distruttive: `grep -rn "Confirm" apps/mobile/src/components | head`), e `RefineItemPanel` in testa per `kind === "backlog_refine"`, riletto a ogni nuovo dettaglio come sul web.

- [ ] **Step 1: doppi e fixture, poi test che falliscono**

`BacklogItemScreen.test.tsx`:

```tsx
function makeClient(overrides: { get?: jest.Mock; convert?: jest.Mock; start?: jest.Mock } = {}): StubwiseClient {
  return {
    backlog: { /* …come oggi… */ },
    backlogRefine: {
      start: overrides.start ?? jest.fn().mockResolvedValue({ agentSessionId: SESSION_ID, inputId: null }),
      close: jest.fn(),
    },
  } as unknown as StubwiseClient;
}

it("avvio: start col primo messaggio e apertura della sessione sul root stack", async () => {
  const start = jest.fn().mockResolvedValue({ agentSessionId: SESSION_ID, inputId: INPUT_ID });
  const { navigate } = await renderScreen(makeClient({ start }));
  fireEvent.press(await screen.findByTestId("backlog-item-refine-session"));
  fireEvent.changeText(screen.getByTestId("refine-session-first-message"), "partiamo");
  fireEvent.press(screen.getByTestId("refine-session-launch"));
  await waitFor(() => expect(start).toHaveBeenCalledWith(ITEM_ID, { message: "partiamo" }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("AgentSession", { id: SESSION_ID }, { pop: true }));
});

it("server senza la funzione: dopo il 404 senza code il bottone sparisce", async () => {
  const start = jest.fn().mockRejectedValue(new ApiError(404, undefined, "Route not found"));
  await renderScreen(makeClient({ start }));
  fireEvent.press(await screen.findByTestId("backlog-item-refine-session"));
  fireEvent.press(screen.getByTestId("refine-session-launch"));
  await waitFor(() => expect(screen.queryByTestId("backlog-item-refine-session")).toBeNull());
});

it("sessione attiva: «Apri la sessione»; voce convertita: niente", async () => { /* due render, come sul web */ });
```

`AgentSessionScreen.test.tsx`: gli stessi casi di B2 (idle scrivibile senza «Ferma», `agent-session-close` solo con `canClose`, conferma → `backlogRefine.close(ITEM_ID)`, motivo `budget_exceeded` in parole, `item_closed` in parole col testo che resta, riquadro della voce che si rilegge a un nuovo dettaglio). Ogni `render` è `await`ato.

- [ ] **Step 2: verificare che falliscano**

Run: `pnpm --filter @stubwise/mobile test -- BacklogItemScreen AgentSessionScreen`
Expected: FAIL nei test nuovi.

- [ ] **Step 3: implementazione**

- `navigation.tsx`: `export type BacklogItemScreenProps = CompositeScreenProps<NativeStackScreenProps<BacklogDetailParamList, "Item">, NativeStackScreenProps<RootStackParamList>>;` e `BacklogItemScreen` lo usa.
- `agent-session-errors.ts`: `case "item_closed": return t("mobile.agents.errors.item_closed");`.
- `RefineItemPanel.tsx`: `useQuery({ queryKey: ["backlog", "detail", itemId], queryFn: () => client.backlog.get(itemId) })` (la chiave è quella che `BacklogItemScreen` usa già: verificarla e riusare la stessa costante se c'è), `refetch()` in un effetto su `dataUpdatedAt` del dettaglio della sessione; titolo, metadati, design e piano in due sezioni richiudibili. Niente persistenza: la chiave non deve passare `shouldPersistQuery` (controllarlo in `apps/mobile/src/lib/` e aggiungere il prefisso agli esclusi se il backlog fosse persistito).
- Testi `en`/`it`: `mobile.agents.state.idle`, `mobile.agents.kind.backlog_refine`, `mobile.agents.segment.refine`, `mobile.agents.input.reason.turn_failed`, `…budget_exceeded`, `mobile.agents.close.*`, `mobile.agents.refineItem.*`, `mobile.agents.errors.item_closed`, `mobile.backlog.refineSession.*` — stessi testi del web.

- [ ] **Step 4: verificare e committare**

Run: `pnpm --filter @stubwise/mobile test && pnpm --filter @stubwise/mobile typecheck && pnpm lint`
Expected: PASS.

```bash
git add apps/mobile
git commit -m "feat(mobile): sessione di refinement dalla voce di backlog e nella vista della sessione"
```

---

### Task B5: Guida utente

**Files:**
- Modify: `apps/docs/src/content/docs/team/backlog.md` (sezione nuova «Sessione di refinement»)
- Modify: `apps/docs/src/content/docs/ai-pipeline/agent-sessions.md` (il kind nuovo, chi scrive, «Chiudi sessione», stato «pronta»)

Contenuto, dalla spec: cos'è (una conversazione con Claude Code sulla voce, che legge TUTTE le repository in sola lettura); chi può (chiunque lavori sul backlog, anche gli operatori); cosa scrive l'agente (design, piano, titolo, effort, rischio, urgenza — con la versione precedente conservata); cosa NON fa (non approva il piano: conversione e run passano dall'approvazione di sempre; niente creazione, fusione o cancellazione di voci); vita della sessione (si chiude dopo `BACKLOG_REFINE_IDLE_MINUTES` di inattività, si riprende scrivendo, «Chiudi sessione»; si chiude da sola quando la voce diventa un ticket o viene archiviata); budget (a budget mensile esaurito scrive solo un maintainer); dove si trova nell'app.

- [ ] **Step 1: scrivere e verificare il build**

Run: `pnpm --filter @stubwise/docs build`
Expected: build verde.

- [ ] **Step 2: commit**

```bash
git add apps/docs
git commit -m "docs(guide): sessioni di refinement del backlog"
```

- [ ] **Step 3: verifica finale del piano B**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: tutto verde. Poi `graphify update .` e commit di `graphify-out/` se cambiato.
