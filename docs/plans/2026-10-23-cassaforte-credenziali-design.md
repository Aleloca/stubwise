# Cassaforte delle credenziali — design

Data: 23 ott 2026. Terzo di tre progetti in sequenza: (1) appartenenza e
permessi (rilasciato il 23 ott 2026), (2) secondo fattore sul login
(rilasciato il 23 ott 2026), (3) questo. Discussione d'origine: 22 ott 2026
(rischi di tenere password in Stubwise, Bitwarden/Vaultwarden scartati,
scelta della cifratura nel browser).

## Perché

Oggi le credenziali dei servizi dei progetti (pannelli di hosting, console
cloud, registrar, account dei clienti) stanno in file Excel, uno per
progetto, condivisi a mano. Il maintainer le vuole in Stubwise, accanto al
progetto a cui servono, con un controllo vero su chi le legge. Stubwise però
gira su un VPS dove stanno insieme database, backup, chiavi d'istanza e un
agente AI con accesso al terminale: per questo le password si cifrano **nel
browser di chi le usa**, e il server conserva solo dati che non sa leggere.
Le credenziali servono **solo alle persone**, mai all'automazione.

## Obiettivi

- Credenziali per progetto, con **solo la password cifrata end-to-end**: chi
  ruba il VPS, il database o un backup non legge nessuna password.
- Ogni credenziale ha i suoi **lettori**: persone invitate direttamente o
  tramite un ruolo di progetto; i **full admin** leggono sempre tutto.
- Permessi di progetto nuovi per **creare**, **modificare** e
  **condividere**.
- Sblocco della cassaforte con **passkey** (Face ID / Touch ID / chiave
  fisica), niente frasi da ricordare.
- Inserimento **a mano dalla web** e **via API**, con la cifratura fatta dal
  client: chi inserisce non deve poter rileggere.
- Registro di chi ha mostrato o copiato quale password, e quando.
- **Kit di recupero** stampato per il caso peggiore.

## Non obiettivi (di questa versione)

- **App iOS/Android**: è il progetto successivo (modulo nativo per
  l'estensione PRF delle passkey, domini associati).
- Funzione di **importazione** (CSV o Excel): l'inserimento massivo si fa
  con uno script che usa l'API (vedi «Inserimento via API»).
- Il **codice 2FA dei servizi esterni** (segreto TOTP di un account
  condiviso).
- **Storico delle versioni** di una password.
- Uso delle credenziali da parte dell'agente, del worker o di qualunque
  automazione.
- Pubblicazione su npm della libreria di cifratura.

## Anti-obiettivi (fallimento anche se «funziona»)

- **Una password in chiaro che arriva al server**: in una richiesta, in un
  log, in un errore, in un backup. Il server riceve solo dati già cifrati.
- Una password, o una chiave che la apre, raggiungibile dall'agente, dal
  worker, dall'MCP, dalle chat AI, dalla ricerca o dagli embedding.
- I campi in chiaro di una credenziale (servizio, utente, URL, note) che
  finiscono in ricerca, chat AI, MCP, notifiche, webhook o log.
- Una password che si vede in un elenco: si mostra una alla volta, su
  richiesta esplicita.
- Restare chiusi fuori per sempre senza saperlo: le password perse per
  costruzione devono essere un caso estremo, previsto e recuperabile col
  kit.

## Cosa contiene una credenziale

- **Progetto**.
- **Servizio** (es. «Hetzner»): più credenziali possono avere lo stesso
  servizio.
- **Etichetta**, per distinguerle nello stesso servizio (es. «Account
  principale», «Sola lettura»).
- **URL** del sito.
- **Nome utente**.
- **Password** — **l'unico campo cifrato** (decisione del maintainer: gli
  altri servono a capire di quale account si tratta e non sono segreti).
- **Note**, testo libero, in chiaro (*mia osservazione*: chi le scrive deve
  sapere che non sono cifrate; la web lo dice accanto al campo).
- Chi l'ha creata, quando, ultima modifica.

## Permessi e accesso (decisioni del maintainer)

Tre **permessi di progetto** nuovi nel catalogo dei permessi
(`packages/shared/src/permissions.ts`), assegnabili ai ruoli come gli altri:

- **Creare credenziali** (*mio nome*: `credentials.create`). Chi crea una
  credenziale ne diventa automaticamente **lettore**.
