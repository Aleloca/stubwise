import type { InboxItem, Reader } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, Text } from "react-native";
import { CardFooter, CardShell } from "./CardShell";
import { SnoozeSheet } from "./SnoozeSheet";
import { can, hasDecisionAction, isAdminGatedKind } from "../../lib/inbox-sections";
import { useHandled, useRelaunch, useSnooze } from "../../lib/inbox-mutations";
import type { ColorToken } from "../../theme/tokens";
import { colors } from "../../theme/tokens";

/** Etichetta e tono per ogni kind SENZA una variante bespoke — fallback per un kind ignoto (`Reader<>`). */
const KIND_META: Record<string, { i18nKey: string; tone: ColorToken }> = {
  "ticket.created": { i18nKey: "mobile.inbox.kinds.ticketCreated", tone: "muted" },
  "job.pr_closed": { i18nKey: "mobile.inbox.kinds.prClosed", tone: "danger" },
  "job.held": { i18nKey: "mobile.inbox.kinds.jobHeld", tone: "signal" },
  "job.plan_review": { i18nKey: "mobile.inbox.kinds.planReview", tone: "signal" },
  "job.budget_held": { i18nKey: "mobile.inbox.kinds.budgetHeld", tone: "signal" },
  "docs.limit_paused": { i18nKey: "mobile.inbox.kinds.docsLimitPaused", tone: "muted" },
  "monitor.alert": { i18nKey: "mobile.inbox.kinds.monitorAlert", tone: "danger" },
  "monitor.recovered": { i18nKey: "mobile.inbox.kinds.monitorRecovered", tone: "ok" },
  "job.pr_opened": { i18nKey: "mobile.inbox.kinds.prOpened", tone: "muted" },
  "review.completed": { i18nKey: "mobile.inbox.kinds.reviewCompleted", tone: "muted" },
  "job.awaiting_input": { i18nKey: "mobile.inbox.kinds.awaitingInput", tone: "signal" },
  "project.pulse": { i18nKey: "mobile.inbox.kinds.pulse", tone: "signal" },
};

export interface InfoCardProps {
  item: Reader<InboxItem>;
  projectName?: string;
}

/**
 * Catch-all: ogni kind senza una variante bespoke (`ticket.created`,
 * `job.pr_closed`, `job.held`, `docs.limit_paused`, `monitor.*`…) e un kind
 * ignoto (`Reader<>` — un server più nuovo dell'app). Mostra `item.text` più i
 * bottoni che `actions` dichiara davvero (`relaunch`/`open`/`snooze`/`handled`)
 * — quelli che ci sono, non un insieme fisso.
 *
 * ECCEZIONE deliberata: un `job.plan_review`/`job.budget_held` SENZA decisione
 * per chi guarda (l'operatore che vede il piano del maintainer) degrada a
 * pura informazione — "Aspetta un maintainer.", NESSUN bottone, nemmeno
 * rinvia/archivia. Il canvas (`1b`, sezione "In attesa di altri") lo mostra
 * così di proposito: non c'è nulla che questo viewer possa decidere, e
 * offrirgli comunque rinvio/archiviazione aggiungerebbe rumore a una card che
 * esiste solo per dirgli "non tocca a te".
 */
export function InfoCard({ item, projectName }: InfoCardProps) {
  const { t } = useTranslation();
  const relaunch = useRelaunch();
  const snooze = useSnooze();
  const handled = useHandled();
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  const meta = KIND_META[item.kind] ?? { i18nKey: "mobile.inbox.kinds.unknown", tone: "muted" as ColorToken };

  const waitingOnMaintainer = isAdminGatedKind(item.kind) && !hasDecisionAction(item);

  const buttons = [];
  if (!waitingOnMaintainer) {
    if (can(item, "relaunch")) {
      buttons.push({
        key: "relaunch",
        label: t("mobile.inbox.actions.retry"),
        emphasis: true,
        onPress: () => relaunch.mutate({ id: item.id }),
        disabled: relaunch.disabled,
        testID: "info-card-retry",
      });
    }
    if (can(item, "open") && item.url !== undefined) {
      buttons.push({
        key: "open",
        label: t("mobile.inbox.actions.openWork"),
        onPress: () => void Linking.openURL(item.url as string),
        testID: "info-card-open",
      });
    }
    if (can(item, "snooze")) {
      buttons.push({
        key: "snooze",
        label: t("mobile.inbox.actions.snooze"),
        onPress: () => setSnoozeOpen(true),
        testID: "info-card-snooze",
      });
    }
    if (can(item, "handled")) {
      buttons.push({
        key: "handled",
        label: t("mobile.inbox.actions.handled"),
        onPress: () => handled.mutate({ id: item.id }),
        testID: "info-card-handled",
      });
    }
  }

  return (
    <CardShell
      tone={meta.tone}
      kindLabel={t(meta.i18nKey)}
      projectName={projectName}
      createdAt={item.createdAt}
      footer={buttons.length > 0 ? <CardFooter buttons={buttons} /> : undefined}
      errorMessage={waitingOnMaintainer ? null : (relaunch.errorMessage ?? snooze.errorMessage ?? handled.errorMessage)}
      testID="info-card"
    >
      <Text style={styles.text}>{item.text}</Text>
      {waitingOnMaintainer && <Text style={styles.waiting}>{t("mobile.inbox.waitingOnMaintainer")}</Text>}

      <SnoozeSheet
        visible={snoozeOpen}
        onRequestClose={() => setSnoozeOpen(false)}
        onChoose={(until) => {
          setSnoozeOpen(false);
          snooze.mutate({ id: item.id, until });
        }}
        testID="info-card-snooze-sheet"
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
  waiting: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 6,
  },
});
