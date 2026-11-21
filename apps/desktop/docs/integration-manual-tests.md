# Integrazione — prove a mano (aree 2 e 3: 10 nov 2026; aree 9 e 10: 20 nov 2026; area 11: 21 nov 2026)

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

# Aree 9 e 10 — amministrazione, accessi e Claude (20 nov 2026)

Le prove dei flussi che i test automatici coprono solo a pezzi. Si fanno
**sia nell'app desktop (dmg) sia nel browser su `/app`**: dove le due strade
differiscono, la prova lo dice.

## Cosa serve in più

- **Il codice di `feat/integrazione-area10`** su un'istanza di prova: server
  prima (migrazioni fino alla 0198), poi worker, poi caddy; il dmg rifatto da
  quel branch.
- **Tre account con il secondo fattore acceso** (app di autenticazione):
  - **A**: Project Lead di un progetto P (gestisce i membri);
  - **B**: Developer di P;
  - **C**: full admin, non membro di P.
- Un secondo progetto Q con un repository collegato e senza lavori in corso,
  da archiviare ed eliminare.
- Un plugin registrato nel registro d'istanza (per esempio `superpowers`).
- A con una casella Google collegata (per la prova della posta).

## La riconferma (quando chiede il codice, e perché)

Il codice si chiede prima di un'azione che dà accessi, crea un segreto o
tocca l'identità. Dopo un codice giusto, per 10 minuti non lo chiede più.

- Con A, Members di P → aggiungi B con un ruolo → il dialogo chiede il codice
  **nominando l'azione** → codice giusto → B è membro. Subito dopo cambia il
  ruolo di B → **non** chiede niente (dentro i 10 minuti).
- Aspetta 11 minuti, cambia di nuovo il ruolo → chiede il codice.
- Preferenze → Tokens → «Create token» → chiede il codice. Anche «Change
  password» e il cambio d'email di login lo chiedono.
- Rinomina un reparto, o cambia chi gestisce la sua Home → **nessun** codice.
  Aggiungi un permesso di progetto al reparto → il codice sì. Togli un
  permesso → no.
- 5 codici sbagliati di fila → «locked» per 15 minuti, anche col codice giusto;
  il campo è spento e lo dice in parole.
- **Desktop**: il codice si scrive dentro l'app (nessun browser). Dal web
  vecchio, cambia la password di A → l'app desktop chiede di rientrare, e la
  finestra dei 10 minuti riparte da zero.

## I segreti si vedono una volta

Dopo il salvataggio un segreto non si rilegge: al più le ultime 4 cifre.

- Preferenze → Tokens: crea un token → il valore si copia una volta; chiudi e
  riapri la sezione → c'è solo il nome, con date e ultimo uso.
- Preferenze → Claude Code: il comando d'installazione contiene un token
  nuovo, visto una volta; il token compare fra i Tokens.
- Preferenze → Security: rigenera i codici di riserva → si vedono una volta;
  «Done», o lasciare la pagina, li toglie dallo schermo.
- Amministrazione → People: link di reset della password di B, e un invito →
  il link si copia una volta; «Done» lo dimentica.
- Amministrazione → Webhooks: crea un webhook → il segreto di firma una volta;
  «Regenerate» ne mostra uno nuovo, una volta (e chiede il codice).
- AI → Providers, Git accounts, Storage: dopo il salvataggio la chiave o il
  token appare solo come «••••» con le ultime 4, mai intero.

## Archiviare, riaprire, eliminare (con i repository staccati)

- Con A, Settings di Q → **Archive** → l'anteprima dice cosa si ferma. Con un
  lavoro di Claude in corso su Q → non si archivia, e la ragione è in parole.
- Archivia Q → sparisce dalla colonna; All projects → **Archived** → la pagina
  di Q (sola lettura) → **Reopen** → Q torna com'era.
- Archivia di nuovo e **Delete**: va scritto il codice esatto, poi chiede il
  codice di riconferma → Q sparisce; il toast porta ad **Amministrazione →
  Repositories**.
- Lì il repository di Q è fra quelli **senza progetto**, con la data e da dove
  è stato staccato → **Link** a P → torna collegato. Prova anche **Delete**
  su un altro staccato.
