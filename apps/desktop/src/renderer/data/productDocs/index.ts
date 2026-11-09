// Lo spazio Prodotto (area 11a) come lo espone `api.ts`:
// `api.productDocs.<funzione>`. Chi vede che cosa lo decide `docsAccess`
// (`docs/reads.ts`), la stessa funzione dei Docs, per letture e scritture.
export {
  getProductExport,
  getProductPage,
  getProductSpace,
  productPageByCode,
  productPageById,
  productPageRef,
  readableProductPages,
} from "./reads";
export { searchProductPages } from "./search";
export {
  createProductPage,
  createProductPageAs,
  deleteProductPage,
  deleteProductPageAs,
  moveProductPage,
  onAnchorsMerged,
  renameProductPage,
  renameProductPageAs,
  saveProductBlocks,
  writeProductBlocksAs,
} from "./writes";
export { lastRevisionTouching, listProductRevisions, touchedAfter } from "./revisions";
export {
  followersOf,
  followProductPage,
  productDocRecipients,
  unfollowProductPage,
} from "./follows";
export {
  addProductComment,
  addProductCommentAs,
  listProductComments,
  productMentionCandidates,
  reopenProductComment,
  resolveProductComment,
} from "./comments";
export {
  applyProductSource,
  askProductQuestion,
  whenProductClaudeIdle,
  type ProductSourceOutcome,
} from "./claude";
export { productUpdatesWaiting } from "./claudeReads";
export { listProductMarks, listProductMarksAs } from "./marks";
export {
  acceptProductMark,
  acceptProductMarkAs,
  undoProductChange,
  undoProductChangeAs,
} from "./markGestures";
export { onProductFirstVersion, onProductQuestionsChanged } from "./events";
export {
  acceptFirstVersionPage,
  acceptFirstVersionPageAs,
  firstVersionSourcesFor,
  getProductFirstVersion,
  listFirstVersionSources,
  listOpenProductQuestions,
  openProductQuestions,
  productFirstVersionOf,
  startFirstVersion,
  startFirstVersionAs,
  undoFirstVersion,
  undoFirstVersionAs,
  whenFirstVersionIdle,
  type FirstVersionSources,
} from "./firstVersion";
export {
  answerProductQuestion,
  answerProductQuestionAs,
  listProductRequestsPreparing,
  productQuestionDecisions,
  productRequestsPreparingAs,
  productQuestionRequestDraft,
} from "./questions";
export {
  getProductPresence,
  joinProductPage,
  leaveProductPageAs,
  onProductPresence,
  setProductPresence,
  subscribeProductPage,
  whenProductIdle,
  writersNear,
} from "./presence";
export {
  listProductLinkedRequests,
  listProductLinkedRequestsAs,
  productOriginOf,
  proposeBacklogFromPage,
  proposeBacklogFromPageAs,
} from "./backlog";
export {
  drawWireframe,
  drawWireframeAs,
  keepWireframe,
  keepWireframeAs,
  pickWireframe,
  redrawWireframe,
  redrawWireframeAs,
  replaceWireframeWithImage,
  replaceWireframeWithImageAs,
  wireframeKey,
} from "./wireframes";
