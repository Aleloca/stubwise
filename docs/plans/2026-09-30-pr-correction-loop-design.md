---
stubwise:
  project: stubwise
  backlogItem: bf99b3f6-3928-4178-b094-978d0de1ea17 # https://stubwise.thecove.it/backlog/bf99b3f6-3928-4178-b094-978d0de1ea17
---

# Correzioni post-PR: il ciclo review → correzione

Data: 30 set 2026. Stato: design approvato, piano da scrivere.

## 1. Il problema, verificato sul codice di oggi

Una PR aperta da Stubwise non si corregge. La review AI trova i problemi, ma
nessuno li applica:

- **Un commento sul ticket non fa partire niente.** `routes/comments.ts` salva
  e basta. I commenti utente entrano solo nel prompt di un run lanciato a
  mano (`fix.ts:1036-1046`, gli ultimi 10 con `authorType = 'user'`).
- **La review non entra mai nel prompt.** È scritta come commento
  `authorType: "ai"` (`run-review.ts:737-756`), che la query dei commenti
  del team esclude.
- **Il webhook non ascolta la PR oltre apertura e chiusura.** Bitbucket è
  iscritto a `created`/`updated`/`fulfilled`/`rejected`/`repo:push`
  (`bitbucket.ts:674-680`), GitHub a `pull_request`/`push`. "Request
  changes" e i commenti non arrivano.
- **Rilanciare il fix non aggiorna la PR.** `openWorktree` riporta sempre il
  branch al default (`mirrors.ts:452-458`), il push non è forzato
  (`mirrors.ts:647`) quindi viene rifiutato su un branch divergente, e
  `openPullRequest` fa sempre una `POST` (una seconda PR sullo stesso branch
  è rifiutata dal provider).
- **Nessuna scrittura di stato sulla PR.** Il provider sa leggere gli status
  (`bitbucket.ts:155`, `github.ts:149`) ma non scriverli, e non sa leggere i
  commenti di una PR.
- **Autore e revisore coincidono.** La review commenta con lo stesso account
  che ha aperto la PR (`run-review.ts:188-193`). GitHub vieta all'autore
  `APPROVE`/`REQUEST_CHANGES` sulla propria PR.
- **La review si accende solo a livello d'istanza**
  (`instance_settings.pr_review_enabled`), non per progetto.

Caso che l'ha fatto emergere: trion-webapp, PR #10. La review ha segnalato
problemi giusti, il maintainer ha commentato sul ticket e poi messo "Request
changes" su Bitbucket; non è successo nulla, in entrambi i casi.

## 2. Il flusso

**Prima tornata, automatica.** Il fix apre la PR e il worker accoda subito la
review (non si affida a `pullrequest:updated`: che Bitbucket lo mandi a ogni
commit non è documentato; se il webhook arriva lo stesso, l'upsert su
`pr_review_jobs (repository_id, pr_number)` lo assorbe).

1. Review `approve` → PR "approvata": status verde, stato vero della PR se c'è
   l'account revisore. Tocca a una persona.
2. Review `request_changes` e giri automatici della tornata < tetto → si
   accoda una **correzione**: worktree sul branch della PR, prompt con la
   review, push in avanti sullo stesso branch, review riaccodata. Torna a 1.
3. Review `request_changes` al tetto → il ciclo si ferma, notifica "la review
   chiede ancora modifiche dopo N correzioni automatiche". La PR resta aperta.

**Tornate successive, manuali.** Il bottone "Applica le correzioni" sul
ticket (web e app), oppure "Request changes" sulla PR (Bitbucket o GitHub),
fanno partire una correzione con il feedback umano più l'ultima review. Il
contatore si azzera e si riprende dal punto 1.

**Cosa ferma tutto:** PR mergiata o chiusa (le correzioni in coda si
annullano), tetto raggiunto, budget mensile esaurito, review spenta
d'istanza. A review spenta le correzioni manuali funzionano, ma dopo il push
nessuno controlla.

**Il contatore si deriva, non si salva:** è il numero di correzioni
`trigger = 'review'` sulla PR create dopo l'ultima correzione umana
(`stubwise` o `provider`). Non può andare fuori sincrono.

**Solo PR aperte da Stubwise** (branch `stubwise/ticket-N`). Su una PR scritta
da una persona la review continua a commentare come oggi; Stubwise non pusha
mai sul branch di qualcun altro.

## 3. Chi può chiedere una correzione

