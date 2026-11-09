# Shape brief — Scheda di preparazione e blocchi Home di Posta e Calendario

Superfici: la **scheda di preparazione** dentro il dettaglio di un evento
con progetto (`#/calendar?...&event=<id>`, sezione del pannello, vedi
`calendar.md` §6 punto 11), il **riassunto della riunione** negli eventi
passati con trascrizione, e i due blocchi della Home **Important email**
(`importantMail`) e **Upcoming** (`upcomingEvents`). Piano: Task 10 e 11
(dati nel Task 6). Spec: area 6 «Scheda di preparazione», «Riunioni
registrate», «Home», «Permessi». Le proposte in «Da decidere» sono in
`home.md` (catalogo) e `mail.md` (la card). Mondo: «Catalogo numerato»,
modalità **Operate** con un tratto di **Read** (il riassunto). **[A n]** =
scelta del brief, elencata in fondo.

## 1. Lavoro e pubblico

- Chi arriva: il PM, il commerciale o lo sviluppatore che fra cinque
  minuti ha la riunione settimanale di AUD con il cliente, e la apre dal
  calendario o dalla Home. Ha un minuto. Vuole sapere cosa si è detto
  l'ultima volta, cosa è rimasto aperto, cosa è arrivato per email da
  allora, e se il progetto è in ritardo.
