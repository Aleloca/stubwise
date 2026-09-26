import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { isUnknown } from "@stubwise/shared";
import type { ProjectDetail, Reader } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { AppSwitch } from "../../components/AppSwitch";
import { GhostButton } from "../../components/GhostButton";
import { PrimaryButton } from "../../components/PrimaryButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SectionLabel } from "../../components/SectionLabel";
import { Skeleton } from "../../components/Skeleton";
import {
  PULSE_DAYS_MAX,
  PULSE_DAYS_MIN,
  effectiveSettings,
  pulseValue,
  settingsErrorKey,
  settingsInvalid,
  settingsPatch,
  type ProjectSettingsEdits,
  type ProjectSettingsValues,
} from "../../lib/project-settings";
import { projectKeys } from "../../lib/query-keys";
import { colors, radii } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";
import { usePullToRefresh } from "../../components/PullToRefresh";
import { KEYBOARD_AWARE_SCROLL_PROPS } from "../../lib/keyboard";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * LE IMPOSTAZIONI DI UN PROGETTO (23 set 2026, hub di progetto, tappa 3).
 *
 * **La regola è quella del web, e non si reinventa**: un maintainer modifica,
 * un operatore legge — con la stessa riga che spiega perché. Il gate VERO è
 * sul server (`PATCH /api/projects/:projectId` è `requireAdmin`): l'app mostra
 * il form solo a chi quel gate lo passa, e un 403 che arrivasse lo stesso si
 * MOSTRA, non si ingoia.
 *
 * Legge dalla STESSA query della sezione repository dell'hub
 * (`projectKeys.detail`): entrarci non costa una richiesta in più, e il
 * salvataggio che la invalida aggiorna anche l'hub sotto.
 */
