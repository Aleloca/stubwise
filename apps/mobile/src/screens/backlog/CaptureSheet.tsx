import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { GhostButton } from "../../components/GhostButton";
import { PrimaryButton } from "../../components/PrimaryButton";
import { useCreateBacklogItem } from "../../lib/backlog-mutations";
import { getLastBacklogProjectId, setLastBacklogProjectId } from "../../lib/storage";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

export interface CaptureSheetProject {
  id: string;
  name: string;
}

export interface CaptureSheetProps {
  visible: boolean;
  onRequestClose: () => void;
  /** Progetti disponibili — il chiamante (`BacklogScreen`) li ha già caricati. */
  projects: CaptureSheetProject[];
  /** Chiamato dopo una `create` riuscita: il chiamante chiude la sheet e mostra il toast. */
  onSubmitted: () => void;
  testID?: string;
}

/**
 * Sheet di cattura rapida (canvas `3b`): UN campo di testo libero, non
 * titolo+descrizione separati come `NewBacklogItemDialog` sul web
 * (`apps/web/src/components/new-backlog-item-dialog.tsx`) — coerente col
 * mockup, che mostra un solo textarea. Il server
 * (`createBacklogItemSchema`) vuole comunque `title` E `body` non vuoti:
 * questa sheet deriva `title` dal testo (troncato a 300 caratteri, il tetto
 * del campo) e manda l'INTERO testo come `body` — il worker di intake
 * (`kind: "intake"`) rielabora comunque tutto (dedup, metadati suggeriti), la
 * cattura rapida è volutamente grezza.
 *
 * Nessuna dettatura vocale ("Tieni premuto per dettare" nel canvas): fuori
 * scope per questo task (nessuna API microfono nell'app), copy non
 * implementata di proposito — vedi il report del Task 17.
 *
 * Il picker progetto è una lista inline che si apre/chiude sotto la pillola
 * (non un secondo `Modal` annidato, più fragile da testare) e preseleziona
 * l'ULTIMO progetto usato in questa sheet (`getLastBacklogProjectId`,
 * `lib/storage.ts`, AsyncStorage — sopravvive a un riavvio dell'app), o il
 * primo progetto della lista se non c'è ancora uno storico o quello salvato
 * non esiste più.
 *
 * A differenza di `RejectSheet`/`QuestionSheet` (mutazione posseduta dallo
 * screen, questa sheet puramente presentazionale), qui la mutazione
 * (`useCreateBacklogItem`) vive DENTRO la sheet: il picker e la persistenza
 * "ultimo usato" sono già effetti locali alla sheet, tenerli separati dalla
 * mutazione avrebbe solo spostato stato correlato in due posti.
 */
