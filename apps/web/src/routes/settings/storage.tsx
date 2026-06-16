import { StorageSection } from "../../components/storage-section";

/**
 * Sotto-pagina Storage (solo admin): configurazione del bucket S3-compatibile
 * usato per gli allegati. La logica vive in StorageSection.
 */
export function SettingsStoragePage() {
  return <StorageSection />;
}
