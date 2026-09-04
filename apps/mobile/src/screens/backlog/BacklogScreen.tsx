import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { BacklogItem, Reader } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { BacklogStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { PrimaryButton } from "../../components/PrimaryButton";
import { PulseIndicator } from "../../components/PulseIndicator";
import { Skeleton } from "../../components/Skeleton";
import {
  backlogMetaParts,
  backlogStatusLabelKey,
  backlogStatusTone,
  navigateToTicketWork,
  useBacklogList,
  useConvertBacklogItem,
  type BacklogChip,
} from "../../lib/backlog-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { CaptureSheet } from "./CaptureSheet";

const CHIPS: { chip: BacklogChip; i18nKey: string }[] = [
  { chip: "active", i18nKey: "mobile.backlog.chips.active" },
  { chip: "ready", i18nKey: "mobile.backlog.chips.ready" },
  { chip: "all", i18nKey: "mobile.backlog.chips.all" },
];

/** Quanto resta visibile il toast «Aggiunta al backlog» (canvas `3b`) prima di sparire da solo. */
const TOAST_DURATION_MS = 3000;

/**
 * Schermata Backlog (canvas `3a`): lista con chip Attivi/Pronti/Tutti, "Procedi"
 * sulle voci pronte, "Raffina in chat" ovunque tranne convertite/archiviate, FAB
 * "+" per la cattura rapida.
 *
 * Le card NON sono un `Pressable` unico verso un "dettaglio" (a differenza di
 * `PulseRow`/`WorkScreen`): stesso principio di `CardShell` in
 * `components/inbox/` (che è una `View`, non un `Pressable`, coi bottoni del
 * footer come unica superficie di tap) — annidare un `Pressable` (Procedi/
 * Raffina) dentro un altro non ha precedenti in questa codebase, e la card
 * stessa ha già le sue azioni esplicite. Le uniche card SENZA azioni proprie —
 * `converted`/`archived`, raggiungibili solo dal chip "Tutti" — sono
 * l'eccezione: lì la card intera è cliccabile verso `BacklogItemScreen` (sola
 * lettura, coi ticket collegati).
 */
export function BacklogScreen({ navigation }: NativeStackScreenProps<BacklogStackParamList, "List">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const [chip, setChip] = useState<BacklogChip>("active");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const query = useBacklogList(chip);
  const convert = useConvertBacklogItem();

  const projectsQuery = useQuery({
    queryKey: ["projects", "list"],
    queryFn: () => {
      if (!client) throw new Error("BacklogScreen richiede un client autenticato");
      return client.projects.list();
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  function handleProceed(id: string): void {
    convert.mutate(id, {
      onSuccess: (result) => navigateToTicketWork(navigation, result.ticketId),
    });
  }

  function handleCaptured(): void {
    setCaptureOpen(false);
    setToast(t("mobile.backlog.capture.toast"));
  }

  const projects = projectsQuery.data ?? [];
  const items = query.data ?? [];

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>{t("mobile.tabs.backlog")}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("mobile.backlog.fab.add")}
            accessibilityState={{ disabled: projects.length === 0 }}
            disabled={projects.length === 0}
            onPress={() => setCaptureOpen(true)}
            style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed, projects.length === 0 && styles.addButtonDisabled]}
            testID="backlog-add"
          >
            <Text style={styles.addButtonLabel}>+</Text>
          </Pressable>
        </View>

        <View style={styles.chipsRow}>
          {CHIPS.map((option) => {
            const active = chip === option.chip;
            return (
              <Pressable
                key={option.chip}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setChip(option.chip)}
                style={[styles.chip, active && styles.chipActive]}
                testID={`backlog-chip-${option.chip}`}
              >
                <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{t(option.i18nKey)}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {toast !== null && (
        <View style={styles.toast} testID="backlog-toast">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

      {query.isPending ? (
        <View style={styles.skeletonList} testID="backlog-skeleton">
          <Skeleton height={90} />
          <Skeleton height={90} />
          <Skeleton height={90} />
        </View>
      ) : query.isError ? (
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>{t("mobile.backlog.loadError.title")}</Text>
          <GhostButton label={t("mobile.backlog.loadError.retry")} onPress={() => void query.refetch()} testID="backlog-retry" />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.centered} testID="backlog-empty">
          <Text style={styles.emptyTitle}>{t("mobile.backlog.empty.title")}</Text>
          <Text style={styles.emptyBody}>{t("mobile.backlog.empty.body")}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {items.map((item) => (
            <BacklogListCard
              key={item.id}
              item={item}
              proceedPending={convert.isPending}
              onProceed={() => handleProceed(item.id)}
              onRefine={() => navigation.navigate("Chat", { id: item.id })}
              onOpenDetail={() => navigation.navigate("Item", { id: item.id })}
            />
          ))}
        </ScrollView>
      )}

      {convert.errorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.convertError} testID="backlog-convert-error">
          {convert.errorMessage}
        </Text>
      )}

      <CaptureSheet
        visible={captureOpen}
        onRequestClose={() => setCaptureOpen(false)}
        projects={projects.map((project) => ({ id: project.id, name: project.name }))}
        onSubmitted={handleCaptured}
      />
    </View>
  );
}

interface BacklogListCardProps {
  item: Reader<BacklogItem>;
  proceedPending: boolean;
  onProceed: () => void;
  onRefine: () => void;
  onOpenDetail: () => void;
}

function BacklogListCard({ item, proceedPending, onProceed, onRefine, onOpenDetail }: BacklogListCardProps) {
  const { t } = useTranslation();
  const metaText = backlogMetaParts(item)
    .map((part) => t(part.key, part.params))
    .join(" · ");
  const isReady = item.status === "ready";
  const isClosed = item.status === "converted" || item.status === "archived";

  const content = (
    <>
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {item.title}
        </Text>
        <PulseIndicator tone={backlogStatusTone(item.status)} text={t(backlogStatusLabelKey(item.status))} />
      </View>
      <Text style={styles.cardMeta}>{metaText}</Text>
      {!isClosed && (
        <View style={styles.cardActions}>
          {isReady && (
            <View style={styles.proceedButton}>
              <PrimaryButton
                label={t("mobile.backlog.actions.proceed")}
                onPress={onProceed}
                disabled={proceedPending}
                testID={`backlog-proceed-${item.id}`}
              />
            </View>
          )}
          <View style={styles.refineButton}>
            <GhostButton label={t("mobile.backlog.actions.refineInChat")} onPress={onRefine} testID={`backlog-refine-${item.id}`} />
          </View>
        </View>
      )}
    </>
  );

  if (isClosed) {
    return (
      <Pressable onPress={onOpenDetail} style={styles.card} testID={`backlog-card-${item.id}`}>
        {content}
      </Pressable>
    );
  }

  return (
    <View style={styles.card} testID={`backlog-card-${item.id}`}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 56,
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  title: {
    color: colors.fg,
    fontSize: fontSize.title,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  addButton: {
    alignItems: "center",
    borderColor: "#b97d1a",
    borderRadius: radii.control,
    borderWidth: 1,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  addButtonPressed: {
    opacity: 0.7,
  },
  addButtonDisabled: {
    opacity: 0.4,
  },
  addButtonLabel: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 16,
  },
  chipsRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  chip: {
    borderColor: "#2c3641",
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  chipActive: {
    borderColor: "#b97d1a",
  },
  chipLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  chipLabelActive: {
    color: colors.signal,
  },
  toast: {
    backgroundColor: colors.ink900,
    borderColor: colors.signal,
    borderRadius: radii.control,
    borderWidth: 1,
    marginHorizontal: 20,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  toastText: {
    color: colors.fg,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 0.4,
  },
  skeletonList: {
    gap: 8,
    padding: 16,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  errorTitle: {
    color: colors.fg,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  emptyTitle: {
    color: colors.fg,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  emptyBody: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  list: {
    gap: 10,
    padding: 16,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    padding: 14,
  },
  cardTop: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  cardTitle: {
    color: colors.fg,
    flexShrink: 1,
    fontSize: 15,
    fontWeight: "600",
  },
  cardMeta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 6,
  },
  cardActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
  },
  proceedButton: {
    flex: 1.6,
  },
  refineButton: {
    flex: 1,
  },
  convertError: {
    color: colors.danger,
    fontSize: 13,
    marginHorizontal: 20,
    marginTop: 4,
  },
});