- **Modificare credenziali** (`credentials.edit`): modifica i campi e la
  password di ogni credenziale del progetto. Anche **chi l'ha creata** la
  modifica, con o senza il permesso.
- **Condividere credenziali** (`credentials.share`): aggiunge o toglie
  lettori, **per persona** o **per ruolo di progetto** (es. «tutti i
  Developer»). **Per condividere bisogna anche essere lettori** di quella
  credenziale (decisione del maintainer): la condivisione è immediata
  perché chi condivide può ricifrarne la chiave.
- **Leggere** (vedere la password) è solo di chi è **invitato** a quella
  credenziale, direttamente o tramite un ruolo. Non è un permesso di ruolo:
  è un invito per credenziale.
- I **full admin** (`instance.full_admin`) leggono tutte le credenziali.
- **Elenco**: ognuno vede le credenziali che può leggere; chi ha
  `credentials.edit` o `credentials.share` vede anche le altre del
  progetto, senza password (deve poterle gestire). Nessun altro sa che una
  credenziale esiste.
- *Mie scelte*: eliminare una credenziale = `credentials.edit` o chi l'ha
  creata; i preset di ruolo esistenti non ricevono questi permessi tranne
  `Admin`/`Project Lead` (che li hanno tutti e tre) — il maintainer li
  assegna come crede.

## Il modello delle chiavi

Solo primitive standard del browser (WebCrypto), nessuna crittografia
inventata. Le scelte esatte di algoritmi sono del builder dentro questi
vincoli; *mia indicazione*: ECDH P-256 + HKDF + AES-256-GCM, che WebCrypto
supporta in Safari, Chrome e Node ≥ 22.

- **Chiave di ogni credenziale**: casuale, una per credenziale; cifra la
  password.
- **Coppia di chiavi di ogni persona**: la pubblica sta sul server in
  chiaro; la privata sta sul server **cifrata** con una chiave che si
  ricava dalla passkey (sotto).
- La chiave di una credenziale si salva **una volta per ogni lettore**,
  cifrata con la sua chiave pubblica. Leggere = scaricare la propria copia,
  aprirla con la propria chiave privata, decifrare la password.
- **Creare e cambiare la password non richiede di poterla leggere**: il
  client genera una chiave nuova e la cifra per le chiavi pubbliche di
  tutti i lettori (che il server fornisce). È così che funziona anche lo
  script via API.
- **Sblocco con passkey** (decisione del maintainer: niente frasi segrete).
  L'estensione **PRF** di WebAuthn fa produrre alla passkey un segreto che
  non lascia il dispositivo; da quel segreto il browser ricava la chiave
  che apre la chiave privata della persona. Il codice dell'app di
  autenticazione NON può fare da chiave: il server conosce il suo segreto.
  - Si usano le **passkey già registrate** in Impostazioni → Sicurezza
    (fase 2). Ogni passkey che supporta PRF apre la cassaforte in modo
    indipendente (la chiave privata è cifrata una volta per passkey).
  - Al primo accesso alla cassaforte, Stubwise verifica che la passkey
    supporti PRF; se no, lo dice e propone di aggiungerne una che lo fa.
    Supporto atteso: passkey del Portachiavi iCloud (Safari) e del Gestore
    password di Google (Chrome), chiavi fisiche recenti. Il builder lo
    verifica su dispositivi veri (Mac Safari, Chrome Mac e Windows) prima
    di affidarcisi.
  - Le passkey sincronizzate (iCloud, Google) funzioneranno anche nell'app
    del progetto successivo.
- **Cassaforte aperta**: resta sbloccata nella scheda per **15 minuti di
  inattività** (*mia scelta*), poi si richiude; si chiude anche chiudendo la
  scheda o col logout. La chiave privata vive solo in memoria nella
  scheda, mai in `localStorage`.

## Lettori che arrivano dopo, e la conferma (decisione del maintainer)

Chi diventa lettore quando la credenziale esiste già — una persona che
riceve un ruolo già invitato, un nuovo full admin — e chi **crea o ricrea**
la propria chiave (prima apertura della cassaforte, passkey perse) ha
l'accesso **in attesa**: il server non può ricifrare la chiave per lui.

