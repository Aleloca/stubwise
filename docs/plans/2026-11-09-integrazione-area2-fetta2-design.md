# Integrazione area 2, fetta 2 — Planning e La mia settimana — design

Data: 9 nov 2026. Segue `docs/plans/2026-11-09-integrazione-area2-task-design.md`
(fetta 1: architettura, tre build, `@backend/*`, «in arrivo», login), che resta
valido in tutto. La specifica funzionale ed estetica è il prototipo:
`docs/plans/2026-10-23-desktop-area2-task-design.md` §2 («La mia settimana») e
§5 (Planning), `apps/desktop/.impeccable/shape/{planning,home}.md`, e il codice
in `apps/desktop/src/renderer/{pages/planning,pages/week,pages/home/blocks/MyWeekBlock*,pages/tasks/TaskTimeline.tsx,domain/{planning,load,weeks}.ts}`.

Il maintainer ha chiesto (9 nov 2026) di procedere in autonomia: le scelte
d'integrazione sono *(orchestratrice)*; quelle del maintainer *(maintainer)*.

## Cosa entra

- **Settimana pianificata** su ogni task (campo «Week» del dettaglio, azione in
  blocco, Nuova task, filtro di periodo «settimana»), riaccesi dalla fetta 1.
- **Slittamento**: una task aperta con la settimana passata è nella settimana
  corrente col segno «slittata» e quante volte.
- **La mia settimana** a tutta pagina (`/home?view=week`): le mie task della
  settimana sistemate nei giorni (lun–ven + «in settimana»), slittate, barra del
  mio carico, «Pianifica la prossima settimana».
- **Planning di progetto** (sezione Planning) e **Planning trasversale**
  (`/planning`, per reparto), col carico in taglie per persona e settimana,
  trascinamento e menu da tastiera, righe altrui in sola lettura senza il
  permesso.
- **Vista Timeline** di Tasks (barre settimana→scadenza, traguardi in sola
  lettura).
- Permesso **`planning.others`** nel registro vero.
- Avvisi: **`planning.changed`** a chi aveva la task spostata o tolta da altri,
  **`task.assigned`** a chi la riceve (se il server non ha già un avviso di
  assegnazione equivalente: in quel caso si riusa).

## Non entra

- La Home a blocchi e il blocco «My week» della Home (fetta 3): `/home` senza
  `view=week` resta «in arrivo».
- Claude come riga del Planning (area 3): nella build app la riga non c'è.
- Assenze e ferie (decisione aperta del prototipo, invariata).

## Decisioni

- **`planning.others`** *(maintainer, 9 nov)*: Project Lead e full admin sì;
  **Developer e Legacy Member no** (vanno esclusi esplicitamente, perché i loro
  preset sono «tutto tranne»); Contributor e Viewer no.
- **Forma della settimana** *(orchestratrice)*: nel DB `tickets.planned_week
  date` = il lunedì (CHECK `isodow = 1`); sul filo e nel renderer la stringa
  ISO `2026-W46`, come nel prototipo. Conversioni pure in `@stubwise/shared`.
- **Settimana corrente** *(orchestratrice)*: calcolata nel fuso
  `Europe/Rome`, lo stesso del giro notturno, in una sola funzione SQL e una
  sola funzione TS. Configurabile in futuro; oggi una costante dichiarata.
- **Slittamento derivato a lettura** *(orchestratrice)*, non un job: la riga
  tiene `planned_week` (la scelta umana) e `slip_count` (gli slittamenti già
  consolidati). Per una task non chiusa con `planned_week` < lunedì corrente:
  settimana effettiva = lunedì corrente, `slipCount = slip_count + settimane
  trascorse`. A ogni scrittura umana di `planned_week` su una task slittata il
  derivato si consolida in `slip_count`. `slipCount` non si azzera mai, come
  nel prototipo. Motivi: la regola «si deriva a lettura» del repo, nessun
  aggiornamento di massa (che toccherebbe `updated_at` e quindi le ferme per
  inattività), nessun recupero se il worker è giù. Equivale al prototipo, che
  slitta di una settimana per giro.
- **Regole in UN posto** *(orchestratrice)*: `domain/{load,planning}.ts` e le
  parti senza «oggi» di `domain/weeks.ts` passano in `@stubwise/shared`
  (`SIZE_WEIGHT` 1/2/3/5/8, `load`, `progress`, `usualWeekWeight`, `isToPlan`,
  `planBlock`/`canMove`, `slipOf`, `planRecipientsOf`, le funzioni ISO); il
  prototipo le richiama come adattatori, il server le usa per decidere.
- **Chi può pianificare cosa** lo decide il server per task (`planBlock`) e lo
  dice nella vista (`TaskView.canPlan`), mai dedotto dal client. Vale per la
  rotta di pianificazione, per `plannedWeek` nel PATCH e nel bulk (per task,
  tutto o niente). Il cambio di assegnatario dal dettaglio resta quello della
  fetta 1 (`tickets.edit`), come nel prototipo: se il prototipo applica
  `planBlock` anche lì, si segue il prototipo.
- **Carico** *(orchestratrice)*: lo calcola il renderer con i moduli puri
  condivisi, sopra le task che `listTasks` restituisce (aperte, con i filtri
  della vista): «in tutti i progetti» = i progetti che chi guarda vede, come nel
  prototipo, quindi nessuna task di un progetto invisibile entra nel conto. Se
  la lista è troncata (oltre 2000), la vista lo dice («Some tasks are missing
  from the load»).
- **Sistemazione per giorno**: tabella personale `task_day_arrangements`
  (task, persona, settimana, giorno 1–5 o null); si legge e si scrive solo per
  le proprie task assegnate; un trigger la cancella quando cambiano davvero
  settimana o assegnatario, da qualunque scrittura. In lettura vale solo se la
  settimana è ancora quella della task.
- **Avvisi**: come `planRecipientsOf` del prototipo (mai all'attore; il
  follower che non vede la task non riceve niente). Nell'evento solo dati veri
  al momento (la settimana di prima e di dopo); testo composto a lettura.
  `ADD VALUE` in una migrazione a sé.
- **Dove si arriva** *(orchestratrice)*, finché la Home a blocchi non c'è:
  dopo il login si atterra su La mia settimana; la colonna della Home mostra
  «My week» e, a chi ha `planning.others` in almeno un progetto, «Planning»;
  le altre voci della colonna restano «in arrivo».

## Verifica

Come la fetta 1: test del server su Postgres vero (casi negativi di permesso
con stato invariato, visibilità 404), test dei moduli puri portati dal
prototipo, test dell'implementazione vera con client finto, prototipo invariato
(~6800 test sul finto), `check-no-seed`, giro completo dell'orchestratrice, due
review. Tabella di parità: `apps/desktop/docs/integration-slice2.md`.
