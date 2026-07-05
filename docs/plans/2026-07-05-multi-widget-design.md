# Multi-widget per progetto

Data: 2026-07-05 · Stato: design validato · Estende: `2026-07-05-widget-customer-service-design.md`

## Obiettivo

Più widget customer service sullo stesso progetto, con configurazioni
indipendenti (whitelist repo, aspetto, lingua, cap) — es. un widget "Webapp"
con i repo della webapp e un widget "Admin" con i repo del pannello — e
attribuzione di conversazioni e ticket al widget di provenienza.

## Decisioni chiave

| Tema | Decisione |
|---|---|
| Identità/auth | **Chiave per-widget nel DSN** (stesso formato `https://KEY@host/p/slug`); revoca granulare; la ingestionKey NON è più valida sulla superficie `/widget` (breaking consapevole, feature deployata oggi, snippet installati ~zero) |
| Cap giornalieri | **Per-widget, configurabili da UI** (`dailyMessageCap`/`dailyTicketCap` nullable); le env `WIDGET_DAILY_MESSAGE_CAP`/`WIDGET_DAILY_TICKET_CAP` diventano i default d'istanza |
| Delete widget | **Conversazioni conservate** (FK `widgetId` SET NULL, mostrate come "widget eliminato"); i ticket non sono toccati |
| Client widget | `packages/widget` **invariato**: cambia solo la chiave nel DSN |

## Modello dati

- **Nuova tabella `widgets`** (sostituisce `widget_settings`): `id` uuid pk,
  `projectId` FK cascade, `name` text notNull (mostrato in lista/viewer/ticket),
  `key` text notNull **unique** (32 hex, generata come la ingestionKey),
  `enabled`, `enabledRepositoryIds`, `title`, `welcomeMessage`, `accentColor`,
  `language` (campi identici a widget_settings), `dailyMessageCap` int nullable,
  `dailyTicketCap` int nullable (null = default d'istanza), `createdAt`.
- **`widget_conversations`**: nuova colonna `widgetId` uuid FK → widgets
  **ON DELETE SET NULL**, nullable.
- **Migrazione unica** (DDL + data migration; nessun nuovo valore enum → niente
  trappola batch): crea `widgets`; migra l'eventuale riga `widget_settings` in
  un widget `name='Widget'` con chiave nuova generata in SQL
  (`replace(gen_random_uuid()::text,'-','')`); punta le conversazioni esistenti
  a quel widget; droppa `widget_settings`. Backup DB prima del deploy.

## Autenticazione superficie pubblica

Lookup progetto per slug (come oggi), poi confronto timing-safe della chiave
fornita contro le chiavi dei **widget del progetto** (pochi per progetto);
match → `request.widget` decorato. 401 indistinguibile invariato per slug
inesistente / chiave errata / chiave di widget eliminato.

## API

**Pubblica `/widget/:slug/*`** — struttura invariata, contesto per-widget:
- `GET /config` → campi del widget risolto (nessun campo nuovo esposto).
- `POST /conversations` → conversazione con `widgetId`.
- `POST .../messages` → retrieval sulla whitelist del widget; cap messaggi
  conteggiato sulle conversazioni **di quel widget**
  (`dailyMessageCap ?? env`).
- Conferma ticket → cap ticket per-widget (`dailyTicketCap ?? env`).
- Ownership: conversazione di un altro widget dello stesso progetto → 404
  indistinguibile (una chiave non legge i fili dell'altro sito).

**Interna nuova `/api/projects/:projectId/widgets`**:
- `GET` lista (requireAuth): nome, enabled, chiave, conteggi sintetici.
- `POST` crea (requireAdmin): nome obbligatorio, chiave generata server-side.
- `PUT /:widgetId` (requireAdmin): config completa incl. cap; validazione 422
  sui repo come oggi.
- `DELETE /:widgetId` (requireAdmin): conversazioni → widgetId null.

Le route `widget-settings` (GET/PUT 1:1) **vengono rimosse**; la SPA passa al
CRUD.

**Viewer conversazioni**: la lista espone `widgetName` (JOIN; null → "widget
eliminato") e accetta `?widgetId=` come filtro, accanto a `?ticketId=`.

## SPA

- **Tab Widget** → lista di widget (card: nome, stato, dati sintetici,
  "Nuovo widget"); editor per widget = form attuale + nome + cap giornalieri
  (placeholder = default d'istanza, vuoto = default) + snippet precompilato
  con la chiave del widget. Delete con conferma esplicita ("le conversazioni
  restano, lo snippet installato smette di funzionare").
- **Conversazioni**: badge nome widget in lista, filtro per widget (select),
  "widget eliminato" per widgetId null; `?ticketId` invariato.
- **Ticket**: il blocco identità del body dice "Segnalato dal widget <nome>".
  Nessun campo nuovo sul ticket.

## Guida

Aggiornare `integrations/widget.md`: più widget per progetto, chiave
per-widget, cap configurabili da UI (env = default d'istanza).

## Testing

- Server (testcontainers): auth multi-chiave (chiave A non legge fili di B;
  chiave di widget eliminato → 401), cap per-widget con override e fallback
  env, migrazione dati (settings esistente → widget, conversazioni
  riattaccate), CRUD 401/403/404/422, viewer con filtro e widgetName.
- SPA (happy-dom): lista/editor widget, snippet con chiave giusta, filtro
  conversazioni.
- `packages/widget`: nessuna modifica → nessun test nuovo.
- `pnpm lint` prima del merge.

## Deploy

Ribuild `server` (API + migrazione all'avvio) + `caddy` (SPA + guida).
**Backup DB prima** (data migration). Worker non toccato.

## Fuori scope v1

- Rotazione chiave del widget (workaround: elimina e ricrea)
- Cap aggiuntivo a livello progetto (somma dei widget)
- Statistiche per widget (messaggi/giorno, ticket/settimana)
