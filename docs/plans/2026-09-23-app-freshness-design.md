# L'app non resta indietro (23 set 2026)

## §1 — Cosa succede oggi, misurato

Il sintomo da cui si parte: nel dettaglio di un progetto il **polso** resta
com'era. Approvi il piano del #27 dal ticket, torni indietro, e il #27 è
ancora sotto «aspetta te». Il worker finisce il fix del #29 mentre guardi il
progetto, e il #29 resta «in corso» finché non esci e rientri.

Contato sul codice (`apps/mobile/src`, 23 set 2026):

- **17 invalidazioni** in tutta l'app. Il polso (`["projects","pulse"]`) lo
  raggiunge **una sola**: il salvataggio delle impostazioni di progetto
  (tappa 3 dell'hub, `projectKeys.all` = `["projects"]`). Nessuna delle azioni
  che il polso lo cambiano davvero.
- **Solo l'inbox si ricarica da sola**: ogni 60 secondi (`refetchInterval` in
  `lib/inbox-mutations.ts`) e quando l'app torna in primo piano (il listener
  `AppState` in `app/providers.tsx`, che ricarica l'inbox e il badge e basta).
  Nessun'altra schermata si aggiorna, né al ritorno né da ferma.
- **Solo due schermate** hanno il «trascina per aggiornare»: le due inbox.
- L'app **non ha** refetch al ritorno su una schermata: `useFocusEffect` non è
  usato da nessuna parte, e `focusManager` di TanStack Query non è collegato
  ad `AppState`.

E c'è una promessa scritta e mai mantenuta, nel commento che configura la
cache (`app/providers.tsx`):

> I dati di Stubwise cambiano per iniziativa di altri (un altro maintainer
> risponde, il worker finisce un job): […] i task successivi (inbox, pulse)
> decideranno l'intervallo di refetch per singola query.

L'inbox il suo intervallo l'ha avuto. Il polso no.

## §2 — Due cause diverse, che nessun rimedio singolo copre

**(a) Cambiamenti fatti da ALTRI** — il worker che finisce un job o apre una
PR, un collega che risponde o approva. È la causa principale per il polso, e
**nessuna invalidazione può vederla**: un'invalidazione nell'app sa solo quello
che fai tu dal telefono. Qui l'unico rimedio è ricaricare.

**(b) Cambiamenti fatti da TE, dall'app** — rispondi, approvi, converti.
Ricaricare al ritorno qui **non basta**, ed è il punto meno ovvio del design:
il ricaricamento rispetta lo `staleTime` (10 secondi sul polso), e il caso più
frequente è proprio quello in cui approvi e torni indietro in tre secondi. I
dati hanno tre secondi, non sono vecchi, e non si ricaricano. Serve che
l'azione dichiari cosa ha cambiato.

Decisione del maintainer: **tutte e due**, più un terzo pezzo per il caso che
nessuna delle due copre — guardare la schermata senza muoversi (§5).

## §3 — Ricaricare al ritorno: in UN posto, per tutte le schermate

Due momenti, due meccanismi, entrambi **globali**:

1. **L'app torna in primo piano.** `focusManager` di TanStack Query collegato
   ad `AppState` — la forma documentata per React Native. Da lì ogni query
   montata e scaduta si ricarica da sola al ritorno. Il listener `AppState`
   esistente (inbox + badge) resta com'è: TanStack deduplica due richieste
   concorrenti sulla stessa chiave, quindi non c'è un doppio fetch.
2. **Si torna su una schermata.** Un solo punto nel `NavigationContainer`
   (`onStateChange`) che ricarica le query montate e scadute
   (`refetchQueries({ type: "active", stale: true })`).

