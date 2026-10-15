# Giro notturno: riassunti dei commit, daily report, note di rilascio e Docs

Data: 15 ott 2026. Stato: design approvato dal maintainer in conversazione, una
sezione alla volta. Sostituisce l'aggiornamento Docs a ogni push
(`apps/worker/src/docs/auto-update.ts`) e il poller del daily report
(`apps/worker/src/reports/daily-report-poller.ts`); comprende la gestione della
quota degli account Claude per **tutti** i tipi di lavoro.

## 1. Il problema

Il 15 ott 2026 si è scoperto che in un giorno era stato consumato il 65% della
quota settimanale dell'abbonamento. Indagine in sola lettura sul server
(`~/stubwise-records/2026-10-15-claude-usage/` sulla macchina del maintainer):

- **Aggiornamento Docs a ogni push**: 98,5% della spesa dall'ultimo reset
  settimanale. Negli ultimi 7 giorni 8527 processi `claude` e ~1646 $ equivalenti;
  ogni aggiornamento di Audin AI lanciava ~210 run Opus (200–300 $). Tre difetti
  combinati:
  1. i tetti in produzione erano 100000 (default di `docker-compose.yml`, commit
     `aa4149f0` del 24 lug 2026), quindi ogni pagina toccata (e la sua padre)
     veniva rigenerata a freddo con Opus;
  2. il punto di partenza del diff restava bloccato: avanzava solo se la nota di
     rilascio andava a buon fine, quindi ogni push rielaborava lo stesso
     intervallo, sempre più grande;
  3. il limite dell'account («You've hit your session/weekly limit») non era
     riconosciuto: ogni job lanciava comunque tutti i suoi processi, e la nota
     falliva sul testo del limite, alimentando il punto 2.
  In un job da 303 $, 161 pagine su 206 hanno risposto «nessun cambiamento».
- **Limite non riconosciuto, ovunque**: fra il 13 e il 14 ott oltre 7000
  processi (Docs, ma anche daily report, posta, backlog) sono partiti e morti sul
  limite settimanale.
- **Daily report**: un run per commit, ~15 $ a notte sui giorni attivi
  (Audin AI 142 commit). I report del 12 e 13 ott sono rimasti vuoti per sempre
  perché ogni descrizione è fallita sul limite.

