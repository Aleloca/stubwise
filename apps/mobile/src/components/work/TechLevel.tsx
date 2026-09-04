import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

const MAX_LOG_LINES = 50;

/** Le ultime {@link MAX_LOG_LINES} righe di `log` — il resto è nel dettaglio tecnico, non qui. */
function lastLines(log: string, max: number): string {
  const lines = log.split("\n");
  return lines.slice(Math.max(0, lines.length - max)).join("\n");
}

/** Repository toccata dal fix, proiettata sui soli campi che questo componente usa (`ticket.repositories[]`). */
export interface TechLevelRepo {
  repositoryId: string;
  branch: string;
}

export interface TechLevelProps {
  /** Una riga per repository toccata dal fix — vuoto prima dell'esecuzione. */
  repositories: TechLevelRepo[];
  /** `job.log` dell'ultimo job — stringa vuota se il job non ha ancora scritto nulla. */
  log: string;
}

/**
 * "Livello tecnico · solo maintainer" (canvas `2d`): ramo/i + le ULTIME 50
 * righe di log, dietro un toggle collassato di default (stesso pattern di
 * `AIJobTimeline` sul web, `apps/web/src/components/ai-job-timeline.tsx`,
 * `showLog`/`hideLog`).
 *
 * ⚠️ GAP NOTO rispetto al canvas: la riga "costo finora" (`2d`, "$0.84 ·
 * piano forte / esecuzione economica") NON c'è. Il dato esiste lato server
 * (`GET /api/tickets/:id/usage`, `apps/server/src/routes/ai-jobs.ts`, già
 * usato dalla pagina ticket web) ma non è mai stato esposto da
 * `@stubwise/api-client` — il commento su `createTicketsEndpoints`
 * (`packages/api-client/src/endpoints/tickets.ts`) dice esplicitamente che la
 * "storia del lavoro" mobile si ricostruisce da `jobs`+`questions` "senza
 * rotte dedicate": aggiungere qui il wiring di un endpoint in più (schema
 * condiviso + metodo client) è un'estensione additiva legittima ma FUORI dal
 * perimetro di questo task — vedi il report del Task 16. Chi la implementa:
 * additiva pura, nessun campo esistente cambia forma.
 *
 * Chi mostra questo componente (gate ruolo+visibilità) è `WorkScreen`, non
 * questo file.
 */
export function TechLevel({ repositories, log }: TechLevelProps) {
  const { t } = useTranslation();
  const [showLog, setShowLog] = useState(false);
  const trimmedLog = log.trim();
  const hasLog = trimmedLog.length > 0;
  const lineCount = hasLog ? trimmedLog.split("\n").length : 0;

  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>{t("mobile.work.techLevel.title")}</Text>
      <View style={styles.body}>
        {repositories.map((repo, index) => (
          <View
            key={repo.repositoryId}
            style={[styles.row, index === repositories.length - 1 && !hasLog && styles.rowLast]}
          >
            <Text style={styles.rowLabel}>{t("mobile.work.techLevel.branch")}</Text>
            <Text style={styles.rowValue}>{repo.branch}</Text>
          </View>
        ))}

        {!hasLog ? (
          <Text style={styles.noLog}>{t("mobile.work.techLevel.noLog")}</Text>
        ) : (
          <View style={styles.rowLast}>
            <Pressable
              onPress={() => setShowLog((current) => !current)}
              accessibilityRole="button"
              accessibilityState={{ expanded: showLog }}
              style={styles.row}
              testID="tech-level-log-toggle"
            >
              <Text style={styles.rowLabel}>{t(showLog ? "mobile.work.techLevel.hideLog" : "mobile.work.techLevel.showLog")}</Text>
              <Text style={styles.rowValue}>{t("mobile.work.techLevel.logLines", { count: lineCount })}</Text>
            </Pressable>
            {showLog && (
              <ScrollView style={styles.logBox} nestedScrollEnabled>
                <Text style={styles.logText}>{lastLines(trimmedLog, MAX_LOG_LINES)}</Text>
              </ScrollView>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 16,
  },
  eyebrow: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.4,
    marginBottom: 8,
    textTransform: "uppercase",
  },
  body: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    overflow: "hidden",
  },
  row: {
    alignItems: "center",
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  rowValue: {
    color: colors.fg,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  noLog: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    padding: 16,
  },
  logBox: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
    maxHeight: 220,
    padding: 12,
  },
  logText: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    lineHeight: 16,
  },
});
