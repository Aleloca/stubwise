---
title: Self-hosting con Docker Compose
description: Installa Stubwise su un tuo server in pochi minuti con Docker Compose, dai segreti al primo login.
---

Stubwise si auto-ospita con Docker Compose. Lo stack gira in **quattro
container**:

- **`postgres`** — il database (ticket, progetti, utenti, code dei job);
- **`server`** — l'API Fastify; **applica le migrazioni del database
  all'avvio**;
- **`worker`** — la pipeline AI (richiede `git` e il CLI `claude`); parte solo
  dopo che il server è sano;
- **`caddy`** — serve la web app statica e la documentazione, e fa da reverse
  proxy verso il server, con HTTPS automatico.

:::note[L'AI è opzionale]
Se non autentichi il CLI `claude` nel worker, l'issue tracker funziona lo
stesso: errori, feedback, ticket, board e commenti restano pienamente
operativi. I soli job AI restano in coda o falliscono, senza intaccare il
resto. Vedi [Auth del worker](/docs/getting-started/claude-setup/).
:::

## Prerequisiti

- **Docker** con **Docker Compose v2** (il comando `docker compose`).
- Un **dominio** che punta all'host, se vuoi l'HTTPS automatico via Let's
  Encrypt. Per provare in locale bastano `localhost` o `:80`.

## 1. Configura l'ambiente

Clona il repository e copia il file di esempio:

```bash
git clone https://github.com/stubwise/stubwise.git
cd stubwise
cp .env.example .env
```

Genera i segreti una volta sola:

```bash
openssl rand -hex 32      # -> SESSION_SECRET (min. 32 caratteri)
openssl rand -base64 32   # -> ENCRYPTION_KEY (32 byte in base64)
openssl rand -hex 24      # -> POSTGRES_PASSWORD (una password robusta qualsiasi)
```

Compila nel `.env` almeno questi valori della sezione **DEPLOY**:

| Variabile           | Valore                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` | La password del database (obbligatoria per il deploy).                                                   |
| `DATABASE_URL`      | Deve puntare al servizio `postgres` del compose e combaciare con utente/password/db (vedi sotto).       |
| `SESSION_SECRET`    | Il segreto generato sopra con `openssl rand -hex 32`.                                                    |
| `ENCRYPTION_KEY`    | La chiave generata sopra con `openssl rand -base64 32`.                                                  |
| `DOMAIN`            | Il dominio pubblico (es. `stubwise.example.com`), oppure `localhost` / `:80` per provare in locale.     |
| `PUBLIC_URL`        | L'URL pubblico **coerente con `DOMAIN`**, es. `https://stubwise.example.com`.                            |

Esempio di `DATABASE_URL` per il deploy (host = `postgres`, **non**
`localhost`, perché punta al servizio del compose):

```bash
DATABASE_URL=postgres://stubwise:LA_TUA_PASSWORD@postgres:5432/stubwise
```

:::caution[`PUBLIC_URL` deve combaciare con `DOMAIN`]
`PUBLIC_URL` è l'URL con cui Stubwise costruisce i link nei commenti e gli URL
dei webhook che consegni al provider git. Se non corrisponde a `DOMAIN`, i link
alle PR e gli endpoint webhook risultano rotti. In produzione usa
`https://<DOMAIN>`.
:::

L'elenco completo delle variabili, server e worker, è nella
[reference della configurazione](/docs/reference/configuration/).

## 2. Avvia

```bash
docker compose up -d --build
```

Il server applica le migrazioni del database all'avvio; il worker e Caddy lo
aspettano sano. Quando è su, apri `https://DOMAIN` nel browser.

## 3. Setup iniziale dalla UI

1. Alla prima apertura crei l'utente **admin**: il primo registrato è admin.
2. Crei un **progetto**. Dalla pagina del progetto trovi:
   - il **DSN** per configurare l'SDK nella tua app (vedi
     [Installazione SDK](/docs/sdk/installation/));
   - l'URL e il **secret del webhook** git da impostare sul provider
     (GitHub/Bitbucket) per chiudere i ticket al merge della PR;
   - le **credenziali git** del repo che il worker userà per clonare e aprire
     le PR (vengono cifrate a riposo con `ENCRYPTION_KEY`).

Il giro completo della UI è descritto in [La web app](/docs/getting-started/web-app/).

## Note operative

Qualche dettaglio utile per chi manda Stubwise in produzione.

### Il server è a singola replica

Il server applica le migrazioni all'avvio **senza advisory lock**: non
scalarlo a più repliche, altrimenti due processi proverebbero ad applicare le
migrazioni in contemporanea. Una sola replica è sufficiente per un deploy
self-hosted.

### Limiti di risorse del worker

Un fix dell'agente può durare fino a ~30 minuti e clonare/buildare repository
grandi. Il compose impone tetti **conservativi e regolabili** al container del
worker:

```yaml
mem_limit: 4g
cpus: 2
```

Senza tetti, un run impazzito affamerebbe `postgres` e `caddy` sullo stesso
host. Alza o abbassa questi valori in base alla macchina e a
`WORKER_CONCURRENCY` (vedi [configurazione della pipeline](/docs/ai-pipeline/configuration/)).

### Rotazione dei log

I container usano il driver `json-file` con rotazione già configurata (`max-size:
10m`, `max-file: 3`, quindi ~30 MB per servizio): senza, i log crescerebbero
fino a saturare il disco dell'host.

## Backup

I dati persistenti vivono in due volumi Docker:

- **`pgdata`** — il database (ticket, progetti, utenti, code dei job): è il dato
  irrecuperabile, va nel backup.
- **`mirrors`** — i mirror git dei repository dei progetti: ricostruibili da
  zero, ma il backup evita un re-clone completo.

Dump del database:

```bash
docker compose exec postgres pg_dump -U stubwise stubwise > backup.sql
```

## Aggiornamenti

```bash
git pull
docker compose up -d --build
```

Le nuove migrazioni vengono applicate dal server all'avvio.
