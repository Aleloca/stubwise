import { isSafeWebUrl } from "@stubwise/shared";
import type { Reader, TicketHistory as TicketHistoryData } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { relativeTimeCompact } from "../../lib/format";
import { historyLineFor } from "../../lib/ticket-history";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Quante righe si vedono prima di «Mostra tutto» (design §2, decisione 4). */
export const HISTORY_PREVIEW = 8;

/**
 * La «Storia del lavoro» VERA del ticket (piano B3): un evento per riga, dal
 * più recente, come lo calcola il server (`GET /api/tickets/:id/history`).
 * Prende il posto della timeline a sei passi fissi, che guardava solo
 * l'ultimo job e non vedeva i giri di correzione.
 *
 * Primi {@link HISTORY_PREVIEW}, poi «Mostra tutto (N)» espande sul posto. N è
 * `total` del server, non la lunghezza dell'elenco: oltre il tetto di 200 il
 * server manda i più recenti, e la riga «Ultimi 200 di N» lo dice.
 *
 * Le righe con una PR sono premibili e la aprono — SOLO un URL http/https,
 * deciso da `isSafeWebUrl` di shared (anche qui, non solo in
 * `historyLineFor`: chi tocca una delle due non toglie la guardia all'altra).
 * Le altre sono testo.
 *
 * `history` assente con `unavailable` = la query è fallita, o il server è più
 * vecchio della rotta (404): la sezione lo dice, e la tab resta intera.
 */
export function TicketHistory({
  history,
  unavailable,
}: {
  history: Reader<TicketHistoryData> | undefined;
  unavailable: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const events = history?.events ?? [];
  const total = history?.total ?? 0;
  const shown = expanded ? events : events.slice(0, HISTORY_PREVIEW);
  const hiddenCount = events.length - shown.length;

  return (
    <View testID="work-history">
      <Text style={styles.title}>{t("mobile.work.history.title")}</Text>

      {history === undefined ? (
        unavailable ? (
          <Text style={styles.empty} testID="work-history-unavailable">
            {t("mobile.work.history.unavailable")}
          </Text>
        ) : null
      ) : events.length === 0 ? (
        <Text style={styles.empty} testID="work-history-empty">
          {t("mobile.work.history.empty")}
        </Text>
      ) : (
        <>
          {shown.map((event, index) => {
            const line = historyLineFor(event, t);
            const relative = relativeTimeCompact(event.at);
            const time =
              relative.kind === "now"
                ? t("mobile.work.time.now")
                : t(`mobile.work.time.${relative.kind}`, { count: relative.count });
            const meta = [line.who, line.pr].filter((part): part is string => part !== null).join(" · ");
            const content = (
              <>
                {index < shown.length - 1 && <View style={styles.rail} />}
                <View style={[styles.dot, { backgroundColor: colors[line.tone] }]} testID={`work-history-dot-${event.id}-${line.tone}`} />
                <View style={styles.headline}>
                  <Text style={styles.label}>{line.title}</Text>
                  <Text style={styles.time}>{time}</Text>
                </View>
                {meta !== "" && <Text style={styles.meta}>{meta}</Text>}
              </>
            );
            const url = line.url;
            return url !== null ? (
              <Pressable
                key={event.id}
                accessibilityRole="button"
                accessibilityHint={t("mobile.work.history.openPr")}
                onPress={() => {
                  if (isSafeWebUrl(url)) void Linking.openURL(url);
                }}
                style={styles.row}
                testID={`work-history-row-${event.id}`}
              >
                {content}
              </Pressable>
            ) : (
              <View key={event.id} style={styles.row} testID={`work-history-row-${event.id}`}>
                {content}
              </View>
            );
          })}
          {hiddenCount > 0 && (
            <Pressable
              accessibilityRole="button"
              onPress={() => setExpanded(true)}
              style={styles.showAll}
              testID="work-history-show-all"
            >
              <Text style={styles.showAllLabel}>{t("mobile.work.history.showAll", { count: total })}</Text>
            </Pressable>
          )}
          {expanded && total > events.length && (
            <Text style={styles.empty} testID="work-history-capped">
              {t("mobile.work.history.capped", { shown: events.length, total })}
            </Text>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  title: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.4,
    marginBottom: 10,
    textTransform: "uppercase",
  },
  empty: {
    color: colors.faint,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
  },
  row: {
    gap: 2,
    paddingBottom: 14,
    paddingLeft: 24,
    position: "relative",
  },
  rail: {
    backgroundColor: colors.line,
    bottom: -2,
    left: 5,
    position: "absolute",
    top: 12,
    width: 1,
  },
  dot: {
    backgroundColor: colors.faint,
    borderRadius: 6,
    height: 11,
    left: 0,
    position: "absolute",
    top: 4,
    width: 11,
  },
  headline: {
    alignItems: "baseline",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  label: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
  },
  time: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  meta: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  showAll: {
    paddingVertical: 6,
  },
  showAllLabel: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
});
