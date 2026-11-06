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
  getProductPresence,
  joinProductPage,
  leaveProductPageAs,
  onProductPresence,
  setProductPresence,
  subscribeProductPage,
  whenProductIdle,
  writersNear,
} from "./presence";
