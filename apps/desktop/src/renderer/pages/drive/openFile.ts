import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useDriveFileIfStillThere } from "../../data/queries";
import type { DriveFileRow } from "../../data/types";
import { useToast } from "../../tasks-ui/Toast";
import { previewKind } from "./driveFilters";
import { useDriveOpeners } from "./FilePreview";

/**
 * Apre un file del Drive da una citazione (gettone, codice nel testo, fonte
 * di Claude): è chi legge che apre, quindi conta (shape drive-search.md §3).
 * Prima rilegge il file: tolto, nascosto o permesso perso dopo che la
 * citazione è stata scritta → «This file is no longer available» e nient'altro
 * (§5). Un Google si apre su Google (avviso, nel prototipo), un caricato con
 * l'anteprima se ne ha una, altrimenti il dettaglio nel Drive.
 *
 * Lo usano anche i risultati di una ricerca (⌘K, Drive) per la stessa
 * ragione: la riga mostrata può essere vecchia, e si decide sul file riletto.
 * `view` sono le righe fra cui l'anteprima scorre (quella aperta al posto
 * della sua riga vecchia); `details` sostituisce il passaggio al dettaglio.
 */
export function useOpenDriveFile(): (id: string, options?: OpenOptions) => void {
  const { t } = useTranslation();
  const toast = useToast();
  const router = useRouter({ warn: false });
  const fileIfThere = useDriveFileIfStillThere();
  const openers = useDriveOpeners();
  return useCallback(
    (id: string, { view, details }: OpenOptions = {}) =>
      void fileIfThere(id).then((file) => {
        if (!file) return toast.error(t("drive.search.gone"));
        if (file.unavailable !== null) {
          return toast.show(t(`drive.row.cantOpen.${file.unavailable}`, { code: file.code }));
        }
        if (file.source === "google") return openers.google(file);
        if (previewKind(file)) {
          const items = (view ?? [file])
            .map((r) => (r.id === file.id ? file : r))
            .filter((r) => previewKind(r));
          return openers.preview(file, items);
        }
        if (details) return details(file);
        const path = `/p/${file.projectCode}/drive?file=${file.code}`;
        if (router) router.history.push(path);
        else window.location.hash = path;
      }),
    [fileIfThere, openers, router, toast, t],
  );
}

interface OpenOptions {
  view?: readonly DriveFileRow[];
  details?: (file: DriveFileRow) => void;
}
