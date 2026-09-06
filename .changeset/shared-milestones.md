---
"@stubwise/shared": minor
---

Le milestone hanno finalmente uno schema condiviso: `milestoneSchema`,
`milestoneStatusSchema`, `milestoneCountsSchema`, `milestoneWithCountsSchema`,
`milestoneDraftSchema` e la patch. Vivevano solo dentro la rotta del server,
mentre la web app tipava il proprio client con interfacce scritte a mano — ed è
così che la creazione dalla UI è potuta divergere dal body che il server
esigeva senza che nulla se ne accorgesse. Novità di forma: `repositoryId` è
**opzionale** in creazione (la milestone appartiene al progetto) e **non** fa
parte della proiezione pubblica; `description` e `closedAt` sono nullable, e
`closedAt` non è modificabile a mano — lo governa il passaggio di `status`.
