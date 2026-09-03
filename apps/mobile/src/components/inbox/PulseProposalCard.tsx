import type { InboxItem, Reader } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, Text, View } from "react-native";
import { CardFooter, CardShell } from "./CardShell";
import { SnoozeSheet } from "./SnoozeSheet";
import { useHandled, useProceed, useSnooze } from "../../lib/inbox-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

export interface PulseProposalCardProps {
  item: Reader<InboxItem>;
  projectName?: string;
}

const LETTERS = "ABCDEFGHIJ";

/**
 * Proposta del pulse proattivo (`project.pulse`, canvas `1b`): A/B/C con
 * urgenza·effort, la consigliata marcata, "Procedi con {lettera}" avvia
 * SUBITO l'opzione consigliata (un tap, niente sheet — diverso dalla domanda
 * dell'agente perché qui non c'è un turno da "rispondere", c'è un lavoro da
 * far partire). `pulse.proposals[i]` descrive `question.options[i]`: stesso
 * indice, per costruzione del contratto (vedi `inboxPulseSchema`).
 */
export function PulseProposalCard({ item, projectName }: PulseProposalCardProps) {
  const { t } = useTranslation();
  const proceed = useProceed();
  const snooze = useSnooze();
  const handled = useHandled();
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  const can = (action: string) => (item.actions as string[]).includes(action);
  const question = item.question;
  const pulse = item.pulse;

  const options =
    question !== undefined && pulse !== undefined
      ? question.options.slice(0, pulse.proposals.length).map((option, index) => ({
          option,
          proposal: pulse.proposals[index],
          letter: LETTERS[index] ?? String(index + 1),
        }))
      : [];

  const recommended =
    question?.recommendedIndex !== undefined && question.recommendedIndex >= 0 && question.recommendedIndex < options.length
      ? options[question.recommendedIndex]
      : undefined;

  const footerButtons = [];
  if (can("open") && item.url !== undefined) {
    footerButtons.push({
      key: "refine",
      label: t("mobile.inbox.actions.refine"),
      onPress: () => void Linking.openURL(item.url as string),
      testID: "pulse-card-refine",
    });
  }
  if (can("snooze")) {
    footerButtons.push({
      key: "snooze",
      label: t("mobile.inbox.actions.snooze"),
      onPress: () => setSnoozeOpen(true),
      testID: "pulse-card-snooze",
    });
  }
  if (can("handled")) {
    footerButtons.push({
      key: "handled",
      label: t("mobile.inbox.actions.handled"),
      onPress: () => handled.mutate({ id: item.id }),
      testID: "pulse-card-handled",
    });
  }

  return (
    <CardShell
      tone="signal"
      kindLabel={t("mobile.inbox.kinds.pulse")}
      projectName={projectName ?? pulse?.projectName}
      createdAt={item.createdAt}
      footer={footerButtons.length > 0 ? <CardFooter buttons={footerButtons} /> : undefined}
      testID="pulse-proposal-card"
    >
      {pulse !== undefined && (
        <Text style={styles.idle}>{t("mobile.inbox.pulse.idle", { count: pulse.idleDays })}</Text>
      )}
      <Text style={styles.text}>{item.text}</Text>

      {options.map(({ option, proposal, letter }, index) => (
        <View
          key={proposal.backlogItemId}
          style={[styles.optionRow, index === question?.recommendedIndex && styles.optionRowRecommended]}
          testID={`pulse-card-option-${letter}`}
        >
          <Text style={[styles.letter, index === question?.recommendedIndex && styles.letterRecommended]}>{letter}</Text>
          <Text style={styles.optionTitle} numberOfLines={1}>
            {option.label}
          </Text>
          <Text style={styles.optionMeta}>
            {proposal.urgency !== null ? t(`mobile.inbox.pulse.priority.${proposal.urgency}`) : ""}
            {proposal.urgency !== null && proposal.effort !== null ? " · " : ""}
            {proposal.effort !== null ? t("mobile.inbox.pulse.effort", { value: proposal.effort }) : ""}
            {index === question?.recommendedIndex ? ` · ${t("mobile.inbox.question.recommended").toLowerCase()}` : ""}
          </Text>
        </View>
      ))}

      {recommended !== undefined && can("answer") && (
        <View style={styles.proceedButton}>
          <PulseProceedButton
            label={t("mobile.inbox.actions.proceedWith", { letter: recommended.letter })}
            disabled={proceed.disabled}
            onPress={() => proceed.mutate({ id: item.id, body: { optionIndex: question?.recommendedIndex as number } })}
          />
        </View>
      )}

      {proceed.errorMessage !== null && <Text style={styles.error}>{proceed.errorMessage}</Text>}

      <SnoozeSheet
        visible={snoozeOpen}
        onRequestClose={() => setSnoozeOpen(false)}
        onChoose={(until) => {
          setSnoozeOpen(false);
          snooze.mutate({ id: item.id, until });
        }}
        testID="pulse-card-snooze-sheet"
      />
    </CardShell>
  );
}

/**
 * Bottone pieno dentro il corpo della card (non nel footer, che qui porta
 * solo "Va raffinata"/"Rimanda"/"Gestita"): stile a sé perché il canvas lo
 * vuole a piena larghezza fra le opzioni e il footer, non in coda a una riga
 * di bottoni pari altezza.
 */
function PulseProceedButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <Text
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onPress={disabled ? undefined : onPress}
      testID="pulse-card-proceed"
      style={[proceedStyles.button, disabled && proceedStyles.disabled]}
    >
      {label}
    </Text>
  );
}

const proceedStyles = StyleSheet.create({
  button: {
    backgroundColor: colors.signal,
    borderRadius: radii.control,
    color: colors.ink950,
    fontFamily: fontFamily.monoSemiBold,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.8,
    minHeight: 44,
    overflow: "hidden",
    paddingVertical: 12,
    textAlign: "center",
    textTransform: "uppercase",
  },
  disabled: {
    opacity: 0.5,
  },
});

const styles = StyleSheet.create({
  idle: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginBottom: 4,
  },
  text: {
    color: colors.fg,
    fontSize: 15,
    lineHeight: 21,
  },
  optionRow: {
    alignItems: "center",
    borderColor: "#2c3641",
    borderRadius: radii.control,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  optionRowRecommended: {
    backgroundColor: "rgba(245,166,35,0.07)",
    borderColor: "rgba(245,166,35,0.55)",
  },
  letter: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  letterRecommended: {
    color: colors.signal,
  },
  optionTitle: {
    color: colors.fg,
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
  },
  optionMeta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    textTransform: "uppercase",
  },
  proceedButton: {
    marginTop: 12,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
    marginTop: 8,
  },
});
