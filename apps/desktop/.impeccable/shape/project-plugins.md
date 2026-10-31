# Shape brief — Progetto → Settings → Plugins

> Shape scritto dal controller senza intervista (31 ott 2026): le domande di
> discovery non sono state fatte al maintainer. Dove design e piano non
> bastavano la scelta è marcata **scelta del controller** e numerata
> **[PG n]** in fondo. La sola lettura, il segno «View only» e il «Who?»
> seguono `project-settings.md` ([PS 3]).

Superficie: la sezione **Plugins** (`/p/<CODE>/settings/plugins`): i plugin
del registro dell'istanza con le loro skill e i gruppi di hook, accesi **per
sottrazione**; il plugin base che non si spegne; i plugin non pronti; il
preset consigliato; il **conflitto** fra due finestre. Piano 9c: Task 10
(dati: Task 4). Spec area 9: «Impostazioni del progetto (9c) → Plugins»
(«il salvataggio controlla la versione e avvisa»). CLAUDE.md: «Plugin e
skill dell'agente» (sottrazione, preset chiavato sul `name` del manifest,
`stubwise-base` mai filtrato, `.mcp.json` mai caricato, limite «una persona
per volta»). Web di riferimento: `apps/web/src/components/
project-plugins-section.tsx`. La pagina d'istanza del plugin è in
`admin-integrations.md`. Mondo: «Catalogo numerato», modalità **Operate**.

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi guida il progetto** (Laura Costa in STW, `project.settings.
    manage`): spegne le skill che rifanno il lavoro della pipeline (applica
    il preset), spegne un hook che rallenta i run, riaccende una skill che
    serve. Lo fa di rado, e vuole sapere **da quando vale** e che **nessuno
    gli cancella le scelte in silenzio**.
  - **Chi lavora con Claude** (Marco Bellini, Developer; Sara in sola
    lettura): «perché `/superpowers:brainstorming` non c'è più in STW?».
    Legge e trova a chi chiedere.
- **Stato d'animo**: cura. È un elenco lungo (fino a 60 skill per plugin):
  deve leggersi a colpo d'occhio cosa è spento, e per quale ragione.

## 2. Esito e prova

- **Azioni primarie**: spegnere e riaccendere una skill o un gruppo di hook;
  spegnere o riaccendere tutto un plugin; applicare il preset consigliato;
  salvare; risolvere un conflitto senza perdere né la propria bozza né le
  scelte dell'altro.
- **Successo**, a 1440×900, da Laura in STW:
  - leggo in cima **stubwise** «Always on», con le sue skill, senza
    caselle;
  - sotto, **superpowers** «✓ Ready · 9 of 9 skills · 1 of 1 hooks in
    runs»; premo **Apply recommended preset**, quattro righe si spengono
    con il segno «Preset», la barra dice «4 changes»;
  - spengo `brainstorming`, salvo, leggo «Saved. From the next run:
    sessions already started keep their skills.»; in una conversazione con
    STW come contesto, «/» non elenca più `/superpowers:brainstorming`;
  - **lint-helpers** si legge in fondo, «✕ Failed: it doesn't enter runs»,
    senza caselle.
- **Conflitto**: Laura e Roberta aprono la sezione; Roberta salva per
  prima; Laura salva e legge «Someone changed these plugins while you were
  editing. Nothing of yours has been saved.» con le due strade (sotto). Le
  scelte di Roberta restano finché Laura non decide.
- **Verità del prodotto**:
  - **per sottrazione**: di base tutto è acceso; si salva ciò che è spento;
  - **il plugin base non si spegne** e porta le skill di Stubwise in «/»;
  - **un plugin `failed` o `materializing` non entra nei run**, qualunque
    cosa dica la sezione;
  - **il preset è chiavato sul nome del manifest** (`superpowers`) e tocca
    solo le quattro skill;
  - **vale dalla prossima sessione**: una sessione già nata tiene le sue
    skill;
  - **i server MCP propri di un plugin non si caricano mai**.