Il passaggio **non è automatico**: lo **conferma una persona**. Il motivo è
che un login rubato (password + codice) basterebbe altrimenti a crearsi una
chiave «a nome di» qualcuno e farsi passare in silenzio le sue password.

- Chi può confermare: un **lettore** della credenziale che ha
  `credentials.share` nel progetto, oppure un **full admin**. La cassaforte
  aperta mostra «accessi da confermare»: chi è, quando è stata creata la
  sua chiave, da quale browser/dispositivo (dato registrato alla
  creazione), e per quante credenziali. Il testo invita a verificare con la
  persona (di persona, al telefono) prima di confermare.
- Confermare una persona passa la chiave di **tutte** le credenziali in
  attesa per lei che chi conferma può leggere; le altre restano in attesa
  di un altro lettore.
- Quando una persona **crea o ricrea** la sua chiave, riceve un **avviso di
  sicurezza** (push + DM Slack + inbox, lo stesso meccanismo della fase 2,
  *mio soggetto nuovo*: «chiave della cassaforte creata»): se non è stata
  lei, se ne accorge.
- Si può anche **rifiutare**: la chiave rifiutata non riceve nulla e la
  persona dovrà ricrearla (*mia scelta*).
- La condivisione **diretta** fatta da un lettore verso una persona che ha
  GIÀ una chiave confermata resta immediata (è un gesto esplicito, non un
  completamento in background).
- Una chiave conta come «confermata» per una persona dal primo momento in
  cui qualcuno la conferma; ricrearla la riporta in attesa.

## Revoca

Togliere un lettore (direttamente, togliendo il ruolo, o togliendo la
persona dal progetto) gli toglie la lettura **subito**: il server consegna
le copie della chiave solo a chi è lettore **in quel momento** (stesso
principio di `docs/invariants/permissions.md`, «la revoca si applica a
lettura»). In più le copie di chi non è più lettore **si cancellano** (*mia
scelta*): subito quando la revoca passa dalla gestione dei lettori della
cassaforte; per le revoche che arrivano da altrove (ruolo cambiato, uscita
dal progetto, admin declassato) alla prima operazione sulla cassaforte di
quel progetto. Una copia rimasta nel frattempo in database non basta da
sola: serve anche la chiave privata di quella persona. Se l'aveva già
vista, potrebbe ricordarla: la web propone di **cambiare la password** del
servizio subito dopo. Chi esce dal progetto perde la lettura di tutte le
credenziali di quel progetto, come per il resto di Stubwise.

## Mostrare e copiare

- Nell'elenco la password non c'è mai. **«Mostra»** o **«Copia»**, una voce
  alla volta.
