# Integrazione area 8 — «L'API per i siti»: il cliente segue le sue richieste sul sito

*15 nov 2026, 72. Ultima fetta dell'area 8, da `feat/area8-waiting`. Fonti:
la voce «L'API per i siti» del registro
(`docs/plans/integrazione-registro-rimandi.md`, area 8) e la premessa corretta
della F3 (`docs/plans/2026-11-14-integrazione-area8-fetta3-plan.md`): **il team
non scrive MAI al cliente nel widget**; una conversazione con un esito è
chiusa; il cliente segue richieste e ticket **sul sito che ospita il widget**,
che li legge da Stubwise via API.*

## Cosa risolve, in una frase

Il sito che ospita il widget mostra al SUO cliente, autenticato DAL SITO, le
richieste e i ticket che quel cliente ha aperto dal widget, con lo stato in
parole del cliente (`customerStatus`), e niente altro.

## Il punto di partenza (il codice di oggi)

- Le rotte pubbliche `/widget/:slug/*` (`apps/server/src/routes/widget.ts`)
  autenticano il **widget**, non la persona: `X-Stubwise-Key` è la `key` del
  widget, **pubblica per design** (sta nel sorgente della pagina). Lo slug
  sconosciuto, la chiave assente e quella sbagliata danno la stessa 401. CORS
  aperto (`*`), i siti ammessi (`widgets.allowed_origins`, F3 S16) rifiutano
  un'`Origin` fuori elenco, e il rate limit è per chiave (300/min).
- Il cliente lo **dichiara** il sito: `user.id` (`external_user_id`) in chiaro.
  Va bene per la chat (il peggio che si ottiene è parlare con l'AI a nome di
  un altro), ma **non** per leggere lo stato delle richieste: chiunque abbia la
  chiave potrebbe dichiararsi un altro cliente.
- Il legame cliente → esito: `widget_conversations.external_user_id` → la
  conversazione (canale `widget`) → la richiesta
  (`backlog_items.support_conversation_id`) o il ticket
  (`widget_messages.ticket_id`). Le conversazioni successive
  (`continued_in_id`) sono dello stesso cliente. Lo stato per il cliente lo
  calcola già `outcomeOf` (`apps/server/src/services/support.ts`) con
  `customerStatus` di `@stubwise/shared`, quella che usa l'«anteprima del
  cliente» della F3.
- Una richiesta FUSA in un'altra (`backlog_items.merged_into_id`) non segue
  la fusione: `customerStatus` la dà «in valutazione» per sempre (limite della
  F3).
- Non esiste un segreto di widget lato server, né la rotazione della chiave
  (la `key` nasce alla creazione e non cambia più).

## La forma

### S1. Il segreto d'identità del widget

- Migrazione (primo numero libero):
  - `widgets.identity_secret_encrypted text` (null = nessun segreto),
    cifrato con la chiave d'istanza come i file `.env` di progetto
    (`encrypt`/`decrypt` di `@stubwise/db`);
  - `widgets.identity_secret_rotated_at timestamptz`;
  - `widgets.identity_required boolean not null default false`;
  - `widget_conversations.identity_verified boolean not null default false`.
- Il segreto si **genera** (e si rigenera) da Amministrazione del widget,
  stesso `MANAGE_ACCESS` delle rotte admin
  (`apps/server/src/routes/widget-admin.ts`), con la riconferma recente
  (`config.reauth`, è una credenziale). Si mostra **una volta sola**, alla
  generazione. Nessuna lettura lo restituisce: la vista del widget dice solo
  `identitySecretSet` e `identitySecretRotatedAt`. 32 byte casuali, base64url.
- Rigenerare spegne il vecchio **subito** (D-5). La traccia è
  `identity_secret_rotated_at` (quando), mai il segreto. Se serve anche il
  «chi», è una colonna in più, non un registro nuovo.

### S2. Il token d'identità del cliente

- Lo emette il **backend del sito** (mai il browser), col segreto del widget:
  un **JWT compatto HS256** (si firma con qualunque libreria JWT, o con 10
  righe di `crypto`). Claim:
  - `sub`: l'id del cliente nel sito (= `external_user_id`, 1–200 caratteri);
  - `email`, `name`: facoltativi, come oggi nel body;
  - `aud`: l'id del widget (un token di un widget non vale su un altro, anche
    se un sito ne usa due col segreto copiato);
  - `iat`, `exp`: obbligatori. Durata massima accettata: D-6.
