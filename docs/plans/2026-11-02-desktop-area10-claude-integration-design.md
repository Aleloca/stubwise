# App desktop Stubwise, area 10: Claude dentro l'app — design

Data: 2 nov 2026. È il decimo documento della serie e l'ultima fase del
prototipo desktop. Accanto ci sono l'ossatura
(`docs/plans/2026-10-23-desktop-ossatura-design.md`) e i design delle aree
2–9. Questo documento parte soprattutto da:
- l'area 3 (`docs/plans/2026-10-24-desktop-area3-claude-design.md`):
  conversazione libera, sessioni, proposte con conferma, «Claude agisce come
  l'utente»;
- l'area 7 (`docs/plans/2026-10-26-desktop-area7-automations-design.md`):
  il flusso come documento dichiarativo validato da `validateFlow`, e il
  rimando «Claude che costruisce o prova le automazioni»;
- l'area 9 (`docs/plans/2026-10-29-desktop-area9-admin-design.md` e i piani
  9a, 9b, 9c): la riconferma (+R), il registro delle modifiche, R-G5,
  «Who?», i segreti.

Si costruisce nel prototipo `apps/desktop`, con dati finti e le stesse
regole delle altre aree:
- ogni pagina è definita fino in fondo, con gli stati veri;
- i permessi si verificano col «vedi come»;
- il linguaggio visivo è quello di `apps/desktop/DESIGN.md`;
- UI e UX si definiscono con Impeccable: shape, poi costruzione, poi
  revisione.

Come leggere le marcature:
- *(maintainer)*: decisione presa nella conversazione del 2 nov 2026;
- *(scelta del costruttore)*: proposta confermabile, presa per non lasciare
  buchi a chi costruisce;
- *(scelta del controller)*: risposta del controller a una domanda del
  controllo del costruttore (2 nov 2026).

## Perché

Le aree 2–9 hanno messo Claude in tanti posti, ognuno col suo bottone e le
sue regole:
- la conversazione libera e le sessioni (area 3);
- @Claude nella Chat (area 4);
- le citazioni dei Docs e del Drive (area 5);
- «Ask Claude» nella Posta (area 6);
- i passi di Claude nelle automazioni (area 7);
- «Bozza di Claude» nel Supporto e «Chiedi a Claude di spiegarlo» sui
  rilasci (area 8a).

Manca un Claude che si chiami **da qualunque pagina** e che **faccia il
lavoro dell'app** per chi lo chiama: costruire un'automazione, archiviare
dieci progetti, rispondere a «quanto abbiamo speso», scrivere la risposta a
un cliente *(maintainer)*. L'area 7 ha rimandato qui di proposito «Claude
che costruisce o prova le automazioni». Il flusso è già un documento che
`validateFlow` (`domain/automations/validate.ts`) controlla, proprio perché
Claude potesse scriverlo (`apps/desktop/docs/ossatura-follow-ups.md`,
«Area 7 — Rimandati»).

## Cosa copre

1. **Il riquadro di Claude**: si apre da ogni pagina, sa cosa si sta
   guardando ed è la conversazione libera dell'area 3.
2. **La regola nuova della conferma**: cosa parte subito, cosa chiede una
   scheda, cosa chiede anche il codice, cosa Claude non fa mai.
3. **Trasparenza**: «Claude per conto di [persona]» nel registro delle
   modifiche, nei commenti e nelle notifiche.
4. **Rispondere sui dati** che chi chiede può vedere.
5. **Agire sull'app**: task, impostazioni, archiviazione, inviti e membri,
   assegnazioni.
6. **Costruire e provare automazioni.**
7. **Riassunti e bozze** nei campi veri, col segno «Bozza di Claude».
8. **Suggerimenti discreti**: la riga «Claude può aiutarti a…».
9. **Gli scenari d'esempio** del maintainer, tutti.

## Obiettivi

Claude deve saper fare quattro cose dentro l'app *(maintainer)*:
1. costruire automazioni;
2. agire sull'app: crea task, cambia impostazioni, archivia, invita,
   assegna…;
3. rispondere su tutti i dati che chi chiede può vedere;
4. riassumere e scrivere bozze: risposte, descrizioni di task, note di
   rilascio, brief.

In più:
- si usa **senza cambiare pagina e senza perdere il lavoro** *(maintainer)*;
- ogni cosa che Claude fa si **vede**, porta il nome di chi l'ha chiesta e
  si **annulla** dove è possibile *(maintainer)*;
- gli scenari del maintainer girano tutti nel prototipo, su dati finti, con
  i permessi veri del «vedi come» *(maintainer)*.

## Non obiettivi

- **Le sessioni di lavoro sulle task restano come sono** *(maintainer)*:
  pianifica, esegue, corregge, il gate del piano, le domande `ask_user`.
  Quest'area non le tocca.
- **Le proposte che esistono già restano dove sono** *(maintainer)*: pulse,
  domande dell'agente, piani da approvare, proposte nate dalla posta.
  Restano in «Da decidere» e nelle loro pagine; il riquadro non le
  duplica.
- **@Claude nella Chat** resta con le regole dell'area 4: ogni modifica è
  una proposta da confermare *(scelta del costruttore)*. Un canale è un
  posto condiviso: un'azione «partita subito» con «Annulla» sotto gli occhi
  di tutti sarebbe una regola diversa da decidere a parte.
- **Iniziativa di Claude**: Claude non agisce mai da solo *(maintainer)*.
  Nessun lavoro in background avviato dal riquadro, nessuna azione
  programmata.
- **Un modello vero**: il prototipo non usa la rete *(maintainer)*.
- **Deploy**, azioni sui server, merge: vedi «Cosa Claude non fa».

## Anti-obiettivi

Del maintainer *(maintainer)*:
- **Claude che inventa dati o presenta un'ipotesi come fatto.**
- **Dover cambiare pagina o perdere il lavoro per usarlo.**
- **Risposte lunghe quando basta una riga.**

Restano quelli delle aree precedenti:
- Claude che fa qualcosa che chi lo chiama non potrebbe fare a mano
  (area 3);
- un registro che rivela (area 9, R-G5);
- un segreto che ricompare (area 9);
- un'azione delicata senza riconferma (area 9);
- un'automazione che esce dai binari (area 7).

### L'anti-obiettivo dell'area 3 che cambia *(maintainer)*

L'area 3 aveva questo anti-obiettivo: «Una modifica ai dati di Stubwise
fatta da Claude per conto dell'utente **senza che l'utente l'abbia vista e
confermata**». Con quest'area **non vale più**, anche nella conversazione
libera dalla destinazione «Claude». Alcune azioni partono subito (vedi la
regola della conferma).

Lo sostituiscono tre regole:
1. **Nessuna azione invisibile.** Ogni azione eseguita compare nella
   conversazione come riga, con cosa, su cosa e il risultato apribile.
   Compare anche nel registro delle modifiche, o nella storia
   dell'oggetto, come «Claude per conto di [persona]».
2. **Annullabile fin dove si può.** Ogni azione eseguita ha «Annulla» nella
   sua riga finché l'oggetto è come Claude l'ha lasciato. Un'azione che non
   si annulla non parte mai senza scheda.
3. **Subito solo ciò che resta tuo.** Partono senza scheda solo le azioni
   che toccano soltanto chi le chiede e si rimettono a posto con «Annulla».
   Tutto il resto passa dalla scheda.

