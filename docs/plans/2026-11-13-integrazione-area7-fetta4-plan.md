# Area 7, fetta 4 — le automazioni generali e il webhook in arrivo

> Piano di stubwise-94 (13 nov 2026), su richiesta di stubwise-46, con le
> risposte F4-1…F4-6 (vedi «Le risposte alle domande»), nella
> forma dei piani della F1, della F2 e della F3. I task del SERVER sono
> scritti come interfacce e test: l'implementazione e le scelte interne
> restano a 72, che le corregge prima di cominciare («Correzioni di 72»). I
> task del RENDERER sono dettagliati. Design:
> `docs/plans/2026-11-12-integrazione-area7-design.md` (§ Fette, § Permessi,
> Q2, D3, Review Focus F4). Inventario:
> `docs/plans/2026-11-12-integrazione-area7-inventario.md` (le righe
> «Sorgenti esterne», «Sorgenti `#/automations/sources`», la tabella cliente
> → progetto). Registro: `docs/plans/integrazione-registro-rimandi.md`, area
> 7 (la voce di `automations.manage` d'istanza). Specifica: il prototipo
> (`data/automations/{webhooks,sourceWrites,sources}.ts`,
> `pages/automations/{SourcesPage,SourcePanel,WebhookSections,ClientLinks}.tsx`),
> le shape `apps/desktop/.impeccable/shape/{automations,automation-sources}.md`.
> Branch proposti: `feat/area7-f4` (server, 72) e `feat/area7-f4-renderer`
> (94), sopra la F3.

## Cosa cambia

- **Le automazioni generali**: un'automazione senza progetto (fra i
  progetti), di chi ha `automations.manage` d'istanza. Agisce nel progetto
  che il passo dice: uno fisso, oppure quello del cliente dell'evento, dalla
  tabella cliente → progetto; un cliente fuori tabella ferma l'esecuzione su
  «scegli il progetto» (già nel motore, `waiting_project`).
- **Il webhook in arrivo** (Q2, D3): un indirizzo segreto, rigenerabile, con
  un tetto di frequenza. Chi lo chiama manda un JSON; i campi vengono da un
  esempio incollato da chi gestisce l'integrazione. È anche il modo con cui
  Audin e HubSpot si collegano finché non ci sono i loro connettori (Q2: nel
  registro, dopo questa area).
- **«Avvia un'altra automazione»**: il passo che fa partire un'altra
  automazione con dei dati, nella catena di al più 3 (`CHAIN_MAX`,
  `chainAllows` del motore condiviso), senza cicli.
- **La pagina Sources e la tabella cliente → progetto** del prototipo, con
  `integrations.manage`.

Nella F3 l'inizio `source` e il passo `startAutomation` sono «Coming soon» e
`not_available`; la F4 li rende veri.

## Decisioni già prese

- **Q2 = a** *(M)*: prima il webhook in arrivo per automazione; Audin e
  HubSpot dopo, fuori da questa area (registro).
- **D3 = a** *(M)*: il webhook in arrivo ha un URL segreto per automazione,
  rigenerabile, più un limite di frequenza. Niente firma HMAC (era la (b)).
- **Q7 = a** *(O)* e la verifica del 13 nov *(S, registro)*:
  `automations.manage` d'istanza serve solo alle generali e sta al solo
  preset Admin (da noi `instance.full_admin`, quindi già implicito), con la
  regola dei preset; `integrations.manage` (esistente) per le sorgenti e la
  tabella.
- **D2** *(M)*: nessun limite in più sulle quantità; la difesa resta
  l'idempotenza e la profondità della catena (3).
- **P2 = a** *(O, F1)*: i due modelli del prototipo tornano «quando sono
  usabili (F3/F4)»: vedi la domanda F4-4.
- **F3-1 e il suo confine** *(M, O)*: un campo DECISO DA CLAUDE e tinto usato
  come destinazione chiede sempre l'approvazione; un campo grezzo
  dell'evento no. Vale anche per i campi di una sorgente.
- **R-J13** *(design)*: l'evento di un'email lo vede solo il proprietario
  della casella, LUNGO LA CATENA: anche nelle esecuzioni avviate da
  «avvia un'altra».
- **F4-1 = a** *(M)*: un webhook per automazione (un indirizzo, una sola
  automazione che lo usa).
