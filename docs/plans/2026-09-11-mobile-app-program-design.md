---
title: Programma App — Stubwise Go
date: 2026-09-11
stubwise:
  project: stubwise
---

# Programma App — Stubwise Go

## 1. Perché esiste

La fase 4b nasceva come «app mobile v2» quando l'app aveva due settimane di vita
e il sito metà delle funzionalità di oggi. Da allora sono arrivate le fasi 5, 6,
6b, 6c, 7, 7b, 8 e 9, e l'app le ha viste passare quasi tutte senza riceverle.

Il maintainer ha chiesto di estrarla dal programma «centro nevralgico» e farne
un programma a sé: «ci sono tante cose che mancano all'app rispetto a quello che
abbiamo sul sito e tante cose che esteticamente non mi convincono».

## 2. Dove siamo, verificato

**L'app** (`apps/mobile`, React Native 0.87.1 bare, niente Expo): 16 rotte su 4
tab (INB/PRJ/BLG/DOC) più il foglio Impostazioni, 41 file di test / ~455 casi,
i18n it+en con test di parità, token di tema propri, tolleranza a un server più
nuovo via `readerSchema` su ogni schema. **Non è un prototipo**: è costruita
bene. Il problema è che è ferma alla fase 4.

**Il sito**: ~30 rotte, oltre 120 azioni di scrittura in nove aree.

**Niente è condiviso, e questo è il problema strutturale.** Fra web e mobile non
esiste nessun componente in comune — né può esistere: uno è React DOM, l'altro
React Native. Ma nemmeno le **decisioni** sono condivise:

- `deriveNextStep` (fase 7 — qual è il prossimo passo di una voce di lavoro)
  vive solo nel web (`apps/web/src/components/work-next-step.tsx:66`).
- ~~`actionsFor` … l'app riscrive quelle regole per conto proprio~~ —
  **AFFERMAZIONE SBAGLIATA, corretta l'11 set 2026.** L'app **non** duplica il
  catalogo: ogni card dell'inbox chiama `can(item, "<azione>")`, cioè legge
  `item.actions`, l'elenco che **calcola il server**
  (`apps/mobile/src/components/inbox/FailedCard.tsx:29` e gemelle). L'avevo
  dedotto dall'assenza di un import invece di guardare come le card decidono.
  L'unica duplicazione vera era un insieme di due nomi di kind usato per
  raggruppare l'inbox, ora collegato al catalogo condiviso. **Regola che ne
  discende**: un'assenza di import non è una prova di duplicazione — la prova è
  leggere chi decide.
- `workStateFor` (`packages/shared/src/work-state.ts`) è invece **già condiviso**
  e usato da entrambi: è il precedente che dimostra che la strada funziona.

⚠️ Una cosa che sembrava un divario e non lo è: l'app non usa `@stubwise/i18n`,
ma **nemmeno il sito** — quel package serve ai template lato server (notifiche,
registro decisioni). Cataloghi separati per app è il modello corretto.

## 3. Le tre cose che il maintainer ha chiesto per prime

Dette da lui, verificate da me.

**(a) La barra in basso deve essere quella nativa di iOS 26, con Liquid Glass.**
Oggi è `@react-navigation/bottom-tabs`, che **disegna la barra in JavaScript**:
non è una `UITabBar` di sistema, quindi non potrà mai avere quell'aspetto per
quanto la si stili. Serve una barra nativa.

Prerequisito verificato: **Xcode 26.6, SDK iOS 26.5** — il Liquid Glass si
applica solo a un'app compilata con l'SDK di iOS 26, ed è il caso. Il target
minimo è iOS 15.1 e **resta**: sui telefoni più vecchi l'aspetto è quello
classico, che è il comportamento giusto. Da verificare in fase di ricerca: se la
libreria scelta imponga un minimo più alto.

**Quale libreria dia oggi la tab bar nativa con il supporto migliore su React
Native 0.87 va verificato sulla documentazione corrente, non deciso a memoria.**
È il primo passo del lavoro, non una scelta già presa.

**(b) Tutto il contenuto della pagina deve scorrere, non solo il corpo sotto un
header fisso.** La causa non è quella che sembra: **nell'app non esiste nessuna
`FlatList`** — zero occorrenze in tutto `src`, ogni schermata usa già
`ScrollView`. L'header resta fermo perché è **fratello** dello `ScrollView`, non
dentro: in `InboxScreen.tsx` il blocco del titolo sta alle righe 84-93 e lo
`ScrollView` comincia alla 108. Stesso schema altrove.

Spostarlo dentro il contenuto scorrevole è un lavoro da poche righe per
schermata, senza virtualizzazione da perdere: non si sta togliendo una lista
ottimizzata, si sta togliendo un annidamento sbagliato.

**Ma c'è un secondo pezzo fisso**, e nessuno lo nota finché non lo cerca: la
barra globale in alto (`apps/mobile/src/app/providers.tsx:276`), con il banner
offline e l'avatar che apre le Impostazioni. Sta **sopra tutte le schermate**,
quindi resterebbe ferma comunque — e se la si fa scorrere via si perde l'unico
accesso alle Impostazioni. È l'unica vera decisione di questo punto (§5).