## Regole di fondo

### Claude agisce con i permessi di chi lo chiama *(maintainer)*

È la regola dell'area 3, «Claude agisce come l'utente», ripresa intera.
- Ogni lettura e ogni scrittura del riquadro gira con l'**identità e i
  permessi della persona** che conversa. Usa le stesse funzioni del livello
  dati delle pagine (`can()` in `data/viewer.ts`, `visibleProjectIds`, le
  mutazioni con `writer()`), e fallisce con `forbidden` o `not_found`
  esattamente come a mano.
- Il controllo è **deterministico e lato dati**, mai un'istruzione nel
  prompt. Non si aggira con quello che si scrive a Claude.
- Il permesso si controlla **quando l'azione parte**: alla conferma della
  scheda, o all'invio per un'azione immediata. Si ricontrolla
  all'**Annulla**. Chi ha perso il permesso nel frattempo riceve il rifiuto
  in parole, con «Who?».

### Due Claude, due regole *(scelta del costruttore)*

Nell'app ci sono due Claude diversi, e non vanno confusi:
- **Claude collega**: il membro implicito di ogni progetto. Gli si assegna
  una task e lavora nelle sessioni. Ha l'insieme fisso di permessi di
  lavoro (`CLAUDE_PROJECT_PERMISSIONS`, `CLAUDE_INSTANCE_PERMISSIONS`) e mai
  quelli di decisione (R-L9, R-L11). Quest'area non lo cambia.
- **Claude per conto di [persona]**: l'assistente del riquadro. Non ha
  permessi propri: ha **esattamente** quelli della persona. Non usa
  l'insieme di R-L9, né l'unione né l'intersezione con quello.
- **Chi agisce, per i permessi e per il registro, è la persona.** La riga
  del registro ha `actorId` uguale alla persona e porta in più il segno
  `via: "claude"`.

### La regola della conferma *(maintainer)*

Sostituisce quella dell'area 3 («Le modifiche sono proposte da
confermare»), **anche nella conversazione libera** della destinazione
«Claude». Ci sono quattro classi; ogni azione del catalogo ne ha una,
scritta nel livello dati accanto all'azione (vedi «Il catalogo delle
azioni»).

**A — Parte subito, con «Annulla».** Sono le azioni solo tue e facili da
rimettere a posto *(maintainer)*:
- una bozza in un campo;
- una task tua;
- un filtro.

Cosa vuol dire «solo tua» *(maintainer)*: l'azione **non manda avvisi ad
altre persone** e **non fa partire un'automazione**. Sono i soli due
criteri. Che il risultato compaia nelle liste del progetto, e quindi lo
vedano anche altri, **non conta**: una task tua nell'elenco di ACQ resta
tua. Quindi rientrano in A:
- creare una task assegnata a te in un progetto dove puoi crearla, se la
  creazione non avvisa nessuno e nessuna automazione attiva parte da
  `task_created` lì;
- pianificare o spostare di stato una task assegnata a te, se il cambio
  non avvisa nessuno e non fa partire un'automazione;
- applicare un filtro o salvarne uno personale;
- cambiare le tue preferenze: lingua, tema, notifiche;
- creare un'automazione in **bozza** (spenta, vedi «Automazioni»);
- mettere una bozza in un campo della pagina, compresa la casella della
  Chat: nessuno la vede finché la persona non la invia, e l'invio resta un
  gesto suo *(scelta del controller)*.

La classe si decide **al momento**, sui dati veri, con quei due soli
controlli: chi riceverebbe un avviso (le iscrizioni agli avvisi dell'8a,
calcolate a lettura) e quali automazioni attive partirebbero. Lo stesso
«crea una task» è A se è tua e non avvisa nessuno. Diventa B se è di un
altro, se avvisa qualcuno o se fa partire un'automazione. Claude dice
perché in una riga: «Ti chiedo conferma: in ACQ un'automazione parte
quando nasce una task».

**B — Chiede conferma con una scheda** (Conferma / Modifica / Annulla)
*(maintainer)*. Sono le azioni che toccano:
- altre persone: assegnare, commentare, creare una richiesta, avviare il
  lavoro di Claude su una task, invitare, aggiungere un membro;
- impostazioni condivise: del progetto o dell'istanza;
- permessi: ruoli, membri, reparti;
- e le azioni che **non si annullano**.

La scheda è quella dell'area 3 (`ProposalCard`), con le sue regole:
- più azioni insieme stanno in una scheda, con «Conferma tutto» e la
  conferma per riga;
- le azioni girano **tutte o nessuna** (`settleProposal`);
- «Modifica» apre il dialogo vero dell'azione, già compilato;
- la scheda scade dopo 20 messaggi o 24 ore.

In più, la scheda dice in una riga **chi ne sarà toccato** («Avvisa Marco
Bellini») e se l'azione **non si annulla** («Non si annulla»).

**C — Scheda e codice.** Un'azione che a mano chiede la riconferma (è in
`REAUTH_REQUIRED` di `data/auth/reauth.ts`) la chiede anche qui
*(maintainer)*:
- dopo «Conferma» si apre il dialogo dell'app (`useReauth`,
  `ReauthDialog`), sopra il riquadro;
- poi l'azione si ripete da sola;
- valgono le regole dell'area 9 senza eccezioni: la finestra di grazia di
  10 minuti, per persona; un PAT non la soddisfa mai.

Nessuna azione C diventa B perché parte dal riquadro, e nessuna B diventa
A. Una classe può solo **salire**, mai scendere *(scelta del costruttore)*.

**D — Claude non la esegue.** Mostra il posto vero dove la fai tu. Vedi
«Cosa Claude non fa».

### Cosa Claude non fa *(scelta del costruttore, dalle invarianti)*

Queste azioni non entrano nel catalogo di Claude, **anche se la persona ha
il permesso**. Claude porta al gesto vero (la scheda del piano, la coda di
rilascio, il costruttore) e lo dice in una riga:
- **approvare o rifiutare un piano**. Il gesto resta della persona
  (CLAUDE.md: «Nessun tool MCP approva un piano»);
- **mergiare una PR**: resta il merge esplicito a due clic della coda di
  rilascio;
- **rispondere a una domanda dell'agente** (`ask_user`). Il riquadro può
  mostrare la stessa scheda della domanda (`QuestionCard`), ma il clic è
  della persona;
- **scrivere nel registro decisioni** (vedi «Parità e invarianti
  toccate»);
- **accendere un'automazione**: resta spenta finché non la accende la
  persona *(maintainer)*;
- **azioni su un server** (analisi, correzione, accessi SSH) e **qualunque
  deploy**;
- **creare, mostrare o sostituire un segreto**: token, link d'invito, link
  di reset, chiavi API, chiavi d'ingestione, valori d'ambiente. Claude apre
  il dialogo vero, già compilato dove si può, e il segreto lo mostra
  l'app, una volta, come a mano;
- **mandare un messaggio fuori**: email, risposta a un cliente. Claude
  scrive la bozza nel campo e l'invio resta un clic di chi scrive.

Il motivo è uno solo: sono le azioni su cui il CLAUDE.md o le aree
precedenti hanno già deciso che **il gesto è di una persona**. Il riquadro
non deve diventare una seconda strada per farle.

### R-G5, i segreti, «Who?»: come altrove

