# Shape brief — Support e richieste dei clienti

Superficie: sezione di progetto **Support** (`#/p/<CODE>/support`,
conversazione aperta `#/p/<CODE>/support/<CODE>-S<n>`, widget
`#/p/<CODE>/support?view=widgets` **[A 1]**): elenco delle conversazioni
coi clienti per stato, dettaglio con la conversazione intera, la richiesta
nata, il compositore della risposta con «Bozza di Claude», «Anteprima del
cliente», «Scrivigli anche per email», «Apri la richiesta» su una non
conclusa; la vista **Widget** per chi ha `widget.manage`; il blocco Home
**Clienti in attesa**; la
provenienza nel pannello della richiesta. Piano 8a: Task 9 (dati: Task 2 e
6). Spec area 8: «Support e richieste dei clienti» (Il triage, Cosa
contiene una richiesta, Le email, Cosa vede il cliente, La sezione
Support), «Permessi», «Codici», «Stati», «Dati finti», «Quanto è vero nel
prototipo», Review Focus 7. Il compositore della Posta e la sua bozza sono
di `mail-compose.md`; il refine di una richiesta di `refine.md`. Mondo:
«Catalogo numerato», modalità **Operate**, con un tratto di **Read** (la
conversazione). **[A n]** = scelta del brief, **approvata dal maintainer
il 28 ott 2026**, numerata in fondo.

## 1. Lavoro e pubblico

- **Chi risponde**: chi ha `support.reply` nel progetto (Project Lead,
  Developer, Legacy Member; l'assistenza clienti con un ruolo che lo
  contiene). Apre Support perché un cliente aspetta, lo legge, risponde
  partendo dalla bozza di Claude.
- **Chi legge soltanto**: gli altri membri (Sara, Contributor): vedono le
  conversazioni e la richiesta nata, per capire **perché** il cliente la
  vuole, senza poter scrivere al cliente.
- **Chi trasforma**: chi ha `backlog.create` apre a mano la richiesta da
  una conversazione non conclusa (mai da un'email); chi ha `backlog.edit` la
  porta al refine (fuori da qui).
- **Chi configura**: chi ha `widget.manage` crea e modifica i widget del
  progetto e copia lo snippet per il sito.
- **Quando**: entrando da «Clienti in attesa» in Home, da un avviso
  (`support.customer_replied`, `support.request`) o dalla sezione del
  progetto. Ritmo: **smistare** (chi aspetta noi?) e **rispondere bene**
  (con la richiesta e lo stato a vista, senza ricostruirli).
- **La fatica vera** (spec, «Perché» 4): le richieste arrivano mezze vuote
  e il team deve tornare dal cliente. Qui la richiesta arriva già col
  desiderio riscritto **e** la conversazione che lo prova.

## 2. Esito e prova

- Azione primaria: rispondere a un cliente che aspetta, in pochi
  secondi, partendo dalla bozza di Claude riletta e inviata da una
  persona.
- Successo: a 1440×900, aprendo Support, le conversazioni che **aspettano
  noi** sono in cima e riconoscibili senza leggere; aprendone una, in alto
  c'è **cosa vuole il cliente** (il desiderio riscritto, con il codice della
  richiesta), sotto la conversazione, in fondo la casella; un clic su
  «Anteprima del cliente» mostra **esattamente** cosa vede lui adesso.
- Verità del prodotto:
  - **Nessuna risposta parte da sola**: la bozza di Claude è una bozza;
    parte solo dal clic su «Invia» di chi ha `support.reply`.
  - **Nessuna email automatica al cliente**, nemmeno di solo avviso.
    «Scrivigli anche per email» apre il compositore della Posta con una
    bozza: la manda una persona, dalla sua casella.
  - **Il cliente vede solo il suo**: stato in parole e messaggi suoi e
    nostri; mai nomi del team, commenti interni, stime, bozze.
  - **Una richiesta non nasce MAI da un'email**, né da sola né a mano
    (decisione del maintainer, 28 ott 2026): nascono solo dai canali col
    triage (widget, Claude Code/MCP e simili).
  - **Una conversazione abbandonata non apre niente**: resta «Non
    conclusa» finché una persona non apre la richiesta a mano.