- La copia negli appunti si cancella dopo **30 secondi** (*mia scelta*).
- La chiave di una credenziale si scarica **solo quando si mostra o si
  copia** (*mia scelta*: l'elenco non contiene copie delle chiavi), così il
  server registra ogni lettura nel **registro**: chi, quale credenziale,
  quando, mostra o copia. Lo vedono chi ha `credentials.share` o
  `credentials.edit` nel progetto e i full admin.
- Lo sblocco con passkey è già un secondo fattore fresco: nessuna
  riconferma ulteriore finché la cassaforte è aperta.

## Inserimento via API (decisione del maintainer)

Niente funzione di importazione: l'inserimento massivo dai CSV del
maintainer lo fa uno **script** scritto da Claude Code, che usa l'API con un
token personale di chi ha `credentials.create`.

- L'API di creazione e modifica accetta **solo password già cifrate** e le
  copie della chiave per i lettori. Il server non riceve mai una password in
  chiaro, nemmeno via API.
- La cifratura sta in **un modulo condiviso** (pacchetto del monorepo, *mio
  nome*: `@stubwise/vault-crypto`) che usano sia la web sia lo script:
  stessa funzione, stesso formato. Lo script gira dal monorepo in locale.
- Lo script **non deve far leggere i CSV a Claude Code**: gli si descrivono
  le colonne (o una riga finta), lui scrive lo script, lo script legge il
  file e cifra riga per riga senza stamparne il contenuto. La guida lo dice
  esplicitamente: se Claude legge il file, le password entrano nella
  conversazione e arrivano al fornitore del modello.
- Un token personale **non legge mai** una password: le rotte che
  restituiscono la copia cifrata della chiave sono solo da sessione web
  (*mia scelta*, difesa in profondità: decifrarla richiederebbe comunque la
  passkey).

## Kit di recupero (decisione del maintainer)

- All'**attivazione della cassaforte** sull'istanza (un full admin, una
  volta), Stubwise genera una **coppia di chiavi di recupero**: la pubblica
  va sul server ed è **lettrice di tutte le credenziali**; la privata si
  mostra **una sola volta**, da stampare o salvare offline, e non sta mai
  sul server.
- **Uso** (*mie scelte*): una pagina di recupero, raggiungibile solo da un
  full admin con riconferma recente (fase 2), dove si incolla la chiave di
  recupero. Il browser la usa **solo per confermare accessi in attesa**
  (di chiunque, non solo degli admin), con la stessa schermata di
  conferma; **non mostra mai una password**. La chiave non viene salvata.
  Ogni uso finisce nel registro di sicurezza e manda un avviso agli altri
  full admin.
- **Rigenerare il kit** (se si sospetta compromesso o è stato perso): un
  full admin con la cassaforte aperta; il browser ricifra le chiavi di
  tutte le credenziali per la nuova chiave di recupero. La vecchia smette
  di valere.
- Avvertenza da mostrare all'attivazione: chi ha il kit **e** il database
  legge tutto.

## Dove sta nella web

- Sezione **«Credenziali»** nella pagina del progetto: elenco raggruppato
  per servizio (servizio, etichetta, utente, URL), Mostra / Copia,
  creazione e modifica, gestione dei lettori, registro.
- Vista **«Le mie credenziali»**: tutte quelle che puoi leggere, di tutti i
  progetti.
- Attivazione della cassaforte e kit di recupero in un'area dei full admin.

## Isolamento dal resto di Stubwise

Invariante con test, nello stile del repo: le tabelle delle credenziali non
sono lette da ricerca, embedding, chat RAG e grafo, MCP, notifiche,
webhook, prompt dell'agente, worker. I log di Fastify già serializzano solo
metodo e URL; le rotte della cassaforte non mettono nulla dei corpi nei
log. Un test sul sorgente (come `decisions-never-ai.test.ts`) verifica che
i moduli del worker e dei percorsi AI non nominino le tabelle della
cassaforte.

## Limiti accettati

- **Server compromesso mentre lo si usa**: chi controlla il server *in quel
  momento* può servire una web modificata che ruba ciò che si sblocca, o
  dare allo script una chiave pubblica falsa, o aggiungere un lettore finto
  che il browser completerebbe in automatico. La cifratura end-to-end
  protegge dal furto di dati (VPS spento, database, backup), non da un
  server attivamente compromesso. È lo stesso limite di Bitwarden web.
- I campi in chiaro (servizio, utente, URL, note) sono leggibili da chi ha
  il database.
- Password perse per costruzione solo se tutti i lettori, tutti gli admin e
  il kit di recupero sono persi.
- **Cambiare il dominio** (`PUBLIC_URL`) rende inutilizzabili tutte le
  passkey, quindi nessuno apre più la cassaforte con la sua: si rientra col
  kit di recupero, ognuno ricrea la chiave e gli accessi si riconfermano
  (*mia scelta*: va scritto nella voce di deploy e nella guida, non si
  aggiunge un'impostazione separata).

## Rilascio

- Migrazioni: tabelle di credenziali, copie delle chiavi, inviti (persona o
  ruolo), coppie di chiavi delle persone e copie della privata per passkey,
  chiave pubblica di recupero, registro delle letture; i tre permessi nuovi
  nel catalogo (con la loro migrazione dei preset, se serve).
- Server e caddy insieme; il worker non c'entra (e non deve vedere le
  tabelle).
- Dopo il rilascio: un full admin attiva la cassaforte e custodisce il kit;
  poi ognuno, alla prima apertura, prepara la propria chiave con la
  passkey.

## Lasciato al builder

- Algoritmi esatti e formato dei dati cifrati (dentro i vincoli sopra),
  forma delle tabelle e delle rotte.
- Come si usa PRF con le passkey già registrate (se serve registrarle di
  nuovo con l'estensione attiva, lo si dice all'utente).
- Testi e layout, nello stile «terminal» della web.
- Il formato del kit di recupero (es. gruppi di caratteri leggibili +
  QR).
