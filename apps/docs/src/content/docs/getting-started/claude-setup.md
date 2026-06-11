---
title: Auth del worker (Claude)
description: Autentica il CLI di Claude nel worker per abilitare la pipeline AI, via API key oppure login OAuth/MAX.
---

La pipeline AI è gestita dal **worker**, che invoca il CLI `claude` in modalità
headless per il triage e il fix dei ticket. Perché funzioni, il CLI deve essere
**autenticato**. Hai due vie: scegline **una**.

:::note[L'AI è opzionale]
Senza autenticazione il resto di Stubwise funziona comunque: l'issue tracker
(progetti, ticket, board, commenti, ingestion degli errori) è pienamente
operativo. Solo i job AI restano in coda o falliscono — la pipeline è
disabilitata, in modo silenzioso e senza effetti collaterali sul tracker.
:::

## Via a) Chiave API (consigliata in produzione)

Imposta `ANTHROPIC_API_KEY` nel `.env` e riavvia il worker:

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

```bash
docker compose up -d worker
```

È la via più semplice e robusta per un deploy non presidiato.

## Via b) Login OAuth/MAX

Se preferisci usare un abbonamento (es. Claude MAX) via login OAuth, **lascia
`ANTHROPIC_API_KEY` vuota** ed effettua il login interattivo dentro il
container:

```bash
docker compose exec worker claude login
```

Il token persiste nel volume Docker `claude-config`, montato su
`CLAUDE_CONFIG_DIR=/home/worker/.claude`: sopravvive a riavvii e rebuild, quindi
il login si fa una volta sola.

:::caution[Non lasciare `ANTHROPIC_API_KEY` impostata a vuoto se usi l'OAuth]
Una `ANTHROPIC_API_KEY=""` che raggiunge il CLI `claude` può sabotare un login
OAuth valido. Il compose è già scritto per **omettere** la variabile quando non
è impostata (usa `${ANTHROPIC_API_KEY}` senza default), e il worker scarta a
valle le stringhe vuote dall'ambiente passato al CLI. Per usare l'OAuth, quindi,
basta lasciare la riga `ANTHROPIC_API_KEY=` vuota nel `.env`.
:::

## Cosa vede (e cosa non vede) il sottoprocesso

Il worker **non** passa l'intero ambiente al CLI `claude`: costruisce una
**allowlist** esplicita. Al sottoprocesso arrivano solo:

- `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TMPDIR`;
- `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`;
- tutte le variabili che iniziano con `ANTHROPIC_` o `CLAUDE_`.

In particolare **non** raggiungono mai il CLI i segreti del master:
`ENCRYPTION_KEY`, `DATABASE_URL` e `SESSION_SECRET` sono in una denylist che ha
la precedenza assoluta. Questo è una difesa contro la prompt injection: il
prompt contiene contenuto non fidato del ticket e l'agente può eseguire comandi
(i test), quindi non deve mai poter esfiltrare le chiavi che cifrano le
credenziali git di tutti i progetti. Vedi
[Sicurezza della pipeline](/docs/ai-pipeline/security/).

## Verifica

Dopo aver configurato l'auth, crea un ticket di prova (manuale, dalla web app o
via SDK) su un progetto con credenziali git valide e osserva la timeline dei
job AI nel dettaglio del ticket: dovresti vedere il triage partire. Se il CLI
non è autenticato, il job fallisce con un errore di autenticazione visibile nel
log del job.
