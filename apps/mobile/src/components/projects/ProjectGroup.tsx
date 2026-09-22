import { StyleSheet, View } from "react-native";
import { SectionLabel } from "../SectionLabel";
import { ProjectRowsCard, type ProjectGroupRowProps } from "./ProjectRowsCard";
import { colors } from "../../theme/tokens";

export type { ProjectGroupRowProps };

/**
 * UN gruppo del dettaglio progetto (canvas `2b`): etichetta di sezione con
 * conteggio + la card che raccoglie le sue righe (`ProjectRowsCard`, condivisa
 * con `HubSection` dal 22 set 2026).
 *
 * `amber` è SOLO per "Aspetta qualcuno": è l'unico gruppo il cui colore
 * ambra fa parte del significato ("qualcuno sta aspettando"), non
 * un'enfasi decorativa.
 */
export function ProjectGroup({ label, amber = false, rows }: { label: string; amber?: boolean; rows: ProjectGroupRowProps[] }) {
  return (
    <View style={styles.group}>
      <SectionLabel style={amber ? styles.labelAmber : undefined}>{label}</SectionLabel>
      <ProjectRowsCard rows={rows} />
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    gap: 8,
  },
  labelAmber: {
    color: colors.signal,
  },
});
