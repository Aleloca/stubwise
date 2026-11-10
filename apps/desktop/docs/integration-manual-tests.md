# Integrazione aree 2 e 3 — prove a mano (10 nov 2026)

Le prove che i test automatici non fanno: il giro vero sul Mac, il mouse e la
tastiera, l'aspetto delle pagine, il server vero con dati veri. Raccolgono le
sezioni «Da provare a mano» delle quattro fette
(`integration-slice{1,2,3,4}.md`), messe in ordine per superficie.

Ogni prova dice cosa fare e cosa deve succedere. Se qualcosa non torna, basta
annotare la prova e cosa si è visto: il resto lo ricostruiamo noi.

## Preparare l'istanza di prova

1. **Il codice di questo branch** (`feat/integrazione-area2-fetta4`, che
   contiene le fette 1–4) su un'istanza di prova, non in produzione.
2. **Server e caddy di questo branch**: `docker compose up -d --build server`,
   aspettare che il server sia healthy (applica le migrazioni fino alla
   0121), poi `docker compose up -d --build caddy`. Caddy serve l'app nuova su
   `/app` accanto al web vecchio.
3. **L'app desktop**: sul Mac, `pnpm --filter @stubwise/desktop package:mac`.
   Il `.dmg` è in `apps/desktop/release/`. Non è firmato: al primo avvio
   tasto destro sull'app → «Apri».
4. **Due account** nella stessa istanza, membri dello stesso progetto:
   - **A**, Project Lead del progetto (e responsabile della Home del suo reparto);
   - **B**, Developer dello stesso progetto, nello stesso reparto.
   Utile anche un terzo account full admin, per le prove dei reparti.
5. **Lo storage S3 per gli allegati**: dal web vecchio, nelle impostazioni
   dell'istanza (Integrazioni → archiviazione). Senza, gli allegati
   rispondono «storage non configurato».
6. **Un po' di dati**:
   - qualche task con taglia e scadenza;
   - un paio di traguardi;
   - una richiesta di backlog creata dal web vecchio con urgenza «urgent»;
   - il brief settimanale e i daily report accesi su un progetto.

## Ingresso e login

**Web (`/app`)**
- Apri `<istanza>/app` senza sessione → la pagina di login. Entra con
  password e codice dell'app di autenticazione → atterri sulla **Home**.
- Con un account senza secondo fattore → al login ti chiede di configurarlo
  (QR, chiave, primo codice, codici di riserva una volta sola) → poi dentro.
- Un codice di riserva al posto del codice dell'app → entra, e il codice usato
  non vale più.
- Esci dal profilo → torni al login; il web vecchio sulla stessa istanza resta
  utilizzabile.

**Desktop (dmg)**
- Primo avvio → ti chiede l'indirizzo dell'istanza → «Sign in with your
  browser» → si apre il browser su `/app/#/desktop-login` → login → «Allow» →
  l'app torna in primo piano già dentro, sulla Home.
- Chiudi e riapri l'app → sei ancora dentro, senza rifare il login.
- Cambia la password dal web → l'app desktop ti chiede di rientrare.
- Guarda con calma l'aspetto delle pagine nuove: indirizzo dell'istanza e
  attesa, la conferma «Allow», la configurazione del secondo fattore.

## Tasks

- Apri un progetto → atterri sull'**Overview**; vai su Tasks → l'elenco
  coincide con quello del web vecchio.
- Filtri (stato, reparto, assegnatario, taglia, periodo, ferma) → l'indirizzo
  li conserva; ricaricando la pagina restano.
- Board: trascina una task in un'altra colonna → cambia stato subito; il web
  vecchio la mostra nello stato nuovo.
- Seleziona più task → azione in blocco (stato o assegnatario) → cambiano
  tutte; con B su una task che non può modificare → nessuna cambia.
- Timeline: le task in vista con i traguardi alla loro data.
- New task con titolo, reparto, taglia, settimana → compare in elenco e nel
  web vecchio.

## Dettaglio della task

- Apri una task → testata e campi: modifica stato, priorità, assegnatario,
  taglia, scadenza, settimana → il web vecchio vede le modifiche.
- Un link a una task che B non può vedere → «not found», senza dettagli.
- Commenti: scrivi, rispondi, modifica, elimina → il web vecchio vede lo stesso.
- Task collegate: aggiungi e togli; dall'altra task si vede il legame inverso.
- Allegati: carica un file vero, poi toglilo (serve S3).
- «Segui» e la ferma a mano («Mark as stalled» e «Not stalled»).
- Chiedi una decisione a B → B la trova in «Da decidere» e nell'inbox, la
  risponde → A vede la risposta nel feed.
