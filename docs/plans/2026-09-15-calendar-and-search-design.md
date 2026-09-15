# Il calendario che dice la verità, e una ricerca che trova la posta

**Data**: 15 settembre 2026
**Origine**: test manuali dell'App M3 sul telefono del maintainer, 15 set 2026
**Stato**: design approvato a sezioni dal maintainer

## Perché

Tre cose emerse usando il prodotto, non leggendo il codice.

1. Un appuntamento **rifiutato** è indistinguibile da uno a cui si va. Il dato
   c'è (`attendees[].responseStatus` dalla fase 9, e sui dati veri
   `a.locatelli@thecove.it → declined`), ed è pure mostrato accanto a ogni
   partecipante — ma niente dice «questa è la TUA risposta», e **nessuna
   condizione nel codice lo consulta**: cercato in tutto `apps/worker`,
   `responseStatus` non entra in nessuna decisione.
2. Di un appuntamento Stubwise mostra molto meno di Google: manca la
   descrizione (che il client **già normalizza** e il poller butta, perché la
   colonna non esiste), il luogo, il link per partecipare, i promemoria, la
   ricorrenza a parole.
3. **Non c'è modo di cercare fra le email.** `GET /api/search` copre ticket,
   progetti, repository e pagine Docs; la posta non c'è, su nessuna
   superficie. E nell'app la ricerca è raggiungibile **solo da dentro DOC**:
   le altre quattro schede non hanno nessun campo.

## §1 — Il rifiuto conta

**Riconoscere «te».** Il partecipante che è il proprietario della casella si
trova per confronto con `google_accounts.email` — quattro caselle collegate,
nessuna ambiguità. **Non serve una colonna nuova**: si ricava in lettura da
`attendees` e dalla casella, e il worker la casella ce l'ha già in mano. Una
colonna derivata sarebbe un secondo posto da tenere allineato quando cambia
l'indirizzo di una casella.

**Dirlo dove si guarda.** La tua risposta va detta separata dall'elenco dei
partecipanti, e l'appuntamento rifiutato va segnato **anche nella griglia** —
come Google, che lo barra. Se per sapere che non ci vai devi aprire il
dettaglio, la griglia sta mentendo.

**Farlo contare.** Un appuntamento che hai rifiutato **non genera mai una
proposta**. È la stessa famiglia dell'incidente del 9 settembre 2026: lavoro
creato da qualcosa che non ti riguarda.

**Solo `declined` blocca** (decisione del maintainer). `tentative` e
`needsAction` no: alle riunioni di lavoro ricorrenti quasi nessuno risponde
formalmente, e bloccarle toglierebbe di mezzo la maggior parte degli
appuntamenti veri — un falso negativo che nessuno noterebbe, perché una
proposta che non nasce non lascia traccia.

⚠️ **Tre punti devono restare d'accordo**, come già scritto in CLAUDE.md per
la regola «un appuntamento passato non diventa mai una proposta»:
`isReadyForProposal` (`apps/worker/src/google/calendar.ts`), la query del
propose phase che la replica in SQL (`apps/worker/src/google/poller.ts`) e il
conteggio `stats.ready` nello stesso file. Se dicono cose diverse, il difetto
torna dalla porta che non è stata chiusa.

## §2 — Quanto calendario vogliamo essere

Decisione del maintainer: **tutto quello che Google mostra**. La richiesta a
Google non limita i campi (`events.list` senza `fields`), quindi ce li manda
già tutti: aggiungerli non costa una chiamata in più — solo codice e spazio.

Entrano: **descrizione**, **luogo**, **link per partecipare** (Meet più i
numeri di telefono), **promemoria**, **ricorrenza a parole**.

### La descrizione è HTML non fidato, e va trattata come tale

La descrizione di un evento Google è HTML scritto da chi ha creato l'invito,
che può essere chiunque. Segue **le stesse regole del corpo di un'email**, già
scritte e già implementate: si conserva **grezza**, si sanifica **alla
lettura** con `sanitizeEmailHtml`, sul web si rende nell'`<iframe sandbox>`
esistente (senza `allow-scripts` né `allow-same-origin`, immagini remote
neutralizzate), sull'app resta **testo** con i link toccabili
(`LinkedText`/`linkify`). Non si inventa un secondo percorso di rendering: si
riusano i due che ci sono.

### I promemoria si mostrano ATTRIBUITI a Google

Stubwise non li fa scattare, e non deve sembrare che lo faccia. Si mostrano
dicendo che sono i promemoria impostati **su Google** — un'informazione vera
su cosa farà Google, non una promessa di Stubwise. Chi un domani volesse
farli scattare stia aggiungendo una funzione, non riempiendo un campo.

### La ricorrenza a parole costa una chiamata PER SERIE

Il poller chiede gli eventi con `singleEvents=true`, che espande le ricorrenze
in occorrenze: le singole istanze **non portano la regola** (`recurrence`,
l'RRULE), che vive sull'evento PADRE. Serve quindi una lettura in più del
padre — **una per serie, mai una per occorrenza**, e il risultato si conserva
accanto alla serie, non ripetuto su ogni riga. Chi implementa tenga questo
confine: una chiamata per occorrenza su un calendario ricorrente è esattamente
il moltiplicatore che ha prodotto l'incidente del 9 settembre.

## §3 — Una ricerca sola, che trova anche la posta

Decisione del maintainer: **una ricerca globale nell'app, raggiungibile da
ogni schermata**, sugli stessi gruppi del web più la posta.

**Il vincolo non negoziabile**: la posta è **privata del proprietario della
casella** (audience `mailbox_owner`, fase 6 — «una proposta nata dalla casella
di qualcuno la vede SOLO quel qualcuno», e nemmeno un admin). La ricerca
filtra su `google_accounts.user_id`, come già fa ogni rotta di `/api/me/mail`.
Nessun ruolo scavalca. Questo non è un requisito di questa fase: è
un'invariante esistente che questa fase non deve poter incrinare.

**Si cercano CONVERSAZIONI, non messaggi.** La posta in Stubwise si legge per
conversazione dal 15 settembre: una ricerca che restituisse messaggi sciolti
riporterebbe indietro il modello che abbiamo appena tolto. Un risultato porta
alla conversazione, evidenziando quale messaggio ha combaciato.

**L'ingresso nell'app non aggiunge una sesta destinazione.** Le cinque
(INB/PRJ/BLG/DOC/MBX) sono decise per tutte le fasi: la ricerca è un'azione,
non un posto. Vive nell'intestazione di schermata — quella che dalla App M3
porta già titolo e avatar — e da lì è raggiungibile ovunque.

⚠️ **Il gruppo nuovo nella risposta va difeso nel punto di LETTURA sul web.**
`apps/web/src/lib/api.ts` non valida con Zod, fa un cast (scelta dichiarata
nel docblock): il `.default([])` dello schema **non gira mai** sul web, e un
campo assente resta `undefined`. Un `undefined` dove il codice chiama `.map()`
fa smontare a React l'intero sottoalbero — è l'invariante scritta in
CLAUDE.md il 15 set 2026, e questa è la prima fase che la incontra dopo che è
stata scritta.

## Cosa NON si fa

- **Non si fanno scattare i promemoria.** Si mostrano come proprietà
  dell'evento su Google (vedi §2).
- **Non si cambia l'ammissione della posta per la ricerca.** Si cerca fra ciò
  che è già dentro; la ricerca non è una porta d'ingresso nuova.
- **Non si tocca la regola «solo `declined` blocca»** allargandola a
  `tentative` «per prudenza»: è stata decisa guardando i dati veri.
