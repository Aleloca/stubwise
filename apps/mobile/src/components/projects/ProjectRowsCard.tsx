import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

export interface ProjectGroupRowProps {
  /**
   * Riga grigia mono SOPRA il titolo: `#27 · urgente · guasto · aperto 2
   * mesi` (22 set 2026, design §3). La compone `ticketHeading`
   * (`lib/ticket-labels.ts`), che omette i pezzi assenti col loro separatore.
   *
   * **Opzionale apposta**: le righe che non sono un ticket — «backlog pronto»
   * è l'unica oggi — restano esattamente com'erano, senza un ramo speciale né
   * un'intestazione vuota che occupi spazio.
   */
  heading?: string;
  /** Testo primario della riga (titolo del ticket, o un riassunto quando non c'è un singolo elemento). */
  title: string;
  /** Testo mono secondario, a destra (stato, ruolo di chi sblocca, azione…). */
  trailing?: string;
  /**
   * Tono di `trailing` — ambra per l'azione che il viewer può fare
   * ("Rispondi ›"), rosso (`danger`, 23 set 2026, monitor) per qualcosa che è
   * davvero ROTTO: un server offline, un controllo giù. Il rosso non si usa
   * per «attenzione» né per «in attesa»: se compare dappertutto smette di
   * dire qualcosa.
   */
  trailingTone?: "amber" | "muted" | "danger";
  onPress?: () => void;
  testID?: string;
  /** Chiave React (non `key`: quel nome ombreggerebbe la prop riservata quando l'oggetto viene letto come props altrove). */
  rowKey: string;
}

/**
 * La CARD di righe del dettaglio progetto: il contenitore col bordo e le
 * righe separate fra loro ma non prima della prima.
 *
 * Estratta da `ProjectGroup` il 22 set 2026 (hub di progetto) perché da
 * allora la usano in due — il gruppo del polso e una sezione dell'hub
 * (`HubSection`), che hanno un'INTESTAZIONE diversa ma lo stesso corpo.
 * Copiarne il disegno nel secondo avrebbe messo il bordo fra le righe in due
 * posti destinati a divergere: è il difetto che questo repo insegue ovunque.
 *
 * `rows` è un ARRAY (come `buttons` di `CardFooter` in
 * `components/inbox/CardShell.tsx`) e non `children`, di proposito: è l'unico
 * modo di sapere qual è la prima riga per disegnare il bordo FRA le righe ma
 * non prima della prima — `index > 0`, esattamente come lì.
 */
export function ProjectRowsCard({ rows }: { rows: ProjectGroupRowProps[] }) {
  return (
    <View style={styles.card}>
      {rows.map((row, index) => {
        // Il titolo e il `trailing` restano sulla STESSA riga; l'intestazione
        // si aggiunge sopra, dentro lo stesso blocco. Nessuna riga in più
        // rispetto a prima per chi non ha un heading — il `gap` della colonna
        // non si applica a un figlio solo.
        const content = (
          <View style={[styles.rowBlock, index > 0 && styles.rowSeparator]}>
            {row.heading !== undefined && (
              <Text style={styles.rowHeading} numberOfLines={1} testID={row.testID ? `${row.testID}-heading` : undefined}>
                {row.heading}
              </Text>
            )}
            <View style={styles.row}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {row.title}
              </Text>
              {row.trailing !== undefined && (
                <Text
                  style={[
                    styles.rowTrailing,
                    row.trailingTone === "amber" && styles.rowTrailingAmber,
                    row.trailingTone === "danger" && styles.rowTrailingDanger,
                  ]}
                  testID={row.testID ? `${row.testID}-trailing` : undefined}
                >
                  {row.trailing}
                </Text>
              )}
            </View>
          </View>
        );
        if (!row.onPress) {
          return (
            <View key={row.rowKey} testID={row.testID}>
              {content}
            </View>
          );
        }
        return (
          <Pressable key={row.rowKey} onPress={row.onPress} accessibilityRole="button" testID={row.testID}>
            {content}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    overflow: "hidden",
  },
  rowBlock: {
    gap: 3,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  rowHeading: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
  rowSeparator: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  rowTitle: {
    color: colors.fg,
    flex: 1,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  rowTrailing: {
    color: colors.faint,
    flexShrink: 0,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
  rowTrailingAmber: {
    color: colors.signal,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  rowTrailingDanger: {
    color: colors.danger,
  },
});