## 3. Direzione scelta

- **Tesi**: **una lista di caselle raggruppata per plugin, dove lo spento si
  legge prima dell'acceso**: ogni plugin ha in testa il suo conteggio «9 of
  9 skills in runs», ogni riga spenta è attenuata con la parola «Off» e,
  se viene dal preset, «Preset». Il conflitto non è un errore: è una
  **riconciliazione** in un riquadro sopra la barra, con due strade
  esplicite **[PG 1]**.

### La pagina

- h1 «Plugins» / «Plugin» · prosa «The Claude Code plugins Claude can use
  when it works on STW. Everything is on unless you turn it off here.» / «I
  plugin di Claude Code che Claude può usare quando lavora su STW. Tutto è
  acceso, a meno che non lo spegni qui.»
- 12px `ink-faint` sotto la prosa: «Plugins are registered for the whole
  instance in Administration → Plugins.» / «I plugin si registrano per
  tutta l'istanza in Amministrazione → Plugin.» (link solo per chi vede la
  voce) e, una volta, «A plugin's own MCP servers (.mcp.json) are never
  loaded.» / «I server MCP propri di un plugin (.mcp.json) non vengono mai
  caricati.»

### Il plugin base

- Primo blocco, sempre. Testata (48px): **stubwise** 600 · «Stubwise's base
  plugin» / «Il plugin base di Stubwise» 13px `ink-muted` · a destra «Always
  on» / «Sempre acceso» (12px 600, nessun interruttore).
- Frase 13px: «It carries the rules of every run and Stubwise's own
  commands. It can't be turned off.» / «Porta le regole di ogni esecuzione e
  i comandi di Stubwise. Non si può spegnere.» **[PG 2]**
- Le sue skill come righe di sola lettura (nome in codice `/stubwise:start`
  · descrizione), **senza caselle**: nessuna casella spenta che faccia
  pensare a un permesso mancante.

### Un plugin del registro (`ready`)

- **Testata** (52px, filetto sotto): casella del plugin (tre stati: tutto,
  niente, in parte; etichetta accessibile «Use superpowers in STW's runs» /
  «Usa superpowers nelle esecuzioni di STW») · **nome** 600 (dal manifest) ·
  slug 12px se diverso · «✓ Ready» / «✓ Pronto» · a destra il **conteggio**
  «9 of 9 skills · 1 of 1 hooks in runs» / «9 di 9 skill · 1 di 1 hook
  nelle esecuzioni» (cifre tabellari) e, se il plugin ha un preset,
  **Apply recommended preset** / **Applica il preset consigliato**
  (secondario).
  - Con tutto spento il conteggio diventa «Not in runs: everything is off» /
  «Non entra nelle esecuzioni: è tutto spento».
- **SKILLS** (`heading-group` + numero): righe 44px, casella · **nome** ·
  descrizione 13px `ink-muted` (una riga, ellissi, intera nel `title`) · a
  destra, se spenta, «Off» / «Spenta» e, se è una delle skill del preset,
  «Preset» / «Preset» 12px `ink-faint` con `title` «Recommended off: the
  pipeline already does this.» / «Consigliata spenta: la pipeline lo fa
  già.» Una riga spenta ha nome e descrizione in `ink-muted` (il segnale
  vero è la parola, non il colore).
- **HOOKS** (`heading-group` + numero): righe 44px, casella · chiave
  «SessionStart#0» (cifre tabellari) · evento in parola · comando in un
  blocco codice d'una riga (ellissi, intero nel `title`). Etichetta
  accessibile «Use the hook group SessionStart#0» / «Usa il gruppo di hook
  SessionStart#0».
