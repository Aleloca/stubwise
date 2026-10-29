# Shape brief — Task di server, correzione sul server, sessione d'analisi e avvisi

Superfici: sezione **Server** nel pannello della task (`?task=<CODE-n>`,
nuova `pages/task/ServerSection.tsx`) per le task con `serverRef`; la
**scheda del piano** e il **registro dei comandi** di una correzione dentro
la sezione Claude della task e nella sessione (`ClaudeSection.tsx`,
`ClaudeRunParts.tsx`, conversazione dell'area 3); la **sessione d'analisi**
nella destinazione Claude (`#/claude/<id>`, kind `server_analysis`); il
segno di sorgente «Server» (`SourceMark.tsx`); le voci degli avvisi dei
server nel pannello notifiche (`NotificationItem.tsx`). Piano 8b: Task 9
(dati: Task 5–6). Spec area 8: «L'analisi automatica», «La correzione»,
«Permessi», «Stati» (Server, Task di server), Review Focus 1 e 4. Forme di
riferimento: `task-claude.md` (sezione Claude), `conversation.md` (schede),
`claude-destination.md`, `alerts.md` (voci del pannello). Mondo: «Catalogo
numerato», modalità **Operate**, con un tratto di **Read** (registro dei
comandi). Scelte del brief **[ST n]**, raccolte in fondo; quelle che
cambiano ciò che si vede in «Scelte da confermare».

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi può avviare la correzione** (Marco su ACQ: `servers.operate`, non
    `plans.approve`; Roberta: tutti e due): legge la diagnosi, decide se
    far intervenire Claude **con l'accesso che può fare tutto**.
  - **Chi approva** (Laura su ACQ: `plans.approve`, non `servers.operate`;
    Roberta): legge il piano **comando per comando** prima che qualcosa
    giri, e lo rifiuta se rilascia.
  - **Chi segue** (Matteo, Sara): vuole sapere in una parola se il server
    è stato sistemato.
- **Stato d'animo**: il problema è già successo (spesso è già rientrato);
  ora si decide se toccare un server di produzione. Serve **calma e
  controllo**: ogni passo dice cosa succederà dopo e chi lo decide, e
  niente sembra partire da solo.

## 2. Esito e prova

- **Azioni primarie**: (1) leggere la diagnosi e la proposta; (2) avviare
  la correzione (`servers.operate`); (3) approvare o rifiutare il piano
  (`plans.approve`); (4) leggere cosa è stato eseguito e se il problema è
  sparito, poi chiudere la task.
- **Successo**, a 1440×900, pannello della task a 400–640px:
  - aprendo ACQ-57 la prima sezione dice **quale server, quale episodio,
    cosa propone Claude** e in che stato è la task, in tre righe;
  - il bottone «Start fix on the server» ha **sotto, sempre scritte**, le
    due condizioni;
  - avviata la correzione, anche Roberta (che può approvare) trova la
    scheda del piano **ferma su «Approve the plan»**: nessun comando gira
    prima del suo gesto;
  - a lavoro finito, una riga dice «Fixed — memory at 41%, every check
    up» o «Not fixed — memory still at 92%».
- **Verità del prodotto** (mai ammorbidite):
  - **due condizioni, sempre**: avvia solo chi ha `servers.operate`; il
    piano si approva **sempre**, anche dal proprio autore, con un gesto
    esplicito; niente pre-approvazione, niente partenza diretta;
  - **l'analisi automatica è in sola lettura**: la sessione lo dice, e i
    suoi comandi sono marcati «read»;
  - **un piano che rilascia va rifiutato** (pull, aggiornamento
    d'immagine, deploy): la scheda lo scrive;
  - **il normale «Start» di Claude non tocca mai il server**.

## 3. Direzione scelta

- **Tesi**: **il server è il contesto, Claude è il lavoro**. La sezione
  **Server** sta in testa al pannello (prima della descrizione) e porta il
  contesto e l'avvio; tutto ciò che Claude fa dopo l'avvio — piano,
  comandi, controllo finale — vive nella sezione **Claude** già esistente,
  con le sue schede, perché la correzione è una sessione `task_run` come le
  altre **[ST 1]**.
- **Momento focale**: prima dell'avvio, il bottone con le due condizioni;
  dopo, la scheda del piano con la riga «Runs as stubwise-fix: can do
  anything on SRV-1».

```
┌─ ACQ-57  Memory leak in the import worker ────────────────── ✕ ┐
│ ▣ Server · Bug · No assignee                                    │
│ SERVER ───────────────────────────────────────────────────────  │
│ SRV-1 acq-prod-01 · Healthy                          Open →     │
│ Memory above 90% · Oct 27 14:02 → 16:10 (back to normal)        │
│ Diagnosis ready                                                 │
│ Suggested fix: restart the import worker with a 512 MB cap and  │
│ rotate its log. Read the analysis →                             │
│ [Start fix on the server]                                       │
│ 1. Only people allowed to operate ACQ's servers can start it.   │
│ 2. Claude writes a plan first. Nothing runs on SRV-1 until      │
│    someone who can approve plans in ACQ approves it — even you. │
│ DESCRIPTION ─────────────────────────────────────────────────── │
│ …                                                               │
│ CLAUDE ──────────────────────────────────────────────────────── │
└─────────────────────────────────────────────────────────────────┘
```

### Sezione «Server» (task con `serverRef`)

- Titolo `heading-group` SERVER, filetto, come le altre sezioni.
- **Riga del server**: codice `SRV-1` (600, tabellare) · nome · salute
  **attuale** in parola e glifo (come in `servers.md`) · a destra «Open →»
  (dettaglio del server, `?section=` assente). Server cancellato: «SRV-1 ·
  deleted» senza link.
- **Riga dell'episodio** 13px `ink-muted`: motivi brevi + intervallo
  («Memory above 90% · Oct 27 14:02 → 16:10 (back to normal)»; aperto:
  «… · since 14:02, still going»); più motivi: il primo e «+1» con gli
  altri nel `title`.
- **Stato della task di server** (`ServerTaskState`) in una riga 14px con
  glifo, sempre presente:
  - `diagnosis_ready` «Diagnosis ready» · `fix_planning` «Claude is
    planning the fix (read-only)» (anello) · `plan_awaiting` «Fix plan
    waiting for approval» (punto ink pieno se aspetta **me**) ·
    `plan_rejected` «Plan rejected · Oct 29 11:02» · `fixing` «Fix
    running on SRV-1» (anello) · `stopped` «Fix stopped by Marco Bellini»
    · `resolved` ✓ `positive` «Fixed — the check after the fix passed» ·
    `not_resolved` ✕ `critical` «Not fixed — the check after the fix
    failed» · `closed` «Closed».
- **Proposta**: «Suggested fix:» + il testo della proposta (fino a 4
  righe, poi «More») e il link **«Read the analysis →»** alla sessione
  d'analisi. La diagnosi intera sta nella descrizione (la scrive Claude
  all'apertura), la sezione non la ripete **[ST 2]**.
- **Esiti dell'analisi che non sono una diagnosi**: «Claude couldn't reach
  SRV-1 over SSH. What it tried: …» (elenco breve) / «The analysis hit its
  20-minute limit. This is what it found so far.» al posto della proposta.
- **Avvio** (secondario della sezione se c'è un primario altrove, se no
  primario):
  - **«Start fix on the server»** e sotto, **sempre**, le due condizioni in
    12px `ink-muted`, numerate: «1. Only people allowed to operate ACQ's
    servers can start it.» · «2. Claude writes a plan first. Nothing runs
    on SRV-1 until someone who can approve plans in ACQ approves it — even
    you.» **[ST 3]**;
  - clic → dialogo 440px «Start a fix on SRV-1?»: «Claude reads the
    server, then writes a plan. It runs commands as **stubwise-fix, which
    can do anything on SRV-1**, only after the plan is approved.» · campo
    facoltativo «Notes for Claude» · **Start fix**. Dopo: lo stato passa a
    «planning», il pannello scorre alla sezione Claude.
  - **Bloccato** (`startBlock`), al posto del bottone una riga in parole:
    `no_permission` → «Someone allowed to operate ACQ's servers can start
    the fix.» (le due condizioni restano scritte sotto); `no_fix_access` →
    «SRV-1 has no fix access.» + **Link SSH access** solo a
    `servers.ssh.manage`; `fix_access_unverified` → «SRV-1's fix access
    isn't verified.» + stesso link; `run_live` → niente (lo stato dice già
    «Fix running»); `closed` → niente.
  - Dopo `plan_rejected`, `stopped`, `not_resolved`: il bottone diventa
    **«Start fix again»** con le stesse condizioni.
- **Chiusura**: la task la chiude una persona dallo stato della task come
  oggi; su `resolved` la sezione aggiunge il suggerimento «Close the task
  if the problem is gone.» senza bottone proprio.

### Sezione «Claude» su una task di server

- **Start normale** (`runs.start`) resta dov'è, con una riga in più sotto:
  «This run works on the code, never on SRV-1. To fix the server, use
  Start fix in Server above.» **[ST 4]**.
- La correzione si riconosce: riga di stato «Fix on SRV-1 · waiting for
  approval», e la scheda e il registro qui sotto.

### Scheda del piano della correzione (sezione Claude e sessione)

- La stessa `PlanCard` dell'area 3, con:
  - titolo «Fix plan for SRV-1»; sotto il titolo una riga 13px con ▲
    `warning`: «Runs as stubwise-fix: it can do anything on SRV-1.»;
  - il piano mostra i **comandi previsti** come elenco (monospace 12px),
    ognuno con la sua spiegazione in una riga;
  - riga fissa 12px `ink-muted` in fondo: «A plan that releases — pull,
    image update, deploy — must be rejected. Releases go through Releases.»;
  - **nessun «Approve in advance»**, né nel «⋯» della sezione (la voce
    «Pre-approve the plan» non compare su una task di server);
  - bottoni: **Approve the plan** · **Reject with instructions**; a chi
    l'ha avviata e può approvare, sopra i bottoni: «You started this fix.
    Approving runs the commands on SRV-1.»;
  - senza `plans.approve`: nessun bottone, «Waiting for someone who can
    approve plans in ACQ.»;
  - **approvazione spenta** (`planBlockedReason`): bottone Approve
    disattivato al 40% e, sopra, la ragione: «Fix access to SRV-1 was
    revoked. Link it again to approve this plan.» / «SRV-1's fix access
    isn't verified. Verify it to approve this plan.» (+ link alla parte
    SSH per `servers.ssh.manage`). Reject resta attivo.