**(c) Via la safe area quando arriva la barra nuova.** D'accordo sul risultato,
con una correzione: con una barra traslucida che galleggia il contenuto **deve**
passarci sotto — è ciò che dà l'effetto vetro, perché senza niente da rifrangere
il vetro sembra plastica. Ma va tenuto un **margine di scorrimento** in fondo
pari all'altezza della barra, altrimenti l'ultima riga di ogni lista resta
nascosta sotto il vetro senza modo di portarla in vista. Il contenuto passa
sotto; si può scorrere fino a vederlo tutto.

## 4. Due cause tecniche dell'«è brutta», trovate senza vedere una schermata

**L'app non ha IBM Plex Sans.** Ha i quattro file di IBM Plex **Mono** in
`assets/fonts/`, ma il Sans no: tutto il testo normale usa il font di sistema,
mentre il sito usa IBM Plex Sans ovunque. È un divario dichiarato in
`apps/mobile/src/theme/typography.ts:1-30` e mai chiuso.

**La palette dell'app è più piatta di quella del sito.**
`apps/mobile/src/theme/tokens.ts` ha gli stessi valori esatti del web per i
colori che ha, ma **ne mancano cinque**: `ink-850`, `ink-700`, `line-strong`,
`signal-bright`, `signal-dim`. Sono proprio quelli che creano la profondità —
superfici rialzate, bordi degli elementi interattivi, l'ambra viva contro quella
spenta. Senza, tutto è sullo stesso piano.

Queste due costano poco e valgono più di qualunque ridisegno di schermata.

## 5. La decisione aperta: dove va l'avatar

Se tutto scorre, la barra globale in alto non può restare ferma — ma è l'unico
accesso alle Impostazioni e al banner offline.

**Proposta**: l'avatar entra nella barra di navigazione della schermata, che
scorre col contenuto e si contrae (il comportamento dei titoli grandi di iOS);
il **banner offline** resta invece ancorato, perché è uno stato del sistema e
non un elemento della pagina — un avviso che scorre via è un avviso che non hai
letto.

Va confermata dal maintainer prima di implementare.

## 6. Il divario funzionale, in tre gruppi

**Manca all'app** (in ordine di quanto pesa):
- **Le domande a bottoni nella chat del backlog** (fase 7). Oggi la chat
  dell'app è solo testo — limite dichiarato nel codice. È la funzionalità nata
  per far lavorare chi non scrive prompt, e manca proprio dove scrivere è più
  scomodo.
- La **pre-approvazione del piano** (fase 7): l'app ha solo approva/rifiuta.
- La **Posta** (fasi 6/6b/6c/9) e il **Calendario** (7b/9): interamente assenti.
  Le proposte via notifica arrivano e si confermano, ma non c'è una sezione.
- La **roadmap con le milestone** e il **registro decisioni** (fase 5).
- Gli **ambienti** e la **coda di rilascio** (fase 8).

**Non va portato sull'app**, ed è una scelta, non un rinvio: impostazioni
d'istanza (automazione, provider AI, plugin, storage, Slack, account git),
repository, monitoraggio, editing dei Docs, widget. È configurazione da schermo
grande: su un telefono peggiorerebbe entrambe le superfici.

**L'app dovrebbe fare meglio del sito**: rispondere in due tap da una notifica
(già c'è, cinque categorie con azioni rapide); la **dettatura** nella cattura
rapida (dichiarata mancante in `CaptureSheet.tsx:37`); un **widget** con «cosa
aspetta te»; le **ore di silenzio**.

## 7. I rischi operativi

Non estetici, ma vanno nel programma perché diventano gravi proprio quando non
ci sarà più nessuno a rimediare:

- **La release Android si firma con la keystore di DEBUG** per default. Serve
  una keystore di upload vera, con le credenziali fuori dal repo.
- **Nessuna build nativa gira in CI**: ogni rilascio è manuale, dalla macchina
  di chi rilascia.
- **I bottoni delle notifiche Android funzionano solo in foreground**
  (`apps/mobile/index.js`, e `README:291`).
- **CocoaPods è deprecato.** ⚠️ Deprecato **non** vuol dire che smette di
  funzionare a una data: vuol dire che non è più sviluppato. Il rischio è che
  una versione futura di React Native o Firebase smetta di supportarlo, e quel
  giorno non ha una data. La ragione per migrare a Swift Package Manager prima
  di fine ottobre non è una scadenza: è che dopo saresti tu a farlo, da solo, su
  ciò che tocca la build nativa.

## 8. L'ordine

Il maintainer ha scelto «prima le fondamenta condivise». Le prime due fasi
riescono a essere entrambe le cose, perché font e token **sono** insieme
fondamenta ed estetica.

1. **M1 — Fondamenta e superficie**: token di design da un sorgente unico (con i
   cinque mancanti), IBM Plex Sans nell'app, `actionsFor` e `deriveNextStep`
   condivisi.
2. **M2 — Lo scorrimento e la barra nativa**: §3, le tre cose chieste.
3. **M3 — Il divario che conta**: domande a bottoni, pre-approvazione, poi posta
   e calendario.
4. **M4 — Ciò che l'app fa meglio**: dettatura, widget, ore di silenzio.
5. **M5 — I rischi operativi**: §7, con SPM da collocare **prima di fine
   ottobre**.

⚠️ M5 è l'unica con un vincolo esterno. Se le prime fasi si allungano, **M5
scavalca**, non slitta.

## 9. Cosa NON entra

- Un tema chiaro, o il cambio di linguaggio visivo: l'app segue il sito.
- Portare sull'app le aree del §6 dichiarate «non va portato».
- Riscrivere l'app: è costruita bene, ha 455 test e va estesa, non rifatta.
