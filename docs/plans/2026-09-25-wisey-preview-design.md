# Wisey, anteprima nell'app — design

25 set 2026. Wisey sarà l'agente AI con cui si parla a tutta l'istanza:
domande, avvio di voci di backlog, stato dei job. Questo lavoro NON lo
costruisce: gli dà il posto nell'app, la faccia e le animazioni, con risposte
finte. Il riferimento visivo è `Wisey.dc.html` (export di design, turno 5):
gufo **Classic 56×48**, sei fasi animate, anche per la tab bar (il suo
primo fotogramma di riposo — vedi §2: il Minimal che l'export proponeva per
la barra è stato scartato dopo la prova sul telefono).

Decisioni del maintainer:
1. **Tab nativa al centro**, col gufo Classic a colori. Il rilievo lo dà il
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

Icona: il **primo fotogramma di riposo del gufo Classic della 5a** (56×48,
`gufo-riposo.png` x 0..55), a colori (`iconRenderingMode: "original"`), la
stessa da selezionata e non. Su Android un'immagine va bene com'è (non
verificato su device, come il resto di Android).

✅ **Corretto il 25 set 2026, dopo la prima prova sul telefono**: questo
documento proponeva `owl/minimal.png` (il gufo Minimal 28×24 dell'export),
e nella barra si vedeva, a colori e nitido — ma il maintainer vuole il gufo
della 5a, lo stesso della schermata. Il Minimal esce dall'uso.

Misure: nella barra sta a **28×24 pt**, metà del disegno. A @2x è il
fotogramma 1:1 (56×48 px); a @3x servono 84×72 px, un fattore **1,5 non
intero**, e nessuna scala è perfetta. Se ne generano due varianti
(`scripts/wisey-assets.py`, il ragionamento è nel suo docblock): **(a)**
NEAREST a 1,5× — pixel netti ma irregolari — e **(b)** NEAREST a 3× poi
LANCZOS a 84×72 — fedele ma morbida. ✅ **Scelta la (b)** dal maintainer
sul telefono; la (a) è stata tolta.

Margine: nel fotogramma il gufo arriva a 1 px dal bordo inferiore, e sul
telefono toccava la scritta «WISEY» (gli SF Symbol delle altre tab hanno
aria intorno). La tela è quindi **28×27 pt**, col gufo in alto alla sua
misura e 3 pt trasparenti sotto — una costante dello script,
`TAB_BOTTOM_MARGIN_PT`, da ritoccare se serve.

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

- Asset: un PNG per fase, 4 fotogrammi da 56×48 affiancati (`gufo-<fase>.png`, 224×48), dal
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

## §10 — Correzioni dopo la prova sul telefono (25 set 2026)

Il maintainer ha provato la schermata completa e ha cambiato due cose.
Questa sezione **vince** sui §2, §4 e §5 dove li contraddice.

### La pagina: il gufo grande resta fisso

- Il gufo grande (2×, 112×96) sta **fisso in testa per tutta la
  conversazione**, sempre alla stessa misura, animato sulla fase, con sotto la
  riga di stato. **Non si rimpicciolisce più** alla prima domanda: niente
  `LayoutAnimation`. Scorrono solo i messaggi, sotto di lui.
- **Nessun gufo sui messaggi.** Le risposte di Wisey si distinguono per la
  bolla e per una piccola etichetta mono «WISEY» sopra il testo, come
  «Wisey · risponde» nella 5b, senza il gufo.

### La barra: il gufo segue lo stato, sempre

Supera la regola del design originale «nella tab bar resta fermo»: decisione
del maintainer.

- L'icona della tab è **animata sulla stessa fase del gufo grande**: resting
  respira, poi thinking, working, answering; listening mentre scrivi.
- **«Done» resta finché non l'hai visto.** Se una risposta finisce mentre la
  tab Wisey NON è a fuoco, sia il gufo della barra sia quello grande restano
  in «done», con l'animazione a ciclo, finché non apri la tab Wisey. Quando la
  apri, «done» fa un giro e poi si torna al riposo. Se la risposta finisce
  mentre sei su Wisey, fa un giro e torna a riposo come oggi.
- Per questo lo stato della conversazione esce dalla schermata e va in UNO
  store condiviso (un context sopra il navigator). La schermata e l'icona
  della barra lo leggono; la fase continua a essere `wiseyPhase(state)`, con
  un campo nuovo `doneUnseen`.
- **Riduzione del movimento**: anche l'icona della barra resta sul primo
  fotogramma della fase.
- Tecnica: la barra nativa non anima immagini, quindi cambiamo noi l'icona a
  ogni fotogramma. Servono 4 fotogrammi per fase alla misura della tab
  (variante morbida, tela 28×27 pt col margine di 3 pt), generati dallo
  script. ⚠️ **Rischio da provare sul telefono**: «answering» cambia
  fotogramma ogni 120 ms, e ogni cambio passa dalla barra nativa. Se sfarfalla
  o scatta, l'icona della barra usa un passo minimo (per esempio 250 ms), in
  una costante. Il gufo grande resta alla velocità del design.

### La tab senza nome

- La tab Wisey **non mostra l'etichetta** sotto il gufo; le altre quattro la
  tengono. Scelta del maintainer (25 set 2026).
- ⚠️ **VoiceOver non la nomina, ed è accettato.** Non era la richiesta
  iniziale («l'accessibilità resta, VoiceOver dice Wisey»), ma con la
  libreria non si può: in `react-native-bottom-tabs` 1.4.0 l'etichetta di
  accessibilità È il titolo (`ios/TabViewImpl.swift:238`,
  `item.accessibilityLabel = tabData.title`; nel percorso SwiftUI
  `TabItem.swift` rende `Text(title)`), le opzioni di
  `@bottom-tabs/react-navigation` non hanno un'etichetta di accessibilità per
  tab, e `labeled` vale per tutta la barra. Titolo vuoto vuol dire quindi
  nessun nome per VoiceOver. Ridarglielo senza mostrarlo richiederebbe una
  patch nativa alla libreria.
- Il margine trasparente resta **in basso**, per ora: prima si guarda sul
  telefono se iOS lascia comunque lo spazio del titolo. Se il gufo resta alto
  con un vuoto sotto, il margine si sposta in alto (costante dello script).

## §11 — Il cerchio che sporge (25 set 2026, seconda prova)

Il maintainer vuole Wisey più in evidenza nella barra: un cerchio più grande
della barra che esce sopra il bordo, sul modello delle bottom nav con un
bottone centrale rialzato che ci ha mostrato come esempio. Questa sezione
**vince** sul §10 per l'icona della barra.

Verificato sul codice (`navigation.tsx`): la barra non si nasconde mai (nessun
`tabBarHidden`) e non si rimpicciolisce scorrendo (nessun `minimizeBehavior`).
Un elemento nostro appoggiato sopra la barra nativa resta quindi al suo
posto: il rischio che al §2 ci aveva fatto scartare questa strada, qui non c'è.
Non si può fare invece l'**incavo** nella barra, perché la forma di quella
nativa non si ritaglia.

- **Il bottone** (`WiseyTabButton`) è un componente React Native nostro,
  posato sopra la barra nativa, centrato sulla terza tab, dentro
  `MainNavigator`, quindi sotto il `WiseyProvider`. Cerchio da **64 pt**,
  sfondo scuro (`ink900`, lo stesso della barra), **bordo ambra** di 2 pt e,
  fuori dal bordo, un anello di 4 pt del colore della barra che lo stacca dal
  contenuto. Sporge sopra il bordo della barra di circa metà altezza.
  Il cerchio NON è ambra pieno: il gufo è ambra e crema, e sparirebbe.
- **Dentro**, il gufo animato con `WiseySprite`, sulla fase dello store e con
  le stesse regole, compresi «done finché non l'hai visto» e la riduzione del
  movimento. La misura è da scegliere perché stia nel cerchio: circa
  42×36 pt, ridotta morbida come la variante (b).
- **A fuoco sulla tab Wisey**: il bordo ambra si accende di più, con uno
  spessore o un alone. Fuori fuoco resta come descritto sopra.
- **Tap** → si va alla tab Wisey. Accessibilità: `accessibilityRole="button"`,
  `accessibilityLabel="Wisey"`. Questo **risolve** il buco di VoiceOver del
  §10, perché il nome ora ce l'ha il bottone.
- **La tab nativa** sotto resta, così le altre quattro mantengono le loro
  posizioni, ma con un'icona **trasparente** e il titolo vuoto: la copre il
  cerchio. Tutto il meccanismo che cambiava l'icona nativa a ogni fotogramma
  (i 72 file `wisey-tab-*`, `useWiseyTabIcon`, `WISEY_TAB_MIN_FRAME_MS`) si
  **toglie**: l'animazione ora è del componente nostro.
- **Posizione verticale**: si aggancia all'altezza reale della barra (safe
  area compresa), non a un numero scritto a mano. Scegli il modo più solido
  che la libreria offre e scrivilo nel docblock.
- Il contenuto delle schermate scorre sotto la parte che sporge: è accettato,
  come negli esempi.
- Da provare sul telefono: posizione esatta sulla barra, tap, rotazione non
  necessaria (l'app è verticale), tastiera aperta (il cerchio resta sotto la
  tastiera), pannelli nativi aperti (lo coprono).
