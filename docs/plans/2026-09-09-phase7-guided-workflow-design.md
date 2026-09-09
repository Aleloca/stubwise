---
title: Fase 7 — Workflow guidato web per non-tecnici
date: 2026-09-09
status: validato (brainstorming)
program: 2026-08-31-stubwise-nerve-center-program-design.md
stubwise:
  project: stubwise
  backlog: 6b49f888-ecc6-413d-ac58-5b4da8cc2411
  ticket: https://stubwise.thecove.it/tickets/0804eba7-2b09-4faf-bbb7-ebe33eee2a28
---

# Fase 7 — Workflow guidato web per non-tecnici

Ottava fase del programma, e la più vicina al suo scopo: entro fine ottobre
2026 non ci saranno più sviluppatori, e **operatori non tecnici dovranno far
avanzare i progetti da soli** dalla web app.

Il percorso idea → modifica pronta **esiste già ed è percorribile da un
operatore**: crea una voce di backlog, la raffina in chat, la converte in
ticket, avvia il lavoro, il sistema prepara il piano e si ferma per
l'approvazione del maintainer. Non manca il motore: mancano i bottoni (alcuni
sono nascosti senza motivo), manca chi dica qual è il passo successivo, e i
messaggi di fermata e di errore sono tecnici.

## 1. Stato di partenza (fatti verificati)

- **La UI ammette il vicolo cieco**: `tickets.detail.noPlan` e
  `backlog.detail.noPlan` dicono testualmente «Ancora nessun piano di
  implementazione — collegane uno da Claude Code». Le rotte `PUT
  /api/tickets/:id/plan` e `PUT /api/backlog/:id/plan` sono `requireAuth` e i
  client esistono in `apps/web/src/lib/api.ts:412-427,3081-3096`, ma
  **nessun componente web li chiama** (solo `delete` è cablato).
- **Il percorso alternativo funziona già**: un operatore avvia il run senza
  piano, `startRun` accende `planApprovalRequired`
  (`apps/server/src/services/jobs.ts:139-148`), il worker lo legge in
  `resolveFixMode` e ritorna `mode: "plan-only"`
  (`apps/worker/src/pipeline/fix.ts:414-425`): pianifica e si ferma.
- **Il gate è una riga**: `jobs.ts:139`
  `const needsApproval = actor.role === "member" || input.requirePlanApproval === true;`
  con `useSavedPlan` a `:131`. `requirePlanApproval` estende il gate anche a
  un maintainer per i run nati da una proposta del sistema (`pulse.ts:325`).
- **Blocchi accessori**: `PATCH /api/backlog/:id` (`backlog.ts:604`),
  `suggested/accept|dismiss` (`:902,:946`), `refresh-document` (`:1278`),
  `merge` (`:1418`), `deep-dive` (`:1523`) sono `requireAdmin`; e
  l'`ActionsPanel` è **interamente nascosto** ai member
  (`apps/web/src/routes/backlog/$id.tsx:283`) — quindi anche «Converti in
  ticket», la cui rotta è aperta ai member dalla fase 0 (`backlog.ts:1379`),
  è irraggiungibile. È il blocco più assurdo dei cinque.
- **Il pannello a bottoni è già staccato dal suo contesto originale due
  volte**: `KINDS_WITH_OPTIONS = {job.awaiting_input, project.pulse,
  google.proposal}` e `KINDS_WITHOUT_JOB = {project.pulse, google.proposal}`
  (`packages/notifications/src/actions.ts:186-213`). `QuestionPanel`
  (`apps/web/src/components/question-panel.tsx`) è già progettato per essere
  ospitato altrove: `submitLabel` parametrizzabile (`:91-96`), bail-out sugli
  indici (`:26-42`), rimonta su `questionId` (`:269-277`), degrada a nulla se
  non c'è niente di azionabile (`:136`).
- **Ma le domande hanno un'ancora rigida**: `agent_questions.job_id` e
  `.ticket_id` sono NOT NULL (`packages/db/src/schema.ts:2726-2731`) con
  unique parziale «una sola aperta per job». Una voce di backlog non ha né
  job né ticket.
- **La chat del backlog è testo libero puro** (`components/backlog-chat.tsx`)
  e non usa `QuestionPanel`. Ha già due modalità: DOCS (streaming SSE su RAG
  via SDK HTTP) e CODE (turno asincrono con agente CLI su worktree
  read-only, `--resume` su sessione persistente,
  `apps/worker/src/backlog/chat-turn.ts`). **Solo la modalità CODE ha
  l'infrastruttura MCP** per porre domande a bottoni.
- **Il vocabolario umano esiste ma è scollegato**: `workStateFor` e gli 11
  stati (`packages/shared/src/work-state.ts`) sono importati **solo da
  `apps/mobile`**; il web mostra «Triage», «Fix in corso», «PR mergiata».
  Le parole italiane sono già scritte in `apps/mobile/src/i18n/it.json`
  (`mobile.work.status.*`).