- Verifica lato server, **scritta a mano con `node:crypto`** (nessuna
  dipendenza nuova; il server non ne ha una JWT). Il perimetro è stretto:
  - header esattamente `{"alg":"HS256","typ":"JWT"}`, nient'altro: niente
    `none`, niente confusione di algoritmo, niente `kid`;
  - firma confrontata a tempo costante;
  - `exp` nel futuro, `iat` non più di 60 secondi nel futuro, e `exp − iat`
    entro la durata massima;
  - `aud` uguale all'id del widget autenticato dalla chiave;
  - payload ≤ 2 KB, `sub` nei limiti di `external_user_id`.
  - Un errore qualunque dà la stessa 401 `invalid_identity`: nessun oracolo
    su quale controllo è caduto.
- Il token viaggia **solo nell'header** `Authorization: Bearer …`, mai nella
  query: l'URL finisce nei log, gli header no (il serializzatore del logger
  registra metodo e URL, `apps/server/src/app.ts`). CORS del plugin del
  widget aggiunge `authorization` agli header ammessi.

### S3. La chat con l'identità verificata

- Il widget accetta `identityToken` (stringa, o una funzione che lo
  restituisce, per rinnovarlo alla scadenza) in `Stubwise.init`, e lo manda in
  `Authorization` su creazione della conversazione e messaggi. Additivo: un
  sito che non lo passa funziona come oggi.
- Con un token valido la conversazione nasce `identity_verified = true` e il
  suo `external_user_id` è il `sub` del token: **il token vince** sul `user.id`
  del body, e un body diverso dal `sub` è un 401 `identity_mismatch`.
- `identity_required = true` (toggle per widget, spento di default): una
  conversazione o un messaggio senza un token valido sono rifiutati (401
  `identity_required`). Così sul sito che lo accende nessuno parla più
  dichiarandosi un altro.
- Una conversazione successiva (`continued_in_id`) eredita `identity_verified`
  solo se è creata con un token valido dello stesso `sub`: la catena non
  promuove a verificato ciò che non lo era.

### S4. La lettura: `GET /widget/:slug/me/requests`

- Nel plugin del widget (stessi CORS, chiave, siti ammessi, rate limit), più
  il token. `config.access`: la stessa dichiarazione pubblica delle altre
  rotte del widget (il test del registro delle rotte).
- **Cosa elenca**: le conversazioni del progetto del widget, canale `widget`
  (MAI `mcp`: sono i collaboratori interni), con `external_user_id = sub` e
  `identity_verified` (D-1), che hanno un ESITO (una richiesta legata o un
  ticket aperto dal widget; D-7). La WHERE porta il progetto e il `sub`: un
  cliente non vede MAI altro che le sue righe.
- **Una riga** (`siteRequestSchema` in `@stubwise/shared`, campi additivi con
  default, `readerSchema` per gli enum):
  - `code`: il codice della conversazione, `<PRJ>-S<n>` (D-3);
  - `kind`: `request` | `ticket`;
  - `label`: il primo messaggio del cliente, al più 140 caratteri (D-2),
    testo NON FIDATO per il sito;
  - `status`: `customerStatus` (l'enum) e `statusLabel` (la frase nella lingua
    del widget, da un **template i18n**, mai un testo del team);
  - `openedAt`: l'inizio della conversazione.
  - MAI nomi del team, stime, commenti, testo interno, il codice `R`/task.
- **Le fusioni**: una richiesta fusa segue `merged_into_id` fino alla
  destinazione (con un tetto di passi contro i cicli). La riga prende lo
  **stato** della destinazione, ma **non** il suo titolo né il suo codice: la
  destinazione può essere la richiesta di un ALTRO cliente.
