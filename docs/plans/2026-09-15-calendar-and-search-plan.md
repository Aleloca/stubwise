# Piano — Il calendario che dice la verità, e una ricerca che trova la posta

Design: `docs/plans/2026-09-15-calendar-and-search-design.md` (approvato a
sezioni dal maintainer il 15 set 2026).

**Tre parti indipendenti**, in quest'ordine di valore. Ognuna è deployabile da
sola: fermati alla fine di ognuna e fai verificare.

---

## Parte A — Il rifiuto conta (design §1)

### Task 1 — Chi sei tu fra i partecipanti

Una funzione PURA in `packages/google` o `@stubwise/shared`: dati gli
`attendees` e l'indirizzo della casella, qual è la TUA risposta. Confronto
case-insensitive (gli indirizzi sono già normalizzati in minuscolo
nell'ingestione, ma non fidarsi è gratis). **Nessuna colonna nuova**: si
ricava in lettura — una colonna derivata sarebbe un secondo posto da tenere
allineato quando cambia l'indirizzo di una casella.

**Test**: rifiutato, accettato, forse, senza risposta, e il caso in cui la tua
casella non è fra i partecipanti (l'evento è tuo e basta) — che NON è un
rifiuto.

### Task 2 — Un appuntamento rifiutato non propone mai

`isReadyForProposal` (`apps/worker/src/google/calendar.ts`): falso se il
proprietario della casella ha **rifiutato**. **Solo `declined`** — `tentative`
e `needsAction` non bloccano, vedi il design §1 per il perché.

⚠️ **Tre punti devono dire la stessa cosa**, ed è già scritto in CLAUDE.md per
la regola dell'appuntamento passato: `isReadyForProposal`, la query del
propose phase che la replica in SQL (`apps/worker/src/google/poller.ts`) e il
conteggio `stats.ready` poco sotto. Cambiarne uno solo riapre il difetto
dall'altra porta.

**Test**: una serie accesa con un'occorrenza rifiutata → zero proposte; la
stessa senza rifiuto → una; e il conteggio `stats.ready` che concorda con
quello che viene davvero pubblicato.

### Task 3 — Dirlo dove si guarda

Web (`calendar-detail-panel.tsx`) e app (`EventSheet.tsx`): la TUA risposta
detta **separata** dall'elenco dei partecipanti, non una riga fra le altre. E
nella **griglia** (web e app) un appuntamento rifiutato si distingue a colpo
d'occhio — Google lo barra, qualunque segno equivalente va bene purché non
richieda di aprire il dettaglio.

**Test**: griglia con un rifiutato e uno no, i due si distinguono senza aprire
nulla.

---

## Parte B — Tutto quello che Google mostra (design §2)

### Task 4 — I campi nuovi, dal client alla tabella

`packages/google/src/calendar.ts` normalizza già `description` e il poller la
BUTTA (la colonna non esiste): aggiungerla è metà lavoro già fatto. Da
aggiungere alla normalizzazione: **luogo**, **link per partecipare** (Meet +
numeri di telefono, da `conferenceData`/`hangoutLink`) e **promemoria**.
Migrazione additiva su `calendar_events`, un solo batch, nessun `ALTER TYPE`.

La richiesta a Google non limita i campi: nessuna chiamata in più.

**Test**: un evento con tutti i campi e uno spoglio; il secondo non deve
produrre stringhe vuote dove il senso è «non c'era» (vedi la convenzione
`null` vs `""` già usata in `extractRawBody`).

### Task 5 — La descrizione è HTML NON FIDATO

Si conserva **grezza**, si sanifica **alla lettura** con `sanitizeEmailHtml`,
esattamente come il corpo di un'email (invariante in CLAUDE.md, «Il corpo HTML
di un'email: dove si conserva, e dove no»). Sul **web** si rende
nell'`<iframe sandbox>` che già esiste — senza `allow-scripts` né
`allow-same-origin`, immagini remote neutralizzate; sull'**app** resta
**testo**, coi link toccabili (`LinkedText`/`linkify`, solo `http`/`https`).
**Non si scrive un secondo percorso di rendering**: si riusano i due esistenti.

**Test**: una descrizione con `<script>` e con un'immagine remota esce
sanificata dalla rotta e la colonna la contiene ancora grezza.

### Task 6 — I promemoria, attribuiti a Google

Si mostrano dicendo che sono impostati **su Google**. Stubwise non li fa
scattare e la copy non deve lasciar credere il contrario.

**Test**: il testo mostrato nomina Google.

### Task 7 — La ricorrenza a parole

Le occorrenze non portano l'RRULE (`singleEvents=true` la lascia sul PADRE):
serve una lettura dell'evento padre. ⚠️ **Una per SERIE, mai una per
occorrenza** — il risultato si conserva accanto alla serie, non ripetuto su
ogni riga. Una chiamata per occorrenza su un calendario ricorrente è lo stesso
moltiplicatore dell'incidente del 9 settembre 2026.

**Test**: venti occorrenze della stessa serie → UNA lettura del padre (conta
le chiamate del client finto, non fidarti del codice).

---

## Parte C — La ricerca (design §3)

### Task 8 — La posta dentro `/api/search`

Un gruppo nuovo in `searchResultsSchema` (`packages/shared`) e in
`apps/server/src/routes/search.ts`, accanto a ticket/progetti/repository/docs.

⚠️ **ACL, ed è la parte che non può sbagliare**: filtro su
`google_accounts.user_id = utente corrente`, come ogni rotta di
`/api/me/mail`. **Nessun ruolo scavalca**: un admin non vede la posta altrui.
È l'invariante `mailbox_owner` della fase 6, non un requisito nuovo.

**Si cercano CONVERSAZIONI, non messaggi**: un risultato porta alla
conversazione e dice quale messaggio ha combaciato. Restituire messaggi
sciolti riporterebbe indietro il modello appena tolto.

**Test NEGATIVO obbligatorio**: la posta di un altro utente non compare nei
risultati, **e l'asserzione non è solo sul conteggio** — si cerca una parola
che esiste SOLO nel messaggio dell'altro e non deve tornare niente. Stessa
forma dei test `member → forbidden` già in `jobs.test.ts`.

### Task 9 — Il campo nuovo va difeso in LETTURA sul web

`apps/web/src/lib/api.ts` non valida con Zod, fa un cast: il `.default([])`
dello schema **non gira mai** sul web. Il gruppo nuovo va difeso nel punto di
lettura (`?? []`), e la fixture del test che lo copre va lasciata **senza** il
campo — è la prova, non una svista. Vedi l'invariante in CLAUDE.md (15 set
2026); questa è la prima fase che la incontra.

