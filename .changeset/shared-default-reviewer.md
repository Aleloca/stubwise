---
"@stubwise/shared": minor
---

Revisore predefinito per provider/workspace e firma delle review di Stubwise:
tutto additivo, i campi nuovi nelle risposte nascono `.default()` per i client
già installati.

- `gitAccountSchema.isDefaultReviewer` (`.default(false)`): l'account è il
  revisore predefinito del suo ambito.
- `effectiveReviewAccountSchema` (`{ id, name, source: "explicit" | "default" }`)
  e `skippedDefaultReviewAccountSchema` (`{ id, name }`), nuovi, e i campi
  `repositorySchema.effectiveReviewAccount` / `.skippedDefaultReviewAccount`
  (`.nullable().default(null)`): il revisore che il server usa davvero su una
  repository, derivato a ogni lettura, e il predefinito che lì non si applica
  perché è l'account principale.
- `repositoryWarningSchema` guadagna `default_review_account_invalid` (avviso
  non bloccante del salvataggio: il predefinito non passa le verifiche sulla
  repository).
- `reviewScopeKey` (`review-scope.ts`, nuovo): l'ambito di un account per il
  predefinito — provider, più il workspace solo su Bitbucket.
- `stubwiseReviewSignature`, `signReviewBody` e `hasStubwiseReviewSignature`
  (`review-signature.ts`, nuovo): generano e riconoscono la firma in fondo alle
  review di Stubwise sulle PR.
