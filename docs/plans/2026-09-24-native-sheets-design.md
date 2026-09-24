# I pannelli dell'app diventano quelli nativi di iOS (24 set 2026)

## §1 — Il difetto, segnalato dal maintainer

«TUTTI i bottomsheet di questa applicazione non funzionano come dovrebbero:
non posso scorrerli in giù per chiuderli e hanno un background opaco sotto.»

Vero, e il motivo è uno solo: nessuno dei pannelli è il foglio di sistema.
Sono `Modal` di React Native con uno sfondo disegnato a mano
(`rgba(5,7,10,0.7)`) e un pannello ancorato in basso: niente trascinamento,
niente elastico, un velo che non è quello di iOS.

**Le dieci finestre, contate** (`grep -rl "<Modal" apps/mobile/src`):

| finestra | file | forma oggi |
|---|---|---|
| nuova voce di backlog | `screens/backlog/CaptureSheet.tsx` | pannello dal fondo, campo di testo |
| rifiuto di un piano | `components/inbox/RejectSheet.tsx` | pannello dal fondo, campo di testo |
| domanda dell'agente | `components/inbox/QuestionSheet.tsx` | pannello dal fondo, risposta libera |
| etichette | `components/work/LabelsSheet.tsx` | pannello dal fondo, campo di testo |
| scelta di un campo | `components/work/ChoiceSheet.tsx` | pannello dal fondo, elenco |
| rimanda una notifica | `components/inbox/SnoozeSheet.tsx` | pannello dal fondo |
| serie del calendario | `components/mbx/EventSheet.tsx` | pannello dal fondo |
| ricerca | `components/GlobalSearchSheet.tsx` | pagina a tutto schermo |
| leggi il piano completo | `components/work/PlanSection.tsx` | pagina a tutto schermo |
| conferma di cancellazione | `components/work/DestructiveActions.tsx` | dialogo centrato |

**Decisione del maintainer: tutte e dieci**, conferma compresa.

## §2 — Come l'abbiamo già risolto in Half Story

Stesso problema, stessa versione di React Native (0.87.1), stessa New
Architecture. Il componente è `half-story-app/src/components/ui/SheetModal.tsx`,
e il suo docblock racconta il percorso — che vale la pena non rifare:

- un **gesto scritto a mano** (`PanResponder`) sa rubare il trascinamento a
  chi l'ha già preso, ma dove nessuno lo prende — la maniglia — non c'è niente
  da rubare e il pannello non si muove;
- **`@gorhom/bottom-sheet`** è scritto per Reanimated 3: con la 4, che è quella
  di RN 0.87, i pannelli non si aprono e non dicono perché;
- **il foglio di sistema** (`UISheetPresentationController`, via
  `@lodev09/react-native-true-sheet`) non ha nessuno dei due problemi, perché
  non è JavaScript: trascinamento, la lista che cede il gesto quando è in cima,
  velo, elastico — tutto dal sistema.

Verificato per Stubwise: `true-sheet` 3.x ha Reanimated come dipendenza
**facoltativa** (`peerDependenciesMeta`), quindi non va aggiunto niente oltre
alla libreria.

## §3 — Un componente, `SheetModal`, per tutte e dieci

Sul modello di quello di Half Story: aperto/chiuso da una prop, il pannello
segue quella; `onClose` arriva da qualunque strada (trascinamento, tocco sul
velo, indietro di Android). Le lezioni del suo docblock si portano con lui:

- **l'altezza si dice, non si indovina.** Il detent `auto` si misura da sé sul
  contenuto ma **non convive con una lista che scorre**: messi insieme il
  pannello si pianta a tutta altezza anche con tre righe. Chi scorre passa
  l'altezza, chi non scorre usa `auto`;
- **il safe area in fondo lo mette il sistema** (`insetAdjustment:
  'automatic'`): aggiungerne un secondo lascia un dito di vuoto sotto
  l'ultimo bottone;
- **`keyboardShouldPersistTaps="handled"`** sulla lista: con un campo di testo
  dentro, senza, il primo tocco su un bottone chiude solo la tastiera.

Le due **pagine** (ricerca, leggi il piano) usano lo stesso componente a
tutta altezza: un meccanismo solo per tutte le finestre, invece di due.

### ⚠️ La conferma di cancellazione

Trascinarla via è dire **no** — la cancellazione non parte. Quindi un gesto
distratto annulla, non esegue, e il foglio va bene anche qui. Ma **mentre la
cancellazione è in corso** il pannello non si deve chiudere (`dismissible:
false`), o l'esito arriverebbe su una finestra che non c'è più. È la stessa
regola di Half Story per la cancellazione dell'account.

## §4 — Cosa si toglie

**`SheetBackdrop`** (`components/SheetBackdrop.tsx`, 24 set 2026): esisteva
per sollevare i pannelli sopra la tastiera, e il foglio di sistema lo fa da
sé. Va tolto — con i suoi test — **solo dopo** aver visto sul telefono che la
tastiera non copre i campi nei pannelli nativi (§6). Se il foglio non la
gestisse, resta.

Così pure lo sfondo disegnato a mano e il `Pressable` «tocco fuori» di ogni
pannello: li fa il sistema.

## §5 — I test

In Jest il foglio nativo non esiste. Half Story lo sostituisce nei test con un
contenitore che rende i figli quando è aperto (`jest.mock` di `SheetModal`,
per file). Qui conviene **un mock globale** (nel setup di Jest) di
`@lodev09/react-native-true-sheet`, così i test esistenti dei dieci pannelli
continuano a funzionare senza toccarli uno per uno: quello che asseriscono è
il contenuto, non il contenitore.

I test che premono lo sfondo per chiudere (`accessibilityLabel` del velo) non
hanno più un velo da premere: vanno riscritti su `onClose`, non cancellati.

## §6 — ⚠️ La CI non vede niente di tutto questo

Una dipendenza **nativa** nuova: pod da installare, `Podfile.lock` da
committare, e la CI (`pnpm -r build/typecheck/lint/test`) non compila mai
Xcode. La prova vera è sul telefono, **prima del merge**, e la fa il
maintainer con il build che gli installo dal branch:

- un pannello si chiude trascinandolo in giù;
- il velo è quello di sistema;
- in un pannello con un campo di testo (nuova voce di backlog) la tastiera
  non copre il campo — è la condizione per togliere `SheetBackdrop`.