- Per i blocchi Home: la stessa persona la mattina, che vuole sapere se c'è
  qualcosa di nuovo e importante e cosa ha oggi (maintainer: «vedere se
  c'è qualcosa di nuovo e prepararsi agli impegni del giorno»).

## 2. Esito e prova

- Scheda — successo: in un minuto di lettura si risponde a «cosa abbiamo
  deciso l'ultima volta e l'abbiamo fatto?» senza aprire altro; ogni riga
  porta all'oggetto vero (conversazione, task, Overview).
- Verità del prodotto:
  - **le email sono solo quelle che vede chi guarda** (privacy
    `mailbox_owner`: nemmeno l'admin vede la posta di altri), quindi due
    persone alla stessa riunione vedono schede diverse;
  - il **riassunto** è testo generato, lo vede solo chi era alla riunione
    (partecipanti dell'evento in Stubwise), e si dice;
  - le **cose da fare** sono task e richieste vere del progetto, con il
    loro stato di **adesso** (aperta, chiusa, in ritardo), visibili a ogni
    membro;
  - lo **stato del progetto** sono gli stessi numeri e le stesse ferme
    dell'Overview, non un calcolo parallelo.
- Blocchi Home — successo: in 5 secondi so se c'è un'email importante non
  letta e qual è il prossimo impegno; un clic porta all'email o
  all'evento con la scheda.

## 3. Direzione scelta

- **Tesi**: la scheda è un **promemoria a tre voci** dentro il pannello,
  non una seconda Overview: tre sezioni corte, ognuna con un tetto, nello
  stesso ordine sempre — **Recent email · Last meetings · Project status**.
  Righe del kit (riga di conversazione, `TaskRow`, `StalledRow`, riga
  traguardo), nessuna card, nessun grafico.
- **Sequenza** nel pannello dell'evento, sotto i dettagli e separata da un
  filetto: intestazione `heading-group` PREPARE · codice e nome del
  progetto (link all'Overview) · riga di polso del progetto (la stessa
  formula dell'Overview, `pulseLine`) → **Recent email** → **Last
  meetings** → **Project status** → link «Open AUD overview».
- **Momento focale**: la prima riunione precedente, con le sue cose da
  fare e lo stato di ciascuna — un «In ritardo» in `critical` con la
  parola si legge per primo.

```
┌─ pannello evento (360–640px) ─────────────────────────┐
│ AUD Weekly with client                                │
│ Today · 15:00 – 16:00 · Every Friday                  │
│ [Join Google Meet]                                    │
│ Going?  [Yes] [Maybe] [No]   Add a note               │
│ AUD Audin 2.0 · Suggested by Stubwise      Change     │
│ …partecipanti, descrizione, promemoria…               │
│ ───────────────────────────────────────────────────── │
│ PREPARE  AUD Audin 2.0                                │
│ Waiting on you · 3 stalled · next: Launch · Nov 14    │
│ Recent email                                       3  │
│ ● Elena Rossi   Export CSV: new deadline   ▲ Due Oct 28│
│   Paolo Neri    Re: invoices batch           Oct 21   │
│ Last meetings                                         │
│ AUD Weekly · Oct 16          Summary · Generated text │
│ "We agreed to ship the export before the dialer…" more│
│  ▌AUD-91 Export CSV for invoices      In progress     │
│  ▌AUD-94 Send dialer mockups          Overdue · Oct 21│
│  ▌AUD-95 Update price sheet           Done            │
│ Project status                                        │
│ In progress 12 · Overdue 3 · Stalled 3                │
│ 12d ▌AUD-77 Onboarding mail   Waiting for the client  │
│ Launch 2.0  Nov 14 ▬▬▬▬▬▬░░░                          │
│ Open AUD overview →                                   │
└───────────────────────────────────────────────────────┘
```

## 4. Ambito e confini

- **Dentro**: scheda per eventi **futuri o in corso** con progetto di cui
  chi guarda è membro; per eventi **passati** con trascrizione la stessa
  posizione ospita «Meeting summary» + «Tasks from this meeting» (§6) **[A
  1]**; versioni per partecipante, membro non partecipante, non membro;
  stati della trascrizione; i due blocchi Home.
- **Fuori**: generare la scheda con l'AI (la scheda è composta da dati, il
  solo testo generato è il riassunto già scritto dalla trascrizione);
  ordine del giorno modificabile; note condivise della riunione;
  trascrizioni non Gemini; aprire la trascrizione dentro Stubwise (si
  apre su Google, avviso del prototipo).
- **Anti-obiettivi**: una scheda che rivela email di colleghi o il
  riassunto a chi non c'era; un riassunto che si confonde con un fatto
  (deve portare «Generated text» come il brief); un pannello lungo da
  scorrere più di due schermate.

## 5. Stati e intervalli

- **Recent email**: le conversazioni del progetto con un messaggio visibile
  a me, dalla più recente, **max 5** (`recentMail`); 0 → riga calma
  «No recent email with you about AUD». Riga: punto non letto (ink, 8px) ·
  mittente 600 (ellissi) · oggetto (ellissi) · segno d'importanza alta
  (glifo ▲ lineare + nome accessibile «Important», mai solo colore) ·
  scadenza «Due Oct 28» se c'è (`warning` con la parola se entro 2 giorni,
  `critical` «Overdue» se passata) · data tnum a destra.
- **Last meetings**: le riunioni passate del progetto, dalla più recente,
  **max 3** (`recentMeetings`). Per ognuna: titolo + data tnum; per chi ha
  partecipato il riassunto (3 righe poi «Read more» che espande in posto)
  con `GeneratedTag` («Generated text», lo stesso del brief); poi le **cose
  da fare** nate lì: `TaskRow` (striscia di reparto, codice, titolo) con lo
  stato in parole a destra: «Open», «In progress», «Done» (`positive` +
  ✓), «Overdue · Oct 21» (`critical`), «Request» per una voce del backlog
  ancora richiesta. Max 6 per riunione, poi «N more». Una riunione senza
  cose da fare: «No tasks came out of this meeting».
  - **Membro non partecipante**: vede titolo, data e cose da fare; nessun
    riassunto e nessuna frase che ne segnali l'esistenza; la riga non apre
    l'evento (non lo vede) **[A 2]**.
  - **Trascrizione in lettura**: al posto del riassunto, «Reading the
    transcript…» 13px muted.
  - **Trascrizione non raggiungibile** (`doc: "unreachable"`, seme):
    «Couldn't open the transcript document · Open in Google Docs» (avviso)
    — niente riassunto, e le cose da fare ci sono se nate da altre fonti,
    altrimenti «No tasks yet».
  - Nessuna riunione precedente: «No earlier meetings on AUD».
- **Project status**: riga di conteggi tnum come link all'elenco filtrato
  («In progress 12 · Overdue 3 · Stalled 3», ognuno → Tasks con filtro);
  poi le ferme più vecchie con `StalledRow` (**max 3**, «Show all» →
  Overview); poi i traguardi aperti con data e barra (`ProgressSection`
  in densità compatta, **max 2**); poi «Next due» con le prossime 3 task a
  scadenza (data tnum). Ogni sotto-parte assente se vuota; tutte vuote →
  «Nothing open on AUD».
- **Versioni**:
  - partecipante e membro: tutto;
  - membro non partecipante: tutto tranne i riassunti;
  - **non membro** (o progetto che non vedo): nessuna scheda e nessun
    segno «scheda» sul blocco evento; il pannello ha solo i dettagli
    dell'evento;
  - evento senza progetto: nessuna scheda; la riga progetto dice «No
    project · Choose» (`calendar.md`), e scelto un progetto di cui sono
    membro la scheda compare.
- **Caricamento**: scheletro per sezione con la forma vera (2 righe
  ciascuna); **errore** per sezione con «Retry» dentro la sezione, le altre
  restano. Cambio di persona («vedi come») con la scheda aperta: la scheda
  si ricarica per la nuova persona e, se non è più membro o non vede
  l'evento, il pannello passa a «This event isn't available».

## 6. Interazione e layout

- La scheda vive nel pannello di dettaglio (360px di partenza, la persona
  lo allarga fino a 640). A 360 ogni riga va su una linea con ellissi e i
  metadati a destra si riducono a uno (scadenza prima della data); da 480
  tornano entrambi. Nessuna versione «a pagina»: «Open AUD overview» è
  l'approfondimento **[A 3]**.
- Clic: riga email → `#/mail/<threadId>` (il pannello si chiude, la Posta
  si apre su quella conversazione); task → pannello della task (`?task=`,
  sostituisce l'evento; «Back to event» in testa al pannello riporta
  indietro) **[A 4]**; titolo di una riunione precedente (solo se la vedo)
  → quell'evento; conteggi e ferme come nell'Overview.
- **Evento passato con trascrizione** (partecipante): al posto di PREPARE
  la sezione `heading-group` MEETING SUMMARY · `GeneratedTag` · il
  riassunto intero · «Open the transcript» (avviso) · «From the email by
  Gemini, Oct 16» (link al messaggio in Posta) · poi **Tasks from this
  meeting** con le stesse righe di stato. Le proposte ancora aperte nate
  dalla trascrizione compaiono qui come la card di `mail.md` (conferma sul
  posto per chi può). Membro non partecipante: solo «Tasks from this
  meeting».
- **Segno della scheda**: sul blocco evento della griglia e sulla riga di
  «Upcoming», glifo lineare ⌸ con nome accessibile «Preparation
  available» e tooltip «Open to prepare»; mai colore.
- Movimento: «Read more» espande in 200ms; zero con riduzione del
  movimento.

### Blocco Home «Important email» (`importantMail`)

- Guscio `BlockSection` (titolo `headline`, conteggio tnum, azione
  «Open Mail» a destra). Contenuto: le email di importanza **alta non
  ancora aperte**, dalla più recente, **max 5** e «Show all N» → `#/mail?
  importance=high` **[A 5]**.
- Riga 44px su una linea: punto non letto · mittente 600 (160px, ellissi)
  · oggetto (ellissi) · codice progetto tnum (più di uno: il primo + «+1»,
  tutti nel tooltip con i nomi) · scadenza se c'è («Due Fri», `warning` /
  `critical` con la parola come sopra) · ora o data tnum a destra.
- Clic (o Enter): apre la conversazione in Posta, che la segna letta; al
  ritorno la riga non c'è più. J/K fra le righe come gli altri blocchi.
- **Vuoto**: «Nothing important» + frase «Important email you haven't
  opened shows up here.» **Account non collegato**: «Connect your Google
  account to see important email here» + «Connect» (scheda dell'area 5).
  **Scaduto**: le righe lette l'ultima volta + riga 12px `critical`
  «Connection expired · Reconnect». **Vecchio**: nella riga meta del
  titolo «Updated 12 min ago». **Errore**: «Couldn't load · Retry» dentro
  il blocco.
- Un'email in analisi non compare finché non è classificata alta; una
  senza progetto ma alta compare senza codice.

### Blocco Home «Upcoming» (`upcomingEvents`)

- Guscio `BlockSection`, azione «Open Calendar». Contenuto: gli eventi **da
  adesso a fine di domani** (`listUpcomingEvents`), raggruppati in TODAY e
  TOMORROW (`heading-group`); in ogni gruppo prima i «tutto il giorno»,
  poi per ora. Esclusi gli eventi rifiutati **[A 6]**. Max 8 righe, poi
  «Show all N» → Calendario, Day di oggi.
- Riga 44px: orario tnum «15:00 – 16:00» (o «All day»; in corso: «Now ·
  until 16:00» in 600) · codice progetto tnum (se c'è e lo vedo) · titolo
  (ellissi) · segni a destra: ⌸ scheda disponibile, «Not answered» per un
  invito senza risposta, glifo Meet; per l'evento in corso o che inizia
  entro 10 minuti, bottone «Join» (avviso del prototipo) **[A 7]**.
- Clic: `#/calendar?view=day&date=<giorno>&event=<id>` — il Calendario sul
  giorno con il pannello dell'evento aperto e la scheda a vista (il
  pannello scorre fino a PREPARE se l'evento è entro 2 ore) **[A 8]**.
- **Vuoto**: «Nothing else today or tomorrow». **Non collegato**,
  **scaduto**, **vecchio**, **errore**: come «Important email».
- Gli eventi passano nel tempo: un evento finito esce dal blocco
  all'aggiornamento successivo (orologio del prototipo).

## 7. Vincoli e decisioni aperte

- Dati solo da `data/queries.ts`: `getMeetingPrep`, `getMeetingSummary`,
  `tasksBornFrom`, `listImportantMail`, `listUpcomingEvents`. Lo stato del
  progetto riusa le funzioni e i componenti dell'Overview (`StalledRow`,
  `ProgressSection`, `pulseLine`, `GeneratedTag`), senza ricalcoli.
- Privacy: `canSeeMessage` decide le email (nessuna eccezione admin),
  `canSeeTranscript` il riassunto, `canSeeTask` le cose da fare; un
  progetto invisibile resta invisibile (R-G5).
- Il riassunto non entra nel registro decisioni: nel registro va solo ciò
  che qualcuno conferma, con testo da template.
- Accessibilità: ogni sezione è una `section` con `aria-labelledby`;
  stati in parole; il riassunto annuncia «Generated text» prima del testo.
- Lingue: «Last meetings» / «Riunioni precedenti», «Overdue» / «In
  ritardo»; le righe vanno a capo solo nel riassunto.

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| scheda | Prepare · Recent email · Last meetings · Project status · Open {{code}} overview | Preparati · Email recenti · Riunioni precedenti · Stato del progetto · Apri la panoramica di {{code}} |
| riassunto | Meeting summary · Generated text · Read more · Open the transcript · Tasks from this meeting | Riassunto della riunione · Testo generato · Leggi tutto · Apri la trascrizione · Task nate dalla riunione |
| trascrizione | Reading the transcript… · Couldn't open the transcript document | Lettura della trascrizione… · Non è stato possibile aprire il documento della trascrizione |
| stati task | Open · In progress · Done · Overdue · Request | Aperta · In corso · Chiusa · In ritardo · Richiesta |
| vuoti scheda | No recent email with you about {{code}} · No earlier meetings on {{code}} · No tasks came out of this meeting · Nothing open on {{code}} | Nessuna email recente con te su {{code}} · Nessuna riunione precedente su {{code}} · Nessuna task nata da questa riunione · Niente di aperto su {{code}} |
| segno | Preparation available | Scheda di preparazione disponibile |
| blocchi | Important email · Upcoming · Open Mail · Open Calendar · Today · Tomorrow | Email importanti · Prossimi appuntamenti · Apri la Posta · Apri il Calendario · Oggi · Domani |
| vuoti blocchi | Nothing important · Important email you haven't opened shows up here. · Nothing else today or tomorrow | Niente di importante · Qui compaiono le email importanti che non hai ancora aperto. · Nient'altro oggi e domani |
| altri | Now · until {{time}} · Join · Due {{date}} · Important | Ora · fino alle {{time}} · Partecipa · Scade {{date}} · Importante |

## Scelte del brief da confermare

1. **[scelta del brief]** La scheda di preparazione c'è solo per eventi
   futuri o in corso; un evento passato con trascrizione mostra invece
   «Meeting summary» e «Tasks from this meeting».
2. **[scelta del brief]** Un membro non partecipante vede **titolo e data**
   delle riunioni precedenti del progetto e le loro cose da fare, ma non il
   riassunto, non i partecipanti e non l'evento; nessuna frase gli dice che
   un riassunto esiste. Il titolo di una riunione di progetto è considerato
   noto quanto le task nate da lei. Da confermare per la privacy.
3. **[scelta del brief]** Nessuna versione «a pagina» della scheda: vive nel
   pannello (allargabile a 640px), l'approfondimento è l'Overview.
4. **[scelta del brief]** Aprire una task dalla scheda sostituisce l'evento
   nel pannello, con «Back to event» per tornare.
5. **[scelta del brief]** «Important email» mostra 5 righe, solo alte e non
   aperte; un'email aperta esce dal blocco.
6. **[scelta del brief]** «Upcoming» esclude gli eventi rifiutati e mostra i
   «tutto il giorno» in testa a ogni giorno; tetto 8 righe.
7. **[scelta del brief]** Bottone «Join» sulla riga solo per l'evento in
   corso o che inizia entro 10 minuti.
8. **[scelta del brief]** Il clic su un appuntamento porta al Calendario sul
   giorno (vista Day) con il pannello aperto, non apre il pannello sopra la
   Home.
9. **[scelta del brief]** Nelle Home nuove i due blocchi vanno subito dopo
   «My week»: prima «Upcoming», poi «Important email» (vedi `home.md`).
