---
title: App M1+M2 — fix di review prima del merge
date: 2026-09-11
design: 2026-09-11-mobile-app-program-design.md
plan: 2026-09-11-app-m1-m2-plan.md
stubwise:
  project: stubwise
  backlog: 9699cd60-8f36-4461-abbc-6b2da5bcdcc7
---

# App M1+M2 — fix di review prima del merge

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.
>
> Worktree esistente `.worktrees/app-m1-m2` (branch `feature/app-m1-m2`,
> PR #21, HEAD `fd4c74b`). Il piano è su `main`: `git fetch && git show
> origin/main:docs/plans/2026-09-11-app-m1-m2-review-fixes-plan.md`, oppure
> `git merge origin/main`. **Non** mergiare. Alla fine: push, CI verde, report.
>
> ⚠️ `pnpm -r build` dalla radice prima dei test del mobile, e cache Metro
> svuotata dopo ogni modifica ai packages.

**Il lavoro è buono.** Lo scorrimento è completo e le due eccezioni delle chat
sono giuste e motivate nel codice; la migrazione alla barra nativa rispetta alla
lettera tutte e tre le istruzioni (icona **e** sigla, nessuna compensazione del
tint su iOS 26, `AppTheme` verificato prima di cambiarlo); il test di parità dei
token è la rete che serviva; nessun test è stato cancellato. E hai trovato e
chiuso da solo un tuo gap del Task 6 (il margine in fondo), dicendolo.

**Ma tre cose non vanno mergiate così**, e le prime due riguardano esattamente
ciò per cui il maintainer ha chiesto questo lavoro.

---

### Task 1: il font deve coprire l'app, non otto titoli

**PRIMA DEL MERGE. È la ragione per cui questo lavoro esiste.**

Numeri verificati sul branch: `fontFamily` come proprietà di stile fuori da
`theme/` compare **84 volte, di cui 82 mono e ZERO sans**. L'unico
`fontFamily.sansBold` dell'app è dentro `theme/typography.ts:74`
(`textStyles.screenTitle`), consumato in **8 punti** — otto titoli di schermata.
`textStyles.screenSubtitle` usa **mono**, quindi i sottotitoli non contano. Circa
**96 blocchi di stile hanno `fontSize` senza `fontFamily`**, e React Native non
eredita `fontFamily` da una `View`: nessuna propagazione implicita salva il
resto.

**Il caso peggiore è `theme/markdown.ts:18`**: `body` non ha `fontFamily`.
Quindi **tutto il testo lungo dell'app** — brief settimanale, pagine Docs,
documenti del backlog, risposte della chat — è ancora nel font di sistema.

Il maintainer aprirebbe l'app, vedrebbe otto titoli diversi e tutto il resto
identico, e concluderebbe che non è servito a niente. È esattamente lo scenario
che il Task 7 doveva evitare.

**Files:**
- Modify: `apps/mobile/src/theme/typography.ts` — un preset per il **corpo**
  accanto a quelli che ci sono già. La struttura è giusta, manca il pezzo
- Modify: `apps/mobile/src/theme/markdown.ts` — il `body` e i suoi discendenti
  prendono il Sans. **Questo da solo copre la maggior parte del testo lungo**
- Modify: le schermate e i componenti — i testi normali usano i preset. **Il
  mono resta dov'è di proposito** (sigle, metadati, badge, wordmark): non
  convertirlo, è identità, non una dimenticanza
- ⚠️ Procedi **a schermata**, non con una sostituzione automatica: un tentativo
  cieco ha già prodotto un errore reale nel Task 2 (uno stile che eredita
  `fontFamily` per composizione di array l'avrebbe persa)
- Alla fine, riporta il numero: quanti blocchi con `fontSize` restano **senza**
  `fontFamily`, e perché ciascuno è giustificato

**Commit** `feat(app): il Sans copre il testo dell'app, non solo i titoli`.

### Task 2: le Impostazioni si raggiungono da ovunque

**PRIMA DEL MERGE. Due difetti distinti, uno è una regressione.**

**(a) L'avatar manca del tutto su quattro schermate.** `ScreenHeader` — che lo
contiene — è usato dai 4 tab root più Dettaglio progetto, Pagina Docs e Card
d'inbox. **Non** da `WorkScreen`, `BacklogItemScreen`,
`BacklogChatScreen`, `AskProjectScreen`. Su `main` l'avatar viveva nel `topBar`
globale sopra `{children}` ed era quindi presente **ovunque**: questa è una
regressione, non un compromesso. E fra le quattro c'è **Lavoro**, la schermata
dove si approva un piano.

**(b) Dove c'è, scorre via senza lasciare niente.** Il piano diceva: «l'avatar è
l'UNICO accesso alle Impostazioni: qualunque forma tu gli dia, deve restare
raggiungibile senza scorrere fino in cima. Se la tua soluzione non lo
garantisce, dillo». L'hai detto — ed è il comportamento giusto — ma il vincolo
resta non rispettato. Il design parlava di un header «che scorre col contenuto
**e si contrae**, come i titoli grandi di iOS»: la contrazione era il punto,
perché nei titoli grandi di iOS la barra compatta **resta ancorata** e l'avatar
non sparisce, si sposta.

**Il requisito, non il meccanismo**: da **qualunque** schermata post-login e da
**qualunque** posizione di scorrimento, le Impostazioni si raggiungono con un
gesto solo. Il come lo scegli tu — un header che si contrae e resta ancorato è
la strada standard, ma se ne trovi una più semplice che soddisfa il requisito,
va bene e spiegala.

⚠️ Le due chat restano eccezioni per l'header (giustamente), ma **non** per
l'accesso alle Impostazioni: lì l'header è già fisso, quindi ospitarlo è facile.

- Test: per ogni schermata post-login, le Impostazioni sono raggiungibili.
  Questo test è la rete che impedisce alla regressione di tornare

**Commit** `fix(app): le Impostazioni si raggiungono da ogni schermata`.

### Task 3: il margine in fondo ha un test che lo discrimina

**PRIMA DEL MERGE.** `git grep` su `paddingBottom|tabBarHeight|useBottomTabBarHeight`
in tutti i `*.test.tsx` → **zero risultati**. Il mock di
`useBottomTabBarHeight()` restituisce `0`, quindi `paddingBottom: BASE + 0` è
indistinguibile dal comportamento precedente: se qualcuno togliesse
`+ tabBarHeight` da uno screen, **nessun test fallirebbe**. È l'unico
comportamento nuovo del Task 6 senza rete, e nessuno può vederlo in CI.

Poche righe: in un test, `mockReturnValue(80)` e l'asserzione che il
`paddingBottom` dello `ScrollView` lo includa. Fallo su almeno due schermate
diverse.

**Commit** `test(app): il margine sotto la barra è verificato, non solo scritto`.

### Task 4: quattro rifiniture

- **Dipendenza morta**: `@react-navigation/bottom-tabs` è ancora in
  `apps/mobile/package.json:22` ma non è più importato da nessun sorgente. Peso
  inutile, e peggio: un import del vecchio tab navigator continuerebbe a
  risolvere senza errori.
- **`signalBright` non è usato da nessuna parte**, e la motivazione («sul web è
  quasi sempre un `hover:`, che il touch non ha») regge solo a metà:
  l'equivalente touch dell'hover è lo **stato premuto**, e lì hai usato
  `signalDim` — l'ambra *spenta* per «premuto», mentre sul sito il feedback
  attivo è l'ambra *viva*. O inverti, o scrivi perché sul touch la scelta
  opposta è giusta.
- **`designRadii` afferma una parità che non esiste**: il docblock dice «stessi
  valori sul sito e sull'app», ma in `apps/web/src/styles.css` non c'è nessuna
  variabile di raggio e nessun test la copre. O togli la frase, o porta i raggi
  nel tema del sito.
- **La regex del test di parità gira su tutto il file**, non solo sul blocco
  `@theme`: un `--color-*` definito in futuro dentro un `@layer` o una media
  query verrebbe conteggiato e farebbe fallire il test per la ragione sbagliata.

**Commit** `chore(app): dipendenza morta, token premuto, parità dei raggi`.

### Task 5: la checklist dice anche cosa può rompersi su Android

Due cose che nessuno vedrà finché non si rilascia su Android, che oggi non
distribuiamo — quindi **non correggerle alla cieca**, ma metterle nella
checklist di `apps/mobile/README.md`:

- **Material 3 cambia l'aspetto dello `Switch` nativo** (dimensioni e icona nel
  thumb), usato in `SettingsSheet.tsx`.
- **Le icone dei tab su Android sono `.svg`** (`navigation.tsx:26-29`): Metro le
  tratta come asset, ma il decoder immagini di Android non rasterizza SVG —
  potrebbero non comparire.

**Commit** `docs(app): la checklist copre anche cosa può rompersi su Android`.

### Task 6: verifica finale

1. `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test` → verde.
2. `git merge origin/main`; push; CI verde.
3. Report: HEAD, link al run, i cinque task, **la checklist di verifica manuale
   aggiornata**, e il numero del Task 1 (quanti testi restano senza `fontFamily`
   e perché).

---

## Fuori da questo piano

M3 (divario funzionale), M4 (ciò che l'app fa meglio), M5 (rischi operativi —
⚠️ ha l'unico vincolo esterno: se queste fasi si allungano, **M5 scavalca, non
slitta**). Il flaky preesistente di `me-google.test.ts`.
