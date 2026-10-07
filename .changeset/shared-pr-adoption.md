---
"@stubwise/shared": minor
---

Adozione delle PR aperte da altri: `isCorrectablePr` (la regola unica di
correggibilità: branch di Stubwise del ticket, o PR adottata e non
rilasciata), gli schemi `prAdoptionSchema`, `adoptPrBodySchema` e
`adoptPrResponseSchema` (con `reviewApproved`), il campo
`ticketDetailSchema.prAdoption` (`.nullable().default(null)`), e i branch
protetti per repository: `isProtectedBranch`, `protectedBranchesInputSchema`
e `repositorySchema.protectedBranches` (`.default([])`).
