# Registro dei rimandi dell'integrazione del prototipo desktop

Unico posto in cui sta **tutto ciò che è stato rimandato a una fase successiva**
durante l'integrazione del prototipo (`apps/desktop`) col backend vero, insieme
alle **decisioni già prese** su quelle cose. Le tabelle di parità
(`apps/desktop/docs/integration-*.md`) dicono cosa è stato fatto in una fetta;
questo registro dice cosa **deve entrare** nelle fasi che verranno.

**Regola (maintainer, 10 nov 2026)**: chi apre il design di una fase o di
un'area lo parte da qui. Ogni voce della sua area entra nel design (o resta qui
con un motivo scritto); alla chiusura della fase le voci fatte si spostano in
«Chiuse», con il commit o la tabella di parità che le chiude. Una decisione già
presa e scritta qui non si ridecide senza il maintainer.

Legenda: *(M)* decisione del maintainer, *(O)* scelta dell'orchestratrice,
*(S)* limite del server da colmare.

---

## Area 3 — Claude come collega (in corso)

- «Annulla il lavoro» DOPO il push *(O, 10 nov 2026)*: non vale più, la PR si
  apre comunque (il lavoro è già sul remoto). Accettato; da riguardare se un
  giorno serve «annulla e chiudi la PR».
- «Annulla il lavoro» col runner classico (`AGENT_STREAMING=false`) *(S)*: il
  CLI non si uccide a metà, vale solo il controllo fra i passi.
- «Annullato da» nella storia del ticket si perde al RICICLO del job *(O, 10
  nov 2026)*: la richiesta vale per un tentativo e ogni ripartenza la azzera,
  e la storia la legge dal job; come il `pr_opened`, che il riciclo perde già
  (limite dichiarato di `ticket-history`). Copiarla in `ticket_events` alla
  chiusura vorrebbe una migrazione: rimandato. Né `requeueStale` scrive il
  commento quando chiude uno stantio annullato.
- Il dettaglio della sessione non porta il piano né il suo digest *(S)*: il
  digest da rimandare ad approve/reject si legge da `/work` o da «Da decidere».
- Abbinare un commit per **username** del provider *(S)*: nessuna tabella lega
  un utente al suo login GitHub, quindi lo username (letto dalle noreply) si
  mostra ma non abbina; si abbina per email (account o `git_identities`).
- Chi ha avviato una sessione e chi ha risposto a una domanda (e quando) *(S)*:
  oggi non arrivano.
- Consumi per task (`usage`) e blocco d'istanza (`blocked`) in `/work` *(S)*.
- Allegati nei messaggi a una sessione *(S)*: il server non li accetta.
- `generatedAt` dei report giornalieri *(S)*.
- Report giornaliero per progetto (oggi si rigenerano tutti i progetti del
  giorno) *(O, differenza dal prototipo)*.

## Fase «Chat con Claude e azioni» (dopo l'area 3)

Design: `docs/plans/2026-11-10-integrazione-claude-chat-design.md`.

- Classi A/B/C/D come il prototipo, calcolate dal server *(M)*.
- Prima versione: azioni delle sole aree integrate (task, commenti, richieste,
  traguardi, filtri, avvio del lavoro, azioni della pagina) *(M)*.
- Fuori portata: risponde il modello; per un'azione non in catalogo dice che non
  può e dove si fa a mano *(M)*.
- **Conversazioni pubbliche e continuazione**, `claude.public.view`, conferma dei
  progetti, messaggi privati se Claude tocca un progetto nuovo: fetta 5, IN
  CORSO (piano `docs/plans/2026-11-10-integrazione-claude-chat-f5-plan.md`,
  decisioni del maintainer del 10 nov 2026: gli eventi dei tool restano
  visibili ai lettori, D1) *(M)*.
  - Renderer (F5.4) *(S)*: i codici nella prosa di Claude non si collegano
    nella build app (solo le citazioni registrate, che il server non
    registra): R-G5 regge per costruzione, ma neanche l'autrice apre un
    codice citato dalla prosa.
- «Claude can help you…» (suggerimenti nelle pagine) e le citazioni
  registrate sui messaggi (oggi solo i codici nel testo) *(O)*. Menzioni,
  riquadro come chat e ⌘J/⌘K: chiuse (sotto).
- Azioni delle altre aree: entrano **con la loro area** (sotto) *(O)*.
- **Limiti della fetta 5 (server e worker)** *(S, stubwise-72, 10 nov 2026)*:
  - **Ordine di «Public».** Si ordina per `updated_at`: il messaggio
    dell'autore in una pubblica fa salire la riga anche se il turno resta
    privato. Si vede che c'è attività, non il contenuto.
  - **Progetti letti o toccati (D2).** Non vede ciò che Claude ricava senza
    citarlo né leggerlo per codice o per id, cioè gli elenchi generici; la
    responsabilità resta della conferma dell'autore.
  - **La trascrizione dell'originale di una continuazione** è un'istantanea
    presa al «Continua» (`origin_transcript`), non letta dal vivo. Ha un tetto
    di 40 messaggi e 12.000 caratteri.
  - **La prosa di Claude** resta com'è, e un codice invisibile si mostra come
    testo (R-G5, il renderer).
