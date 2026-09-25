# Wisey, anteprima nell'app — design

25 set 2026. Wisey sarà l'agente AI con cui si parla a tutta l'istanza:
domande, avvio di voci di backlog, stato dei job. Questo lavoro NON lo
costruisce: gli dà il posto nell'app, la faccia e le animazioni, con risposte
finte. Il riferimento visivo è `Wisey.dc.html` (export di design, turno 5):
gufo **Classic 56×48**, sei fasi animate; **Minimal** per la tab bar.

Decisioni del maintainer:
1. **Tab nativa al centro**, col gufo Minimal a colori. Il rilievo lo dà il
   colore, non la misura: la barra resta quella nativa col Liquid Glass.
2. **Via il tab DOC**. «Ask the project» si sposta nella pagina Docs
   dell'hub del progetto.
3. **Risposte oneste**: Wisey recita tutte le fasi ma dice cosa FARÀ, non
   inventa dati su progetti veri. Etichetta «Preview» nell'intestazione.

## §1 — Premesse (verificate sul codice di `main`, 2c6a7779)

- Tab bar: `createNativeBottomTabNavigator` di `@bottom-tabs/react-navigation`
  su `react-native-bottom-tabs` 1.4.0 (`apps/mobile/src/app/navigation.tsx`).
  Oggi le tab sono Inbox, Projects, Backlog, Docs, Mbx; le icone sono SF
  Symbol via `nativeTabIcon`.
- La libreria accetta anche un'immagine come icona, e ha
  `iconRenderingMode: "original"` (in Swift `.alwaysOriginal`,
  `TabViewImpl.swift`): senza, iOS ricolora l'immagine con la tinta della
  barra e il gufo diventerebbe una sagoma grigia.
- «Ask the project» (`AskProjectScreen`) è raggiungibile SOLO dal tab DOC
  (`DocsScreen.tsx:124`, rotta `Ask` del `DocsStack`).
- La ricerca globale apre i risultati di documentazione navigando al tab
  `Docs` (`GlobalSearchSheet.tsx:222`). `DocsPageScreen` è già registrata
  anche nello stack dei progetti (rotta `Page`, hub del 22 set).
- `ProjectDocsScreen` (hub del progetto) esiste e non ha l'ingresso alla chat.
- `TabScreenKeyboardAvoider` è lo strumento per un campo fisso in fondo a una
  schermata dentro le schede (`lib/keyboard.ts` spiega i tre casi).

## §2 — La barra

Ordine: **Inbox · Projects · Wisey · Backlog · Mailbox**. La tab iniziale
resta Inbox: finché Wisey è un'anteprima, aprire l'app su un finto sarebbe
sbagliato. Quando Wisey sarà vero, cambiarla sarà una riga.

Icona: `owl/minimal.png` del design, a colori (`iconRenderingMode:
"original"`), la stessa da selezionata e non. Su Android un'immagine va bene
com'è (non verificato su device, come il resto di Android).

⚠️ **Rischio da verificare PER PRIMO, su device**: che l'immagine a colori
resti nitida e della misura giusta dentro la barra col Liquid Glass. Se il
rendering non regge, si torna qui prima di scrivere la schermata.

## §3 — Il tab DOC che se ne va

- Rimossi: la tab `Docs`, `DocsNavigator`, `DocsStack`, `DocsScreen` e i suoi
  test. `DocsPageScreen` e `AskProjectScreen` restano.
- `AskProjectScreen` passa nello stack dei progetti come rotta `Ask`
  (`{ projectId, projectName }`, invariati). `ProjectDocsScreen` guadagna un
  bottone «Ask this project ›» in testa, che apre quella rotta.
- ⚠️ `AskProjectScreen` usa `TabScreenKeyboardAvoider`: nello stack dei
  progetti è ancora dentro le schede, quindi resta giusto. Da riprovare sul
  telefono comunque.
- `GlobalSearchSheet`: un risultato di documentazione naviga a
  `Projects → Page` invece che a `Docs → Page`, con gli stessi parametri.
- Chiavi i18n del solo `DocsScreen`: via, in it e en.
- Link che portano al tab Docs (notifiche push, deep link): cercarli tutti
  (`grep` su `"Docs"` nelle navigate e nella config di linking) e
  reindirizzarli a Projects. Nessuno deve restare a puntare una tab che non
  esiste.

