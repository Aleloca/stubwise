# La posta si legge per conversazione

**Data**: 14 settembre 2026
**Origine**: test manuali dell'App M3 sul telefono del maintainer, 13-14 set 2026
**Stato**: design approvato a sezioni dal maintainer

## Perché

Aprendo una email che fa parte di uno scambio, in Stubwise si vede **un
messaggio solo**. Gli altri, se ci sono, sono righe separate nella stessa
lista; se non ci sono — perché l'ammissione li ha scartati — non esistono
affatto. E l'unico modo di leggere il resto è il bottone «Mostra l'originale»,
che restituisce il corpo grezzo con dentro tutta la catena citata: corretto,
perché l'originale esiste apposta per mostrare ciò che l'estratto toglie
(`extractRawBody` non chiama `stripQuotedAndSignature`, e il suo docblock lo
dice), ma illeggibile — un blocco unico in cui non si capisce dove finisce una
email e comincia la precedente.

Sono tre sintomi di una cosa sola: **in Stubwise il thread non esiste come
oggetto**. `email_messages.thread_id` c'è ed è `NOT NULL` fin dalla fase 6, ma
non è esposto in nessuno schema di risposta e nessuna query ci raggruppa
sopra.

Sui dati veri, al 14 settembre 2026: 107 thread, di cui 3 con più di un
messaggio (uno da tre, due da due). Quei tre hanno generato **una proposta per
messaggio** — il sintomo che il maintainer descrive come «vengo inondato»,
già presente in produzione.

E c'è un secondo fastidio, indipendente ma dello stesso giro: ogni tap su
«Mostra l'originale» ri-scarica il messaggio da Google. Si esce dalla
schermata, si rientra, e lo ri-scarica. Nessuna cache, da nessuna parte.

## §1 — La cache del corpo originale

`GET /api/me/mail/:source/:id/original` oggi rinfresca il token, chiama
`getMessageFull` e sanifica l'HTML per quella sola risposta; niente viene
scritto. Lato client non c'è cache nemmeno di sessione (`useMailOriginal` è
una `useMutation`, il cui risultato muore con il componente).

**Tabella nuova `email_bodies`**, una riga per messaggio, `ON DELETE CASCADE`
da `email_messages`: la cache muore col messaggio, quindi la potatura non va
toccata per lei.

**Nessuna scadenza, e non è una svista**: un messaggio Gmail è immutabile —
una volta inviato non cambia più. L'unico modo in cui questa cache può
diventare falsa è che il messaggio sparisca da Gmail, e in quel caso la riga
padre se ne va comunque.

**Si conserva l'HTML GREZZO, sanificato a ogni lettura.** Decisione del
maintainer, e la ragione non è la sicurezza dello storage (l'HTML in una
colonna è dato, non viene eseguito, e verso il client esce sanificato in ogni
caso): è che il sanificatore può migliorare. Conservando il sanificato, ogni
riga resterebbe congelata alla versione del filtro che l'ha scritta, e
rimediare richiederebbe una colonna di versione più un ri-scaricamento da
Google. Conservando il grezzo, una correzione a `sanitizeEmailHtml` vale
retroattivamente su tutto ciò che è già in cache, senza migrazioni di dati.

⚠️ **Questo CAMBIA l'invariante «Il corpo HTML di un'email non si conserva
mai» (CLAUDE.md, fase 9)**, che va riscritta, non aggirata. La ragione
scritta lì non era la sicurezza: era che un corpo persistito diventa
un'affermazione implicita «questo è ciò che Stubwise ha letto», e per l'HTML
non è vero — nessun codice lo legge se non la persona che clicca. Quella
ragione regge ancora, ed è il motivo per cui la cache vive in una **tabella a
sé, dal nome esplicito**, e non in una colonna accanto a `text_excerpt`: il
testo dell'estratto è ciò che la classificazione ha letto davvero, questa è
una copia per chi legge. I due non vanno sullo stesso piano.

**La copy deve dire la verità.** Oggi la nota accanto al bottone promette che
il messaggio verrà chiesto a Google *adesso* — servita dalla cache sarebbe una
bugia. La risposta porta da dove viene il corpo, e la frase cambia di
conseguenza.

## §2 — Il thread entra intero

Quando l'ammissione fa passare un messaggio, il poller chiede a Gmail il
**thread intero** (`threads.get`, `format=full`: una sola chiamata che torna
tutti i messaggi col corpo, non una chiamata per messaggio) e inserisce i
fratelli che non ha già. I corpi restano capati come oggi (`capText`), quindi
un thread lungo non è un problema di spazio.

I fratelli entrano **marchiati**: colonna `admitted` su `email_messages`,
`true` per chi è passato dal cancello, `false` per chi è stato tirato dentro
come contesto. Da quella colonna discende tutto: chi può generare una
proposta, cosa compare nelle liste, come si comporta la potatura.

**Non è un valore nuovo di `status`**, di proposito: lo stato è un percorso
(`new → classified → proposed → …`) e un messaggio di contesto quel percorso
non lo fa mai — sarebbe uno stato che non è uno stato.

