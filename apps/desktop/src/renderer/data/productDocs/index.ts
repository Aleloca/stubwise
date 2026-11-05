// Lo spazio Prodotto (area 11a) come lo espone `api.ts`:
// `api.productDocs.<funzione>`. Chi vede che cosa lo decide `docsAccess`
// (`docs/reads.ts`), la stessa funzione dei Docs, per letture e scritture.
export {
  getProductPage,
  getProductSpace,
  productPageByCode,
  productPageById,
  productPageRef,
  readableProductPages,
} from "./reads";
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
export { listProductRevisions, touchedAfter } from "./revisions";
export {
  followersOf,
  followProductPage,
  productDocRecipients,
  unfollowProductPage,
} from "./follows";
