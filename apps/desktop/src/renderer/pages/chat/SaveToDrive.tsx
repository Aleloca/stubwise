import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUploadFiles } from "../../data/queries";
import { onBeforePersonaChange } from "../../data/session";
import type { Attachment, DriveUploadInput, Project } from "../../data/types";
import { useToast } from "../../tasks-ui/Toast";
import { UploadGlyph } from "../drive/glyphs";
import { ProjectChoiceDialog, useUploadProjects } from "../drive/WhichProjectDialog";

// «Save to Drive» sull'allegato di un messaggio (area 5, design «Citazioni»):
// gli allegati della Chat non entrano da soli nel Drive. In un canale di
// progetto si salva in quel progetto; in un DM o in un canale generale si
// sceglie il progetto fra quelli dove chi guarda ha `drive.upload`. Senza
// un progetto idoneo l'azione non c'è (non un bottone spento: non c'è).

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * Il file da caricare, dal modello dell'allegato: nome e peso così come
 * sono, il tipo dall'estensione (l'allegato non lo conserva).
 */
export function uploadInputOf(attachment: Attachment): DriveUploadInput {
  const ext = /\.([a-z0-9]+)$/i.exec(attachment.name)?.[1]?.toLowerCase() ?? "";
  const mime =
    MIME_BY_EXTENSION[ext] ??
    (attachment.kind === "image" ? "image/*" : "application/octet-stream");
  return { name: attachment.name, mime, sizeBytes: attachment.sizeBytes };
}

/**
 * Il bottone sul gettone dell'allegato. `projectId`: il progetto del canale
 * (`null` in un DM o in un canale generale).
 */
export function SaveToDriveButton({
  attachment,
  projectId,
}: {
  attachment: Attachment;
  projectId: string | null;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const eligible = useUploadProjects();
  const upload = useUploadFiles();
  const [asking, setAsking] = useState(false);
  // Cambio di persona: la domanda «in quale progetto?» di chi guardava prima
  // non resta aperta (i progetti idonei erano i suoi).
  useEffect(() => onBeforePersonaChange(() => setAsking(false)), []);

  // Si decide sui permessi calcolati, non a tentativi: finché non ci sono, niente bottone.
  if (!eligible) return null;
  const here = projectId === null ? null : (eligible.find((p) => p.id === projectId) ?? null);
  if (projectId !== null ? here === null : eligible.length === 0) return null;

  const save = (project: Project) => {
    if (upload.isPending) return;
    upload.mutate(
      { projectId: project.id, files: [uploadInputOf(attachment)] },
      {
        onSuccess: ([result]) => {
          setAsking(false);
          if (!result?.file) {
            toast.error(t("chat.saveToDrive.tooLarge", { name: attachment.name }));
            return;
          }
          const code = result.file.code;
          toast.show(t("chat.saveToDrive.saved", { project: project.code, code }), {
            action: {
              label: t("drive.which.open"),
              run: () =>
                void navigate({
                  to: "/p/$code/$section",
                  params: { code: project.code, section: "drive" },
                  search: { file: code } as never,
                }),
            },
          });
        },
        // Nel dialogo l'errore resta lì (si riprova); dal canale di progetto, l'avviso.
        onError: () => {
          if (!asking) toast.error(t("chat.saveToDrive.failed"));
        },
      },
    );
  };

  const label = t("chat.saveToDrive.label", { name: attachment.name });
  return (
    <>
      <button
        type="button"
        onClick={() => (here ? save(here) : setAsking(true))}
        disabled={upload.isPending}
        aria-label={label}
        title={t("chat.saveToDrive.short")}
        className="grid size-7 shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink disabled:opacity-40"
      >
        <UploadGlyph />
      </button>
      {asking && (
        <ProjectChoiceDialog
          title={t("chat.saveToDrive.title", { name: attachment.name })}
          description={t("chat.saveToDrive.body")}
          confirmLabel={t("chat.saveToDrive.confirm")}
          eligible={eligible}
          pending={upload.isPending}
          failed={upload.isError ? t("chat.saveToDrive.failed") : null}
          onConfirm={save}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
}
