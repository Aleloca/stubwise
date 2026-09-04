import { useTranslation } from "react-i18next";
import { StyleSheet, Text } from "react-native";
import { colors } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

/**
 * Riga mono di conteggi sotto la riga di polso (canvas `2a`, es. "2 in
 * lavorazione · 1 piano da Marco · backlog pronto 4"): qui nella forma
 * GENERICA che i dati del polso possono davvero sostenere — `waitingForYou`
 * + `waitingForOthers`, `running`, `backlogReadyCount` — non la copy
 * contestuale del canvas (che nomina persone e stati di PR che
 * `ProjectPulseSummary` non porta). Tre frammenti pluralizzati
 * indipendentemente e uniti con "·": un solo `t()` con `count` sceglierebbe
 * UNA sola forma per l'intera riga, non tre.
 */
export function CountsLine({ waiting, running, ready }: { waiting: number; running: number; ready: number }) {
  const { t } = useTranslation();
  const text = [
    t("mobile.projects.counts.waiting", { count: waiting }),
    t("mobile.projects.counts.running", { count: running }),
    t("mobile.projects.counts.ready", { count: ready }),
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