- **R-G5**: Claude non rivela nulla che chi chiede non vede, **nemmeno
  nelle risposte**. Non dà nomi, non dà codici, non dà conteggi («e altri
  3 progetti»), non dice «ci sono cose che non puoi vedere». Un oggetto
  invisibile e uno inesistente ricevono la stessa frase: «Non trovo
  ACQ-99».
- **Segreti**: Claude non legge né mostra segreti. Le letture che usa sono
  le stesse viste delle pagine, che non li contengono mai (area 9). Nessun
  segreto entra nel registro della conversazione.
- **«Who?»**: quando la persona chiede qualcosa che non può fare, Claude lo
  dice in una riga e mette il link «Who?» (`WhoCanLink`). È lo stesso
  calcolo di `can()`, con le sole persone e progetti che chi chiede vede.
- **Orologio unico**: ogni «quando», «da 3 mesi» o «questo mese» si misura
  su `now()` di `data/store.ts`, mai sull'orologio della finestra.
- **en/it**: le frasi di Claude si registrano come chiave i18n e parametri
  (`Utterance`), come nell'area 3. Si leggono nella lingua di chi guarda,
  anche in una conversazione riaperta dopo un cambio di lingua.

## 1. Il riquadro

### Come si apre *(maintainer: sempre a portata)*

- **Scorciatoia** ⌘J / Ctrl+J da qualunque pagina *(scelta del costruttore:
  ⌘K, ⌘N, ⌘⇧H e ⌘1…9 sono già presi in `layout/useShortcuts.ts`)*.
- **Bottone fisso**: il segno di Claude (l'anello tratteggiato) in fondo al
  binario, sempre visibile *(scelta del costruttore)*.
- **Da ⌘K**: «Chiedi a Claude: <testo scritto>» apre il riquadro con quel
  testo già nella casella.
- **Dalle righe «Claude può aiutarti a…»** (vedi la parte 8).

Il riquadro sta **sopra la pagina**, a destra, e non la sostituisce
*(maintainer)*:
- la pagina resta viva sotto: si scorre, si clicca, si scrive;
- Esc o la scorciatoia chiudono il riquadro senza perdere niente: la
  conversazione resta e il testo non inviato nella casella resta;
- il pannello della task (`useDetailPanel`) e il riquadro convivono. Come
  stanno insieme a 1024 px lo decide lo shape (vedi «Lasciato al
  costruttore»).

### È la conversazione libera *(maintainer)*

- Il riquadro **è** la conversazione libera dell'area 3, con lo stesso
  componente (`pages/claude/conversation/Conversation.tsx`), lo stream, le
  citazioni, «#» e «@», i comandi «/».
- Le conversazioni aperte dal riquadro **restano** e si ritrovano nella
  destinazione «Claude» → «Le mie conversazioni», **private** come ogni
  conversazione libera.
- Valgono le regole dell'area 3 sulla pubblicazione: si possono rendere
  pubbliche con la conferma dei progetti toccati, e chi continua una
  conversazione pubblica ne apre una continuazione sua *(scelta del
  costruttore: si tiene l'area 3 così com'è)*. «Annulla» e le schede
  aperte sono **solo di chi le ha chieste**: un lettore della conversazione
  pubblica le vede chiuse.
- Riaprendo il riquadro si ritrova **l'ultima conversazione**, finché la
  persona non preme «Nuova» *(scelta del costruttore)*. Una riga di
  suggerimento apre sempre una conversazione nuova.
- In testa al riquadro: «Apri in Claude», che porta la stessa conversazione
  nella destinazione a tutta pagina.

### Sa cosa stai guardando *(maintainer)*

- Il riquadro riceve il **contesto della pagina**: la rotta, il progetto e
  l'oggetto aperto (la task nel pannello, la conversazione di supporto, la
  PR, l'automazione, la sezione di impostazioni, il filtro attivo).
- Il contesto si vede come **chip** in testa, «Stai guardando: ACQ-S4 ·
  conversazione di supporto», e si toglie con un clic.
- Il contesto è un **riferimento**, non un contenuto. Claude lo rilegge con
  le funzioni di visibilità della persona. Un oggetto che nel frattempo è
  diventato invisibile risponde come uno inesistente (R-G5).
- Cambiando pagina col riquadro aperto, il chip si aggiorna. I messaggi già
  scritti restano legati al contesto che avevano.
- Il campo `Conversation.context` (oggi solo `release`, area 8a) si allarga
  ai tipi di oggetto citabili *(scelta del costruttore)*.

### Le pagine che si possono riempire *(scelta del costruttore)*

Una bozza va nel **campo vero** *(maintainer)*. Per farlo, le pagine
**dichiarano** i loro campi riempibili, con un'etichetta e il tipo di testo:
- la risposta a una conversazione di supporto;
- la descrizione di una task;
- le note di rilascio di una PR;
- il corpo di un'email;
- il messaggio della Chat.

Claude scrive solo in un campo dichiarato **della pagina aperta**. Se la
persona ha già cambiato pagina, la bozza resta nella conversazione con
«Metti nel campo», che porta alla pagina e la mette lì. Niente si perde.

### Stati del riquadro

Valgono quelli della conversazione dell'area 3 (in diretta, riconnessione,
interrotta, finita, sola lettura con motivo, proposta scaduta). In più:
- **budget mensile esaurito** (9b): il riquadro lo dice in parole e non
  parte niente. Bozze e risposte compresi: usano Claude;
- **coda del progetto in pausa** (9b): **non** ferma il riquadro, come non
  ferma «Chiedi a Claude» (decisione del maintainer del 30 ott 2026). Ferma
  solo il lavoro che il riquadro farebbe partire, che entra in coda;
- **vedi come**: cambiando persona il riquadro passa alle conversazioni
  della nuova persona. Le schede aperte dell'altra non si confermano.

## 2. Il catalogo delle azioni *(scelta del costruttore)*

Oggi le azioni di Claude sono i valori di `ProposedAction.fn`
(`data/model.ts`): `createTask`, `updateTask`, `planTask`, `addComment`,
`createRequest`, `convertRequest`, `startRun`, `archiveRequest`,
`createMilestone` e quelle della posta. Le esegue `applyActions` in
`data/api-mutations.ts`.

L'area 10 le allarga. **Ogni azione nuova chiama la mutazione che la pagina
usa già**, a nome della persona; il catalogo non ha scritture sue. Per ogni
azione il catalogo dichiara:
- la **classe** di partenza (A, B, C), che i dati possono solo alzare;
- l'**inverso**, cioè cosa fa «Annulla», o «non si annulla»;
- **chi tocca**, per la riga della scheda;
- la **funzione dell'API** (`ApiFnName`): la classe C viene da
  `REAUTH_REQUIRED`, non si dichiara a mano.

Un test del registro controlla che ogni azione del catalogo abbia classe e
inverso, e che nessuna funzione di `REAUTH_REQUIRED` sia sotto la classe C.

Le azioni nuove:

