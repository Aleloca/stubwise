import type { AgentSessionSummary, Reader } from "@stubwise/shared";
import { elapsedParts, isUnknown } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { relativeTimeAgo } from "../../lib/format";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

export type SessionRowData = Reader<AgentSessionSummary>;

/** Chiave del catalogo per un valore di enum aperto da `readerSchema`: l'ignoto ha la sua voce. */
function key(value: string): string {
  return isUnknown(value) ? "unknown" : value;
}

/**
 * Una riga dell'elenco AGT. Gemella di `components/agent-session/session-row.tsx`
 * del web: la durata («da X») la conta il CLIENT da `startedAt`, solo per le
 * vive; le concluse mostrano esito e quando. `lastActivity`/`outcome` si
 * difendono con `?? null`: un server più vecchio non li manda.
 */
export function SessionRow({
  session,
  now,
  live,
  onPress,
}: {
  session: SessionRowData;
  now: number;
  live: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const activity = session.lastActivity ?? null;
  const outcome = session.outcome ?? null;
  const elapsed = elapsedParts(session.startedAt, now);
  const when = relativeTimeAgo(session.lastEventAt ?? session.startedAt, t, now);

  const status = live ? t(`mobile.agents.state.${key(session.state)}`) : outcome ? t(`mobile.agents.outcome.${key(outcome)}`) : null;
  const time = live
    ? elapsed.hours > 0
      ? t("mobile.agents.elapsed", { hours: elapsed.hours, minutes: elapsed.minutes })
      : t("mobile.agents.elapsedMinutes", { minutes: elapsed.minutes })
    : when;

  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.row} testID={`agent-row-${session.id}`}>
      <View style={styles.top}>
        <Text style={styles.kind}>{t(`mobile.agents.kind.${key(session.kind)}`)}</Text>
        <Text style={styles.project} numberOfLines={1}>
          {session.projectName ?? ""}
          {session.ticketNumber !== null ? ` #${session.ticketNumber}` : ""}
        </Text>
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {session.title}
      </Text>
      <View style={styles.meta}>
        {status !== null && <Text style={styles.metaText}>{status}</Text>}
        {time !== null && <Text style={styles.metaText}>{time}</Text>}
      </View>
      {live && (
        <Text style={styles.activity} numberOfLines={1}>
          {activity
            ? t(`mobile.agents.activity.${key(activity.kind)}`, { target: activity.target ?? "" })
            : t("mobile.agents.activity.none")}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    gap: 4,
    padding: 12,
  },
  top: { alignItems: "center", flexDirection: "row", gap: 8 },
  kind: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  project: { color: colors.muted, flexShrink: 1, fontFamily: fontFamily.sans, fontSize: 12 },
  title: { color: colors.fg, fontFamily: fontFamily.sans, fontSize: 14 },
  meta: { flexDirection: "row", gap: 10 },
  metaText: { color: colors.muted, fontFamily: fontFamily.sans, fontSize: 12 },
  activity: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: fontSize.label },
});
