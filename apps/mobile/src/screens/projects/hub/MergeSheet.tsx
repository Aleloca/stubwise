import { useTranslation } from "react-i18next";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { GhostButton } from "../../../components/GhostButton";
import { PrimaryButton } from "../../../components/PrimaryButton";
import { SheetModal } from "../../../components/SheetModal";
import type { HubDestination } from "../../../lib/project-hub";
import { colors } from "../../../theme/tokens";
import { fontFamily } from "../../../theme/typography";

export type MergeTarget = Extract<HubDestination, { kind: "confirmMerge" }>;

/**
 * LA CONFERMA DEL MERGE (28 set 2026, dettaglio progetto v3 §6): il secondo
 * dei due passi, come nella coda di rilascio del web. Dice cosa si sta per
 * mergiare — il ticket, il repository, il link alla PR per guardarla prima —
 * e solo «Mergia» qui chiama la rotta.
 *
 * Gli errori restano DENTRO il pannello, che non si chiude: chi ha premuto
 * deve leggere perché non è andata, e poter riprovare o annullare. Mentre la
 * richiesta è in volo il pannello non si manda via — l'esito arriverebbe su
 * una finestra che non c'è più.
 */
export function MergeSheet({
  target,
  pending,
  errorMessage,
  onConfirm,
  onClose,
}: {
  target: MergeTarget | null;
  pending: boolean;
  errorMessage: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SheetModal open={target !== null} onClose={onClose} scrollable={false} dismissible={!pending} testID="merge-sheet">
      {target !== null && (
        <View style={styles.body}>
          <Text style={styles.title}>{t("mobile.projects.merge.title", { number: target.ticketNumber })}</Text>
          <Text style={styles.context} numberOfLines={2}>
            {target.repositoryName !== undefined ? `${target.repositoryName} · ${target.title}` : target.title}
          </Text>
          <Pressable
            accessibilityRole="link"
            hitSlop={8}
            onPress={() => void Linking.openURL(target.prUrl)}
            style={styles.link}
            testID="merge-sheet-open-pr"
          >
            <Text style={styles.linkText}>{t("mobile.projects.merge.openPr")}</Text>
          </Pressable>

          {errorMessage !== null && (
            <Text accessibilityLiveRegion="polite" style={styles.error} testID="merge-sheet-error">
              {errorMessage}
            </Text>
          )}

          <View style={styles.actions}>
            <View style={styles.primary}>
              <PrimaryButton
                label={t("mobile.projects.merge.confirm")}
                onPress={onConfirm}
                pending={pending}
                testID="merge-sheet-confirm"
              />
            </View>
            <View style={styles.secondary}>
              <GhostButton
                besidePrimary
                label={t("mobile.projects.merge.cancel")}
                onPress={onClose}
                disabled={pending}
                testID="merge-sheet-cancel"
              />
            </View>
          </View>
        </View>
      )}
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: 6,
  },
  title: {
    color: colors.fg,
    fontFamily: fontFamily.sansBold,
    fontSize: 18,
    fontWeight: "700",
  },
  context: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  link: {
    alignSelf: "flex-start",
    marginTop: 2,
  },
  linkText: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  error: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    marginTop: 8,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
  },
  primary: {
    flex: 1,
  },
  secondary: {
    flex: 1,
  },
});
