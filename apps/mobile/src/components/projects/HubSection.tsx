import { Pressable, StyleSheet, Text, View } from "react-native";
import { SectionLabel } from "../SectionLabel";
import { ProjectRowsCard, type ProjectGroupRowProps } from "./ProjectRowsCard";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/**
 * LO STATO DI UNA SEZIONE, esplicito e non dedotto.
 *
 * Ogni sezione dell'hub carica PER CONTO SUO (design §4): sei richieste
 * piccole e indipendenti, `useQuery` non suspense. La conseguenza voluta è
 * che una sezione che fallisce mostra il proprio guasto e le altre restano
 * usabili — l'hub non è mai una schermata bianca perché una sola area non
 * risponde. Perché ciò sia vero, lo stato dev'essere un dato che la sezione
 * RICEVE, non qualcosa che si indovina dalla presenza o assenza di righe.
 *
 * ⚠️ `empty` esiste come stato a sé, separato da `ready` con zero righe:
 * «non c'è niente» e «non è arrivato» sono due frasi diverse, e un progetto
 * senza backlog deve poter dire la prima (design §Task 2). Una sezione vuota
 * si MOSTRA, non sparisce — al contrario dei gruppi del polso, che sono
 * «cosa fare adesso» e a zero sarebbero rumore.
 */
export type HubSectionState =
  | { kind: "pending" }
  | { kind: "error"; message: string; retryLabel: string; onRetry: () => void }
  | { kind: "empty"; message: string }
  | { kind: "ready"; rows: ProjectGroupRowProps[] };

/**
 * UNA sezione dell'hub di progetto (22 set 2026, design §3): l'etichetta col
 * conteggio, l'azione «vedi tutte ›» a destra, e sotto il corpo — le prime
 * righe vere, o il proprio stato.
 *
 * L'etichetta arriva GIÀ composta col conteggio («TICKET · 14 aperti»):
 * quante siano e come si chiamino le cose lo sa il chiamante, che ha la
 * risposta in mano. Quando il conteggio non c'è — un server più vecchio non
 * manda `total`, vedi il docblock di `ticketPageSchema.total` — il chiamante
 * passa la sola parola, e la sezione mostra le righe senza il numero: è il
 * degrado previsto, non un caso da nascondere.
 *
 * ⚠️ «vedi tutte ›» resta premibile anche mentre la sezione carica o
 * fallisce: la schermata di destinazione esiste comunque, e su un guasto è
 * anzi la via d'uscita — nasconderla lascerebbe chi guarda senza niente da
 * fare proprio nel momento in cui gli serve.
 */
export function HubSection({
  label,
  state,
  seeAllLabel,
  onSeeAll,
  testID,
}: {
  /** Etichetta di sezione, conteggio incluso quando c'è: «TICKET · 14 aperti». */
  label: string;
  state: HubSectionState;
  /** Testo dell'azione a destra («vedi ›»). Serve insieme a `onSeeAll`. */
  seeAllLabel?: string;
  /** L'approfondimento. Assente = sezione senza una schermata dove atterrare. */
  onSeeAll?: () => void;
  testID: string;
}) {
  return (
    <View style={styles.section} testID={testID}>
      <View style={styles.headerRow}>
        <SectionLabel style={styles.label}>{label}</SectionLabel>
        {onSeeAll !== undefined && seeAllLabel !== undefined && (
          <Pressable accessibilityRole="button" onPress={onSeeAll} testID={`${testID}-see-all`}>
            <Text style={styles.seeAll}>{seeAllLabel}</Text>
          </Pressable>
        )}
      </View>

      {state.kind === "pending" ? (
        <View style={styles.messageCard} testID={`${testID}-pending`}>
          <Text style={styles.message}>{"…"}</Text>
        </View>
      ) : state.kind === "error" ? (
        <View style={styles.messageCard} testID={`${testID}-error`}>
          <Text style={styles.message}>{state.message}</Text>
          <Pressable accessibilityRole="button" onPress={state.onRetry} testID={`${testID}-retry`}>
            <Text style={styles.retry}>{state.retryLabel}</Text>
          </Pressable>
        </View>
      ) : state.kind === "empty" ? (
        <View style={styles.messageCard} testID={`${testID}-empty`}>
          <Text style={styles.message}>{state.message}</Text>
        </View>
      ) : (
        <ProjectRowsCard rows={state.rows} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 8,
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  label: {
    flexShrink: 1,
  },
  seeAll: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  messageCard: {
    alignItems: "center",
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  message: {
    color: colors.faint,
    flexShrink: 1,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  retry: {
    color: colors.signal,
    flexShrink: 0,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
});
