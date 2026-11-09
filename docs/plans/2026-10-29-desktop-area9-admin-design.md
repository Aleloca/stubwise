# App desktop Stubwise, area 9: Amministrazione, accessi e impostazioni — design

Data: 29 ott 2026. È il nono documento della serie. Accanto ci sono
l'ossatura (`docs/plans/2026-10-23-desktop-ossatura-design.md`) e i design
delle aree 2–8.

Si costruisce nel prototipo `apps/desktop`, con dati finti e le stesse
regole delle altre aree:
- ogni pagina è definita fino in fondo, con gli stati veri;
- i permessi si verificano col «vedi come»;
- il linguaggio visivo è quello di `apps/desktop/DESIGN.md`;
- UI e UX si definiscono con Impeccable: shape, poi costruzione, poi
  revisione.

Come leggere le marcature:
- *(maintainer)*: decisione presa nella conversazione del 29 ott 2026;
- *(scelta del controller)*: proposta confermabile, presa per non lasciare
  buchi a chi costruisce.

## Il principio *(maintainer)*

**L'app fa tutto quello che fa il sito, e di più.** Ogni funzione
d'amministrazione e d'impostazione del web ha un posto nell'app desktop.
Fanno eccezione solo le funzioni che le aree precedenti hanno già
**sostituito** di proposito (vedi «Non obiettivi»).

Il «di più» di quest'area sono tre cose nuove:
- il **registro delle modifiche**;
- **«Chi può farlo?»**;
- la pagina **Stato dell'istanza**.

L'elenco completo di partenza è l'inventario del 29 ott 2026 (sezione
«Parità con il web»). Ogni voce lì ha una parte e un posto.

## Tre piani: 9a, 9b, 9c *(maintainer)*

Il design è uno solo; i piani sono tre, ognuno con le sue revisioni e il suo
push:

- **9a — persone e accessi:**
  - ingresso: login col secondo fattore, registrazione su invito, primo
    avvio;
  - preferenze personali: account e password, sicurezza, token, Claude Code,
    lingua e tema;
  - in Amministrazione: persone, inviti, reparti, ruoli;
  - la sezione Members del progetto;
  - la riconferma col secondo fattore;
  - «Chi può farlo?»;
  - il registro delle modifiche (il meccanismo e le voci di 9a).
- **9b — istanza:**
  - AI: provider, modelli, automazione, budget e lingua, consumi;
  - account git, plugin, Google Workspace, archiviazione, webhook in uscita;
  - le viste di tutta l'istanza: server, repository, Stato dell'istanza.
