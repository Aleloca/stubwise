import type { BacklogItem, Reader } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PrimaryButton } from "../PrimaryButton";
import { PulseIndicator } from "../PulseIndicator";
import {
  backlogDatesPart,
  backlogMetaParts,
  backlogStatusLabelKey,
  backlogStatusTone,
} from "../../lib/backlog-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

export interface BacklogListCardProps {
  item: Reader<BacklogItem>;
  proceedPending: boolean;
  onProceed: () => void;
  /** Il nome del progetto della voce, risolto da chi ha l'elenco progetti. */
  projectName?: string;
  onOpenDetail: () => void;
}

/**
 * La card di UNA voce di backlog in lista (canvas `3a`).
 *
 * Viveva dentro `screens/backlog/BacklogScreen.tsx`, non esportata; estratta
 * qui il 22 set 2026 (hub di progetto) perché da allora la montano in DUE —
 * il tab BLG e la schermata del backlog DI UN PROGETTO. **Estratta, non
 * copiata**: due card che dicono la stessa cosa in due posti divergono, ed è
 * il difetto che questo repo insegue ovunque. L'estrazione è stata pulita —
 * la card non leggeva nessuno stato locale della schermata, prende tutto
 * dalle props.
 *
 * Le card non sono un `Pressable` UNICO, e la ragione resta quella di sempre:
 * annidare un `Pressable` (Procedi) dentro un altro non ha precedenti in
 * questa codebase — stesso principio di `CardShell` in `components/inbox/`.
 *
 * ⚠️ **Fino al 15 set 2026 da questo discendeva però che una voce ATTIVA non
 * si potesse APRIRE affatto**, e non era l'intenzione. Risolto senza annidare
 * niente: la parte ALTA della card (titolo e metadati) è un `Pressable` verso
 * il dettaglio, e i bottoni restano suoi FRATELLI, non suoi figli. Le card
 * chiuse (`converted`/`archived`), che azioni non ne hanno, restano
 * cliccabili per intero come prima.
 */
export function BacklogListCard({ item, proceedPending, onProceed, projectName, onOpenDetail }: BacklogListCardProps) {
  const { t } = useTranslation();
  const metaText = backlogMetaParts(item)
    .map((part) => t(part.key, part.params))
    .join(" · ");
  const datesPart = backlogDatesPart(item);
  const isReady = item.status === "ready";
  const isClosed = item.status === "converted" || item.status === "archived";

  // Titolo e metadati: è questa la superficie che apre il dettaglio, e sta
  // FUORI dal blocco delle azioni — vedi il docblock del modulo.
  const header = (
    <>
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {item.title}
        </Text>
        <PulseIndicator tone={backlogStatusTone(item.status)} text={t(backlogStatusLabelKey(item.status))} />
      </View>
      {/*
        Riga d'IDENTITÀ (16 set 2026): progetto a sinistra, date a destra.
        Prima progetto, date e stime stavano tutti in UNA riga di metadati
        indistinta che andava a capo comunque — il peggio dei due mondi. Sono
        tre domande diverse («di cosa parla», «quando», «quanto lavoro è») e
        ognuna ha la sua riga, così l'occhio le separa senza leggerle tutte.
      */}
      <View style={styles.cardIdentity}>
        <Text style={styles.cardProject} numberOfLines={1}>
          {projectName ?? ""}
        </Text>
        <Text style={styles.cardDates}>{t(datesPart.key, datesPart.params)}</Text>
      </View>
      <Text style={styles.cardMeta}>{metaText}</Text>
    </>
  );

  // Una card chiusa non ha azioni: cliccabile per intero, nessun annidamento
  // possibile.
  if (isClosed) {
    return (
      <Pressable onPress={onOpenDetail} style={styles.card} testID={`backlog-card-${item.id}`}>
        {header}
      </Pressable>
    );
  }

  return (
    <View style={styles.card} testID={`backlog-card-${item.id}`}>
      <Pressable accessibilityRole="button" onPress={onOpenDetail} testID={`backlog-open-${item.id}`}>
        {header}
      </Pressable>
      {/*
        Qui `isClosed` è già falso: il ramo sopra è uscito.

        ⚠️ «Raffina in chat» NON sta più qui (16 set 2026, richiesta del
        maintainer): vive nel DETTAGLIO, dove c'è il documento su cui si sta
        decidendo di aprire una chat. Toglierlo dalla lista non chiude nessuna
        porta — `BacklogItemScreen` offre già sia la chat sia «Procedi», ed è
        stato verificato PRIMA di rimuoverlo, non dopo.
      */}
      {isReady && (
        <View style={styles.cardActions}>
          <View style={styles.proceedButton}>
            <PrimaryButton
              label={t("mobile.backlog.actions.proceed")}
              onPress={onProceed}
              disabled={proceedPending}
              testID={`backlog-proceed-${item.id}`}
            />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    padding: 14,
  },
  cardTop: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  cardTitle: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
  },
  cardIdentity: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
    marginTop: 6,
  },
  cardProject: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 13,
    fontWeight: "600",
  },
  cardDates: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  cardMeta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 6,
  },
  cardActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
  },
  proceedButton: {
    flex: 1.6,
  },
});