- Approvato: la scheda si riduce alla riga d'esito «Plan approved by Laura
  Conti · 11:04» (200ms), lo stato passa a «Fix running».

### Registro dei comandi

- Nella sezione Claude, sotto la scheda: «▾ Commands on SRV-1 · 12»,
  **aperto** durante `fix_planning`/`fixing`, chiuso dopo **[ST 5]**. Nella
  sessione i comandi sono le azioni del flusso, con la stessa forma.
- **Riga di un comando**: ora tabellare · etichetta in parola «read» /
  «fix» (12px, `ink-muted` per read, ink 600 per fix) · il comando in
  monospace (ellissi, intero nel `title`) · esito «OK» / «Failed · exit 1»
  (✕ `critical`) a destra. Clic apre l'**uscita**: blocco monospace con le
  ultime 40 righe; più lunga, in testa «Showing the last 40 of 5,000
  lines» e **Show all** che apre il visore delle Releases (finestra di
  righe disegnate, ricerca con `/`).
- **Controllo finale** (`work_result` `server_check`): ultima riga del
  registro, in evidenza 14px: ✓ «Check after the fix: resolved — memory at
  41%, every check up» / ✕ «Check after the fix: not resolved — memory
  still at 92%», con i comandi di lettura del controllo sotto (chiusi).
