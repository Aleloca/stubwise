# Piano — Pannelli nativi (24 set 2026)

Design: `docs/plans/2026-09-24-native-sheets-design.md`.
Riferimento: `/Users/aleloca/git/half-story/half-story-app/src/components/ui/SheetModal.tsx`
(leggilo per intero: il docblock è la metà del lavoro).

## Task 1 — La dipendenza

`@lodev09/react-native-true-sheet` alla stessa versione di Half Story
(`^3.11.12`) in `apps/mobile`, `pod install`, `Podfile.lock` committato.
Reanimated NON si aggiunge (è facoltativo). Build iOS locale che compila.

## Task 2 — `SheetModal`

`apps/mobile/src/components/SheetModal.tsx`, sul modello di Half Story
adattato ai token di questa app (colori e raggi da `theme/tokens`): `open`,
`onClose`, `scrollable`, `contentHeight`, `maxFraction`, `dismissible`,
`testID`. Le tre lezioni del design §3 nel docblock.

## Task 3 — I dieci pannelli

Uno alla volta, ognuno su `SheetModal`: via il `Modal`, lo sfondo disegnato
e il `Pressable` di chiusura. Le due pagine a tutta altezza. La conferma di
cancellazione con `dismissible={false}` **mentre la cancellazione è in
corso** (design §3).

## Task 4 — I test

Mock globale di `@lodev09/react-native-true-sheet` nel setup di Jest (design
§5). I test che premevano il velo si riscrivono su `onClose`. Un test per
`SheetModal` e uno per la conferma che, a cancellazione in corso, il pannello
non sia chiudibile — fatto fallire togliendo la regola.

## Task 5 — Verifica e consegna

Typecheck dopo l'ultimo test, lint, test dell'app. **`SheetBackdrop` NON si
toglie in questa PR**: lo decide la prova sul telefono (design §4/§6), in un
commit successivo sullo stesso branch se la tastiera è a posto.

Nella PR scrivi i passi della prova sul telefono. Il merge aspetta quella
prova, non solo la CI.
