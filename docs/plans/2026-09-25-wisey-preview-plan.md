# Wisey, anteprima nell'app — piano

Design: `2026-09-25-wisey-preview-design.md`. Branch `feature/wisey-preview`,
worktree `.worktrees/wisey`. Un commit per task, TDD dove c'è logica.

## Task 0 — Gli asset

- Gli sprite sono GIÀ nel branch, in `apps/mobile/assets/wisey/` (copiati
  dall'export di design, commit dei documenti): `gufo-{riposo,ascolta,pensa,
  lavora,parla,fatto}.png`, 224×48 RGBA = 4 fotogrammi da 56×48 (`parla` è la
  fase «ti risponde»). L'icona della tab è il PRIMO fotogramma di
  `gufo-riposo.png` (il gufo Classic della 5a), non `owl-minimal.png`:
  scartato dal maintainer dopo la prima prova sul telefono (25 set 2026),
  e tolto dagli asset. La variante
  «noedge» dell'export esiste solo per tre fasi e l'HTML non la usa: esclusa.
- Il riferimento visivo è `docs/design/wisey/Wisey.dc.html`: **leggi per
  intero la sezione 5a/5b** (colori, bolle, campo, riga di stato) e ricreala
  fedelmente coi token di `theme/tokens.ts`. Non renderizzarla in un browser.
- `apps/mobile/scripts/wisey-assets.py` (Pillow, `Image.NEAREST`): genera
  @2x/@3x per il gufo grande, il gufo piccolo e l'icona della tab. Committa
  anche i file generati. Per la tab (28×24 pt): @2x = il fotogramma 1:1;
  @3x = 84×72, fattore 1,5: NEAREST a 3× poi LANCZOS (la variante morbida,
  scelta sul telefono). Tela 28×27 pt: 3 pt trasparenti sotto il gufo
  (`TAB_BOTTOM_MARGIN_PT`) — vedi design §2.

## Task 1 — La tab, e la prova sul telefono SUBITO

- `navigation.tsx`: tab `Wisey` al centro, con una schermata segnaposto.
  Icona immagine `iconRenderingMode: "original"`: il primo fotogramma di
  riposo della 5a (`src/app/wisey-tab-icon.ts`).
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

## Task 6 — CLAUDE.md

In «Nell'app la ricerca è un'AZIONE…» c'è scritto che le cinque schede
INB/PRJ/BLG/DOC/MBX «sono decise per tutte le fasi»: dal 25 set 2026 non è
più vero (decisione del maintainer). Aggiorna quella frase: le schede sono
INB/PRJ/WISEY/BLG/MBX, DOC è uscita e la documentazione si raggiunge
dall'hub del progetto e dalla ricerca. E la frase «La ricerca dentro DOC
resta» va riscritta sulla Docs del progetto. Nient'altro nel file.

## Task 7 — Correzioni dopo la prova (design §10)

1. **Store condiviso** (`WiseyProvider`, context sopra il navigator):
   messaggi, stage, fuoco e testo del campo, `doneUnseen`, e i timer della
   risposta finta. I timer oggi stanno nella schermata: spostali nel provider,
   così una risposta prosegue e finisce anche fuori dalla tab. `wiseyPhase`
   riceve `doneUnseen`. Se `doneUnseen` è vero la fase è «done» finché la tab
   Wisey non va a fuoco; alla messa a fuoco fa un giro e torna a riposo. Test
   puri su `wiseyPhase` e test del provider coi fake timer: risposta finita a
   tab non a fuoco → resta done; messa a fuoco → done un giro, poi rest.
2. **La pagina**: il gufo grande è fisso, senza `LayoutAnimation`, sempre 2×.
   I messaggi di Wisey non hanno gufo, solo l'etichetta mono «WISEY». Aggiorna
   i test: via quello «un solo sprite animato» coi gufi dei messaggi, e UN
   solo sprite nella pagina.
3. **La barra**:
   - lo script genera 4 fotogrammi per fase per la tab, cioè 6 fasi × 4
     fotogrammi, variante morbida con margine;
   - l'icona della tab si legge dallo store e avanza sul ciclo della fase, con
     un passo minimo `WISEY_TAB_MIN_FRAME_MS`, oggi 120 (cioè nessun limite:
     si prova prima al vero ritmo);
   - riduzione del movimento → primo fotogramma.
   Test: l'icona passata alla barra nativa cambia coi fake timer e segue la
   fase; resta ferma con la riduzione del movimento.
4. Pusha e avvisami: prima di tutto va provato sul telefono se la barra
   regge i cambi d'icona.
5. **Tab senza nome** (richiesta del maintainer, arrivata dopo): la tab Wisey
   non mostra l'etichetta sotto il gufo. Le altre quattro la tengono.
   L'accessibilità resta, e VoiceOver dice «Wisey». Da verificare sul
   telefono, perché UITabBar potrebbe tenere comunque lo spazio del titolo:
   se il gufo resta alto con un vuoto sotto, sposta il margine trasparente
   della tela dal basso all'alto, così il gufo scende, con la costante dello
   script. Test: la barra nativa riceve un titolo vuoto per Wisey, e
   l'etichetta di accessibilità resta.