### Due conseguenze che vanno scritte, non dedotte

**La potatura della fase 6b si rompe da sola, in silenzio.** La regola oggi
dice: un messaggio è potabile quando ogni figlio `email_proposals` è terminale
e nessun figlio ha una notifica ancora aperta. Un messaggio di contesto **non
ha figli**, quindi soddisfa quella condizione banalmente — sarebbe il primo a
essere cancellato, portandosi via il contesto del thread che stiamo ancora
leggendo, e lasciando una conversazione con dei buchi. La potatura va legata
al **thread**: un messaggio di contesto è potabile solo quando lo è ogni
messaggio ammesso del suo thread.

**Il cancello dell'ammissione si allarga, di proposito.** La fase 6c ha
separato ammissione e attribuzione proprio per tenere fuori ciò che non è
lavoro. Scaricare il thread intero fa entrare anche messaggi che quel cancello
avrebbe scartato. È una decisione del maintainer e va dichiarata in
`CLAUDE.md` come tale, insieme al limite che la rende accettabile: **entrano
come contesto, mai come sorgente di proposte** — `admitted = false` non
diventa mai una card, in nessun percorso.

## §3 — Una proposta per RICHIESTA, non per messaggio

Solo l'**ultimo** messaggio di un thread può generare un'azione, e la genera
valutando tutto il thread, non se stesso. La classificazione legge l'ultima
email più i messaggi che la precedono, cappati agli ultimi — il costo di un
run non deve crescere con la lunghezza della conversazione.

Quando arriva una risposta su un thread che ha **già una proposta aperta**, la
classificazione riceve anche quella proposta e decide che rapporto ha il
messaggio nuovo con essa. Tre esiti, che a livello di dati sono due:

- **integra** e **sostituisce** → **una sola card**, riscritta con l'ultima
  comprensione. La differenza fra le due sta in ciò che la card *dice*, non in
  quante card esistono: in entrambi i casi la cosa da fare è una, e la
  versione precedente è superata.
- **richiesta nuova** → **una seconda card** sullo stesso thread, e la prima
  resta aperta. Deliberato: sono due cose da fare.

L'invariante che ne esce non è «un thread, una proposta» — è **una proposta
per richiesta**. Ed è proprio la distinzione che oggi manca: le tre card in
produzione sono tre messaggi, non tre richieste.

### I due paletti sul giudizio del modello

Qui il modello decide qualcosa che ha conseguenze visibili — può chiudere una
card che stavi per usare. Due regole lo limitano.

**Nessuna card sparisce in silenzio.** Una proposta superata si chiude con un
esito esplicito che dice *da cosa* è stata superata, resta leggibile fra le
gestite, e la card nuova dichiara di venire da lì. Se il modello sbaglia a
chiamarla «stessa richiesta», deve restare possibile accorgersene.

**La rivalidazione resta quella della fase 6.** Il modello può dire «è la
stessa richiesta», ma il ticket, il progetto e la data che nomina passano
dallo stesso controllo nel codice: un referente che non regge fa sparire
l'azione. Questa aggiunta non apre una scorciatoia intorno a quella dottrina.

## §4 — Cosa vede chi legge

**La lista mostra thread, non messaggi**, su entrambe le superfici: una riga
per conversazione — oggetto, ultimo mittente, data dell'ultimo messaggio,
quanti ne contiene — e aprendola si leggono tutti i messaggi in ordine,
ciascuno col suo mittente, la sua data e il suo corpo.

È anche ciò che dissolve il terzo sintomo: se il thread si mostra come una
lista di messaggi distinti, non serve più indovinare dove finisce una email
dentro un blocco citato. Il problema non era la citazione — era che la
conversazione arrivava come un muro di testo.

**App e web insieme.** Il web è la superficie che useranno gli operatori non
tecnici da fine ottobre; lasciare le due a dire cose diverse sulla stessa
casella è una divergenza che poi non si recupera.

### Il vincolo di compatibilità

`GET /api/me/mail` è letta da un'app **già installata**, e cambiarne la forma
la romperebbe — «verso l'app mobile solo cambi additivi» (CLAUDE.md). Le rotte
per thread nascono quindi **accanto** a quelle esistenti, non al loro posto:
la lista per messaggio resta viva e invariata (la usa anche il calendario, che
thread non ne ha), e app e web passano alle nuove.

## Cosa NON si fa

- **Non si tocca il calendario.** `calendar_events` non ha thread e resta
  esattamente dov'è, anche nella lista fusa `/api/me/mail`.
- **Non si inventa un parser che spacchi la catena citata** dentro un corpo.
  Sarebbe euristica su testo scritto da chiunque, e non serve: i messaggi
  separati li dà Gmail, già separati.
- **Non si tocca `stripQuotedAndSignature`.** L'estratto continua a togliere
  citazioni e firma per la classificazione: è giusto così, e ora il contesto
  che gli mancava arriva dal thread, non dalla catena citata dentro un singolo
  corpo.
