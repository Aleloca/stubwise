---
"@stubwise/shared": minor
---

`agentSessionSummarySchema` guadagna `backlogItemId` (`.nullable().default(null)`).
`TranscriptItem` di tipo `interrupted` guadagna `authorName` (chi ha fermato il turno, `null` se non si sa).
