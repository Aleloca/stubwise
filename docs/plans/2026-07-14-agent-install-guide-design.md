# Guida installazione agente: sidepanel + documentazione

Data: 2026-07-14 · Stato: design validato · Estende: `2026-07-13-server-monitoring-design.md`

## Obiettivo

Sostituire il modal del comando di installazione dell'agente (oggi `KeyDialog`
in `apps/web/.../settings/servers.tsx`) con un **sidepanel a destra** che
contiene una guida essenziale (verifica/installa Docker, comando, verifica
connessione) e un link alla **guida completa** nella documentazione. In
parallelo, **creare la documentazione** del monitoraggio server in Starlight
(`apps/docs`), oggi assente, con l'installazione di Docker su più distro.

## Decisioni chiave

| Tema | Decisione |
|---|---|
| Due deliverable | (A) doc Starlight in `apps/docs`; (B) sidepanel nella SPA che linka (A) |
| Sidepanel | Riuso del `Drawer` esistente (`components/drawer.tsx`) con `side="right"` e larghezza maggiore (`w-[min(92vw,34rem)]`) — dà overlay, animazione, Escape, `role="dialog"`, focus |
| Entry point | Il sidepanel rimpiazza il modal negli **stessi due punti**: creazione server e rigenerazione chiave (entrambi producono la chiave one-shot) |
| Docker nel pannello | Snippet **minimo** Ubuntu/Debian (`curl -fsSL https://get.docker.com \| sh`) in uno step **collassabile** (chiuso di default); il dettaglio multi-distro vive nella doc |
| Docker nella doc | Blocchi per Ubuntu/Debian, RHEL/Fedora, Alpine + nota rootless e gruppo `docker` |
| Link guida | `<a href="/guide/monitoring/agent-install/">` — doc servita dalla **stessa istanza** (self-host), non github.io |
| Chiave one-shot | Resta il vincolo: box con avviso ambra in cima, copia affidabile (fallback selezione se `navigator.clipboard` assente) |
| Backdrop | Nuova prop opzionale `dismissOnBackdrop` sul `Drawer` (default `true`); il sidepanel chiave la passa `false` per evitare perdita accidentale della chiave |

## A. Documentazione (Starlight, `apps/docs`)

Nuovo gruppo **"Server monitoring"** nella sidebar di `astro.config.mjs`
(accanto a Integrations/Notifications). Due pagine scritte a mano (nessun
contenuto autogenerato):

**`src/content/docs/monitoring/index.md` — "Server monitoring"**
- Cosa fa: metriche host (CPU/RAM/disco/rete), auto-discovery container Docker
  e app PM2, check espliciti (HTTP/TCP/process/Postgres/MySQL), alert via
  notifiche.
- Modello: un server → N progetti; push dall'agente (nessuna porta in ingresso).
- Uso: registrare un server dalle Impostazioni, associarlo ai progetti, leggere
  lista e dettaglio (grafici uPlot, servizi, check), configurare soglie di alert
  e il toggle notifiche.
- Retention: 48h fini, 90 giorni aggregati a 5 minuti.

**`src/content/docs/monitoring/agent-install.md` — "Installare l'agente"**
(pagina linkata dal sidepanel)
- **Prerequisiti**: host Linux, accesso in uscita HTTPS verso Stubwise.
- **Installare Docker** con blocchi per distro: Ubuntu/Debian
  (`get.docker.com` o repo `apt`), RHEL/CentOS/Fedora (`dnf`), Alpine (`apk`);
  nota su rootless e sul gruppo `docker`.
- **Il comando dell'agente** riga per riga (mount read-only `/proc`, `/sys`,
  `/`; `docker.sock`; `--group-add`; le due env `STUBWISE_URL`/
  `STUBWISE_SERVER_KEY`); la chiave si ottiene dal sidepanel in Impostazioni →
  Server.
- **Verifica e troubleshooting**: server resta "mai connesso" → `docker logs`,
  URL, firewall in uscita; container Docker assenti → gruppo del socket; PM2
  assente → l'agente scansiona `/proc`.
- **Aggiornare / disinstallare**: `docker pull alelocadev/stubwise-agent` +
  ricrea; `docker rm -f stubwise-agent`.

Link interni con la convenzione `/docs/...` (il plugin `rehypeRebaseLinks`
li rebasa al `base` reale: `/guide` su Caddy, `/stubwise` su Pages).

## B. Sidepanel (SPA, `apps/web`)

Sostituisce `KeyDialog`. Struttura verticale (chiave critica in alto, guida
sotto):

1. **Header** — "Installa l'agente su «`<nome server>`»".
2. **Chiave one-shot** — box con avviso ambra "mostrata una sola volta";
   comando `docker run` completo con chiave interpolata, bottone copia (con
   fallback selezione testo).
3. **Step 1 — Docker** (collassabile, chiuso di default): riga di verifica
   `docker --version` + snippet `curl -fsSL https://get.docker.com | sh` con
   nota "altre distro / rootless → Guida completa".
4. **Step 2 — Avvia l'agente**: il comando (già presente sopra o ripetuto nello
   step), spiegazione breve dei mount e di `--group-add`.
5. **Step 3 — Verifica**: "il server passa a **online** entro ~1 minuto dal
   primo invio; log con `docker logs -f stubwise-agent`".
6. **Footer** — link "Guida completa e installazione Docker per tutte le
   distro →" verso `/guide/monitoring/agent-install/`.

### `Drawer` — prop `dismissOnBackdrop`
`components/drawer.tsx` acquisisce `dismissOnBackdrop?: boolean` (default
`true`, comportamento invariato per gli usi esistenti in docs-chat/app-layout).
Il sidepanel della chiave lo passa `false`: chiusura solo via bottone/Escape,
mai per click accidentale sul backdrop (la chiave è irrecuperabile). Aggiornare
`drawer.test.tsx` con il caso `false`.

## Testing

- `servers.test.tsx`: il test del `KeyDialog` diventa il test del sidepanel —
  chiave in chiaro presente, comando con `alelocadev/stubwise-agent`, link con
  `href="/guide/monitoring/agent-install/"`, step Docker collassabile, chiusura
  via bottone/Escape ma **non** backdrop, avviso one-shot.
- `drawer.test.tsx`: `dismissOnBackdrop=false` → click backdrop non chiude.
- Doc: `astro check` (già nel `pnpm typecheck` di `apps/docs`) valida frontmatter
  e link interni. i18n della SPA: parità en/it per le chiavi nuove del pannello.

## Deploy

- `apps/docs` → la GitHub Action `docs.yml` pubblica su Pages al push su main.
- `apps/docs` **e** `apps/web` sono entrambi dentro l'immagine caddy
  (`Dockerfile.caddy`): un **unico rebuild di `caddy`** in prod porta sia il
  sidepanel sia la guida su `/guide`. Nessun tocco a server/worker.
