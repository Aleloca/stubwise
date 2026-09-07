---
"@stubwise/shared": minor
---

Brief settimanale negli schemi condivisi: `projectBriefWeeklySchema` (la forma di
`GET /api/projects/:id/briefs` e `GET /api/briefs/:id`) e il toggle
`weeklyBriefEnabled` su progetto, in lettura e nel PATCH. Il nome porta
`Weekly` per non confonderlo col *project brief* della documentazione, che è
un'altra cosa con lo stesso nome corto. `error` non fa parte della proiezione:
il messaggio con cui una generazione è fallita può contenere path del worker e
frammenti di prompt, e lo stato `failed` basta a una UI.