| Azione | Mutazione | Classe | Annulla |
|---|---|---|---|
| Crea task tua (già nel catalogo) | `createTask` | A | `deleteTask` |
| Elimina task (nuova, anche a mano) | `deleteTask` | B, non si annulla | — |
| Archivia progetti | `archiveProject` | B | `reopenProject` |
| Aggiungi un membro con un ruolo | `admin.addMember` / `saveMember` | C | `removeMember` (C) |
| Cambia il ruolo di un membro | `admin.setMemberRole` | C | ruolo di prima (C) |
| Impostazioni di progetto (General, AI, Automations) | le scritture del 9c | B | valore di prima |
| Impostazioni d'istanza senza segreti | le scritture del 9b | B | valore di prima |
| Le tue preferenze | le scritture di Preferenze | A | valore di prima |
| Filtro | quello della pagina | A | filtro di prima |
| Bozza in un campo | nessuna scrittura: il testo va nel campo | A | testo di prima |
| Crea automazione in bozza | `automations.createAutomation` | A | `deleteDraft` |
| Salva la bozza dell'automazione | `automations.saveDraft` | A | versione di prima |
| Prova l'automazione | `automations.startSimulation` | A, nessun effetto | — |

### «Annulla» *(maintainer: annullabile; forma: scelta del costruttore)*

- «Annulla» è **un'azione nuova**, l'inverso, non una cancellazione della
  storia. Passa dagli stessi controlli: permesso, riconferma se l'inverso è
  in `REAUTH_REQUIRED`, `escalation`.
- Si scrive nel registro come voce a sé: «Claude per conto di Giulia
  Ferri ha annullato: …». La voce originale resta: il registro non si
  modifica (area 9).
- È possibile **finché l'oggetto è come Claude l'ha lasciato**. Se qualcuno
  l'ha toccato dopo, la riga dice «Marco Bellini l'ha modificata dopo: non
  si annulla da qui» e porta all'oggetto. Nessuna fusione silenziosa.
- **Non scade col tempo**: scade con il cambiamento. È la stessa regola
  per le azioni A e B.
- Le azioni di una scheda confermata insieme si annullano **insieme**,
  tutte o nessuna, come si sono eseguite.
- **«Annulla» sulla creazione di una task** usa l'azione «Elimina task»
  (sotto), con le sue regole e la sua traccia *(maintainer)*. Vale finché
  la task è come Claude l'ha creata: un commento, un cambio di campo o un
  lavoro di Claude partito da qualcuno la rendono non più annullabile da
  qui.

### Eliminare una task *(maintainer, 2 nov 2026)*

Oggi il prototipo non sa eliminare una task. L'area 10 aggiunge **«Elimina
task»**, un'azione dell'app usabile **anche a mano da tutti** (dal menu
della task), non solo da Claude. È anche l'inverso della creazione per
«Annulla».

**Permesso** *(scelta del costruttore)*. È la stessa regola dei commenti e
degli allegati, che oggi esiste già:
- **chi l'ha creata** (`createdById`) la elimina con `tickets.edit` nel
  progetto. «Annulla» di Claude rientra qui: la task creata per conto di
  Giulia ha Giulia come autrice;
- **le task create da altri** le elimina chi ha `tickets.moderate` nel
  progetto, il permesso che oggi serve per cancellare il commento o
  l'allegato di un altro.

Non nasce un permesso nuovo. Claude collega non ha `tickets.moderate`
(R-L9), e il suo insieme fisso non cambia.

