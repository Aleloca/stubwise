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
