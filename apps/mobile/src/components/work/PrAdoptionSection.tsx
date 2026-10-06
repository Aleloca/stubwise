import type { PrAdoption, Reader } from "@stubwise/shared";
import { isUnknown } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useAdoptPr, useReleasePrAdoption } from "../../lib/adoption-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { GhostButton } from "../GhostButton";
import { PrimaryButton } from "../PrimaryButton";
import { SheetModal } from "../SheetModal";

/** Lo stesso tetto di `adoptPrBodySchema` lato server (e del web). */
const NOTE_MAX = 4000;

/** I motivi che questa versione dell'app sa dire; gli altri cadono su `unknown`. */
const KNOWN_REASONS = new Set(["fork", "stubwise_pr", "base_branch", "pr_closed"]);

export interface PrAdoptionSectionProps {
  ticketId: string;
  ticketNumber: number;
  adoption: Reader<PrAdoption>;
}

/**
 * ADOZIONE della PR di un ticket review (6 ott 2026): «Fai correggere a
 * Stubwise» e «Smetti di correggere». Gemella di `pr-adoption-panel.tsx` del
 * web: stessi stati, stessi testi, stesse regole.
 *
 * ⚠️ **Il client non decide niente.** Stato, motivo e soprattutto `canManage`
 * vengono dal server (col ruolo di chi guarda). Un operatore non vede il
 * bottone — non spento: assente —, e vede solo, se c'è, che Stubwise sta
 * correggendo la PR. Uno stato che questa app non conosce (server più nuovo)
 * non offre nessuna azione.
 *
 * La nota della prima correzione sta in un foglio nativo (`SheetModal`) come
 * «Chiedi modifiche»; il rilascio è in due passi in linea. Lo stato locale è
 * del ticket: il contenuto è keyato sul `ticketId`.
 */
export function PrAdoptionSection(props: PrAdoptionSectionProps) {
  return <PrAdoptionBody key={props.ticketId} {...props} />;
}

function PrAdoptionBody({ ticketId, ticketNumber, adoption }: PrAdoptionSectionProps) {
  const { t } = useTranslation();
  const adopt = useAdoptPr(ticketId);
  const release = useReleasePrAdoption(ticketId);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const state = adoption.state;
  const canManage = adoption.canManage;

  if (!isUnknown(state) && state === "adopted") {
    return (
      <View testID="pr-adoption">
        <Text style={styles.adopted} testID="pr-adoption-adopted">
          {adoption.adoptedBy !== null
            ? t("mobile.work.adoption.adopted", { who: adoption.adoptedBy })
            : t("mobile.work.adoption.adoptedNoWho")}
        </Text>
        {adopt.firstCorrectionNotStarted && (
          <Text style={styles.note}>{t("mobile.work.adoption.firstCorrectionNotStarted")}</Text>
        )}
        {canManage && !confirmRelease && (
          <View style={styles.actionsRow}>
            <GhostButton
              label={t("mobile.work.adoption.release")}
              onPress={() => {
                release.reset();
                setConfirmRelease(true);
              }}
              disabled={release.disabled}
              testID="pr-adoption-release"
            />
          </View>
        )}
        {canManage && confirmRelease && (
          <View style={styles.actions}>
            <View style={styles.primary}>
              <PrimaryButton
                label={t("mobile.work.adoption.releaseConfirm")}
                onPress={() => release.release(adoption.repositoryId, () => setConfirmRelease(false))}
                pending={release.isPending}
                disabled={!release.online}
                testID="pr-adoption-release-confirm"
              />
            </View>
            <View style={styles.secondary}>
              <GhostButton
                besidePrimary
                label={t("mobile.work.adoption.cancel")}
                onPress={() => setConfirmRelease(false)}
                disabled={release.isPending}
              />
            </View>
          </View>
        )}
        {canManage && !release.online && <Text style={styles.offline}>{t("mobile.work.adoption.offline")}</Text>}
        {release.errorMessage !== null && (
          <Text accessibilityLiveRegion="polite" style={styles.error} testID="pr-adoption-error">
            {release.errorMessage}
          </Text>
        )}
      </View>
    );
  }

  // Non adottata: il bottone è affare di chi può decidere, e solo negli stati
  // che questa app conosce.
  if (!canManage || isUnknown(state)) return null;

  const unavailable = state !== "available";
  const reason = adoption.unavailableReason;
  const reasonKey = reason !== null && !isUnknown(reason) && KNOWN_REASONS.has(reason) ? reason : "unknown";

  return (
    <View testID="pr-adoption">
      <Text style={styles.note} testID="pr-adoption-note">
        {unavailable ? t(`mobile.work.adoption.unavailable.${reasonKey}`) : t("mobile.work.adoption.available")}
      </Text>
      <View style={styles.actionsRow}>
        <PrimaryButton
          label={t("mobile.work.adoption.adopt")}
          onPress={() => {
            adopt.reset();
            setSheetOpen(true);
          }}
          disabled={unavailable || adopt.disabled}
          testID="pr-adoption-adopt"
        />
      </View>
      {!adopt.online && <Text style={styles.offline}>{t("mobile.work.adoption.offline")}</Text>}
      <SheetModal
        open={sheetOpen}
        onClose={() => {
          if (adopt.isPending) return;
          adopt.reset();
          setSheetOpen(false);
        }}
        dismissible={!adopt.isPending}
        testID="pr-adoption-sheet"
      >
        {sheetOpen && (
          <AdoptForm
            ticketNumber={ticketNumber}
            branch={adoption.branch}
            adopt={adopt}
            repositoryId={adoption.repositoryId}
            onCancel={() => {
              adopt.reset();
              setSheetOpen(false);
            }}
            onDone={() => setSheetOpen(false)}
          />
        )}
      </SheetModal>
    </View>
  );
}

