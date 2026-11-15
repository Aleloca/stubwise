# Operazioni sui server (area 8, fetta 4b, 14 nov 2026)

La regola generale sta in CLAUDE.md, «Stubwise non fa deploy; il merge è il
confine dei RILASCI»: **una sola azione sull'ambiente, la correzione di un
problema di un server**, che non rilascia. Qui le regole di dettaglio; il
piano è `docs/plans/2026-11-14-integrazione-area8-fetta4b-plan.md`.

## L'insieme chiuso, e niente fuori

- Le azioni sono SOLO quelle di `SERVER_ACTIONS` (`@stubwise/shared`): oggi
  `container.restart`, `container.stop`, `container.start`, `docker.prune`
  (`images_unused`, `build_cache`, `stopped_containers`: ognuna un passo
  approvato a sé; ammessa su OGNI server, anche condiviso — F4b-8 = c — ma
  agisce su TUTTO il server, quindi prima dell'approvazione la vista dice
  quali ALTRI progetti tocca, calcolati dal server; l'approvazione resta
  `plans.approve` nel progetto attribuito) e le due letture `container.logs`, `container.state`. Ogni
  azione ha il suo schema dei parametri; il container è il NOME di un
  container che l'agente riporta, con la regex dei nomi di Docker; mai un
  pattern, mai un valore composto da un'uscita.
- L'agente ha una TABELLA dall'azione alla chiamata HTTP sul socket di
  Docker: un'azione o un parametro fuori dalla tabella si rifiuta PRIMA di
  toccare il socket. Non esiste un ramo «comando generico».
- Fuori per costruzione: deploy, pull o aggiornamento di un'immagine,
  creare o ricreare un container, `compose`, `exec`, `run`, volumi, reti,
  qualunque comando sull'host, qualunque stringa del modello.
  **Aggiungere un'azione all'insieme è un cambio di prodotto**, non una
  modifica di codice: va al maintainer, con la riscrittura di questo file e
  di CLAUDE.md.

## La firma e la consegna

- Il server firma con la chiave Ed25519 d'istanza (`instance_signing_keys`,
  privata cifrata a riposo come le credenziali, decifrata solo per firmare)
  la serializzazione CANONICA di `{ v, serverId, commandId, action, params,
  approvalId, issuedAt, expiresAt }`. Scadenza breve (10 minuti).
- L'agente verifica con la chiave pubblica FISSATA alla sua installazione
  (`STUBWISE_COMMAND_PUBLIC_KEY`), MAI scaricata dal server: chi controlla
  una risposta del server non può sostituirla. Rifiuta un comando di un altro
  server, scaduto, o con un nonce (`commandId`) già visto.
- Il canale è un PULL dell'agente sulla sua chiave `sk_…`
  (`GET /monitor/commands`), solo con `STUBWISE_OPERATIONS=1`. Il server
  consegna un comando UNA volta (UPDATE guardato `pending → delivered`) e
  accetta l'esito una volta. Nessuna porta aperta sull'host.
- La chiave `sk_…` autentica l'agente, NON autorizza un comando: chi la ruba
  può falsificare campioni ed esiti e «consumare» un comando, non farne
  eseguire uno.

## Chi, quando, dove

