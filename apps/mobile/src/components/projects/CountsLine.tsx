import { useTranslation } from "react-i18next";
import { StyleSheet, Text } from "react-native";
import { colors } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

/**
 * Riga mono di conteggi sotto la riga di polso (canvas `2a`, es. "2 in
 * lavorazione · 1 piano da Marco · backlog pronto 4"): qui nella forma
 * GENERICA che i dati del polso possono davvero sostenere — `waitingForYou`
 * + `waitingForOthers` + le PR in attesa di merge, `running`,
 * `backlogReadyCount` e i ticket FERMI — non la copy contestuale del canvas
 * (che nomina persone che `ProjectPulseSummary` non porta). Frammenti
 * pluralizzati indipendentemente e uniti con "·": un solo `t()` con `count`
 * sceglierebbe UNA sola forma per l'intera riga, non una per frammento.
 *
 * ⚠️ `stalled` compare SOLO quando c'è (21 set 2026), al contrario degli
 * altri tre che stanno sempre: «0 fermi» su ogni progetto sano sarebbe rumore
 * costante, mentre i primi tre sono lo scheletro fisso della riga. Ma quando
 * c'è deve esserci: senza, un progetto con soli ticket fermi resta identico a
 * uno tranquillo, e per scoprirlo bisogna aprirlo — cioè il buco che questo
 * batch chiude, lasciato aperto sulla schermata da cui si parte.
 */
export function CountsLine({
  waiting,
  running,
  ready,
  stalled = 0,
}: {
  waiting: number;
  running: number;
  ready: number;
  stalled?: number;
}) {
  const { t } = useTranslation();
  const text = [
    t("mobile.projects.counts.waiting", { count: waiting }),
    t("mobile.projects.counts.running", { count: running }),
    t("mobile.projects.counts.ready", { count: ready }),
    ...(stalled > 0 ? [t("mobile.projects.counts.stalled", { count: stalled })] : []),
  ].join(" · ");

  return <Text style={styles.text}>{text}</Text>;
}

const styles = StyleSheet.create({
  text: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
});
