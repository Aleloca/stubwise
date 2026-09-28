import { isUnknown } from "@stubwise/shared";
import type { ProjectPulseSummary, Reader } from "@stubwise/shared";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PulseIndicator } from "../../../components/PulseIndicator";
import {
  buttonDestination,
  nowIsEmpty,
  othersRows,
  rowDestination,
  yourTurnRows,
  type HubDestination,
  type MonitorAlert,
  type OthersTrailing,
  type YourTurnRow,
} from "../../../lib/project-hub";
import { pulseLineFor } from "../../../lib/pulse-line";
import { ticketPriorityLabel } from "../../../lib/ticket-labels";
import { colors, radii } from "../../../theme/tokens";
import { fontFamily } from "../../../theme/typography";
import { HubBlockLabel, HubCard, HubDot, HubRow, MonitorBanner, hubText } from "./hub-ui";

/**
 * La riga del banner del monitor: «prod-eu-1 · 1 controllo giù», o «· offline»
 * se il server non risponde affatto; con più server giù, quanti altri. Qui e
 * non nel banner perché la usano due tab.
 */
export function monitorLine(alert: MonitorAlert, t: TFunction): string {
  const first = alert.offline
    ? t("mobile.projects.detail.now.monitorOffline", { server: alert.serverName })
    : t("mobile.projects.detail.now.monitorChecks", { server: alert.serverName, count: alert.checksDown });
  const others = alert.brokenCount - 1;
  return others > 0 ? `${first} · ${t("mobile.projects.detail.now.monitorOthers", { count: others })}` : first;
}

function kindLabel(row: YourTurnRow, t: TFunction): string {
  switch (row.kind) {
    case "question":
      return t("mobile.projects.detail.now.kind.question");
    case "plan_approval":
      return t("mobile.projects.detail.now.kind.plan");
    case "merge":
      return t("mobile.projects.detail.now.kind.merge");
    default:
      return t("mobile.projects.detail.now.kind.unknown");
  }
}

function actionLabel(action: NonNullable<YourTurnRow["action"]>, t: TFunction): string {
  return t(`mobile.projects.detail.now.action.${action}`);
}

function othersTrailing(trailing: OthersTrailing, t: TFunction): string {
  switch (trailing.kind) {
    case "who":
      return trailing.who === "maintainer"
        ? t("mobile.projects.detail.now.toMaintainer")
        : t("mobile.projects.detail.now.toRequester");
    case "merge":
      return t("mobile.projects.detail.now.waitingMerge");
    case "stalled":
      return t("mobile.projects.detail.now.stalledDays", { count: trailing.days, reason: t(trailing.reasonKey) });
  }
}

/**
 * TAB «ADESSO» (28 set 2026, dettaglio progetto v3 §4): cosa c'è da fare ORA.
 * Dall'alto, e ogni blocco solo se ha qualcosa: il banner del monitor, «Tocca
 * a te», «In esecuzione», «Aspetta altri · fermi». Tutto vuoto: la frase del
 * polso di sempre, che qui cambia posto invece di sparire.
 *
 * I bottoni di «Tocca a te» portano DOVE SI DECIDE (decisione 1 del
 * maintainer): Rispondi alla card della domanda, Approva al ticket col piano,
 * Mergia alla conferma. Le destinazioni le decide `lib/project-hub.ts`; qui
 * si disegna e si inoltra.
 */
