import { useTranslation } from "react-i18next";
import { BlockSection } from "../home/blocks/BlockSection";

/**
 * «My week» nella Home. Segnaposto del Task 9 (il titolo, il corpo vuoto):
 * il Task 10 lo sostituisce con la settimana vera (giorni, carico, slittate).
 */
export function MyWeekBlock() {
  const { t } = useTranslation();
  return <BlockSection title={t("home.blocks.myWeek")} state={{ status: "ready" }} />;
}
