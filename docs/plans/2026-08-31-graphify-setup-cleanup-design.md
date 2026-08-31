---
stubwise:
  project: stubwise
  backlogItem: 5971494f-41fa-493d-a559-09816be2be2f
  # https://stubwise.thecove.it/backlog/5971494f-41fa-493d-a559-09816be2be2f
  ticket: 3
  # https://stubwise.thecove.it/tickets/4b7bd99a-26c5-438b-9c36-d404236b0ac0
---

# Pulizia del setup graphify locale (post-merge PR "Configura il knowledge graph graphify")

## Contesto

Il commit `e0c0a67` ("Configura il knowledge graph graphify", mergiato con
`a6873e6`) ha aggiunto al repo il knowledge graph **locale** per la navigazione
da Claude Code: skill `.claude/skills/graphify/`, server MCP `graphify` in
`.mcp.json`, output `graphify-out/` committato, riga `.gitattributes` per il
merge driver e due sezioni in `CLAUDE.md`.

Una review post-merge ha segnalato 4 problemi. Verificandoli sul repo e **sul
sorgente Python di graphify installato** (`graphifyy 0.9.29` in
`~/.local/share/uv/tools/graphifyy`) è emerso che due conclusioni della review
erano **invertite** rispetto alla realtà, e che c'è un **bug non segnalato** che
è il difetto più concreto dell'intero lotto. Questo documento fissa cosa
sistemare e perché.

Obiettivo: rendere il setup graphify locale coerente e manutenibile, senza
toccare la pipeline graphify di produzione (worker + servizio `graphify` +
`graph-chat`), che è ortogonale e funzionante.

## Evidenze raccolte

### E1 — Il merge driver dichiarato non esiste (bug non segnalato dalla review)

`.gitattributes` su `main` contiene:

```
graphify-out/graph.json merge=graphify-union
```

Ma `graphify hook install` registra il driver con il nome **`graphify`**, non
`graphify-union`. Sorgente (`graphify/hooks.py`):

```python
def _merge_attr_line() -> str:
    ...
    return f"{out.rstrip('/')}/graph.json merge=graphify"

# e in _register_merge_driver():
("merge.graphify.name", "graphify graph.json union merge"),
("merge.graphify.driver", driver),
```

`git config --get-regexp 'merge\.graphify'` in locale conferma che le uniche
chiavi registrate sono `merge.graphify.name` / `merge.graphify.driver`.

Conseguenza: l'attributo committato punta a un driver **inesistente**, git
ricade sul merge testuale di default e la "strategia di merge dichiarata" non è
attiva **nemmeno in locale**. Il nome `graphify-union` non compare da nessuna
parte nel package: è stato inventato dalla PR.

C'è anche un effetto collaterale già visibile: il working tree ha una **seconda
riga** non committata,

```
graphify-out/graph.json merge=graphify
```

aggiunta da un successivo `graphify hook install`. Il suo controllo di
idempotenza è un test di appartenenza a lista, non di sottostringa
(`"merge=graphify" in fields[1:]` con `fields[1:] == ["merge=graphify-union"]`
→ `False`), quindi non ha riconosciuto la riga sbagliata e ne ha appesa una
corretta. Ora il file ha due righe per lo stesso path: git applica solo
l'ultima, quindi in locale funziona per caso.

### E2 — Le due sezioni di CLAUDE.md sono duplicate, ma la "gestita dal tool" è l'altra

`CLAUDE.md` ha due sezioni graphify, entrambe introdotte dallo stesso commit
`e0c0a67`:

- righe 137-146: `## Knowledge graph (graphify)`, italiana, racchiusa tra
  `<!-- graphify:start -->` / `<!-- graphify:end -->`;
- righe 148-156: `## graphify`, inglese, senza marcatori.

La review ha concluso che la prima è quella generata dal tool e la seconda un
orfano da eliminare. **È il contrario.** Nel package:

- `graphify/always_on/claude-md.md` contiene **testualmente** il blocco inglese
  `## graphify` → è l'asset che `graphify claude install` scrive;
- `install.py` definisce `_CLAUDE_MD_MARKER = "## graphify"` e
  `_remove_marker_section(content, marker, boundary_prefix="## ")` rimuove ogni
  sezione la cui riga di intestazione è **esattamente** `## graphify`, fino alla
  successiva H2 o a EOF;
- la stringa `graphify:start` / `graphify:end` **non compare da nessuna parte**
  nel sorgente: i marcatori HTML sono scritti a mano e il tool li ignora.

Quindi il blocco inglese è quello gestito (install lo rimpiazza, uninstall lo
rimuove); il blocco italiano con i marcatori è quello che **non verrà mai
rimosso né aggiornato** da graphify, cioè esattamente l'orfano che la review
voleva eliminare — solo, è l'altro.

Corollario operativo: modificare a mano il blocco `## graphify` è inutile,
`_replace_or_append_section` lo sovrascrive al prossimo `graphify claude
install`.

### E3 — Il costo del blob committato è ~15x più basso di quanto stimato

Misurato, non stimato:

| Metrica | Valore |
|---|---|
| `graphify-out/graph.json` in chiaro | 6.748.869 byte (~6,7 MB) |
| stesso blob **su disco nel pack** | **400.236 byte (~400 KB)** |
| `size-pack` dell'INTERO repo | 2,97 MiB |
| commit che hanno toccato `graph.json` | 1 |