- **F4-2 = c** *(M)*, NON la consigliata: il tetto di frequenza lo sceglie
  chi gestisce l'automazione, con un default di 60 richieste al minuto e
  5 000 al giorno.
- **Il massimo d'istanza** *(O, 46)*: sopra il tetto scelto c'è un massimo
  d'istanza NON superabile (il maintainer non ne ha parlato; scelta
  dell'orchestratrice), così un indirizzo pubblico non resta mai senza
  freno.
- **F4-3 = a, F4-4 = a, F4-5 = a, F4-6 = a** *(O, 46)*, con la consigliata:
  corpo al più 256 KB; i due modelli Audin restano fuori finché non c'è il
  connettore; un evento coi tipi sbagliati è rifiutato (422) e la sorgente lo
  mostra; gli eventi recenti li vede solo chi ha `integrations.manage`.

## Perimetro della F4

| Dentro | Fuori (fetta o area) |
|---|---|
| Automazioni generali (`automations.manage` d'istanza), codici `AUT-n` | I connettori Audin e HubSpot (OAuth, eventi nativi): registro, Q2 |
| Inizio `source` con un webhook in arrivo (D3) | I webhook IN USCITA (area 9) |
| La tabella cliente → progetto, «scegli il progetto», «Remember for <client>» | Le azioni di Claude sulle automazioni (area 10) |
| Passo «avvia un'altra automazione», la catena a 3 | |
| La pagina Sources (solo webhook), gli eventi recenti, «Simulate an event» nella prova | «Simulate an event» che avvia un'esecuzione VERA (solo prototipo) |

## Il webhook in arrivo

- **L'indirizzo**: `POST /hooks/in/:secret` (caddy lo inoltra al server come
  i webhook di oggi), un segreto lungo e casuale per ogni sorgente webhook,
  salvato come hash (si mostra una volta sola, alla creazione e alla
  rigenerazione, come i token). Rigenerare invalida il vecchio subito.
- **Il tetto di frequenza** (D3, F4-2 = c): per indirizzo, con lo stesso
  meccanismo di `POST /api/inbound/:slug/ticket` (`rateLimit` di Fastify).
  Lo sceglie chi gestisce l'automazione (al minuto e al giorno), con un
  default di 60 al minuto e 5 000 al giorno, e non supera MAI il massimo
  d'istanza *(O, 46)*. Oltre: 429, e l'evento non entra.
- **Il corpo**: JSON, un oggetto, al più 256 KB (F4-3 = a). Un corpo che non è un oggetto JSON, o con i tipi sbagliati
  rispetto ai campi della sorgente, NON avvia niente: 422, e l'evento
  compare fra gli «eventi recenti» della sorgente come rifiutato, col motivo
  (F4-5 = a); gli eventi recenti li vede solo chi ha `integrations.manage`
  (F4-6 = a).
- **Il contenuto è NON fidato**: chiunque abbia l'indirizzo scrive i campi.
  Sono tinti (`taint.ts`: i campi di un inizio `source`), entrano nei passi
  come DATI, e un passo di Claude che li legge li riceve delimitati
  (`untrustedText` di `claudePrompt.ts`). F3-1 vale anche qui.
- **L'evento** passa dall'outbox `automation_events` (kind `source_event`,
  con `source_id`, il payload come fotografia e una `dedupe_key` se il
  chiamante manda un id), come gli altri inizi: il consumatore fa partire le
  automazioni attive con quella sorgente.

## Le sorgenti e la tabella cliente → progetto

- **`automation_sources`** (design, § Dati): per la F4 solo `kind:
  "webhook"`, con nome, hash del segreto, esempio, campi (etichetta e tipo
  modificabili), stato, chi l'ha creata. Le righe Audin e HubSpot del
  prototipo restano del prototipo (Q2).
- **`client_project_links`**: chiave del cliente (normalizzata come nel
  prototipo, `lower`), progetto, chi e quando. Un progetto che chi legge non
  vede resta senza id (R-G5, `projectVisible: false`, come il prototipo).
- **La risoluzione del progetto** (`resolve_project` del motore): il cliente
  dell'evento (`clientRef` del passo) → la tabella; fuori tabella →
  `waiting_project`, «scegli il progetto» al proprietario (solo progetti dove
  può creare); «Remember for <client>» scrive la tabella solo con
  `integrations.manage`.
- **I suggerimenti** «From recent events» (`listClientSuggestions`): i
  clienti degli eventi recenti senza riga in tabella.