- **La classe C (riconferma) arriva con l'area 9** *(S, 10 nov 2026)*: la
  fetta 4 della chat per ora è vuota. Nel prototipo una C è un'azione la cui
  funzione sta in `REAUTH_REQUIRED` (`data/auth/reauth.ts`): sono solo
  `admin.*`, `me.*` e `instance.*` (aree 8 e 9), e nessuna voce del catalogo
  delle aree 2–3 lo è. Il server ha già ciò che serve per la C: la
  riconferma dal desktop (0132). Le C entrano con le azioni di Claude
  dell'area 9.
- **Limiti della fetta 1 (runner)** *(S, stubwise-72)*: i tool di lettura sono
  sette (progetti, persone — dalla fetta 3, senza email —, cerca/leggi task,
  leggi richiesta, cerca docs, brief + registro decisioni). Non leggono commenti e storia della task, la pagina
  Docs intera, il codice o il grafo; restituiscono il JSON delle rotte
  compattato (senza chiavi da segreto, tetto 12.000 caratteri), non le viste
  delle pagine. Si allargano aggiungendo rotte di LETTURA a
  `CHAT_TOOL_READ_ROUTES` (col test del registro) e un tool al ponte.
- **Limiti della fetta 3 (worker)** *(S, stubwise-72)*: l'idempotenza di
  `propose_action` usa l'id del `tool_use` che il CLI passa nel `_meta` della
  chiamata MCP (`claudecode/toolUseId`, verificato sul 2.1.322). Se un CLI
  futuro smettesse di passarlo, il ponte conia un id nuovo per chiamata: la
  proposta funziona, ma un doppio invio della STESSA chiamata ne farebbe due.
  Da riverificare a ogni aggiornamento del CLI (il test del server MCP lo
  fissa solo lato nostro). Le firme delle azioni nel contratto si generano
  dagli schemi zod (`claudeActionSignatures`): `pageAction` di tipo
  `filter` vi compare, ma il modello non conosce le rotte del renderer: lo
  userà davvero solo dove la pagina gliele dà (F3.4).
