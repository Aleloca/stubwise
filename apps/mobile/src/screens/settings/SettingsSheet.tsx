import type { StubwiseClient } from "@stubwise/api-client";
import { isUnknown } from "@stubwise/shared";
import type { Language, Reader, SessionUser } from "@stubwise/shared";
import { deleteToken, getMessaging } from "@react-native-firebase/messaging";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { GhostButton } from "../../components/GhostButton";
import { SectionLabel } from "../../components/SectionLabel";
import { getPushToken } from "../../lib/push-token";
import { clearSession, loadSession } from "../../lib/storage";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

export interface SettingsSheetProps {
  visible: boolean;
  onRequestClose: () => void;
  client: StubwiseClient;
  user: Reader<SessionUser>;
  /** Chiamato DOPO che il logout (best-effort remoto + pulizia locale) è finito: transiziona l'app a `unauthenticated`. */
  onLoggedOut: () => void;
  testID?: string;
}

/** Host della baseUrl salvata (`stubwise.farmakom.it`, senza protocollo, canvas `3i`) — o la stringa grezza se non è un URL valido. */
function hostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

const LANGUAGES: Language[] = ["it", "en"];

/**
 * Sheet Impostazioni (Task 20, canvas `3i`), raggiunta dall'avatar globale
 * (vedi `app/providers.tsx`): profilo, Notifiche (push on/off + progetti
 * seguiti), Istanza (server sola lettura + lingua) ed Esci.
 *
 * Scope volutamente più STRETTO del canvas: niente "Quiet hours" né "Canali"
 * (email) — nessuno dei due ha un campo lato server (`notificationPrefsSchema`
 * ha solo `slackDm`/`push`, senza un canale email), e il testo del Task 20
 * elenca esplicitamente solo push + progetti seguiti. Aggiungerli richiede
 * prima lo schema server, fuori perimetro qui.
 *
 * Ogni query è `enabled: visible`: la sheet resta montata (come `CaptureSheet`)
 * anche a `visible=false`, e senza il gate ripartirebbe una fetch ogni volta
 * che il resto dell'app cambia — oltre a interrogare un client che, prima del
 * login, questo componente non riceve nemmeno (vedi `providers.tsx`, che lo
 * monta solo da autenticato).
 */
