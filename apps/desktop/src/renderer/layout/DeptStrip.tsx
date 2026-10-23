import { useTranslation } from "react-i18next";
import { DEPARTMENTS } from "../data/seed/departments";

/**
 * Striscia di reparto di una TASK: barra di 3 px rientrata sul bordo
 * sinistro della riga (mai un bordo colorato). Il reparto appartiene alla
 * task, non al progetto: niente strisce su progetti e tessere. Il colore non
 * è mai l'unico segnale: il nome del reparto c'è nel testo per i lettori di
 * schermo e nel `title`. Il genitore deve essere `relative`.
 */
export function DeptStrip({ departmentId }: { departmentId: string | null | undefined }) {
  const { t } = useTranslation();
  const dept = DEPARTMENTS.find((d) => d.id === departmentId);
  if (!dept) return null;
  const label = t("common.department", { name: dept.name });
  return (
    <>
      <span
        aria-hidden="true"
        data-dept-strip={dept.id}
        title={label}
        className="absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-[1px]"
        style={{ background: `var(${dept.colorToken})` }}
      />
      <span className="sr-only">{label}</span>
    </>
  );
}
