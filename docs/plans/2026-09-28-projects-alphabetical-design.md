# I progetti in ordine alfabetico, ovunque — design e piano

28 set 2026. Il maintainer cerca i progetti «a occhio» in ogni elenco, perché
nessuno è in un ordine prevedibile. Decisioni sue:
1. **Ordine alfabetico in tutti gli elenchi e i selettori di progetti, su app
   e web.**
2. **La lista principale dei progetti** (Projects nell'app, la vista polso sul
   web) diventa **due gruppi**:
   - in cima «Needs you», i progetti dove qualcosa aspetta chi guarda;
   - sotto, tutti gli altri;
   - ciascun gruppo in ordine alfabetico.

## §1 — Premesse (verificate su main 477ba31d)

- `GET /api/projects` ordina per `createdAt`
  (`apps/server/src/routes/projects.ts:256`). Da quell'elenco passano i
  selettori dell'app (Backlog, Inbox, card d'inbox, proposta Google,
  onboarding, impostazioni, EventSheet) e, sul web, `projectsQueryOptions`
  (inbox, calendario, board, docs e altri).
- `GET /api/projects/pulse` ordina con `pulseOrder` (`projects.ts:99-114`), una
  scala a cinque livelli allineata alla riga del polso. Il docblock lo
  spiega.
- ⚠️ Il Postgres del compose è inizializzato con `--locale=C`: un `ORDER BY
  name` sarebbe case-sensitive in ASCII («Zeta» prima di «alfa»), quindi
  l'ordine si fa in TypeScript.

## §2 — La regola, in un posto solo

In `@stubwise/shared`:
- `compareProjectNames(a, b)`: un `Intl.Collator` con locale `it`,
  `sensitivity: "base"` e `numeric: true`, quindi «progetto 2» viene prima di
  «progetto 10», e maiuscole e accenti non contano. A parità di nome si usa
  l'id, così l'ordine è stabile.
- `needsViewer(summary)`: `waitingForYou.length > 0` oppure una PR con
  `canMerge`. È lo stesso primo livello di `pulseOrder` di oggi, e lo stesso
  conteggio del badge «Tocca a te».

## §3 — Server

- `GET /api/projects` ordina con `compareProjectNames`.
- `pulseOrder` diventa `[needsViewer ? 0 : 1, nome]`. Riscrivi il suo
  docblock: la scala a cinque livelli era allineata alla riga del polso, e
  ora la POSIZIONE dice solo «aspetta te sì o no». Tutto il resto lo dice la
  riga sotto il nome, per decisione del maintainer del 28 set.
- È un cambio d'ordine, non di forma: nessun campo cambia, quindi è sicuro
  per le app già installate.

## §4 — Client

- **Lista principale**, app `ProjectsScreen` e vista polso del web:
  intestazioni «Needs you» e «All projects» (i18n), solo quando ENTRAMBI i
  gruppi hanno qualcosa. Il confine si calcola con `needsViewer` di shared,
  la stessa funzione del server.
- **Tutti gli altri elenchi e selettori**: arrivano già ordinati dal server.
  Cerca ogni punto che li RIORDINA in locale (`grep` su `.sort(` e
  `localeCompare` vicino ai progetti) e allinealo a `compareProjectNames`,
  oppure togli l'ordinamento locale.
- ⚠️ **Il primo elemento di un elenco può essere una scelta di default**
  (un `[0]`, un preselezionato, un «ultimo progetto usato»): cambiando
  l'ordine cambierebbe il default. Cercali, ed elencali nel riepilogo con
  cosa succede a ciascuno.
- Fuori perimetro: i risultati della ricerca, che sono per rilevanza, e gli
  elenchi di altre cose raggruppate per progetto.

## §5 — Piano

1. shared: `compareProjectNames` e `needsViewer`, con test (accenti,
   maiuscole, numeri, parità).
2. server: le due rotte, e test su ordine e gruppi, con due progetti che
   differiscono solo per le maiuscole.
3. app: `ProjectsScreen` con i due gruppi, e verifica dei selettori.
4. web: la vista polso con i due gruppi, e verifica dei selettori e di
   `projectsQueryOptions`.
5. CLAUDE.md: la voce «ogni rotta …» del polso che cita `pulseOrder` va
   aggiornata col nuovo significato dell'ordine. Una voce di deploy breve:
   server + caddy.

Verifica finale: `pnpm lint`, `pnpm typecheck`, test di shared, server, web e
app. Non aprire PR: pusha e scrivimi.
