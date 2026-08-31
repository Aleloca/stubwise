---
stubwise:
  project: stubwise
  backlogItem: 5971494f-41fa-493d-a559-09816be2be2f
  # https://stubwise.thecove.it/backlog/5971494f-41fa-493d-a559-09816be2be2f
---

# Pulizia del setup graphify locale — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Correggere i quattro difetti del setup graphify locale introdotto da `e0c0a67`: merge driver dichiarato con un nome inesistente, sezione duplicata in `CLAUDE.md`, ambiguità fra il grafo locale e i grafi per-repository di produzione, invariante del pin ferma a 3 punti su 4.

**Architecture:** Lotto di sole modifiche a documentazione e configurazione git: `.gitattributes` (una riga) e `CLAUDE.md` (tre edit indipendenti). Nessun codice applicativo, nessuna migrazione, nessun impatto su build, CI o deploy. Le decisioni e le evidenze che le giustificano — incluse le **due conclusioni invertite** della review post-merge — sono in `docs/plans/2026-08-31-graphify-setup-cleanup-design.md` (**LEGGILO PRIMA**: senza quel contesto i Task 1 e 2 sembrano fare il contrario di quanto chiedeva la review, ed è voluto).

**Tech Stack:** git attributes + merge driver `graphify` (`graphifyy` CLI, Python); Markdown.

**Convenzioni trasversali (valgono per ogni task):**
- **Si lavora direttamente su `main`**, senza branch né worktree: è la convenzione del repo per le modifiche piccole e questo lotto è doc-only. Verifica con `git rev-parse --abbrev-ref HEAD` → `main`.
- **Prefissa OGNI commit con `GRAPHIFY_SKIP_HOOK=1`.** L'hook `post-commit` rigenera `graphify-out/` a ogni commit che tocca file non-grafo e lascerebbe il working tree sporco fra un task e l'altro, confondendo le verifiche. Esempio: `GRAPHIFY_SKIP_HOOK=1 git commit -m "..."`.
- Non serve `pnpm lint` / `typecheck` / `test`: nessun file processato da eslint o tsc viene toccato (verificato nel design doc). Il Task 5 fa comunque un check finale.
- Commenti e messaggi di commit in italiano, stile dello storico (`fix(scope):`, `docs:`).
- Non toccare `apps/worker/src/graph`, `Dockerfile.graphify`, `apps/server/src/graph-chat`: la pipeline di produzione è fuori scope.

---

## Task 1: `.gitattributes` — una sola riga, con il nome canonico del driver