- Ordine: dall'apertura più recente, al più 50, `total`. Niente paginazione
  nella v1 (un cliente con più di 50 esiti è un caso da vedere quando c'è).
- **La forma dei dati è chiusa**: un test fissa l'insieme delle chiavi della
  risposta. Così un campo aggiunto «per comodità» (un assegnatario, una stima)
  fa fallire il test invece di arrivare al cliente.

### S5. La guida per chi integra

- Una pagina della guida (`apps/docs`, Starlight): come generare il segreto,
  come firmare il token nel backend (Node, PHP, Python: snippet con le
  librerie standard), come passarlo al widget e come chiamare l'API.
- Gli avvisi da dare, in chiaro:
  - il segreto mai nel browser;
  - `exp` corto;
  - `label` è testo dell'utente: si rende come TESTO (XSS sul sito).
- Nessun pacchetto nuovo da pubblicare.

### S6. Il renderer (94)

- In Amministrazione del widget:
  - «Identità dei clienti»: genera o rigenera il segreto, mostrato una volta,
    con la riconferma; la data dell'ultima rotazione;
  - il toggle «Solo clienti verificati».
- Nel dettaglio di una conversazione: «cliente verificato» / «dichiarato dal
  sito».

## Il modello delle minacce

| Minaccia | Cosa la ferma | Cosa resta (accettato) |
|---|---|---|
| **Identità falsificata**: chi ha la chiave pubblica del widget si dichiara un altro cliente | La lettura vuole un token HS256 firmato col segreto, che sta solo nel backend del sito. La chiave pubblica non basta, e il `user.id` del body non dà mai lettura. `alg` fisso, `aud` = widget, `exp` obbligatorio. Le conversazioni dichiarate non entrano nell'elenco (D-1). Con `identity_required` nemmeno la chat accetta un cliente dichiarato. | Un token rubato vale fino alla sua `exp` (D-6). Senza `identity_required`, chiunque può ancora CHATTARE a nome di un altro (com'è oggi), ma non leggere. |
| **Enumerazione dei codici**: i codici `S<n>`, `R<n>` e dei ticket sono sequenziali | Nessuna rotta accetta un codice come chiave di lettura: l'elenco è per identità, e il dettaglio cerca il codice DENTRO le righe di quel `sub` e dà lo stesso 404 per «non esiste» e «non è tuo». La stessa 401 per slug, chiave e token sbagliati. Rate limit per chiave e per `sub`. | Un `S<n>` mostrato al cliente rivela l'ordine di grandezza delle conversazioni del progetto (D-3). |
| **I dati di un altro cliente** | La WHERE su progetto del widget + `sub` + verificata + canale `widget`. Una fusione dà lo stato della destinazione, mai titolo o codice. Lo schema della risposta è chiuso (test sulle chiavi), e un test negativo semina un commento, una stima e un assegnatario e verifica che non escano. | — |
| **Chiave del widget rubata** | È pubblica per design: da sola non legge niente. Con `allowed_origins`, un browser su un altro sito è rifiutato. | Fuori dal browser l'`Origin` si falsifica: la chiave resta un'autenticazione del widget, non della persona. |
| **Segreto d'identità rubato** | Rigenerarlo spegne il vecchio subito (D-5), e la data della rotazione resta. Il danno è confinato a UN widget e a UN progetto, in sola LETTURA (l'API non scrive). | Finché non si rigenera, chi lo ha può leggere gli esiti di qualunque cliente di quel widget e, con `identity_required`, chattare a suo nome (nei tetti giornalieri). |
| **Il token nei log** | Solo nell'header, mai nella query; il logger non registra gli header. | — |
| **CSRF, cookie** | L'API non usa cookie né credenziali del browser: un sito terzo non può far leggere qualcosa a nome dell'utente. | — |

## Le decisioni *(M, via 46, 16 nov 2026)*

- **D-1 = a**: nell'elenco (e nel dettaglio) solo le conversazioni VERIFICATE.
- **D-2 = a**: la `label` sono le parole del cliente, il suo primo messaggio,
  troncato a 140 caratteri.
- **D-3 = a**: il codice mostrato è quello della conversazione, `<PRJ>-S<n>`.
- **D-4 = b**: c'è anche il DETTAGLIO, con i messaggi della SUA conversazione
  col widget (cliente ↔ AI). Vedi S4b.
- **D-5 = a**: rigenerare il segreto spegne il vecchio subito.
- **D-6 = a**: `exp` obbligatorio, al più 24 ore accettate.
- **D-7 = a**: solo le conversazioni con un esito (una richiesta o un ticket).

### S4b. Il dettaglio: `GET /widget/:slug/me/requests/:code`

- Le stesse regole dell'elenco, nella stessa WHERE:
  - progetto del widget, canale `widget`;
  - `external_user_id = sub`, `identity_verified`, con un esito.
- Il `code` (`<PRJ>-S<n>`) si cerca SOLO fra le righe di quel `sub`. Un codice
  inesistente, malformato, di un altro cliente, di un altro progetto, non
  verificato o senza esito danno lo stesso 404 `not_found`.
- **La riga dell'elenco** più `messages`: i messaggi della conversazione,
  `{ from: "customer" | "assistant", body, at }`, in ordine.
  - Si leggono SOLO i ruoli `user` e `assistant`: un messaggio con un altro
    ruolo, o con un autore del team (`author_id` non nullo), non esce, anche
    se sul canale `widget` non ce ne sono per costruzione.
  - Niente citazioni, niente id dei ticket.
