import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ColorToken } from "../../theme/tokens";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { relativeTimeCompact } from "../../lib/format";

/**
 * Involucro comune delle sei varianti di card d'inbox (canvas `1a`, "Card
 * azionabile — anatomia"): badge di kind (pallino + etichetta mono), progetto
 * e tempo relativo in testata, corpo libero (`children`, diverso per
 * variante), footer opzionale a bottoni separato da un bordo.
 *
 * Non è una delle sei varianti — è l'infrastruttura condivisa che le rende
 * visivamente coerenti, così ciascuna variante scrive solo ciò che la rende
 * diversa (le opzioni del pulse, la domanda, il verdetto della review…) e non
 * ridisegna la card ogni volta.
 */
export interface CardShellProps {
  /** Colore del pallino e dell'etichetta di kind. */
  tone: ColorToken;
  kindLabel: string;
  /** Assente = non risolto (progetto non ancora caricato): la card si mostra senza, mai con un placeholder. */
  projectName?: string;
  createdAt: string;
  children: ReactNode;
  footer?: ReactNode;
  testID?: string;
}

export function CardShell({ tone, kindLabel, projectName, createdAt, children, footer, testID }: CardShellProps) {
  const { t } = useTranslation();
  const relative = relativeTimeCompact(createdAt);
  const timeText =
    relative.kind === "now"
      ? t("mobile.inbox.time.now")
      : t(`mobile.inbox.time.${relative.kind}`, { count: relative.count });

  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.metaRow}>
        {projectName !== undefined ? <Text style={styles.project}>{projectName}</Text> : <View />}
        <Text style={styles.time}>{timeText}</Text>
      </View>
      <View style={styles.kindRow}>
        <View style={[styles.dot, { backgroundColor: colors[tone] }]} />
        <Text style={[styles.kindLabel, { color: colors[tone] }]}>{kindLabel}</Text>
      </View>
      <View style={styles.body}>{children}</View>
      {footer !== undefined ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    overflow: "hidden",
  },
  metaRow: {
    alignItems: "baseline",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  project: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  time: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  kindRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    marginTop: 4,
    paddingHorizontal: 16,
  },
  dot: {
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  kindLabel: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  body: {
    padding: 16,
    paddingTop: 8,
  },
  footer: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
    flexDirection: "row",
  },
});

/** Un bottone del footer di una card: "Rispondi", "Rimanda", "Gestita", "Riprova"… */
export interface FooterButtonSpec {
  key: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** `emphasis` per l'azione primaria della riga (es. "Rispondi", "Riprova"), default per il resto. */
  emphasis?: boolean;
  testID?: string;
}

/**
 * Riga di bottoni in coda a una card, coi separatori verticali del canvas
 * (bordo fra un bottone e il successivo, mai dopo l'ultimo). Un componente a
 * sé — e non ripetuto in ciascuna variante — perché il separatore "fra i
 * bottoni ma non dopo l'ultimo" è l'unico punto scomodo da ricostruire a mano
 * in React Native (niente `:not(:last-child)`).
 */
export function CardFooter({ buttons }: { buttons: FooterButtonSpec[] }) {
  return (
    <>
      {buttons.map((button, index) => (
        <Pressable
          key={button.key}
          accessibilityRole="button"
          accessibilityState={{ disabled: button.disabled ?? false }}
          disabled={button.disabled}
          onPress={button.onPress}
          testID={button.testID}
          style={({ pressed }) => [
            footerButtonStyles.base,
            index > 0 && footerButtonStyles.separator,
            button.disabled === true && footerButtonStyles.disabled,
            pressed && button.disabled !== true && footerButtonStyles.pressed,
          ]}
        >
          <Text
            style={[
              footerButtonStyles.label,
              button.emphasis === true ? footerButtonStyles.labelEmphasis : footerButtonStyles.labelDefault,
            ]}
          >
            {button.label}
          </Text>
        </Pressable>
      ))}
    </>
  );
}

const footerButtonStyles = StyleSheet.create({
  base: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 6,
  },
  separator: {
    borderLeftColor: colors.line,
    borderLeftWidth: 1,
  },
  pressed: {
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  disabled: {
    opacity: 0.45,
  },
  label: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 1,
    textAlign: "center",
    textTransform: "uppercase",
  },
  labelDefault: {
    color: colors.muted,
  },
  labelEmphasis: {
    color: colors.signal,
    fontWeight: "600",
  },
});