- **Apply recommended preset** **[PG 3]**: cambia **solo la bozza**: spegne
  le quattro skill (`using-git-worktrees`, `finishing-a-development-branch`,
  `dispatching-parallel-agents`, `subagent-driven-development`) e non
  tocca nient'altro, nemmeno skill già spente o accese a mano. Prima, un
  `title` sul bottone: «Turns off the 4 skills that redo the pipeline's work:
  worktrees, finishing a branch, parallel agents, subagents.» / «Spegne le 4
  skill che rifanno il lavoro della pipeline: worktree, chiusura del ramo,
  agenti in parallelo, subagenti.» Dopo, annuncio `aria-live`: «4 skills
  turned off. Save to apply.» / «4 skill spente. Salva per applicare.» Con
  le quattro già spente il bottone è spento con 12px «Preset applied» /
  «Preset applicato» (regola, nessun «Who?»).

### Plugin non pronti

- In fondo, dopo i `ready`, sotto `heading-group` **NOT IN RUNS** / **FUORI
  DALLE ESECUZIONI**. Testata come sopra ma **senza casella e senza
  conteggio**, in `ink-muted`, con lo stato in glifo e parola e la ragione:
  - `failed`: «✕ Failed: it doesn't enter runs until someone fixes it in
    Administration → Plugins.» / «✕ Non riuscito: non entra nelle
    esecuzioni finché qualcuno non lo sistema in Amministrazione → Plugin.»
    (`critical` sul glifo e sulla parola);
  - `materializing`: «◌ Being prepared: it enters runs when it's ready.» /
    «◌ In preparazione: entra nelle esecuzioni quando è pronto.»
  - Riga 12px: «Choices saved for it are kept and apply when it's ready.» /
    «Le scelte salvate per lui restano, e valgono quando è pronto.» **[PG 4]**
  - Nessun elenco di skill (l'inventario può mancare o essere vecchio).

### Salvare

- **Barra di salvataggio** agganciata in fondo (come Roles): «5 changes ·
  **Discard** · **Save**» / «5 modifiche · **Scarta** · **Salva**». Ogni
  casella cambiata nella bozza ha un punto ink 6px a sinistra (con testo
  per lettore di schermo «changed» / «cambiata») finché non si salva.
- **Save** → nessuna riconferma → «Saved. From the next session: sessions
  already started keep their skills.» / «Salvato. Dalla prossima sessione:
  quelle già partite tengono le loro skill.» (12px accanto alla barra per 4
  s, poi la barra esce).
- Lasciare la sezione con modifiche: «Discard 5 changes?» / «Scartare 5
  modifiche?»

### Il conflitto **[PG 5]**

Quando `saveProjectPlugins` torna `conflict` (qualcuno ha salvato dopo la
mia lettura):

- **Niente si perde**: la bozza resta sullo schermo; il livello dati non ha
  scritto niente.
- La pagina rilegge la versione nuova **sotto** la bozza e mostra, al posto
  della barra, un riquadro agganciato in fondo con filetto `rule-strong` e
  ▲ `warning`:
  - «Someone changed these plugins while you were editing. Nothing of yours
    has been saved.» / «Qualcuno ha cambiato questi plugin mentre li
    modificavi. Niente di tuo è stato salvato.»
  - se l'altro ha toccato anche righe che ho cambiato io: «You both changed:
    brainstorming, SessionStart#0.» / «Avete cambiato entrambi:
    brainstorming, SessionStart#0.» (fino a 5, poi «and 3 more» / «e altre
    3»), e quelle righe portano «Both changed» / «Cambiata da entrambi» al
    posto del punto;
  - due strade:
    - **Keep my changes on theirs** / **Tieni le mie modifiche sulle loro**
      (primario): la base diventa la versione nuova, e sopra si rimettono
      **solo le righe che ho cambiato io**; il riquadro torna la barra
      normale («3 changes · Discard · Save») e serve ancora **Save**;
    - **Use theirs** / **Usa le loro** (secondario): la bozza si scarta, si
      legge la versione nuova, nessuna barra.
  - Nessuna delle due salva da sola: la scelta resta esplicita.
- Un secondo `conflict` di fila ripete lo stesso riquadro.