Misura presa il 15 ott alle 16:41: `doc_auto_update=false` su tutti gli 11
progetti e coda `doc_auto_update_jobs` svuotata. Resta spento fino al rilascio
di questa funzione. Il daily report è passato a Haiku (PR #103), in attesa di
questo ridisegno.

## 2. Decisioni del maintainer

1. **Un solo processo notturno** raggruppa le operazioni automatiche sui commit:
   riassunti, daily report, note di rilascio, aggiornamento dei Docs.
2. **Ogni commit si legge una volta**, con Haiku 5.5: il riassunto salvato serve
   sia al daily report sia ai Docs, che non rileggono il codice per capire cosa è
   cambiato.
3. **Freschezza**: i Docs possono essere indietro fino a un giorno, ma devono
   dirlo («onesti»).
4. **«In produzione» = raggiungibile dal branch di default.** Solo i commit in
   produzione entrano nella nota di rilascio e nei Docs; tutti entrano nei
   riassunti e nel daily report.
5. **Commit arrivati in ritardo**: vengono riassunti e assegnati al giorno della
   loro data, ma il daily report di quel giorno NON si rigenera da solo; si
   rigenera dall'interfaccia, come oggi.
6. **Note di rilascio**: una per progetto per notte, con Sonnet 5.5, scritta dai
   riassunti dei commit entrati in produzione.
7. **Docs**: con Sonnet 5.5 (non Opus). Pagine candidate = pagine collegate ai
   file cambiati ∪ pagine che la nota indica come toccate. Per ogni candidata il
   modello riceve la pagina e i riassunti dei commit che la riguardano, e può
   leggere **solo i file cambiati**, al commit documentato. Le aree nuove
   descritte dalla nota diventano **pagine nuove**.
8. **Nessun tetto** sul numero di pagine aggiornate o create: un rilascio grosso
   va documentato per intero. Il freno sul costo è la quota (punto 9); in più un
   **allarme** in inbox se il piano notturno di un progetto supera una soglia di
   run (default 50): si esegue comunque.
9. **Quota degli account, per tutti i lavori**:
   - il limite si riconosce e ferma i run su quell'account fino al reset;
   - si passa agli altri **abbonamenti** della catena; l'account fissato su un
     progetto diventa **«preferito»** (con un'opzione «solo questo» per
     l'esclusiva);
   - la **chiave API a consumo non entra mai** nel passaggio automatico;
   - i lavori di **sfondo** (il giro notturno, il brief settimanale e la
     generazione Docs completa — decisione del 15 ott dopo il preflight) non
     usano un account oltre il **90%** della quota settimanale; quelli
     interattivi fino al limite.

## 3. Il giro notturno

Parte a un orario configurabile (`NIGHTLY_START`, default `01:00`
`Europe/Rome`) e lavora **per repository**, alternando i progetti. Gira solo
sui progetti con almeno uno dei due interruttori accesi (§5.1). È un lavoro di
**sfondo** (§4.4).

### 3.1 Fase 1 — Riassunti dei commit (Haiku 5.5)

- Insieme di lavoro: i commit di **tutti i branch** (`git log --branches`, come
  il daily report di oggi) **non ancora riassunti**, esclusi i merge, con data
  entro una finestra di sicurezza (default 30 giorni, per non riassumere la
  storia intera al primo giro).
- Ogni commit ha un riassunto **salvato in tabella** (repository, sha): cosa fa,
  aree e file toccati, data del commit, autore. Non si rifà mai.
- **Rumore**: un commit che tocca solo file di rumore (lockfile, codice
  generato o vendorizzato, cartelle di processo: la stessa regola del «gate
  rumore» di oggi) non va al modello; riceve un riassunto deterministico.
- **Diff enormi**: al modello arriva il diff tagliato a una soglia, con il
  riepilogo completo dei file (numstat).
- Un commit arrivato in ritardo viene riassunto e assegnato al suo giorno
  (data del commit nel fuso del progetto).

### 3.2 Fase 2 — Daily report (Haiku 5.5)

- Solo per i progetti con il daily report acceso.
- Si generano i report del **giorno appena chiuso**: riassunto di progetto e per
  sviluppatore, scritti dai riassunti della fase 1 (nessuna rilettura dei diff).
- I giorni passati non si rigenerano da soli (decisione 5). La rigenerazione a
  mano (`POST /api/activity/generate`) usa anch'essa i riassunti salvati.

### 3.3 Fase 3 — Nota di rilascio (Sonnet 5.5)

- Solo per i progetti con i Docs notturni accesi.
- Insieme: i commit diventati raggiungibili dal branch di default dopo il
  **segnalibro «documentato fino a»** del repository (quindi anche commit
  vecchi di branch mergiati tardi). Se il segnalibro non c'è ancora, parte dal
  commit dell'ultima generazione Docs completa.
- Una nota per repository, una pagina `releases` come oggi, scritta dai
  riassunti; elenca anche le **aree nuove** non coperte da nessuna pagina.

### 3.4 Fase 4 — Docs (Sonnet 5.5)

- Pagine candidate = pagine il cui `sourcePath` copre un file cambiato
  (`mapAffectedPages`, regola deterministica esistente) ∪ pagine che la nota
  indica come toccate.
- Per ogni candidata, un run read-only su un worktree al commit documentato
  (la punta del branch di default all'inizio della fase): riceve la pagina e i
  riassunti dei commit che la riguardano, può leggere **solo i file cambiati**
  (allowlist ristretta ai loro percorsi), e corregge le sezioni interessate o
  risponde «nessun cambiamento». Le guardie di oggi restano (audit dei segreti
  sulle pagine `product`).
- Per ogni area nuova, una pagina nuova.
- Le pagine cambiate o create vengono ri-embeddate (`doc_chunks`).
- A fine fase il segnalibro avanza al commit documentato. **Il segnalibro non
  dipende dalla nota di rilascio** (il difetto 2 del §1).

### 3.5 Coda e ripresa

Ogni elemento di lavoro è una riga in tabella con il suo stato: un commit da
riassumere, un daily report da scrivere, una nota di rilascio, una pagina da
aggiornare, una pagina da creare. Il giro le consuma come una coda per
repository e fase. Conseguenze:

- **idempotenza**: rieseguire una fase non rifà ciò che è fatto;
- **ripresa** dopo un limite, un riavvio del worker o un errore: si riparte
  dall'elemento registrato; il lavoro rimasto passa alla notte dopo, mai perso;
- **visibilità**: «quanto manca» si può mostrare.

### 3.6 Allarme

Se il piano di un progetto per la notte supera `NIGHTLY_ALERT_RUNS` (default
50) run Sonnet (fase 3 + fase 4), il giro lo esegue comunque e i maintainer
ricevono una card in inbox con i numeri (commit in produzione, pagine
candidate, pagine nuove). Serve a vedere il giorno stesso un difetto che gonfia
il lavoro, senza tagliare la documentazione di un rilascio grosso.

## 4. Quota degli account (tutti i lavori)

Vale per ogni run `claude` del worker: fix, triage, review, chat CODE, deep
dive, sessioni di refinement, posta, backlog, giro notturno.

### 4.1 Riconoscere il limite

`LIMIT_MARKERS` (`apps/worker/src/providers/limit.ts`) riconosce anche
«You've hit your session limit» e «You've hit your weekly limit · resets …»,
che oggi non combaciano con nessun marcatore.

### 4.2 Stop e ripresa

Al primo run che incontra il limite, l'account è marcato **«al limite» fino al
reset** (dal testo del messaggio, o dallo snapshot d'uso di `/usage` letto ogni
5 minuti). Nessun run parte su quell'account finché non torna disponibile. Il
lavoro interrotto non si perde: i job tornano in coda (come i `held` per
limite di oggi), il giro notturno riprende dalla coda (§3.5).

### 4.3 Passaggio fra abbonamenti

Ordine di scelta per ogni lavoro:

1. l'account **preferito** del progetto, se c'è e se è disponibile;
2. gli altri **abbonamenti** (`kind = 'account'`) nell'ordine della catena.

L'account fissato su un progetto (`projects.ai_provider_id`) diventa
**preferito**: oggi è rigido (niente failover). Un'opzione per progetto
**«solo questo»** ripristina l'esclusiva; vale solo finché il progetto ha un
account fissato (se l'account viene tolto o cancellato, l'opzione si azzera).
La **chiave API** (`kind = 'api_key'`) non entra mai nel passaggio automatico,
**nemmeno con tutti gli abbonamenti al limite**: si usa solo se è il provider
esplicito del progetto, se l'istanza non ha nessun abbonamento, o nei punti che
oggi la usano già esplicitamente.

### 4.4 Soglia per lo sfondo

I lavori di **sfondo** non scelgono un account la cui ultima lettura della
quota settimanale è oltre `BACKGROUND_WEEKLY_THRESHOLD` (default 90%). Sono di
sfondo (decisione del maintainer del 15 ott, dopo il preflight dei piani):

- il giro notturno;
- il brief settimanale;
- la **generazione Docs completa**, anche quando la lancia una persona: senza
  margine va in pausa e riprende quando il margine torna, come oggi al limite.

Tutti gli altri lavori sono interattivi e possono usare un account fino al
limite. Se nessun abbonamento è sotto soglia, il giro si ferma e riprende quando
il margine torna (al più tardi la notte dopo). La ripresa automatica dei lavori
fermi usa la stessa scelta del §4.3, non una regola sua.

### 4.5 Un posto solo

La scelta dell'account è una funzione condivisa, usata da tutti i lavori. Oggi
ce n'è una per il fix (`handler.ts`, con failover), una per i Docs e una per il
backlog (`resolveBacklogProvider`, senza): diventano una.

## 5. Interfaccia

### 5.1 Impostazioni del progetto

I due interruttori esistenti cambiano significato, non nome di colonna:

- `doc_auto_update` → **«Docs aggiornati ogni notte»** (fasi 3–4);
- `daily_report_enabled` → invariato (fase 2).

La fase 1 gira se almeno uno dei due è acceso. Dopo il deploy restano tutti
spenti come adesso; si riaccendono a mano, progetto per progetto. Nuova opzione
«solo questo account» accanto al provider del progetto (§4.3).

### 5.2 Pagine dei Docs oneste

In testa a ogni pagina: «aggiornata al commit X, il giorno Y». Se un commit in
produzione dopo il segnalibro ha toccato i suoi file, un avviso «il codice è
cambiato dopo questa pagina» con i commit e i loro riassunti. L'avviso è
**derivato a lettura** (file della pagina ∩ file dei commit in produzione dopo
il segnalibro), mai scritto: vale anche per le pagine vecchie (regola «i campi
che un client legge si derivano a lettura»).

### 5.3 Note di rilascio, allarme, daily report

- Una pagina `releases` per progetto per notte con commit in produzione: cita
  pagine aggiornate, pagine create e aree nuove.
- L'allarme del §3.6 è una card d'inbox per i maintainer.
- Il daily report per chi legge non cambia.

## 6. Cosa sparisce

- L'aggiornamento Docs innescato dal push: l'accodamento nel webhook
  (`apps/server/src/routes/webhooks.ts`), la coda `doc_auto_update_jobs` con il
  suo debounce, `auto-update.ts` e `auto-update-poller.ts`.
- Il poller del daily report, assorbito dal giro notturno.
- Le env `DOCS_AUTOUPDATE_MAX_PAGES` / `DOCS_AUTOUPDATE_MAX_NEW_PAGES` (e i loro
  100000 in compose).

La generazione Docs completa (a mano, DAG ricorsivo) non cambia, salvo la quota
(§4.4: è un lavoro di sfondo).

## 7. Errori

- **Limite**: §4.2; non è un errore della fase.
- **Errore del modello o output non valido**: il commit resta senza riassunto,
  la pagina com'era, la nota non scritta; si riprova la notte dopo. Dopo **3
  notti consecutive** di fallimento dello stesso elemento, l'elemento va in
  inbox ai maintainer e non si riprova più da solo.
- **Riavvio del worker a metà giro**: si riparte dalla coda (§3.5); il worktree
  si riapre.
- **Repository non raggiungibile** (credenziali, mirror): saltato per la notte,
  una riga nel log, gli altri progetti proseguono.

## 8. Test

- **Unitari e su Postgres vero**:
  - insieme dei commit nuovi e di quelli entrati in produzione, compresi branch
    mergiati tardi e commit fuori finestra;
  - ripresa a metà fase e idempotenza;
  - il segnalibro avanza anche se la nota fallisce;
  - selezione delle candidate (mappa file ∪ nota);
  - avviso «superata» derivato a lettura, con una fixture senza i campi nuovi;
  - scelta dell'account: preferito, passaggio, «solo questo», mai la chiave
    API, soglia 90% solo per lo sfondo, stop al limite e ripresa;
  - i nuovi messaggi di limite riconosciuti (test con i testi veri del 13–15
    ott).
- **Golden manuale**: una notte su un repo fixture con 5 commit (uno solo
  rumore, uno con un'area nuova): 4 riassunti, solo le pagine toccate
  aggiornate, la pagina dell'area nuova creata, una nota; costo misurato.
- **Rollout**: un progetto piccolo per primo, giro lanciato a mano, costo reale
  letto; poi gli altri.

## 9. Deploy e rollback

- **Migrazione additiva**: tabelle per i riassunti dei commit e per la coda del
  giro; segnalibro per repository; opzione «solo questo account» sul progetto.
- **Tipo di notifica nuovo** per l'allarme (e per l'elemento fallito 3 notti):
  un valore nuovo di `notification_kind` va in uno statement a sé
  (`ALTER TYPE … ADD VALUE`, regola del batch in una transazione) e rende **non
  sicuro** tornare indietro col server finché ne esistono righe (500 su
  `/api/inbox`): la voce di deploy dirà cosa cancellare prima di scendere.
- **Ordine**: server (migrazione), poi worker col controllo d'inattività, poi
  caddy. Gli interruttori restano spenti fino al rollout del §8.
- **Rollback del worker**: il worker vecchio riprende l'aggiornamento a ogni
  push solo se gli interruttori sono accesi: tenerli spenti prima di scendere.

## 10. Fuori perimetro

- La generazione Docs completa (cambia solo per la quota, §4.4).
- Review delle PR, fix, chat: cambiano solo per la quota (§4).
- Posta, pulse, brief settimanale: non sono operazioni sui commit; seguono la
  quota (§4) ma non entrano nel giro notturno.
- Un «ripristina» delle pagine o una UI per la coda del giro.
