import { useTranslation } from "react-i18next";
import { DEPARTMENTS } from "../data/seed/departments";
import type { Department } from "../data/types";

const deptOf = (id: string | null | undefined) => DEPARTMENTS.find((d) => d.id === id);

/** Il nome di un reparto (dato di configurazione), `undefined` se non c'è. */
export function departmentName(id: string | null | undefined): string | undefined {
  return deptOf(id)?.name;
}

/**
 * «Department: X» per una riga con la striscia, da mettere nel `title` della
 * riga (tooltip visibile al passaggio); `undefined` senza reparto.
 */
export function useDeptLabel(departmentId: string | null | undefined): string | undefined {
  const { t } = useTranslation();
  const dept = deptOf(departmentId);
  return dept ? t("common.department", { name: dept.name }) : undefined;
}

/**
 * Striscia di reparto di una TASK: barra di 3 px rientrata sul bordo
 * sinistro della riga (mai un bordo colorato). Il reparto appartiene alla
 * task, non al progetto: niente strisce su progetti e tessere. Il colore non
 * è mai l'unico segnale: il nome del reparto c'è nel testo per i lettori di
 * schermo, nel `title` della riga (`useDeptLabel`) e nella legenda in fondo
 * alla superficie (`DeptLegend`). Il genitore deve essere `relative`.
 */
export function DeptStrip({ departmentId }: { departmentId: string | null | undefined }) {
  const label = useDeptLabel(departmentId);
  const dept = deptOf(departmentId);
  if (!dept || !label) return null;
  return (
    <>
      <span
        aria-hidden="true"
        data-dept-strip={dept.id}
        className="absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-[1px]"
        style={{ background: `var(${dept.colorToken})` }}
      />
      <span className="sr-only">{label}</span>
    </>
  );
}

/**
 * Legenda di una riga: solo i reparti presenti nelle righe mostrate, in
 * ordine di configurazione — campione (la stessa barra della striscia) e
 * nome. Niente se non c'è nessuna riga con la striscia.
 */
export function DeptLegend({
  departmentIds,
  wrap = false,
}: {
  departmentIds: Iterable<string | null | undefined>;
  /**
   * Se la superficie è troppo stretta per tutti i nomi (il pannello notifiche,
   * 400 px, coi cinque reparti), la legenda va a capo invece di tagliarli.
   */
  wrap?: boolean;
}) {
  const { t } = useTranslation();
  const present = new Set(departmentIds);
  const shown: Department[] = DEPARTMENTS.filter((d) => present.has(d.id));
  if (shown.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t("common.departmentsLegend")}
      data-dept-legend
      className={`flex min-w-0 items-center gap-3 text-xs text-ink-muted ${wrap ? "flex-wrap gap-y-1" : "overflow-hidden whitespace-nowrap"}`}
    >
      <span aria-hidden="true" className="shrink-0">
        {t("common.departmentsLegend")}
      </span>
      <span className={`flex min-w-0 items-center gap-3 ${wrap ? "flex-wrap gap-y-1" : ""}`}>
        {shown.map((d) => (
          <span
            key={d.id}
            data-dept-legend-item={d.id}
            className="flex items-center gap-1.5 whitespace-nowrap"
          >
            <span
              aria-hidden="true"
              className="h-3 w-[3px] shrink-0 rounded-[1px]"
              style={{ background: `var(${d.colorToken})` }}
            />
            {d.name}
          </span>
        ))}
      </span>
    </div>
  );
}