## «Avvia un'altra automazione» e la catena

- Il passo `startAutomation` fa partire un'altra automazione ATTIVA, con i
  dati del passo come evento. `chainAllows` del motore condiviso: un'
  automazione già fra gli antenati non riparte (nessun ciclo), e la catena
  si ferma a 3 (`CHAIN_MAX`).
- **Il proprietario** del passo deve poter gestire l'automazione da avviare
  (`cantManage` del prototipo), ricontrollato a ogni effetto.
- **R-J13 lungo la catena**: un'esecuzione figlia di una partita da un'email
  porta l'«origine email» del genitore (`mailOwnerId` del primo anello):
  mittente, oggetto e testo che arrivano nei dati della figlia li vede solo
  il proprietario della casella d'origine, anche se la figlia è di un altro
  (`viewRun` / `hideReplies`, le regole già in shared).
- **La configurazione**: avviare un'automazione sconosciuta o sé stessa
  (A → … → A) è un errore e non si pubblica (`automation_cycle`, già nel
  prototipo e in `validateFlow`).

## La tinta (F3) per le sorgenti

- I campi di un inizio `source` sono tinti (già in `taint.ts`).
- **Un «per ogni» su un elenco GREZZO tinto** (un elenco del payload del
  webhook) tinge i suoi elementi per chi li legge (un passo di Claude che
  legge un elemento ha i campi tinti), ma una destinazione presa direttamente
  dall'elemento grezzo resta permessa: non l'ha decisa Claude. È nel fix
  della F3 di 72 (M6, d7844b18 su `feat/area7-f3-fix`); nella F4 R2 lo
  verifica coi campi di una sorgente.
- **Le richieste** (I4 del fix della F3, *(O)* di 46): con gli inizi
  `request_created` e `request_converted` titolo e descrizione della
  richiesta sono tinti (possono venire dal widget di supporto), salvo un
  filtro dell'inizio che escluda `richiesta.dal_supporto`.

## Le rotte (aggiunte alla F3)

| Rotta | |
|---|---|
| `POST /hooks/in/:secret` | pubblica, senza sessione; 202 accettato, 404 indirizzo sconosciuto, 422 corpo non valido, 429 oltre il tetto |
| `GET /api/automation-sources` · `POST` (nuovo webhook) · `PATCH /:id` (nome) · `POST /:id/regenerate` · `PUT /:id/example` · `PATCH /:id/fields/:key` · `GET /:id/events` | `integrations.manage`; il segreto esce solo da `POST` e `regenerate` |
| `GET /api/client-links` · `PUT /api/client-links/:key` · `DELETE /api/client-links/:key` · `GET /api/client-links/suggestions` | `integrations.manage` per scrivere; leggere chi vede le sorgenti |
| `POST /api/automations` con `projectId: null` | generale, `automations.manage` d'istanza |
| `GET /api/automations/:code/test/source-example` | l'esempio della sorgente per la prova (gratuito) |

## Task del SERVER (interfacce e test; l'implementazione è di 72)

