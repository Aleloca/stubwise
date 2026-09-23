# Tutto ciò che si fa su un ticket, anche dall'app (21 set 2026)

## §1 — Il censimento, letto dal codice

Richiesta del maintainer: «vedere e capire tutte le cose che si possono fare
su un ticket nella webapp, e poi vorrei che tutte quelle cose fossero presenti
anche nella app».

Le azioni della pagina web (`apps/web/src/routes/tickets/$id.tsx`, dieci
`useMutation`) contro quelle dell'app (`WorkScreen` + `PlanSection`):

| azione | web | app | ruolo |
|---|---|---|---|
| approvare il piano | ✓ | ✓ | admin |
| rifiutare il piano, con istruzioni | ✓ | ✓ | admin |
| pre-approvare il piano | ✓ | ✓ | admin |
| revocare la pre-approvazione | ✓ | ✓ | admin |
| **modificare i campi** — stato, priorità, assegnatario, milestone, **etichette** | ✓ | — | chiunque |
| **commentare** | ✓ | — | chiunque |
| **avviare il lavoro dell'agente**, con o senza istruzioni | ✓ | — | chiunque |
| **rispondere a una domanda dell'agente** | ✓ | — | chiunque |
| **cancellare il design** | ✓ | — | chiunque |
| **cancellare il piano** | ✓ | — | chiunque |

⚠️ **Le domande nell'app non si vedono affatto, ed è peggio di come lo avevo
scritto.** La prima stesura diceva «si vedono e non si possono rispondere»:
falso. `buildTimeline` (`apps/mobile/src/lib/timeline.ts`) seleziona le
domande con `answeredAt !== null` — cioè **solo quelle già risposte**, e solo
per datare il passo «Domanda risposta». Il TESTO di una domanda non compare
mai, e di una domanda APERTA non resta alcuna traccia nell'app.

Quindi il lavoro non era «aggiungere l'invio dove la domanda si vede»: era
**far vedere la domanda**. Un job fermo su una domanda resta fermo finché
qualcuno non apre il web — e dalla card in inbox si risponde, ma solo se la
notifica è ancora lì.

### §1.1 — Tre correzioni al censimento (21 set, dalla lettura del codice)

1. **`effort` non è modificabile, da nessuna superficie**:
   `updateTicketBodySchema` (`apps/server/src/routes/tickets.ts`) non lo
   contiene. Era nella mia riga per errore.
2. **Titolo e tipo**: il server li accetta, ma **nessuna UI li espone** — il
   web dalla pagina ticket non li modifica. Fuori dal perimetro della parità.
3. **Le etichette c'erano e mancavano dal censimento**: sono uno dei cinque
   `patchMutation.mutate` del web. Vedi §4.1 per dove finiscono.

## §2 — Cosa serve davvero: metà del lavoro è già fatto

Verificato in `packages/api-client/src/endpoints/tickets.ts`:

- **`runAi` e `answerQuestion` ci sono già**: mancano solo nella UI dell'app;
- **`patch`, `comment`, `deleteDesign`, `deletePlan` non esistono nel client
  condiviso** — il web le chiama da `apps/web/src/lib/api.ts`, che parla
  direttamente col server senza passare di lì.

Le **rotte server esistono tutte**: nessuna modifica al server, nessuna
migrazione. Il lavoro è aggiungere quattro metodi al client condiviso e sei
pezzi di interfaccia.

## §3 — I permessi, verificati rotta per rotta

Solo le **quattro azioni sul piano** hanno `preHandler: requireAdmin`
(`apps/server/src/routes/tickets.ts`). Le altre sei sono `requireAuth`: un
operatore può modificare i campi, commentare, avviare il lavoro, rispondere a
una domanda e cancellare design e piano.

⚠️ **Questo NON allarga i due divieti dell'operatore** (CLAUDE.md): un member
che avvia un run passa comunque dal gate di approvazione del piano — è una
riga in `jobs.ts`, non un controllo di rotta — e non può mergiare nulla. Chi
implementa non aggiunga controlli di ruolo dove il server non ne ha: sarebbero
una seconda copia della regola, e la copia sbagliata starebbe nel client.

## §4 — Le due cancellazioni: si portano, con una conferma

Decisione del maintainer, 21 settembre: **tutte e sei, senza eccezioni** —
parità piena fra le due superfici, così non c'è una regola da ricordare su
cosa sta dove.

⚠️ Ma design e piano cancellati **non si recuperano**, e su un telefono si
tocca per sbaglio più che su un computer. Quindi: conferma esplicita a due
passi, come il rilascio di una PR sul web, e **mai** in un punto dove il dito
passa scorrendo. Il resto delle azioni non chiede conferma: sono reversibili
o innocue.

### §4.1 — Le etichette: dentro la parità, ma nel batch successivo

Sono la quinta cosa che il web modifica, e con la parità piena chiesta dal
maintainer **vanno fatte**. Non stanno però in questo batch: un editor di
etichette è un componente a sé (chip, aggiunta, rimozione), e infilarlo ora
allungherebbe un lavoro che ha già i quattro campi con selettore pronti.

⚠️ **Registrato qui perché non si perda**: senza le etichette la parità non è
piena, e questo design non può dirsi chiuso finché ci sono.

✅ **Chiuso il 23 set 2026**: le etichette si modificano dall'app
(`LabelsSheet`, `apps/mobile/src/components/work/LabelsSheet.tsx`), con le
stesse regole del web più una differenza voluta — un doppione identico lo si
dice invece di scartarlo in silenzio. Con questo la parità delle azioni sul
ticket è piena.

## §5 — Cosa NON fa questo batch

- **Non tocca il server**: nessuna rotta nuova, nessuna migrazione, nessun
  permesso cambiato.
- **Non tocca il web**: la pagina ticket resta quella che è.
- **Non aggiunge azioni che il web non ha**: la parità è il perimetro, in
  entrambe le direzioni.