**Quando si rifiuta** (`busy`, come l'archiviazione del 9c): se c'è un
lavoro di Claude vivo sulla task, una PR aperta legata alla task, o se la
task è la correzione di un server (`serverRef`) o di un rilascio
(`releaseRef`) ancora aperta. Il dialogo dice cosa aspettare.

**Non si annulla.** Chiesta a Claude («elimina ACQ-14»), è quindi sempre
una scheda B con «Non si annulla». A mano apre un dialogo di conferma che
nomina codice e titolo della task. Non chiede la riconferma: non è in
`REAUTH_REQUIRED`.

L'unica eccezione è «Annulla» sulla creazione fatta da Claude. Lì
l'eliminazione parte senza scheda, perché rimette a posto un'azione A e
la task è ancora come Claude l'ha creata (vedi sopra). Permesso, `busy` e
traccia sono gli stessi.

**Cosa succede a ciò che le sta intorno** *(scelta del costruttore)*:
- **figli**: le task che la avevano come `parent` **non si eliminano**.
  Perdono il collegamento e restano task a sé, nello stesso progetto. Il
  dialogo li elenca («2 task figlie restano, senza task madre»);
- **collegamenti** `blocks` e `relates`: spariscono da entrambe le parti.
  Le righe salvate sulle altre task che la nominano si tolgono nella stessa
  scrittura. Una task bloccata solo da lei non è più bloccata;
- **commenti, allegati, storia della task**: se ne vanno con la task;
- **richiesta d'origine** (`requestId`): la richiesta resta com'è (già
  convertita) e mostra «La task ACQ-14 è stata eliminata», senza link;
- **traguardo**: la task esce dai conteggi del traguardo;
- **esecuzione d'automazione** che l'ha creata: il registro
  dell'esecuzione resta e la riga dice «task eliminata», senza link;
- **codice**: non si riusa mai. Scritto a mano o citato altrove (Chat,
  conversazioni, Docs, registro decisioni, notifiche), si legge **come un
  codice inesistente**, senza link: la stessa resa per eliminata,
  invisibile e mai esistita (R-G5). Le righe del registro decisioni non si
  riscrivono;
- **notifiche** che la riguardano: restano. «Task eliminata» al posto del
  link si deriva a lettura, non si scrive nell'evento.

**Traccia**:
- **registro delle modifiche**: voce di progetto `task.deleted`, con codice
  e titolo di allora (`ChangeObject.label`). La leggono chi gestisce il
  progetto (come le altre voci di progetto) e chi ha `tickets.moderate`
  lì. Eliminata dal riquadro, porta «Claude per conto di …»;
- **storia del progetto** e **rassegna del giorno per persona** (area 3):
  l'evento «Giulia Ferri ha eliminato ACQ-14 «titolo»», dove la task si
  vedeva.

### Annullare quando altri hanno già visto *(scelta del costruttore)*

È il caso delicato: Giulia fa assegnare ACQ-14 a Marco, Marco riceve la
notifica e apre la task, poi Giulia preme «Annulla».
- L'assegnazione torna com'era (se Marco non l'ha toccata nel frattempo).
- La notifica di Marco **non sparisce**: dice «Annullato da Giulia Ferri»,
  e il segno si **deriva a lettura** dall'azione annullata, non si scrive
  nell'evento della notifica (invariante del CLAUDE.md: «I campi che un
  client legge su una card di inbox si derivano a lettura»).
- Annullare non genera una seconda notifica a Marco *(scelta del
  costruttore: la prima, segnata «Annullato», basta)*.

## 3. Trasparenza: «Claude per conto di [persona]» *(maintainer)*

La frase compare **ovunque** resti traccia di un'azione fatta dal riquadro:
- **registro delle modifiche** (area 9): la voce ha `actorId` uguale alla
  persona e `via: "claude"`. La frase viene dallo stesso template i18n con
  un prefisso: «Claude per conto di Roberta Fontana ha archiviato OLV». Il
  filtro «Persona» la trova sotto Roberta, e un filtro nuovo «Fatte con
  Claude» le isola *(scelta del costruttore)*;
- **commenti**: l'autore è la persona e la testata dice «Claude per conto
  di Giulia Ferri». La persona può modificarlo ed eliminarlo come un suo
  commento: è suo (regole dei commenti del 5 ott 2026);
- **notifiche**: «Claude per conto di Giulia Ferri ti ha assegnato
  ACQ-14»;
- **storia della task** e **rassegna del giorno per persona** (area 3):
  l'evento conta per la persona, col segno di Claude.

Una **bozza** che la persona invia è **sua**: non porta «per conto di»
*(scelta del costruttore, lettura delle decisioni 8 e 9)*. Il segno vale per
le azioni che Claude **esegue**. Una bozza invece la rilegge e la manda la
persona, e il segno «Bozza di Claude» ha già detto da dove veniva finché
c'era.

`via` è un campo **facoltativo** in ogni forma in cui compare (voce del
registro, commento, notifica). Le righe nate prima lo leggono assente, e i
client vecchi lo scartano (regola dei cambi additivi del CLAUDE.md).

## 4. Rispondere sui dati *(maintainer)*

- Claude risponde su **tutto ciò che chi chiede può vedere**, e solo su
  quello: task, richieste, progetti, planning, Docs, Drive, decisioni,
  brief, consumi (con il permesso), rilasci, supporto, automazioni, la
  propria posta e il proprio calendario (mai quelli altrui:
  `mailbox_owner`).
- **Fatti, non ipotesi** *(maintainer: anti-obiettivo)*:
  - ogni numero e ogni affermazione su un oggetto cita l'oggetto, col suo
    codice apribile;
  - ciò che Claude **deduce** porta il segno «Ipotesi» ed è scritto come
    tale («Forse aspetta il cliente: l'ultima risposta è sua, di 12 giorni
    fa»). Una deduzione non è mai nella prima riga di una risposta *(scelta
    del costruttore)*;
  - un dato che manca si dice («Non ho i consumi di settembre»), non si
    stima.
- **Corto** *(maintainer: anti-obiettivo)*:
  - la prima riga risponde alla domanda;
  - un elenco si ferma a **5 righe**, poi «e altri N · apri l'elenco», che
    porta alla pagina filtrata. N conta solo ciò che chi chiede vede;
  - il resto (come l'ho calcolato, le fonti) sta chiuso sotto «Dettagli».
  *(scelta del costruttore per numeri e forma)*
- **Testo generato**: un riassunto lungo (la settimana di un progetto, una
  conversazione) porta l'etichetta «Testo generato» come le descrizioni dei
  commit nell'area 3. Il brief ufficiale resta quello settimanale e
  automatico: un riassunto del riquadro non lo sostituisce e non si salva
  come brief.

## 5. Agire sull'app *(maintainer)*

- Claude prepara le azioni del catalogo (parte 2) con la classe giusta.
- Ogni azione eseguita è una **riga** nella conversazione: cosa, su cosa,
  il risultato col codice, «Annulla».
- Le **azioni in blocco** («archivia i progetti senza attività da 3 mesi»)
  sono una scheda sola con l'elenco. Ogni riga dice il perché in un fatto
  («ultima attività: 4 ago»). Si può togliere una riga prima di
  confermare.
- Ciò che non si può fare **non entra nella scheda**. Sotto la scheda una
  riga dice perché, senza nominare ciò che non si vede:
  - «Su 2 di questi non puoi archiviare · Who?»: progetti che la persona
    vede ma non gestisce;
  - «MKX ha un lavoro di Claude in corso: si archivia quando finisce»
    (`busy` del 9c).
- Un'azione che fallisce alla conferma (permesso perso, oggetto cambiato)
  chiude la scheda come «Non eseguita» col motivo, come nell'area 3. Non
  resta nulla a metà.

## 6. Automazioni *(maintainer)*

Claude scrive il flusso, lo prova su dati d'esempio e apre il costruttore
con la bozza compilata e l'esito della prova. L'automazione resta **spenta**
finché non la accende la persona.

### Scrivere

- Claude scrive un `AutomationFlow` con **solo i blocchi del motore**:
  inizi, passi, condizioni, «Per ogni», «Ripeti finché». Le tre regole
  dell'area 7 valgono anche per ciò che Claude scrive: approvazioni vere,
  passi di Claude che scelgono solo fra le uscite disegnate, tutto
  tracciato.
- Il flusso passa da `validateFlow` **prima** di esistere. Se ci sono
  problemi, Claude ne corregge da solo solo quelli meccanici (un campo
  mancante che si ricava dalla richiesta). Per gli altri chiede, con una
  scheda di scelta («Quale reparto avviso? Support · Sviluppo · Altro…»)
  *(scelta del costruttore)*.
- **Approvazioni** *(scelta del costruttore)*: i passi che restano dentro
  Stubwise (crea task, avvisa) nascono «Parte da solo». Un passo «Manda
  email» nasce sempre «Chiede approvazione al proprietario». Claude lo dice
  nella riga che riassume il flusso.
- Se la richiesta chiede qualcosa che il motore non sa fare, Claude lo dice
  e propone la cosa più vicina che il motore sa fare. Non inventa un passo.
- **Progetto**: dal contesto (un'automazione di ACQ se si è in ACQ),
  altrimenti Claude chiede. Serve `automations.manage` lì, o d'istanza per
  una generale.
- **Senza permesso**: Claude descrive in parole il flusso che costruirebbe e
  mette «Who?». Non crea niente.

### Provare

- Creare la bozza (`createAutomation`, spenta) e salvarla (`saveDraft`)
  sono **classe A**: sono della persona, e «Annulla» la elimina
  (`deleteDraft`).
- Claude avvia la prova (`startSimulation`) su un **evento d'esempio**: uno
  reale recente della sorgente, se la persona lo vede, altrimenti uno
  scritto da Claude, etichettato «Evento d'esempio scritto da Claude».
- La prova avanza fino alla fine, o fino al primo passo che **aspetta una
  persona**. Lì si ferma: «Qui si fermerebbe per l'approvazione di …».
  Claude non approva nella prova: l'approvazione blocca davvero, anche
  nella simulazione (area 7, regola 1).
- La prova non ha effetti, come sempre (area 7).

### Aprire il costruttore

- Finita la prova, Claude scrive in una riga cosa succederebbe («Nascerebbe
  una task per Support e avviserebbe 4 persone») e **apre il costruttore**
  nell'area principale. Il costruttore mostra la bozza e la prova con il
  suo esito (la vista della simulazione dell'area 7).
- Il riquadro **resta aperto** sopra il costruttore *(scelta del
  costruttore)*. La pagina lasciata tiene il suo stato (campi non salvati,
  filtri, scorrimento), e il riquadro mostra «Torna a <pagina>».
- **Accendere** è un clic della persona nel costruttore, col dialogo
  dell'area 7 («Da adesso agisce con i tuoi permessi»). Claude non lo
  propone come azione e non lo esegue *(maintainer)*.

### Cosa serve al motore *(scelta del costruttore)*

Lo scenario del maintainer («quando arriva una richiesta di supporto
urgente, crea una task e avvisa il reparto») chiede due cose che il motore
dell'area 7 non ha. Si aggiungono qui, piccole e dichiarate:
1. **Due dati sull'inizio `request_created`**: `richiesta.urgenza` (bassa,
   media, alta, da `ProjectRequest.urgency`) e `richiesta.dal_supporto`
   (sì/no, da `ProjectRequest.origin`). Così «urgente e dal supporto» è una
   **condizione**, un fatto, non una scelta di Claude.
2. **«Avvisa» un reparto**: `PersonTarget` accetta `{ departmentId }`.
   L'avviso va ai membri del reparto **che vedono il progetto** (R-G5). La
   configurazione segnala il reparto dove nessuno lo vede, come fa già per
   un approvatore che non vede il progetto.

L'alternativa scartata per l'urgenza è un passo di Claude che giudica
«è urgente?». Funzionerebbe, ma metterebbe un giudizio dove c'è già un dato.

## 7. Riassunti e bozze *(maintainer)*

- Claude scrive nel **campo vero** dichiarato dalla pagina (parte 1) e
  mette accanto il segno **«Bozza di Claude»**.
- Il segno **resta finché la persona non modifica la bozza o non la
  invia** *(maintainer)*. Alla prima modifica sparisce; all'invio sparisce
  e il testo è della persona.
- Se il campo ha già del testo, Claude chiede «Sostituire o aggiungere
  sotto?», come «Ask Claude» della Posta *(scelta del costruttore)*.
  «Annulla» rimette il testo di prima.
- La bozza **non si salva e non si invia da sola**. Non c'è nessuna azione
  «invia» nel catalogo.
- **Una regola sola per tutte le bozze di Claude** *(scelta del
  costruttore)*. Le bozze che esistono già seguono questa regola del
  segno:
  - Posta: oggi dopo una modifica mostra «Modificata dalla bozza di
    Claude» (`ClaudeDraftButton.tsx`);
  - Supporto: il campo `claudeDraft`.
  Con questa regola la riga «Modificata dalla bozza di Claude» non c'è
  più. Lo si scrive nella parità.
- Cosa entra nella bozza: solo ciò che chi scrive vede, e per un testo che
  esce (cliente, email) **niente** nomi del team, stime né commenti
  interni. È la regola di `draftText` del Supporto (area 8a), estesa a
  ogni bozza che esce.
- **Note di rilascio di una PR**: oggi la PR non ha un campo per le note.
  L'area 10 aggiunge alla PR il campo facoltativo «Note di rilascio»,
  modificabile da chi può modificare la task della PR o mergiarla. Si
  mostra nel dettaglio del rilascio dopo il merge *(scelta del
  costruttore; dove sta nella pagina lo decide lo shape)*.

## 8. Suggerimenti discreti *(maintainer)*

- In alcune pagine compare **una riga** «Claude può aiutarti a…» che apre
  il riquadro con la richiesta **già scritta e non inviata**: la persona
  preme Invio, o la cambia.
- Claude **non agisce mai** di sua iniziativa *(maintainer)*: la riga
  scrive una richiesta, non fa niente.
- Le proposte che esistono già (pulse, domande, piani) **restano dove
  sono** *(maintainer)*. Una riga non compare su un oggetto che ha già una
  proposta, una domanda o un piano aperti.

Regole della riga *(scelta del costruttore)*:
- **al massimo una** per pagina, sotto la testata, in tono quieto;
- compare solo se la persona **può fare** ciò che la riga propone (niente
  «Who?» in un suggerimento);
- «Non ora» la nasconde per quella pagina e per quella persona, in
  `localStorage` con try/catch: è una comodità, non uno stato che deve
  durare;
- il testo non contiene nulla che la persona non veda (R-G5).

Le pagine di partenza *(scelta del costruttore)*:

| Pagina | Quando | Riga |
|---|---|---|
| Conversazione di supporto | aspetta una risposta del team | «…scrivere la risposta» |
| PR nella coda di rilascio | senza note di rilascio | «…scrivere le note di rilascio» |
| Automations | nessuna automazione nel progetto | «…costruire un'automazione» |
| Panoramica di un progetto | ha task ferme | «…capire perché è fermo» |
| Consumi (`usage.view`) | sempre | «…riassumere la spesa del mese» |

## 9. Gli scenari *(maintainer: tutti)*

Ogni scenario gira sui dati veri del prototipo, con la persona del «vedi
come». Le risposte sono **calcolate**, non testi fissi: dopo un'archiviazione
la domanda successiva lo sa.

### S1 — Costruire un'automazione

Laura (Project Lead in ACQ), dalla sezione Support di ACQ: «quando arriva
una richiesta di supporto urgente, crea una task e avvisa il reparto».
1. Claude chiede quale reparto, con una scheda di scelta (Support
   consigliato).
2. Scrive il flusso: inizio `request_created` con la condizione
   `richiesta.dal_supporto` è sì **e** `richiesta.urgenza` è alta; poi «Crea
   task» per il reparto Support, scadenza 1 giorno; poi «Avvisa» il reparto
   Support. `validateFlow` non trova problemi.
3. Crea la bozza `ACQ-A<n>` (classe A, con «Annulla»).
4. Prova su una richiesta urgente vera di ACQ: nasce una task per Support
   e partono 3 avvisi. Prova su una non urgente: il ramo non parte.
5. Apre il costruttore con la bozza e la prova. Riga finale: «È spenta:
   accendila dal costruttore quando ti va bene».

Il caso negativo: Sara (Contributor) chiede la stessa cosa. Claude descrive
il flusso in tre righe, dice che non può crearlo in ACQ e mette «Who?».

### S2 — «Quali progetti sono fermi e perché?»

- La prima riga: «3 progetti hanno task ferme». Poi l'elenco con, per
  ognuno, il fatto: «ACQ — 4 task ferme, la più vecchia da 12 giorni
  (aspetta una risposta)». Il motivo viene da `stallOf`
  (`domain/stalled.ts`) e dal blocco «Fermo» del polso.
- Un'eventuale lettura in più porta il segno «Ipotesi».
- Contano solo i progetti che chi chiede vede: Giulia e Roberta ricevono
  risposte diverse sullo stesso seme, e nessuna delle due nomina o conta gli
  altri.

### S3 — «Quanto abbiamo speso in AI questo mese?»

- **Roberta** (`usage.view`): il totale del mese dal 1° a `now()`, il
  confronto col budget mensile (9b) e i 3 progetti che spendono di più.
  Link a Consumi.
- **Laura** (solo `project.usage.view` in alcuni progetti): «Nei progetti di
  cui vedi i consumi: $X», con l'elenco. **Nessun totale d'istanza**, né
  come numero né come «di più». Riga finale: «Il totale lo vede chi ha
  “vedere i consumi” · Who?».
- **Sara** (nessuno dei due): «Non vedi i consumi di nessun progetto ·
  Who?».
- L'aggregato «Other projects» lo mostra solo a chi ha `usage.view`, come
  la pagina Consumi del 9b.

### S4 — «Archivia i progetti senza attività da 3 mesi»

Roberta, da All projects:
1. Claude calcola l'ultima attività di ogni progetto visibile su `now()` e
   la mostra per riga.
2. Scheda B con l'elenco dei progetti archiviabili. Sotto, in righe a
   parte: quelli `busy` («ha un lavoro di Claude in corso») e quelli che
   Roberta vede ma non gestisce, con «Who?». RNC, già archiviato, non
   compare.
3. Conferma: tutti archiviati insieme, o nessuno. Ogni progetto ha la sua
   voce «Claude per conto di Roberta Fontana ha archiviato …» nel registro.
4. «Annulla» li riapre tutti, se nessuno li ha toccati nel frattempo. Le
   automazioni si riaccendono solo se lo erano (regola del 9c).

Giulia, con la stessa frase, riceve solo i progetti che gestisce.

### S5 — «Invita Luca come Developer in ACQ»

- Luca Bianchi **esiste già** nell'istanza. Claude lo dice («Luca Bianchi
  è già in Stubwise: lo aggiungo ad ACQ come Developer») e prepara
  `addMember`, classe C. Il seme garantisce che Luca non è membro di ACQ.
- Scheda («Aggiunge Luca Bianchi ad ACQ come Developer · lo avvisa»), poi
  «Conferma», poi il codice, poi l'aggiunta. Le regole del 9a valgono
  intere: un ruolo con permessi che chi agisce non ha è `escalation`, e la
  scheda lo dice prima della conferma.
- Se ci sono **più Luca**, una scheda di scelta. Se **non c'è nessun
  Luca**, è un invito vero: il link d'invito è un segreto, quindi Claude
  apre il dialogo «Invita» già compilato (email da scrivere, ruolo,
  progetto) e il link lo mostra l'app, una volta.
- Chi non vede ACQ riceve «Non trovo il progetto ACQ», la stessa frase di
  un codice inesistente.
- «Annulla» toglie Luca da ACQ (`removeMember`, di nuovo con il codice se
  la finestra di grazia è scaduta).

### S6 — Bozza nel contesto: risposta a una conversazione di supporto

Davide, sulla conversazione di supporto `ACQ-S<n>` che aspetta il team:
dalla riga «Claude può aiutarti a scrivere la risposta», poi Invio.
- La bozza va nel campo della risposta, col segno «Bozza di Claude».
- Il testo segue `draftText`: niente nomi del team, niente stime.
- Davide la ritocca e il segno sparisce; la invia lui.
- Chi non ha `support.reply` non vede la riga, e nel riquadro riceve «Non
  puoi rispondere a questa conversazione · Who?».

### S6b — Bozza nel contesto: note di rilascio di una PR

Laura, su una PR aperta di ACQ nella coda di rilascio: «scrivi le note di
rilascio».
- Claude legge la task della PR, i commit e la descrizione, e scrive nel
  campo «Note di rilascio», col segno.
- Ogni voce cita il codice della task; nessuna voce senza fonte.
- Il merge resta un gesto di chi ha `release.merge`, nella coda, a due clic.

### S0 — Le altre richieste *(maintainer)*

A una richiesta che non è fra quelle preparate, Claude risponde in modo
onesto: «Nel prototipo so fare queste cose:», seguito dall'elenco degli
scenari, ognuno cliccabile, che riscrive la richiesta nella casella. Non
c'è più la «risposta generica e plausibile» dell'area 3: era proprio un
testo che non diceva niente di vero.

Restano gli intenti dell'area 3 (stato, oggi, spiegami, come funziona,
file, avvia, crea, assegna, pianifica), con la regola nuova della
conferma.

## Quanto è vero nel prototipo *(maintainer: simulato con scenari)*

- **Nessuna rete, nessun modello.** Il motore di intenti deterministico
  dell'area 3 (`domain/claude/intents.ts`) si allarga con gli intenti degli
  scenari:
  - automazione;
  - progetti fermi;
  - spesa;
  - archivia gli inattivi;
  - aggiungi o invita;
  - bozza nel campo;
  - l'elenco onesto «so fare queste cose».
  Riconosce frasi en/it, varianti comprese («archivia i progetti fermi da
  90 giorni»).
- **Le risposte leggono lo stato vivo** con le letture della persona, e le
  azioni passano dalle mutazioni vere. Quello che si fa nel riquadro
  cambia davvero il prototipo, finché non si resetta.
- **Lo stream è quello di `data/stream.ts`**: testo e righe d'azione
  arrivano nel tempo, con la latenza del livello finto.
- **La prova delle automazioni** è la simulazione vera dell'area 7
  (`data/automations/simulate.ts`), non un testo che la imita.
- **La riconferma** è quella del 9a: codice fisso del riquadro «Prototype
  only».
- **I consumi** del riquadro si registrano come operazione `chat`
  (`data/instance/models.ts`), sul progetto del contesto se c'è.
- **Non è vero**: il linguaggio. Una frase fuori dagli intenti riceve la
  risposta onesta (S0), mai un'imitazione.

## Dati finti *(scelta del costruttore)*

Il seme si allarga quanto serve agli scenari, senza spostare gli indici
del seme di oggi (le aggiunte vanno in fondo, come per RNC nel 9c):
- **Progetti inattivi**: 4 progetti con l'ultima attività fra 95 e 140
  giorni prima di `CLOCK_START`. Fra questi:
  - uno che Giulia vede e gestisce;
  - uno che Roberta vede e Giulia no;
  - uno `busy` per un lavoro di Claude in corso;
  - uno che Laura vede ma non gestisce.
- **Supporto urgente**: in ACQ, una richiesta `high` nata da una
  conversazione di supporto e una `low`, per le due prove di S1. Più una
  conversazione `ACQ-S<n>` che aspetta il team, per S6.
- **PR senza note**: una PR aperta di ACQ nella coda di rilascio, con task
  e commit, per S6b.
- **Consumi del mese**: righe fra il 1° e `CLOCK_START` su almeno 5
  progetti, uno dei quali invisibile a Laura, per S3.
- **Membri**: Luca Bianchi non è membro di ACQ, e Laura ha
  `project.members.manage` in ACQ.
- **Conversazioni del riquadro**: due di Giulia nate dal riquadro, una con
  un'azione A annullata e una con una scheda B confermata, per vedere
  «Annulla», «Annullato da» nella notifica e la voce «per conto di» nel
  registro.
- **Una notifica** a Marco nata da un'azione di Claude per conto di Giulia
  e poi annullata.

## Parità e invarianti toccate

Il web non ha un riquadro di Claude: l'area non ha parità da chiudere. Le
voci nuove vanno in `apps/desktop/docs/area10-parity.md`, con dove vivono e
il test.

### Invarianti del CLAUDE.md che restano identiche

- **«Il registro decisioni non è MAI scritto dall'AI».** Il riquadro non ha
  `recordDecision` nel catalogo. A «registra la decisione che…» Claude
  risponde aprendo il dialogo «Registra una decisione» con progetto e task
  già scelti e il **testo vuoto**: lo scrive la persona. Il flusso della
  posta dell'area 6 (origine `email`, testo da template) resta com'è.
  Nessun testo di Claude entra nel registro delle modifiche: le frasi sono
  template, i valori sono dati.
- **«Stubwise non fa deploy: il merge è il confine».** Il catalogo non ha
  nessuna azione su ambienti, server o processi. Le etichette del riquadro
  entrano nel controllo `test/noDeploy.ts`.
- **I due divieti dell'operatore.** Approvare un piano e mergiare non sono
  nel catalogo, nemmeno per chi ha `plans.approve` o `release.merge`
  (vedi «Cosa Claude non fa»). Il riquadro non può essere una strada
  laterale a quei due gesti.
- **R-L9 / R-L11**: Claude collega resta com'è. «Per conto di» non è un
  permesso di Claude (vedi «Due Claude, due regole»).
- **`mailbox_owner`**: la posta e il calendario che il riquadro legge sono
  solo quelli di chi chiede.
- **Secondo fattore** (`second-factor.md`): la riconferma si dichiara in un
  posto solo (`REAUTH_REQUIRED`), e il catalogo la eredita da lì.
- **Ogni run AI dichiara un `UsageTag`**: il riquadro è operazione `chat`.

### Cosa cambia deliberatamente

1. **L'anti-obiettivo dell'area 3** («una modifica senza che l'utente
   l'abbia vista e confermata») è sostituito dalle tre regole di
   «L'anti-obiettivo dell'area 3 che cambia» *(maintainer)*.
2. **La regola «Le modifiche sono proposte da confermare» dell'area 3**
   lascia il posto alle classi A–D, anche nella destinazione «Claude»
   *(maintainer)*.
3. **La risposta generica e plausibile** dell'area 3, a una domanda non
   riconosciuta, lascia il posto alla risposta onesta *(maintainer)*.
4. **Il segno delle bozze della Posta e del Supporto** segue la regola
   unica *(scelta del costruttore)*.
5. **Il motore delle automazioni** guadagna due dati su `request_created` e
   l'avviso a un reparto *(scelta del costruttore)*.
6. **Una task si può eliminare** *(maintainer)*: azione nuova, anche a
   mano, con la voce `task.deleted` nel registro. Sul web oggi non c'è.
   Per il motore va scritto in `docs/invariants/` cosa succede a figli,
   collegamenti e codici: lo dice «Eliminare una task».

### Per il motore *(da scrivere prima del codice, come le §1–§11 dei follow-up)*

- **Gli strumenti del riquadro girano con la sessione della persona,
  lato server.** Il segno `via: "claude"` lo mette il server, sullo
  strumento chiamato, mai il client. Una richiesta che arriva col segno da
  un client è ignorata.
- **La classe di un'azione la calcola il server** sui dati del momento
  (notifica qualcuno? fa partire un'automazione?), come `canMerge`: il
  client la legge, non la deduce.
- **«Annulla»** è uno strumento a sé, con il controllo «l'oggetto è come
  l'ho lasciato» (una versione o un confronto di campi). È da scrivere come
  invariante, accanto a «Un commento eliminato non ha più testo».
- Va scritta in `docs/invariants/` la regola «Cosa Claude non fa», con un
  test sul **sorgente**: il catalogo non nomina le funzioni vietate. È lo
  stesso schema di `decisions-never-ai.test.ts`.

## Review Focus

1. **R-G5 nelle risposte.** Un conteggio («e altri 3»), un totale (la
   spesa d'istanza a chi non ha `usage.view`), un motivo che nomina un
   progetto invisibile, una riga di suggerimento, un elenco di scelta (più
   Luca), «Who?» con persone di progetti che non si vedono. Ci si aspetta
   lo stesso testo per invisibile e inesistente, ovunque.
2. **Una richiesta che tocca cose che la persona non può vedere.** «Archivia
   tutti i progetti di Mix Cucine», con uno visibile e uno no; «Quanto
   spende Roberta?». Claude deve rispondere sulla parte visibile **come se
   il resto non esistesse**, senza «solo quelli che vedi» detto in modo che
   faccia intuire il resto.
3. **Un'azione A che in realtà avvisa altri o fa partire un'automazione**
   *(maintainer: sono i soli due criteri)*. Una task «tua» in un progetto
   con un'automazione su `task_created`; una task tua il cui cambio di stato
   avvisa chi è iscritto agli avvisi del progetto; un filtro salvato che
   manda avvisi. Ci si aspetta che la classe salga a B, col motivo in una
   riga. Al contrario, **non** deve salire a B solo perché il risultato
   compare nelle liste del progetto, né una bozza nella casella della Chat,
   che nessuno vede finché la persona non la invia *(scelta del
   controller)*.
4. **«Annulla» dopo che altri hanno visto o toccato.** Marco ha aperto la
   task, Marco ha cambiato lo stato, Roberta ha riaperto un progetto
   archiviato da Claude, la persona ha perso il permesso, l'inverso chiede
   il codice. Ci si aspetta: un annullamento pulito, oppure un rifiuto
   detto in parole, e mai uno stato a metà.
5. **Strade laterali ai gesti delle persone.** Approvare un piano,
   mergiare, rispondere a una domanda, accendere un'automazione, registrare
   una decisione, creare un token: nessuna deve passare dal riquadro, né
   come azione né come «Modifica» di una scheda.
6. **Un segreto nella conversazione**: link d'invito, link di reset,
   chiavi, valori d'ambiente. Né nel testo, né negli eventi salvati, né nei
   risultati delle righe d'azione.
7. **Il «vedi come» a metà**: una scheda aperta da Giulia e confermata dopo
   il passaggio a Sara; un «Annulla» premuto da un'altra persona; la grazia
   della riconferma che passa da una persona all'altra.
8. **Automazioni**: una bozza scritta da Claude che arriva accesa; una
   prova con un effetto vero; un'approvazione approvata da Claude nella
   prova; un reparto avvisato con persone che non vedono il progetto.
9. **Il segno «Bozza di Claude»**: resta dopo una modifica, sparisce senza
   modifica, finisce in un testo inviato, copre il testo che la persona
   aveva già scritto senza chiedere.
10. **Ipotesi e lunghezza**: una deduzione scritta come fatto, un numero
    senza fonte, una risposta che non sta in una riga quando potrebbe.

## Lasciato al costruttore

- **La forma del riquadro**: larghezza, aggancio a destra, come convive col
  pannello della task a 1024 px, cosa succede a 800 px. La decide lo shape
  Impeccable, approvato dal maintainer prima dei task UI.
- **La scorciatoia** definitiva, se ⌘J confligge con qualcosa del sistema o
  di Electron.
- **Il meccanismo dei campi riempibili** (un registro per pagina, un hook),
  purché Claude non scriva mai in un campo non dichiarato o di un'altra
  pagina.
- **Dove sta il campo «Note di rilascio»** nella pagina della PR e del
  rilascio.
- **I testi esatti** delle frasi di Claude, in en e it, partendo da quelli
  dell'area 3 dove esistono.
- **Il caso di una richiesta che tocca cose che la persona non può
  vedere.** La regola è fissata (si risponde sul visibile, come se il resto
  non esistesse). Al costruttore resta la formulazione di ogni scenario, da
  provare in revisione con Sara, Giulia e Roberta sugli stessi dati.
- **Il caso di un'azione annullata dopo che altri l'hanno vista.** La
  regola è fissata (inverso come azione nuova, «Annullato da» derivato a
  lettura, nessuna seconda notifica). Al costruttore resta come si mostra
  nella notifica, nella storia della task e nel registro.
- **Come si confrontano «com'era»** per decidere se «Annulla» è ancora
  possibile: una versione dell'oggetto o i soli campi toccati.
- **L'elenco delle pagine con la riga di suggerimento**, oltre alle cinque
  di partenza, e i loro criteri.
- **Il riconoscimento delle frasi** degli scenari: quante varianti, purché
  ciò che non si riconosce riceva la risposta onesta.
- **Come si dividono i piani**, se l'area ne chiede più di uno. Una
  proposta: 10a riquadro, conferma, trasparenza e «Annulla»; 10b scenari,
  automazioni e bozze.

## Decisioni aperte

Nessuna del maintainer. Le *(scelte del costruttore)* qui sopra sono da
confermare.