export function CaptureSheet({ visible, onRequestClose, projects, onSubmitted, testID }: CaptureSheetProps) {
  const { t } = useTranslation();
  const create = useCreateBacklogItem();
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const wasVisible = useRef(false);

  useEffect(() => {
    if (visible && !wasVisible.current) {
      setText("");
      setPickerOpen(false);
      create.reset();
      void (async () => {
        const last = await getLastBacklogProjectId();
        setProjectId(last !== null && projects.some((project) => project.id === last) ? last : (projects[0]?.id ?? ""));
      })();
    }
    wasVisible.current = visible;
    // Solo `visible` decide quando (ri)partire: `projects`/`create` sono letti
    // dalla chiusura del render corrente, stesso pattern minimale di
    // `QuestionSheet` (`[visible, question.questionId]`, non ogni prop usata).
  }, [visible]);

  const canSubmit = text.trim().length > 0 && projectId !== "";
  const selectedProject = projects.find((project) => project.id === projectId);

  function submit(): void {
    if (!canSubmit || create.disabled) return;
    const trimmed = text.trim();
    const submittedProjectId = projectId;
    create.mutate(
      { projectId: submittedProjectId, title: trimmed.slice(0, 300), body: trimmed },
      {
        onSuccess: () => {
          void setLastBacklogProjectId(submittedProjectId);
          onSubmitted();
        },
      },
    );
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onRequestClose} testID={testID}>
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onRequestClose}
          accessibilityLabel={t("mobile.backlog.capture.cancel")}
        />
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <ScrollView keyboardShouldPersistTaps="handled">
            <View style={styles.headerRow}>
              <Text style={styles.title}>{t("mobile.backlog.capture.title")}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("mobile.backlog.capture.projectPickerLabel")}
                onPress={() => setPickerOpen((open) => !open)}
                style={styles.projectPill}
                testID="capture-sheet-project-toggle"
              >
                <Text style={styles.projectPillLabel}>{selectedProject ? `${selectedProject.name} ▾` : "— ▾"}</Text>
              </Pressable>
            </View>

            {pickerOpen && (
              <View style={styles.projectList} testID="capture-sheet-project-list">
                {projects.map((project) => (
                  <Pressable
                    key={project.id}
                    accessibilityRole="button"
                    onPress={() => {
                      setProjectId(project.id);
                      setPickerOpen(false);
                    }}
                    style={styles.projectOption}
                    testID={`capture-sheet-project-${project.id}`}
                  >
                    <Text style={styles.projectOptionLabel}>{project.name}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            <TextInput
              accessibilityLabel={t("mobile.backlog.capture.title")}
              value={text}
              onChangeText={setText}
              editable={!create.disabled}
              multiline
              placeholder={t("mobile.backlog.capture.placeholder")}
              placeholderTextColor={colors.faint}
              style={styles.input}
              testID="capture-sheet-input"
            />

            {projects.length === 0 && <Text style={styles.notice}>{t("mobile.backlog.capture.noProjects")}</Text>}
            {!create.online && <Text style={styles.notice}>{t("mobile.backlog.offlineAction")}</Text>}
            {create.errorMessage !== null && (
              <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                {create.errorMessage}
              </Text>
            )}

            <View style={styles.actions}>
              <View style={styles.primaryButton}>
                <PrimaryButton
                  label={create.online ? t("mobile.backlog.capture.submit") : t("mobile.backlog.offlineAction")}
                  onPress={submit}
                  disabled={!canSubmit || create.disabled}
                  testID="capture-sheet-submit"
                />
              </View>
              <View style={styles.secondaryButton}>
                <GhostButton label={t("mobile.backlog.capture.cancel")} onPress={onRequestClose} testID="capture-sheet-cancel" />
              </View>
            </View>

            <Text style={styles.hint}>{t("mobile.backlog.capture.hint")}</Text>
          </ScrollView>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(5,7,10,0.7)",
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    maxHeight: "85%",
    paddingBottom: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  handle: {
    alignSelf: "center",
    backgroundColor: "#2c3641",
    borderRadius: 2,
    height: 4,
    marginBottom: 16,
    width: 36,
  },
  headerRow: {
    alignItems: "baseline",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  title: {
    color: colors.fg,
    fontSize: 18,
    fontWeight: "700",
  },
  projectPill: {
    borderColor: "#2c3641",
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  projectPillLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
  projectList: {
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    marginTop: 8,
    overflow: "hidden",
  },
  projectOption: {
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  projectOptionLabel: {
    color: colors.fg,
    fontSize: 14,
  },
  input: {
    backgroundColor: "rgba(10,13,16,0.7)",
    borderColor: "#b97d1a",
    borderRadius: radii.control,
    borderWidth: 1,
    color: colors.fg,
    fontSize: fontSize.input,
    marginTop: 14,
    minHeight: 88,
    padding: 14,
    textAlignVertical: "top",
  },
  notice: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    marginTop: 12,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    marginTop: 12,
  },
  actions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 14,
  },
  primaryButton: {
    flex: 1.6,
  },
  secondaryButton: {
    flex: 1,
  },
  hint: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    marginTop: 12,
  },
});
