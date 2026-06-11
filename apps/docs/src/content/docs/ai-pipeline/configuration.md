---
title: Configurazione della pipeline
description: Concorrenza, soglia di staleness, modelli e comandi di test consentiti all'agente.
---

La pipeline AI si regola con poche variabili d'ambiente del worker e con alcuni
parametri di default codificati nella pipeline. Qui i più importanti; l'elenco
completo delle variabili è nella
[reference della configurazione](/docs/reference/configuration/).

## `WORKER_CONCURRENCY`

Quanti job AI il worker lavora in parallelo, **su progetti diversi**. Default
**`2`** (range ammesso 1–16). I job dello stesso progetto restano comunque
serializzati (vedi [Come funziona](/docs/ai-pipeline/how-it-works/)).

Alza questo valore solo insieme ai limiti di risorse del container: ogni job
può clonare e buildare un repo e far girare un agente per minuti. Vedi le
[note operative](/docs/getting-started/self-hosting/) sul deploy.

## `WORKER_STALE_MINUTES`

Minuti di inattività oltre cui un job in lavorazione è considerato **orfano** di
un worker crashato e riportato in coda. Default **`45`**.

:::caution[Deve superare ~40 minuti, o il worker non parte]
La soglia di staleness deve superare il tempo massimo che un job legittimo può
impiegare: **timeout fix (30') + 2× triage (2' ciascuno, per il retry) +
margine (5') ≈ 40 minuti**. Un valore troppo basso riaccoderebbe un job lungo
ma ancora vivo, generando una **PR duplicata** sullo stesso progetto. Il worker
**verifica questa invariante all'avvio e si rifiuta di partire (exit 1)** se è
violata: con `restart: unless-stopped` finirebbe in crash-loop. Lascia il
default `45` se non hai un motivo preciso per cambiarlo.
:::

La difesa primaria contro i falsi orfani è comunque l'**heartbeat**: durante il
fix il worker aggiorna `lastActivityAt` ogni 60 secondi, ben sotto la soglia di
staleness. L'invariante è la rete di sicurezza contro una configurazione rotta.

## `MIRRORS_DIR`

Directory dei **mirror git persistenti** del worker. Default
`/var/stubwise/mirrors`. Nel deploy Docker è un volume montato lì: i mirror sono
ricostruibili, ma persisterli evita un re-clone completo ad ogni job. I worktree
del fix sono invece **effimeri** e vengono rimossi a fine job.

## Modelli

- **Triage**: modello **`haiku`** (la fase economica), con pochi turni
  (default 10) e timeout 2 minuti.
- **Fix**: usa il **modello di default del CLI** `claude` (la fase costosa), con
  fino a 80 turni e timeout 30 minuti.

Questi parametri sono interni alla pipeline; il modello dell'auth è quello con
cui hai autenticato il CLI (API key o login OAuth/MAX, vedi
[Auth del worker](/docs/getting-started/claude-setup/)).

## Comandi consentiti all'agente di fix

In modalità headless l'agente gira con `--permission-mode acceptEdits`: può
**modificare i file** ma ha **Bash negato** per default. Siccome il prompt gli
chiede di eseguire i test del repo, il worker gli concede una **allowlist** di
soli comandi di test:

```
Bash(npm test:*)
Bash(npm run test:*)
Bash(pnpm test:*)
Bash(pnpm run test:*)
Bash(npx vitest:*)
Bash(npx jest:*)
```

Tutto il resto di Bash resta negato: l'agente **non** può fare `git push` né
eseguire comandi arbitrari. Questa allowlist è il default; vedi
[Sicurezza](/docs/ai-pipeline/security/) per il razionale completo.
