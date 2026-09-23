# Piano — Hub del progetto, TAPPA 3 (23 set 2026)

Design: `docs/plans/2026-09-22-project-hub-design.md` (§6 e §7).

Perimetro (design §9.3): **monitor e impostazioni**. È l'ultima tappa: dopo
di questa l'hub è completo.

---

## Task 1 — `serverViewSchema` e `serverDetailSchema` in `packages/shared`

Oggi vivono **dentro `apps/server/src/routes/servers.ts`** (righe 49 e 76).
L'app parsa davvero le risposte, quindi finché sono lì non può leggere quella
rotta affatto — è l'ostacolo del design §6, e non è di UI.

Vanno in `packages/shared/src/schemas/server.ts`, dove stanno **già** i loro
pezzi (`serverStatusSchema`, `alertThresholdsSchema`,
`discoveredServiceSchema`): è il posto, non uno nuovo. La rotta li importa.

⚠️ **Lo spostamento non deve cambiare NESSUNA risposta.** È una riscrittura
di dove vive una dichiarazione, non di cosa produce la rotta: se nel farlo un
campo cambia forma o nome, quella non è più questa tappa — è un cambio
rompente verso un'app che si aggiorna dagli store. Il modo di accorgersene è
che i test esistenti di `servers` restino verdi **senza** essere ritoccati:
se devi modificarli, fermati e dimmelo.

⚠️ Il **web ha un terzo `ServerView`** scritto a mano in
`apps/web/src/lib/api.ts` (riga 2806). Allinealo importando da `shared`:
lasciarne tre è come questo repo si procura le divergenze che poi insegue.
Se l'allineamento fa emergere una differenza fra i due, **è una scoperta, non
un fastidio**: dimmela invece di appianarla.

---

## Task 2 — Il gruppo `servers` nel client

`packages/api-client/src/endpoints/servers.ts` (nuovo):
`list(projectId?)` → `GET /api/servers?projectId=`, `get(id)` → `GET
/api/servers/:id`.

Entrambe le letture sono `requireAuth` e non `requireAdmin` (verificato:
righe 214 e 252 della rotta), quindi un operatore le vede — coerente con
quanto il design §6 dice all'utente. **Nessuna scrittura**: creare o
configurare un server resta sul web.

---

## Task 3 — Monitor: sezione, elenco, cruscotto

Sezione dell'hub: quanti server e se qualcosa è giù — `MONITOR · 2 server · 3
controlli giù`, con il rosso solo quando c'è davvero qualcosa di rotto.

Schermata elenco: una card per server. Dettaglio: il **cruscotto pieno**
deciso dal maintainer — CPU con lo storico, memoria, dischi per mount,
servizi scoperti, versione dell'agente, controlli su/giù.

`react-native-svg` è **già una dipendenza** (l'abbiamo aggiunta per le icone),
quindi lo storico della CPU si disegna con quello: nessuna libreria nuova,
nessun build nativo da rifare.

⚠️ `metricsAt` dice **quando** è stato preso l'ultimo campione: un cruscotto
che mostra numeri di due ore fa come se fossero di adesso mente. Se il
campione è vecchio, la schermata lo dice.

⚠️ Un server che non ha mai inviato campioni ha liste vuote e `null` ovunque:
è `never_connected`, e si dice così — non «0% di CPU», che è un numero falso.

---

## Task 4 — Impostazioni: lettura per tutti, modifica agli admin

`projects.patch(projectId, input)` nel client — `updateProjectSchema` è già
in `shared` ed è **già una patch a campi opzionali**, che è esattamente la
forma che un client mobile richiede (CLAUDE.md: un body che cresce nel tempo
non rende obbligatorio niente).

⚠️ **Manda solo i campi che cambiano**, mai l'oggetto intero: due persone che
salvano dalla stessa schermata non devono sovrascriversi a vicenda i campi
che nessuna delle due ha toccato.

I campi: nome, descrizione, aggiornamento automatico dei documenti, report
giornaliero, backlog, pulse con la cadenza (1-30), brief settimanale.

Un **admin** modifica; un **operatore** legge, con la riga che spiega perché
(la stessa del web, `projects:detail.readOnlyHint`). Il gate vero resta sul
server (`PATCH /:projectId` è `requireAdmin`, verificato): l'app non
reinventa la regola, e un 403 va mostrato, non ingoiato.

⚠️ **Il pulse acceso senza backlog è muto** — non ha voci da proporre. Il web
lo dice nel valore invece di mostrare una cadenza che non succederà;
l'app dica la stessa cosa. Due superfici che spiegano diversamente lo stesso
stato sono un modo di sbagliare che qui si evita a costo zero.

---

## Task 5 — Le sezioni nell'hub

In fondo, nell'ordine del design §3: monitor dopo la roadmap, impostazioni
per ultima — si scende da «cosa devi fare» a «com'è configurato».

⚠️ Chiavi di query **sotto i prefissi esistenti**, mai un namespace nuovo. È
la lezione che questo lavoro ha già pagato due volte (la review sulla tappa 1,
e `useTicketAction` trovato durante la tappa 2). E il salvataggio delle
impostazioni deve invalidare ciò che le mostra: la sezione, la schermata, e
il progetto ovunque sia letto.

---

## Task 6 — Verifica

`pnpm --filter @stubwise/shared... build` prima di credere a un rosso locale.
Typecheck **dopo** l'ultimo file di test scritto, poi test e lint dalla
radice. Metodi nuovi nel doppio del client **prima** dei test che li usano.

⚠️ Questa tappa tocca `apps/server` e `apps/web`, non solo l'app: il deploy
sarà **server + caddy**, a differenza della tappa 2. Se ti accorgi di aver
cambiato il comportamento di una rotta invece che solo la posizione di uno
schema, dillo — cambia cosa va deployato e come.

Il maintainer verifica: aprire un progetto, vedere lo stato dei server e i
numeri di un server, e leggere le impostazioni (modificandone una, se è
admin).
