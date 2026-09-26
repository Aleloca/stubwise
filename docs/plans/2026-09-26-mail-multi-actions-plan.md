# Una mail, più azioni e più progetti — piano

Design: `2026-09-26-mail-multi-actions-design.md`. Branch
`feature/mail-multi-actions`, worktree `.worktrees/mail-multi`, base `main`
f1d3e7f6. Un commit per task e TDD: ogni test va visto fallire prima. Un test
che passa al primo colpo si fa fallire apposta, e al doppio del client si
aggiunge il metodo o il campo PRIMA del test.

## Task 1 — La regola in shared (design §2)
`multiSelectableIndices(actions)` in `packages/shared`, pura. `InboxGoogle`
guadagna `multiSelectIndices: number[]` `.default([])`. `answerBodySchema`
accetta `optionIndices?: number[]` con «esattamente uno fra optionIndex,
optionIndices e text». Test:
- la regola: una sola azione del modello dà `[]`; «Sposta» e «Non fare
  nulla» sono sempre esclusi; il calendario dà `[]`;
- il parse di una risposta SENZA `multiSelectIndices`;
- i corpi vecchi `{optionIndex}` restano validi.

## Task 2 — Lettura (server)
`readGoogle` calcola `multiSelectIndices` dalle `actions` dell'evento.
Test «CARD VECCHIA»: un evento pubblicato senza nessun campo nuovo esce con
gli indici giusti, sul modello di `inbox.test.ts`.

## Task 3 — Risposta multipla (server, design §3)
`answerGoogleProposal` e il body largo della rotta: `optionIndices`,
validazione PRIMA del claim, esecuzione di tutte in una transazione, outcome
`multiple` registrato in `closed-reason.ts`, nota con tutte le etichette.
Test in `google-proposal.test.ts` e `routes/inbox.test.ts`:
- tre voci di backlog → tre righe `backlog_jobs` e outcome `multiple`;
- un indice non ammesso, un doppione o una lista vuota → `invalid_answer`,
  e nessuna riga scritta né claim;
- una seconda azione che fallisce → nessuna riga scritta, card `failed`;
- `optionIndex` singolo su una card multipla funziona ancora;
- `projectId` con `optionIndices` rifiutato;
- le sorelle su altri progetti non si toccano (invariante 6b).

## Task 4 — Più progetti (worker, design §4)
`loadContext`: tutti i progetti ammessi, col perimetro prima; prompt con le
due etichette (i18n it e en); `revalidateProposal` sul solo «esiste fra gli
elencati». Riscrivi i test `classify.test.ts:364, :1598, :1979` come dice il
design, senza cancellarli. Test nuovi:
- mail sul progetto A che nomina il progetto B → due righe
  `email_proposals`, due card;
- il tetto dei 5 progetti preferisce quelli del perimetro;
- smistamento e riclassificazione dopo «Sposta» invariati.

## Task 5 — Web (design §5)
`QuestionPanel` con una modalità a caselle attivata apposta, e
`inbox-item.tsx` che la attiva quando `multiSelectIndices` non è vuoto. Le
domande dell'agente restano identiche, e i loro test esistenti passano
intatti. Test con la fixture SENZA il campo, per provare il `?? []`.

## Task 6 — App (design §5)
`GoogleProposalScreen`: caselle, «Create N», «Sposta» e «Non fare nulla» al
tap come oggi. i18n it e en.

## Task 7 — Slack (design §5)
`MAX_OPTIONS` a 6, con un test sulla card da 5 opzioni in cui «Non fare
nulla» c'è. Bottone «Crea tutte (N)» con `inbox:answer:all` e il gestore che
ricalcola gli indici sul server.

## Task 8 — CLAUDE.md
Una voce di deploy «Una mail, più azioni e più progetti (26 set 2026)»:
server + worker + caddy, nessuna migrazione, il rollback del §6 e il
controllo da fare dopo qualche giorno (design §4). Breve.

## Verifica finale
`pnpm lint`, `pnpm typecheck`, e i test di shared, notifications, server,
worker, web e app. Pusha e scrivimi: la prova la fa il maintainer sul
telefono, e sul web se serve.
