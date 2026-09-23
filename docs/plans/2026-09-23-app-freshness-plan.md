# Piano — L'app non resta indietro (23 set 2026)

Design: `docs/plans/2026-09-23-app-freshness-design.md`.

Perimetro: **solo `apps/mobile`**. Nessun server, nessun web, nessuno schema.

---

## Task 1 — Ricaricare quando l'app torna in primo piano

`app/providers.tsx`: collega `focusManager` di TanStack Query ad `AppState`
(forma documentata per React Native). Il listener `AppState` esistente per
inbox e badge **resta com'è**.

Test: portare l'app in background e di nuovo in primo piano ricarica una
query scaduta di una schermata montata; una non scaduta NO.

---

## Task 2 — Ricaricare quando si torna su una schermata

Un solo punto: `onStateChange` del `NavigationContainer`
(`app/navigation.tsx`), che chiama `refetchQueries({ type: "active", stale:
true })`.

⚠️ **Globale, non un hook per schermata**, e il docblock deve dire perché
(design §3): un hook da ricordarsi in ogni schermata è la fragilità che
questo lavoro toglie. E deve dichiarare il costo — si ricaricano anche le
schermate sotto nello stack, se scadute.

Test sull'albero VERO (come quelli dell'hub in `app/navigation.test.tsx`):
una schermata con una query scaduta, entri in una figlia, torni, la query si
è ricaricata; con una query NON scaduta, non si ricarica.

---

## Task 3 — Le azioni dichiarano cosa cambiano

La mappa è nel design §4. Una riga in ciascuno dei **quattro** involucri
condivisi, mai nelle singole chiamate:

1. `useDecision` (`lib/inbox-mutations.ts`) — polso, `ticketKeys.all`,
   `backlogKeys.all`, `milestoneKeys.all`, `mailKeys.all`, e il ticket aperto
   se l'azione ne porta uno.
2. `useHandled` / `useSnooze` — il polso.
3. `useTicketAction` (`lib/work-mutations.ts`) — il polso, in aggiunta a
   quello che invalida già.
4. `useConvertBacklogItem` (`lib/backlog-mutations.ts`) — il polso.

⚠️ Il polso si invalida con **`projectsPulseKey`**, non con
`projectKeys.all` (design §4).

⚠️ Il test di ognuna NON asserisce «`invalidateQueries` è stata chiamata»
(passerebbe anche senza raggiungere niente): semina il polso in cache, fa
l'azione, e verifica che la query del polso sia marcata scaduta. È la forma
che la tappa 1 ha usato per `ticketKeys.hub`.

E almeno UN test sull'albero vero che riproduca il sintomo del design §1:
approvi un piano da un ticket aperto dal progetto, torni indietro **subito**
(dentro lo `staleTime`), e il ticket non è più sotto «aspetta te». Fatto
fallire togliendo l'invalidazione da `useTicketAction`.

---

## Task 4 — Il polso ogni minuto

`refetchInterval: 60_000` sulla query `projectsPulseKey` in **entrambi** i
posti che la leggono: `screens/projects/ProjectsScreen.tsx` e
`screens/projects/ProjectDetailScreen.tsx`. Se lo metti in uno solo, l'altro la
legge con un'opzione diversa e il comportamento dipende da quale schermata è
montata — il docblock lo dica.

---

## Task 5 — Trascina per aggiornare ovunque

Un componente o hook condiviso (la forma di riferimento è quella di
`InboxScreen`), che ricarica le query di QUELLA schermata e tiene la rotella
finché non hanno finito tutte. Montalo su ogni schermata che mostra dati del
server: elenco progetti, hub, le schermate dell'hub (ticket, backlog,
repository, documentazione, roadmap, monitor, server, impostazioni), ticket,
backlog, dettaglio voce, documentazione, posta, calendario.

Se una schermata non si presta (una chat, un modulo in scrittura), lasciala
fuori e **dillo nella PR**, con il perché.

Test: su almeno l'hub e l'elenco ticket, il gesto ricarica le query della
schermata.

---

## Task 6 — Verifica

⚠️ **Rischio principale, design §6**: più ricaricamenti possono far diventare
rossi test che contano le chiamate (`toHaveBeenCalledTimes(1)`). Un rosso lì
si LEGGE prima di correggerlo: può voler dire che il ricaricamento parte dove
non dovrebbe. Scrivi nella PR ogni test di questo tipo che hai dovuto toccare,
e perché.

⚠️ E verifica con un test che il ricaricamento al ritorno non annulli un
aggiornamento ottimistico di «Fatto» in corso.

Typecheck **dopo** l'ultimo test scritto; metodi nuovi nel doppio del client
**prima** dei test che li usano; `pnpm typecheck`, `pnpm test`, `pnpm lint`
dalla radice.

Il maintainer verifica una cosa sola sul telefono (design §8).
