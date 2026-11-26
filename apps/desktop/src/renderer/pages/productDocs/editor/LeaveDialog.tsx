import { useTranslation } from "react-i18next";
import { Dialog } from "../../../tasks-ui/Dialog";
import { primaryButton, secondaryButton } from "../../tasks/controls";

// Uscire dalla pagina, o cambiare persona, con qualcosa di non salvato
// (shape product-editor.md §3.12, «scelta del costruttore»; costruito il 21
// nov 2026): «Some changes aren't saved yet» · Stay · Leave without saving.
// «Stay» ha il fuoco ed è il bottone pieno: restare non perde niente. Esc e
// il clic fuori sono «Stay».

export function LeaveDialog({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={t("productDocs.editor.leave.title")}
      onClose={onStay}
      width={420}
      footer={
        <>
          <button type="button" onClick={onLeave} className={secondaryButton}>
            {t("productDocs.editor.leave.leave")}
          </button>
          <button type="button" data-autofocus="" onClick={onStay} className={primaryButton}>
            {t("productDocs.editor.leave.stay")}
          </button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}
