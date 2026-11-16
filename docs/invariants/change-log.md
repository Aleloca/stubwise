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
- **La lettura è filtrata nella WHERE**, prima della paginazione: le voci
  d'istanza con `changelog.view`; quelle di un progetto con `changelog.view`
  o con la gestione di quel progetto; mai una voce che nomini un progetto
  invisibile.
