# Area 6, fetta 3b — il Calendario con TUTTI gli eventi

> Piano di 72, 12 nov 2026. Decisione del maintainer *(M)*: «Tutti, come il
> prototipo». Decisioni d'orchestrazione *(O)* di 46 sull'inventario di 94
> (vedi il registro, area 6). Branch `feat/area6-f3b`, sopra `feat/area6-f3`.

## Cosa cambia

Oggi il worker scrive in `calendar_events` SOLO gli eventi «in perimetro»
(le regole di smistamento dei progetti, `routeEvent(...).inScope`) e con un
titolo: il calendario dell'app mostra quindi solo il lavoro riconosciuto. Il
prototipo mostra TUTTO il calendario della persona. Dopo questa fetta:

- il worker salva **tutti** gli eventi della finestra `now − 30gg → now +
  60gg` del calendario **principale** di ogni casella (il prototipo ha UN
  calendario per account Google: `CALENDAR_SYNC`, una riga per persona —
  verificato, quindi niente `calendarList`), tranne `workingLocation` e
  `birthday` *(O, 46)*; gli `outOfOffice` restano (occupano il
  libero/occupato della F4);
- ogni riga distingue **evento visto** da **candidato a una proposta**
  (`proposal_candidate`): solo i candidati possono diventare proposte, con le
  regole di oggi (futuri, non rifiutati, le serie solo se accese);
- gli eventi li vede SOLO il proprietario della casella (`mailbox_owner`,
  invariato); i colleghi vedranno solo intervalli (F4).

## Le forme per il renderer (risposta a 94, tutte additive)

- su ogni evento di `range` e di `event(id)`: `recognized: boolean` (è un
  candidato: lavoro riconosciuto), `projectBy: "rules" | "model" | "manual" |
  null`, `eventType` (`default`, `outOfOffice`, `focusTime`, `fromGmail`, …
  aperto con `readerSchema`), `transparency` (`opaque` | `transparent`); un
  evento non riconosciuto ha `reproposable: false` e nessun «Suggested by
  Stubwise»;
- `range` diventa una lista **leggera** (titolo, orari, tutto il giorno,
  stato, progetto, i quattro campi sopra, il rifiuto); `descriptionHtml`,
  `conferenceEntryPoints`, i promemoria e gli invitati restano in `event(id)`
  (F1.4), che il dettaglio rilegge per id;
- un evento o un'occorrenza cancellata su Google **sparisce** da `range`;
  un'occorrenza spostata ha l'ora nuova (la riga si aggiorna per
  `google_event_id`, come oggi);
- `/series` elenca ogni serie ricorrente, anche personali, spente di default;
  ogni serie ha `recognized` (almeno una sua occorrenza è candidata) per
  ordinarle, prima quelle di lavoro;