- Registro delle modifiche d'istanza: le voci «project deleted» e
  «repository deleted». Una voce di Q archiviato porta alla sua pagina
  d'archivio.

## Plugin acceso per progetto

- Con A, Settings di P → **Plugins**: un plugin del registro è **spento** per
  P finché non lo accendi (il plugin base `stubwise` è sempre acceso, senza
  caselle).
- Accendi il plugin, spegni una sua skill → «Saved». Nel riquadro di Claude
  (⌘J) col contesto di P, «/» non elenca la skill spenta.
- «Apply recommended preset» su `superpowers` → spegne quattro skill e
  nient'altro.
- Con A e con C sulla stessa pagina: C salva per primo, A salva dopo → A vede
  il conflitto con «Keep my changes on theirs» e «Use theirs»; la sua bozza
  resta finché non sceglie.
- Con B (senza `project.settings.manage`) → la pagina si legge, con «Who?».

## I permessi dei reparti con due admin insieme

- A e C aprono lo stesso reparto in Amministrazione → Departments.
- C aggiunge un permesso di progetto e salva (codice) → nel pannello di A,
  **senza modifiche**, il reparto si rilegge da solo.
- Di nuovo, ma A ha cambiato qualcosa senza salvare → il pannello dice
  «Someone else changed this department while you were editing it…»; salvare
  dà «Someone else changed this while you were editing it. Nothing was
  saved.», e niente si sovrascrive. **Da guardare**: la prima frase dice anche
  «or save yours over them», ma il salvataggio sopra non riesce. Annota cosa
  succede dopo «Discard».
- L'anteprima di un permesso che il reparto non può dare lo mostra spento,
  col perché; un reparto che non arriva a nessun progetto ha la sua frase.
- Togliere l'ultimo che gestisce i membri passando dal reparto → rifiutato,
  in parole.

## Le azioni di Claude con «Annulla»

Nella conversazione libera (destinazione Claude) o nel riquadro (⌘J).

- «Assegna P-12 a B» → una riga eseguita con **Undo** → Undo → la task torna
  com'era; il registro dice «By Claude» e poi «Undid…».
- Un'azione B (per esempio «elimina la task P-13») → una scheda coi motivi;
  **Confirm** la esegue, **Cancel** no.
- Un'azione C, «aggiungi B a P come Developer» → la scheda dice «Asks for your
  two-step code» → Confirm → il codice → B entra in P.
- **Undo** di quell'aggiunta → è una scheda nuova che chiede il codice
  (l'inverso è anch'esso C); confermata, B esce da P.
- Una scheda C aperta col codice scaduto (oltre 10 minuti) → Confirm chiede il
  codice, e senza niente cambia.

## La Chat con una C

- In un canale di P, «@Claude aggiungi C a P come Viewer» → la scheda nel
  canale dice «Asks for your two-step code» → A conferma → il codice → C entra.
- **Il codice si chiede PRIMA** che la scheda risulti presa: con il dialogo
  del codice chiuso senza confermare, la scheda resta aperta per tutti.
- B, nello stesso canale, vede la scheda ma non la conferma (non gestisce i
  membri).
- Le notifiche `member.added`: C riceve «You've been added to P as Viewer»
  («Claude on behalf of A»). Gli altri che gestiscono i membri di P ricevono
  «A added C to P as Viewer». Chi ha agito no. Un gestore che spegne «Someone
  joined the project» in Preferenze → Notifiche non la riceve più; chi entra la
  riceve comunque.

## Il contenuto personale blocca «Rendi pubblica»

- Con A, apri una conversazione della tua posta, ⌘J, chiedi qualcosa su
  quella email → nella conversazione, **Make public** → il dialogo dice «This
  conversation can't be made public» col perché, e solo **Close**.
- Lo stesso con una bozza di email scritta da Claude, e col chip di
  un'automazione generale (una senza progetto).
- Una conversazione che ha letto solo task e progetti → il dialogo di sempre,
  coi progetti da confermare.