- **Esito delle azioni della pagina salvato dal server** *(S, F3.4, review)*:
  oggi l'esito (D3) è del renderer, per persona e in memoria, e un'azione
  parte solo se arriva dal vivo in quella finestra; letta dalla storia (un
  ricaricamento, un riavvio, un'altra scheda del browser) resta «non
  applicata» col gesto «Apply». Salvato sul server, la riga direbbe l'esito
  vero anche dopo.
- Il contesto della pagina arriva al modello come `tipo: id`, non come il suo
  contenuto: Claude lo legge con i tool se serve *(S)*.
- Conservazione *(M, review delle fette 1–2)*: le conversazioni inattive da 14
  giorni si potano come le altre sessioni, con le trascrizioni del CLI; la
  casella lo dice. Nessuna chiusura per inattività (la conversazione resta
  aperta finché vive).
- Budget del mese finito: in chat nessuno lo scavalca (una conversazione non ha
  un progetto, quindi nessun `plans.approve`) *(S)*.
- **Limiti della fetta 2 (renderer, destinazione)** *(S, stubwise-72)*:
  - «#» propone task, progetti e (dall'area 5, fetta 1) pagine Docs, non le richieste; «@» le persone.
  - «/» ha i comandi di lettura (`/explain`, `/docs`) e, dalla F3.4, quelli
    d'azione (`/plan`, `/new-task`, `/new-request`, `/run`); `/status` e
    `/today` tornano quando i tool leggono progetti seguiti, decisioni e la
    settimana di chi scrive; niente skill dei plugin del progetto (il server
    non le espone).
  - Le citazioni registrate su un messaggio non esistono sul server: Claude
    cita col codice nel testo, che la pagina risolve (`resolveCodes`, task e
    richieste).
  - Il contesto è UNO per conversazione: un messaggio col chip di una pagina
    lo sostituisce (l'ultimo vince) e il turno lo ripete al modello; il
    contesto di progetto scelto all'inizio si perde dopo un messaggio con un
    chip di task.
  - Riquadro: il chip c'è per task, richieste, pagine e impostazioni di
    progetto; gli oggetti delle aree non integrate (rilasci, supporto, PR,
    automazioni, posta) non danno chip né contesto; le domande della doc di
    prodotto sotto il chip restano spente (`product-docs`, area 11).

## Area 4 — Chat

Design: `docs/plans/2026-11-10-integrazione-area4-chat-design.md`. Fetta 1
chiusa (sotto, «Chiuse»); invariante `docs/invariants/chat.md`.

Fetta 2 chiusa (sotto, «Chiuse»). Fetta 3: server e renderer (sotto, «Chiuse»).
Fetta 4: renderer (sotto, «Chiuse»).

- (S) Motivo «limite» per le risposte di @Claude: oggi un limite o un errore
  dell'API del CLI chiude la risposta `failed`/`other` (review della fetta 3,
  scelta dell'orchestratrice dell'11 nov 2026). Un valore a sé vuole il CHECK
  della 0140 e il client: da riprendere col prossimo aggiornamento del pin del
  CLI.
- Limite *(S, renderer della fetta 4)*: un invio con più file si ferma al primo
  file rifiutato; quelli già caricati restano «in sospeso» e il server li pota
  dopo 24 ore (non li si toglie con `DELETE /api/chat/attachments/:id`).
- `@channel` e `@reparto` non avvisano nessuno (R-G6). È la regola della fetta
  1, da riprendere se il maintainer vuole avvisi di gruppo.
- Limite accettato: modificare un messaggio avvisa solo chi viene nominato
  per la PRIMA volta. Chi era già nominato non riceve una seconda card, e chi
  viene tolto dal testo tiene la card che aveva (la sua domanda però esce da
  «Da decidere»).
- Limite accettato: i messaggi scritti prima della 0137 hanno `search_folded`
  solo in minuscolo, con gli accenti, finché non vengono modificati. In
  produzione non ce ne sono: la fetta 1 esce con la 0137.
- Limite accettato: una richiesta nata da un messaggio mostra il codice solo
  a fine intake (lo scrive il worker), non subito.

## Area 5 — Docs e Drive

Design: `docs/plans/2026-11-11-integrazione-area5-docs-design.md`. Fetta 1
(Docs) chiusa lato server (sotto, «Chiuse»); invariante `docs/invariants/docs.md`.

- Il Drive, fetta 3: il contenuto dei file (estrazione del testo, OCR con le
  regole dell'input non fidato), il riassunto (`summaryLine`, `drive.summary`
  delle citazioni, oggi null), la ricerca per contenuto e i tool di Claude sul
  Drive. I riferimenti a Google Drive (sorgente `google`, «Togli», «Nascondi»,
  le cartelle collegate) stanno nell'area 6. Fuori da entrambe: versioni,
  modifica dei file, cartelle in Stubwise, condivisione esterna.
- Limite accettato (fetta 2): l'anteprima inline vuole lo storage su
  un'origine diversa dall'istanza; senza `endpoint`, o sullo stesso host, è
  sempre un download (`docs/invariants/drive.md`).
- Limite accettato (fetta 2): una citazione `drive` scelta col «#» resta solo
  se il testo nomina il file per NOME o per codice, come il titolo di una
  pagina; rinominare un file non è possibile oggi, quindi il nome non cambia
  sotto i piedi.
- Limite accettato (fetta 2): gli allegati della Chat (`chat.attachments.upload`
  nell'api-client) stanno in un gruppo annidato, e il guardiano dei tipi
  (`reader.test.ts`) guarda solo i metodi di primo livello: il loro schema di
  risposta non è controllato da lui. Il Drive sta al primo livello apposta.
- Limite accettato (fetta 1): la cronologia della ricerca globale
  (`search_history`, `type = 'doc'`) punta a id di pagina, che una
  rigenerazione cambia. Un clic vecchio può non trovare più la pagina.
- Limite accettato (fetta 1): `provider_error` nello stato della generazione
  non si emette, perché manca un segnale strutturato che lo distingua da
  `other`.
- Differenze dichiarate del renderer (fetta 1, *S*): le «pagine toccate» da
  una nota di rilascio (il server non le dà); l'estratto negli elenchi; lo
  slug di una manuale che non cambia; il riassunto e le vicine delle comunità
  del grafo; «Abilita» il grafo dal desktop (impostazioni del repository non
  integrate). Elenco completo in `apps/desktop/docs/integration-area5-f1.md`.
- Stato della PR di setup del grafo *(S, fetta 1, review del renderer)*: il
  server dà l'indirizzo della PR (`setupPrUrl`), non se è aperta, mergiata o
  chiusa; il desktop la mostra sempre aperta.
- Chat dei Docs senza streaming *(S, fetta 1)*: se `CHAT_MAX_TOKENS` sale molto
  o arriva un modello lento, il primo a scattare è il timeout di 300 s del main
  (undici); la strada è lo streaming, non un timeout più alto.
- Differenze dichiarate del renderer (fetta 2, *S*): l'anteprima sul desktop è
  un salvataggio e sul web la rotta `preview` in una scheda nuova (niente
  Quick Look né miniatura nella build app); `counted` di un'apertura non si
  sa; (contenuto, riassunto e passaggi: arrivati con la F3); «#» cerca i file da
  2 caratteri; sul web una sessione scaduta durante un caricamento la chiude
  la richiesta dopo. Elenco completo in `apps/desktop/docs/integration-area5-f2.md`.
- Il contenuto dei file: limiti dichiarati *(S, area 5, fetta 3)*: doc, xls,
  ppt e RTF sono `unsupported` (D Office/ODF = a); un documento ostile può far
  mentire il SUO riassunto (narrativa generata, mai nel registro decisioni);
  la ricerca per testo copre i primi 100.000 caratteri, oltre trova la sola
  corsia semantica (al più 200 chunk per file); i tempi del VPS sono da
  misurare al deploy.
- Motivo del `no_text` visibile *(S, F3, decisione dell'orchestratrice A(a))*:
  il server manda `contentReason` (`no_text_found`, `ocr_timeout`,
  `ocr_unavailable`, `unreadable`, `too_large`, `limits`), il desktop dice solo
  «nessun testo» come il prototipo.
- La ricerca del Drive non si rilegge mentre un risultato è «in lettura»
  *(S, F3, review del renderer)*: parità col prototipo. Un file che finisce
  di leggersi mentre si guardano i risultati resta «Reading the content…»
  finché non si ricerca o si apre; l'elenco e il dettaglio invece si
  rileggono.
- «Retry» anche su un `no_text` transitorio *(S, F3, decisione
  dell'orchestratrice C(a))*: il server lo permette (`permissions.retry`) su
  `no_text` ed `error`; il desktop mostra «Retry» solo su `error`, come il
  prototipo. Riaprire per `ocr_timeout` e `ocr_unavailable`.
- La corsia semantica del Drive per chi vede tutto *(S, area 5, review della
  F3)*: oggi esatta (filtro prima, senza indice); con 50.000 chunk la ricerca
  di un full admin sta a 290–340 ms. Se le istanze crescono, si torna
  all'indice HNSW con `SET LOCAL hnsw.ef_search` alto (e, con pgvector ≥ 0.8,
  `hnsw.iterative_scan`) per chi vede tutti i progetti, lasciando esatto chi
  ne vede pochi.
- Credenziali di sola lettura separate per il worker, se lo storage lo
  permette *(S, area 5, fetta 3)*: oggi il worker legge gli oggetti del Drive
  con le credenziali dell'istanza, e la sola lettura è una regola del codice
  (una funzione, solo `drive/`, test sul sorgente). Un utente S3 di sola
  lettura sul prefisso `drive/` la renderebbe una regola dello storage.
- `nosniff` sull'anteprima del Drive *(S, limite accettato, review della
  fetta 2)*: l'URL firmato di S3 non può aggiungere
  `X-Content-Type-Options: nosniff` (le firme permettono di sovrascrivere solo
  Content-Type e Content-Disposition). Accettato perché il Content-Type
  dell'anteprima inline lo decide il server (solo PDF, immagini raster e
  testo come `text/plain`) e l'anteprima inline esiste solo da un'origine
  diversa dall'istanza. Si riapre se lo storage passa dietro un proxy nostro.

## Area 6 — Posta e Calendario

- Più account Google nel cassetto *(S, F1, decisione B(a) dell'orchestratrice)*:
  il server tiene una casella per Workspace; il cassetto del desktop ne mostra
  una (quella da ricollegare, se c'è, altrimenti la prima). La Posta e il
  Calendario le mostrano tutte. Da riprendere con la F5 (Drive Google).
- Ritorno OAuth della casella all'app con `stubwise://` *(S, F1, decisione
  dell'orchestratrice)*: oggi il callback resta quello del web («puoi tornare
  all'app») e il desktop rilegge le caselle mentre «Collega» aspetta e al
  ritorno in primo piano.
- I testi del cassetto Google col Drive *(S, F1 → F5)*: senza il Drive Google
  il cassetto parla di Posta e Calendario (intro, scaduto, scollegare senza
  cartelle); con la F5 tornano i testi del prototipo.
- Il Calendario in lettura *(F1)*: nella build app restano nascosti i gesti
  che scrivono su Google (nuova riunione, sposta e ridimensiona, modifica,
  elimina, rispondi, il progetto a mano: F4) e il riassunto e le task di una
  riunione passata (F5). Il server non sa i NOMI
  degli invitati (solo l'indirizzo e la risposta): il dettaglio mostra
  l'indirizzo. La serie non porta la sua regola (`RRULE` sta sulle
  occorrenze): la colonna non la dice a parole.
- La Posta in lettura *(F1)*: la posta TRATTATA per conversazione, le
  proposte della casella accanto al messaggio d'origine, letto/non letto
  con Gmail. Nascosti nella build app: scrivere (nuova email, rispondi,
  inoltra, bozze, la bozza di Claude: F3), i campi modificabili di una
  proposta e gli incaricati fuori dal progetto (F2, col task 6 del server).
  Dalla F2 ci sono importanza, scadenza, «Importanti» e l'estratto
  nell'elenco. Differenze dichiarate: un allegato non ha
  la dimensione e si apre da Gmail; la proposta mostra la frase che il
  server scrive per ogni azione (non i campi) e non l'estratto letto; la
  scelta del progetto di un'email incerta (`choose_project`) non c'è (il
  worker non la produce più).
- I progetti di una conversazione abbinati per NOME *(S, review della F1)*:
  le righe di `/threads` danno solo `projectNames`, e due progetti con lo
  stesso nome si confondono. Chiusa con la F2: `projectIds` dal server (per
  nome resta solo con un server di prima).
- La lettura automatica dopo 1 s scrive su Gmail *(O, decisione
  dell'orchestratrice)*: aprire la conversazione È il gesto, come nel
  prototipo (D5 = b). Va scritto esplicito nell'invariante «Nessuna
  scrittura verso Google senza un gesto» (chiesto a stubwise-72).
- `/api/inbox` senza filtro per tipo *(S, review della F1)*: chiusa con la
  F2, la Posta legge e decide le proposte da `/api/me/mail/proposals`.
- Una casella con le proposte spente si legge e si allinea come le altre
  *(M, decisione del maintainer: come il prototipo; chiusa con la F1 del
  server, 02df56c8)*: il poller la legge comunque e «Aggiorna ora» funziona;
  «Proposte attive» spegne solo le proposte.

- I riferimenti a Google Drive nel Drive dei progetti (area 5, D1 = a): le
  cartelle collegate, «Aggiungi da Google Drive», «Quale progetto?», i file
  non disponibili. Servono lo scope `drive.readonly` (ristretto: riconsenso e
  verifica di Google) e il cassetto Google comune a Drive, Posta e
  Calendario.

- Il blocco della Home «Posta importante» è acceso dalla F2 (le conversazioni
  con un messaggio di importanza alta non letto). «Prossimi appuntamenti» è
  acceso dalla F1, con la finestra
  del prototipo (da adesso a fine di domani, senza i rifiutati) *(O,
  decisione dell'orchestratrice: il prototipo è la specifica)*.
- Azione di Claude «bozza del corpo dell'email».
- F1.2 «Aggiorna ora», scelte accettate *(O)* (12 nov 2026, commit 31151503):
  (a) 409 `proposals_disabled` per una casella con le proposte spente — tolto
  dalla decisione *(M)* sotto, insieme alla richiesta tolta dal PATCH; (b) il
  NOTIFY sveglia soltanto, è il claim di sempre a prendere la casella (le
  richieste prima delle altre dovute); (c) a fine giro si azzera la richiesta
  vista al claim, una scritta a giro in corso resta e la casella torna dovuta;
  (d) con `GMAIL_POLL_MINUTES=0` una richiesta non viene servita (il
  rollback): va nell'invariante `mail-calendar.md` alla F1.5.
- Proposte spente, la casella si legge *(M)* (12 nov 2026): claim e indice
  solo su `disabled_at`, classificazione e pubblicazione saltate; «Aggiorna
  ora» funziona. Il taglio alla riaccensione *(O)*: `proposals_since`
  (0150), scritto dal PATCH da spente ad accese; la posta con `created_at`
  precedente non si classifica mai e resta `new`; il calendario non ha
  taglio (propone solo appuntamenti futuri, come al primo collegamento).
  Invariante in `mail-calendar.md`, voce del deploy-log dell'area 6 F1.
- Ritorno OAuth al desktop *(O)* (area 6, F1): nessun deep link, il callback
  resta quello del web e il renderer rilegge `accounts()` al ritorno in primo
  piano. Rimandato `stubwise://google?outcome=…` (come `stubwise://auth`),
  che riporterebbe l'esito direttamente all'app.
- F2, chi riceve la proposta condivisa *(M)* (12 nov 2026): A = (a) un
  destinatario membro senza casella collegata la riceve e la vede con
  l'estratto, il messaggio intero solo se è nella SUA casella; B = (b)
  l'interruttore «Proposte attive per questa casella» decide solo se
  classificare la PROPRIA posta, e la notifica arriva a TUTTI i destinatari
  membri, anche a chi le ha spente (la frase dell'interruttore nella UI non
  promette più «niente notifiche»).
- F2, decidere una proposta condivisa, scelte *(O)* (12 nov 2026):
  «Passa al progetto» non crea una card nuova: la proposta passata la vede e
  la decide chi nel progetto ha i permessi di OGNI sua azione, in
  `/proposals?status=handed` (rimandato: una card per loro); «Quale
  progetto?» scelto cancella la domanda e riclassifica l'email solo per quel
  progetto; i Contributor si aggiungono con `putProjectMember` (le regole di
  Membri) prima della conferma, e se ne vanno se la conferma non riesce
  (non sono nella stessa transazione delle azioni).
- F1.3 letto / non letto, limite *(S)*: dopo un resync per query (primo
  giro, history scaduta) i messaggi GIÀ ingeriti non rileggono `UNREAD`
  finché non cambia di nuovo su Gmail; le righe di prima della 0149 sono
  `unread = null`, lette come «letto». Un recupero (rileggere le etichette
  dei thread recenti al resync) costa una chiamata per messaggio: non ora.

## Area 7 — Automazioni

- Blocco della Home delle automazioni.
- Effetti che il prototipo ha e la build app spegne: segnali alle automazioni
  alla chiusura di un traguardo e alla conversione di una richiesta.
- Azioni di Claude: crea automazione in bozza, salva/elimina bozza, prova.

## Area 8 — Rilasci, ambienti, avvisi, Support, Servers

- Blocchi della Home «Rilasci» (anche l'extra di `resolveHome` per
  `release.merge`) e «Clienti in attesa».
- Origine di una richiesta da Support; «View conversation» delle task del widget.
- Adozione delle PR e rilascio (merge) — confine di prodotto invariato.
- Azioni di Claude: iscrizioni agli avvisi, bozze di risposta di supporto e
  delle note di rilascio della PR.
- L'evento `release_page` della Chat (area 4, fetta 4, [DECIDE] 1 = a): il
  «general» lo ha acceso (D8), ma non ha una fonte finché l'area 8 non
  definisce la pagina di Release. Nasce qui, con la sua scheda.

## Area 9 — Amministrazione, preferenze, accesso

- Audit vera dei membri di progetto *(O)* (area 6, F2, 12 nov 2026): oggi
  `putProjectMember` non lascia traccia, e i Contributor aggiunti (e tolti)
  da una conferma della posta lasciano solo una riga nel log della rotta.
  Va col registro delle modifiche qui sotto.
- Registro delle modifiche dell'istanza vero (oggi i ruoli di reparto lasciano
  solo una riga di log).
- Archiviati, interruttori di brief e report, pausa della coda e lavoro fermo.
- Le altre impostazioni di progetto (AI, repository, membri, integrazione,
  widget, regole mail, server, ambienti, plugin, elimina).
- Preferenze, persone e accessi, istanza (compresa la pagina Google, con
  l'origine vera dell'istanza al posto di `INSTANCE_ORIGIN` finto).
- Inbox: «Restore», «Move to New» e «segna come non letta» *(S)*.
- Tentativi rimasti del secondo fattore *(S)*.
- Permessi di progetto dati da un reparto (`department-permissions`): non
  previsti dal server, da decidere col maintainer se servono.
- Azioni di Claude dell'area 9 (membri, ruoli, impostazioni senza segreti), con
  la riconferma.
- Classe C delle azioni di Claude (la fetta 4 della chat è vuota: le C sono
  solo dell'area 9) *(O, 10 nov 2026)*: nel renderer la conferma di una
  proposta MODIFICATA (`confirmEdited`, scheda «Edit») salta il wrapper
  `reauth()` che usa la conferma semplice. Oggi è innocuo (nessuna C ha
  «Edit»), ma con le prime C va passata dalla riconferma come Confirm.
- **Cassaforte dal desktop: aperta al desktop riconfermato per decisione del
  maintainer, bloccata tecnicamente dallo sblocco PRF** *(M, 10 nov 2026)*. Il
  maintainer vuole che dal desktop si faccia tutto quello che si fa dal
  browser, cassaforte compresa (leggere, condividere, confermare). Ma la
  chiave di una persona si apre solo nel client col segreto PRF di una
  passkey, e dal desktop le passkey non ci sono (decisione D1 della
  riconferma). Le sfide (`vault_recovery_challenges`) sono poi legate alla
  SESSIONE. Oggi quindi `vaultRoutes` è `config.browserOnly` e `credentials.ts`
  tiene i suoi `session_required` (`docs/invariants/vault.md`). Le due strade:
  - **la passkey nel browser, consegnata all'app**: un passaggio come il login
    del desktop, che porta il segreto PRF (o la chiave aperta) all'app per la
    durata della finestra;
  - **un secondo modo di sbloccare** la chiave dal desktop (per esempio una
    chiave del dispositivo sigillata alla prima apertura nel browser): è un
    cambio d'invariante della cassaforte («non esiste un secondo
    meccanismo»), da decidere col maintainer.
  Con l'una o l'altra servono anche le sfide legate al PAT (`pat_id` in
  alternativa a `session_id`, con un CHECK) e la rimozione di `browserOnly`.

## Area 10 — Integrazione di Claude

- Le citazioni di file del repository (`kind file`, `<repo>:<path>`, visibili
  con `repos.view`, senza destinazione) (area 5, D6 = a): arrivano con un tool
  di Claude che legge il codice; oggi niente le produce.

- Le task eliminate nella cronologia del progetto *(S)*: il server non ha una
  cronologia di progetto che le nomini (la storia della task se ne va con
  lei); lo standup e la richiesta d'origine sì. (Elimina task: chiusa, sotto.)

## Area 11 — Documentazione di prodotto

- Origine di una richiesta dalla documentazione di prodotto.
- Azioni di Claude dell'area 11.

## Trasversali

- **Ritiro del web vecchio** e passaggio di `/app` alla radice (decisione aperta
  del design della fetta 1); con il ritiro: togliere `tickets.status` enum,
  `saved_views`, `/api/projects/pulse` se nessuno lo legge più.
- `downloadUrl` nelle liste degli allegati dei ticket *(S, 11 nov 2026, review
  della fetta 4)*: `GET /api/tickets/:id/attachments` dà già l'URL firmato, che
  così arriva al renderer. Da togliere quando i ticket scaricano solo da
  `api:download` (il proxy toglie già il `Location` dei percorsi di download).
- **MCP** (`@stubwise/mcp`): imparare stati per progetto, reparti, taglie, codici
  R<n>, Home e filtri.
- Elenchi oltre le 2000 righe (oggi troncati e dichiarati); una rotta aggregata
  per il polso del portafoglio.
- **CLI `claude` del worker aggiornato con regolarità** *(M)*, ogni volta col
  giro completo dei golden e i testi del limite riverificati.
- App mobile: riceve il fix del reader dei traguardi (e gli altri cambi delle
  risposte) solo con una nuova build.
- Prova a mano complessiva: `apps/desktop/docs/integration-manual-tests.md`.
- **Produzione 2.1.287 e tool nativi** *(M, 10 nov 2026)*: l'init espone gli
  stessi tool nativi del 2.1.322 (CronCreate, RemoteTrigger, SendMessage,
  PushNotification, ToolSearch…; traccia di `streaming-cli.test`,
  `apps/worker/src/sessions/fixtures/interrupt-then-message.jsonl`);
  eseguibilità non verificata (il binario non c'è e non si scarica).
  Decisione del maintainer del 10 nov: correzione solo col rilascio del pin
  2.1.322, insieme all'elenco esplicito dei nativi per run (commit
  «fix(worker): elenco esplicito dei tool nativi per ogni run del CLI»,
  `docs/invariants/agent-sessions.md`, «I tool NATIVI di ogni run»). Si
  chiude con quel rilascio.

## Chiuse

(Le voci fatte si spostano qui con il riferimento che le chiude.)

- **Gli snippet di `search_docs` come contenuto non fidato** *(S, area 5,
  fetta 3, chiusa l'11 nov 2026, decisione (a) dell'orchestratrice)*: la
  ricerca nei Docs è in `CHAT_TOOL_UNTRUSTED_ROUTES` accanto alla pagina
  intera; dopo una ricerca nei Docs ogni proposta della conversazione è almeno
  B (`claude-actions/untrusted-input.test.ts`).

- **Area 5, fetta 2: il Drive dei file caricati, server** *(M/O, 11 nov
  2026)*: 0143 (`drive_files`, `drive_opens`, permessi `drive.*`), le rotte
  del Drive col caricamento in streaming fino a 100 MB, l'anteprima inline
  solo per i tipi sicuri e da un'altra origine, la lapide e la pulizia oraria
  degli oggetti, i codici F, «Save to Drive» come copia, le citazioni `drive`
  e `client.drive`. Il renderer è di stubwise-94.

- **Area 5, fetta 1: Docs nel desktop, server** *(M/O, 11 nov 2026)*: codici
  D stabili (0142) con le citazioni `doc` della Chat sul codice e il link;
  `GET /api/docs/codes/:code`; embedding delle pagine manuali; `read_doc_page`
  per Claude; nello stato motivo, rientro e avanzamento; `projectId` sugli
  spazi; l'api-client dei Docs e le forme del grafo in shared. Il renderer è di
  stubwise-94. Chiude «Docs del progetto e modulo Docs dei progetti».

- **Area 4, fetta 4: eventi dei progetti e allegati, server** *(M/O, 11 nov
  2026)*: i messaggi di sistema dai trigger della 0141 (task chiusa,
  richiesta nuova, traguardo, brief, PR aperta e mergiata), con la scheda
  derivata a lettura; `setPublishedEvents`; gli allegati dei messaggi
  (25 MB, 10 per messaggio, tipo ed estensione, download firmato per chi
  legge, potatura dei sospesi dopo 24 ore dal server); il filtro «con
  allegati» e i nomi dei file nella ricerca. `release_page` resta all'area 8.
  Il renderer è di stubwise-94.
- **Area 4, fetta 4: eventi dei progetti e allegati, renderer** *(M, 11 nov
  2026)*: `chat-events` e `chat-attachments` accesi (sono accesi tutti i flag
  della Chat); parità in `apps/desktop/docs/integration-area4-f4.md`. Chiude
  anche il filtro «con allegati» della ricerca.
- **Download degli allegati dal desktop** *(Trasversali, 11 nov 2026)*: il 302
  presigned non passava dal proxy. Ora `api:download` del main
  (`apps/desktop/src/main/apiDownload.ts`) vale per gli allegati della Chat e
  dei ticket: bearer solo verso l'istanza, Location https (http solo su
  un'istanza http), «Salva» sempre chiesto, mai aperto. Il bottone
  «Download» sugli allegati della task c'è (`downloadTaskAttachment`,
  `pages/task/LinksSection.tsx`, test in `real/taskPanel.test.tsx`).

- **Area 4, fetta 3: @Claude nei canali, server e worker** *(M/O, 10 nov
  2026)*: la chiamata e la sessione privata di chi chiama (D5), il contesto
  del thread costruito dal server, le proposte sempre B senza «Annulla», la
  domanda a chi chiama (`ask_question` scritto dal worker) in «Da decidere»,
  stop, «Try again», eliminazione, budget → `failed`/`budget`. Migrazione
  0140; golden `chat-mention-*`. Il renderer è di stubwise-94.

- **Area 4, fetta 3: @Claude nei canali, renderer** *(M/O, 11 nov 2026)*:
  `chat-claude` acceso; la parità sta in
  `apps/desktop/docs/integration-area4-f3.md` («Renderer»). Comprende anche
  i difetti trovati nella review della fetta 1: «apri il thread dopo l'invio»
  con la persona vera della build app (`useSessionPersonId`, test
  `real/chatOpenThread.test.tsx`) e le bozze del riquadro di Claude per
  persona (`answerDraft`, `wantDraft`, `undoDraft`, `fillable.test.tsx`).
  Dopo il primo giro: le schede per chi non ha chiamato mostrano i dettagli
  degli oggetti che vede (decisione del maintainer, server 63ccd90a); Modifica
  ed Elimina dei messaggi seguono `canEdit`/`canDelete` del server; gli
  eventi della sessione si rileggono al più ogni 4 s mentre Claude scrive.

- Messaggi «via Claude» nella Chat *(M, 10 nov 2026, piano della fetta 3)*:
  si chiude senza codice. Nessuna azione del catalogo scrive in Chat, e
  «Claude nella Chat» è la risposta `kind claude` «chiamato da X».
  `chat_messages.via_claude_action_id` resta inerte: un'azione «scrivi nel
  canale» sarebbe una decisione nuova.

- **Area 4, fetta 2: DM, privati, generali, domande, ricerca, server**
  *(M/O, 10 nov 2026)*. Comprende:
  - DM da 2 a 8 persone, invisibili anche al full admin;
  - privati con invito e rimozione, che chi gestisce vede ma non legge;
  - canali generali d'istanza (i permessi `chat.general.*` della 0135 ora
    hanno le rotte);
  - la ricerca;
  - le domande `chat.question` in «Da decidere»;
  - «Create task/request» con i `linkedCodes`;
  - «anche nel canale»;
  - i permessi del canale del prototipo.

  Migrazioni 0137–0138. Commit «feat(area4): fetta 2 della Chat, server — …»
  e «feat(area4): task e richieste nate da un messaggio della Chat (F2.5)»;
  `docs/invariants/chat.md`. Il renderer è di stubwise-94.

- **Area 4, fetta 1: la Chat fra persone, server** *(M/O, 10 nov 2026)*:
  canali di progetto aperti, il «general» creato col progetto (backfill e
  trigger, 0135; era la voce «Canale "general" creato col progetto» di
  `integration-slice4.md`), thread, reazioni, letture, «Threads»,
  «Mentions», `@Nome` con la card `chat.mention` derivata a lettura (0136) e
  lo stream SSE — commit «feat(area4): fetta 1, F1.1 — …» e «feat(area4):
  fetta 1, F1.2 — il server della Chat», `docs/invariants/chat.md`. Il
  renderer è la F1.3 (stubwise-94).

- **Riconferma dal desktop** *(S/O, 10 nov 2026)*: decisa dal maintainer
  (opzione B di `docs/plans/2026-11-10-riconferma-desktop-design.md`) e
  costruita (0132). Il codice si scrive dentro l'app (`POST
  /api/auth/desktop-reauth`, solo un PAT `desktop`), e la finestra di 10 minuti
  vale su tutte le rotte con `config.reauth`. Niente passkey dal desktop.
  Con la seconda decisione dello stesso giorno, la regola unica
  (`browserOrConfirmedDesktop`) vale anche negli handler: aperti PAT,
  desktop-handoff, il link di reset altrui e la propria password. Resta fuori
  solo la cassaforte, bloccata dallo sblocco PRF (voce nell'area 9).

- La riga di benvenuto con la promessa di sola lettura e «/» senza comandi
  d'azione *(S, fetta 2)*: `landing.intro` e `/plan`, `/new-task`,
  `/new-request`, `/run` col flag `claude-chat-actions` — commit
  «feat(desktop): la chat con Claude agisce nella build app (F3.4)».
- «via Claude» a lettura *(S, 10 nov 2026)*: commenti, registro della task,
  card d'inbox e standup per persona (`tasksMoved`, `comments`, oltre a
  `tasksDeleted`) derivano `viaClaude`, l'azione e il richiedente (dal gruppo)
  dalle colonne `via_claude_action_id`; il jsonb delle notifiche non si tocca
  — commit «feat(server): viaClaude derivato a lettura».

- **Elimina task** *(M, 10 nov 2026)* e lo standup «`tasksDeleted` sempre
  vuoto» *(S)*: eliminazione vera (0130, lapide `deleted_tickets`, FK decise,
  numero mai riusato, chi lo decide il server, `busy`), «Delete task…» nella
  build app; la richiesta d'origine (`deletedTaskCodes`), le card d'inbox
  (`objectGone`) e lo standup la nominano — commit «feat(server): elimina task
  (F3.0, server)» e «feat(desktop): elimina task (F3.0, renderer)»,
  `apps/desktop/docs/integration-claude-chat.md`.
- Le sessioni dell'agente di una task eliminata se ne vanno con lei *(M,
  decisione del maintainer del 10 nov 2026; il prototipo le tiene)*: la loro
  visibilità passa dal ticket (R26). Il dialogo lo dice: «Anche il lavoro di
  Claude su questa task (sessioni, piano, domande) viene eliminato; restano i
  consumi e il registro decisioni».

- Chat con Claude, **fette 1 e 2** *(O)*: conversazioni libere private sul
  server (sessioni `free`, 0126–0128), turni a sola lettura col token del turno
  e `--tools ""`, golden `chat-*`; nel renderer «New», N, «Mine», la pagina, il
  riquadro (⌘J, ⌘K) col chip del contesto, menzioni e comandi di lettura —
  parità in `apps/desktop/docs/integration-claude-chat.md`, commit «feat(chat):
  …» (F1.1, F1.2, F2.1a, F2.1b).
- Area 3, la riga di Claude nel Planning di progetto per chi NON può
  assegnarlo *(O, 10 nov 2026)*: c'è per chiunque veda il Planning, col suo
  carico, in sola lettura col motivo e fuori dai bersagli — commit
  «fix(desktop): la riga di Claude nel Planning, in sola lettura»,
  `apps/desktop/docs/integration-area3e.md`.

- Area 3, 3e.2 **Claude assegnabile, renderer** *(M)*: riga e carico nel
  Planning, assegnatario solo dove `claudeAssignableProjectIds` lo dice, la sua
  frase per `claude_assign_forbidden` — commit «feat(desktop): Claude
  assegnabile (3e.2)», `apps/desktop/docs/integration-area3e.md`.
- Polso e «aspetta te» con Claude *(O)*: «Claude al lavoro» (sessioni `ai_job`
  dal vivo) e «Claude aspetta te» (voci di Claude in «Da decidere») nel polso e
  sulle tessere — stesso commit.

- Area 3, 3e.1 **Claude assegnabile, server** *(M)*: utente di sistema (0125,
  `users.is_agent`), niente accesso né notifiche, assegnarlo avvia il run con le
  regole di `run-ai` e chiede `runs.start` — commit «feat(area3): Claude
  assegnabile (3e.1)».
- Area 3, **«Link a person» nello standup, renderer** *(O)*: sul web
  `POST /api/users/:id/git-identities` con la riconferma, dal desktop il gesto
  apre il web sulla stessa pagina; la riga senza persona mostra email e
  username — commit «feat(desktop): Link a person nello standup»,
  `apps/desktop/docs/integration-area3e.md`.
- Area 3, **«Link a person» nello standup, server** *(S)*: i commit si
  attribuiscono anche via `git_identities`; le righe senza persona sono per
  email e portano `authorEmail` e `authorUsername` — commit «feat(area3):
  collegare un autore di commit allo standup».