**Files:**
- Modify: `.gitattributes` (l'intero file: 1 riga committata + 1 riga non committata → 1 riga)

**Contesto:** su `main` c'è `merge=graphify-union`, un nome che non esiste nel package graphify; il driver registrato da `graphify hook install` si chiama `merge.graphify`. Nel working tree c'è già una seconda riga corretta, non committata. Vedi E1 nel design doc.

**Step 1: fotografa lo stato di partenza**

```bash
cat .gitattributes
git check-attr merge -- graphify-out/graph.json
git config --get-regexp 'merge\.graphify'
```

Atteso: due righe nel file (`merge=graphify-union` e `merge=graphify`); `merge: graphify` da `check-attr` (vince l'ultima riga); in config **solo** `merge.graphify.name` e `merge.graphify.driver`, nessun `graphify-union`. Se `check-attr` stampa `graphify-union` o `unspecified`, fermati e rileggi il design doc: lo stato di partenza è diverso da quello atteso.

**Step 2: riscrivi il file con la sola riga canonica**

```bash
printf 'graphify-out/graph.json merge=graphify\n' > .gitattributes
```

**Step 3: verifica**

```bash
cat .gitattributes
git check-attr merge -- graphify-out/graph.json
grep -c 'graphify-union' .gitattributes || true
```

Atteso: una sola riga `graphify-out/graph.json merge=graphify`; `graphify-out/graph.json: merge: graphify`; `grep -c` stampa `0`.

**Step 4: commit**

```bash
git add .gitattributes
GRAPHIFY_SKIP_HOOK=1 git commit -m "fix(graphify): il merge driver di graph.json si chiama graphify, non graphify-union"
```

---

## Task 2: `CLAUDE.md` — elimina il blocco orfano (quello con i marcatori)

**Files:**
- Modify: `CLAUDE.md:136-147` (il blocco `<!-- graphify:start -->` … `<!-- graphify:end -->` e la riga vuota che lo segue)

**Contesto — LEGGI PRIMA DI AGIRE:** si elimina il blocco **italiano con i marcatori**, non quello inglese. Il blocco `## graphify` inglese è l'asset generato da `graphify claude install` (`graphify/always_on/claude-md.md`) e gestito via `_CLAUDE_MD_MARKER = "## graphify"`; i marcatori `graphify:start/end` non compaiono da nessuna parte nel sorgente del tool. La review post-merge sosteneva il contrario. Vedi E2 nel design doc.

**Step 1: conferma quale blocco è quale**

```bash
grep -n 'graphify:start\|graphify:end\|^## graphify' CLAUDE.md
```

Atteso: `136:<!-- graphify:start -->`, `146:<!-- graphify:end -->`, `148:## graphify`.

**Step 2: elimina il blocco fra i marcatori**

```bash
sed -i '' '/<!-- graphify:start -->/,/<!-- graphify:end -->/d' CLAUDE.md
```

**Step 3: normalizza le righe vuote lasciate dalla cancellazione**

```bash
sed -n '130,140p' CLAUDE.md | cat -A | grep -n '^\$$'
```

Se fra la fine della sezione MCP e `## graphify` restano **due** righe vuote consecutive, rimuovine una:

```bash
python3 - <<'PY'
from pathlib import Path
p = Path("CLAUDE.md")
t = p.read_text(encoding="utf-8")
t = t.replace("\n\n\n## graphify", "\n\n## graphify")
p.write_text(t, encoding="utf-8")
PY
```

**Step 4: verifica**

```bash
grep -c 'graphify:start\|graphify:end' CLAUDE.md || true
grep -c '^## graphify$' CLAUDE.md
grep -n '^## ' CLAUDE.md | tail -3
```

Atteso: `0` marcatori; **esattamente 1** riga `## graphify`; l'elenco delle H2 finisce con `## Integrazione Claude Code (MCP)` e `## graphify`, senza più `## Knowledge graph (graphify)`.

**Step 5: commit**

```bash
git add CLAUDE.md
GRAPHIFY_SKIP_HOOK=1 git commit -m "docs: rimuove la sezione graphify duplicata non gestita dal tool"
```

---

## Task 3: `CLAUDE.md` — distingui il grafo locale dai grafi per-repository

**Files:**
- Modify: `CLAUDE.md` — in coda alla sezione `## Integrazione Claude Code (MCP)`, subito **prima** di `## graphify`

**Contesto:** nello stesso file convivono `graphify-out/` (grafo locale committato, per la navigazione da Claude Code) e `/graphs/<repositoryId>/graphify-out/` (grafi prodotti dal worker per le chat). La nota va in una sezione che il generatore non tocca, altrimenti sparisce al prossimo `graphify claude install`. Vedi D2/D3/D4 nel design doc.

**Step 1: inserisci il blocco**

```bash
python3 - <<'PY'
from pathlib import Path

BLOCK = """### Grafo locale del repo (`graphify-out/`)

Oltre ai grafi **per-repository** che il worker produce in
`/graphs/<repositoryId>/graphify-out/` per le chat (vedi "Architettura runtime"),
questo repo ha un grafo **proprio** in `graphify-out/`, committato, che serve
alla navigazione del codice da Claude Code. Sono due cose distinte: quando in
questo file leggi `graphify-out/` senza prefisso, è quello locale.

- È servito dal server MCP `graphify` di `.mcp.json` (`uvx`, stdio) e rigenerato
  dall'hook `post-commit` installato da `graphify hook install` (l'hook esce
  subito nei worktree collegati: lì il grafo non si aggiorna).
- La sezione `## graphify` in fondo a questo file è **generata** da `graphify
  claude install` (asset `graphify/always_on/claude-md.md`): non editarla a mano,
  viene rimpiazzata a ogni install.
- `graphify-out/graph.json` è un artefatto generato committato (~400 KB nel pack
  per versione, su un repo da ~3 MiB). In caso di **conflitto** non mergiarlo a
  mano: il merge driver `merge=graphify` di `.gitattributes` è configurazione
  locale in `git config` e **non gira sui merge lato GitHub**. Risolvi
  rigenerando: `graphify update . && git add graphify-out/`.

"""

p = Path("CLAUDE.md")
t = p.read_text(encoding="utf-8")
anchor = "## graphify\n"
assert t.count(anchor) == 1, "atteso esattamente un '## graphify' (Task 2 fatto?)"
t = t.replace(anchor, BLOCK + anchor, 1)
p.write_text(t, encoding="utf-8")
PY
```

**Step 2: verifica**

```bash
grep -n '^### Grafo locale del repo' CLAUDE.md
grep -n '^## ' CLAUDE.md | tail -2
sed -n "$(grep -n '^### Grafo locale del repo' CLAUDE.md | cut -d: -f1),+24p" CLAUDE.md
```

Atteso: il `###` compare una volta, **dentro** la sezione `## Integrazione Claude Code (MCP)` (cioè dopo l'ultima H2 che la precede e prima di `## graphify`); il testo stampato è quello inserito, con i backtick intatti.

**Step 3: commit**

```bash
git add CLAUDE.md
GRAPHIFY_SKIP_HOOK=1 git commit -m "docs: distingue il grafo locale del repo dai grafi per-repository del worker"
```

---

## Task 4: `CLAUDE.md` — invariante del pin da 3 a 4 punti

**Files:**
- Modify: `CLAUDE.md:80-82` (dentro `## Deploy (prod)`, voce "Modifica al **grafo**")

**Contesto:** la PR ha aggiunto un quarto pin funzionale in `.mcp.json:18` senza aggiornare la checklist. `.claude/skills/graphify/.graphify_version` **non** è un pin da allineare a mano. Vedi E4/D5 nel design doc.

**Step 1: fotografa i punti del pin oggi presenti**

```bash
grep -rn '0\.9\.28' apps/worker/Dockerfile Dockerfile.graphify apps/worker/src/graph/setup-pr.ts .mcp.json
```

Atteso: 4 file, ognuno con il pin `0.9.28` (in `setup-pr.ts` come `GRAPHIFY_VERSION`).

**Step 2: aggiorna il testo dell'invariante**

```bash
python3 - <<'PY'
from pathlib import Path

OLD = """  `graphifyy==0.9.28` va tenuto ALLINEATO in 3 punti quando si aggiorna:
  `apps/worker/Dockerfile`, `Dockerfile.graphify` e `GRAPHIFY_VERSION` in
  `apps/worker/src/graph/setup-pr.ts`.
"""

NEW = """  `graphifyy==0.9.28` va tenuto ALLINEATO in 4 punti quando si aggiorna:
  `apps/worker/Dockerfile`, `Dockerfile.graphify`, `GRAPHIFY_VERSION` in
  `apps/worker/src/graph/setup-pr.ts` e il pin `uvx` del server MCP `graphify`
  in `.mcp.json`. NON è un quinto punto
  `.claude/skills/graphify/.graphify_version`: è il marcatore di versione della
  skill, riscritto da `graphify claude install`.
"""

p = Path("CLAUDE.md")
t = p.read_text(encoding="utf-8")
assert t.count(OLD) == 1, "blocco dell'invariante non trovato testualmente"
p.write_text(t.replace(OLD, NEW, 1), encoding="utf-8")
PY
```

**Step 3: verifica**

```bash
grep -n 'ALLINEATO in' CLAUDE.md
sed -n "$(grep -n 'ALLINEATO in' CLAUDE.md | cut -d: -f1),+6p" CLAUDE.md
```

Atteso: "in 4 punti", con `.mcp.json` elencato e la nota su `.graphify_version`.

**Step 4: commit**

```bash
git add CLAUDE.md
GRAPHIFY_SKIP_HOOK=1 git commit -m "docs: l'invariante del pin graphifyy copre 4 punti, incluso .mcp.json"
```

---

## Task 5: verifica finale del lotto

**Files:** nessuno (sola verifica)

**Step 1: rileggi il risultato**

```bash
cat .gitattributes
git check-attr merge -- graphify-out/graph.json
grep -c '^## graphify$' CLAUDE.md
grep -c 'graphify:start' CLAUDE.md || true
grep -n 'ALLINEATO in' CLAUDE.md
```

Atteso, nell'ordine: una riga `merge=graphify`; `merge: graphify`; `1`; `0`; "in 4 punti".

**Step 2: verifica che il lotto sia davvero doc-only**

```bash
git diff --stat a6873e6..HEAD
```

Atteso: **solo** `.gitattributes`, `CLAUDE.md` e i due doc in `docs/plans/`. Se compare qualsiasi altro file (in particolare sotto `apps/` o `packages/`), fermati: è fuori scope.

**Step 3: allinea il grafo e chiudi**

```bash
git status --short
```

Se `graphify-out/` risulta modificato (un commit è passato senza `GRAPHIFY_SKIP_HOOK=1`), committalo a parte:

```bash
git add graphify-out/ && git commit -m "chore(graphify): rigenera il grafo"
```

**Step 4: aggiorna lo stato su Stubwise**

Porta il ticket collegato (riferimento nel frontmatter di questo piano) a `in_review` con `set_ticket_status`.
