# Invarianti e trappole — Il registro delle modifiche (16 nov 2026)

> Design: `docs/plans/2026-11-16-integrazione-area9-design.md` (F2, D-3 = a e
> D-4 = a del maintainer). Il registro di sicurezza (`security_events`) resta
> a sé: `second-factor.md`.

- **Il registro delle modifiche si scrive nella transazione della modifica,
  e non si modifica né si cancella mai.** `recordChange(tx, …)`, un trigger
  che rifiuta UPDATE e DELETE, nessuna potatura (D-4: per sempre). Un tipo è
  una lista DICHIARATA (`CHANGE_LOG_TYPES`) con il suo schema e il suo
  template: il server manda `type` e `data`, mai prosa.
- **Un segreto non entra mai nel registro**: solo «sostituito». Un test di
  sorgente lo verifica sugli scrittori.
- **La lettura è filtrata nella WHERE**, prima della paginazione
  (`services/change-log-read.ts`): le voci d'istanza con `changelog.view` o
  col `readPermission` del loro tipo (G-3 = a: chi gestisce l'oggetto); quelle
  di un progetto visibile con `changelog.view`, con la gestione di quel
  progetto o col `readPermission` lì; mai una voce che nomini un progetto
  invisibile. Le voci di un progetto ELIMINATO restano nella tabella e non le
  legge nessuno, come nel prototipo.
- **L'attore di una voce si mostra per nome a chi lo CONOSCE** (registro, A11
  r.1414, decisione del maintainer del 23 nov 2026, che supera quella della
  review di F2 del 18 nov, «per nome anche a chi non lo vede altrove»): chi
  guarda non conosce l'attore (`peopleKnownTo`, `services/people-known.ts`:
  nessun progetto visibile in comune, presente o passato, nessun canale
  leggibile) → `actor.id` è il segnaposto `hidden-<n>` della risposta e
  `actor.name` null («Someone»). L'oggetto e i `params` seguono R-G5. Ma una voce su una
  PERSONA che chi guarda non vede non esiste per lui (`person.*`), e dai
  `params` che elencano persone si tolgono quelle invisibili. Le voci di un
  progetto (`member.*`) le protegge la visibilità del progetto, così chi lo
  gestisce legge anche chi ne è uscito.
