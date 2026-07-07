# Docs: project brief, classe `product` e meccanismo segreti

Data: 2026-07-07 · Stato: design validato · Estende: pipeline recursive (orient/explore/synthesize/finalize) e auto-update Fasi 1-3

## Contesto e obiettivo

L'analisi della pipeline e del corpus reale (Audin, 144 pagine) ha mostrato che
la doc generata ha ottima prosa ma manca di **scaffolding di accesso e
attraversamento**: nessun layer task-oriented (getting-started, how-to,
troubleshooting), nessun reference/glossario, terminologia che deriva tra
pagine, e — critico — le pagine `functional` contengono **fatti di business
riservati** (es. markup sui token) e sono oggi esposte ai widget pubblici.

Obiettivo (scope: TUTTO INSIEME, deciso): orientamento ristrutturato attorno a
un **project brief**; nuova classe **`product`** pubblica per-superficie con
percorsi di navigazione obbligatori; **meccanismo segreti** a rilevamento
automatico con verificatore fail-closed; widget che espongono di default solo
`product`.

## Decisioni chiave

| Tema | Decisione |
|---|---|
| Scope v1 | Tutto insieme (brief completo + product + segreti + widget), rollout in 4 fasi implementative |
| Segreti | **Solo rilevamento automatico** nel brief (euristiche esplicite), lista PERSISTITA e ispezionabile in SPA (sola lettura) |
| Verticali product | **Scoperte dal brief**: una per superficie pubblica; superfici interne (admin) escluse by default |
| Verificatore | **Riscrittura una volta + blocco fail-closed**: pagina ancora in violazione → esclusa, riportata in stats/log |
| Tassonomia | `technical` = interna dev; `functional` = interna operativa (può parlare di margini/schermate admin); `product` = pubblica, widget-ready |

## 1. Project brief (orientamento a due step)

Step A (nuovo): 1-2 run agente producono il **brief** col contratto a
marcatori: identità (cos'è il prodotto, chi paga per cosa); attori
`{nome, descrizione, interno/esterno}`; superfici
`{nome, tipo, path radice, audience, interna/pubblica}`; glossario (10-30
termini canonici); invarianti di business; **fatti riservati**
`{fatto, motivazione, fonte, come-non-deve-apparire}`; journey (5-10 per
attore); fonti esistenti (README/ADR/schema/contratti — non più scartati come
noise).

Step B: semina dei due alberi come oggi, ma con il brief nel contesto.

**Persistenza**: `doc_generations.brief` (jsonb). **SPA**: tab del brief nella
sezione Docs (sola lettura; include fatti riservati rilevati e pagine escluse
dal verificatore — ispezionabilità).

**Propagazione**: glossario+invarianti+attori nel prompt di ogni
explore/synthesize (centinaia di token); i segreti SOLO nella pipeline
product (le classi interne possono parlarne).

## 2. Classe `product`

- Nuovo valore `product` in `doc_page_kind` (ADD VALUE, MAI DML nello stesso
  batch — trappola nota). Stessa tabella/albero/embedding.
- Generata DOPO i due alberi interni. Per ogni superficie pubblica del brief,
  una **verticale**: radice "Guida <superficie>" con getting-started; una
  guida per journey pertinente (struttura imposta: *Obiettivo → Prerequisiti →
  Passi numerati con percorso di navigazione → Risultato atteso → Problemi
  comuni*); una pagina FAQ per verticale (derivata dai "limiti/cosa non fa"
  delle functional pertinenti).
- **Percorsi di navigazione obbligatori**: ogni passo ancorato a
  `Menu → Voce → Bottone` e URL relativo dove esiste; il parser valida
  l'ancoraggio (fail → una rigenerazione, poi scarto: meglio nessuna guida che
  una vaga).
- Fonti dell'agente: codice della superficie + pagine functional pertinenti +
  glossario/journey del brief. Registro: seconda persona, zero interni, nomi
  visibili all'utente obbligatori.
- Tetto per verticale (default 12 pagine) e budget nodi SEPARATO dagli alberi
  interni.

## 3. Meccanismo segreti

- **Rilevamento** (brief): euristiche esplicite nel prompt — margini/markup,
  pricing/costi interni, tassi, condizioni fornitori, competitor, tutto ciò
  che è visibile solo da superfici interne o codice di calcolo economico.
- **Iniezione** (product): sezione "NEVER disclose" in ogni run product, con
  istruzione di non negare/confermare se chiesto.
- **Verificatore** (post-generazione, per pagina product): agente separato,
  prompt da red-teamer, contratto `CLEAN` / `VIOLATION: <fatto, passaggio>`.
  Violazione → UNA rigenerazione mirata → seconda verifica → se boccia,
  pagina ESCLUSA (le altre si pubblicano), esclusione in stats e log.
- **Difesa passiva**: le pagine con fonte in superfici interne non sono mai
  input della pipeline product.

## 4. Consumo, auto-update, costo

- **Widget**: filtro kind guadagna `product`; widget NUOVI default
  `kinds: ["product"]`; esistenti non migrati, ma warning nell'editor quando
  espongono technical/functional ("documentazione interna"). Chat interna
  Docs invariata (vede tutto).
- **Auto-update**: Fase 2 copre anche le pagine product, col verificatore
  segreti prima di persistere (fail-closed). Fase 3 resta sugli alberi
  interni; le verticali si arricchiscono alla rigenerazione completa (niente
  grow product in v1).
- **Costo dichiarato**: +2 run (brief) + ~8-15 run product + 1 verifica per
  pagina product ≈ +30-40% sul costo di una generazione completa.

## Rollout (4 fasi implementative, un branch)

1. **Brief**: orient a due step, jsonb, propagazione glossario/invarianti,
   tab SPA.
2. **Product**: kind+migrazione, pipeline per-verticale con contratto
   navigazione, budget separato.
3. **Segreti**: iniezione + verificatore fail-closed + esclusioni in stats.
4. **Consumo**: widget (default+warning), refresh product in Fase 2, guida
   Starlight.

## Testing

Unit su contratti/parser (brief, guida con ancoraggi, verdetti verificatore);
integrazione worker con runner a copione (brief→alberi→product;
violazione→riscrittura→esclusione; guida senza ancoraggi→scartata; budget
separati); migrazione additiva; SPA (tab brief, warning widget); parità i18n.

## Deploy

Migrazione additiva (enum + colonna jsonb); ribuild `worker` (pipeline),
`server` (API brief/tab), `caddy` (SPA+guida). ⚠️ Riavvio worker solo senza
generazioni attive. Le nuove classi appaiono alla PRIMA rigenerazione completa
di ogni repo (comunicarlo: serve una rigenerazione per beneficiarne).

## Fuori scope

- Gestione manuale della lista segreti (v2 se il rilevamento non basta)
- Verticali modificabili dall'admin
- Grow incrementale (Fase 3) delle pagine product
- Migrazione automatica dei widget esistenti al kind product
