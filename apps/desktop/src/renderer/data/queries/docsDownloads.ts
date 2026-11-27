import { useMutation } from "@tanstack/react-query";
import * as api from "@backend/api";
import type { DocKind } from "../model";

// Scaricare dai Docs (ritiro del web vecchio, inventario 1.5): lo zip di una
// categoria e il `graph.json`. Nessuna cache: sono gesti, non letture.

export type { DocDownloadResult } from "../docs/downloads";

export function useExportDocCategory() {
  return useMutation({
    mutationFn: ({ repositoryId, kind }: { repositoryId: string; kind: DocKind }) =>
      api.docs.exportCategory(repositoryId, kind),
  });
}

export function useDownloadGraphJson() {
  return useMutation({
    mutationFn: (repositoryId: string) => api.docs.downloadGraphJson(repositoryId),
  });
}