```
1440 ── Plugins (Laura in STW) ─────────────────────────────────────────────────
│ Plugins                                                                      │
│ The Claude Code plugins Claude can use when it works on STW. Everything is   │
│ on unless you turn it off here.                                              │
│ stubwise  Stubwise's base plugin                              Always on      │
│   It carries the rules of every run and Stubwise's own commands. …          │
│   /stubwise:start   Start a plan on Stubwise                                 │
│ ──────────────────────────────────────────────────────────────────────────── │
│ [◐] superpowers  ✓ Ready     5 of 9 skills · 1 of 1 hooks in runs           │
│                                          [Apply recommended preset]          │
│ SKILLS 9                                                                     │
│ [✓] brainstorming          Explore the idea and the design before…           │
│ [ ] using-git-worktrees    Works in a separate git worktree.   Off · Preset  │
│ HOOKS 1                                                                      │
│ [✓] SessionStart#0  Session start  ${CLAUDE_PLUGIN_ROOT}/hooks/session-st…   │
│ NOT IN RUNS ──────────────────────────────────────────────────────────────── │
│ lint-helpers  ✕ Failed: it doesn't enter runs until someone fixes it in …   │
│                                 ┌ 4 changes · Discard · [Save] ┐             │
```

## 4. Ambito e confini

- **Dentro**: plugin base in sola lettura, plugin `ready` con skill e gruppi
  di hook, casella del plugin a tre stati, preset consigliato, plugin non
  pronti con la ragione, salvataggio con controllo della versione e
  riconciliazione, sola lettura con «Who?».
- **Fuori**: registrare, aggiornare o rimuovere un plugin (Amministrazione,
  9b); scegliere i plugin per una singola task o sessione; l'avviso stantio
  del web su `--setting-sources` (riguardava deep dive e chat di analisi,
  dismessi il 19 ott 2026).
- **Anti-obiettivi**: una casella sul plugin base; un plugin `failed` con
  caselle che fanno credere che entri nei run; un preset che tocca più di
  quattro skill o le chiave sullo slug; un salvataggio che sovrascrive in
  silenzio le scelte di un altro; una bozza persa per un conflitto; la
  frase «Skills in this run» qui (è della sessione, `project-effects.md`).

## 5. Stati e intervalli

| Stato | Cosa si vede |
|---|---|
| Caricamento | il blocco del plugin base + 2 blocchi scheletro da 6 righe |
| Vuoto (nessun plugin nel registro) | il plugin base, poi «No other plugins on this instance. Claude works with the base plugin only.» / «Nessun altro plugin su questa istanza. Claude lavora solo col plugin base.» |
| Solo plugin non pronti | il plugin base e il gruppo NOT IN RUNS; nessuna barra |
| Errore | «Couldn't load STW's plugins.» / «Impossibile caricare i plugin di STW.» · **Retry** / **Riprova** |
| Pieno | come sopra |
| Sola lettura (Sara) | riga ○ della tabella di [PS 3] con **Who?** (`manageProjectSettings`); caselle visibili nello stato salvato e spente; **Apply recommended preset** spento con **Who?**; nessuna barra |

- **Rifiuti** (stato invariato):
  - `conflict`: il riquadro sopra;
  - `invalid: "base_plugin"` (non può succedere dalla pagina: nessuna
    casella): «Stubwise's base plugin can't be turned off.» / «Il plugin base
    di Stubwise non si può spegnere.»;
  - `forbidden`: «You can no longer change this.» / «Non puoi più
    cambiarlo.», la sezione passa in sola lettura e la bozza si perde (lo
    dice la frase);
  - `not_found`: come [PS 11];
  - errore del livello dati: «Couldn't save. Try again.» · **Retry** nella
    barra, bozza conservata.
- **Intervalli**: 0–20 plugin, 0–60 skill e 0–10 gruppi di hook per plugin;
  descrizioni fino a 300 caratteri (ellissi). Oltre 12 skill un plugin si
  apre con le skill chiuse dietro «Show 60 skills» / «Mostra 60 skill»,
  tranne le spente, che restano sempre visibili **[PG 6]**.