- Una conversazione pubblica, poi chiedi a Claude di leggere la tua posta →
  Claude dice in prosa che lì non può leggerla.
- «Make private» resta sempre possibile.

## Le automazioni scritte da Claude (S1)

- Con A, dalla pagina Support di P, nella libera: «avvisa il reparto quando
  arriva una richiesta urgente dal supporto» → Claude chiede **quale reparto**
  con una scheda di scelta → scegli → Claude crea la bozza.
- La riga della prova: «Tested on 2 examples · nothing was created», un
  esempio che passa e uno che il filtro esclude («Wouldn't start»). Nessuna
  task, notifica o email vera nasce.
- Il costruttore si apre da solo sulla prova, con «Back to <pagina>».
  L'automazione è **spenta**: si accende solo dal costruttore, a mano.
- Senza esempi adatti nel progetto → «Nothing to try it on yet», e il
  costruttore si apre sulla bozza.
- **Undo** dell'automazione creata → la bozza sparisce.
- Claude non dice mai «l'ho accesa», e non propone mai di pubblicarla.
- La scheda di scelta: rispondi con un'opzione o con un testo tuo; risposta,
  non si risponde una seconda volta («already answered»). Chi legge la
  conversazione resa pubblica vede la domanda ma non risponde.

## I chip del riquadro (F1)

- ⌘J su un'automazione, su una conversazione di supporto, su un'email della
  tua casella → il chip la nomina; chiedi «cosa fa?» → Claude risponde
  leggendola.
- Un'email nel riquadro di una conversazione pubblica → Claude dice che lì
  non legge la posta.


# Area 11 — la documentazione di prodotto (21 nov 2026)

Le prove dello spazio Product contro il server vero. Si fanno **sia
nell'app desktop (dmg) sia nel browser su `/app`**; le prove «dal vivo»
vogliono due finestre, e dove desktop e browser si comportano diversamente
la prova lo dice. Le parole fra virgolette sono quelle dell'interfaccia in
inglese; in italiano cambiano, il senso no.

## Cosa serve in più

- **Il codice di `feat/integrazione-area11`** su un'istanza di prova: server
  prima (migrazioni fino alla 0215), poi worker, poi caddy; il dmg rifatto da
  quel branch. Un solo processo server (la presenza dal vivo sta in memoria).
- **Tre account** in un progetto P col modulo Docs acceso:
  - **A**: Project Lead di P (scrive i Docs, gestisce le impostazioni);
  - **B**: Developer di P (scrive i Docs);
  - **S**: un account che legge soltanto i Docs di P (senza «Edit docs»).
- Un'immagine PNG sotto i 5 MB, una sopra i 5 MB e un file non immagine
  (per esempio un PDF).
- Per Claude sulla doc: il worker acceso col CLI pinnato e budget del mese
  disponibile. In P qualche email e una riunione con la trascrizione (per la
  prima versione), e un file nel Drive di P.
- **Le prove di F6** (prima versione, bozze di schermata, dalla doc al
  backlog) valgono quando l'interruttore `product-claude-actions` è acceso,
  dopo il catalogo di Claude (Task 4 del server). Prima, quei gesti non ci
  sono: nessun «Write the first version», niente gruppo «Claude» nel «⋯».

## Spazio ed editor

- Con A, Docs di P → **Product**: lo spazio vuoto; crea una pagina, poi una
  sottopagina, rinominala, spostala sotto un'altra pagina, eliminane una
  vuota. Il codice di ogni pagina è della serie `-D` dei Docs e una pagina
  eliminata non lo ridà a nessuno.
- Scrivi qualche paragrafo, un titolo, un elenco, un blocco di codice, una
  tabella → «Saving…» poi «Saved». Ricarica: tutto è com'era. ⌘Z dell'editor
  rimette un blocco tolto, coi commenti che aveva.
- **Pagina cambiata intanto (`stale`)**: l'editor salva a pezzi, dopo 0,8
  secondi di pausa o uscendo dal blocco, e ogni pezzo parte dalla versione
  della pagina che A aveva sotto gli occhi.
  - **Blocchi diversi**: A e B scrivono in due paragrafi diversi quasi
    insieme → il salvataggio di A si riprova da solo sopra quello di B:
    «Saved», e ricaricando ci sono tutte e due le modifiche.
  - **Lo stesso blocco** («Mostra le due versioni», decisione del
    maintainer del 21 nov 2026): serve che B tocchi lo stesso paragrafo mentre il
    pezzo di A è in viaggio. Con la scrittura dal vivo accesa la sezione presa
    di solito lo impedisce, quindi conviene lasciarla libera: B scrive e
    manda la finestra in secondo piano, A cambia lo stesso paragrafo senza
    rileggere. Atteso:
    - la barra di A dice «Couldn't save a change: the page had changed. Your
      version is under the paragraph.», senza «Retry»;
    - il paragrafo mostra la versione del server (quella di B) e, sotto, il
      riquadro «Your version, not saved» col testo di A, con **Use mine** e
      **Discard**. Il riquadro resta anche uscendo dal blocco e scrivendo
      altrove;
    - **Use mine** → una scrittura nuova: il paragrafo prende il testo di A,
      il fuoco va alla fine, «Your version is back in the paragraph», e in
      cronologia una revisione di A. Se B scrive ancora lì, il riquadro
      torna con la frase «B is writing in this section. Your version is
      under the paragraph.»;
    - **Discard** → il riquadro se ne va e niente si scrive;
    - B elimina il paragrafo mentre A lo scrive → il riquadro dice «· the
      paragraph was deleted» e sta dove il paragrafo era; «Use mine» lo
      rimette lì, come paragrafo nuovo;
    - dividere o unire paragrafi rifiutati non ha un riquadro: solo la frase;
    - col riquadro aperto, A apre un'altra pagina (o un'altra sezione) →
      «Some changes aren't saved yet» · Stay · Leave without saving; «Stay»
      resta col riquadro, «Leave without saving» esce e la versione di A
      si perde. Lo stesso con una scrittura ferma su «Couldn't save · Retry»
      (A stacca la rete, scrive, esce); uscire subito dopo aver scritto,
      con la rete, non chiede niente. Chiudere la finestra non chiede;
    - le modifiche dopo di A si salvano normalmente.