S1. **La migrazione**: `automation_sources`, `client_project_links`, la
   sequenza dei codici delle generali, `automation_events.kind`
   `source_event` (valore d'enum in uno statement a sé), i permessi
   `automations.manage` d'istanza al preset Admin con la regola dei preset.
   *Test*: il preset Admin lo ha, gli altri no; un utente senza non vede
   le generali (404, R-G5).

S2. **Le generali**: creare, modificare, accendere con `projectId: null`;
   l'elenco e il dettaglio solo con `automations.manage` d'istanza; le
   esecuzioni di una generale nei progetti dove ha agito (la sezione del
   progetto, «generali che hanno agito qui», solo a chi le vede). *Test
   negativi*: un Project Lead non crea né vede una generale.

S3. **Il webhook in arrivo**: la rotta pubblica, il segreto come hash, il
   tetto, il controllo del corpo coi campi della sorgente, l'outbox.
   Il tetto scelto per automazione (al minuto e al giorno, default 60 e
   5 000) e il massimo d'istanza che nessuna scelta supera (F4-2).
   *Test*: corpo sbagliato → 422 e nessuna esecuzione; oltre il tetto → 429;
   un tetto scelto sopra il massimo d'istanza vale il massimo;
   rigenerato → il vecchio indirizzo dà 404; due consegne con la stessa
   `dedupe_key` → una sola esecuzione.

S4. **Sorgenti e tabella**: le rotte sopra; «esempio → campi» con la regola
   del prototipo (`deriveFields`, da spostare in shared); i suggerimenti.
   *Test*: un progetto che chi legge non vede resta senza id.

S5. **La risoluzione del progetto**: dalla tabella, `waiting_project` fuori
   tabella, «scegli il progetto» e «Remember for <client>» coi permessi.
   *Test*: «Remember» senza `integrations.manage` sceglie il progetto ma non
   scrive la tabella.

S6. **«Avvia un'altra»**: l'effetto, `chainAllows`, `cantManage`, la catena
   nell'outbox (`chain`), l'origine email lungo la catena (R-J13). *Test*:
   A → B → C parte, A → B → C → D no; A → B → A no; la figlia di
   un'esecuzione da email non mostra il testo a un proprietario diverso.

S7. **Il client** (`client.automations`): sorgenti, tabella, generali; forme
   additive in shared, facoltative, con un test che parsa una risposta senza.

S8. **Il deploy-log**: la voce della F4 (caddy per `/hooks/in`, la
   migrazione, il rollback: un `automation_events.kind` nuovo).

## Task del RENDERER (94)

R1. **La disponibilità della F4**: `AUTOMATION_F4_AVAILABILITY` = la F3 più
   l'inizio `source` (solo webhook) e `startAutomation`. Nella build app con
   `automations-f4`, spenta. *Test*: `BuilderPerimeter.test.tsx` col
   perimetro della F4; Audin e HubSpot restano «Coming soon».

R2. **La verifica della tinta con le sorgenti** (la regola è già in
   `taint.ts` dal fix della F3): *Test* coi campi di una sorgente webhook:
   un passo di Claude che legge l'elemento di un elenco del payload ha i
   campi tinti; una destinazione presa dall'elemento grezzo resta permessa;
   una presa da Claude chiede l'approvazione.

R3. **Le generali nella build app**: la voce «General» della colonna, la
   creazione con «General (all projects)» (`projectId: null`), i perimetri
   di `useAutomationPerms` (`instance` oggi spento nella build app) e
   `automations.manage` d'istanza dal server. *Test*: chi non ha il permesso
   d'istanza non vede la voce né l'opzione.

R4. **Sources e tabella**: le pagine del prototipo sulle rotte vere (solo
   webhook; Audin e HubSpot «Coming soon»), il segreto mostrato una volta
   alla creazione e alla rigenerazione (copia, poi non più), gli eventi
   recenti coi rifiutati e il motivo; il tetto di frequenza
   dell'automazione (al minuto e al giorno, col default e il massimo
   d'istanza detto accanto, F4-2 = c). *Test*: la pagina fino alla richiesta
   esatta; il segreto non è più leggibile dopo aver chiuso il dialogo; un
   tetto oltre il massimo non si salva (o vale il massimo, come dice il
   server).

R5. **La prova con una sorgente**: l'esempio della sorgente (o uno scritto),
   la risoluzione del progetto e «scegli il progetto» nella prova senza
   scrivere la tabella (già nel prototipo). *Test*: chiama solo GET e
   `/tested`.

R6. **«Avvia un'altra» nel costruttore e nell'esecuzione**: il passo, i
   problemi di configurazione (ciclo, sconosciuta), le figlie nel dettaglio
   («Started by …», «Started …»), R-J13 lungo la catena detto in parole.

R7. **Parità** (`apps/desktop/docs/integration-area7-f4.md`) e registro.

## Global Constraints

- Le tre regole dell'anti-obiettivo; tutto tracciato.
- Il contenuto di un webhook è non fidato: dati, mai istruzioni; tinto.
- Il segreto del webhook non esce mai dopo la creazione o la rigenerazione;
  si salva come hash.
- Nascosto = inesistente: le generali per chi non ha il permesso d'istanza,
  i progetti della tabella che chi legge non vede.
- La catena si ferma a 3 e non fa cicli; l'idempotenza vale per ogni effetto.
- La posta resta del proprietario della casella, anche lungo la catena.
- Verso i client solo campi additivi con default; test filtrati; mutazioni
  sui controlli dei permessi, del tetto e della catena.

## Review Focus

- **Il webhook come porta pubblica**: indirizzo indovinabile? hash del
  segreto, rigenerazione che invalida subito, tetto per indirizzo, corpo
  grande, JSON annidato profondo, tipi sbagliati, consegne duplicate.
- **Il contenuto non fidato**: un campo del webhook non diventa
  un'istruzione per Claude, né sceglie la casella o il progetto senza
  passare dalla tabella.
- **Le generali e R-G5**: un Project Lead non le vede né le crea; nella
  sezione del progetto una generale compare solo a chi la vede.
- **La catena**: A → B → C → D si ferma, A → B → A non parte, la catena non
  si allunga passando da una sorgente.
- **R-J13 lungo la catena**: il testo di un'email non arriva al proprietario
  di una figlia che non possiede la casella.

## Domande per il maintainer (risposte: vedi «Le risposte alle domande»)

### Le risposte alle domande (13 nov 2026)

- **F4-1 = a** *(M)*: un webhook per automazione.
- **F4-2 = c** *(M)*, NON la consigliata: il tetto lo sceglie chi gestisce
  l'automazione, default 60 al minuto e 5 000 al giorno; sopra c'è un
  massimo d'istanza non superabile *(O, 46)*.
- **F4-3 = a** *(O, 46)*: corpo al più 256 KB.
- **F4-4 = a** *(O, 46)*: i due modelli Audin fuori finché non c'è il
  connettore.
- **F4-5 = a** *(O, 46)*: un evento coi tipi sbagliati è rifiutato (422) e
  la sorgente lo mostra col motivo.
- **F4-6 = a** *(O, 46)*: gli eventi recenti li vede solo chi ha
  `integrations.manage`.
- **R2** resta una verifica: la tinta degli elementi di un «per ogni» su un
  elenco grezzo è nel fix della F3 di 72 (minore 6).

### Le opzioni poste

Ognuna con la consigliata per prima.

F4-1. **Il webhook è per automazione (D3) o una sorgente condivisa** (il
   prototipo: una sorgente webhook in Sources, usata da più automazioni)?
   (a) Una sorgente webhook in Sources ha UN indirizzo e la usa UNA sola
   automazione: D3 alla lettera, e rigenerare tocca un'automazione sola.
   *(consigliata)*
   (b) Come il prototipo: una sorgente, un indirizzo, più automazioni che la
   usano (rigenerarla le tocca tutte, e Sources dice chi si ferma).

F4-2. **Il tetto di frequenza di un indirizzo** (D3)?
   (a) 60 richieste al minuto e 5 000 al giorno, poi 429. *(consigliata:
   largo per un CRM, stretto per un abuso)*
   (b) 10 al minuto.
   (c) Lo sceglie chi gestisce l'integrazione, per sorgente.

F4-3. **La dimensione massima del corpo**?
   (a) 256 KB. *(consigliata: un evento, non un file)*
   (b) 1 MB.

F4-4. **I due modelli del prototipo** («Nuovo contratto» da una trattativa
   Audin, «Richiesta dati al cliente») partono da Audin, che nella F4 non
   c'è (Q2)?
   (a) Restano fuori finché non c'è il connettore di Audin (registro).
   *(consigliata)*
   (b) Tornano nella F4 con un webhook al posto di Audin (chi crea collega
   lui il CRM al webhook).

F4-5. **Un evento con i tipi sbagliati** (un campo numero che arriva testo)?
   (a) Rifiutato con 422, nessuna esecuzione, e la sorgente lo mostra fra gli
   eventi recenti col motivo. *(consigliata)*
   (b) Accettato: l'esecuzione parte e fallisce al primo passo che usa il
   campo.

F4-6. **Chi vede gli eventi recenti di una sorgente** (il payload, che può
   avere dati di clienti)?
   (a) Solo chi ha `integrations.manage`. *(consigliata)*
   (b) Anche i proprietari delle automazioni che la usano.

## Correzioni da chiedere a 72 (prima dei task del server)

- **C-F4-1.** La rotta pubblica: `/hooks/in/:secret` sotto caddy accanto a
  `/webhooks/git/:slug`, o sotto `/api/inbound/…` per riusarne il
  `rateLimit`?
- **C-F4-2.** `deriveFields` e la normalizzazione della chiave del cliente
  (`lower`) in shared, come `planEmail`, così prova, server e prototipo non
  divergono.

## Rimandi (dal registro, area 7)

- I connettori Audin e HubSpot (Q2): eventi nativi, OAuth o chiave, dopo
  questa area.
- Le azioni di Claude sulle automazioni (area 10).
- I webhook in uscita (area 9).
