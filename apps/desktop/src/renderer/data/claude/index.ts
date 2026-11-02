// Il catalogo delle azioni di Claude verso le pagine (`api.claude`, area
// 10a). Solo ciò che si legge: i tipi e le dichiarazioni del catalogo. NON
// esce da qui:
// - `CLAUDE_CATALOG`, perché le sue voci (`run`) scrivono senza passare dal
//   cancello: le esegue solo `applyActions`;
// - `classOf`, che prende chi chiede: la classe arriva alle pagine già
//   calcolata, sulla proposta (`cls`, `reasons`);
// - il segno «per conto di» (`via.ts`): nessuna funzione pubblica lo accetta.

//
// «Annulla» (Task 5) sì: passa dal cancello, e gli inversi girano con i
// permessi di adesso.

export type { CatalogInverse, ClaudeActionFn, ObjectRef } from "./types";
export type { ActionClass, ClassReason } from "./classes";
export { declaredClassOf, isCatalogFn } from "./catalog";
export { undoClaudeActions, type UndoResult } from "./actions";