- **Manca il riassunto del fallimento**: esistono `summary.plan.instructions`
  e `summary.pr.instructions` (`packages/i18n/src/catalog.ts:288-290`) e i
  campi `planSummary`/`prSummary`, ma un job `failed` ha come unica
  spiegazione il log tecnico in `AIJobTimeline`.
- **Il polso dei progetti è servito ma non consumato dal web**:
  `GET /api/projects/pulse` (`projects.ts:266`) lo usa solo l'app mobile.
- **Navigazione non filtrata**: `apps/web/src/components/app-layout.tsx:27-44`
  mostra a tutti Monitor, Repository, Impostazioni.
- **Trappola già pagata**: `actions.ts:118-147` documenta il caso di domande
  non archiviabili che, se la propagazione fallisce, restano aperte per
  sempre senza uscita sul web.

## 2. Perimetro (deciso)

Dentro: (1) sblocco delle cinque azioni; (2) conversazione guidata a bottoni;
(3) passo successivo sempre esplicito; (4) piano pre-approvato; (5)
linguaggio umano sul web, riassunto dei fallimenti, navigazione filtrata,
vista «cosa aspetta me».

Fuori: sessioni che **scrivono** codice per i maintainer (rinviate alla fase
8, dove c'è il tema del rilascio); il rilascio in produzione; una
conversazione di progetto separata da quella della voce; onboarding guidato
al primo accesso; domande dell'agente nella modalità DOCS.

**Decisione dichiarata**: la conversazione di lavoro resta ancorata alla
**voce di backlog**, non al progetto come diceva il programma. La voce è già
l'unità con un documento che cresce, uno stato che avanza e il ponte verso il
ticket; una conversazione di progetto sarebbe un secondo posto in cui vivono
i messaggi.

**I due divieti del maintainer, invarianti**: un operatore non può far
partire un piano non approvato da un maintainer, e non può mandare nulla in
produzione.

## 3. Permessi e piano pre-approvato

**Le cinque aperture** (nessuna tocca i due divieti):

| Azione | Oggi | Dopo |
| --- | --- | --- |
| Convertire in ticket | rotta aperta, bottone nel pannello admin | bottone fuori dal pannello |
| Metadati della voce (stato, urgenza, effort, rischio, titolo) | `requireAdmin` | `requireAuth` |
| Accettare/scartare i valori suggeriti | `requireAdmin` | `requireAuth` |
| Consolidare la chat nel documento | `requireAdmin` | `requireAuth` |
| Fondere duplicati, analisi approfondita | `requireAdmin` | `requireAuth` |

⚠️ **Consolidare il documento e l'analisi approfondita fanno girare l'AI**:
aprirle agli operatori significa che possono spendere. Il precedente è
`routes/briefs/$id.tsx:22-24` («chi lo lancia spende», per questo è admin).
La protezione esiste già ed è il budget mensile dell'istanza; la scelta è
consapevole e va scritta in `CLAUDE.md`.

**Piano pre-approvato.** Colonne nuove su `tickets`: `plan_approved_at`,
`plan_approved_by_user_id` (SET NULL), `plan_approved_digest` (SHA-256 del
testo del piano al momento dell'approvazione).

- Il gate diventa: `needsApproval = (actor.role === "member" &&
  !planPreApproved) || input.requirePlanApproval === true`, dove
  `planPreApproved` è vero se `plan_approved_at` non è nullo **e** il digest
  coincide con `sha256(ticket.implementation_plan)` corrente.
- **L'approvazione decade da sola** quando il piano cambia, da qualunque
  strada (MCP `set_plan`, `PUT /plan`, riscrittura del worker): il digest non
  coincide più. È più robusto che azzerare il campo a ogni scrittura, perché
  non dipende dal ricordarsi di farlo in ogni percorso.
- `POST /api/tickets/:id/pre-approve-plan` (`requireAdmin`, 409 se non c'è
  piano) e `DELETE` per revocare. Registrato in `project_decisions` con
  `source: "plan_review"` e testo da template i18n, mai dall'AI.
- `requirePlanApproval: true` (proposte del sistema) **vince sempre** sulla
  pre-approvazione: chi clicca «Procedi» non ha letto un piano.
- UI del ticket: «Piano approvato da {nome} il {data}, pronto per partire»
  oppure «Piano modificato dopo l'approvazione: serve un nuovo via libera».

## 4. Conversazione guidata

**Due sorgenti di bottoni, distinte per natura.**

1. **I passi del percorso**, prodotti dal **sistema**, deterministici: una
   riga sopra la conversazione che dice dove sei e cosa puoi fare adesso.
   Stati derivati da voce + ticket + job, non da un modello: «idea da
   chiarire», «pronta: la converto in un lavoro?», «lavoro avviato, sto
   preparando il piano», «piano pronto, serve l'ok di {maintainer}», «in
   esecuzione», «modifica pronta, il rilascio spetta a un maintainer».
2. **Le domande dell'agente**, con 2-3 opzioni, `consequence` per ciascuna,
   consigliata marcata ma **mai preselezionata**, testo libero come
   alternativa. Rese da `QuestionPanel` **dentro la bolla della
   conversazione**.

**Limitazione dichiarata**: in v1 le domande dell'agente arrivano solo dalla
**modalità CODE**, dove il turno gira col CLI e l'infrastruttura MCP di
`ask_user` è cablabile (`apps/worker/src/pipeline/ask-user.ts` è indipendente
da `runFix`). La modalità DOCS risponde in prosa come oggi e mostra solo i
bottoni dei passi: farle produrre domande richiederebbe di cambiare il
trasporto SSE, e non vale il rischio ora.

**Ancora nuova**: tabella `backlog_questions`, gemella di `agent_questions`
ma ancorata a `backlog_item_id` (cascade): `question`, `options` jsonb
(2..4, `label` + `consequence`), `recommended_index`, `allow_free_text`,
`answer` jsonb (union `{optionIndex} | {text}`), `asked_at`, `answered_at`,
`answered_by_user_id` (SET NULL), `dismissed_at`; CHECK
`(answer IS NULL) = (answered_at IS NULL)`; **unique parziale**: una sola
domanda aperta per voce. Il messaggio in chat la referenzia.

**La risposta è unica**: UPDATE guardato su `answered_at IS NULL`, come
`answerQuestion` (`apps/server/src/services/questions.ts:239-293`). Il
servizio è un gemello, non un'estensione di quello esistente.

**L'uscita, per non ripetere la trappola.** Ogni domanda ha sempre
**«non ora»**, che la marca `dismissed_at` e lascia la conversazione libera.
E se la voce viene convertita o archiviata mentre una domanda è aperta, la
domanda si chiude da sola nella stessa transazione. Nessuna domanda può
restare aperta senza via d'uscita.

**Aspetto**: la conversazione resta accanto al documento (il layout split di
`routes/backlog/$id.tsx:71-78` è già quello giusto). Le domande sono bolle
con i bottoni dentro; la scelta fatta **resta scritta** nella conversazione,
così a distanza di giorni si legge cosa è stato deciso.

## 5. Linguaggio e leggibilità

- **`workStateFor` sul web**: adottare `packages/shared/src/work-state.ts`
  in `AIJobTimeline` e nei badge; portare le chiavi `mobile.work.status.*`
  in `apps/web/src/i18n/locales/{en,it}.json` (guardia:
  `apps/web/src/i18n/parity.test.ts`).
- **Riassunto del fallimento**: `ai_jobs.failure_summary` (text, nullable),
  generato come `planSummary`/`prSummary` con `runAgentText`
  (`permissionMode "plan"`, best-effort, nella lingua di contenuto) quando
  un job entra in `failed`. Nuove istruzioni `summary.failure.instructions`
  in `packages/i18n/src/catalog.ts` accanto alle altre due: cosa si stava
  facendo, cosa non ha funzionato, cosa si può fare adesso, e **quando la
  risposta è «serve un maintainer» dirlo**. Se la generazione fallisce, si
  degrada al log come oggi.
- **Navigazione filtrata per ruolo** in `app-layout.tsx:27-44`, con le
  guardie `beforeLoad` coerenti in `router.tsx`.
- **Vista «cosa aspetta me»**: consumare `GET /api/projects/pulse` nella
  pagina dei progetti, con le frasi già scritte in
  `apps/mobile/src/lib/pulse-line.ts` («aspetta te», «sta lavorando»,
  «fermo da N giorni», «tutto tranquillo»).

## 6. Test e deploy

- **Test**: le cinque aperture (un member le esegue, i due divieti restano:
  `approve-plan` e `reject-plan` continuano a dare 403); pre-approvazione
  (decade se il piano cambia da ciascuna delle tre strade; due approvazioni
  concorrenti; `requirePlanApproval` vince sempre; decisione registrata da
  template); domande (unicità della risposta sotto concorrenza, «non ora»,
  chiusura automatica alla conversione e all'archiviazione, bail-out sugli
  indici, rimonta su id); riassunto del fallimento (generato, e degrado al
  log se il run fallisce); `workStateFor` sul web con parità i18n;
  navigazione filtrata; vista polso.
- **Deploy**: migrazione (tabella `backlog_questions`, tre colonne su
  `tickets`, una su `ai_jobs`); rebuild server+worker+caddy insieme; nessuna
  env obbligatoria nuova. **Rollback sicuro**: nessun `notification_kind`
  nuovo e nessun valore aggiunto a un enum esistente, quindi scendere di
  immagine non richiede di ripulire righe; le domande aperte in
  `backlog_questions` semplicemente non sarebbero più mostrate.