function AdoptForm({
  ticketNumber,
  branch,
  adopt,
  repositoryId,
  onCancel,
  onDone,
}: {
  ticketNumber: number;
  branch: string | null;
  adopt: ReturnType<typeof useAdoptPr>;
  repositoryId: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState("");

  function confirm(): void {
    if (adopt.disabled) return;
    const trimmed = note.trim();
    adopt.adopt({ repositoryId, note: trimmed.length > 0 ? trimmed : undefined }, onDone);
  }

  return (
    <View>
      <Text accessibilityRole="header" style={styles.title}>
        {t("mobile.work.adoption.sheet.title", { number: ticketNumber })}
      </Text>
      <Text style={styles.body}>
        {branch !== null
          ? t("mobile.work.adoption.sheet.body", { branch })
          : t("mobile.work.adoption.sheet.bodyNoBranch")}
      </Text>
      <Text style={styles.label}>{t("mobile.work.adoption.sheet.noteLabel")}</Text>
      <TextInput
        accessibilityLabel={t("mobile.work.adoption.sheet.noteLabel")}
        value={note}
        onChangeText={setNote}
        editable={!adopt.isPending}
        multiline
        maxLength={NOTE_MAX}
        placeholder={t("mobile.work.adoption.sheet.placeholder")}
        placeholderTextColor={colors.faint}
        style={styles.input}
        testID="pr-adoption-sheet-note"
      />
      {adopt.errorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.error} testID="pr-adoption-sheet-error">
          {adopt.errorMessage}
        </Text>
      )}
      <View style={styles.actions}>
        <View style={styles.primary}>
          <PrimaryButton
            label={t("mobile.work.adoption.sheet.confirm")}
            onPress={confirm}
            pending={adopt.isPending}
            disabled={!adopt.online}
            testID="pr-adoption-sheet-confirm"
          />
        </View>
        <View style={styles.secondary}>
          <GhostButton
            besidePrimary
            label={t("mobile.work.adoption.sheet.cancel")}
            onPress={onCancel}
            disabled={adopt.isPending}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  adopted: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  note: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
    lineHeight: 20,
  },
  actionsRow: {
    marginTop: 10,
  },
  title: {
    color: colors.fg,
    fontFamily: fontFamily.sansBold,
    fontSize: 18,
    fontWeight: "700",
  },
  body: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
    lineHeight: 20,
    marginTop: 10,
  },
  label: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 14,
  },
  input: {
    backgroundColor: "rgba(10,13,16,0.7)",
    borderColor: colors.signalDim,
    borderRadius: radii.control,
    borderWidth: 1,
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.input,
    marginTop: 6,
    minHeight: 88,
    padding: 14,
    textAlignVertical: "top",
  },
  offline: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    marginTop: 8,
  },
  error: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    marginTop: 12,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 12,
  },
  primary: {
    flex: 2,
  },
  secondary: {
    flex: 1,
  },
});