- Le conversazioni successive (`continued_in_id`) sono righe A SÉ, ognuna col
  suo codice e i suoi messaggi: il dettaglio di una non include quelli
  dell'altra.
- Dopo una fusione: lo STATO della destinazione, MAI il suo titolo o il suo
  codice. Sono le stesse regole dell'elenco, con la stessa funzione.
- **Schema chiuso** (`siteRequestDetailSchema`), con un test sulle chiavi.

## Fuori dalla fetta

- Qualunque scrittura dall'API: il cliente non commenta, non chiude e non
  riapre. Scrive nel widget, e il widget apre una conversazione nuova.
- Le notifiche al cliente (email «la tua richiesta è rilasciata»): una
  decisione di prodotto a sé.
- La rotazione della chiave PUBBLICA del widget (`key`): resta com'è.
  Rubarla non dà lettura.
- Il canale `mcp`: i collaboratori interni seguono le loro richieste con
  `my_requests`.

## I test

- **Il token**, ciascuno → 401 `invalid_identity`, con la stessa risposta:
  - firma giusta → verificato;
  - firma sbagliata; `alg: none`; `alg: HS512`; header con `kid`;
  - `exp` passato; `exp − iat` oltre il tetto; `iat` nel futuro;
  - `aud` di un altro widget; payload troppo grande; base64 rotto;
  - un token valido col segreto VECCHIO dopo la rigenerazione.
- **La chat**:
  - un token valido rende la conversazione verificata, e il `sub` vince sul
    body;
  - body diverso → `identity_mismatch`;
  - `identity_required` senza token → 401 su creazione e messaggio;
  - un widget vecchio senza token funziona come prima (toggle spento);
  - la conversazione successiva è verificata solo con un token.
- **La lettura**:
  - un cliente vede le SUE richieste e i suoi ticket, con lo stato giusto
    lungo la vita (ricevuta → in valutazione → pianificata → in lavorazione →
    rilasciata, «non procediamo»);
  - NEGATIVI: un altro `sub` dello stesso widget; lo stesso `sub` su un
    widget di un ALTRO progetto; una conversazione dichiarata (D-1);
  - NEGATIVI: il canale `mcp`; una conversazione senza esito (D-7);
  - la fusione: lo stato della destinazione, il codice e la label del
    cliente, nessun testo della destinazione;
  - lo schema chiuso, e il negativo con commento, stima e assegnatario
    seminati;
  - il dettaglio (S4b):
    - i messaggi del cliente e dell'AI, in ordine;
    - NEGATIVI: un messaggio con un ruolo diverso o con un autore del team;
      il codice di un altro cliente, uno inesistente, uno non verificato o
      senza esito → lo stesso 404;
    - la conversazione successiva è una riga a sé;
    - lo schema chiuso;
  - i siti ammessi; il rate limit per `sub`;
  - nessun token nei log: un test sul serializzatore con l'header.
- **Il segreto**:
  - mai in una risposta di lettura;
  - la generazione vuole `MANAGE_ACCESS` e la riconferma (negativi:
    Developer, PAT);
  - è cifrato a riposo (la colonna non contiene il chiaro).
- **Il client**: parse di una risposta senza i campi facoltativi; uno `status`
  sconosciuto è `UNKNOWN`.
- **Il widget**: `identityToken` stringa e funzione, il rinnovo alla scadenza
  (401 → una nuova chiamata alla funzione, una volta).

## Ordine, deploy, rollback

- **ORDINE**: **server** (migrazione, rotte, verifica del token), poi
  **caddy** (il bundle del widget con `identityToken`, il renderer, la guida).
  Nessuna env nuova; nessuna modifica al worker.
- La migrazione aggiunge solo colonne con default: un server vecchio le
  ignora.
- **Rollback**: il server di prima non ha la rotta né la verifica, quindi il
  widget nuovo manda un header che il server vecchio ignora: la chat funziona,
  ma `identity_required` non vale più. Va detto nel deploy-log: un rollback
  SPEGNE la protezione di chi l'ha accesa, finché non si torna avanti. La
  pagina del sito riceve 404 sull'API e mostra il suo errore.

## Stima

S1–S4 server: 1,5 giorni con i test. S5 guida: mezza giornata. S6 renderer:
94. Nessun golden: nessun modello nel percorso.
