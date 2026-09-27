# Una proposta decisa mostra la decisione — piano

Design: `2026-09-27-proposal-decided-view-design.md`. Branch
`fix/proposal-decided-view`, worktree `.worktrees/proposal-decided`, base
main 3a9d7662. Un commit per task, TDD, mutazioni sui punti delicati; al
doppio del client si aggiunge il campo PRIMA del test.

## Task 1 — Salvare gli indici (server, §2)
`markSourceOutcome`/`markSourceFailed` con `chosenIndices`, dalla scelta
singola, da quella multipla e da tutte e tre le sorgenti. Test in
`google-proposal.test.ts` sui valori scritti in colonna.

## Task 2 — Derivare `decision` (shared + server, §3)
Schema in shared (`.nullable().default(null)`), con un test di parse senza il
campo. Caricatore a lotti, e `readGoogle` che compone la decisione. Test:
- proposta decisa con una scelta, con tre, ignorata, fallita;
- CARD VECCHIA senza `chosenIndices`: `chosen []` e status presente;
- notifica aperta: `decision` null;
- una query per tabella e per pagina, non una per card.

## Task 3 — App (§4)
Blocco «Decided by…» in `GoogleProposalScreen`, al posto di «already
decided». Test: io e un collega, `ignored`, `failed`, card vecchia, e subito
dopo la conferma (il refetch rende il blocco).

## Task 4 — Web (§4)
Lo stesso blocco nella card gestita di `inbox-item.tsx`, con `?? null` e la
fixture del test lasciata SENZA il campo.

## Task 5 — CLAUDE.md
Una voce di deploy breve: server + caddy e il rollback del §5.

## Verifica finale
`pnpm lint`, `pnpm typecheck`, e i test di shared, server, web e app. Pusha e
scrivimi.
