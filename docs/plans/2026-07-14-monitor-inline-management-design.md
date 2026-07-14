# Gestione server nel Monitor + valore corrente nei grafici

Data: 2026-07-14 · Stato: design validato · Estende: `2026-07-13-server-monitoring-design.md`

## Obiettivo

Tre migliorie UX al monitoraggio:
1. **Grafici**: la legenda mostra sempre l'ultimo valore registrato quando il
   mouse non è sul grafico (invece di `--`).
2. **Gestione nel Monitor**: creazione server dalla lista Monitor, gestione
   check + modifica/rigenera-chiave/elimina server dalla pagina di dettaglio.
3. **Rimozione di Settings → Server**: il Monitor diventa l'unico posto; la
   pagina e la voce di nav dei Settings spariscono.

## Decisioni chiave

| Tema | Decisione |
|---|---|
| Scope | TUTTA la gestione si sposta nel Monitor; `settings/servers.tsx` + route + nav rimossi |
| Permessi | Gating solo UI: azioni di scrittura visibili solo agli admin (`role === "admin"` da `meQueryOptions`); view per tutti gli autenticati. Le route API sono già `requireAdmin` (sicurezza non dipende dai bottoni) |
| Grafico | Cursore uPlot con "idx a riposo" = ultimo punto: legenda mostra l'ultimo campione senza hover, il valore al cursore durante l'hover, e torna all'ultimo all'uscita del mouse |
| Riuso | I componenti di gestione si SPOSTANO (non si riscrivono) da `settings/servers.tsx` a `monitor/` |
| Deploy | Solo frontend → rebuild `caddy`. Nessun backend/DB/migrazione |

## 1. Grafici: valore corrente nella legenda (`monitor/uplot-chart.tsx`)

uPlot popola la legenda solo all'`idx` del cursore; a cursore inattivo lascia
`--`. Fix nel wrapper: impostare l'idx "di riposo" all'ultimo punto della serie.
- `cursor.idx` iniziale = ultimo indice.
- Hook `setCursor` (o `cursor.dataIdx`/gestione dell'uscita): quando il cursore
  esce (idx null), riportarlo all'ultimo indice invece di lasciarlo vuoto.
Vale automaticamente per i 4 pannelli e il grafico latenza check. Nessun impatto
su dati/query. Test: verifica della config del cursore (idx a riposo = ultimo).

## 2. Creazione server dalla lista (`monitor/index.tsx`)

Header con bottone **"Nuovo server"** (solo admin) → `NewServerForm` (nome) →
`createServer` → apertura del **sidepanel guida** (`KeyPanel`: chiave one-shot,
comando docker, step Docker collassabile, link alla guida completa). Empty-state
rimanda all'azione qui ("Registra il tuo primo server"), non più ai Settings.

Componenti spostati da `settings/servers.tsx` a `monitor/` (condivisi):
`dockerRunCommand`, `NewServerForm`, `KeyPanel`. Collocazione: `monitor/
server-admin.tsx` (o file dedicati) riusati da lista e dettaglio.

## 3. Gestione nel dettaglio (`monitor/server-detail.tsx`)

Azioni di scrittura solo per admin; view per tutti.

**Check editabili** — la sezione CHECKS diventa `ChecksEditor` (spostato dai
Settings): tabella con modifica/elimina per riga + bottone "Aggiungi check"
(`CheckForm`: select tipo, campi contestuali, DSN cifrato per i DB, gestione del
400 `target_required_for_type_change`). La selezione per il grafico latenza
resta.

**Impostazioni del server** — nuovo pannello in fondo: `EditServerForm` (nome,
intervallo, progetti); **rigenera chiave** (riapre il sidepanel guida);
**elimina server** (conferma + avviso "metriche e check verranno eliminati" →
redirect a `/monitor`).

Layout dettaglio: header → range → grafici → servizi/dischi → **check editabili**
→ soglie → **impostazioni server**. Le zone di gestione (check, impostazioni)
mostrano i controlli solo agli admin.

## 4. Rimozione Settings → Server

- Elimina `settings/servers.tsx` e `settings/servers.test.tsx`.
- Rimuovi la route `/settings/servers` (router.tsx) e la voce nav Settings.
- Il toggle "Alert di monitoraggio" RESTA nella sezione Notifiche (preferenza di
  notifica, non gestione server).
- Aggiorna i rimandi a `/settings/servers`: empty-state del tab Server nel
  progetto (`components/project-servers-section.tsx`) → `/monitor`; riferimento
  "Impostazioni → Server" nella guida agente (`apps/docs/.../agent-install.md`)
  → "sezione Monitor".

## Permessi (dettaglio)

`meQueryOptions` fornisce l'utente corrente; `isAdmin = user.role === "admin"`.
Nel Monitor: bottoni "Nuovo server", "Aggiungi check", modifica/elimina check,
`EditServerForm`, rigenera chiave, elimina server → renderizzati solo se
`isAdmin`. Nessuna nuova protezione backend: le route API sono già `requireAdmin`
(create/patch/delete/regenerate/checks) e `requireAuth` (GET).

## Testing

- Wrapper grafico: config cursore idx-a-riposo.
- Lista Monitor: bottone "Nuovo server" presente per admin / assente per member;
  creazione → sidepanel.
- Dettaglio: check CRUD (add/edit/delete) per admin, sola lettura per member;
  edit server, rigenera chiave (sidepanel), elimina (→ redirect); presenza/
  assenza dei controlli per ruolo.
- Sposta/adatta i test di `settings/servers.test.tsx` verso i nuovi componenti.
- Aggiorna i test che navigavano a `/settings/servers` e l'empty-state del tab
  progetto.

## Deploy

Solo `apps/web` → rebuild `caddy`. Nessun server/worker/DB. Nessuna migrazione.

## Note di rischio

`settings/servers.tsx` (906 righe) si smonta e ricolloca. Strategia: estrarre i
componenti condivisi in `monitor/`, ricablare lista e dettaglio con il gating
admin, spostare i test. Nessuna logica riscritta da zero — solo spostata.