export function ProjectSettingsScreen({
  navigation,
  route,
}: NativeStackScreenProps<ProjectsStackParamList, "ProjectSettings">) {
  const { t } = useTranslation();
  const { client, user } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { projectId, projectName } = route.params;

  const query = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => {
      if (!client) throw new Error("ProjectSettingsScreen richiede un client autenticato");
      return client.projects.get(projectId);
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  // Stessa forma di `WorkScreen`: un ruolo che questa build non conosce NON
  // è admin. L'errore in questa direzione costa un form nascosto a chi poteva
  // usarlo; quello opposto un form che il server rifiuterebbe.
  const isAdmin = user !== null && !isUnknown(user.role) && user.role === "admin";

  const refreshControl = usePullToRefresh([projectKeys.detail(projectId)], "project-settings-refresh");

  return (
    <View style={styles.container}>
      <ScrollView
        {...KEYBOARD_AWARE_SCROLL_PROPS}
        refreshControl={refreshControl}
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
        testID="keyboard-aware-scroll"
      >
        <ScreenHeader
          title={t("mobile.projects.settings.title")}
          subtitle={projectName}
          onBack={() => navigation.goBack()}
          backLabel={projectName}
        />

        {query.isPending ? (
          <View style={styles.skeletonList} testID="project-settings-skeleton">
            <Skeleton height={120} />
            <Skeleton height={200} />
          </View>
        ) : query.isError ? (
          <View style={styles.centered} testID="project-settings-error">
            <Text style={styles.errorTitle}>{t("mobile.projects.settings.loadError.title")}</Text>
            <GhostButton
              label={t("mobile.projects.settings.loadError.retry")}
              onPress={() => void query.refetch()}
              testID="project-settings-retry"
            />
          </View>
        ) : query.data === undefined ? null : isAdmin ? (
          // `key` sul progetto: le modifiche locali appartengono a QUESTO
          // progetto, e non devono sopravvivere a un cambio di identità.
          <SettingsForm key={query.data.id} project={query.data} />
        ) : (
          <SettingsReadOnly project={query.data} />
        )}
      </ScrollView>
    </View>
  );
}

function valuesOf(project: Reader<ProjectDetail>): ProjectSettingsValues {
  return {
    name: project.name,
    description: project.description,
    docAutoUpdate: project.docAutoUpdate,
    dailyReportEnabled: project.dailyReportEnabled,
    backlogEnabled: project.backlogEnabled,
    pulseEnabled: project.pulseEnabled,
    pulseEveryDays: project.pulseEveryDays,
    weeklyBriefEnabled: project.weeklyBriefEnabled,
  };
}

function onOff(value: boolean, t: (key: string) => string): string {
  return value ? t("mobile.projects.settings.on") : t("mobile.projects.settings.off");
}

/** Operatore: i valori, e la riga che dice perché non si modificano da qui. */
function SettingsReadOnly({ project }: { project: Reader<ProjectDetail> }) {
  const { t } = useTranslation();
  const values = valuesOf(project);
  const pulse = pulseValue(values);

  return (
    <>
      <View style={styles.card}>
        <ReadField label={t("mobile.projects.settings.fields.name")} value={values.name} />
        <ReadField
          label={t("mobile.projects.settings.fields.description")}
          value={values.description ?? t("mobile.projects.settings.noDescription")}
        />
        <ReadField label={t("mobile.projects.settings.fields.docAutoUpdate")} value={onOff(values.docAutoUpdate, t)} />
        <ReadField label={t("mobile.projects.settings.fields.dailyReport")} value={onOff(values.dailyReportEnabled, t)} />
        <ReadField label={t("mobile.projects.settings.fields.backlog")} value={onOff(values.backlogEnabled, t)} />
        <ReadField
          label={t("mobile.projects.settings.fields.pulse")}
          value={pulse.key === "mobile.projects.settings.pulseEvery" ? t(pulse.key, { count: pulse.count }) : t(pulse.key)}
          testID="project-settings-pulse-value"
        />
        <ReadField
          label={t("mobile.projects.settings.fields.weeklyBrief")}
          value={onOff(values.weeklyBriefEnabled, t)}
          last
        />
      </View>
      <Text style={styles.hint} testID="project-settings-read-only-hint">
        {t("mobile.projects.settings.readOnlyHint")}
      </Text>
    </>
  );
}

/** Maintainer: il form. Tiene solo le MODIFICHE, non una copia del progetto. */
function SettingsForm({ project }: { project: Reader<ProjectDetail> }) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<ProjectSettingsEdits>({});
  const [saved, setSaved] = useState(false);

  const server = valuesOf(project);
  const values = effectiveSettings(server, edits);
  const patch = settingsPatch(server, edits);
  const dirty = Object.keys(patch).length > 0;
  const invalid = settingsInvalid(values);
  // Stessa regola del form web: il pulse si accende solo col backlog — e
  // guarda il valore CORRENTE del form, così chi accende il backlog adesso può
  // accendere il pulse nello stesso passaggio.
  const pulseAvailable = values.backlogEnabled;

  const mutation = useMutation({
    mutationFn: () => {
      if (!client) throw new Error("SettingsForm richiede un client autenticato");
      return client.projects.patch(project.id, patch);
    },
    onSuccess: async () => {
      setEdits({});
      setSaved(true);
      // ⚠️ Tutto il prefisso `["projects"]`: il dettaglio (questa schermata e
      // la sezione repository/impostazioni dell'hub), il polso (nome del
      // progetto nell'hub e nella lista) e la lista. Un nome cambiato qui e
      // rimasto vecchio nell'hub montato sotto — l'app non ha
      // refetch-on-focus — sarebbe esattamente il difetto dei prefissi.
      await queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });

  function edit(next: ProjectSettingsEdits) {
    setSaved(false);
    mutation.reset();
    setEdits((current) => ({ ...current, ...next }));
  }

  return (
    <>
      <SectionLabel>{t("mobile.projects.settings.sections.identity")}</SectionLabel>
      <View style={[styles.card, styles.cardPadded]}>
        <Text style={styles.fieldLabel}>{t("mobile.projects.settings.fields.name")}</Text>
        <TextInput
          accessibilityLabel={t("mobile.projects.settings.fields.name")}
          value={values.name}
          onChangeText={(name) => edit({ name })}
          style={styles.input}
          placeholderTextColor={colors.faint}
          testID="project-settings-name"
        />
        <Text style={styles.fieldLabel}>{t("mobile.projects.settings.fields.description")}</Text>
        <TextInput
          accessibilityLabel={t("mobile.projects.settings.fields.description")}
          value={values.description ?? ""}
          onChangeText={(description) => edit({ description })}
          placeholder={t("mobile.projects.settings.noDescription")}
          placeholderTextColor={colors.faint}
          multiline
          style={[styles.input, styles.inputMultiline]}
          testID="project-settings-description"
        />
        {invalid && <Text style={styles.errorText}>{t("mobile.projects.settings.nameRequired")}</Text>}
      </View>

      <SectionLabel style={styles.sectionLabel}>{t("mobile.projects.settings.sections.automations")}</SectionLabel>
      <View style={styles.card}>
        <ToggleRow
          label={t("mobile.projects.settings.fields.docAutoUpdate")}
          hint={t("mobile.projects.settings.hints.docAutoUpdate")}
          value={values.docAutoUpdate}
          onChange={(docAutoUpdate) => edit({ docAutoUpdate })}
          testID="project-settings-doc-auto-update"
        />
        <ToggleRow
          label={t("mobile.projects.settings.fields.dailyReport")}
          hint={t("mobile.projects.settings.hints.dailyReport")}
          value={values.dailyReportEnabled}
          onChange={(dailyReportEnabled) => edit({ dailyReportEnabled })}
          testID="project-settings-daily-report"
        />
        <ToggleRow
          label={t("mobile.projects.settings.fields.backlog")}
          hint={t("mobile.projects.settings.hints.backlog")}
          value={values.backlogEnabled}
          onChange={(backlogEnabled) => edit({ backlogEnabled })}
          testID="project-settings-backlog"
        />
        <ToggleRow
          label={t("mobile.projects.settings.fields.pulse")}
          hint={pulseAvailable ? t("mobile.projects.settings.hints.pulse") : t("mobile.projects.settings.pulseNeedsBacklog")}
          value={values.pulseEnabled}
          disabled={!pulseAvailable}
          onChange={(pulseEnabled) => edit({ pulseEnabled })}
          testID="project-settings-pulse"
        />
        <View style={[styles.stepperRow, styles.rowBorder]}>
          <Text style={[styles.toggleLabel, !pulseAvailable && styles.disabledText]}>
            {t("mobile.projects.settings.fields.pulseEveryDays")}
          </Text>
          <View style={styles.stepper}>
            <StepButton
              label="−"
              disabled={!pulseAvailable || values.pulseEveryDays <= PULSE_DAYS_MIN}
              onPress={() => edit({ pulseEveryDays: values.pulseEveryDays - 1 })}
              testID="project-settings-pulse-days-minus"
            />
            <Text style={[styles.stepperValue, !pulseAvailable && styles.disabledText]} testID="project-settings-pulse-days">
              {values.pulseEveryDays}
            </Text>
            <StepButton
              label="+"
              disabled={!pulseAvailable || values.pulseEveryDays >= PULSE_DAYS_MAX}
              onPress={() => edit({ pulseEveryDays: values.pulseEveryDays + 1 })}
              testID="project-settings-pulse-days-plus"
            />
          </View>
        </View>
        <ToggleRow
          label={t("mobile.projects.settings.fields.weeklyBrief")}
          hint={t("mobile.projects.settings.hints.weeklyBrief")}
          value={values.weeklyBriefEnabled}
          onChange={(weeklyBriefEnabled) => edit({ weeklyBriefEnabled })}
          testID="project-settings-weekly-brief"
          last
        />
      </View>

      <View style={styles.actions}>
        <PrimaryButton
          label={mutation.isPending ? t("mobile.projects.settings.saving") : t("mobile.projects.settings.save")}
          onPress={() => mutation.mutate()}
          disabled={!dirty || invalid || mutation.isPending}
          testID="project-settings-save"
        />
        {mutation.isError && (
          <Text accessibilityLiveRegion="polite" style={styles.errorText} testID="project-settings-save-error">
            {t(settingsErrorKey(mutation.error))}
          </Text>
        )}
        {saved && !dirty && (
          <Text accessibilityLiveRegion="polite" style={styles.savedText} testID="project-settings-saved">
            {t("mobile.projects.settings.saved")}
          </Text>
        )}
      </View>
    </>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
  disabled = false,
  last = false,
  testID,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  last?: boolean;
  testID: string;
}) {
  return (
    <View style={[styles.toggleRow, !last && styles.rowBorder]}>
      <View style={styles.toggleText}>
        <Text style={[styles.toggleLabel, disabled && styles.disabledText]}>{label}</Text>
        <Text style={styles.toggleHint}>{hint}</Text>
      </View>
      <AppSwitch
        accessibilityLabel={label}
        disabled={disabled}
        onValueChange={onChange}
        value={value}
        testID={testID}
      />
    </View>
  );
}

function StepButton({
  label,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.stepButton, disabled && styles.stepButtonDisabled]}
      testID={testID}
    >
      <Text style={styles.stepButtonLabel}>{label}</Text>
    </Pressable>
  );
}

