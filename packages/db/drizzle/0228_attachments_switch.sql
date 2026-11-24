-- Lotto 6, voce 2: l'interruttore d'istanza degli allegati, come il prototipo
-- (`attachmentsEnabled` di Impostazioni → Archiviazione). Default ACCESO:
-- sulle istanze esistenti non cambia niente (gli allegati restano accesi dove
-- l'archiviazione è configurata e valida). Spento, i caricamenti nuovi si
-- fermano; la lettura di ciò che c'è resta.
ALTER TABLE "instance_settings" ADD COLUMN "attachments_switch" boolean DEFAULT true NOT NULL;