### Task 10 — La ricerca globale nell'app

Raggiungibile da **ogni schermata**, sugli stessi gruppi del web più la posta.

⚠️ **Non aggiunge una sesta destinazione**: le cinque (INB/PRJ/BLG/DOC/MBX)
sono decise per tutte le fasi (`docs/plans/2026-09-11-app-navigation-
architecture-design.md`). La ricerca è un'AZIONE, non un posto: vive
nell'intestazione di schermata, quella che già porta titolo e avatar.

La ricerca dentro DOC, che oggi è l'unica, va riconciliata: o diventa questa,
o resta come filtro locale — purché non restino due ricerche che sembrano la
stessa e non lo sono.

**Test**: raggiungibile da tutte e cinque le schede; un risultato di posta
apre la conversazione giusta.

### Task 11 — CLAUDE.md e guida utente

- Il rifiuto come cancello (e i tre punti che devono restare d'accordo).
- La descrizione dell'evento trattata come il corpo di un'email.
- La ricerca che include la posta **senza** incrinare `mailbox_owner`.

---

## Deploy

Rebuild **server + worker + caddy insieme** (migrazione della parte B
all'avvio del server; il worker nuovo è l'unico che legge i campi nuovi e che
applica il cancello del rifiuto, il server nuovo l'unico che espone la posta
nella ricerca, il bundle nuovo l'unico che disegna tutto). L'app si
distribuisce a parte — e **si ribuilda `@stubwise/shared` e
`@stubwise/api-client` PRIMA di compilarla**: Metro risolve verso `dist/`, non
verso i sorgenti.