Il JSON del grafo è estremamente ridondante e comprime ~17x. La cifra "7 MB per
versione" della review è il peso in chiaro, non quello che entra nella history.

Sui conflitti: il repo ha di fatto **un solo contributor**
(`git shortlog -sn`: 1023 + 5 commit della stessa persona, più il bot CI). E
l'hook `post-commit` installato **esce subito nei worktree collegati**
(`[ "$_GFY_GITDIR" != "$_GFY_COMMONDIR" ] && exit 0`) e quando cambia solo
`graphify-out/`, e nessun workflow in `.github/workflows/` rigenera il grafo.
Lo scenario "due branch che rigenerano il grafo in parallelo e collidono su
GitHub" oggi è raro.

Resta vero il punto tecnico di fondo: **GitHub non può eseguire un merge driver
custom** (è configurazione locale in `git config`), quindi su un merge lato
server un conflitto su `graph.json` va risolto rigenerando l'artefatto, non
mergiando il testo.

### E4 — Il pin è in 4 punti, non 3, e `.graphify_version` non è un pin

`CLAUDE.md:80-82` dichiara che `graphifyy==0.9.28` va tenuto allineato in **3
punti**. I punti funzionali reali sono **4**:

| File | Occorrenza |
|---|---|
| `apps/worker/Dockerfile` | `graphifyy[sql]==0.9.28` |
| `Dockerfile.graphify:25` | `graphifyy[mcp,sql]==0.9.28` |
| `apps/worker/src/graph/setup-pr.ts:67` | `GRAPHIFY_VERSION = "0.9.28"` |
| **`.mcp.json:18`** (nuovo con la PR) | `graphifyy[mcp]==0.9.28` |

La review ne contava 5, includendo
`.claude/skills/graphify/.graphify_version`. Quello **non è un pin**: è il
marcatore di versione della skill, riscritto da `graphify claude install`;
metterlo in checklist produrrebbe solo rumore, perché nessuno deve allinearlo a
mano.

Nota collaterale emersa: la CLI installata in locale è **0.9.29**, quindi il
`graphify-out/` committato è stato prodotto da 0.9.29 mentre `.mcp.json` lo
serve con 0.9.28. Su un bump di patch la compatibilità del formato è
verosimile, ma è un disallineamento da conoscere.

## Decisioni

**D1 — `.gitattributes`: una sola riga, con il nome canonico.** Il file deve
contenere esattamente `graphify-out/graph.json merge=graphify`, che è la riga
che `graphify hook install` genera e riconosce. Si elimina sia il nome inventato
sia il doppione. Questo è il fix con il rapporto valore/costo più alto del lotto:
oggi il driver non è attivo per nessuno.

**D2 — CLAUDE.md: si elimina il blocco italiano con i marcatori, si tiene quello
del tool.** Ragione: combattere il generatore è una battaglia persa
(`graphify claude install` riscriverebbe comunque `## graphify`, ricreando il
duplicato al primo `/graphify`). Il blocco inglese resta come asset gestito, e
`CLAUDE.md` guadagna la nota che **non va editato a mano**.

**D3 — La disambiguazione tra i due `graphify-out/` si sposta nella sezione
"Integrazione Claude Code (MCP)".** È il problema reale sollevato dal punto 3
della review: nello stesso file convivono il grafo **locale** in
`graphify-out/` (committato, per la navigazione in dev) e i grafi
**per-repository** in `/graphs/<repositoryId>/graphify-out/` prodotti dal worker
per le chat. La sezione MCP è il posto naturale (descrive già `.mcp.json` e le
skill) e non è toccata dal generatore, quindi la nota sopravvive.

**D4 — `graphify-out/` resta committato, con il workflow dei conflitti
documentato.** Il beneficio (qualunque clone o sessione agente ha il grafo senza
build) supera un costo misurato di ~400 KB per versione su un repo da 3 MiB. Si
documenta però che su conflitto l'artefatto si **rigenera** (`graphify update .`
+ `git add graphify-out/`), non si merge a mano, perché il driver non gira lato
GitHub. Il segnale per rivedere la decisione è l'arrivo di un secondo
contributor regolare: a quel punto la scelta giusta diventa `.gitignore` +
rigenerazione locale.

**D5 — L'invariante del pin passa da 3 a 4 punti, con `.mcp.json` incluso e una
nota esplicita che `.graphify_version` non ne fa parte.** Senza la nota, il
prossimo che legge la checklist e trova un quinto file con "0.9.28" dentro si
chiede se ha sbagliato.

## Fuori scope

- Bump di `graphifyy` a 0.9.29 su tutti e 4 i punti: comporta rebuild di
  `worker` e `graphify` e un deploy, mentre qui non si tocca prod. Il
  disallineamento CLI locale/pin resta documentato in E4 come nota.
- Qualunque modifica a `apps/worker/src/graph`, `Dockerfile.graphify`,
  `apps/server/src/graph-chat`: la pipeline di produzione non è in discussione.
- Rigenerazione di `graphify-out/`: l'hook `post-commit` la fa da sé.

## Rischi e verifica

Il lotto è interamente **documentazione + un file di configurazione git**:
nessun codice applicativo, nessuna migrazione, nessun impatto su build o
deploy. `eslint` non processa `.gitattributes` né `CLAUDE.md`, quindi non ci
sono rischi CI.

Il solo punto verificabile in modo non banale è D1, e si verifica con
`git check-attr merge -- graphify-out/graph.json`, che deve stampare
`merge: graphify` (e non `graphify-union` né `unspecified`).