export function NowTab({
  summary,
  viewerId,
  alert,
  now,
  onOpen,
  onGoProject,
}: {
  summary: Reader<ProjectPulseSummary>;
  viewerId: string;
  alert: MonitorAlert | null;
  now: Date;
  onOpen: (destination: HubDestination) => void;
  onGoProject: () => void;
}) {
  const { t } = useTranslation();
  const yours = yourTurnRows(summary);
  const others = othersRows(summary, now);
  const empty = nowIsEmpty(summary);
  const line = pulseLineFor(summary, viewerId);

  return (
    <View style={styles.column}>
      {alert !== null && (
        <MonitorBanner
          eyebrow={t("mobile.projects.detail.now.monitorEyebrow")}
          line={monitorLine(alert, t)}
          onPress={onGoProject}
          testID="hub-now-monitor-banner"
        />
      )}

      {empty && (
        <View testID="hub-now-empty">
          <PulseIndicator tone={line.tone} text={t(line.key, line.params)} />
        </View>
      )}

      {yours.length > 0 && (
        <View style={styles.block} testID="hub-now-your-turn">
          <HubBlockLabel amber text={t("mobile.projects.detail.now.yourTurn", { count: yours.length })} />
          <HubCard>
            {yours.map((row, index) => {
              const destination = buttonDestination(row);
              return (
                <HubRow
                  key={row.key}
                  first={index === 0}
                  onPress={() => onOpen(rowDestination(row))}
                  testID={`hub-now-row-${row.key}`}
                >
                  <View style={styles.rowText}>
                    <Text style={hubText.meta} numberOfLines={1}>
                      {`#${row.ticketNumber}`}
                      {row.priority !== undefined && (
                        <>
                          {" · "}
                          <Text
                            style={!isUnknown(row.priority) && row.priority === "urgent" ? styles.urgent : undefined}
                          >
                            {ticketPriorityLabel(row.priority, t)}
                          </Text>
                        </>
                      )}
                      {` · ${kindLabel(row, t)}`}
                    </Text>
                    <Text style={hubText.title} numberOfLines={1}>
                      {row.title}
                    </Text>
                  </View>
                  {row.action !== null && destination !== null && (
                    <Pressable
                      accessibilityRole="button"
                      hitSlop={6}
                      onPress={() => onOpen(destination)}
                      style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
                      testID={`hub-now-action-${row.key}`}
                    >
                      <Text style={styles.actionLabel}>{actionLabel(row.action, t)}</Text>
                    </Pressable>
                  )}
                </HubRow>
              );
            })}
          </HubCard>
        </View>
      )}

      {summary.running.length > 0 && (
        <View style={styles.block} testID="hub-now-running">
          <HubBlockLabel text={t("mobile.projects.detail.now.running", { count: summary.running.length })} />
          <HubCard>
            {summary.running.map((item, index) => (
              <HubRow
                key={item.ticketId}
                first={index === 0}
                onPress={() => onOpen(rowDestination(item))}
                testID={`hub-now-running-${item.ticketId}`}
              >
                <HubDot color={colors.sky} />
                <Text style={[hubText.title, styles.grow]} numberOfLines={1}>
                  {`#${item.ticketNumber} ${item.title}`}
                </Text>
                <Text style={[hubText.trailing, styles.sky]}>
                  {t("mobile.projects.detail.now.sinceMinutes", { count: item.sinceMinutes })}
                </Text>
              </HubRow>
            ))}
          </HubCard>
        </View>
      )}

      {others.length > 0 && (
        <View style={styles.block} testID="hub-now-others">
          <HubBlockLabel text={t("mobile.projects.detail.now.others", { count: others.length })} />
          <HubCard>
            {others.map((row, index) => (
              <HubRow
                key={row.key}
                first={index === 0}
                onPress={() => onOpen(rowDestination(row))}
                testID={`hub-now-other-${row.key}`}
              >
                <Text style={[hubText.title, styles.grow]} numberOfLines={1}>
                  {`#${row.ticketNumber} ${row.title}`}
                </Text>
                <Text style={hubText.trailing}>{othersTrailing(row.trailing, t)}</Text>
              </HubRow>
            ))}
          </HubCard>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    gap: 24,
  },
  block: {
    gap: 8,
  },
  rowText: {
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  urgent: {
    color: colors.danger,
  },
  sky: {
    color: colors.sky,
  },
  action: {
    borderColor: colors.signalDim,
    borderRadius: radii.control,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  actionPressed: {
    backgroundColor: colors.ink850,
  },
  actionLabel: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
});
