# Stubwise

Issue tracker self-hostabile con pipeline AI: gli errori arrivati dagli SDK
diventano ticket, e un worker basato sul CLI di Claude prova a triage-arli e a
proporre una fix aprendo una pull request.

## Self-hosting con Docker Compose

Lo stack gira in quattro container: `postgres`, `server` (API Fastify, applica
le migrazioni all'avvio), `worker` (pipeline AI, richiede git + il CLI claude) e
`caddy` (serve la web app statica e fa da reverse proxy verso il server, con
HTTPS automatico).

### Prerequisiti

- Docker con Docker Compose v2 (`docker compose`).
- Un dominio che punta all'host se vuoi l'HTTPS automatico.

### 1. Configura l'ambiente

```bash
cp .env.example .env
```

Compila almeno questi valori nel `.env` (sezione `DEPLOY`):

```bash
# Segreti: generali una volta sola
openssl rand -hex 32       # -> SESSION_SECRET
openssl rand -base64 32    # -> ENCRYPTION_KEY
openssl rand -hex 24       # -> POSTGRES_PASSWORD (una password qualsiasi robusta)
```

- `POSTGRES_PASSWORD`: la password del database.
- `DATABASE_URL`: deve puntare al servizio `postgres` del compose e combaciare
  con utente/password/db, ad esempio
  `postgres://stubwise:LA_PASSWORD@postgres:5432/stubwise`.
- `SESSION_SECRET` ed `ENCRYPTION_KEY`: i due segreti generati sopra.
- `DOMAIN`: il dominio pubblico (es. `stubwise.example.com`). Per provare in
  locale usa `localhost` (TLS self-signed) o `:80` (solo HTTP).
- `PUBLIC_URL`: l'URL pubblico coerente con `DOMAIN`, es.
  `https://stubwise.example.com`.

### 2. Avvia

```bash
docker compose up -d --build
```

Il server applica le migrazioni del database all'avvio; il worker parte solo
dopo che il server è sano. Apri quindi `https://DOMAIN` nel browser.

### 3. Setup iniziale dalla UI

1. Alla prima apertura crei l'utente **admin** (il primo registrato è admin).
2. Crei un **progetto**. Dalla pagina del progetto trovi:
   - il **DSN** per configurare l'SDK nella tua app (vedi sotto);
   - l'endpoint e il **secret del webhook** git da impostare sul provider
     (GitHub/Bitbucket) per chiudere i ticket al merge della PR;
   - le **credenziali git** del repo che il worker userà per clonare e aprire
     PR (vengono cifrate con `ENCRYPTION_KEY`).

### 4. Configura l'SDK

Nella tua applicazione installa l'SDK Stubwise e inizializzalo con il DSN preso
dalla pagina del progetto: gli errori catturati verranno inviati all'endpoint
`/ingest` della tua istanza e raggruppati in ticket.

### 5. Auth del worker (CLI claude)

Il worker invoca il CLI `claude` per triage e fix: serve un'autenticazione.
Scegli **una** delle due vie.

**a) Chiave API (consigliata in produzione).** Imposta `ANTHROPIC_API_KEY` nel
`.env` e riavvia il worker:

```bash
docker compose up -d worker
```

**b) Login OAuth/MAX.** Lascia `ANTHROPIC_API_KEY` vuota ed effettua il login
interattivo dentro il container; il token persiste nel volume `claude-config`
(montato su `CLAUDE_CONFIG_DIR=/home/worker/.claude`), quindi sopravvive a
riavvii e rebuild:

```bash
docker compose exec worker claude login
```

### Backup

I dati persistenti vivono in due volumi Docker:

- `pgdata`: il database (ticket, progetti, utenti, code dei job).
- `mirrors`: i mirror git dei repository dei progetti (ricostruibili, ma il
  backup evita un re-clone completo).

Esempio di dump del database:

```bash
docker compose exec postgres pg_dump -U stubwise stubwise > backup.sql
```

### Aggiornamenti

```bash
git pull
docker compose up -d --build
```

Le nuove migrazioni vengono applicate dal server all'avvio.