## 6. Interazione e layout

- Contenuto fino a 880px.
- Tastiera: Spazio sulla casella; la casella del plugin cambia tutte le sue
  righe; il conteggio si aggiorna e si annuncia («5 of 9 skills in runs»).
- Dopo «Apply recommended preset» il fuoco resta sul bottone (ora spento,
  quindi va alla testata del plugin).
- Dopo una scelta nel riquadro del conflitto il fuoco va alla barra (o
  all'h1 con «Use theirs»).
- **1440×900**: righe d'una linea (nome · descrizione · segni a destra);
  hook con chiave, evento e comando in fila.
- **1024×680** (720px utili):
  - la testata del plugin va su due righe: casella · nome · stato sopra;
    conteggio e **Apply recommended preset** sotto, a destra;
  - le skill tengono la descrizione sulla stessa riga ma più corta
    (ellissi); i segni «Off · Preset» restano interi;
  - negli hook il comando scende sotto chiave ed evento, a tutta larghezza;
  - il riquadro del conflitto a tutta larghezza, i due bottoni sotto la
    frase.

## 7. Vincoli

- Solo via `data/queries/projectSettings.ts` (`useProjectPlugins`,
  `useSaveProjectPlugins`); la bozza è locale; **Save** manda la `version`
  letta. `canEdit`, `inRuns`, `base`, `preset` vengono dalla vista.
- La riconciliazione («Keep my changes on theirs») rifà la differenza della
  bozza rispetto alla versione di partenza, **chiavata sui nomi stabili**
  (`plugin:skill`, `plugin#Evento#i`), mai sulle posizioni.
- Nessuna riconferma (non tocca segreti).
- Testi en/it con parità.
- **Voce del registro** (gruppo `project`, `project.settings.manage`):
  - `project.plugins_changed`: «**Laura Costa** changed the plugins of
    **STW**.» / «**Laura Costa** ha cambiato i plugin di **STW**.» —
    prima/dopo in righe, dalle chiavi stabili tradotte a lettura: «Off:
    superpowers · using-git-worktrees, superpowers · brainstorming» / «Spente:
    …» e «On again: superpowers · writing-plans» / «Riaccese: …», gli hook
    «superpowers · SessionStart#0»; una voce per salvataggio. Link
    `projectSettings` → `plugins`.

## Scelte del brief (scelte del controller, da confermare)

1. **[PG 1]** Lo spento si legge prima dell'acceso (conteggio in testa, parola
   «Off» sulla riga); il conflitto è una riconciliazione, non un errore.
2. **[PG 2]** Il plugin base è il primo blocco, senza caselle, con «Always on»
   e la frase del perché.
3. **[PG 3]** Il preset cambia solo la bozza e si salva come ogni altra
   modifica.
4. **[PG 4]** I plugin non pronti stanno in un gruppo a sé, senza caselle; le
   scelte salvate per loro restano.
5. **[PG 5]** Al conflitto la bozza resta: «Keep my changes on theirs» rifà
   sopra la versione nuova solo ciò che ho cambiato (e segnala le righe
   cambiate da entrambi), «Use theirs» scarta; nessuna delle due salva da
   sola.
6. **[PG 6]** Oltre 12 skill l'elenco si chiude, ma le spente restano
   sempre visibili.

## Scelte confermate dal maintainer (31 ott 2026)

1. **[PG 5]** Al conflitto la bozza resta, con le due strade «Keep my
   changes on theirs» e «Use theirs»; nessuna delle due salva da sola.

## Ruling del controller (31 ott 2026)

1. Il plugin base `stubwise` vale **per tutti i progetti** e non è fra le
   scelte del seme: la skill `start` spenta oggi in AUD (`PROJECT_PLUGINS`)
   si toglie (piano, Task 1).
