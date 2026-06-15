# Stubwise — Loop di feedback AI (design)

> Design validato il 2026-06-15. Estende la pipeline AI con l'intervento umano su
> un job già avviato: rilancio con contesto invece di subire un esito secco.
> Backlog: vedi `docs/plans/feature-backlog.md` (sezione "Rendere l'AI più affidabile").

## Obiettivo

Tre capacità che condividono un'idea: l'umano interviene su un job e lo rilancia
con contesto.

- **A — Riapertura su PR rifiutata.** Il webhook oggi cattura solo il merge;
  aggiungiamo l'evento "PR chiusa senza merge" → il ticket si riapre e notifica.
- **B — Rilancio con istruzioni.** L'umano commenta una guida e rilancia; il fix
  la incorpora e salta il triage.
- **C — Approvazione del piano.** Per fix rischiosi (per tipo/effort), Opus
  produce il piano e si ferma; l'umano approva o rifiuta-con-istruzioni.

## Modello dati

**Nuovi stati job (`ai_job_status`):**

- `pr_closed` — la PR aperta dalla pipeline è stata chiusa senza merge.
- `awaiting_plan_approval` — il piano è pronto e attende l'approvazione umana.

**Nuove colonne su `ai_jobs`:**

- `plan_text text` (nullable) — il piano prodotto da Opus, persistito tra la
  fase di pianificazione e quella di esecuzione.
- `resume_mode` enum nullable: `null` | `"fix"` | `"execute"` — dice al worker
  come riprendere un job rimesso in coda:
  - `null` → job normale: triage → (gate) → fix;
  - `"fix"` → salta il triage, va al fix (eventualmente si ri-ferma sul gate del
    piano);
  - `"execute"` → salta triage **e** pianificazione, esegue direttamente usando
    `plan_text`.

**Nuova colonna su `automation_rules`:**

- `plan_approval_min_effort int` (nullable, 1-5): `null` = non serve mai
  approvazione; `N` = approvazione richiesta quando l'effort stimato ≥ N. Una
  manopola per-tipo, coerente col gate `auto_fix`/`max_effort` esistente.

**Nuove colonne su `notification_settings`:**

- `notify_pr_closed boolean` (default `true`).
- `notify_plan_review boolean` (default `true`).

**Invarianti preservate:**

- `requeueStale` agisce solo su `triaging`/`fixing` (`ACTIVE_STATUSES`): i nuovi
  stati `pr_closed` e `awaiting_plan_approval` sono parcheggiati e non vengono
  riaccodati.
- La serializzazione per-progetto si libera appena il job esce dallo stato
  attivo: un job in attesa di approvazione non blocca gli altri job del progetto.

## A — Riapertura su PR rifiutata

**`@stubwise/git` — `parseWebhook` diventa unione discriminata:**

```ts
type WebhookEvent =
  | { kind: "merged"; branch: string; prUrl: string }
  | { kind: "closed_unmerged"; branch: string; prUrl: string };
parseWebhook(headers, body): WebhookEvent | null;
```

- **GitHub:** `action === "closed"` → `merged === true` ? `merged` : `closed_unmerged`.
- **Bitbucket:** `pullrequest:fulfilled` → `merged`; `pullrequest:rejected` →
  `closed_unmerged`. Aggiungere `pullrequest:rejected` agli eventi registrati in
  `ensureWebhook` (oggi solo `fulfilled`).

**Server — `webhooks.ts`.** Dopo il match del ramo `stubwise/ticket-N`, dispatch
su `event.kind`:

- `merged` → invariato (ticket `done`, job `pr_opened` → `pr_merged`).
- `closed_unmerged` → in transazione, **solo se** il ticket è in `in_review`
  (idempotenza: ri-consegna o ticket già spostato → 204):
  - ticket → `triaged`;
  - job `pr_opened` → `pr_closed` (`finishedAt` valorizzato);
  - commento di sistema: *"PR chiusa senza merge: <url> — ticket riaperto,
    rilancia il fix quando vuoi"*;
  - `dispatchNotification` evento `pr_closed`.

**Perché `triaged` e non `open`:** il ticket è già classificato e stimato; torna
nello stato "pronto al lavoro" da cui l'umano aggiunge istruzioni e rilancia
(capacità B). Il branch `stubwise/ticket-N` resta sul provider; un rilancio
lavora sullo stesso branch (force-update), coerente con la serializzazione.

## B — Rilancio con istruzioni

**Interazione.** L'umano scrive un commento (`authorType=user`) con la guida,
poi preme **"Rilancia con istruzioni"**.

**Server — `POST /:id/run-ai` con body `{ withInstructions?: boolean }`:**

- assente/false → comportamento attuale: re-queue con `resume_mode = null` (il
  worker rifà il triage).
- `true` → re-queue con `resume_mode = "fix"` (salta triage, va al fix). In
  entrambi i casi `manualTrigger = true`.

Il bottone è sempre disponibile; senza commenti utente recenti mostra un hint
("aggiungi prima un commento con le istruzioni") ma non blocca.

