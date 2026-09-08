---
title: Fase 6c — fix di review prima del merge
date: 2026-09-08
design: 2026-09-08-phase6c-mail-admission-design.md
plan: 2026-09-08-phase6c-mail-admission-plan.md
stubwise:
  project: stubwise
  backlog: 868cdecc-a4ed-4d87-9b4e-94a7dd9a1faa
---

# Fase 6c — fix di review prima del merge

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> Lavora nel worktree esistente `.worktrees/phase6c-mail-admission` (branch
> `feature/phase6c-mail-admission`, PR #15, HEAD `d70ff33`). **Non** mergiare
> e **non** deployare. Alla fine: push, CI verde (incluso E2E), report con
> HEAD e link al run. Le posizioni `file:riga` sono di HEAD `d70ff33`.

**Goal:** chiudere i findings della review indipendente (tre revisori:
permessi e privacy, ammissione e smistamento, regressioni e deploy). Due
riguardano promesse fatte all'utente (consenso, rollback), uno una
dimenticanza funzionale, e due sono decisioni di prodotto già prese dal
maintainer.

**Convenzioni**: TDD, commit piccoli in italiano, `pnpm lint` e `pnpm -r
typecheck` prima dell'ultimo commit.

---

### Task 1: le esclusioni valgono solo per l'ammissione dai domini di lavoro

**Decisione del maintainer** (8 set 2026, esplicita): una regola di progetto
è una scelta deliberata su un mittente preciso, e deve **ammettere sempre**.
Le esclusioni servono a contenere l'ammissione larga per dominio di lavoro,
non a limitare quella mirata. Oggi non è così, ed è un **restringimento
silenzioso del perimetro esistente**.

**Finding**: in `admit` (`packages/notifications/src/email-routing.ts:436-470`)
le esclusioni girano **prima** e vincono su tutto, quindi `denyLabels` e
`denyAutomated` (default entrambi attivi, migrazione 0071) si applicano anche
al ramo `project_rule`. Un'email che una regola di progetto ammette oggi e
che porta `List-Unsubscribe` (comune in notifiche di CRM, ticketing e
piattaforme aziendali legittime) o l'etichetta `CATEGORY_PROMOTIONS`
verrebbe scartata in silenzio, senza download. Il commento della migrazione
0071 afferma testualmente il contrario. Il test
(`email-routing.test.ts:503-524`) passa solo perché i suoi messaggi non hanno
né etichette escluse né header automatici.

**Files:**
- Modify: `packages/notifications/src/email-routing.ts:436-470` (ordine nuovo: **prima** si valuta la regola di progetto, che ammette e basta; poi, solo per il ramo del dominio di lavoro, si applicano le esclusioni. Il motivo va scritto nel codice, non solo qui)
- Modify: `packages/db/drizzle/0071_mail_admission.sql` (il commento va corretto: **non** riscrivere lo statement, la migrazione è già applicata su nessun ambiente ma il file è storia; se il commento è nel corpo del file va bene correggerlo ora, prima del merge) e `packages/db/src/schema.ts` se il commento è ripetuto lì
- Test: `email-routing.test.ts` (regola di progetto + `List-Unsubscribe` → **ammessa**; regola di progetto + `CATEGORY_PROMOTIONS` → **ammessa**; dominio di lavoro + `List-Unsubscribe` → rifiutata; dominio di lavoro + etichetta esclusa → rifiutata; il test «interruttore spento coincide con `inScope`» va **rinforzato** con messaggi che hanno etichette escluse e header automatici, così coprirebbe davvero il caso)

**Step 1: test rosso** → **Step 2–4**: rosso → fix → verde.
**Step 5: Commit** `fix(routing): le esclusioni non restringono le regole di progetto`.

### Task 2: un dominio di lavoro fra i destinatari ammette, in copia o meno

**Decisione del maintainer** (8 set 2026): l'esito non deve dipendere da come
il mittente ha compilato i campi. Un'email che coinvolge due identità
aziendali diverse è lavoro, che il secondo indirizzo sia fra i destinatari o
in copia.

**Finding**: oggi `admit` ammette per dominio di lavoro solo su mittente o
`ccAddresses`, mai su `toAddresses`, e c'è un test che lo inchioda
(`email-routing.test.ts:367`). La ragione tecnica è giusta (ammettere per
destinatario significherebbe ammettere tutta la posta in arrivo), ma la
regola è arbitraria: la stessa email entra o no a seconda del campo usato.

**Regola nuova**: ammette per dominio di lavoro se
- il **mittente** appartiene a un dominio di un Workspace registrato (invariato), **oppure**
- fra i destinatari (`to` **o** `cc`, indifferentemente) compare un indirizzo di un dominio di un Workspace registrato **diverso dal dominio della casella che sta ricevendo**.

Il confronto è sul **dominio**, non sull'indirizzo: la casella che riceve è
nota (`account.email`), quindi il suo dominio si esclude e ciò che resta è un
secondo dominio di lavoro coinvolto. Così la posta ordinaria diretta a una
sola casella non entra da questo criterio, e per quella restano le regole di
progetto.

**Files:**
- Modify: `packages/notifications/src/email-routing.ts` (`admit` riceve il dominio della casella ricevente; nuovo criterio come sopra, con il ragionamento a commento e l'esempio del perché `To` da solo non basta)
- Modify: `apps/worker/src/google/poller.ts` (passa il dominio della casella; è già disponibile da `account.email`)
- Test: `email-routing.test.ts` (tabella dei tre casi del maintainer: cliente → solo `it@farmakom.it` = **non ammessa**; cliente → `it@farmakom.it` con `a.locatelli@thecove.it` in copia = **ammessa**; cliente → entrambi fra i destinatari = **ammessa**; più: due indirizzi **dello stesso** dominio della casella ricevente = non ammessa; mittente di un dominio di lavoro = ammessa comunque), `poller.test.ts`

**Step 1–4**: rosso → fix → verde.
**Step 5: Commit** `feat(routing): un secondo dominio di lavoro fra i destinatari ammette, ovunque sia`.

### Task 3: la pagina Posta mostra i messaggi in smistamento

**Finding**: la fase 6c **non tocca** `apps/server/src/routes/me-mail.ts` né
`apps/web/src/routes/mail.tsx` (zero righe nel diff).
`queryEmailCandidates` (`me-mail.ts:185-247`) parte da `emailProposals` con
`innerJoin(projects)`: un messaggio in smistamento vive solo su
`email_messages` con `proposalNotificationId` e **nessun figlio**, quindi non
compare mai. Conseguenze: l'esito `triage_dismissed`, che
`google-proposal.ts:668-676` si preoccupa di distinguere da un `ignored`
generico, non è leggibile da nessuna parte; «Riproponi» è irraggiungibile;
e il contatore `openProposals` (`me-mail.ts:386-394`) **include** lo
smistamento mentre la lista no, quindi il badge dice «una proposta aperta» e
la lista è vuota. Il design §4 prometteva l'opposto.

**Files:**
- Modify: `apps/server/src/routes/me-mail.ts` (la lista unisce tre sorgenti invece di due: proposte per progetto, **messaggi in smistamento** (`proposal_notification_id` valorizzato o esito di smistamento, senza figli), eventi di calendario; il keyset e l'ACL per utente restano identici; `repropose` accetta anche una riga di smistamento; i contatori diventano coerenti col contenuto della lista)
- Modify: `packages/shared/src/schemas/google.ts` (`mailItemSchema` deve reggere una riga **senza progetto**: `projectId`/`projectName` sono già nullable; serve distinguere il tipo di riga, per esempio un campo `kind` opzionale `proposal | triage | calendar` con default compatibile)
- Modify: `apps/web/src/routes/mail.tsx` (la riga di smistamento è visibilmente diversa: nessun badge di progetto ma un'etichetta «da smistare», e l'esito «nessuno di questi» leggibile), i18n en+it
- Test: `me-mail.test.ts` (un messaggio in smistamento compare in lista; il contatore coincide con le righe mostrate; `repropose` su una riga di smistamento; ACL per utente invariata; il calendario resta com'è), web

**Step 1–4**: rosso → fix → verde.
**Step 5: Commit** `fix(mail): i messaggi da smistare compaiono nella pagina Posta`.

### Task 4: dire all'utente cosa viene letto

**Finding**: la copy nuova dice correttamente **chi decide cosa**, ma nessuna
stringa visibile dice che di ogni email ammessa vengono **scaricati e
analizzati oggetto e corpo, e inviati a un provider di analisi esterno**.
Grep su tutte le chiavi i18n per `scarica|corpo|analiz|provider`: unico esito
è `projects.email.keywordsHint`. Con l'ammissione per dominio attiva di
default, chi collega una casella acconsente a molto più di prima senza che
glielo si dica. È il punto che il design §6 chiamava «la parte non tecnica
più importante della fase».

**Files:**
- Modify: `apps/web/src/i18n/locales/{en,it}.json` — `settings.google.mailAdmission.*`: una riga esplicita accanto all'interruttore dei domini di lavoro, del tipo «Di ogni email ammessa vengono letti oggetto e corpo, che sono inviati al provider di analisi configurato»; e in Account → Caselle Google, dove l'utente **collega** la casella, la stessa informazione in forma breve (è lì che si dà il consenso)
- Modify: `apps/web/src/components/mail-admission-section.tsx` e `google-accounts-section.tsx` (rendono il testo)
- Modify: `projects.email.keywordsHint` («Solo quelle nell'oggetto bastano a far scaricare il messaggio»): tecnicamente ancora vera, ma stona nella sezione che ora dichiara di non decidere l'ammissione. Riformulare.
- Modify: `apps/docs` (la guida deve dire la stessa cosa, non solo l'interfaccia)
- Test: parità i18n; test web che la stringa sia resa

**Step 1–4**: rosso → fix → verde.
**Step 5: Commit** `docs(mail): dichiarare che di ogni email ammessa si leggono oggetto e corpo`.

### Task 5: due rifiniture

- **Smistamento senza suggerimenti**: `buildTriageProposalEvent`
  (`apps/worker/src/google/proposal.ts`) produce un evento anche quando non
  c'è nessun progetto suggeribile, e la card resta con la sola opzione
  «Nessuno di questi». È **voluto** (il maintainer vuole sapere di un'email
  utile su un progetto non ancora in Stubwise), ma è l'unico caso in cui una
  notifica azionabile non offre azioni utili oltre ad archiviare: serve un
  test che ne fissi l'intenzione, così nessuno la «corregge» in futuro.
- **Byte NUL in `email-routing.ts`**: il file contiene due byte NUL letterali
  usati come separatore in `` `${rule.projectId}\0${rule.kind}\0${value}` ``.
  Git li tratta come testo, ma `grep` e `rg` classificano il file come
  binario e **non lo cercano affatto**, cioè lo strumento con cui si fa
  review. È preesistente (sta anche su `main`), ma stiamo già toccando quel
  file: sostituire con `\x1f` o con un separatore stampabile ed escapato.
  Test invariati.

**Commit** `chore(mail): test dello smistamento senza suggerimenti, separatore stampabile nel routing`.

### Task 6: push, CI verde, report

1. `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test` nel worktree → verde.
2. `graphify update .` e commit del grafo se serve; `git merge origin/main`.
3. Push; `gh run watch` finché la CI (incluso E2E) è verde.
4. Report al maintainer: HEAD finale, link al run, conferma dei sei task, eventuali flaky con i nomi.

---

## Fuori da questo piano (backlog, non ora)

- I tetti (`GMAIL_MAX_PER_DAY`, `GMAIL_THREAD_COOLDOWN_MINUTES`) restano env
  del worker invece di stare nella sezione UI come diceva il design: la
  motivazione è scritta in `mail-admission-section.tsx:29-33` con il punto
  d'innesto per dopo. Va bene così.
- `loadAdmissionConfig` fa due query per tick non cacheate fra tick:
  irrilevante col volume dichiarato.
