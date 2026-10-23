# Shape brief — Home a blocchi + La mia settimana

Superficie: `#/home` (blocchi) e `#/home?view=week` (pagina intera); blocco
`myWeek` dentro la Home. Piano: Task 9 e 10. Spec: area 2 §2. Mondo visivo:
«Catalogo numerato» (`apps/desktop/DESIGN.md`), modalità **Operate**. Le
voci marcate **[ASSUNZIONE]** non sono nello spec: da confermare.

## 1. Lavoro e pubblico

- Chi arriva: chiunque, ogni mattina e più volte al giorno, da qualunque
  reparto (marketing, sviluppo, assistenza, amministrazione). La Home è la
  porta d'ingresso e la destinazione di default del binario.
- Stato d'animo: «cosa aspetta me, cosa faccio oggi». Non esplora, smista.
- Bisogno diverso per reparto: lo copre la composizione a blocchi (Home del
  reparto + personalizzazione), non una pagina uguale per tutti.

## 2. Esito e prova

- Azione primaria: **decidere sul posto** ciò che aspetta me (Da decidere),
  poi aprire la prossima task della settimana.
- Successo: in 5 secondi so se qualcuno è fermo per colpa mia e cosa ho oggi;
  rispondere a una decisione non richiede di aprire la task.
- Verità del prodotto: la decisione chiesta a me ferma la task di qualcun
  altro e accende il punto sulla tessera; risponderle qui spegne entrambe
  le cose. Il carico è in taglie, mai in numero, con «+N no estimate».

## 3. Direzione scelta

- **Tesi strutturale**: la Home è un **indice a sezioni**, non una bacheca
  di riquadri. Ogni blocco è una sezione della stessa colonna di lettura,
  separata dalla successiva da un filetto, con titolo `headline` 20px, un
  conteggio in cifre tabellari e «Open»/«Show all N» a destra. Niente card
  con bordo o ombra: il blocco è definito da titolo + filetto.
- **Sequenza**: `Home` (h1 28px) → riga discreta «Your department's Home
  has changed · See what's new» se serve → **Decide** → **My week** → blocchi
  del reparto/personali nell'ordine risolto.
- **Momento focale**: la prima voce di Decide — domanda, chi chiede, task
  citata col codice, e le opzioni come bottoni inline (più «Other…»).
- Conseguenza: un solo componente «sezione di blocco» con quattro stati
  (caricamento, vuoto, errore locale, pieno); ogni blocco ci mette dentro
  righe del kit (`TaskRow`), mai un layout proprio.

```
┌─rail─┬─column──────┬─work area (720–1136px)───────────────────────────┐
│ S_   │ Home      ● │ Home                               [Customize]   │
│ ⌂    │ My week     │ Your department's Home has changed · See what's new│
│ …    │ ─ PINNED ─  │ ────────────────────────────────────────────────  │
│ MKX● │ Open · MKX  │ Decide  2                                        │
│ AUD  │ Stalled >7d │ Elena asks: Which headline for the spring mailer? │
│      │ All filters │ ▌MKX-14 Spring newsletter          [A] [B] Other…│
│      │ Planning    │ Turn into task · AUD request "Export CSV" ×3  [→] │
│      │             │ ────────────────────────────────────────────────  │
│      │             │ My week  W43 · Oct 19–23       ▬▬▬▬▬▬░░  +2 no est│
│      │             │ Mon 2 · Tue 1 · Wed 3 · Thu — · Fri 1 · Week 2    │
│      │             │ Today ▌MKX-21 Banner copy review   M  Fri         │
│      │             │                         Open my week →            │
│      │             │ ────────────────────────────────────────────────  │
│      │             │ My tasks  [Assigned to me|Delegated|Following]    │
│      │             │ OVERDUE  ▌AUD-88 Invoice export check  S  Oct 21  │
└──────┴─────────────┴──────────────────────────────────────────────────┘
```

## 4. Ambito e confini

- Dentro: risoluzione dei blocchi (`resolveHome`), modalità «Customize»,
  i sette blocchi del catalogo dello spec, La mia settimana (blocco e
  pagina), colonna della Home (Home, My week, filtri fissati, All filters,
  Planning con il permesso).
- Fuori: voci di Claude in Decide (area 3, stessa forma), blocchi di chat,
  posta, rilasci (aree successive). Nessun numero di peso a schermo.