- **Da Bitbucket/GitHub:** il cancello è il permesso della piattaforma. Chi
  può mettere "Request changes" sulla PR fa ripartire il ciclo, che esista o
  no su Stubwise e qualunque ruolo abbia. Stubwise registra chi l'ha chiesto:
  l'utente se collegato (`users.bitbucketUsername`), altrimenti il login
  sulla piattaforma.
- **Dal bottone in Stubwise:** chiunque possa già lanciare un run su quel
  ticket, senza gate di approvazione. Sarebbe incoerente chiedere a un
  operatore un'approvazione che da Bitbucket non gli serve.
- **Il ciclo automatico:** nessun gate.

**L'invariante "un operatore non approva un piano da sé" resta vero** perché
una correzione non è un piano nuovo: lavora sulla PR di un piano già
approvato (o lanciato da un maintainer). Il gate in `jobs.ts` e le funzioni
`resolvePlan`/`preApprovePlan`/`revokePlanApproval` non si toccano. Il limite
di questa lettura va detto: un operatore può scrivere nella nota una
richiesta ampia. Il confine lo tiene il prompt della correzione ("applica il
feedback su questa PR, non riprogettare"), non un permesso — ed è la stessa
esposizione che chiunque ha già oggi con "Request changes" su Bitbucket.

## 4. I dati

Migrazione additiva, **nessun `ALTER TYPE`**, un solo batch.

**Tabella nuova `pr_corrections`**, una riga per correzione chiesta:

| colonna | note |
|---|---|
| `id` | |
| `ticket_id`, `repository_id`, `pr_number` | dove |
| `trigger` | CHECK `review \| stubwise \| provider` (CHECK, non pgEnum) |
| `requested_by_user_id` | nullable, FK users ON DELETE SET NULL |
| `requested_by_provider_login` | nullable, per chi non è su Stubwise |
| `review_id` | nullable, FK `pr_reviews`: l'ultima review |
| `note` | nullable, il testo del bottone |
| `provider_feedback` | jsonb nullable: fotografia dei commenti della PR |
| `status` | CHECK `pending \| queued \| done \| cancelled` (vedi §6) |
| `ai_job_id` | nullable, FK `ai_jobs` |
| `created_at` | |

`provider_feedback` è una fotografia presa al momento della richiesta: un
commento modificato dopo non cambia ciò che l'AI ha letto.

**Colonne nuove:**

- `ai_jobs.correction_id` (nullable, FK `pr_corrections`): se valorizzata il
  worker salta il triage e va in `runCorrection`. **Non** è un valore nuovo di
  `resume_mode`: quell'enum ha una trappola documentata (`handler.ts:148`, un
  valore dimenticato in `resolveFixMode` degrada in silenzio a fix completo,
  cioè a un fix che riparte dal default).
- `repositories.review_git_account_id` (nullable, FK `git_accounts` ON DELETE
  SET NULL): l'account revisore.
- `git_accounts.provider_user_id` (nullable): l'identità dell'account sulla
  piattaforma (uuid Bitbucket, id GitHub). Scritto alla validazione; per gli
  account esistenti risolto al primo uso.
- `projects.pr_correction_max_rounds` (int, default 3; 0 = ciclo automatico
  spento).
- `ticket_repositories.pr_number` (nullable): backfill nella migrazione
  estraendolo da `pr_url`.

## 5. La difesa contro il ciclo che si auto-innesca

L'account revisore mette "Request changes" → il provider manda il webhook →
Stubwise lo leggerebbe come richiesta umana e azzererebbe il contatore, per
sempre. Quindi:

- un evento dal provider (richiesta di modifiche o commento) il cui autore è
  l'account principale **o** l'account revisore della repository viene
  **scartato**, prima di qualunque scrittura;
- gli stessi account sono esclusi dalla fotografia dei commenti: la review
  l'AI la riceve già dal DB.

Se `provider_user_id` non è risolvibile per uno dei due account, l'evento
**non** fa partire la correzione (fail-closed) e resta una riga nel log: un
ciclo infinito costa di più di una richiesta persa, che si ripete dal
bottone.

## 6. Richieste concorrenti

Una sola correzione attiva per PR. La regola `job_in_flight` di `startRun`
(un job vivo per ticket) resta la stessa.

- **Bottone durante una correzione (o un fix) in corso:** 409 "correzione già
  in corso".
- **"Request changes" dal provider durante una correzione:** non si può
  rifiutare a chi l'ha premuto, quindi si salva come `pending`. Quando la
  correzione in corso ha pushato, al posto della review parte la `pending`
  (contatore azzerato: è una richiesta umana).