- **Fermare**: lo «Stop» dell'area 3 sulla sessione; fermata, ultima riga
  «Stopped by Marco Bellini · 11:09. No commands after this.»; fermata per
  revoca: «Stopped: fix access was revoked.»

### Sessione d'analisi nella destinazione Claude

- **Riga** negli elenchi: segno del tipo «Server analysis» (nuova voce di
  `claude.destination.kinds`) · titolo «Analysis of SRV-1 · memory» ·
  accanto il codice della task se creata e visibile (ACQ-57) · progetto
  ACQ · stato. Sta in «Working now» mentre gira e in «Finished» dopo.
- **Pagina**: la testata dice «Automatic · read-only access to SRV-1»; la
  casella è sostituita dalla frase di sola lettura esistente, con una
  variante: «This session runs on its own with read-only access to SRV-1:
  it can only be watched.» I comandi compaiono come azioni «read» (stessa
  riga del registro). Il lato oggetto mostra il server (riga del server +
  episodio) e la task quando nasce.
- Esiti: «Diagnosis ready · ACQ-57», «Not reachable · ACQ-57», «Out of
  time · ACQ-57» (con le parole degli esiti dell'area 3).

### Sorgente «Server» e avvisi

- **SourceMark**: «Server» con un glifo di rack (stesso peso degli altri
  segni), tooltip «Opened by Claude after an alert on SRV-1».
- **Voci del pannello notifiche** (forma dell'8a, codice `SRV-1` in testa):
  - `server.trouble` / `server.down` con accesso di lettura: titolo
    «SRV-1 is in trouble» / «SRV-1 isn't responding», corpo «Memory at
    94%, above 90% for 12 minutes. Claude is looking into it.»;
  - **senza accesso**: corpo «… Claude can't look into it: SRV-1 has no SSH
    access.» e, solo a `servers.ssh.manage`, un'azione in chiaro **Link
    SSH access** (non nascosta nel «⋯»: è il motivo dell'avviso) che apre
    la parte SSH del server e chiude il pannello **[ST 6]**;
  - `server.diagnosis_ready`: «Diagnosis ready for SRV-1», corpo col
    titolo della task, clic apre ACQ-57;
  - `server.recovered`: «SRV-1 is back to normal», corpo «after 2 h 8
    min».
  - «Don't alert me about this in ACQ» come ogni tipo del catalogo (8a).

## 4. Ambito e confini

- **Dentro**: sezione Server con stati, proposta, avvio con dialogo e
  blocchi; scheda del piano della correzione; registro dei comandi con
  uscita e visore; controllo finale; riga in più sotto lo Start normale;
  sessione d'analisi in destinazione Claude; SourceMark; voci degli avvisi.
- **Fuori**: avviare un'analisi a mano (parte solo da un avviso);
  approvare i singoli comandi; correggere un server da un'automazione, da
  «Fix it with Claude» delle Releases o da una conversazione libera;
  assegnare `servers.operate` (pagina Membri, area 9).
- **Anti-obiettivi**: un piano di correzione che si approva da solo o in
  anticipo; un bottone «Start fix» per chi non ha `servers.operate`; le
  condizioni scritte solo in un tooltip; un comando «fix» che sembra uguale
  a un «read»; l'uscita di 5000 righe disegnata tutta.

## 5. Stati e intervalli

- **Task di server**: i nove `ServerTaskState` sopra, più i blocchi
  d'avvio; «piano da approvare» è sempre fra avvio e primo comando.
- **Comandi**: analisi 5–15; correzione 3–20; uscita 0–5000 righe.
- **Proposta**: 1–6 righe. **Motivi dell'episodio**: 1–3.
- **Caricamento** della sezione Server: due righe scheletro; **errore**:
  «Couldn't load the server» + **Retry**, il resto del pannello vive.
- **Server non più visibile** a chi guarda (cambio di persona): la riga del
  server diventa «A server you can't see», nessun link né avvio.
- **Cambio di persona** con la task aperta: avvio, bottoni del piano e
  «Link SSH access» compaiono o spariscono sul posto.

## 6. Interazione e layout

- Pannello 360–640px: a 360 le due condizioni vanno a capo sotto il
  bottone, il comando nel registro si tronca prima dell'esito.
- Avvio: dialogo → Start fix → toast nessuno (lo stato cambia sul posto e
  si annuncia in `aria-live="polite"`); errore → toast «Couldn't start the
  fix.» · **Retry**.
- Movimento: riduzione della scheda 200ms, apertura del registro 200ms;
  nulla sotto reduced-motion.
- Tastiera: nel registro ↑/↓ fra i comandi, Invio apre l'uscita, `/` cerca
  nell'uscita aperta.

## 7. Vincoli

- Solo via `data/queries.ts` (`getServerTaskInfo`, `startServerFix`,
  permessi della conversazione con `planBlockedReason`); la UI non decide
  chi può avviare o approvare, legge `startBlock` e i permessi.
- La stringa `server.fix` non compare in `pages/` (test d'architettura): le
  etichette «read»/«fix» vengono da un campo letto, non da un confronto
  sul nome dello strumento nella UI.
- Testi en/it con parità. Riuso: `PlanCard`, il visore del log di
  `RunLog`, `WorkingRing`, le frasi di sola lettura della destinazione.

## Scelte del brief

1. **[ST 1]** Sezione Server in testa al pannello per contesto e avvio;
   piano, comandi e controllo nella sezione Claude.
2. **[ST 2]** La sezione mostra la proposta e il link all'analisi, non la
   diagnosi intera (sta nella descrizione).
3. **[ST 3]** Le due condizioni scritte sempre sotto il bottone, anche a
   chi non può avviare; avvio con dialogo di conferma.
4. **[ST 4]** Lo Start normale resta, con la riga «never on SRV-1».
5. **[ST 5]** Registro aperto durante la correzione, chiuso dopo; uscita
   di un comando chiusa finché non la si apre.
6. **[ST 6]** «Link SSH access» in chiaro sulla voce dell'avviso senza
   accesso.

## Scelte da confermare

1. **Sezione «Server» in testa al pannello della task**, prima della
   descrizione, con server, episodio, stato e proposta **[ST 1]**.
2. **«Start fix on the server» passa da un dialogo di conferma** che
   ripete «stubwise-fix can do anything», e le due condizioni restano
   scritte sotto il bottone anche per chi non può avviare **[ST 3]**.
3. **Lo Start normale di Claude resta** sulle task di server, con la riga
   «This run works on the code, never on SRV-1» **[ST 4]**.