⚠️ **Perché globale e non un hook per schermata.** La forma che si trova
nella documentazione di TanStack per React Native è un `useRefreshOnFocus`
da chiamare in ogni schermata. È la stessa fragilità che questo lavoro esiste
per togliere: ogni schermata nuova dovrebbe ricordarsene, e le tre scoperte di
questa settimana (le chiavi dell'hub, `useTicketAction`, il polso) sono tutte
la stessa cosa — un punto che qualcuno doveva ricordarsi e non l'ha fatto. Un
punto solo vale per le schermate di oggi e per quelle che verranno.

**Il costo, dichiarato.** «Montate» include le schermate che stanno SOTTO
nello stack: tornando indietro si ricaricano anche le loro query scadute, non
solo quelle della schermata in vista. È spreco, ma limitato — solo query più
vecchie del loro `staleTime`, e lo stack dell'app è profondo due o tre livelli.
Filtrarle per schermata richiederebbe di sapere, globalmente, quale query
appartiene a quale rotta: non c'è un modo pulito, e il guadagno non lo vale.

## §4 — Le azioni dichiarano cosa cambiano

La mappa, verificata leggendo le mutazioni:

| azione | dove | oggi invalida | cambia anche |
|---|---|---|---|
| decisioni dall'inbox: approva, rifiuta, rilancia, rispondi, Procedi, conferma proposta | `useDecision` (`lib/inbox-mutations.ts`) | inbox | **polso**, ticket, il ticket aperto, backlog, milestone, posta |
| «Fatto» / rimanda | `useHandled` / `useSnooze` | inbox (ottimistico) | **polso** (`waitingForYou` esclude le notifiche gestite) |
| azioni sul ticket: piano, stato, campi, commento, lancia AI, rispondi | `useTicketAction` (`lib/work-mutations.ts`) | il ticket, ticket, milestone (se cambia milestone) | **polso** |
| converti voce di backlog | `useConvertBacklogItem` | backlog, ticket | **polso** (`backlogReadyCount`) |
| salva impostazioni | `ProjectSettingsScreen` | progetti (polso compreso) | — |

⚠️ **Le correzioni vanno nei QUATTRO punti condivisi, non nelle chiamate.**
`useDecision`, `useHandled`/`useSnooze`, `useTicketAction` e
`useConvertBacklogItem` sono già gli involucri da cui passano tutte quelle
azioni: una riga in ciascuno copre ogni chiamata di oggi e di domani. È la
stessa forma di `useConvertBacklogItem` → `ticketKeys.all` (tappa 1): la
mutazione dichiara una volta cosa ha cambiato, nessuna schermata viene
nominata.

⚠️ **Il polso si invalida con la sua chiave vera** (`projectsPulseKey`,
`screens/projects/ProjectsScreen.tsx`), non con `projectKeys.all`: quella
porterebbe con sé il dettaglio, la lista e le impostazioni di ogni progetto a
ogni «Fatto» su una notifica. Dichiarare il minimo che è cambiato davvero.

Le decisioni dall'inbox sono il caso più largo — una conferma di proposta può
creare un ticket, una voce di backlog o una milestone. Lì invalidare `tickets`,
`backlog` e `milestones` insieme al polso è corretto: non si sa in anticipo
cosa creerà, e sono tre query piccole.

## §5 — Mentre guardi la schermata

Il caso che le due cose sopra non coprono: stai guardando il progetto, non
tocchi niente, e il worker finisce un job.

Decisione del maintainer:

- **Il polso si ricarica da solo ogni minuto**, come l'inbox
  (`refetchInterval: 60_000` sulla query `projectsPulseKey`, in **entrambi** i
  posti che la leggono — `ProjectsScreen` e `ProjectDetailScreen` — o uno dei
  due la terrebbe ferma). Solo il polso: è la parte che dice cosa fare adesso e
  contiene i job «in corso», cioè proprio ciò che cambia mentre guardi.
  Collegato `focusManager` ad `AppState` (§3), l'intervallo si ferma da solo
  quando l'app va in background.
- **«Trascina per aggiornare» su tutte le schermate con dati**, con un
  componente condiviso: il gesto ricarica le query di QUELLA schermata, e la
  rotella resta finché non hanno finito tutte. Oggi ce l'hanno solo le due
  inbox, e la loro forma è il riferimento.

## §6 — Rischi da guardare

- **Gli aggiornamenti ottimistici.** `useHandled`/`useSnooze` scrivono subito
  la cache e poi aspettano il server. Un ricaricamento globale partito a metà
  potrebbe riportare per un istante lo stato vecchio. Oggi `onMutate` chiama
  `cancelQueries` sulla lista (verificato, `lib/inbox-mutations.ts:140`), che è
  la difesa giusta: va verificato che regga anche contro il ricaricamento al
  ritorno, con un test.
- **I test che contano le chiamate.** Più ricaricamenti significa che un test
  che asserisce `toHaveBeenCalledTimes(1)` su una lettura può diventare rosso.
  Un rosso lì va **letto**, non corretto alzando il numero: può voler dire che
  il ricaricamento parte dove non dovrebbe.
- **Il costo in richieste**, dichiarato in §3 e §5: una al minuto sul polso
  mentre l'app è aperta su un progetto, più le query scadute a ogni ritorno.

## §7 — Cosa NON si fa

- **Niente aggiornamenti spinti dal server** (websocket, push silenziose): è la
  soluzione «vera» al caso (a), ma è un'infrastruttura nuova per un problema
  che il ricaricamento risolve già abbastanza bene.
- **Niente hook per schermata** (§3).
- **Gli `staleTime` non si toccano**: sono scelte fatte schermata per
  schermata, e questo lavoro non ha motivo di ridiscuterle.
- **Il web non si tocca**: nel browser TanStack Query ricarica già al ritorno
  sulla finestra di default.

## §8 — Cosa verifica il maintainer

Un solo percorso sul telefono: apri un progetto con un piano da approvare,
entri nel ticket, approvi, torni indietro. Il ticket non deve più comparire
sotto «aspetta te», **senza** uscire dal progetto e rientrare.
