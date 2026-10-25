// Il Drive (area 5) come lo espone `api.ts`: `api.drive.<funzione>`. Chi vede
// che cosa lo decide `canSeeDriveFile` (visibility.ts), per letture e
// scritture. Claude legge da `driveFilesForClaude`/`readDriveFileForClaude`
// (reads.ts), che non contano aperture.
export {
  getDriveFile,
  getGoogleAccount,
  listDriveFiles,
  listDriveFilesForClaude,
  listFolderLinks,
  listMyFolderLinks,
  countDriveReaders,
  listGoogleFiles,
  listGoogleFolders,
  listGoogleOutside,
  searchDrive,
} from "./reads";
export {
  addGoogleFile,
  connectGoogle,
  deleteDriveFile,
  disconnectGoogle,
  driveContentHistory,
  linkFolder,
  recordOpen,
  removeGoogleFile,
  retryExtraction,
  setHidden,
  syncFolder,
  unlinkFolder,
  uploadFiles,
  whenDriveIdle,
} from "./writes";
