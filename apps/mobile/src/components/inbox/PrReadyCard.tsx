import type { InboxItem, Reader } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, Text } from "react-native";
import { CardFooter, CardShell } from "./CardShell";
import { SnoozeSheet } from "./SnoozeSheet";
import { useHandled, useSnooze } from "../../lib/inbox-mutations";
import { colors } from "../../theme/tokens";

export interface PrReadyCardProps {
  item: Reader<InboxItem>;
  projectName?: string;
}

/**
 * Aggiornamenti sulla pull request (`job.pr_opened`, `review.completed`,
 * canvas `1c` — "PR pronta al rilascio").
 *
 * ⚠️ **GAP NOTO rispetto al canvas, deliberato**: il mock mostra un bottone
 * "Rilascia (merge)" — non esiste alcuna azione `merge` nel contratto
 * (`inboxActionSchema` di `@stubwise/shared` ha solo `approve_plan`/
 * `reject_plan`/`relaunch`/`answer`/`open`/`snooze`/`handled`, e
 * `job.pr_opened`/`review.completed` hanno `decisions: []` nel catalogo
 * server — `packages/notifications/src/actions.ts`). Il rilascio di una PR va
 * ancora fatto dal provider git; questa card resta **informativa**: mostra
 * `item.text` (che include già l'esito della review — vedi
 * `notify.reviewCompleted`) e i soli bottoni che `actions` offre davvero
 * (`open`/`snooze`/`handled`). Aggiungere "Rilascia" richiederebbe
 * un'estensione additiva del contratto — vedi il report del Task 14.
 */
export function PrReadyCard({ item, projectName }: PrReadyCardProps) {
  const { t } = useTranslation();
  const snooze = useSnooze();
  const handled = useHandled();
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  const can = (action: string) => (item.actions as string[]).includes(action);
  const kindLabelKey = item.kind === "review.completed" ? "mobile.inbox.kinds.reviewCompleted" : "mobile.inbox.kinds.prOpened";

  const buttons = [];
  if (can("open") && item.url !== undefined) {
    buttons.push({
      key: "open",
      label: t("mobile.inbox.actions.openWork"),
      emphasis: true,
      onPress: () => void Linking.openURL(item.url as string),
      testID: "pr-ready-card-open",
    });
  }
  if (can("snooze")) {
    buttons.push({
      key: "snooze",
      label: t("mobile.inbox.actions.snooze"),
      onPress: () => setSnoozeOpen(true),
      testID: "pr-ready-card-snooze",
    });
  }
  if (can("handled")) {
    buttons.push({
      key: "handled",
      label: t("mobile.inbox.actions.handled"),
      onPress: () => handled.mutate({ id: item.id }),
      testID: "pr-ready-card-handled",
    });
  }

  return (
    <CardShell
      tone="ok"
      kindLabel={t(kindLabelKey)}
      projectName={projectName}
      createdAt={item.createdAt}
      footer={buttons.length > 0 ? <CardFooter buttons={buttons} /> : undefined}
      testID="pr-ready-card"
    >
      <Text style={styles.text}>{item.text}</Text>

      <SnoozeSheet
        visible={snoozeOpen}
        onRequestClose={() => setSnoozeOpen(false)}
        onChoose={(until) => {
          setSnoozeOpen(false);
          snooze.mutate({ id: item.id, until });
        }}
        testID="pr-ready-card-snooze-sheet"
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