export function SettingsSheet({ visible, onRequestClose, client, user, onLoggedOut, testID }: SettingsSheetProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  // La baseUrl non vive nello stato di `useAuth()` (vedi il commento su
  // `AuthState` in `app/auth-context.ts`: aggiungerla lì costringerebbe ogni
  // fixture di test che costruisce un `AuthContextValue` a portarsela dietro)
  // — la si legge dalla sessione salvata, la stessa fonte da cui arriva
  // `patId` al momento del logout più sotto.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void loadSession().then((session) => {
      if (!cancelled) setBaseUrl(session?.baseUrl ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const prefsQuery = useQuery({
    queryKey: ["me", "notification-prefs"],
    queryFn: () => client.me.notificationPrefs(),
    enabled: visible,
  });

  const projectsQuery = useQuery({
    queryKey: ["projects", "list"],
    queryFn: () => client.projects.list(),
    enabled: visible,
  });

  const followsQuery = useQuery({
    queryKey: ["me", "follows"],
    queryFn: () => client.me.follows(),
    enabled: visible,
  });

  const setPushMutation = useMutation({
    // PATCH mirata: manda SOLO `push` (vedi il docblock su `setNotificationPrefs`
    // in `packages/api-client/src/endpoints/me.ts`) — mai l'intero oggetto letto
    // dalla GET, che vanificherebbe il motivo per cui è una patch.
    mutationFn: (push: boolean) => client.me.setNotificationPrefs({ push }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["me", "notification-prefs"] }),
  });

  const setFollowsMutation = useMutation({
    mutationFn: (projectIds: string[]) => client.me.setFollows(projectIds),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["me", "follows"] }),
  });

  const setLanguageMutation = useMutation({
    mutationFn: (language: Language) => client.auth.setLanguage(language),
    onSuccess: (_data, language) => {
      // Applicata in locale SUBITO (non si aspetta la GET successiva): stesso
      // principio di `applyUserLanguage` in `providers.tsx` — l'utente ha
      // appena scelto la lingua, non deve aspettare un altro giro di rete
      // per vederla cambiata.
      void i18n.changeLanguage(language);
    },
  });

  function toggleFollow(projectId: string, follow: boolean): void {
    const current = new Set(followsQuery.data?.projectIds ?? []);
    if (follow) current.add(projectId);
    else current.delete(projectId);
    setFollowsMutation.mutate(Array.from(current));
  }

  /**
   * Logout: BEST-EFFORT ma sempre locale. Le tre chiamate remote (device push,
   * PAT, token FCM) partono in PARALLELO e indipendenti (`Promise.allSettled`,
   * non un `await` sequenziale) — un fallimento di una NON deve impedire le
   * altre due. `clearSession()` e l'azzeramento della cache girano SEMPRE,
   * qualunque sia l'esito delle tre: un'ex istanza non deve poter continuare a
   * raggiungere questo device (`deleteToken`) né usare il PAT rubato dal
   * Keychain di un telefono perso, ma nemmeno un errore di rete deve lasciare
   * l'utente bloccato in una sessione che non riesce a chiudere da qui.
   */
  async function handleLogout(): Promise<void> {
    setLoggingOut(true);
    const session = await loadSession().catch(() => null);

    const results = await Promise.allSettled([
      (async () => {
        const pushToken = await getPushToken().catch(() => null);
        if (pushToken) await client.me.deleteDevice(pushToken.token);
      })(),
      session?.patId ? client.pats.revoke(session.patId) : Promise.resolve(),
      deleteToken(getMessaging()),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        // Best-effort, mai silenzioso (stesso principio di `lib/push.ts`): un
        // logout che sembra riuscito ma ha lasciato un device o un PAT vivi
        // dall'altra parte è il guasto peggiore da diagnosticare più tardi.
        console.warn("stubwise: logout — una chiamata remota è fallita (best-effort)", result.reason);
      }
    }

    await clearSession();
    queryClient.clear();
    setLoggingOut(false);
    onLoggedOut();
  }

  const roleKey = !isUnknown(user.role) && user.role === "admin" ? "admin" : "member";

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onRequestClose} testID={testID}>
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onRequestClose}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.settings.close")}
        />
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <ScrollView keyboardShouldPersistTaps="handled">
            <View style={styles.profileRow}>
              <View style={styles.email}>
                <Text style={styles.emailText} numberOfLines={1}>
                  {user.email}
                </Text>
              </View>
              <View style={styles.roleBadge}>
                <Text style={styles.roleBadgeText}>{t(`mobile.settings.role.${roleKey}`)}</Text>
              </View>
            </View>

            <SectionLabel style={styles.sectionLabel}>{t("mobile.settings.notifications.title")}</SectionLabel>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{t("mobile.settings.notifications.pushLabel")}</Text>
                <Switch
                  accessibilityLabel={t("mobile.settings.notifications.pushLabel")}
                  disabled={!prefsQuery.data}
                  onValueChange={(value) => setPushMutation.mutate(value)}
                  thumbColor={colors.ink950}
                  trackColor={{ false: colors.line, true: colors.signal }}
                  value={prefsQuery.data?.push ?? false}
                  testID="settings-push-switch"
                />
              </View>

              <SectionLabel tone="faint" style={styles.subLabel}>
                {t("mobile.settings.notifications.followedProjectsLabel")}
              </SectionLabel>
              {(projectsQuery.data ?? []).map((project) => (
                <View key={project.id} style={styles.row}>
                  <Text style={styles.rowLabel} numberOfLines={1}>
                    {project.name}
                  </Text>
                  <Switch
                    accessibilityLabel={project.name}
                    disabled={!followsQuery.data}
                    onValueChange={(value) => toggleFollow(project.id, value)}
                    thumbColor={colors.ink950}
                    trackColor={{ false: colors.line, true: colors.signal }}
                    value={(followsQuery.data?.projectIds ?? []).includes(project.id)}
                    testID={`settings-follow-${project.id}`}
                  />
                </View>
              ))}
              {projectsQuery.data && projectsQuery.data.length === 0 && (
                <Text style={styles.emptyNote}>{t("mobile.settings.notifications.noProjects")}</Text>
              )}
            </View>

            <SectionLabel style={styles.sectionLabel}>{t("mobile.settings.instance.title")}</SectionLabel>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{t("mobile.settings.instance.serverLabel")}</Text>
                <Text style={styles.rowValue}>{baseUrl ? hostFromBaseUrl(baseUrl) : "—"}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{t("mobile.settings.instance.languageLabel")}</Text>
                <View style={styles.languageChips}>
                  {LANGUAGES.map((language) => {
                    const active = i18n.language === language;
                    return (
                      <Pressable
                        key={language}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={t(`mobile.settings.instance.language.${language}`)}
                        onPress={() => setLanguageMutation.mutate(language)}
                        style={[styles.chip, active && styles.chipActive]}
                        testID={`settings-language-${language}`}
                      >
                        <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>
                          {t(`mobile.settings.instance.language.${language}`)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            </View>

            <View style={styles.logoutWrap}>
              <GhostButton
                label={loggingOut ? t("mobile.settings.loggingOut") : t("mobile.settings.logout")}
                onPress={() => void handleLogout()}
                disabled={loggingOut}
                testID="settings-logout-button"
              />
            </View>
          </ScrollView>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    maxHeight: "88%",
    paddingBottom: 40,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  handle: {
    alignSelf: "center",
    backgroundColor: colors.line,
    borderRadius: 2,
    height: 4,
    marginBottom: 14,
    width: 36,
  },
  profileRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  email: {
    flex: 1,
    minWidth: 0,
  },
  emailText: {
    color: colors.fg,
    fontSize: 15,
    fontWeight: "600",
  },
  roleBadge: {
    borderColor: colors.line,
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  roleBadgeText: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  sectionLabel: {
    marginBottom: 8,
    marginTop: 16,
  },
  subLabel: {
    marginBottom: 4,
    marginTop: 4,
  },
  card: {
    backgroundColor: colors.ink950,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    overflow: "hidden",
    paddingHorizontal: 16,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
  },
  rowLabel: {
    color: colors.fg,
    flex: 1,
    fontSize: 15,
    marginRight: 12,
  },
  rowValue: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  emptyNote: {
    color: colors.faint,
    fontSize: 13,
    paddingBottom: 12,
  },
  languageChips: {
    flexDirection: "row",
    gap: 8,
  },
  chip: {
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipActive: {
    borderColor: colors.signal,
  },
  chipLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  chipLabelActive: {
    color: colors.signal,
  },
  logoutWrap: {
    marginTop: 20,
  },
});