**Worker — prompt del fix.**

1. Il prompt include **sempre** i commenti utente del ticket come sezione
   *"Indicazioni del team"*, più recenti per primi, con tetto (ultimi ~10
   commenti / budget caratteri). Vale anche per i fix automatici.
2. `resume_mode = "fix"` fa partire il worker dalla fase `fixing` (salta
   `triaging`).

**Sicurezza prompt.** I commenti utente entrano come testo non fidato, in una
sezione delimitata, con la nota all'agente che sono input dell'utente e non
istruzioni di sistema (stesso trattamento di titolo/body).

## C — Approvazione del piano

**Gate.** Nel triage, oltre a `allowAuto`, si valuta
`needsPlanApproval = rule.planApprovalMinEffort != null && effort >= rule.planApprovalMinEffort`.
Se il fix è ammesso (auto o manuale) **e** `needsPlanApproval`, il job entra in
modalità "pianifica e fermati".

**Worker — split del fix a due fasi:**

1. **Job normale senza gate** (`resume_mode = null`, no approvazione) →
   invariato: piano + esecuzione di fila, poi commit/push/PR.
2. **Job con approvazione richiesta** → esegue **solo la fase piano** (Opus,
   worktree read-only). Poi:
   - persiste l'output in `plan_text`;
   - posta un commento AI col piano (timeline) + azioni *Approva* / *Rifiuta*;
   - job → `awaiting_plan_approval`, ticket resta `in_progress`;
   - `dispatchNotification` evento `plan_review`;
   - smonta il worktree (conserva solo `plan_text`), il worker si libera.
3. **Ripresa in esecuzione** (`resume_mode = "execute"`) → ricrea il worktree,
   **salta la pianificazione**, dà a Sonnet il `plan_text` approvato come
   istruzioni, poi commit/push/PR. Non ri-pianifica.

**Endpoint di approvazione:**

- `POST /:id/approve-plan` → job `awaiting_plan_approval` → `queued`,
  `resume_mode = "execute"`, `plan_text` conservato, commento di sistema "Piano
  approvato da <utente>".
- `POST /:id/reject-plan` → job → `queued`, `resume_mode = "fix"`, `plan_text`
  azzerato. Il rifiuto incorpora i commenti utente (la guida è un commento, come
  in B): il worker ri-pianifica e si **ri-ferma** in `awaiting_plan_approval`.
  Commento di sistema "Piano rifiutato da <utente> — ripianificazione in corso".

Entrambi gli endpoint sono UPDATE condizionati sullo stato
`awaiting_plan_approval`: approvazioni doppie o su job in altro stato non fanno
nulla (idempotenza).

## UI (web — dettaglio ticket)

- Bottone **"Rilancia con istruzioni"** accanto al box commento (chiama `run-ai`
  con `withInstructions:true`); resta il "Rilancia il fix" semplice esistente.
- Job `awaiting_plan_approval`: il commento AI col piano mostra in calce
  **Approva** / **Rifiuta** (il rifiuto apre il box commento con hint, poi
  `reject-plan`).
- Nuovi badge per `pr_closed` e `awaiting_plan_approval`.
- **Settings → Automazione AI:** per ogni tipo, campo "Approvazione piano da
  effort ≥" (select 1-5 o "mai").

## Test (TDD)

- `@stubwise/git`: `parseWebhook` → `closed_unmerged` per GitHub
  `closed`+`merged:false` e Bitbucket `pullrequest:rejected`; `merged` invariato.
- server `webhooks.test.ts`: PR chiusa-senza-merge su ticket `in_review` →
  `triaged` + job `pr_closed` + commento + notifica; idempotenza fuori da
  `in_review`.
- server: `run-ai {withInstructions}` → `resume_mode="fix"`;
  `approve-plan`/`reject-plan` solo da `awaiting_plan_approval`.
- worker: gate `plan_approval_min_effort` → `awaiting_plan_approval` +
  `plan_text` persistito + commento; `resume_mode="execute"` salta piano e usa
  `plan_text`; `reject` ri-pianifica e si ri-ferma; prompt fix include i commenti
  utente.
- `@stubwise/notifications`: format dei nuovi eventi `pr_closed` / `plan_review`.

## Migrazione DB

Una migrazione Drizzle, tutta additiva/nullable (sicura sul prod esistente,
backup prima):

- 2 nuovi valori enum `ai_job_status` (`pr_closed`, `awaiting_plan_approval`);
- nuovo enum `resume_mode`;
- `ai_jobs.plan_text` + `ai_jobs.resume_mode`;
- `automation_rules.plan_approval_min_effort`;
- `notification_settings.notify_pr_closed` + `notify_plan_review`.

## Docs

- `ai-pipeline/how-it-works.md` — sezione loop di feedback.
- `ai-pipeline/automation.md` — soglia approvazione piano.
- `notifications/index.md` — nuovi eventi `pr_closed` / `plan_review`.
