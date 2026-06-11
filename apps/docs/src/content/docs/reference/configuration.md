---
title: Variabili d'ambiente
description: Tutte le variabili d'ambiente di server, worker e deploy, con default e vincoli.
---

Tutte le variabili sono validate all'avvio con Zod: server e worker, se trovano
una variabile mancante o non valida, escono con **un solo messaggio** che le
elenca. Il file `.env.example` nel repository documenta ogni variabile.

## Server

| Variabile        | Obbligatoria | Default                   | Note                                                                                  |
| ---------------- | ------------ | ------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`   | Sì           | —                         | URL di connessione Postgres (`postgres://user:pass@host:5432/stubwise`).              |
| `SESSION_SECRET` | Sì           | —                         | Segreto per firmare le sessioni. **Minimo 32 caratteri.** `openssl rand -hex 32`.    |
| `ENCRYPTION_KEY` | Sì           | —                         | Chiave per cifrare le credenziali git. **32 byte in base64.** `openssl rand -base64 32`. |
| `PUBLIC_URL`     | Sì           | —                         | URL pubblico dell'istanza, usato per link e webhook. Deve combaciare con `DOMAIN`.    |
| `PORT`           | No           | `3000`                    | Porta di ascolto del server (1–65535).                                                |
| `TRUST_PROXY`    | No           | `false`                   | Fidarsi di `X-Forwarded-*` dietro reverse proxy. Il compose lo imposta a `true`.      |

:::note[`ENCRYPTION_KEY` è condivisa]
La `ENCRYPTION_KEY` del worker deve essere **la stessa del server**: il server
cifra le credenziali git dei progetti, il worker le decifra. Se differiscono, il
worker non riesce a decifrare le credenziali e i fix falliscono.
:::

## Worker

Il worker riusa `DATABASE_URL` ed `ENCRYPTION_KEY` (la stessa del server), più:

| Variabile               | Obbligatoria | Default                  | Note                                                                                       |
| ----------------------- | ------------ | ------------------------ | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`          | Sì           | —                        | Come il server.                                                                            |
| `ENCRYPTION_KEY`        | Sì           | —                        | **La stessa del server** (vedi sopra). 32 byte in base64.                                  |
| `MIRRORS_DIR`           | No           | `/var/stubwise/mirrors`  | Directory dei mirror git persistenti.                                                      |
| `WORKER_CONCURRENCY`    | No           | `2`                      | Job in parallelo su progetti diversi (1–16).                                               |
| `WORKER_STALE_MINUTES`  | No           | `45`                     | Minuti di inattività oltre cui un job è orfano. **Deve superare ~40'** o il worker non parte. |
| `ANTHROPIC_API_KEY`     | No           | —                        | Auth del CLI `claude` (via API key). Alternativa: login OAuth/MAX. Vedi sotto.             |
| `CLAUDE_CONFIG_DIR`     | No           | —                        | Config home del CLI `claude`. Nel compose è `/home/worker/.claude` (volume persistente).   |

Le variabili `ANTHROPIC_*` e `CLAUDE_*` vengono inoltrate al sottoprocesso
`claude`; i segreti del master (`ENCRYPTION_KEY`, `DATABASE_URL`,
`SESSION_SECRET`) **no**. Vedi [Auth del worker](/docs/getting-started/claude-setup/)
e [Sicurezza](/docs/ai-pipeline/security/).

:::caution[`WORKER_STALE_MINUTES` ha un'invariante]
Deve superare **timeout fix (30') + 2× triage (2') + margine (5') ≈ 40 minuti**.
Il worker verifica questa condizione all'avvio e **esce (exit 1)** se è violata.
Lascia il default `45` salvo motivi precisi. Vedi
[Configurazione della pipeline](/docs/ai-pipeline/configuration/).
:::

## Deploy (Docker Compose)

Queste valgono solo per `docker compose up` (vedi `docker-compose.yml` e la
guida al [self-hosting](/docs/getting-started/self-hosting/)):

| Variabile           | Obbligatoria | Default    | Note                                                                                  |
| ------------------- | ------------ | ---------- | ------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` | Sì           | —          | Password dell'utente Postgres nel container.                                          |
| `POSTGRES_USER`     | No           | `stubwise` | Utente Postgres.                                                                       |
| `POSTGRES_DB`       | No           | `stubwise` | Nome del database.                                                                     |
| `DOMAIN`            | Sì (deploy)  | `localhost` | Dominio servito da Caddy. FQDN → HTTPS automatico; `localhost` → TLS self-signed; `:80` → solo HTTP. |

Per il deploy, `DATABASE_URL` deve puntare al servizio `postgres` del compose
(host `postgres`, non `localhost`) e combaciare con `POSTGRES_USER`/`PASSWORD`/`DB`:

```bash
DATABASE_URL=postgres://stubwise:LA_TUA_PASSWORD@postgres:5432/stubwise
```

E `PUBLIC_URL` deve essere coerente con `DOMAIN` (es. `https://<DOMAIN>` in
produzione), altrimenti i link alle PR e gli URL dei webhook risultano rotti.
