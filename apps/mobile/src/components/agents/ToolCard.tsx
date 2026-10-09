import { describeAgentActivity, isUnknown, type TranscriptItem } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** Oltre questa lunghezza l'input mostrato si tronca: il risultato lo tronca già il worker. */
const MAX_INPUT_CHARS = 4000;

function formatInput(input: unknown): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = typeof input === "string" ? input : (JSON.stringify(input, null, 2) ?? "");
  } catch {
    text = String(input);
  }
  return text.length > MAX_INPUT_CHARS
    ? { text: `${text.slice(0, MAX_INPUT_CHARS)}…`, truncated: true }
    : { text, truncated: false };
}

/**
 * Un'azione dell'agente, compatta (gemella di
 * `apps/web/src/components/agent-session/tool-card.tsx`): la riga dice COSA
 * ha fatto, con la regola dell'«ultima azione» (`describeAgentActivity`) ma
 * all'imperativo — la card può riguardare un'azione finita —, e si apre su
 * input e risultato in monospazio. Un tool senza risultato è «in corso» («…»)
 * solo in una sessione viva: in una conclusa non lo sarà mai.
 */
export function ToolCard({ item, live }: { item: ToolItem; live: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const activity = describeAgentActivity({ type: "tool_use", data: { name: item.name, input: item.input } });
  const kind = isUnknown(activity.kind) ? "unknown" : activity.kind;
  const label = t(`mobile.agents.tool.kind.${kind}`, { target: activity.target ?? "" }).trim();
  // Per `other` il target È il nome: ripeterlo sarebbe rumore.
  const meta = [
    kind === "other" ? null : item.name,
    item.result?.isError ? t("mobile.agents.tool.error") : null,
    item.result === null && live ? "…" : null,
  ]
    .filter((v): v is string => v !== null)
    .join(" · ");
  const input = open ? formatInput(item.input) : null;

  return (
    <View style={styles.card} testID={`tool-card-${item.id}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        style={styles.header}
      >
        <Text style={styles.chevron}>{open ? "▾" : "▸"}</Text>
        <Text style={styles.label} numberOfLines={open ? undefined : 1}>
          {label}
        </Text>
        {meta !== "" && <Text style={styles.meta}>{meta}</Text>}
      </Pressable>
      {input !== null && (
        <View style={styles.body}>
          <Text style={styles.section}>{t("mobile.agents.tool.showInput")}</Text>
          <Text style={styles.mono} selectable>
            {input.text}
          </Text>
          {input.truncated && <Text style={styles.note}>{t("mobile.agents.truncatedInput")}</Text>}
          {item.result !== null && (
            <>
              <Text style={styles.section}>{t("mobile.agents.tool.showResult")}</Text>
              <Text style={[styles.mono, item.result.isError && styles.error]} selectable>
                {item.result.content}
              </Text>
              {item.result.truncated && <Text style={styles.note}>{t("mobile.agents.tool.truncated")}</Text>}
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
  },
  header: { alignItems: "center", flexDirection: "row", gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  chevron: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: fontSize.label },
  label: { color: colors.fg, flexShrink: 1, fontFamily: fontFamily.sans, fontSize: 13 },
  meta: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: fontSize.label, marginLeft: "auto" },
  body: { borderColor: colors.line, borderTopWidth: 1, gap: 4, padding: 10 },
  section: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 0.8,
    marginTop: 4,
    textTransform: "uppercase",
  },
  mono: { color: colors.muted, fontFamily: fontFamily.mono, fontSize: 12 },
  error: { color: colors.danger },
  note: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: fontSize.label },
});
