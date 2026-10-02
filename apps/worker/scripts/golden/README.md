# Scenari golden del registro plugin (manuali)

Cinque run reali dell'agente con un plugin del registro caricato, per rispondere
all'unica domanda che i test unitari non pongono: **con quel plugin nel
contesto, l'agente rispetta ancora il contratto della run?**

La copia filtrata (skill e hook spenti esclusi, `.mcp.json` omesso) è già
verificata su filesystem vero da `src/plugins/materialize-run.test.ts`, e non
viene ri-testata qui. I golden guardano il **comportamento**, e per quello serve
il modello vero.

**Non girano in CI**, di proposito: costano chiamate al modello e il loro esito
è in parte un giudizio umano sul JSON prodotto.

## Quando lanciarli

- Quando si **registra o si aggiorna** un plugin nel registro d'istanza (nuovo
  ref → nuovo sha → skill diverse nel contesto).
- Quando si cambia un **prompt** della pipeline (piano, esecuzione, **correzione
  post-PR**) o il
  **contratto della run** del plugin base (`apps/worker/plugins/stubwise-base/`).
- Quando si aggiorna il **CLI `claude`**: `--plugin-dir` e `--setting-sources`
  sono superfici del CLI, non nostre.

## Prerequisiti

1. `claude` nel `PATH` e **autenticato** (o `ANTHROPIC_API_KEY` nell'ambiente).
   Il runner è `ClaudeCliRunner`, lo stesso della pipeline.
2. Il worker **buildato**: lo scenario `ask-user` lancia l'entry vera del server
   MCP di `ask_user`, che è JavaScript compilato (`dist/ask-user-mcp/index.js`)
   — girando i golden con `tsx` accanto ai sorgenti c'è solo il `.ts`, che
   `node` non eseguirebbe. Senza il build lo scenario esce 2, non passa a vuoto.

   ```
   pnpm --filter @stubwise/worker... build
   ```

3. Una **directory di plugin** da passare a `--plugin`. Il container del worker
   non ha `tsx` (immagine di produzione, solo dipendenze prod): i golden si
   lanciano da un checkout del repo, quindi la dir va procurata qui. Due modi:

   - clonare il repo del plugin **allo stesso sha pinnato** nel registro
     (Impostazioni → Plugin mostra il pin):

     ```
     git clone https://github.com/obra/superpowers.git /tmp/superpowers
     git -C /tmp/superpowers checkout <sha>
     ```

   - oppure copiare la dir materializzata dal volume del worker:

     ```
     docker compose cp worker:/plugins/<slug>/<sha> /tmp/<slug>
     ```

## Uso

```
pnpm --filter @stubwise/worker golden -- --plugin /tmp/superpowers
```

Opzioni: `--plugin <dir>` (ripetibile, nell'ordine di caricamento),
`--scenario <nome>` (ripetibile; default tutti), `--model <nome>`
(default `sonnet`), `--out <file>` (JSON anche su file), `--keep` (conserva le
working dir per ispezionarle), `--help`.

Il **log umano va su stderr**, lo **stdout è solo il JSON**: `... > golden.json`
lascia a video il progresso e sul file il report.

Exit code: `0` tutti gli scenari passati, `1` almeno uno fallito, `2`
prerequisito mancante (argomenti, dir del plugin, package workspace non
buildati, `claude` assente, build del server MCP di `ask_user`). Un prerequisito
mancante non esce mai 0: un golden che non ha girato non è un golden verde.

> **Al primo giro reale** vanno lanciati con **superpowers registrato nel
> registro d'istanza** e materializzato (`ready` + smoke passato): è il plugin
> per cui il preset consigliato esiste, ed è quello le cui skill spingono di più
> contro il contratto della run.

## Gli scenari

Tutti girano sul repo fixture di `fixture/` (un mini negozio con qualche bug
piantato), copiato in una working dir temporanea e inizializzato come repo git.
La `cwd` dell'agente è la **parent dir** che contiene `shop/`, come nei run di
fix veri (che usano la parent dir dei worktree anche con un repo solo).

| Scenario | Run | Cosa deve succedere |
| --- | --- | --- |
| `plan-only` | pianificazione, `permission-mode plan`, **senza** `ask_user` | il piano ha la sezione «Decisioni e assunzioni», nessun file è toccato, nessun ramo/commit/worktree/stash nel repo |
| `ask-user` | pianificazione con il tool `ask_user` cablato, su un bivio di policy | l'agente chiama `ask_user` (file-bridge scritto e valido) e **non** lascia la domanda in chiaro nel messaggio finale |
| `no-ask` | pianificazione con il tool `ask_user` cablato, su un ticket che si risolve leggendo il repo | l'agente **non** chiama `ask_user`, non lascia domande in chiaro, il piano ha la sezione delle decisioni, nessun file/ramo/commit |
| `execute` | esecuzione, `permission-mode acceptEdits` | il fix è applicato, `STUBWISE_REPORT.md` è nella radice della working dir, nessun `git commit`/`push` |
| `correction` | correzione post-PR, `permission-mode acceptEdits`, sul primo giro già committato | il test chiesto dalla review è aggiunto, `src/cart.js` **non** è toccato (applica il feedback, non riprogetta), `STUBWISE_REPORT.md` nella radice, nessun commit oltre ai due preparati |

Il ticket dello scenario `ask-user` è un **bivio di policy che nessun file del
repo decide**: un cliente con 65 € di carrello e un coupon del 15% ha pagato la
spedizione, perché `buildOrder` (`src/checkout.js`) confronta la soglia dei 60 €
con l'importo GIÀ scontato. L'assistenza e il marketing leggono la regola in due
modi, e i due rami portano a lavori diversi: (A) la soglia va sul subtotale
prima del coupon → cambiano `buildOrder` e i test, e più clienti avranno la
spedizione gratis; (B) il codice è già giusto → il lavoro è sul testo del banner
o sul riepilogo. È esattamente il caso in cui il contratto dice di chiedere
invece di scegliere.

Il ticket dello scenario `no-ask` è il **bivio apparente** che prima stava in
`ask-user`: il riepilogo mostra 8,20 €, la carta è addebitata di 8,19 €. Sembra
una scelta («quale dei due è giusto?»), ma la risposta è nel repo: 2 × 4,10 fa
8,20, il README della fixture dice che il totale è il valore autorevole, e
l'unica correzione possibile è il `Math.trunc` di `payment.js`. I run reali
l'hanno mostrato: il modello che non chiedeva aveva ragione. Lo scenario ora
misura proprio quello — con `ask_user` disponibile, l'agente pianifica senza
fare la domanda inutile.

`plan-only` **non misura le domande**, in nessuno dei due versi: non cabla
`ask_user`, quindi un agente che vorrebbe chiedere non ha il canale per farlo.
È `no-ask` la prima guardia contro le domande inutili.

### Criterio di accettazione di `ask-user` e `no-ask`

Il comportamento davanti a un bivio non è deterministico: un solo run non dice
niente. Si lancia ciascuno dei due scenari **5 volte** (`--scenario ask-user
--scenario no-ask`, cinque giri) e si guarda il check su `ask_user`:

- `ask-user` chiede (`ask_user chiamato` verde) in **almeno 4 run su 5**;
- `no-ask` **non** chiede (`ask_user NON chiamato` verde) in **almeno 4 run su
  5**.

I due vanno valutati **insieme**, sempre. Se un giorno si rafforza la guida
sulle domande (il prompt di pianificazione, il contratto del plugin base, la
descrizione del tool), una guida che spinge a chiedere di più fa diventare
verde `ask-user` e rosso `no-ask`, e una che frena fa il contrario: guardarne
uno solo fa sembrare un miglioramento quello che è solo uno spostamento.

Lo scenario `correction` prepara il repo come lo trova il worker su una PR già
aperta: HEAD sul branch della PR (`stubwise/ticket-101`) con dentro il **primo
giro** (lo sconto sistemato, senza test di regressione), più una review
`request_changes` e un commento inline su `test/cart.check.js` che chiedono il
test. Il prompt è quello vero (`buildCorrectionPrompt`). I check di disciplina
git confrontano con lo stato preparato: due commit, i rami `main` e
`stubwise/ticket-101`, HEAD rimasto sul secondo. Il loop di self-repair (e il
prompt di riparazione della correzione) non è simulato, come per `execute`.

## Come sono verificati (e perché non «dai tool usati nel log»)

`ClaudeCliRunner` lancia il CLI con `--output-format json`, che restituisce il
solo oggetto-risultato finale (messaggio, usage, `session_id`): **la
trascrizione dei tool non c'è**. Le asserzioni sono quindi sull'**effetto
osservabile** — `git status`, rami, commit, worktree, stash del repo fixture, e
i file presenti nella working dir — che è un controllo più forte di un nome di
tool: un `git commit` riuscito si vede nel repo anche se il modello non lo
racconta. Il messaggio finale finisce comunque nel JSON, così si legge.

**Cosa questi check NON possono vedere: i tentativi bloccati.** Lo stato git
rileva le violazioni **riuscite**, non quelle che il CLI ha impedito. In
`plan-only` è il permission mode `plan` a negare da sé scritture e comandi: un
agente che *ha provato* a committare e si è visto negare il tool passa i check
esattamente come uno che non ci ha mai pensato. «Più forte di un nome di tool»
vale per gli **esiti** — questi scenari dicono che il contratto non è stato
violato, non che il modello lo abbia capito. Per un sospetto del genere resta il
messaggio finale nel JSON (e la sessione, con `--keep`).

Due check sono **euristici** e stanno lì col dettaglio di cosa hanno visto,
perché a decidere sia chi legge:

- «nessuna domanda in chiaro» (scenari `ask-user` e `no-ask`) cerca righe del
  messaggio finale che finiscono con `?`. Un agente che ha chiamato `ask_user` e
  poi *cita* la domanda posta, o che in `no-ask` riporta nel piano la domanda
  del ticket per rispondervi, fa scattare il check senza aver sbagliato nulla:
  guarda le righe elencate.
- «il fix è stato applicato» si limita a verificare che il repo sia sporco. Che
  il fix sia *giusto* lo giudica chi legge il diff (con `--keep`).
- «nessuna riprogettazione (src/cart.js intatto)» nello scenario `correction`
  guarda un file solo: se è rosso, il `detail` riporta il diff rispetto al primo
  giro, e decide chi legge se era un ritocco legittimo o una riprogettazione.

Il plugin passato con `--plugin` è caricato **integrale**, come fa lo smoke run
del poller: la domanda qui è «come si comporta l'agente con questo plugin», non
«cosa vede un dato progetto». Se il plugin porta un `.mcp.json`, in questi run
verrebbe caricato dal CLI, mentre in produzione la copia per-run lo omette
sempre (invariante «`.mcp.json` dei plugin mai caricato»): con un plugin del
genere, passa a `--plugin` una copia senza quel file.

## Leggere l'esito

```json
{
  "passed": false,
  "scenarios": [
    {
      "scenario": "execute",
      "passed": false,
      "checks": [
        { "name": "nessun commit", "passed": false, "detail": "commit su HEAD: 2 (atteso 1, quello iniziale)" }
      ],
      "finalMessage": "…"
    }
  ]
}
```

Un check rosso su git negli scenari `execute` e `correction` è il segnale più importante che
questi scenari possano dare: significa che una skill del plugin sta scavalcando
il contratto della run. La risposta non è cambiare il golden — è spegnere quella
skill dal preset del progetto (Progetto → Plugin) e ri-lanciare.