- **Sezione occupata (`section_busy`)**: B scrive sotto un titolo; A prova a
  scrivere nella stessa sezione → «Couldn't save a change: B is writing in
  this section. Your version is under the paragraph.»: il testo di B resta,
  e quello di A è nel riquadro sotto, da riprendere o scartare (come sotto). Quando B smette (o la sua finestra va
  in secondo piano, sotto) A scrive.
- **Immagini**: «/image» o trascina un PNG → «Drop to add the image», poi
  l'immagine con «Add a caption». Ricarica e da un'altra finestra: si vede.
  L'immagine sopra i 5 MB → «This image is larger than 5 MB»; il PDF → «Only
  PNG, JPEG, GIF and WebP images»; la pagina non cambia. Una rete staccata
  durante il caricamento → «Couldn't upload the image. Try again.».
- **Cronologia**: le revisioni dalla più recente, con chi e quando; una
  pagina creata, rinominata e spostata ha le sue righe.
- **Segui**: «Follow» → «Following», e la riga «Followed by…». Con S la
  pagina si legge, senza editor e con il «Who?» di «Edit docs».

## Commenti e menzioni

- Con A seleziona una frase → **Comment** → «@» elenca solo chi legge i Docs
  di P («People who can read P's docs») → menziona B → «B will be
  notified.» → «Comment posted».
- **La card**: nell'inbox di B «A mentioned you in P-D… · <titolo>»; aprirla
  porta alla pagina col filo aperto e la frase evidenziata.
- B risponde, poi **Resolve** → il filo esce dagli aperti («1 resolved») →
  **Reopen** lo riporta. S vede i commenti e «Commenting is for people with
  Edit docs in P».
- Elimina la frase commentata → il filo resta con «Sentence deleted».
- Una card di una pagina eliminata, o di un progetto che chi guarda non legge
  più → «This comment is no longer available», nessun dettaglio.
- **Preferenze → Avvisi**: le righe «Mentioned in the product doc»
  (obbligatoria, senza interruttore), «Claude updated a product page» e
  «Claude asks about a product page», per progetto. Spegni la seconda per P
  → B non riceve più le card di aggiornamento di P; chi segue la pagina le
  riceve comunque.

## Ricerca ed esportazione

- Cerca una parola che sta in una pagina di Product → nella ricerca dello
  spazio la pagina col passaggio evidenziato; nella ricerca globale (⌘K) il
  gruppo Product. Una pagina appena scritta compare dopo una trentina di
  secondi (il poller degli embedding), non subito.
- Nella Chat, una risposta che cita una pagina di Product → la citazione
  porta alla pagina. Con S la citazione si vede solo se S legge i Docs di P.
- **Export** → «This page» e «Whole space», PDF e «Word (.docx)» →
  «Preparing…» poi «Saved the PDF» / «Saved the Word file». Apri i file: le
  pagine in ordine d'albero, le immagini dentro, «Comments aren't
  included.». Un file del Drive citato ha la sua riga col nome; S, che non
  vede il file, ha «File: … (not available)».

## Dal vivo (due finestre)

- A e B sulla stessa pagina, in due finestre (o un'app e un browser). Il
  cursore di B si vede nella finestra di A, con «B · writing in <sezione>».
  Quello che B scrive compare da A senza ricaricare.
- **Finestra in secondo piano**: B scrive in una sezione, poi
  - nel browser: cambia scheda (la scheda nascosta);
  - sul desktop: clicca su un'altra app (la finestra perde il fuoco, anche
    se resta visibile);
  → da A la sezione si libera **subito** («B · writing» sparisce) e A ci
  scrive. Quando B torna e rimette il cursore in un blocco, la presa torna;
  il solo ritorno della finestra non la riprende.
- Chiudi la finestra di B → in pochi secondi B sparisce dalla pagina di A.

## Claude sulla doc (segni, «Undo», domande)

Serve un lavoro di Claude sulla pagina: una nota di rilascio, una task
chiusa o una decisione che tocca una frase della pagina (o il giro notturno).

- Le frasi cambiate da Claude hanno il **segno** a margine; aprirlo dice da
  quale fonte («From a decision you can't see» per chi non la vede).
  **Looks good** → «Marked as reviewed»; **Undo** → «Undone: the sentence
  is back as it was».
- **Undo rifiutato**: B cambia la frase dopo Claude → l'«Undo» di A dice che
  B l'ha cambiata dopo, senza «Retry»; B scrive nella sezione mentre A preme
  «Undo» → «B is writing in this section. Try again when they're done.».
  Un «Undo» già fatto da un altro → «Already undone by …». «Retry» c'è solo
  per un errore di rete.
- Dalla **cronologia**: la revisione di Claude con «Undo all» e «Undo» per
  frase; «1 of 3 undone · A» dopo un «Undo» parziale.
- **Le domande**: una frase poco chiara diventa una domanda di Claude nel filo,
  con la frase citata. «Update it» la corregge (una revisione di chi
  risponde), «Leave it as is» la chiude. La card «Claude asks about P-D… ·
  <titolo>» arriva a chi segue la pagina; risposta, dice «Answered by …».
- **«Open a request» (la scheda B nel filo)**: dalla domanda → sotto, la
  scheda «Open a request in P» con titolo e descrizione → **Create request**
  → la richiesta nasce in P e la domanda si chiude. **Cancel** → la scheda
  se ne va e la domanda resta aperta. Da Home → «Decide» → «Open a request»
  porta allo stesso filo con la scheda già aperta (mai un messaggio a
  Claude). Due persone rispondono insieme → la seconda vede chi ha già
  risposto.
- **«riprende quando…»**: col budget del mese finito (o la coda in pausa)
  un aggiornamento di Claude aspetta → in cima allo spazio «Claude will
  resume updating the doc when the budget is back» con «1 update waiting».
  La riga si aggiorna da sola entro mezzo minuto, senza ricaricare. Rimetti
  il budget → l'aggiornamento parte e la card dice «…after waiting for the
  budget».
- La card «Claude updated P-D… · <titolo>» porta al segno della frase; senza
  segni (tutti annullati), alla revisione in cronologia.

## La prima versione (F6, con `product-claude-actions` acceso)

- Con A, in uno spazio **vuoto** → «Write the first version with Claude» →
  scegli due email, una riunione, un file e incolla qualche nota → l'avviso
  sulla privacy → **Write the first version**.
- «Claude is writing the first version», «1 of N pages»: le pagine compaiono
  una alla volta nell'albero, senza ricaricare (la pagina si rilegge ogni
  due secondi mentre scrive). Alla fine «Claude wrote the first version»,
  con le domande da chiudere.
- In cima a ogni pagina «First version written by Claude on behalf of A» con
  **Accept** e **Undo the first version**. «Accept» su una pagina toglie la
  riga da quella pagina.
- B modifica una pagina → l'«Undo the first version» di A dice «B edited
  “…” afterwards» ed è spento. Su uno spazio non toccato, «Undo the first
  version» → la conferma → le pagine se ne vanno, coi loro commenti.
- Mentre A apre la finestra, B aggiunge una pagina → «Someone added a page in
  the meantime: the first version starts only in an empty space.».
- S vede la prima versione, senza «Accept» né «Undo» («…is for people with
  Edit docs in P»). Non c'è un «Stop»: è nel registro dei rimandi.

## Le bozze di schermata (F6, con `product-claude-actions` acceso)

- Con A, «⋯» della pagina → gruppo **Claude** → **Draw this screen** (o
  «/» → «Screen sketch» su un paragrafo vuoto) → il blocco nasce subito con
  la testata «Claude's draft · Screen sketch», l'anello che pulsa e «Claude
  is drawing this screen…»; «Keep» e «Redraw» spenti, «Replace with an
  image» acceso. Dopo qualche secondo arriva lo schizzo (in bianco e nero,
  anche nel tema scuro), senza ricaricare.
- **Redraw** → di nuovo «Claude is drawing this screen…» al posto dello
  schizzo, poi uno schizzo nuovo e l'annuncio «New sketch». Il fuoco resta su
  «Redraw».
- **Keep** → l'etichetta se ne va: è una figura come le altre. Dalla
  cronologia «Kept the screen sketch» con **Undo** → l'etichetta torna. Se B
  ha rifatto lo schizzo dopo, l'«Undo» è spento col nome di B.
- **Replace with an image** (anche mentre disegna) → l'immagine prende il
  posto della bozza, con la didascalia; il disegno in arrivo non scrive più
  nulla. «Undo» dalla cronologia rimette la bozza.
- **Non riuscita**: col budget del mese finito mentre disegna → «Claude
  couldn't draw this screen» e «The monthly AI budget is used up · Who?», e
  «Redraw» spento. Col limite dell'account → «Claude reached its usage limit.
  Try Redraw later.». Un «Redraw» che non riesce lascia lo schizzo di prima,
  con la frase sotto («Claude couldn't redraw this screen»).
- S vede le bozze, gli stati e le frasi, senza bottoni.
- Esporta la pagina: lo schizzo nel PDF e nel Word; una bozza mai tenuta ha
  sotto «Claude's draft · Screen sketch», una tenuta no.

## Dalla doc al backlog (F6, con `product-claude-actions` acceso)

- Una pagina con un elenco o una lista di controllo → «⋯» → **Propose
  backlog items** (o dal ⋮⋮ di un titolo «…from this section») → nel
  riquadro di Claude la scheda con una voce per frase, «From the page:
  “…”». Conferma → le richieste nascono nel backlog di P.
- In fondo alla pagina «From this page» elenca le richieste nate da lì, con
  lo stato («Converted» con le task, «Archived»). Sulla richiesta e sulla
  task, «From the doc: P-D… <titolo>» riporta alla pagina.
- Proporre di nuovo dalla stessa pagina → «Already proposed from this
  page: …» e le frasi già proposte non tornano. Una pagina senza elenchi →
  la voce è spenta con «No list items or to-dos on this page».
- Col budget finito il gruppo Claude è spento con «The monthly AI budget is
  used up · Who?». S non ha il gruppo Claude nel «⋯».