- **9c — impostazioni del progetto:**
  - generali, AI del progetto, interruttori automatici;
  - repository (creazione guidata, modifica, webhook, file d'ambiente);
  - Integrazione, plugin del progetto, consumi del progetto;
  - archiviazione ed eliminazione del progetto.

**Cosa 9b e 9c usano di 9a**, quindi 9a deve offrirlo già *(scelta del
controller)*:
- la **riconferma** (`requireReauth`), usata da ogni azione delicata;
- il **registro delle modifiche**, come punto di estensione: 9b e 9c
  aggiungono i loro tipi di voce senza toccare il meccanismo;
- l'**intelaiatura di Amministrazione**: voci a sinistra filtrate per
  permesso, con 9b e 9c che aggiungono le loro;
- la **struttura del valore segreto**: si mostra una volta, poi si può solo
  sostituire (componente e regola del livello dati).

## Perché

L'ossatura ha lasciato come segnaposto:
- **Amministrazione**: `AdminPage` in `router.tsx`, che mostra solo
  `placeholder.pages.admin`;
- tre delle quattro sezioni delle **Preferenze**: `account`, `security`,
  `claude-code`;
- il blocco «Other» delle **impostazioni di progetto**.

Le aree 4, 7 e 8 vi hanno rimandato per nome:
- il webhook in uscita;
- la vista di tutti i server;
- la pagina Membri, che serve ad assegnare `servers.operate` e
  `servers.ssh.manage`, oggi presenti solo nel seme (`data/seed/grants.ts`);
- inviti, reset e identità della pagina Team.

Senza quest'area il prototipo non risponde a una domanda che ogni
amministratore si fa il primo giorno: come do o tolgo un accesso, e come
vedo chi ha fatto cosa.

## Obiettivi

1. Tutte le funzioni d'amministrazione e d'impostazione del web, con le
   stesse regole di permesso. Sono le voci A–E della «Parità con il web».
2. **Members del progetto**: chi c'è, con che ruolo e con quali permessi in
   più, e da dove viene ogni permesso.
3. **Reparti** gestibili dall'amministrazione. È una voce nuova, senza
   equivalente web.
4. **Registro delle modifiche**, **«Chi può farlo?»**, **Stato
   dell'istanza**.
5. **Ingresso simulato**: login, secondo fattore, invito, primo avvio.
6. **Archiviare** un progetto e riaprirlo; l'eliminazione vera resta solo
   ai full admin.
7. Ogni modifica a ruoli e permessi **vale davvero** in tutto il prototipo
   finché non si resetta. Il «vedi come» la segue *(maintainer)*.

## Non obiettivi

- **Le funzioni già sostituite restano fuori** *(maintainer)*:
  - Slack: c'è la Chat interna (area 4);
  - le regole d'ammissione della posta e le regole d'instradamento della
    posta del progetto: ogni email è letta e classificata (area 6);
  - «Rigenera il brief»: il brief è settimanale e automatico (aree 2 e 3).
- Connessioni vere a qualunque servizio: provider AI, git, S3, Google,
  webhook, WebAuthn. Tutto è simulato, con un riquadro «Prototype only» dove
  serve scegliere l'esito.
- Il motore: backend, migrazioni, cifratura vera.
- Riavvii del worker, deploy, azioni sui server dalla pagina Stato
  dell'istanza.

## Anti-obiettivi

- **Un segreto che ricompare.** Una chiave API, un token, una chiave
  d'ingestione o un valore d'ambiente si vede una volta sola, al momento in
  cui nasce. Poi non torna mai nel DOM: si può solo sostituire.
- **Un'escalation.** Nessuno dà permessi che non ha. Tutte le strade sono
  coperte: ruoli, inviti, Members, reparti, persone. Non c'è invece una
  gerarchia fra persone *(maintainer, 30 ott)*: chi ha il permesso di
  gestione modifica chiunque.
- **Claude con un permesso di decisione.** Non da Members, non da un ruolo,
  non da un invito (R-L9 e R-L11 dell'8b).
- **Un'istanza senza full admin.**
- **Un registro che rivela.** Il registro delle modifiche e «Chi può
  farlo?» non mostrano mai progetti, persone o server che chi guarda non può
  vedere (R-G5).
- **Un'azione delicata senza riconferma.**

## Invarianti del CLAUDE.md che quest'area tocca

Le invarianti di `docs/invariants/permissions.md` e
`docs/invariants/second-factor.md` **valgono identiche** nel prototipo.
Quest'area le costruisce per la prima volta nell'app desktop:
- un progetto invisibile è come uno che non esiste;
- nessuna escalation (`escalation`);
- resta sempre un full admin;
- i full admin sono membri impliciti di ogni progetto;
- la revoca si applica a lettura;
- la riconferma si dichiara, e un PAT non la soddisfa mai;
- `security.alert` va solo all'interessato;
- un admin che azzera il secondo fattore di un pari grado è accettato,
  registrato e avvisato.

Due invarianti **cambiano deliberatamente**:

### «Bersaglio protetto» (`target_above`) non c'è più *(maintainer, 30 ott 2026)*

Sul web nessuno modifica chi sta sopra di lui (`target_above`, confronto
dei ruoli). Il maintainer: «Contano i permessi che una persona ha perché fa
parte di un ruolo o di un reparto, non la gerarchia. Se Laura ha i permessi
per poter modificare i permessi e i ruoli di altre persone, allora può
farlo».

Quindi:
- chi ha il permesso di gestione (`project.members.manage`,
  `users.manage`, `roles.manage`, `departments.manage`) modifica chiunque,
  anche chi ha più permessi di lui: gli toglie permessi, gli cambia il
  ruolo, lo allontana;
- l'`escalation` resta sul **dare**: si danno solo permessi che si hanno;
- restano anche il rifiuto su sé stessi (ruolo d'istanza, reset,
  disattivazione) e «resta sempre un full admin».

Prima del motore va riscritta l'invariante «Nessuna escalation, e il
bersaglio è protetto» di `docs/invariants/permissions.md`.

### «Stubwise non fa deploy» e le azioni dello Stato dell'istanza *(maintainer)*

Lo Stato dell'istanza permette due «azioni leggere»: **rilanciare un lavoro
fallito** e **mettere in pausa o riprendere la coda di un progetto**.

Nessuna delle due tocca un ambiente, un server o un processo. Agiscono solo
sulla coda di Stubwise, come il rilancio che esiste già sulla task. La frase
dell'invariante resta quindi vera.

La pausa della coda però è **nuova** (sul web non esiste). Va scritta
nell'invariante prima del motore: una coda in pausa non prende lavoro nuovo,
e il lavoro già partito finisce.

## Ingresso (9a) *(maintainer: dentro il prototipo)*

- **Login:** email e password, poi il secondo fattore se la persona ce l'ha
  (codice dell'app, passkey o codice di backup). L'errore si scrive in
  parole e non dice mai se l'email esiste. Il blocco dopo troppi tentativi è
  quello di `second-factor.md`.
- **Registrazione su invito:** il link dell'invito apre una pagina col nome
  di chi invita e i progetti offerti. Si scelgono nome e password. Un invito
  scaduto o revocato lo dice in parole.
- **Primo avvio:** su un'istanza vuota si crea il primo full admin. Il
  prototipo ci arriva con «Reset to empty instance» nel riquadro «Prototype
  only» del profilo *(scelta del controller)*.
  - **Vuota vuol dire vuota:** niente persone (tranne Claude), progetti,
    task, server.
  - Dopo il primo avvio l'admin entra in un'app senza progetti. Ogni pagina
    delle aree 2–8 deve reggere questo stato con il suo stato vuoto, e il
    piano 9a ha un task che lo verifica pagina per pagina.
  - «Reset prototype» riporta al seme.
- **Persona disattivata:** non compare nel «vedi come» e non entra dal
  login *(scelta del controller)*.
- **Rapporto col «vedi come»** *(maintainer)*: il «vedi come» resta e
  cambia persona senza rifare il login. «Esci» dal profilo porta al login.
  Dal login si entra con le persone del seme (password del seme mostrata nel
  riquadro «Prototype only»).

## Preferenze personali (9a) *(maintainer)*

Le sezioni stanno nelle Preferenze del profilo, accanto a Notifiche (area
8a):

- **Account:**
  - nome, email e foto;
  - cambio della password, che disconnette le altre sessioni (in parole);
  - progetti seguiti (rimando alla stella di All projects);
  - caselle Google personali: collega, riconnetti, scollega e interruttore
    «Proposals» per casella. È la «scheda dell'account» che l'area 6 dava
    già per esistente.
- **Sicurezza:**
  - app di autenticazione (QR e conferma);
  - passkey: aggiungi, rinomina, rimuovi;
  - codici di backup: quanti restano e rigenera (si vedono e si scaricano
    una volta);
  - sessioni aperte, con «Esci da questa»;
  - registro della sicurezza personale.
  - Tutte le azioni, tranne la rinomina della passkey, chiedono la
    riconferma.
- **Token:** crea, con nome e scadenza facoltativa, e revoca. Il token si
  vede una volta. Creare chiede la riconferma.
- **Claude Code:** il comando d'installazione monouso con il token
  incorporato (mostrato una volta) e i prompt suggeriti, come sul web.
- **Lingua e tema:** gli stessi controlli del menu profilo, che restano
  anche lì.

### La riconferma *(scelta del controller)*

È un dialogo dell'app, non del browser. Chiede il codice o la passkey e,
dopo, ripete l'azione che l'ha aperto. Se la persona non ha un secondo
fattore, propone di attivarlo lì, come fa il web.

Ogni azione delicata la **dichiara** nel livello dati (`reauth: true`), e
un test del registro controlla che nessuna azione delicata ne sia priva.
Nel prototipo, dopo una riconferma riuscita, la finestra di grazia è di
**10 minuti**, come in `second-factor.md`. La finestra vale **per persona**:
cambiare persona col «vedi come» non la passa all'altra, e tornare alla
prima la ritrova se non è scaduta *(scelta del controller)*.

**Iscrizione obbligatoria** *(scelta del controller, come il web)*: chi non
ha un secondo fattore entra, ma la prima azione delicata apre l'iscrizione
dentro la riconferma. Al login Sara non viene bloccata.

## Persone e accessi (9a)

### Amministrazione: com'è fatta *(scelta del controller)*

Si entra dal profilo. A sinistra c'è un elenco di voci, ciascuna visibile
solo a chi ha il permesso:

| Voce | Piano | Permesso |
|---|---|---|
| People | 9a | qualunque utente la legge; le azioni chiedono `users.manage` / `users.invite` |
| Departments | 9a | `departments.manage` (nuovo; di base Admin) |
| Roles | 9a | `roles.manage` |
| Change log | 9a | `changelog.view`, oppure le voci degli oggetti che si gestiscono |
| Who can? | 9a | chiunque (anche da ⌘K e dai bottoni spenti) |
| AI | 9b | `ai_providers.manage` · `settings.manage` · `usage.view` |
| Git accounts | 9b | `git_accounts.view` / `.manage` |
| Plugins | 9b | `plugins.manage` |
| Google Workspace | 9b | `integrations.manage` |
| Storage | 9b | `settings.manage` |
| Outgoing webhooks | 9b | `settings.manage` |
| Servers | 9b | `monitor.manage` |
| Repositories | 9b | `repos.manage` |
| Instance status | 9b | `settings.manage` |

Senza nessuna voce visibile, Amministrazione non compare nel profilo.
`canSeeAdmin` si allarga di conseguenza.

### People *(maintainer per il contenuto)*

L'elenco delle persone mostra:
- avatar, nome, email;
- ruolo d'istanza;
- reparti;
- progetti;
- stato: attiva, invitata, disattivata.

Si filtra per reparto, ruolo e stato.

Il dettaglio di una persona contiene:
- **Ruolo d'istanza:** Admin, User o un ruolo creato a mano. Chiede
  `users.manage` e la riconferma. Non si applica su sé stessi.
- **Progetti:** dove è, con che ruolo e con quali permessi in più. Si
  cambiano da qui come da Members, con le stesse regole.
- **Reparti:** in quali è, e se gestisce la Home del reparto.
- **Identità collegate:** email d'autore git e username Bitbucket. Si
  collegano e si scollegano, anche dagli autori osservati non risolti
  (stessa azione di Activity, area 3). Scollegare un'email git chiede la
  riconferma.
- **Reset della password:** un link monouso a scadenza da copiare, mostrato
  una volta. Chiede la riconferma.
- **Reset del secondo fattore:** con conferma e riconferma. L'interessato
  riceve `security.alert`.
- **Registro della sicurezza di quella persona** (`users.manage`).
- **Disattiva** *(maintainer)*:
  - la persona non entra più e sparisce dagli elenchi di chi si può
    assegnare;
  - le sue task restano assegnate, con «(deactivated)»;
  - il dialogo elenca le task aperte e chiede se riassegnarle a qualcuno;
  - si può riattivare.
  - Non si disattiva l'ultimo full admin, né sé stessi.

**Inviti** *(maintainer: nell'app solo chi invita)*:
- si crea un invito con email, ruolo d'istanza e progetti iniziali, ognuno
  con il ruolo; si offrono solo i progetti dove chi invita ha
  `project.members.manage`;
- il link si copia («consegnalo tu»);
- c'è l'elenco degli inviti in sospeso, con scadenza e revoca.

L'accettazione è la schermata di registrazione dell'Ingresso.

### Departments *(maintainer)*

- Si crea un reparto con nome e colore, presi dalla palette dei reparti di
  `DESIGN.md`.
- Un reparto si rinomina e si ricolora.
- Un reparto si elimina solo se nessuna task lo ha come reparto di
  pertinenza. Altrimenti il dialogo chiede dove spostarle, come per gli
  stati (area 2).
- Si mettono persone nel reparto: una persona può stare in più reparti.
- Si sceglie chi gestisce la Home del reparto (`department.home.manage`,
  oggi in `data/seed/departmentRoles.ts`).
- **Permessi del reparto** *(maintainer: un reparto può dare permessi)*:
  - un reparto può portare un insieme di **permessi di progetto**;
  - chi sta nel reparto li ha **in ogni progetto di cui è già membro**: il
    reparto non rende membri di un progetto;
  - esempio: «tutto il reparto Sviluppo risponde ai clienti» dà
    `support.reply` ai membri di Sviluppo, nei progetti dove sono membri.
  - Si impostano in Departments con `departments.manage`, sotto la regola
    anti-escalation: non si mette in un reparto un permesso che non si ha.
  - Entrano nel calcolo unico di `can()` come terza fonte, dopo il ruolo e
    le concessioni personali. Members e «Chi può farlo?» li mostrano come
    «dal reparto Sviluppo».
  - Togliere una persona dal reparto, o un permesso dal reparto, si applica
    a lettura.
- Claude non ha un reparto (ossatura), quindi non riceve mai permessi di
  reparto.

### Roles *(maintainer: come sul web)*

- Ci sono i ruoli d'istanza e i ruoli di progetto.
- I preset si modificano ma non si eliminano.
- I ruoli creati a mano si creano, si duplicano e si eliminano. Un ruolo in
  uso non si elimina: il dialogo dice chi lo ha.
- La tabella dei permessi ha gli 11 gruppi di `permission-groups.ts` del
  web, più i permessi locali del prototipo, ognuno con una frase che lo
  spiega.
- Per ogni ruolo si vede quante persone lo hanno, con il link all'elenco.
- Tutto chiede `roles.manage` e la riconferma.
- **Regole:**
  - un ruolo non può contenere permessi che chi lo modifica non ha
    (`escalation`);
  - i permessi di decisione dell'8b (R-L9/R-L11) si possono mettere in un
    ruolo, ma un ruolo non arriva mai a Claude, perché Claude non ha ruoli.

### Members del progetto *(maintainer)*

Members sta in Progetto → Settings, accanto a Stati e Repository.

- L'elenco mostra le persone del progetto con:
  - il ruolo di progetto;
  - i **permessi in più**, che possono essere concessioni personali (come
    `servers.operate`) o permessi di reparto;
  - **da dove viene ogni permesso**: «dal ruolo Developer», «aggiunto da
    Roberta il 29 ott».
- Chi ha `project.members.manage` aggiunge, toglie, cambia ruolo, aggiunge
  e toglie permessi. Ogni scrittura chiede la riconferma. Gli altri membri
  vedono l'elenco senza azioni.
- **Claude e i full admin non compaiono** *(maintainer)*. Una riga di testo
  sotto l'elenco dice che i full admin hanno accesso a tutto. Su Claude non
  c'è niente, perché la regola sta in «Chi può farlo?».
- **Permessi in più** *(maintainer)*: qualunque permesso di progetto, purché
  chi lo dà lo abbia. Per esempio «approvare i piani» a un Developer.
- **Regole** *(scelta del controller, allargando il web alle fonti del
  prototipo)*:
  - **`escalation`:** nessuno dà un ruolo, un permesso in più o un permesso
    di reparto che non sia nei **propri permessi effettivi** in quel
    progetto. I permessi effettivi sono ruolo, concessioni personali e
    reparto, compresi i permessi locali del prototipo (`drive.*`, `chat.*`,
    `servers.*`…).
  - **Niente `target_above`** *(maintainer, 30 ott)*: chi gestisce i
    membri modifica chiunque. Togliere un permesso non passa
    dall'`escalation`.
  - La regola sta in una funzione sola del livello dati, usata da Members,
    People, inviti, Roles e Departments.
  - non si toglie sé stessi se si è l'ultimo con `project.members.manage`;
    il messaggio lo dice in parole.
- `servers.operate` e `servers.ssh.manage` si assegnano da qui. Le
  concessioni del seme diventano righe normali, modificabili.

### Cosa diventa un permesso *(scelta del controller)*

Oggi il prototipo calcola i permessi in `data/viewer.ts` da `SPECS` (le
persone del «vedi come»), dai preset e dalle concessioni del seme. Con
quest'area **ruoli, membri, reparti e concessioni diventano stato del
livello dati**:
- il calcolo resta in **un** posto, nel livello dati;
- `viewerFor` lo legge;
- una modifica fatta in Members o in Roles cambia subito cosa può fare la
  persona, anche se è quella che sta guardando;
- «Reset prototype» torna al seme.

Le invarianti di `can()` per Claude (R-L9) restano dove sono, in testa.

**I permessi di Claude diventano un insieme fisso**, slegato dai ruoli
*(scelta del controller)*. Oggi `CLAUDE_PROJECT_PERMISSIONS` deriva dal
preset Developer. Con i preset modificabili, cambiare Developer cambierebbe
Claude in silenzio. Quindi:
- l'insieme si copia una volta, come costante;
- un test lo confronta con l'elenco dei permessi di lavoro di R-L9;
- modificare un ruolo non lo tocca.

Anche i permessi locali cablati su `key === "admin"` diventano permessi del
preset Admin, modificabili come gli altri.

I «permessi di decisione» che non arrivano mai a Claude sono quelli già
elencati in R-L9/R-L11, più `departments.manage`, `instance.status.view` e
`changelog.view`.

### «Chi può farlo?» *(maintainer: è il «di più»)*

Due direzioni:
- **Da un'azione:** si sceglie un'azione dal catalogo in parole («approvare
  un piano», «mandare in produzione», «avviare la correzione di un server»…)
  e un progetto. Esce l'elenco delle persone che possono farla, ognuna col
  **perché**: ruolo, concessione personale, full admin, reparto. Le persone
  che non possono non compaiono.
- **Da una persona:** cosa può fare, raggruppato come la tabella dei ruoli,
  con da dove viene ogni permesso; il progetto si sceglie in alto.

Regole:
- Chi guarda vede solo progetti e persone che può vedere (R-G5).
- Claude compare con la frase fissa «può lavorare, non decide» e con
  l'elenco dei permessi negati (R-L9).
- Il calcolo è **lo stesso** di `can()`: nessuna seconda copia della regola.
  Un test confronta, per ogni persona, azione e progetto del seme, la
  risposta di «Chi può farlo?» con `can()`.

**La usa chiunque**, sui progetti che vede *(maintainer)*. Ci si arriva in
tre modi:
- da Amministrazione, per chi la vede;
- da ⌘K, per tutti («Who can approve plans in ACQ?»);
- da un link «Who can?» accanto ai bottoni spenti per permesso, in tutte le
  aree.

Il link sostituisce il «con chi può farlo in grigio» dell'8b. Sara vede
quindi a chi chiedere, ma solo fra le persone dei progetti a cui ha
accesso.

## Il registro delle modifiche (meccanismo in 9a) *(maintainer: in due posti)*

- **Una voce** contiene:
  - chi;
  - quando;
  - cosa è cambiato, in una frase da template i18n (mai prosa generata);
  - prima e dopo, quando ha senso;
  - il progetto, se c'è;
  - il link all'oggetto.
- **Le voci nascono** da ogni scrittura d'amministrazione e
  d'impostazione:
  - in 9a: ruoli, permessi, membri, reparti, persone, inviti, reset;
  - in 9b: provider, modelli, automazione, budget, git, plugin, Google,
    archiviazione, webhook, server, Stato dell'istanza;
  - in 9c: impostazioni di progetto, repository, file d'ambiente, chiavi,
    archiviazione del progetto.
- **I segreti non entrano mai nel registro**: si scrive «la chiave è stata
  sostituita», mai il valore. Un test lo verifica per ogni tipo di voce che
  tocca un segreto.
- **Chi legge cosa** *(scelta del controller)*:
  - una voce d'istanza la legge chi ha il permesso che **gestisce
    quell'oggetto**: voci dei ruoli con `roles.manage`, dei provider con
    `ai_providers.manage`, delle persone con `users.manage`, e così via;
  - in più c'è un permesso nuovo, `changelog.view` (d'istanza, di base
    all'Admin): legge tutte le voci d'istanza;
  - le voci di progetto restano sempre filtrate per i progetti visibili
    (R-G5).
- **Dove si legge:**
  - in Amministrazione, per chi ha almeno una voce leggibile;
  - in Progetto → Settings → Change log c'è solo il progetto, per chi ha
    `project.settings.manage` o `project.members.manage` in quel progetto.
- **Filtri:** persona, progetto, tipo, periodo.
- **Il registro non si modifica né si cancella** *(scelta del controller)*.
  È fatto, come il registro decisioni.
- **Seme:** una ventina di voci degli ultimi 30 giorni, che coprono tutti i
  tipi.

## Istanza (9b) *(maintainer per il contenuto; forma: scelta del controller)*

### AI

- **Provider:**
  - catena di riserva ordinata: aggiungi (chiave API o setup-token, mostrati
    una volta), abilita o disabilita, riordina, prova, elimina;
  - per ogni account, la quota dell'abbonamento usata (le soglie sono quelle
    di «Quota degli account»).
  - Il risultato della prova si sceglie nel riquadro «Prototype only».
- **Modelli:** un modello per ogni operazione AI (triage, piano, fix,
  review, riassunti, backlog, notturni, docs, report, classificazione della
  posta, chat). Una nota spiega da dove viene il valore: impostazione, env o
  default.
- **Automazione:**
  - per tipo di task: auto-fix, soglia di effort, approvazione del piano da
    un effort in su, costo massimo per task;
  - revisione delle PR attiva, con costo massimo.
- **Budget e lingua:** budget mensile in $, oltre il quale i lavori si
  fermano; lingua dei contenuti generati.
- **Consumi** (`usage.view`):
  - costi, token e run per periodo;
  - tabelle per giorno, modello, progetto, provider e operazione;
  - una vista a due dimensioni.
  - I progetti che chi guarda non vede si sommano in «Other projects»
    (R-G5).

### Integrazioni

- **Account git:**
  - Bitbucket o GitHub: crea, modifica, valida, elimina (bloccato se un
    repository lo usa, con l'elenco);
  - il revisore predefinito.
- **Plugin:**
  - registra un plugin: URL https pubblico, ref e sotto-cartella;
  - aggiorna a un ref, rilancia lo smoke test, rimuovi;
  - mostra l'inventario di skill e hook.
  - Il dialogo di registrazione dice in parole che **registrare esegue già
    il codice del plugin** (CLAUDE.md, «Plugin e skill»).
  - Gli stati sono `materializing`, `ready` e `failed`, simulati.
- **Google Workspace:** registra le app OAuth (nome, domini, client id, e
  client secret mostrato una volta). Si elimina solo se non ci sono caselle
  collegate.
- **Archiviazione:** S3 compatibile (endpoint, regione, bucket, chiavi
  mostrate una volta), con l'interruttore degli allegati. Il risultato della
  prova si sceglie nel riquadro «Prototype only».
- **Webhook in uscita:**
  - abilita, formato (Slack, Discord, JSON generico) e URL;
  - un interruttore per ogni evento: i 13 eventi del web, più i tipi
    d'avviso del catalogo 8a/8b che hanno senso fuori, scelti in shape;
  - invio di prova, con l'esito simulato.

### Viste di tutta l'istanza

- **Servers:** tutti i server fra i progetti, compresi quelli senza ambiente
  (R-L7). Hanno la stessa riga della sezione Servers dell'8b, più la colonna
  dei progetti. Il dettaglio è quello dell'8b.
- **Repositories:** tutti i repository raggruppati per progetto, con il
  link alla loro pagina in Progetto → Settings (9c).
- **Instance status** *(maintainer: anche azioni leggere)*:
  - la coda dei lavori, per progetto e tipo, con età e stato;
  - i worker attivi e cosa stanno facendo;
  - la quota degli account AI in tempo reale;
  - gli ultimi errori, ognuno con il link alla task o al lavoro.
  - **Azioni** (`settings.manage`, con conferma e voce nel registro):
    - **Retry** su un lavoro fallito: è lo stesso rilancio della task. Le
      correzioni ferme seguono `pr-corrections.md` e non si toccano da qui.
    - **Pause / Resume** sulla coda di un progetto: il lavoro partito
      finisce, quello nuovo aspetta. La riga del progetto e la sua task
      dicono «queue paused by Roberta».
  - Lo stato si aggiorna da solo ogni 10 secondi (simulato).

## Impostazioni del progetto (9c) *(maintainer per il contenuto; forma: scelta del controller)*

Progetto → Settings ha queste sezioni:
- General;
- Statuses (area 2);
- Members (9a);
- AI;
- Automations, cioè gli interruttori;
- Repositories (con il modo per repository dell'8a);
- Integration;
- Plugins;
- Usage;
- Change log;
- Archive.

Ogni sezione si mostra in sola lettura a chi non ha il permesso di
modificarla.

- **General:** nome, descrizione e codice (il codice non cambia).
- **AI:** account preferito (Automatico o un account), con «Usa solo questo
  account».
- **Automations:**
  - Docs aggiornati ogni notte, report giornaliero, backlog discovery;
  - pulse, con i giorni fra un pulse e l'altro;
  - brief settimanale;
  - tetto alle correzioni sulle PR (0 = spento): diventa modificabile il
    `correctionCap` che oggi è solo nel modello.
- **Repositories:**
  - **creazione guidata** in quattro passi: account git, repository, ramo,
    verifica degli accessi, e poi i comandi di install e test;
  - **modifica** dei campi del web: nome, URL, ramo, account, account di
    review, comandi, grafo del codice, rami protetti;
  - **webhook** con «Configura automaticamente» e lo stato;
  - **file d'ambiente** per ambiente:
    - importa `KEY=value` o un `.env`;
    - i valori si possono solo scrivere: si vede il nome, mai il valore;
    - sostituisci, rimuovi.
- **Integration:**
  - chiave d'ingestione, DSN e snippet `init()`;
  - URL e autenticazione del webhook in arrivo;
  - URL e secret del webhook git;
  - guida SDK.
  - La chiave e il secret si mostrano una volta e si **rigenerano** con la
    riconferma. Dopo vedi solo le ultime 4 cifre.
- **Plugins:** i plugin del registro, accesi per sottrazione (default tutto
  acceso), per skill e per gruppo di hook, con «Applica il preset
  consigliato». Il limite noto del web («una persona per volta») resta, ma
  qui si evita: il salvataggio controlla la versione e avvisa se qualcuno ha
  cambiato nel frattempo *(scelta del controller: è un «di più» economico)*.
- **Usage:** i consumi del progetto (`project.usage.view`).
- **Change log:** la parte del registro di quel progetto.
- **Archive** *(maintainer)*:
  - **Archivia** (`project.settings.manage`):
    - il progetto sparisce da binario, All projects, ⌘K, Home e
      notifiche;
    - resta raggiungibile da All projects → «Archived» in sola lettura;
    - le sue automazioni si fermano;
    - nessun lavoro nuovo parte.
    - Si rifiuta (`busy`) se Claude ci sta lavorando o un rilascio è in
      corso, come R-L6, e il dialogo dice cosa aspettare.
  - **Chi vede «Archived»** *(scelta del controller)*: chi era membro e i
    full admin, in sola lettura. Per tutti gli altri il progetto resta
    invisibile (R-G5).
  - **Le notifiche:** quelle già ricevute spariscono **a lettura**, come
    una revoca, e ricompaiono alla riapertura. Non ne nascono di nuove.
  - **Riapri:** torna com'era. Le automazioni si riaccendono solo se lo
    erano.
  - **Elimina** (solo full admin, solo su un progetto archiviato):
    - il dialogo mostra cosa verrà cancellato, con i conteggi;
    - si conferma scrivendo il codice del progetto, poi con la riconferma;
    - l'eliminazione lascia la voce nel registro d'istanza.
    - I server e i repository rimasti senza progetto seguono R-L7.

## Permessi *(scelta del controller)*

**Permessi nuovi**, locali nel prototipo come gli altri dell'area 8:
- `departments.manage` (istanza): di base all'Admin;
- `instance.status.view` (istanza): leggere lo Stato dell'istanza. Di base
  all'Admin; chi ha `settings.manage` lo ha implicito. Le azioni restano a
  `settings.manage`.
- `changelog.view` (istanza): leggere tutte le voci d'istanza del registro.
  Di base all'Admin.

Tutti gli altri sono quelli del web, già nel registro di `@stubwise/shared`.
**Claude** (R-L9) non riceve nessun permesso d'amministrazione, e
`instance.status.view` e `departments.manage` entrano fra i suoi negati.

## Quanto è vero nel prototipo

- **Accessi:** ogni scrittura su ruoli, membri, permessi, reparti e persone
  cambia lo stato del livello dati e ha effetto su tutte le pagine.
- **Impostazioni** *(maintainer: gli effetti visibili)*: si salvano e
  finiscono nel registro. In più queste cambiano davvero ciò che si vede
  altrove:
  - **Budget mensile esaurito** (si simula dal riquadro): «Avvia», «Chiedi a
    Claude» e le automazioni si fermano col motivo in parole.
  - **Coda di un progetto in pausa:** come sopra, col nome di chi l'ha messa
    in pausa (vedi «Il lavoro nella coda»).
  - **Modello per operazione:** il modello mostrato nei run e nei consumi
    di quell'operazione.
  - **Account AI preferito del progetto:** l'account mostrato nei run del
    progetto.
  - **Interruttori del progetto:** spento il brief, la sezione del brief
    dice «spento»; spenti i Docs notturni, la pagina Docs non promette
    l'aggiornamento; spento il pulse, nessuna proposta nuova.
  - **Tetto alle correzioni:** il conteggio dei giri delle PR (area 8a)
    usa il valore nuovo.
  - **Archiviazione disattivata:** il Drive e gli allegati dicono che non si
    può caricare.
  - **Plugin del progetto spenti:** l'elenco delle skill nel run.
  - **Progetto archiviato:** vedi 9c.
  - **Non si simulano** i calcoli del motore: auto-fix, soglie d'effort,
    approvazione da effort. Si salvano e basta.

### Il lavoro nella coda *(scelta del controller)*

Il prototipo non ha job, ha run e sessioni. Lo Stato dell'istanza li legge
come «lavori»:
- run delle task;
- correzioni delle PR e review;
- analisi e correzioni dei server;
- sessioni di Claude avviate da automazioni;
- giro notturno: righe del seme, solo da guardare.

I **worker** sono simulati: 2 righe, con il lavoro che stanno facendo.

La **pausa** ferma tutto ciò che **partirebbe** nel progetto, comprese
correzioni, review e automazioni. Un «Avvia» a mano su una coda in pausa
**non è rifiutato**: il lavoro entra in coda come «waiting: queue paused by
Roberta» e parte alla ripresa. Il lavoro già partito finisce. È questa la
frase da aggiungere all'invariante.
- **Simulati, con esito scelto nel riquadro «Prototype only»:**
  - prove di provider, git, S3, webhook e plugin;
  - login e secondo fattore: la password del seme e un codice fisso, mostrati
    nel riquadro;
  - passkey: «Simulate passkey».
- **I segreti** stanno in un modulo a parte del livello dati, come
  `data/servers/secrets.ts` dell'8b. Nessuna lettura li restituisce dopo la
  creazione.

## Dati finti *(scelta del controller)*

- Un **ruolo creato a mano** per ciascun livello:
  - «Release manager» (progetto): Developer più `release.merge`;
  - «Auditor» (istanza): `usage.view` più `changelog.view`.
- Due **inviti in sospeso** (uno scaduto) e una **persona disattivata**
  con due task aperte.
- **Sara** ha il secondo fattore spento; tutte le altre persone del «vedi
  come» lo hanno.
- **Provider:** due account in catena, uno vicino alla soglia di quota.
  **Account git:** uno Bitbucket e uno GitHub. **Plugin:** due nel
  registro, uno `ready` e uno `failed`.
- Un **webhook** Slack acceso su 4 eventi.
- **Coda:** un lavoro fallito ieri e la coda di STW in pausa.
- **Progetto archiviato:** un progetto commessa, chiuso il mese scorso.
- **Registro:** ~20 voci degli ultimi 30 giorni.

## Parità con il web

L'inventario del 29 ott 2026 sta in `apps/desktop/docs/area9-inventory.md`
ed è il perimetro verificabile di «tutto il sito». Ogni voce ha la sua riga
in `apps/desktop/docs/area9-parity.md`, scritta dal task finale di ciascun
piano, con questi campi: voce del web, parte (9a/9b/9c), dove vive
nell'app, test.

In breve:
- **A. Personale:** tutto in Preferenze (9a). Il DM Slack resta fuori.
- **B. Persone e accessi:** tutto in Amministrazione e Members (9a). Le
  identità Slack e «Invita da Slack» restano fuori.
- **C. Istanza:** tutto in Amministrazione (9b). Restano fuori Slack e la
  posta ammessa.
- **D. Progetto:** tutto in Progetto → Settings (9c). Le regole della posta
  restano fuori; widget, ambienti, server e traguardi sono già fatti (aree 2
  e 8).
- **E. Server e repository d'istanza:** in Amministrazione (9b). In più, i
  grafici dei server arrivano a 30d e 90d come sul web, che oggi nell'8b si
  fermano a 7d.

## Lasciato al costruttore

- La forma di ogni pagina: la fissano gli shape Impeccable, uno per gruppo
  di pagine, approvati dal maintainer prima dei task UI.
- I testi esatti, che partono dal web dove esistono.
- Come si divide il livello dati dei permessi, purché il calcolo resti in un
  posto.

## Review Focus

1. **Escalation per una strada laterale:** un invito, un ruolo duplicato,
   un permesso messo in un reparto, una persona aggiunta a un reparto che
   porta permessi, un cambio fatto mentre il «vedi come» è su un'altra
   persona.
   Ci si aspetta `escalation` ovunque si dia qualcosa.
2. **Un segreto nel DOM o nel registro** dopo la prima volta: token, chiave
   d'ingestione, client secret, valori d'ambiente, link di reset.
3. **L'ultimo full admin**, e l'ultimo con `project.members.manage` in un
   progetto: si devono rifiutare con una frase.
4. **Un progetto archiviato che riappare**: in ⌘K, notifiche, Home,
   automazioni, Stato dell'istanza, «Chi può farlo?».
5. **«Chi può farlo?» che diverge da `can()`**, oppure mostra un progetto
   invisibile.

## Domande aperte per il maintainer

Il controllo del costruttore (29 ott 2026) ha posto dodici domande:
- **Quattro sono del maintainer**, e sono risolte nel testo:
  - un reparto dà permessi di progetto;
  - «Chi può farlo?» è per tutti;
  - le impostazioni hanno effetti visibili;
  - i permessi in più possono essere qualunque, entro i propri.
- **Le altre sono scelte del controller**, marcate nel testo:
  - regola `escalation` sui permessi effettivi (`target_above` tolto dal maintainer il 30 ott);
  - grazia della riconferma di 10 minuti, per persona;
  - permessi di Claude come insieme fisso;
  - `changelog.view`;
  - istanza vuota;
  - l'inventario in un file;
  - chi vede gli archiviati;
  - il modello dei lavori in coda;
  - iscrizione al secondo fattore;
  - persona disattivata fuori dal «vedi come».

Nessuna domanda aperta.