- Il feed della task: cambi di stato, settimana, reparto e taglia, con i nomi
  delle persone. Una persona o un traguardo eliminati si leggono come
  «someone» / «a deleted milestone», mai come un codice.
- La sezione Claude: dice lo stato e le PR, con «Open in web»; niente azioni.

## Planning e La mia settimana

- Planning di progetto con A: trascina una task dalla vasca a B in questa
  settimana col **mouse**, poi un'altra con la **tastiera** («P», frecce,
  Invio) → la cella si aggiorna; B riceve l'avviso, che apre la task.
- Planning con B: le righe degli altri sono in sola lettura; B può prendere
  per sé una task non assegnata.
- Planning trasversale (`/planning`) per reparto → stesse regole. B, senza
  permesso di pianificare per altri in nessun progetto, viene riportato alla Home.
- Prova a mettere una task in una settimana passata dal menu «Plan» → il
  rifiuto dice perché, senza «Try again».
- La mia settimana (`/home?view=week`): metti una task in un giorno, poi
  toglila dal giorno, ricarica → resta dove l'hai messa.
- **Slittamento**: una task aperta pianificata la settimana scorsa → compare
  nella corrente col segno dello slittamento (×1). Lasciala aperta un'altra
  settimana → ×2.
- **Cambio di giorno**: tieni l'app aperta oltre la mezzanotte (anche dopo lo
  stop del Mac) → «In ritardo» e «Oggi» si aggiornano senza ricaricare; il
  lunedì la settimana corrente è la nuova.

## Home e filtri

- La Home mostra la Home del reparto: «Da decidere», «La mia settimana» e i
  blocchi dell'area 2; mai posta, calendario, automazioni o rilasci.
- «Customize» → aggiungi un blocco, nascondine uno, riordina col mouse e con
  la tastiera → salva → resta così. «Ripristina» → torna quella del reparto.
- Con A (responsabile della Home del reparto) → «Customize» propone anche la
  Home del reparto → cambiala → B, senza Home personale, la vede.
- Con B, che ha una Home personale → la riga «La Home del reparto è cambiata
  · Vedi le novità» → ti mostra i blocchi nuovi; la riga sparisce.
- Nella Home di reparto un filtro privato non si può mettere.
- Dalla pagina Reparti (full admin): dai ad A la gestione della Home → in A
  compare subito «Customize → reparto», senza riavviare.
- Tasks → «Save as filter» → privato o pubblico → lo trovi in «All filters»;
  modificalo ed eliminalo.
- Fissa un filtro nella colonna, poi toglilo.
- Metti un filtro come blocco della Home → elimina il filtro → il blocco resta
  e dice «non disponibile», con «Remove block».
- «Da decidere» → «Turn into task» su una richiesta → la task nasce collegata
  e la richiesta esce dall'elenco.

## Requests

- Requests del progetto → l'elenco coi codici `R<n>`, come il backlog del web
  vecchio. La richiesta «urgent» del web vecchio si legge «Urgent».
- Nuova richiesta su qualcosa che esiste già → dopo un'attesa visibile «Unita
  a R…» e si apre quella. Una richiesta davvero nuova resta nuova.
- «Fondi in…» → attesa della riscrittura → la destinazione ha il testo
  riscritto. Con il modello spento → errore, «Try again», niente cambiato.
- Metadati (urgenza, taglia, rischio e nota) e descrizione → il web vecchio
  li vede. Suggerimenti dell'intake → «Accetta» e «Scarta».
- Archivia, Riapri, Ripristina.
- Trasforma in task dal dettaglio → la richiesta diventa trasformata ed esce
  dagli elenchi da trasformare.
- «Rifinisci con Claude» c'è ma è spento (area 3).

## Overview

- Traguardi: crea, modifica, chiudi, riapri, elimina → le task del traguardo
  eliminato restano, senza traguardo.
- Registro decisioni: registra una decisione a mano, poi una che la
  «supera» → la prima si legge superata. Un ciclo di «superata da» non si
  può fare.
- Il brief settimanale c'è, etichettato come testo generato.
- Cronologia: «Show earlier» scorre le settimane e, oltre le quattro,
  carica la storia più vecchia; i traguardi futuri stanno in cima.
- Cosa è aperto e cosa è fermo: i numeri coincidono con Tasks.

## Tutti i progetti

- Il portafoglio col polso di ogni progetto (aperte, ferme, «aspetta te»,
  prossimo traguardo); fissa e sgancia un progetto.
