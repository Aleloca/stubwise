# Wisey, anteprima nell'app — piano

Design: `2026-09-25-wisey-preview-design.md`. Branch `feature/wisey-preview`,
worktree `.worktrees/wisey`. Un commit per task, TDD dove c'è logica.

## Task 0 — Gli asset

- Gli sprite sono GIÀ nel branch, in `apps/mobile/assets/wisey/` (copiati
  dall'export di design, commit dei documenti): `gufo-{riposo,ascolta,pensa,
  lavora,parla,fatto}.png`, 224×48 RGBA = 4 fotogrammi da 56×48 (`parla` è la
  fase «ti risponde»), e `owl-minimal.png`, 28×24, per la tab. La variante
  «noedge» dell'export esiste solo per tre fasi e l'HTML non la usa: esclusa.
- Il riferimento visivo è `docs/design/wisey/Wisey.dc.html`: **leggi per
  intero la sezione 5a/5b** (colori, bolle, campo, riga di stato) e ricreala
  fedelmente coi token di `theme/tokens.ts`. Non renderizzarla in un browser.
- `apps/mobile/scripts/wisey-assets.py` (Pillow, `Image.NEAREST`): genera
  @2x/@3x per il gufo grande, il gufo piccolo e l'icona della tab. Committa
  anche i file generati.

## Task 1 — La tab, e la prova sul telefono SUBITO

- `navigation.tsx`: tab `Wisey` al centro, con una schermata segnaposto.
  Icona immagine `iconRenderingMode: "original"`.
- Test di cablaggio dell'ordine delle tab, se il navigator lo consente;
  altrimenti una costante esportata con l'ordine, testata.
- **Fermati qui, pusha e avvisami**: il maintainer deve vedere il gufo nella
  barra sul telefono prima di tutto il resto (design §2, rischio). NON
  proseguire finché non ti rispondo.

## Task 2 — Via il tab DOC

Design §3, nell'ordine: `Ask` nello stack progetti e bottone in
`ProjectDocsScreen`; `GlobalSearchSheet` verso `Projects → Page`; ricerca di
ogni navigate/link verso `"Docs"` (`grep -rn '"Docs"' apps/mobile/src`,
linking compreso); rimozione di tab, stack, `DocsScreen` e sue chiavi i18n.
Test: il bottone apre `Ask` coi parametri giusti; il risultato di ricerca
naviga a Projects; nessun riferimento residuo alla tab (typecheck).

## Task 3 — Fasi e risposte (logica pura)

- `lib/wisey-phase.ts`: `wiseyPhase(state)` (tabella del §5) e le durate.
- `lib/wisey-mock.ts`: `mockReply(question)` → `{ kind, textKey }`, parole
  chiave it/en. Test per ogni gruppo, per la generica e per «azione vs
  risposta». Testi in i18n `mobile.wisey.*`, it e en.

## Task 4 — Lo sprite animato

`components/WiseySprite.tsx`: `phase`, `size` ("large" | "small"),
`animated`. Timer a 4 passi, ritaglio, fermo al primo fotogramma se
`animated=false`, se riduzione movimento, o se la tab non è a fuoco.
Test: fotogramma che avanza coi fake timer; fermo nei tre casi.

## Task 5 — La schermata

`screens/wisey/WiseyScreen.tsx`, design §4: intestazione con «Preview»,
gufo grande che si rimpicciolisce alla prima domanda, messaggi,
suggerimenti, campo con `TabScreenKeyboardAvoider`, risposta a scatti.
Test coi fake timer: suggerimento → domanda inviata → pensa → (lavora) →
risponde → fatto → riposo; invio disabilitato a campo vuoto e durante una
risposta; UN solo sprite animato nella schermata.

## Verifica finale

`pnpm lint`, typecheck e test dell'app. Build Release su device dopo il Task 1
e alla fine (è il maintainer che prova: tu pusha e avvisa).