## 3. Direzione scelta

- **Tesi**: Support è uno **sportello a protocollo**, gemello della Posta.
  Stessa topologia a due colonne (elenco · lettura), stesse righe a più
  linee, stessa colonna di lettura; ma qui ogni conversazione **ha un
  codice** (`ACQ-S3`, spec «Codici»: si cita al team, al contrario di
  un'email personale) e l'elenco è **raggruppato per stato**, non
  cronologico: la domanda della pagina è «chi aspetta noi?».
- **In testa al dettaglio, la richiesta; sotto, le prove.** Il desiderio
  riscritto sta in alto come un'intestazione di scheda (non come un
  messaggio), la conversazione sotto è la sua documentazione. È la stessa
  gerarchia che ha la richiesta vista dal backlog: testo riscritto sopra,
  conversazione apribile sotto.
- **Topologia** (binario 64 · colonna del progetto 240 · area di lavoro):
  - **Testata della pagina**: h1 «Support» (28px, unico titolo) e, a
    destra, per chi ha `widget.manage`, un selettore a due voci
    «Conversations · Widgets (2)» (gettoni, quello corrente con tinta
    ink 10%) **[A 1]**. Senza `widget.manage` il selettore non c'è.
  - **Elenco** (380px fissi, filetto a destra, come la Posta): barra 40px
    con «Search conversations» e il menu a gettone **Channel ▾** (Any ·
    Widget · Claude Code); poi i gruppi con intestazione
    `heading-group` e conteggio: WAITING ON US · IN TRIAGE · NOT CONCLUDED
    · REQUEST OPEN · REPLIED **[A 2]**; gruppi vuoti nascosti; dentro un
    gruppo, la più vecchia attesa in alto per «aspettano noi», la più
    recente in alto per gli altri.
  - **Dettaglio** (il resto, colonna di lettura fino a 760px, 32px di
    margine): testata, blocco della richiesta, conversazione, casella.
  - **Anteprima del cliente**: pannello agganciato a destra 360px
    (`detail-panel`, filetto a sinistra, nessuna ombra) che stringe la
    colonna di lettura **[A 3]**.
- **Riga di conversazione** (64px, due linee):
  1. Punto «ti aspetta» (ink pieno 8px) solo su «aspettano noi» e solo per
     chi ha `support.reply` · codice tnum 600 · nome del cliente (600 se
     aspetta noi) · glifo del canale 14px con nome accessibile · a destra
     ora tnum dell'ultimo messaggio («10:42», «Oct 22»).
  2. 12px: stato in parole (vedi §5) · inizio dell'ultimo messaggio in
     `ink-muted` con ellissi, preceduto da chi l'ha scritto se non è il
     cliente («You: …», «Assistant: …», «Laura: …»). Su «aspettano noi»,
     al posto dell'ora a destra: «waiting 3 h» tnum, in `warning` con
     icona oltre le 24 h **[A 4]**.
- **Testata del dettaglio**: codice tnum + nome del cliente in `headline`
  20px (va a capo per intero); sotto, riga 13px: canale («Widget ·
  Acquaviva site», «Claude Code»), indirizzo del cliente se c'è,
  «started Oct 21», stato in parole. A destra: **Customer preview**
  (secondario) · «Follow» / «Following» · «⋯»: Copy link · Write to them
  by email · le voci **Simulate …** sotto un separatore con l'etichetta
  «Prototype only» (Simulate a customer message · Simulate: customer
  leaves · Simulate: triage done).
- **Blocco della richiesta** (sotto la testata, scheda 1px `rule-strong`,
  raggio 8px, nessuna ombra, come la `MailProposalCard`):
  - con richiesta: riga 12px `heading-group` «REQUEST» · codice tnum +
    titolo (link alla richiesta in `#/p/<CODE>/requests?request=…`) ·
    stato interno della richiesta (`RequestStatusLabel`); sotto, il
    **desiderio riscritto** in corpo 14px, chiuso a 6 righe con «Show
    all»; in fondo, riga 12px muted «The customer sees: **In
    evaluation**» (lo stato in parole di `customerStatus`) · «Confirmed by
    the customer, Oct 21 10:40».
  - in triage: «No request yet · the assistant is still asking» con
    l'anello tratteggiato piccolo (il segno di Claude al lavoro).
  - non conclusa: «No request · the customer left before confirming» e,
    con `backlog.create`, **Open the request** (primario); senza:
    nessun bottone e «Someone with permission to create requests can
    open it.» **[A 5]**.