- Le ferme di tutti i progetti, dalla più vecchia.
- L'attività per giorno, con «Show earlier» oltre le quattro settimane.
- Nuovo progetto con un codice già usato → l'errore sotto il codice, niente
  creato. Con il modello «Client» e un cliente → gli stati del modello e il
  modulo Docs; con «Software» → i quattro moduli.
- I progetti che c'erano già → Software, con i quattro moduli.

## Compatibilità con il web vecchio e il mobile

- **Web vecchio**:
  - liste, dettaglio dei ticket, backlog, traguardi e inbox funzionano come prima;
  - le viste salvate del web vecchio ci sono ancora (i filtri dell'app sono a parte);
  - una task creata o spostata dall'app ha lo stato giusto anche nel web.
- **App mobile**:
  - l'inbox si apre anche con gli avvisi nuovi della pianificazione (`planning.changed`, `task.assigned`);
  - liste e dettaglio funzionano come prima;
  - una richiesta creata dall'app nuova compare nel backlog.
- **Avvisi**: un avviso dell'app nuova (decisione chiesta, task spostata) arriva
  anche sul telefono e nel web vecchio.

# Area 3 — Claude come collega

Le prove dell'area 3 (fette 3a–3e, `integration-area3{a,b,c,d}.md`). Valgono
l'istanza e gli account A (Project Lead) e B (Developer) di sopra.

## Cosa serve in più

1. **Un account Claude nel worker**: dal web vecchio, Impostazioni → AI, un
   account o una chiave API attivi, e il budget del mese non esaurito. Senza,
   i lavori restano fermi in coda.
2. **Un repository di prova collegato al progetto**: piccolo, con i test che
   girano, e il token del provider che può aprire PR. Serve per le PR, le
   correzioni e «Chiedi modifiche».
3. **Un progetto col backlog acceso**: serve per il refinement.
4. Per lo standup: ad **A** (o a un ruolo) il permesso d'istanza «Vedere
   l'attività delle persone» (`people.activity.view`), dalla pagina dei ruoli.
5. Il worker aggiornato a questo branch (`docker compose up -d --build worker`
   dopo il server), senza lavori di Claude in corso al momento del riavvio.

## Sessioni dal vivo (web e desktop)

- **Pagina Claude**: apri Claude dal binario → atterri su «Working now» con
  le sessioni in corso dei progetti che vedi. Mancano «New conversation»,
  «Mine» e «Public»: la chat libera arriva dopo.
- **Una sessione**: aprila → il flusso si riempie mentre Claude lavora (le
  frasi crescono mentre le scrive, le azioni passano da «in corso» a
  fatte), senza ricaricare. Prova su `/app` e sul dmg.
- **Riconnessione dopo lo sleep**: con una sessione aperta sul Mac, chiudi il
  coperchio per qualche minuto e riaprilo → la sessione riprende da sola
  dal punto in cui era, senza messaggi doppi né buchi.
- **Rete giù**: spegni il Wi‑Fi qualche secondo e riaccendilo → stesso
  risultato.
- **Molte sessioni**: apri più di otto sessioni in schede o finestre → le
  ultime aspettano un posto; chiudendone una, parte la successiva.
- **Sessione invisibile**: con B, apri il link di una sessione di un progetto
  di cui B non è membro → «not found», nessun contenuto.
- **Sezione Claude della task**: apri una task su cui Claude ha lavorato →
  stato, piano, domande, PR col ciclo delle correzioni, storia del lavoro.
  «Follow here» la segue nel pannello della task, dal vivo.

## Avvio, rilancio, riprendi, chiedi modifiche

- **Avvia**: con A, su una task del progetto col repository, «Start» →
  parte il lavoro, la sezione dice che Claude è al lavoro, la sessione
  compare in «Working now».
- **Avvio di un operatore**: con B (Developer), avvia su una task col piano
  già salvato → il lavoro si ferma ad aspettare l'approvazione del piano.
- **Rilancia con indicazioni**: su un lavoro fallito o fermato, «Relaunch with
  instructions», scrivi due righe, «Relaunch» → nel web vecchio le indicazioni
  sono un commento della task, e il lavoro riparte tenendone conto.
- **Riprendi la correzione**: una correzione ferma (per esempio sul budget)
  → «Resume correction» la fa ripartire; se nel frattempo non è più ferma, la frase lo
  dice e non nasce un lavoro nuovo.
- **Chiedi modifiche**: su una PR aperta da Stubwise, «Request changes» con
  una nota → la stessa PR riceve un commit di correzione.
- **Rifiuti**: avvia mentre un lavoro è già in corso → «Claude sta già
  lavorando su questa task», e non parte niente.

## Piano

- **Approva**: con A, sulla scheda del piano in attesa (nella sessione,
  nella sezione o in «Da decidere») «Approve» → il lavoro riparte ed esegue.
- **Rifiuta con indicazioni**: «Reject», scrivi cosa cambiare → Claude
  riscrive il piano; le indicazioni sono un commento del team.
- **Pre-approva e revoca**: con A, su una task col piano salvato e il lavoro
  non ancora arrivato al piano, «⋯» → «Approve the plan in advance» → il lavoro non si
  fermerà ad aspettare; «Revoke the advance approval» toglie la pre-approvazione.
- **Chi non può**: con B, il piano si legge ma non ci sono «Approve» né
  «Reject»: la riga dice chi decide.
- **Piano cambiato**: tieni aperta la scheda del piano, fai riscrivere il piano
  da un'altra parte (rifiuta dal web vecchio con un'altra finestra), poi
  premi «Approve» sulla scheda vecchia → «il piano è cambiato dopo che l'hai
  letto: rileggilo», niente approvato.