## §4 — La schermata Wisey

Dall'alto:

1. `ScreenHeader` con titolo «Wisey» e un'etichetta **«Preview»** in ambra,
   in stile badge del design (bordo ambra, mono, maiuscolo).
2. **Il gufo grande**, 56×48 mostrato a 2× (112×96), centrato, animato sulla
   fase corrente, con sotto una riga di stato in mono («Resting», «Listening…»,
   «Thinking…», «Working…», «Answering», «Done»). Quando c'è una
   conversazione il gufo si rimpicciolisce in testa (a 1×) per lasciare spazio
   ai messaggi: una transizione animata, non uno scatto.
3. **I messaggi**: quelli dell'utente allineati a destra; quelli di Wisey a
   sinistra, con il gufo piccolo **fermo** al primo fotogramma accanto (regola
   del design: una sola istanza animata per schermata). Prima conversazione
   vuota: una frase di benvenuto e 3 suggerimenti premibili
   («What's waiting for me?», «Start a backlog item», «How is my project
   doing?»).
4. **Il campo** in fondo, con `TabScreenKeyboardAvoider`: placeholder «Ask or
   ask me to do…», bottone ↑ disabilitato a campo vuoto.

La conversazione vive nello stato del componente: le schede restano montate,
quindi sopravvive al cambio di tab e sparisce alla chiusura dell'app. Nessuna
chiamata al server.

## §5 — Le fasi e chi le decide

Come dice il design, la fase non si sceglie a mano: è una funzione dello
stato. Qui lo stato è quello del mock, in UNA funzione pura
(`wiseyPhase(state)`), così quando arriverà il job vero cambierà l'input, non
le regole:

| stato | fase |
|---|---|
| niente in corso, campo non a fuoco | riposo |
| campo a fuoco o testo scritto | ti ascolta |
| domanda inviata, prima del lavoro | sta pensando (≈1,5 s) |
| domanda che chiede di FARE qualcosa (backlog, ticket, run) | sta lavorando (≈2,5 s) |
| testo della risposta che compare | ti risponde |
| risposta finita | fatto (un giro solo), poi riposo |

Il testo della risposta compare a scatti (parola per parola), a tempo col
becco. Un secondo invio durante una risposta è disabilitato.

## §6 — Le risposte finte

In `lib/wisey-mock.ts`, pura e testata: dalla domanda (parole chiave, in
inglese e italiano) a `{ kind: "answer" | "action", text }`. Le risposte
dicono cosa Wisey FARÀ e dove si fa oggi; non nominano mai un dato vero.
Gruppi: backlog, ticket/fix, PR/merge, posta, stato di un progetto,
saluto, generica. In inglese e italiano, via i18n.

Esempio (backlog): «Soon I'll create the backlog item and estimate it for
you. For now I'm a preview: you can do it from Backlog › New idea.»

## §7 — L'animazione

- Asset: un PNG per fase, 4 fotogrammi affiancati (`gufo-<fase>.png`), dal
  design. Pre-scalati **nearest-neighbour** a @2x e @3x per le misure usate
  (uno script in `apps/mobile/scripts/`, rieseguibile): iOS scala le immagini
  con interpolazione, e la pixel art si sfocherebbe.
- Riproduzione: un timer a 4 passi e un'immagine spostata dentro un
  contenitore che la ritaglia. Nessuna libreria di animazione, nessuna
  interpolazione fra fotogrammi. Durate del ciclo dal design: riposo 3,2 s,
  ascolta 0,6 s, pensa 1,4 s, lavora 1 s, risponde 0,48 s, fatto 1,4 s.
- **Riduzione del movimento** di sistema attiva (`AccessibilityInfo`): il
  gufo resta fermo al primo fotogramma e lo stato lo dice la riga di testo.
- Il timer si ferma quando la tab non è a fuoco.

## §8 — Fuori da questo lavoro

Qualunque chiamata al server, la memoria delle conversazioni, Wisey nelle
notifiche o nell'onboarding, l'icona dell'app, il web.

## §9 — Rilascio

Solo app: nessun deploy, nessuna modifica al server. Nessuna dipendenza
nativa nuova (le immagini sono asset di Metro). Le varianti Modern e le
versioni 28×24 del design non servono qui.
