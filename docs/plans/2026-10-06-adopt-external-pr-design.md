# Far correggere a Stubwise una PR aperta da altri («adozione»)

Data: 6 ott 2026. Stato: design approvato dal maintainer, una decisione alla
volta. Premesse del §1 DA VERIFICARE nel piano.

## 1. Il problema

Quando la review automatica guarda una PR che non nasce da un ticket di
Stubwise (aperta da un collega o da un bot), nasce un ticket di tipo `review`
con il testo della review (`apps/worker/src/review/run-review.ts`). Se la
review chiede modifiche, oggi Stubwise non può farle: il ciclo di correzione
(PR #68 e seguenti, `pr_corrections`, `runCorrection`) vale solo per le PR che
Stubwise ha aperto per un suo ticket — branch `stubwise/ticket-<N>`
(`STUBWISE_BRANCH_RE`, `packages/shared/src/stubwise-branch.ts`). È una regola
voluta: «una correzione non tocca MAI il branch di una PR scritta da una
persona» (CLAUDE.md, invariante «Una correzione non forza MAI il push»).

Il maintainer vuole poter decidere, PR per PR, di far applicare le correzioni
a Stubwise anche su quelle, col ciclo solito.

## 2. Decisioni del maintainer

1. **Adozione esplicita (A)**: le correzioni finiscono sul branch della PR
   del collega, ma solo dopo che un maintainer ha premuto «Fai correggere a
   Stubwise» su QUELLA PR. Nessuna PR esterna entra nel ciclo da sola.
2. **All'adozione parte subito la prima correzione (A)**, con i punti della
   review come indicazioni, più una nota facoltativa scritta da chi adotta.
   Da lì è il ciclo solito: review dopo ogni correzione, giro automatico fino
   al tetto del progetto, «Chiedi modifiche» e «Request changes» della
   piattaforma.
3. **Push concorrente (A)**: come oggi. Se il collega ha pushato nel
   frattempo, il push è rifiutato, la correzione fallisce dicendolo
   chiaramente sul ticket, e la successiva riparte dal branch aggiornato. Mai
   force, mai rebase, nessun ritentativo automatico.
4. **Avviso sulla PR (A)**: all'adozione Stubwise lascia un commento sulla PR
   con un testo fisso (template i18n, mai AI): chi ha adottato, che i commit
   arriveranno su quel branch, di scaricarli prima di pushare. Il commento è
   di un account proprio di Stubwise, quindi non fa partire correzioni (la
   difesa fail-closed degli account propri, già esistente).
5. **Il resto** (confermato):
   - adotta solo un **maintainer** (`admin`); il server lo decide e lo espone
     come permesso calcolato (stesso criterio di `canMerge`), il client non
     lo deduce;
   - **web e app**, con parità;
   - **«Smetti di correggere»**: rilascia la PR, annulla le correzioni in
     coda, ferma i giri automatici, lascia un commento sulla PR; i commit già
     pushati restano;
   - regole del ciclo **invariate**: tetto dei giri, budget (lo scavalca solo
     un admin), push mai forzati, PR chiusa/mergiata ferma tutto;
   - **esclusi**: PR da un **fork** (Stubwise non può scrivere sul branch: il
     bottone c'è ma spento, col motivo) e le PR già di Stubwise
     (`stubwise/ticket-<N>`, sono già nel ciclo);
   - le correzioni vivono **sul ticket review**, che diventa la «casa» della
     PR adottata: card della PR col ciclo e storia, come i ticket normali.

## 3. Cosa cambia (da precisare nel piano)

- **Stato dell'adozione** persistito (chi, quando, rilasciata), legato al
  ticket review e alla PR (repository + numero + branch). Probabilmente una
  riga `ticket_repositories` per il ticket review col branch della PR più un
  marcatore di adozione: il piano verifica cosa già esiste (es. se
  `pr_reviews` conosce il ticket review) e sceglie la forma più piccola.
- **Il riconoscimento «è una PR che Stubwise può correggere»** oggi è
  `STUBWISE_BRANCH_RE`. Diventa: branch di Stubwise **oppure** PR adottata e
  non rilasciata. Una regola sola, usata da tutti i punti che oggi usano la
  regex per decidere (webhook, `derivePrCycle`, rotta delle correzioni,
  review, `runCorrection`). Chi decide «chi può correggere cosa» non deve
  esistere in due copie.
- **`runCorrection`** su un branch adottato: stesso percorso (worktree sul
  branch della PR, push in avanti, ricontrollo dello stato della PR prima del
  push), con la differenza che il branch non segue `stubwise/ticket-<N>`.
  Verificare ogni punto del worker che deduce il branch dal numero del
  ticket.
- **Fork**: il provider deve dire se la PR viene da un fork (GitHub:
  `head.repo` diverso da `base.repo`; Bitbucket: `source.repository` diverso
  da `destination.repository`). Fork → non adottabile, motivo esplicito.
- **Rotte nuove** (solo admin, `requireAdmin` + controllo ridondante nel
  servizio): adotta (con nota facoltativa) e rilascia. Campi additivi per i
  client (`.default`), letti con `??` sul web e nell'app (cache persistita).
- **Commenti sulla PR**: due template i18n (adozione, rilascio), pubblicati
  con l'account principale.
- **Notifiche**: nessun kind nuovo; le esistenti del ciclo (`review.completed`
  col `cycle`, `job.failed`) valgono anche qui.

## 4. Invarianti da aggiornare (CLAUDE.md, a fine lavoro)

- «Una correzione non forza MAI il push … mai il branch di una PR scritta da
  una persona» → diventa «… se non dopo un'adozione esplicita di un
  maintainer». Il push resta sempre in avanti.
- «Una sola regex dei branch dei fix» → la regola di correggibilità passa da
  UN posto che include l'adozione.

## 5. Test

Negativi a più ruoli (member non adotta né rilascia; il bottone non gli è
mostrato); fork non adottabile; PR di Stubwise non adottabile; adozione →
prima correzione in coda con la review come indicazione; push concorrente →
correzione fallita col messaggio, nessun force; rilascio → coda annullata e
nessun giro automatico dopo; PR chiusa → stop; commento sulla PR all'adozione
e al rilascio, che non innesca correzioni (account proprio). Scenario golden
`correction` su un branch adottato, se il prompt cambia.

## 6. Deploy

Server + worker + caddy; l'app dagli store. Se c'è una migrazione: server
PRIMA del worker (come 0082/0083/0084). Il piano dichiara il rollback.