- **Conversazione**: messaggi come nella conversazione con Claude
  (`conversation.md`: niente bolle, avatar 24px, nome 600, ora tnum).
  Tre voci, distinte per forma e nome, mai solo per colore:
  - **cliente**: iniziale su tinta ink 6%, nome del cliente;
  - **assistente del triage**: avatar CL 16px e «Assistant (triage)»; il
    corpo 14px `ink-muted`; la domanda del «è questo?» con il desiderio
    proposto è citata con filetto a sinistra **[A 6]**;
  - **team**: avatar della persona, nome, e sotto 12px «Sent to the
    customer in the widget».
- **Casella della risposta** (in fondo, la stessa casella di
  `mail-compose.md` senza righe d'intestazione): riga 12px in testa
  «Reply to Mario Bianchi · in the widget» (o «· in Claude Code»); corpo
  14px; barra: **Claude's draft** (avatar CL + parola) a sinistra; a
  destra stato della bozza («Saved»), «Discard», **Send to customer**
  (primario pieno d'inchiostro, ⌘Enter).
- **Momento focale**: la bozza di Claude nella casella, sotto il desiderio
  riscritto in alto: chi risponde vede insieme cosa vuole il cliente e
  cosa gli stiamo per dire.

```
┌rail┬ACQ col──────┬list (380)─────────────────────┬reading─────────────────────────────────┐
│    │ ACQ         │ Support        [Conversations·Widgets 2]                               │
│    │ Acquaviva   │ ⌕ Search conversations [Channel▾]│ ACQ-S2 Mario Bianchi                 │
│    │ Overview    │ WAITING ON US 1               │ Widget · Acquaviva site · Oct 21 ·     │
│    │ Tasks       │● ACQ-S2 Mario Bianchi  ◫  3 h │ Waiting on us   Customer preview  ⋯    │
│    │ Requests    │  Waiting on us · Grazie, ma…  │ ┌ REQUEST ACQ-R14 Export bookings… ┐   │
│    │ Support   ● │ IN TRIAGE 1                   │ │ I need to export bookings to CSV │   │
│    │ …           │  ACQ-S4 Elena Neri  ◫   10:42 │ │ every Monday for accounting…     │   │
│    │             │  In triage · Assistant: Per…  │ │ The customer sees: In evaluation │   │
│    │             │ NOT CONCLUDED 1               │ └──────────────────────────────────┘   │
│    │             │  ACQ-S3 (no name) ◫     Oct 20│ (M) Mario Bianchi            10:31     │
│    │             │ REQUEST OPEN 1                │ Vorrei esportare le prenotazioni…      │
│    │             │  ACQ-S1 Luca Riva  ⌘   Oct 18 │ (CL) Assistant (triage)      10:32     │
│    │             │                               │ ┌ Reply to Mario Bianchi · in widget ┐ │
│    │             │                               │ │ Ciao Mario, l'abbiamo presa in▌    │ │
│    │             │                               │ │ [CL Claude's draft]  Saved [Send]  │ │
└────┴─────────────┴───────────────────────────────┴────────────────────────────────────────┘
```

## 4. Ambito e confini

- Dentro: elenco per stato con ricerca e canale; dettaglio; risposta con
  bozza di Claude; seguire una conversazione; anteprima del cliente;
  «Scrivigli anche per email»; «Apri la richiesta» su una non conclusa;
  widget (elenco, nuovo, modifica, snippet, guida, elimina); blocco Home;
  la provenienza nel pannello della
  richiesta; ⌘K per codice `<PRJ>-S<n>`; le voci «Simula …».
- Fuori: chiudere o archiviare una conversazione a mano, assegnarla a una
  persona, etichette, risposte salvate, allegati nelle risposte, unire due
  conversazioni **[A 7]**; il triage stesso (vive nel widget e nel server
  MCP, non qui: qui se ne vede l'esito).
- **Anti-obiettivi**: una risposta partita senza «Send to customer»; un
  avviso email al cliente che nessuno ha scritto; un'anteprima del
  cliente che mostra un nome del team, una bozza, una stima o un commento
  interno; una richiesta che nasce da un'email, in qualunque modo; una «non conclusa» che diventa richiesta da sola; la
  conversazione di triage che sembra scritta da una persona.

## 5. Stati e intervalli

- **Stato della conversazione** (`supportState`, sempre in parole, mai
  solo colore): *In triage* · *Request open* · *Waiting on us* · *Replied*
  · *Not concluded*. Regola di priorità **[A 2]**: con una richiesta,
  ultimo messaggio del cliente → *Waiting on us*; ultimo nostro (team) →
  *Replied*; altrimenti *Request open*. Senza richiesta: cliente andato →
  *Not concluded*, altrimenti *In triage*. Un messaggio del cliente
  arrivato su una *Not concluded* la riporta *In triage* (il triage
  riprende).
- **Stato per il cliente** (`customerStatus`): Received → In evaluation →
  Planned → In progress → Released, oppure «We're not going ahead». Nel
  dettaglio è una riga di testo; nell'anteprima è una scala a cinque passi
  (passo corrente in ink 600, passati `ink-muted` con spunta, futuri
  `ink-faint`), «We're not going ahead» la sostituisce.
- **Quantità**: 0–80 conversazioni per progetto; 1–200 messaggi; nome
  del cliente assente («Anonymous visitor», spec: identità dichiarata dal
  widget) o lunghissimo (ellissi in riga, a capo in testata); desiderio
  riscritto 1–2000 caratteri.
- **Conversazione lunga**: aperti gli ultimi 10 messaggi e i primi 3;
  in mezzo una fascia centrata «187 earlier messages» che li apre tutti,
  come la Posta **[A 8]**; il blocco della richiesta resta in testa.
- **Pagina**: caricamento (scheletro di righe e di colonna), vuoto («No
  customer conversations yet» + per `widget.manage` «Set up a widget»,
  per gli altri «Conversations start from the project's widget or from
  Claude Code»), vuoto filtrato («Nothing matches · Clear filters»),
  errore con «Try again», senza permessi / codice inesistente identici
  (R-G5: `ACQ-S99` e una conversazione di un progetto invisibile danno la
  stessa pagina «not found»).
- **Bozza di Claude**:
  1. Se la conversazione ha già una `claudeDraft`, la casella si apre
     **vuota** con sopra una riga 12px: avatar CL + «Claude prepared a
     draft» · **Use draft** · «Show» (la apre in sola lettura nella riga)
     **[A 9]**. «Use draft» la mette nel corpo; con testo già scritto
     chiede «Replace your text or add Claude's draft below it?» come la
     Posta.
  2. «Claude's draft» (⌘J) la rigenera in streaming nel corpo, con
     «Stop», come `mail-compose.md` §5; a fine, riga «Draft by Claude from
     the conversation and ACQ-R14 · edit it before sending». Nessuna
     indicazione facoltativa qui **[A 10]**.
  3. Errore: «Claude couldn't write a draft. Your text is unchanged.» +
     «Try again».
- **Invio**: «Send to customer» chiude il corpo; il messaggio compare in
  fondo come mio con «Sending…»; avviso «Sent to Mario Bianchi · Undo»
  per 5 s, come la Posta **[A 11]**; poi «Sent to the customer in the
  widget». Fallito: «Not sent · Retry · Edit», testo intatto, mai un nuovo
  tentativo da solo. Corpo vuoto: Send disattivato con il perché nel
  `title`.
- **Il cliente non è più sul sito**: sotto la casella, riga 12px muted
  «Mario last saw the conversation 2 days ago. They'll see your reply
  when they come back.» + **Write to them by email** (se c'è
  `customer.email` e chi guarda ha una casella Google collegata) **[A
  12]**. Senza indirizzo: la voce resta nel «⋯» disattivata con «The
  customer didn't leave an email address»; senza casella collegata:
  «Connect your Google account to write from Stubwise» + link.
  «Write to them by email» apre la Posta in nuova email (`mail-compose.md`,
  `#/mail?compose=new`) con A = indirizzo del cliente, oggetto «About your
  request ACQ-R14» e il corpo riempito dalla bozza di Claude con la riga
  «Draft by Claude · edit it before sending». Non invia nulla, non tocca la
  conversazione di Support.
- **Canale Claude Code** (richiesta dal server MCP): risposta uguale, riga
  «Reply to Luca Riva · in Claude Code»; sotto: «They'll see it the next
  time they ask about their requests.»
- **Senza `support.reply`** (Sara): nessuna casella, nessuna bozza, nessun
  «Write to them by email»; al posto della casella una riga 12px muted
  «Only people who can reply to customers write here.» Il resto si vede.
- **Seguire**: «Follow» aggiunge chi guarda a `followerIds` (avviso
  obbligatorio `support.customer_replied` a ogni nuovo messaggio del
  cliente); chi risponde segue da sé al primo invio **[A 14]**.
- **Cambio di persona** con un dettaglio aperto: la casella si chiude
  salvando la bozza della persona di prima; se la nuova non vede il
  progetto, «not found» (R-G5); se non ha `support.reply`, la riga al
  posto della casella.
- **Anteprima del cliente** (pannello 360px): titolo «What Mario sees» +
  «Updates live» 12px; la scala degli stati; i messaggi solo cliente e
  «Acquaviva» (il nome del widget, mai la persona) con la stessa forma del
  widget; in fondo 12px faint «Internal comments, names, estimates and
  drafts are never shown.» Esc o ✕ chiude, il fuoco torna al bottone.
- **«Apri la richiesta»** (non conclusa): dialogo con progetto fisso,
  **Title** e **Description** precompilati dal desiderio che il triage
  stava proponendo (se c'era) o vuoti, e la riga «The conversation (12
  messages) will be attached to the request.»; **Create request**. Esito:
  il blocco della richiesta si riempie, lo stato diventa *Request open*,
  toast «ACQ-R15 created». Doppio clic: una richiesta sola.
- **Provenienza nel pannello della richiesta** (`RequestDetail`, sezione
  nuova sotto la descrizione): `heading-group` «WHERE IT COMES FROM» ·
  «From the widget · Mario Bianchi · ACQ-S2» (link alla conversazione) /
  «From Claude Code · Luca Riva»; sotto **Show the conversation (14 messages)** che la apre
  sul posto, chiusa di default, in sola lettura, stessa forma della
  conversazione di Support **[A 15]**.

## 6. Interazione e layout

- **Widget** (`?view=widgets`, solo `widget.manage`): elenco a righe 48px
  (nome · stato «On» / «Off» in parole · «12 conversations» tnum ·
  «Edit»), «New widget» primario in testa. Nuovo e Modifica nel pannello
  agganciato a destra (480px) con i campi del web (`widgets-section.tsx`:
  nome, acceso, fonti della documentazione, titolo, messaggio di
  benvenuto, istruzioni, colore, lingua, tetti giornalieri di messaggi e
  richieste) **[A 16]**; sotto, per un widget salvato, **Snippet** (testo
  in monospace consentito come codice, «Copy snippet») e **Guide** («Copy
  guide» · «Download .md»). «Delete widget» in fondo, rosso solo come
  testo `critical`, con conferma in linea «Delete Acquaviva site? Its
  conversations stay.» · **Delete**. Vuoto: «No widgets yet» + «New
  widget».
- **Blocco Home «Clienti in attesa»** (`waitingCustomers`, nel catalogo di
  chi ha `support.reply` in almeno un progetto; non nelle Home di default
  **[A 17]**): righe 44px dalla più vecchia attesa: codice del progetto,
  codice della conversazione, cliente, «waiting 3 h» (in `warning` con
  icona oltre 24 h), inizio dell'ultimo messaggio; tetto e «Show all N»
  del `Capped` esistente; clic → il dettaglio. Vuoto: «No customer is
  waiting».
- **Avvisi**: `support.customer_replied` (codice `ACQ-S2`, «Mario Bianchi
  replied») → il dettaglio; `support.request` (codice `ACQ-R14`, «New
  request from the widget») → la richiesta.
- **Tastiera**: J/K nell'elenco, Enter apre; R porta il fuoco nella
  casella; ⌘Enter invia; ⌘J bozza di Claude; ⌘. ferma; P apre o chiude
  l'anteprima del cliente **[A 20]**; Esc chiude anteprima, poi casella;
  ⌘K trova `ACQ-S2` e le azioni «New widget».
- **Fuoco e ritorno**: dopo l'invio, al messaggio inviato; chiusa
  l'anteprima, al bottone; dopo «Open the request», al codice della
  richiesta nel blocco.
- **Finestra stretta** (sotto ~1100px): elenco e dettaglio uno per volta,
  «← Conversations» in testa al dettaglio; l'anteprima del cliente
  sostituisce il dettaglio con «← Back».
- **Movimento**: pannello dell'anteprima 200ms da destra; nuovo messaggio
  del cliente (simulato) entra con dissolvenza 150ms; nulla con movimento
  ridotto.

## 7. Accessibilità

- Elenco come `listbox` raggruppato; ogni riga legge codice, cliente,
  canale, stato e «waiting 3 hours».
- Il punto «ti aspetta» ha testo per lettori di schermo («Waiting on
  you»); i tre autori della conversazione si distinguono dal nome letto,
  non dall'avatar.
- Un nuovo messaggio del cliente è annunciato `polite`; «Not sent»
  `assertive`; lo streaming della bozza come `mail-compose.md` §7.
- L'anteprima è un `complementary` con titolo; la scala degli stati è un
  elenco ordinato con «current step».

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| pagina | Support · Conversations · Widgets · Search conversations · Channel · Widget · Claude Code | Support · Conversazioni · Widget · Cerca nelle conversazioni · Canale · Widget · Claude Code |
| stati | In triage · Request open · Waiting on us · Replied · Not concluded · waiting {{time}} | In triage · Richiesta aperta · Aspetta noi · Risposta inviata · Non conclusa · in attesa da {{time}} |
| cliente | Received · In evaluation · Planned · In progress · Released · We're not going ahead · The customer sees: | Ricevuta · In valutazione · Pianificata · In lavorazione · Rilasciata · Non procediamo · Il cliente vede: |
| richiesta | Request · No request yet · the assistant is still asking · No request · the customer left before confirming · Open the request · The conversation ({{count}} messages) will be attached to the request. · Create request | Richiesta · Ancora nessuna richiesta · l'assistente sta facendo domande · Nessuna richiesta · il cliente se n'è andato prima di confermare · Apri la richiesta · La conversazione ({{count}} messaggi) sarà allegata alla richiesta. · Crea richiesta |
| conversazione | Assistant (triage) · Sent to the customer in the widget · {{count}} earlier messages · Follow · Following | Assistente (triage) · Inviata al cliente nel widget · {{count}} messaggi precedenti · Segui · Segui già |
| risposta | Reply to {{name}} · in the widget · in Claude Code · Claude prepared a draft · Use draft · Show · Claude's draft · Send to customer · Sent to {{name}} · Undo · Not sent · Only people who can reply to customers write here. | Rispondi a {{name}} · nel widget · in Claude Code · Claude ha preparato una bozza · Usa la bozza · Mostra · Bozza di Claude · Invia al cliente · Inviata a {{name}} · Annulla · Non inviata · Qui scrive solo chi può rispondere ai clienti. |
| email | Write to them by email · {{name}} last saw the conversation {{time}}. They'll see your reply when they come back. · The customer didn't leave an email address · About your request {{code}} | Scrivigli anche per email · {{name}} ha visto la conversazione l'ultima volta {{time}}. Vedrà la risposta quando torna. · Il cliente non ha lasciato un indirizzo email · Sulla tua richiesta {{code}} |
| anteprima | Customer preview · What {{name}} sees · Updates live · Internal comments, names, estimates and drafts are never shown. | Anteprima del cliente · Cosa vede {{name}} · Si aggiorna da sola · Commenti interni, nomi, stime e bozze non si vedono mai. |
| home | Customers waiting · No customer is waiting | Clienti in attesa · Nessun cliente in attesa |
| prototipo | Prototype only · Simulate a customer message · Simulate: customer leaves · Simulate: triage done | Solo nel prototipo · Simula un messaggio del cliente · Simula: il cliente se ne va · Simula: triage concluso |

## 9. Vincoli

- Le pagine leggono solo da `data/queries.ts` (`listSupportConversations`,
  `getSupportConversation`, `customerPreview`, `listWaitingCustomers`,
  `listWidgets`); permessi e stati vengono dal livello dati
  (`supportState`, `customerStatus`, visibilità di `claudeDraft`), il
  client non li deduce.
- `replyToCustomer` non scrive mai in `state.mailMessages`;
  `emailDraftFor` apre una bozza e non invia; `openRequestFrom` vuole
  `backlog.create`. Nessuna funzione crea una richiesta da un'email.
- Componenti riusati: la casella e lo streaming di `mail-compose.md`
  (`Composer`, `useComposerDraft` col bug «Salvato» corretto dal Task 1),
  la forma dei messaggi della conversazione con Claude, la scheda della
  `MailProposalCard`, `BlockSection` e `Capped`, `RequestStatusLabel`,
  `PageEmpty`/`PageError`/`PageSkeleton`, la `Toast` con azione.
- Ogni «Simula …» è sotto l'etichetta «Prototype only».
- Orologio `now()` dello store (attese, «last saw», finestra dell'Undo).

## Scelte del brief da confermare

Ogni voce è una **[scelta del brief]**, non scritta nello spec,
**approvata dal maintainer il 28 ott 2026** (le voci tolte restano
numerate come «tolta», perché i numeri non cambino).

1. Widget come seconda vista della sezione (`?view=widgets`, selettore
   «Conversations · Widgets» accanto all'h1), non come route figlia.
2. Elenco raggruppato per stato (Aspetta noi, In triage, Non concluse,
   Richiesta aperta, Risposta inviata) e la regola di priorità degli
   stati; un messaggio del cliente su una «non conclusa» la riporta in
   triage.
3. Anteprima del cliente come pannello agganciato 360px, non dialogo.
4. «in attesa da» in `warning` oltre le 24 ore.
5. Senza `backlog.create`, su una non conclusa nessun bottone, solo la
   riga che dice chi può aprirla.
6. Il triage ha voce propria («Assistente (triage)», avatar CL, testo
   attenuato).
7. Fuori: chiudere/assegnare/etichettare conversazioni, risposte salvate,
   allegati nelle risposte.
8. Conversazioni lunghe: aperti i primi 3 e gli ultimi 10, il resto in
   una fascia.
9. La bozza già pronta di Claude non riempie la casella: «Usa la bozza»
   la mette nel corpo.
10. «Bozza di Claude» senza indicazione facoltativa (al contrario della
    Posta).
11. Invio con «Annulla» di 5 s, come la Posta.
12. «Scrivigli anche per email» sotto la casella (e nel «⋯»), con oggetto
    «Sulla tua richiesta <codice>»; serve una casella Google collegata.
13. *Tolta (28 ott 2026)*: non esiste un canale Email in Support, perché
    una richiesta non nasce da un'email.
14. Chi risponde segue la conversazione da sé al primo invio.
15. Nel pannello della richiesta, sezione «Da dove nasce» con la
    conversazione apribile sul posto.
16. I campi del widget sono quelli del web (più di `SupportWidget` del
    piano: nome, origini, saluto) — da allineare al modello del Task 2.
17. «Clienti in attesa» nel catalogo, non nelle Home di default.
18. *Tolta (28 ott 2026)*: «Crea richiesta» nella Posta non esiste.
19. *Tolta (28 ott 2026)*: nessuna richiesta da un'email, quindi nessun
    thread reso leggibile ai membri.
20. Scorciatoie: R casella, ⌘Enter, ⌘J, ⌘., P anteprima.