- Anti-obiettivi: dashboard di card con KPI; una Home uguale per tutti;
  decisioni che obbligano ad aprire la task per rispondere.

## 5. Stati e intervalli

- Decide: 0 («Nothing to decide» + frase breve), tipico 1–4, massimo ~15
  → mostra 5, poi «Show all 15» espande in posto. Opzioni 0–5 (+ Other…);
  domande fino a ~200 caratteri, due righe poi ellissi con testo intero
  nella task.
- My week: 0–25 task; slittate 0–6 con «Slipped ×N»; giorni vuoti mostrano
  «—». Settimana precedente in sola lettura.
- My tasks: 0–60, gruppi Overdue / Today / This week / Later / No date;
  ogni gruppo mostra 5 righe e «Show N more». **[ASSUNZIONE]** 5 come tetto.
- Filtro come blocco: prime 5 righe + conteggio per chi guarda + «Open».
- Errore di un blocco: messaggio e «Retry» **dentro** il blocco, gli altri
  restano. Caricamento: scheletro con le righe della forma vera (3 righe).
- Senza permessi: un blocco che richiede un permesso non esiste nel
  catalogo; Decide mostra solo le richieste di decisione se non si può
  creare task.

## 6. Interazione e layout

- **Colonna di lettura** larga fino a 960px, allineata a sinistra con 32px
  di margine; oltre resta spazio calmo. **[ASSUNZIONE]** un'unica colonna
  anche a 1440: nessuna griglia a due colonne di blocchi.
- 1024×680: area di lavoro 720px, tutti i blocchi a piena larghezza; nelle
  righe la colonna «progetto» cede per prima, poi la scadenza diventa breve.
- Pannello di dettaglio (`?task=`): aprire una riga apre il pannello —
  affiancato da 1200px (l'area scende a ~536–776px, la colonna di lettura si
  stringe), sovrapposto sotto. J/K scorrono le righe della sezione corrente.
- Rispondere a una decisione: ottimistico; la voce si chiude in 200ms
  (altezza che collassa), toast «Answered · Undo» per 5s; su errore torna
  al suo posto con toast che lo dice.
- **Customize**: la pagina entra in modalità modifica senza cambiare rotta.
  Chi ha `department.home.manage` sceglie prima «My Home» / «<Dept> Home».
  Ogni sezione diventa una riga compatta (maniglia, titolo, «Hide»; Decide e
  My week con lucchetto e «Always shown»), trascinabile con mouse e con
  tastiera (Space prende, frecce, Space lascia, Esc annulla, annuncio live).
  In fondo «Add block» apre il catalogo; in testa «Done» e «Reset to
  department Home» (con conferma). **[ASSUNZIONE]** in modifica i contenuti
  dei blocchi si nascondono: si riordinano titoli, non liste.
- **La mia settimana (pagina)**: h1 «My week», sotto «W43 · Oct 19–23»,
  navigazione «‹ Previous · This week · Next ›», `LoadBar` + «+N no
  estimate», «Plan next week» (= Next). Sei colonne: Mon–Fri e «This week»
  (senza giorno) per prima a sinistra **[ASSUNZIONE: a sinistra, perché è la
  vasca da cui si smista]**; oggi marcato col solo testo «Today» + ink, non
  con un colore. Carte: striscia, codice, titolo su 2 righe, taglia, segno
  slittata. Trascinamento fra colonne (mouse + tastiera), ottimistico.
  A 720px ogni colonna ~110px: titolo su 3 righe, codice sempre intero.
- Movimento: 150–250ms, solo collasso delle voci risolte e ingresso della
  modalità modifica; zero con riduzione del movimento.

## 7. Vincoli e decisioni aperte

- Inglese/italiano: titoli di blocco e giorni più lunghi in italiano
  («Lunedì» → abbreviati `Lun`); nessuna larghezza fissa sul testo.
- Accessibilità: ogni blocco è una `section` con `aria-labelledby`; la
  risposta a una decisione è un gruppo di bottoni con nome che include la
  domanda; il giorno di una task è annunciato al drop.
- Il giorno è personale: non compare a nessun altro né nel dettaglio della
  task per gli altri.
- Da decidere (non inventare): **[ASSUNZIONE]** che la riga «department
  Home changed» si chiuda da sola dopo «See what's new» (mostra i blocchi
  aggiunti con «Add» accanto) e non ricompaia fino al prossimo cambio.
