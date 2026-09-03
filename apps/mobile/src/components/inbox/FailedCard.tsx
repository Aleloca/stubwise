import type { InboxItem, Reader } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, Text } from "react-native";
import { CardFooter, CardShell } from "./CardShell";
import { SnoozeSheet } from "./SnoozeSheet";
import { useHandled, useRelaunch, useSnooze } from "../../lib/inbox-mutations";
import { can } from "../../lib/inbox-sections";
import { colors } from "../../theme/tokens";

export interface FailedCardProps {
  item: Reader<InboxItem>;
  projectName?: string;
}

/**
 * Lavoro fallito (`job.failed`, canvas `1c`): "Riprova" rilancia il job,
 * "Apri il lavoro" porta al ticket, "Rimanda"/"Gestita" sono igiene. Tono
 * `danger` — l'unica card rossa fra le sei varianti.
 */
export function FailedCard({ item, projectName }: FailedCardProps) {
  const { t } = useTranslation();
  const relaunch = useRelaunch();
  const snooze = useSnooze();
  const handled = useHandled();
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  const buttons = [];
  if (can(item, "relaunch")) {
    buttons.push({
      key: "retry",
      label: t("mobile.inbox.actions.retry"),
      emphasis: true,
      onPress: () => relaunch.mutate({ id: item.id }),
      disabled: relaunch.disabled,
      testID: "failed-card-retry",
    });
  }
  if (can(item, "open") && item.url !== undefined) {
    buttons.push({
      key: "open",
      label: t("mobile.inbox.actions.openWork"),
      onPress: () => void Linking.openURL(item.url as string),
      testID: "failed-card-open",
    });
  }
  if (can(item, "snooze")) {
    buttons.push({
      key: "snooze",
      label: t("mobile.inbox.actions.snooze"),
      onPress: () => setSnoozeOpen(true),
      testID: "failed-card-snooze",
    });
  }
  if (can(item, "handled")) {
    buttons.push({
      key: "handled",
      label: t("mobile.inbox.actions.handled"),
      onPress: () => handled.mutate({ id: item.id }),
      testID: "failed-card-handled",
    });
  }

  return (
    <CardShell
      tone="danger"
      kindLabel={t("mobile.inbox.kinds.jobFailed")}
      projectName={projectName}
      createdAt={item.createdAt}
      footer={buttons.length > 0 ? <CardFooter buttons={buttons} /> : undefined}
      errorMessage={relaunch.errorMessage ?? snooze.errorMessage ?? handled.errorMessage}
      testID="failed-card"
    >
      <Text style={styles.text}>{item.text}</Text>

      <SnoozeSheet
        visible={snoozeOpen}
        onRequestClose={() => setSnoozeOpen(false)}
        onChoose={(until) => {
          setSnoozeOpen(false);
          snooze.mutate({ id: item.id, until });
        }}
        testID="failed-card-snooze-sheet"
      />
    </CardShell>
  );
}

const styles = StyleSheet.create({
  text: {
    color: colors.fg,
    fontSize: 15,
    lineHeight: 21,
  },
});