- **Approvato da un altro**: tieni aperta la sessione su due account con
  `plans.approve`; approva da uno → sull'altro la scheda passa ad
  approvato senza ricaricare, e resta una sola.
- **Non deciso**: un lavoro annullato sul piano → la scheda dice «Non
  deciso», mai «approvato».

## Domande

- Claude fa una domanda (`ask_user`) → la trovi nella sessione, nella
  sezione Claude e in «Da decidere»; risponde chi l'ha avviata o chi ha
  `plans.approve`. Rispondi con un'opzione o col testo → il lavoro riparte.
- Rispondi a una domanda già risposta da un'altra parte → la frase dice che
  non è più aperta.
- Annulla un lavoro che aspettava una risposta → la domanda si legge chiusa
  e non si risponde più.

## Ferma e Annulla

- **Scrivere e Ferma**: in una sessione al lavoro, con A, scrivi un messaggio
  → Claude lo riceve al passo successivo. «Ferma» → l'agente si mette in
  pausa e aspetta; «Ferma e scrivi» lo ferma e riparte dal tuo messaggio.
- **Senza permesso**: con B, la sessione si legge ma non c'è la casella; la
  riga dice che scrive solo un maintainer.
- **Annulla un lavoro parcheggiato**: un lavoro in coda, fermo, in attesa del
  piano o di una risposta → «⋯» → «Cancel the work» → conferma → il lavoro si
  chiude come fermato; PR e branch restano come sono.
- **Annulla in esecuzione**: mentre Claude lavora, «Cancel the work» →
  la sezione dice «Annullamento in corso…» e, in un attimo, il lavoro si
  chiude; non c'è un secondo «Annulla».

## «Da decidere»

- Con A, nella Home: i piani da approvare e le domande di Claude
  compaiono accanto alle altre voci; decidere o rispondere da lì ha il
  tempo dell'«Undo» e poi parte davvero.
- Con B: i piani non ci sono (non può approvarli); le domande sì, solo
  quelle a cui può rispondere.

## Refinement

- Su una richiesta nuova, «Refine with Claude» → si apre la vista del
  refinement con la sessione; scrivi cosa vuoi chiarire → Claude risponde e
  scrive design, piano o metadati nella richiesta: l'esito compare con
  «See», che apre il lato sul pezzo aggiornato.
- Il web vecchio vede lo stesso design e piano nella voce di backlog; il
  piano scritto qui NON è approvato.
- «Close session» → la richiesta è pronta; riaprendo la vista, «Start new»
  c'è solo se la richiesta si può ancora rifinire.
- Con chi non può modificare le richieste: la vista si legge senza
  casella.

## Standup per persona

- Con A (col permesso), Tutti i progetti → Activity → «By person» → per
  ogni persona del giorno le task chiuse e spostate, i commenti, le
  decisioni, le richieste e i commit; il filtro per reparto restringe.
- I commit di un autore che non è un utente compaiono sotto «Commits from
  unlinked authors».
- Con `settings.manage`, «Rigenera i report di tutti i progetti di quel
  giorno» → i report si rigenerano tutti, la riga dice che si stanno
  generando e poi «pronto».
- Con B senza il permesso: la scheda «By person» non c'è.

## Claude assegnabile (quando arriva la 3e)

- Con A, assegna una task a Claude → parte il lavoro; Claude compare fra
  gli assegnatari, nel Planning e nel carico.
- Con chi non può avviare il lavoro di Claude: Claude non è fra gli
  assegnatari proposti.
- Claude non riceve mai avvisi né notifiche push.


## Chat con Claude (fette 1 e 2)

Servono il worker col runner in streaming (`AGENT_STREAMING`), un account AI
e due persone: A membro di AUD, B che non vede ACQ.

