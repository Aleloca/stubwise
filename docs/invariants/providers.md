# Account e provider dell'agente

## La scelta dell'account sta in `providers/select.ts`, e la ripresa usa la stessa funzione (15 ott 2026)

Design: `docs/plans/2026-10-15-nightly-pipeline-design.md` §4.

Ogni run `claude` del worker sceglie l'account con `selectProviders` /
`runWithProviders` (`apps/worker/src/providers/select.ts`), e la decisione di
ripresa (`limit-resume-poller.ts`: job, job Docs, generazioni in pausa) usa
**la stessa funzione** (`selectProviders(...)` e il margine dello snapshot di ALMENO UN
candidato, `candidates.some(hasHeadroom)`: lo stesso failover del run, non il
solo primo candidato). Non esiste una logica
«fissato/catena» separata nel poller: due verità sulla scelta sono il modo in
cui un lavoro riparte per finire subito di nuovo al limite, o non riparte mai.
**Un chiamante nuovo non risolve un provider da sé**: chiama `runWithProviders`
con la sua `WorkClass` (`interactive` | `background`).

Le regole che quel modulo regge:

- Il provider del progetto è **preferito**; `ai_provider_exclusive` lo rende
  l'unico, ma **solo con `ai_provider_id` valorizzato** (un `exclusive = true`
  con id nullo vale «preferito assente»).
- La chiave API (`kind = 'api_key'`) **non entra mai nel passaggio
  automatico** se esiste almeno un abbonamento abilitato — anche con tutti gli
  abbonamenti al limite: il conteggio è fatto PRIMA dei filtri, ed è voluto.
- Un account con `limited_until` futuro non è scelto da NESSUN lavoro; mai «al
  limite per sempre» (ora dal testo, dallo snapshot, o `now + 60 min`).
- Un lavoro `background` (giro notturno, brief settimanale, generazione Docs
  completa — ECCETTO la sua fase product finale, che è `interactive`: è
  l'ultimo passo di una generazione già pagata, e la soglia la farebbe saltare
  proprio quando il resto è fatto) salta gli abbonamenti con lettura settimanale **fresca** (≤ 15
  min) ≥ `BACKGROUND_WEEKLY_THRESHOLD`.
- Una generazione Docs ferma per la **soglia** (`THRESHOLD_PAUSE_REASON`,
  `docs/nodes.ts`) da più di `DOCS_BACKGROUND_PAUSE_MAX_HOURS` (default 6)
  riparte come `interactive` e lo resta **fino alla fine** (16 ott 2026,
  F2a). La marcatura è `doc_generations.stats.interactiveSince`, scritta
  nello stesso UPDATE guardato della ripresa (`resumeGenerationAsInteractive`)
  e riportata dalla finalize nelle stats definitive. La leggono **due**
  posti, e devono restare d'accordo: la ripresa (`limit-resume-poller.ts`,
  che decide con la classe interattiva) e la scelta dei nodi
  (`node-dispatch.ts`, `selectInputFor`) — senza la seconda la generazione
  ripresa ricadrebbe subito nella stessa pausa. Una pausa per il **limite
  vero** non è toccata.
- La reason di una pausa dei Docs è un **codice macchina stabile**
  (`provider_limit` | `background_threshold`, F2b, 16 ott 2026), mai una
  frase: lo scrive il worker in `doc_generations.pause_reason` e nel
  `reason` di `docs.limit_paused`, il payload `generic` dei webhook lo
  esporta così com'è, e la prosa (inbox, push, Slack) la sceglie il catalogo
  i18n alla resa (`notify.docsLimitPaused` / `notify.docsThresholdPaused`).
  Chi la riconosce passa SEMPRE da `docsPauseReasonOf`
  (`packages/notifications/src/docs-pause-reason.ts`), mai dall'uguaglianza:
  legge anche le frasi della soglia scritte prima dei codici (le card già in
  inbox le contengono per sempre) e manda tutto il resto al limite. Non
  aggiungere frasi nuove a quell'elenco storico, e non mettere nomi
  d'ambiente in un codice.
- «Nessun account disponibile» non è un fallimento: ogni coda rimette
  l'elemento in attesa **restituendo il tentativo** (UPDATE guardato).

### Eccezioni ammesse (fuori dalla scelta, per costruzione)

- il poller d'uso (`agent/usage-poller.ts`): deve leggere anche gli account al
  limite per sbloccarli;
- il test delle credenziali (`agent/credential-tester.ts`): prova un provider
  preciso;
- l'etichettatura del grafo (`graph/build.ts`): gira con l'auth del container
  e degrada a `--no-label` (fuori perimetro per decisione);
- la chat RAG del server (`apps/server/src/routes/chat-llm.ts`): chiave API
  esplicita;
- (`auto-update.ts`, l'ultima eccezione temporanea, è stato rimosso dal Piano B,
  Task B11: il giro notturno passa da `runWithProviders` come gli altri.)