- col flag acceso le proposte del calendario entrano in
  `/api/me/mail/proposals` con `kind: "calendar"` e l'origine `{ eventId,
  title, startsAt, allDay }` al posto di `messageId` *(O, 46: una fonte sola
  per «Da decidere»)*; col flag spento restano sull'inbox come oggi.

## Quante righe in più, e la potatura

**Stima per casella** (da confermare con una query di sola lettura del
maintainer, sotto): una persona che lavora ha ~5–12 appuntamenti per giorno
lavorativo, ricorrenti compresi (Google espande le occorrenze); la finestra è
di 90 giorni ≈ 64 giorni lavorativi, quindi **~300–800 righe per casella**,
fino a ~1.500 per chi ha molte ricorrenze brevi. Una riga pesa ~1–4 KB (la
descrizione HTML grezza e i punti d'accesso della conferenza sono la parte
grossa), quindi **~1–5 MB per casella**. Oggi le righe sono solo i candidati:
qualche decina per casella. La crescita NON è illimitata se la finestra
pota: a regime le righe sono quelle della finestra.

**Oggi non c'è nessuna potatura di `calendar_events`** (le righe passate
restano per sempre: con pochi candidati non si vedeva). La F3b la aggiunge,
nel giro di pulizia del worker accanto a `pruneOldEmails`:

- si toglie una riga che **comincia prima di `now − 31gg`** (un giorno oltre
  la finestra, così il bordo non oscilla) **e non ha una proposta aperta**
  (`proposal_notification_id is null or outcome is not null`);
- una proposta aperta su un evento passato non si pota: la si chiude come
  scaduta (`outcome = { type: "expired" }`, la card chiusa) e si pota al giro
  dopo — mai una card che punta a una riga sparita;
- nessuna tabella punta a `calendar_events` (verificato: nessuna FK), e il
  registro decisioni tiene i FATTI per conto suo, quindi potare una riga
  decisa non perde storia;
- `calendar_series` e `calendar_series_recurrence` restano (sono la
  configurazione della persona, non eventi).

Query per il maintainer (sola lettura, prima del rollout):
`select account_id, count(*) from calendar_events group by 1;` (oggi) e,
dopo il rollout, la stessa con `pg_total_relation_size('calendar_events')`.

## Le serie con `auto` accese quando cambia la dottrina

Una serie con `auto: true` esegue da sola l'azione configurata (milestone,
voce di backlog, promemoria) sull'occorrenza che entra nei giorni di
anticipo. È una configurazione ESPLICITA della persona: progetto e azione li
ha scelti lei sulla serie. Quindi:

- **la serie configurata vince sulla dottrina**: con il flag spento o
  acceso, un'occorrenza di una serie accesa è candidata se la serie è accesa
  e ha un progetto, con l'azione della serie — la dottrina nuova decide solo
  gli eventi NON configurati. Nessuna serie `auto` cambia comportamento al
  cambio del flag;
- l'invariante resta: un'azione automatica non avvia MAI lavoro, e una serie
  è spenta di default (anche le personali che ora compaiono in `/series`);
- **rischio da guardare**: oggi una serie accesa riceveva solo occorrenze in
  perimetro; ora le riceve tutte quelle della serie (anche se un'occorrenza
  cambia titolo e uscirebbe dalle regole). È il comportamento giusto (la
  serie è la serie), ma prima del rollout il maintainer controlli `select
  count(*) from calendar_series where auto;` — se ce ne sono, la voce del
  deploy-log dice di guardarle il primo giorno.

## La dottrina nuova sul calendario (flag acceso)

*(O, 72)* Stesso flag della posta, `MAIL_CLASSIFY_V2`: una dottrina sola per
la Posta e il Calendario, come chiede 46, e un solo interruttore da
spiegare. Col flag spento: candidato = in perimetro per le regole, come oggi.
Col flag acceso le regole si tolgono anche qui, nello stesso ordine della
posta:

- candidato = un evento con almeno un **invitato che è una persona di
  Stubwise membro esplicito di un progetto** (gli stessi candidati della
  posta, `loadCandidateProjects`), escluso il solo proprietario; un evento
  con un progetto solo diventa una proposta su quel progetto
  (`projectBy: "model"`), uno con più progetti una «Quale progetto?» (come la
  posta);
- *(O)* **nessun modello** per il calendario in questa fetta: la scelta è
  deterministica dagli invitati. Il calendario porta tanti eventi e poco
  testo, e una classificazione a pagamento per ogni riunione costerebbe più
  di quanto aggiunge; resta nel registro come miglioramento possibile.

## Task (in ordine, ognuno col suo test rosso e le mutazioni)

1. Migrazione: `calendar_events` + `event_type`, `transparency`,
   `proposal_candidate` (default **true**: le righe di oggi sono tutte
   candidate), `project_by`; indice `(account_id, starts_at)` per `range` e
   la potatura.
2. `@stubwise/google`: `eventType` e `transparency` normalizzati (aperti).
3. Worker, ingestione: tutti gli eventi della finestra, senza
   `workingLocation`/`birthday`, senza titolo = «(senza titolo)» alla
   lettura; `proposal_candidate` dalle regole (flag spento) o dagli invitati
   (flag acceso); una cancellata non candidata si toglie.
4. Worker, proposte: solo i candidati (una `where` in più nella fase D) e le
   serie come oggi; test negativo «un evento personale non diventa MAI una
   proposta».
5. Worker, potatura (sopra), con la chiusura delle proposte scadute.
6. Server: `range` leggero coi campi nuovi, `event(id)` completo, `/series`
   con `recognized`; le cancellate fuori.
7. Flag acceso: candidati dagli invitati, «Quale progetto?» del calendario,
   proposte del calendario in `/api/me/mail/proposals` con `kind`.
8. Chiusura: invarianti (`mail-calendar.md`: «un evento visto non è un
   candidato»), deploy-log, registro, api-client.

## Global Constraints

- Nessuna scrittura verso Google (la F3b legge soltanto).
- `mailbox_owner` resta la privacy degli eventi; un admin non li vede.
- Un evento passato o rifiutato non diventa MAI una proposta; una serie è
  spenta di default e la sua azione automatica non avvia lavoro.
- Verso i client solo campi additivi con default; test filtrati; mutazioni.

## Review Focus

- La potatura non toglie una riga con una proposta aperta.
- Un evento personale (nessun invitato membro, nessuna regola) non arriva
  mai a una proposta, né col flag spento né acceso.
- Il carico: una casella con 1.500 eventi in finestra non fa N query per
  evento (le letture per lotto di oggi restano tali).

## Chiusura (12 nov 2026)

Fatti i task 1–8 su `feat/area6-f3b`. Cambiamenti rispetto al piano, tutti
annotati *(O)* e riferiti a 46: la lista leggera di `range` è su richiesta
(`fields=summary`), perché web e app leggono ancora i campi pesanti; la
linea di base (per il deploy e per l'accensione del flag) l'ha chiesta 46;
la «Quale progetto?» del calendario è rimandata (registro); l'origine di una
proposta del calendario sta in `calendarOrigin`. Trovato e corretto un bug
preesistente: l'occorrenza di una serie col progetto scelto diverso da
quello delle regole spariva in silenzio. Migrazioni 0161 (era la 0157) e
0162.