- **Più "Request changes" in attesa:** si fondono nella stessa `pending` (la
  fotografia si rifà al momento dell'avvio).
- **Review automatica che chiede modifiche mentre c'è una `pending`:** vince
  la `pending`, la correzione automatica non si accoda.

## 7. La correzione nel worker

`runCorrection` riusa la pipeline del fix — serializer per progetto, budget,
pausa sul limite, `ask_user`, plugin, `.env` di test, log sul ticket — con
queste differenze:

- **Worktree sul branch della PR.** Capacità nuova in `mirrors.ts`: dopo il
  fetch il mirror ha già `refs/heads/stubwise/ticket-N` (refspec
  `+refs/*:refs/*`); il worktree si apre lì invece che sul default, e la
  pulizia non deve cancellare quel ref prima del push.
- **Prompt nuovo** (`buildCorrectionPrompt` in `pipeline/prompts.ts`):
  l'ultima review, la nota, i commenti utente del ticket scritti **dopo
  l'ultimo giro su quella PR**, la fotografia dei commenti della PR con
  `file:riga`. Tutto come input non fidato, come `renderTeamCommentsBlock`.
  Il prompt chiede di applicare il feedback, non di riprogettare, e di
  scrivere il report come oggi.
- **Niente piano, niente PR nuova.** Commit, poi push in avanti **mai
  `--force`**, poi aggiornamento di `ticket_repositories` e commento sul
  ticket con il report; poi review riaccodata (o la `pending`, §6).
- **Stato della PR ricontrollato prima del push:** se non è più aperta, niente
  push.
- **Staleness:** la correzione non ha fase di piano, quindi il caso peggiore
  resta sotto quello del fix a due fasi. L'invariante di `index.ts` non
  cambia; il piano deve verificarlo sui numeri, non assumerlo.

## 8. Pubblicazione della review, account revisore, status

**Account revisore.** Si sceglie nel form della repository (web), fra gli
account git registrati. Il salvataggio verifica: stesso provider (e stesso
workspace su Bitbucket), account diverso dal principale, token con i permessi
per commentare e approvare. Registra `provider_user_id`.

**Pubblicazione:**

- con l'account revisore: commento **e** stato vero della PR — Bitbucket
  `POST .../request-changes`, oppure `DELETE .../request-changes` + `POST
  .../approve`; GitHub una review `REQUEST_CHANGES` / `APPROVE`;
- senza: commento con l'account principale, come oggi;
- **sempre** uno status di commit `stubwise-review` — "in corso" durante
  review e correzione, "modifiche richieste", "approvata". Lo sha completo si
  risolve dal mirror (`pr_review_jobs.head_sha` di Bitbucket è abbreviato).
  Permette di rendere la review obbligatoria per il merge dalle regole del
  branch.

Status e stato della PR sono **best-effort**: un errore lascia una riga nel log
e il ciclo prosegue. La verità sta in Stubwise.

**Metodi nuovi di `GitProvider`:** `listPrComments` (con `file:riga` per i
commenti inline), `setCommitStatus`, `submitPrReview` (`approve` /
`request_changes`), più l'identità dell'account in `validateAccount`.
`parsePrEvent` (o un parser gemello) riconosce i due eventi nuovi.

## 9. I due ingressi manuali

**Ticket, web e app.** Sotto ogni PR del ticket una riga di stato del ciclo e
il bottone "Applica le correzioni" con una nota facoltativa. La riga la
**deriva il server** e il client la legge (stessa regola di `canMerge`): le
due superfici non possono dire cose diverse. Esempi:

- "Giro 2 di 3 · correzione in corso"
- "In attesa della review"
- "Approvata dalla review · tocca a te"
- "Fermo dopo 3 correzioni automatiche"
- "Modifiche richieste da mario.rossi su Bitbucket · in coda"

L'app deve poter fare tutto ciò che fa il web sul ticket: riga di stato,
bottone, nota. I commenti ci sono già.

**Bitbucket / GitHub.** Webhook iscritto a Bitbucket
`pullrequest:changes_request_created` e GitHub `pull_request_review` con
`review.state = changes_requested` (il testo della review e i suoi commenti
sulle righe arrivano insieme). Alla richiesta: filtro degli account propri
(§5), lettura via API dei commenti scritti dopo l'ultimo push di Stubwise,
fotografia, accodamento. **I commenti da soli non fanno partire niente**: il
segnale è "Request changes". Autenticazione invariata (HMAC col
`webhook_secret` della repository).

## 10. Notifiche: nessun kind nuovo

Un valore nuovo in `notification_kind` è la trappola del 500 su `/api/inbox`
al rollback (fasi 2/5/6). Quindi:

- "approvata" e "fermo al tetto" riusano `review.completed`, con un campo
  additivo nell'evento (`cycle: { round, max, stopped }`) — un fatto vero al
  momento della publish, quindi è giusto scriverlo nell'evento;
- una correzione fallita riusa `job.failed`.

## 11. Errori

- **Push rifiutato** (qualcuno ha pushato durante la correzione): la
  correzione fallisce con un messaggio chiaro, mai `--force`. La prossima
  richiesta riparte dal branch aggiornato.
- **Nessuna modifica prodotta:** conta come giro, notifica con la risposta
  dell'AI (spesso la review chiedeva una cosa sbagliata).
- **PR chiusa o mergiata durante la correzione:** niente push; le `pending` e
  `queued` della PR vanno `cancelled` alla chiusura (webhook di chiusura, che
  già cancella `pr_review_jobs`).
- **Limite del provider / budget mensile:** stesso percorso `held` dei fix.
- **Riavvio del worker:** stesso recupero dei fix (`requeueStale`).
- **Webhook senza `provider_user_id` risolvibile:** fail-closed (§5).

## 12. Test

- **Contatore:** derivazione su sequenze miste (auto, auto, umana, auto →
  giro 1); tetto a 3 ferma e notifica; tetto 0 spegne il ciclo.
- **Auto-innesco (negativo):** un evento "Request changes" dall'account
  revisore e uno dall'account principale non creano righe; lo stesso evento
  da un terzo sì. Asserire sulle righe in DB, non solo sulla risposta.
- **Webhook:** parsing dei due eventi nuovi su entrambi i provider; firma
  HMAC invariata.
- **Fotografia:** solo commenti dopo l'ultimo push, account propri esclusi,
  commenti inline con `file:riga`.
- **Worktree/push:** il worktree parte dalla head del branch della PR, non dal
  default; un push non fast-forward fallisce senza forzare; PR chiusa → niente
  push.
- **Dispatch:** `ai_jobs.correction_id` salta il triage; `resolveFixMode` non
  viene toccato.
- **Concorrenza:** bottone durante una correzione → 409; "Request changes"
  durante una correzione → `pending`, che parte al posto della review.
- **Pubblicazione:** con e senza account revisore; errore dello status non
  ferma il ciclo.
- **Integrazione (testcontainers, provider finto):** il ciclo intero —
  request_changes ×3 → stop; richiesta umana → contatore azzerato → approve.
- **Web:** fixture **senza** i campi nuovi (la SPA fa un cast, non un parse:
  difesa `?? …` nel punto di lettura).
- **App:** fixture complete in ogni test toccato, un caso con **solo** i campi
  nuovi popolati, metodi nuovi aggiunti al doppio del client prima di
  scrivere il test che li usa.
- **Golden (manuali):** cambia un prompt, quindi vanno rilanciati gli scenari
  golden dei plugin.

## 13. Deploy e rollback

Rebuild **server + worker + caddy insieme**; l'app si aggiorna dagli store.

- Migrazione additiva, nessun enum, un batch.
- **Passo manuale:** script una tantum (compilato, `node dist/scripts/...`,
  prima `--dry-run`) che rilancia `ensureWebhook` su ogni repository, perché i
  webhook esistenti non conoscono i due eventi nuovi. Idempotente.
- **Account revisore:** facoltativo. Chi lo vuole crea l'account sulla
  piattaforma (es. `pr-review@thecove.it`), gli dà accesso in scrittura alle
  repository, lo registra fra gli account git e lo sceglie nel form della
  repository.
- **Rollback:** nessun kind di notifica nuovo e nessun valore aggiunto a un
  enum, quindi niente 500 su `/api/inbox`. Server vecchio: le rotte nuove
  spariscono (404), l'app legge i campi nuovi dai `.default`, il web dai `??`;
  va sceso col caddy. Worker vecchio: le `pr_corrections` restano senza
  consumatore e i job con `correction_id` verrebbero presi come fix normali —
  cioè ripartirebbero dal default e fallirebbero al push. Quindi **non
  scendere di immagine sul solo worker** con correzioni in coda: prima
  `update pr_corrections set status='cancelled' where status in
  ('pending','queued')` e fallire i relativi job.

## 14. Fuori da questo lavoro

- Correzioni su PR non aperte da Stubwise.
- Un commento sulla PR che fa partire la correzione senza "Request changes".
- Tetto di spesa per PR (resta il budget mensile d'istanza).
- Accensione della review per progetto invece che d'istanza.