- Con A, /claude → la casella «New conversation» dice che Claude legge e non
  cambia niente; scrivi «A che punto è AUD-12?» → la conversazione nasce col
  titolo della domanda, Claude risponde citando stato e assegnatario veri;
  AUD-12 nel testo si apre.
- Chiedi «Crea una task in AUD per l'export PDF» → Claude dice che da qui non
  può e dove si fa; nessuna task nuova.
- Con B, chiedi di ACQ o di una sua task → Claude dice che non è visibile;
  nessun dato di ACQ nella risposta.
- «Mine» e «Recent» elencano solo le proprie; con un altro utente (anche
  full admin) l'indirizzo della conversazione di A risponde «non trovata».
- Rinomina, archivia (sparisce da Mine e Recent, si ritrova fra le
  archiviate; la casella non scrive più), ripristina, elimina.
- Archivia mentre Claude sta rispondendo → il turno si ferma.
- «Ferma» mentre risponde → si ferma; il messaggio dopo riparte.
- Su una task aperta, ⌘J → il riquadro col chip «task AUD-12»; chiedi «chi la
  segue?» → Claude risponde su quella task. ⌘K «Ask Claude…» con un testo →
  il testo è nella casella del riquadro, da mandare.
- Budget del mese esaurito (Amministrazione → AI sul web vecchio) → la
  casella si spegne con la frase del budget, nella pagina e nel riquadro; un
  messaggio non parte.
- Il web vecchio e il mobile non vedono le conversazioni libere fra le
  sessioni degli agenti.

## Elimina task (fetta 3.0 della chat)

⚠️ Su un'istanza di prova, o col backup appena fatto: si eliminano dati veri.

- Con l'autrice (Legacy Member, `tickets.edit`) di una task: «⋯» → **Delete
  task…** → il dialogo dice codice e titolo, «This can't be undone», cosa resta;
  **Delete** → il pannello si chiude, il toast dice «… was deleted», la riga non
  c'è più; per codice (`?task=`) e nella ricerca non si trova.
- Con un altro Legacy Member: la voce è spenta con «Only its author or someone
  who can moderate…» e **Who?**. Con un Developer (`tickets.moderate`) si elimina.
- Una task con Claude al lavoro o con una PR aperta: il dialogo lo dice e
  **Delete** è spento.
- Una task madre: le figlie restano, senza madre; i collegamenti spariscono
  anche dall'altra task.
- Una task nata da una richiesta: la richiesta dice «La task … è stata
  eliminata». Una task nuova nel progetto non riprende il codice.
- Chi seguiva la task riceve «la task è stata eliminata»; le sue notifiche
  vecchie su quella task restano, col codice in testo, e non si aprono (anche
  dal web vecchio e dal mobile: nessun 404 cliccandole dal desktop; dal web
  vecchio la card non ha più il link).
- Lo standup del giorno elenca la task eliminata a chi l'ha eliminata.

## Conversazioni pubbliche e continuazione (fetta 5 della chat)

Servono due persone con `claude.public.view` (il preset User lo ha): A membro
di AUD e di MKX, B membro di AUD che non vede MKX.

- Con A, una conversazione che legge AUD-12 → «Make public» → il dialogo dice
  AUD fra i progetti letti o toccati e che chi legge vedrà anche ciò che Claude
  ha letto per lei; **Make public, I'm responsible** → la testata dice
  «Public · made public by A». Una conversazione senza progetti apre lo stesso
  il dialogo («Claude didn't use any project.»).
- Con B, «Public» la elenca con l'autrice; aprendola: si legge, niente casella
  per scrivere, niente «Make private», niente bottoni sulle schede di Claude.
- Con A, chiedi di MKX nella pubblica → per B il seguito resta privato (la riga
  e la conversazione dicono «il resto è privato», nessun MKX nel testo, anche
  dal vivo); per A la fascia «New messages are private: Claude used MKX» →
  **Review and share** elenca solo MKX → condiviso, B riceve il seguito una
  volta sola, senza ricaricare.
- Con B, scrivi nella casella «Continue in your own conversation…» → nasce la
  sua conversazione privata, l'originale in testa in sola lettura; chiedi di
  MKX-… citato nell'originale → Claude non lo vede (B non vede MKX). A non vede
  la conversazione di B.
- Con A, «Make private» → B non la trova più (404), la sua continuazione dice
  «The original conversation is no longer available.» e resta scrivibile.
- Il tema o la lingua che Claude cambia in una conversazione non ripartono
  ricaricando la pagina o da un'altra scheda: la riga dice «Not applied in this
  window» con **Apply** (review della F3.4).