- L'analisi parte dal SERVER: da sola all'apertura di un episodio, o a mano
  da chi ha `servers.operate` in un progetto del server. Fa SOLO letture
  (metriche, servizi, controlli, episodi; le letture dell'agente con
  l'opzione accesa, senza approvazione; le letture SSH se collegato), nel
  budget mensile dell'istanza e nei tetti di Impostazioni.
- È l'analisi a dire QUALE progetto causa il problema, e l'attribuzione si
  VALIDA (`attributeServerCause`): il progetto deve usare quel server, i
  container citati devono essere legati ai suoi ambienti su quel server e a
  nessun altro progetto. Altrimenti «non determinato»: nessuna task di
  correzione, nessun piano. Un testo ostile non sposta il piano in un
  progetto dove chi attacca può approvare.
- Il piano appartiene al progetto attribuito: la task nasce lì, il piano è
  una sequenza di azioni dell'insieme chiuso sui SOLI container di quel
  progetto, e lo approva chi ha `plans.approve` in quel progetto, SEMPRE e
  PRIMA di ogni comando, anche quando lo ha chiesto lui stesso. Mai Claude,
  mai in anticipo: la pre-approvazione dei piani dei ticket non vale qui.
- Il modello propone il piano SOLO con uno strumento strutturato, validato
  dal server; il suo testo libero non diventa mai un comando.
- Un comando `change` si firma solo per un passo di un'approvazione non
  revocata con azione e parametri IDENTICI (un CHECK nel DB vieta un
  `change` senza approvazione), uno alla volta, dopo i ricontrolli:
  approvazione valida, sessione non fermata, server ancora in un ambiente del
  progetto, container ancora visto e ancora del progetto, agente con le
  operazioni accese. Un esito fallito ferma il piano.
- Lo Stop (e la revoca) ferma la sessione e cancella i comandi non ancora
  consegnati.
- **Confine di fiducia dichiarato** *(maintainer, 15 nov 2026)*: QUALI
  container sono di un progetto lo dicono gli ambienti
  (`environment_servers.containers`, o il container col nome dell'ambiente
  se la lista è vuota), e li lega chi ha `environments.manage` nel progetto.
  Un container già di un ALTRO progetto, anche per nome, non si lega (409);
  uno che NESSUNO ha legato sì, da chi ha quel permesso. È quel legame a
  decidere su quali container un piano del progetto può agire: chi lo dà
  dà anche questo.
- **Chi riceve l'esito** *(maintainer, 15 nov 2026)*: la diagnosi
  attribuita va agli iscritti del progetto attribuito; «non determinata» e
  «fallita» agli iscritti delle PRODUZIONI del server; chi ha chiesto
  un'analisi a mano riceve SEMPRE l'esito (`analysis_requester`), in una
  card sola anche se è già iscritto.

## L'SSH è solo lettura

- Un accesso SEPARATO per l'analisi, gestito da chi ha `servers.ssh.manage`
  (istanza). La chiave la genera il server: la privata cifrata a riposo,
  usata solo dal worker, mai in una risposta, un log, un prompt o un errore.
- L'utente (`stubwise-read`) è senza privilegi: la verifica rifiuta un
  utente in `sudo`, `wheel`, `docker` o con sudo senza password. La host key
  si FISSA alla verifica: un cambio blocca le letture.
- Solo le letture di `SSH_READS`, con argv FISSI e parametri numerici;
  `journal_errors` solo se l'utente è nel gruppo del journal. Mai una
  scrittura via SSH.

## Le uscite non sono fidate

- Ogni uscita di un server (log, stato, letture SSH, esiti) è contenuto NON
  fidato: troncata, delimitata nel prompt, mai eseguita, mai usata per
  comporre parametri. Un host compromesso può mentire nelle uscite; non può
  far firmare niente.

## Il registro

- Ogni comando firmato e ogni lettura (agente o SSH) lascia una riga in
  `server_commands` con chi l'ha chiesta, la sessione, l'approvazione,
  l'esito. Lo leggono chi vede la task e ha `servers.operate`, più chi ha
  `monitor.manage`; 90 giorni, poi la potatura.

## I test che reggono queste regole

- Uno negativo per ogni «vietato»: azioni fuori dall'insieme, stringhe di
  shell nei parametri, `change` senza approvazione o con una diversa o
  revocata, firma falsa / scaduta / ripetuta / di un altro server, operazioni
  spente (un socket finto conta le chiamate: zero), un'attribuzione spinta
  verso un altro progetto, `plans.approve` in un altro progetto, un utente SSH
  con privilegi, una host key cambiata.
- I golden col Claude vero (`server-analysis`, `server-analysis-hostile`,
  `server-fix-plan`, `server-fix-plan-deploy`): si rilanciano quando cambia
  il prompt, gli strumenti o il CLI.
