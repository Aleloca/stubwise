import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../components/WhoCanLink";
import { LockIcon } from "./parts";

/**
 * La riga di chi legge soltanto ([PS 16]): sotto la testata, col lucchetto,
 * perché non può scrivere e «Who?» (`editDocs`). Una per pagina, sempre;
 * sull'indice la stessa frase al plurale. Chi la mostra lo decide la vista
 * (`permissions.edit`), non questa riga.
 */
export function ReadOnlyLine({
  projectId,
  projectCode,
  scope,
}: {
  projectId: string;
  projectCode: string;
  scope: "page" | "index";
}) {
  const { t } = useTranslation();
  return (
    <p className="flex items-center gap-1.5 text-sm text-ink-muted">
      <LockIcon />
      <span className="text-pretty">
        <span>
          {t(scope === "page" ? "productDocs.space.readOnlyPage" : "productDocs.space.readOnlyIndex", {
            code: projectCode,
          })}
        </span>{" "}
        · <WhoCanLink action="editDocs" projectId={projectId} projectCode={projectCode} />
      </span>
    </p>
  );
}