function ReadField({
  label,
  value,
  last = false,
  testID,
}: {
  label: string;
  value: string;
  last?: boolean;
  testID?: string;
}) {
  return (
    <View style={[styles.field, !last && styles.rowBorder]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  body: {
    gap: 8,
    padding: 16,
    paddingBottom: 40,
  },
  sectionLabel: {
    marginTop: 8,
  },
  skeletonList: {
    gap: 12,
  },
  centered: {
    alignItems: "center",
    gap: 12,
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 40,
  },
  errorTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    overflow: "hidden",
  },
  cardPadded: {
    gap: 6,
    padding: 14,
  },
  field: {
    gap: 3,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowBorder: {
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  fieldLabel: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
  fieldValue: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  input: {
    backgroundColor: colors.ink950,
    borderColor: colors.lineStrong,
    borderRadius: radii.card,
    borderWidth: 1,
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inputMultiline: {
    minHeight: 72,
    textAlignVertical: "top",
  },
  toggleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  toggleText: {
    flex: 1,
    gap: 3,
  },
  toggleLabel: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  toggleHint: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    lineHeight: 15,
  },
  disabledText: {
    color: colors.faint,
  },
  stepperRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  stepper: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  stepButton: {
    alignItems: "center",
    borderColor: colors.lineStrong,
    borderRadius: radii.card,
    borderWidth: 1,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  stepButtonDisabled: {
    opacity: 0.4,
  },
  stepButtonLabel: {
    color: colors.fg,
    fontFamily: fontFamily.mono,
    fontSize: 18,
  },
  stepperValue: {
    color: colors.fg,
    fontFamily: fontFamily.mono,
    fontSize: 16,
    minWidth: 24,
    textAlign: "center",
  },
  actions: {
    gap: 8,
    marginTop: 12,
  },
  errorText: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 13,
  },
  savedText: {
    color: colors.ok,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  hint: {
    color: colors.faint,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
});
