import type { StubwiseClient } from "@stubwise/api-client";
import { isUnknown } from "@stubwise/shared";
import type { Language, Reader, SessionUser } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { GhostButton } from "../../components/GhostButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SectionLabel } from "../../components/SectionLabel";
import { loadSession } from "../../lib/storage";
import { settingsSection, type SettingsSectionKey } from "./sections";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

export interface SettingsSectionScreenProps {
  /** QUALE sezione mostrare — vedi il catalogo in `sections.ts`. */
  section: SettingsSectionKey;
  client: StubwiseClient;
  user: Reader<SessionUser>;
  /** Torna all'indice delle Impostazioni. */
  onBack: () => void;
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
 * PAGINA Impostazioni: profilo, Notifiche (push on/off + progetti seguiti),
 * Istanza (server sola lettura + lingua) ed Esci.
 *
 * ⚠️ Fino al 16 set 2026 era uno SHEET dal basso (`Modal`) montato in
 * `app/providers.tsx` e comandato da `useAuth().openSettings()`. Decisione
 * del maintainer: è una pagina, e vive sul ROOT stack — sopra le schede,
 * perché non è una sesta destinazione ma un posto in cui si entra e da cui
 * si torna indietro. Il contenuto è lo stesso: cambia l'involucro.
 *
 * Scope volutamente più STRETTO del canvas: niente "Quiet hours" né "Canali"
 * (email) — nessuno dei due ha un campo lato server (`notificationPrefsSchema`
 * ha solo `slackDm`/`push`, senza un canale email), e il testo del Task 20
 * elenca esplicitamente solo push + progetti seguiti. Aggiungerli richiede
 * prima lo schema server, fuori perimetro qui.
 *
 * ⚠️ Le query non sono più `enabled: visible` (16 set 2026). Quel gate
 * serviva allo SHEET, che restava montato anche da chiuso: senza, avrebbe
 * rifatto una fetch a ogni cambiamento altrove nell'app, e avrebbe
 * interrogato un client che prima del login non esiste. Una PAGINA si monta
 * quando ci si entra e si smonta quando si esce, quindi il problema non si
 * pone e il gate sarebbe solo una condizione sempre vera.
 */
export function SettingsSectionScreen({ section, client, user, onBack, testID }: SettingsSectionScreenProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [baseUrl, setBaseUrl] = useState<string | null>(null);

  // La baseUrl non vive nello stato di `useAuth()` (vedi il commento su
  // `AuthState` in `app/auth-context.ts`: aggiungerla lì costringerebbe ogni
  // fixture di test che costruisce un `AuthContextValue` a portarsela dietro)
  // — la si legge dalla sessione salvata, la stessa fonte da cui arriva
  // `patId` al momento del logout più sotto.
  // Niente guardia su `visible` come nello sheet: una PAGINA si monta solo
  // quando ci si entra, quindi l'effetto parte una volta sola per visita.
  useEffect(() => {
    let cancelled = false;
    void loadSession().then((session) => {
      if (!cancelled) setBaseUrl(session?.baseUrl ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const prefsQuery = useQuery({
    queryKey: ["me", "notification-prefs"],
    queryFn: () => client.me.notificationPrefs(),
  });

  const projectsQuery = useQuery({
    queryKey: ["projects", "list"],
    queryFn: () => client.projects.list(),
  });

  const followsQuery = useQuery({
    queryKey: ["me", "follows"],
    queryFn: () => client.me.follows(),
  });

  // Le tre mutazioni di questa sheet: MAI silenziose (stesso principio del
  // logout più sotto — vedi il commento lì). Senza `onError`, uno `Switch`
  // pilotato solo dal valore della query (nessuno stato ottimistico locale
  // qui: vedi `toggleFollow`) "scatta indietro" da solo quando la mutazione
  // fallisce — il `value` torna a leggere `prefsQuery.data`/`followsQuery.data`
  // invariati — senza che NULLA lo spieghi. `console.warn` per chi guarda i
  // log, il testo sotto la riga (renderizzato da `mutation.isError` nel JSX)
  // per chi guarda lo schermo.
  const setPushMutation = useMutation({
    // PATCH mirata: manda SOLO `push` (vedi il docblock su `setNotificationPrefs`
    // in `packages/api-client/src/endpoints/me.ts`) — mai l'intero oggetto letto
    // dalla GET, che vanificherebbe il motivo per cui è una patch.
    mutationFn: (push: boolean) => client.me.setNotificationPrefs({ push }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["me", "notification-prefs"] }),
    onError: (error) => {
      console.warn("stubwise: impostazioni — aggiornamento della notifica push fallito", error);
    },
  });

  const setFollowsMutation = useMutation({
    mutationFn: (projectIds: string[]) => client.me.setFollows(projectIds),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["me", "follows"] }),
    onError: (error) => {
      console.warn("stubwise: impostazioni — aggiornamento dei progetti seguiti fallito", error);
    },
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
    onError: (error) => {
      console.warn("stubwise: impostazioni — salvataggio della lingua fallito", error);
    },
  });

  function toggleFollow(projectId: string, follow: boolean): void {
    const current = new Set(followsQuery.data?.projectIds ?? []);
    if (follow) current.add(projectId);
    else current.delete(projectId);
    setFollowsMutation.mutate(Array.from(current));
  }

  /**
   * Logout: BEST-EFFORT ma sempre locale. Le tre chiamate remote (device
   * push, PAT, token FCM) girano in SEQUENZA, non in parallelo (review fase
   * 4, finding #3): il token corrente si legge UNA volta sola, PRIMA di
   * qualunque chiamata distruttiva, e SUBITO passato a `deleteDevice`. Farle
   * in parallelo con `deleteToken` era un bug reale — se `deleteToken`
   * finiva per primo, un `getToken` letto più tardi (anche solo dentro la
   * stessa `Promise.allSettled`, senza garanzia d'ordine) poteva restituire
   * un token NUOVO generato al volo da FCM, e `deleteDevice` avrebbe
   * cancellato quello SBAGLIATO — lasciando sul server il vecchio, quello
   * davvero registrato, vivo per sempre.
   *
   * Ordine: 1. leggi il token UNA volta; 2. `deleteDevice`; 3. revoca il PAT;
   * 4. `deleteToken`; 5. `clearSession` + azzeramento cache, SEMPRE. I passi
   * 2–4 sono in `try/catch` SEPARATI: un fallimento non salta i successivi
   * (best-effort, mai un `await` che si ferma al primo errore), e il passo 5
   * gira qualunque sia l'esito dei tre — un'ex istanza non deve poter
   * continuare a raggiungere questo device (`deleteToken`) né usare il PAT
   * rubato dal Keychain di un telefono perso, ma nemmeno un errore di rete
   * deve lasciare l'utente bloccato in una sessione che non riesce a
   * chiudere da qui.
   */

  const roleKey = !isUnknown(user.role) && user.role === "admin" ? "admin" : "member";

  return (
    <View style={styles.container} testID={testID}>
      <ScrollView keyboardShouldPersistTaps="handled" stickyHeaderIndices={[0]} contentContainerStyle={styles.body}>
        {/*
          `showAvatar={false}`: l'avatar È il bottone che porta qui, e su
          questa pagina porterebbe a se stessa. È l'unico punto dell'app in
          cui l'intestazione non lo mostra.
        */}
        <ScreenHeader
          title={t(settingsSection(section).labelKey)}
          onBack={onBack}
          backLabel={t("mobile.settings.back")}
          showAvatar={false}
        />
            {section === "profile" && (
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
            )}

            {section === "notifications" && (
              <>
            <SectionLabel style={styles.sectionLabel}>{t("mobile.settings.notifications.title")}</SectionLabel>
            <View style={styles.card}>
              {prefsQuery.isError ? (
                <View style={styles.errorRow} testID="settings-push-error">
                  <Text style={styles.errorText}>{t("mobile.settings.notifications.pushLoadError")}</Text>
                  <GhostButton
                    label={t("mobile.settings.notifications.retry")}
                    onPress={() => void prefsQuery.refetch()}
                    testID="settings-push-retry"
                  />
                </View>
              ) : (
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>{t("mobile.settings.notifications.pushLabel")}</Text>
                  <Switch
                    accessibilityLabel={t("mobile.settings.notifications.pushLabel")}
                    disabled={!prefsQuery.data || setPushMutation.isPending}
                    onValueChange={(value) => setPushMutation.mutate(value)}
                    thumbColor={colors.ink950}
                    trackColor={{ false: colors.line, true: colors.signal }}
                    value={prefsQuery.data?.push ?? false}
                    testID="settings-push-switch"
                  />
                </View>
              )}
              {setPushMutation.isError && (
                <Text accessibilityLiveRegion="polite" style={styles.mutationErrorText} testID="settings-push-mutation-error">
                  {t("mobile.settings.notifications.pushSaveError")}
                </Text>
              )}

              <SectionLabel tone="faint" style={styles.subLabel}>
                {t("mobile.settings.notifications.followedProjectsLabel")}
              </SectionLabel>
              {projectsQuery.isError || followsQuery.isError ? (
                <View style={styles.errorRow} testID="settings-projects-error">
                  <Text style={styles.errorText}>{t("mobile.settings.notifications.projectsLoadError")}</Text>
                  <GhostButton
                    label={t("mobile.settings.notifications.retry")}
                    onPress={() => {
                      void projectsQuery.refetch();
                      void followsQuery.refetch();
                    }}
                    testID="settings-projects-retry"
                  />
                </View>
              ) : (
                <>
                  {(projectsQuery.data ?? []).map((project) => (
                    <View key={project.id} style={styles.row}>
                      <Text style={styles.rowLabel} numberOfLines={1}>
                        {project.name}
                      </Text>
                      <Switch
                        accessibilityLabel={project.name}
                        disabled={!followsQuery.data || setFollowsMutation.isPending}
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
                </>
              )}
              {setFollowsMutation.isError && (
                <Text accessibilityLiveRegion="polite" style={styles.mutationErrorText} testID="settings-follows-mutation-error">
                  {t("mobile.settings.notifications.followSaveError")}
                </Text>
              )}
            </View>

              </>
            )}

            {(section === "instance" || section === "language") && (
              <>
            <SectionLabel style={styles.sectionLabel}>{t("mobile.settings.instance.title")}</SectionLabel>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{t("mobile.settings.instance.serverLabel")}</Text>
                <Text style={styles.rowValue}>{baseUrl ? hostFromBaseUrl(baseUrl) : "—"}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{t("mobile.settings.instance.languageLabel")}</Text>
                <View accessibilityRole="radiogroup" style={styles.languageChips}>
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
              {setLanguageMutation.isError && (
                <Text
                  accessibilityLiveRegion="polite"
                  style={styles.mutationErrorText}
                  testID="settings-language-mutation-error"
                >
                  {t("mobile.settings.instance.languageSaveError")}
                </Text>
              )}
            </View>
              </>
            )}

            {/*
              Ogni voce non ancora fatta dice cosa SARÀ, invece di una pagina
              vuota: il catalogo (`sections.ts`) porta già la descrizione, e
              nessuna di quelle voci è inventata — o il web la offre, o il
              server la supporta, o è nel programma dell'app.
            */}
            {settingsSection(section).status === "wip" && (
              <View style={styles.card} testID="settings-coming-soon">
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>{t("mobile.settings.comingSoon")}</Text>
                </View>
                <View style={styles.comingSoonBody}>
                  <Text style={styles.comingSoonText}>{t(settingsSection(section).descriptionKey)}</Text>
                  <Text style={styles.comingSoonNote}>{t("mobile.settings.comingSoonBody")}</Text>
                </View>
              </View>
            )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  comingSoonBody: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
    gap: 8,
    padding: 14,
  },
  comingSoonText: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  comingSoonNote: {
    color: colors.faint,
    fontFamily: fontFamily.sans,
    fontSize: 12,
  },
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  body: {
    paddingBottom: 40,
    paddingHorizontal: 20,
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
    fontFamily: fontFamily.sansSemiBold,
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
    fontFamily: fontFamily.sans,
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
    fontFamily: fontFamily.sans,
    fontSize: 13,
    paddingBottom: 12,
  },
  errorRow: {
    gap: 8,
    paddingVertical: 12,
  },
  errorText: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 13,
  },
  // Sotto una riga già disegnata (switch/chip), non al posto suo — a
  // differenza di `errorText` (che sostituisce l'intera sezione quando la
  // QUERY fallisce), questo si aggiunge quando è la MUTAZIONE a fallire: il
  // controllo resta a schermo (lo `Switch` è già scattato indietro da solo,
  // pilotato dal valore invariato della query), e questo testo è l'unica
  // cosa che spiega perché.
  mutationErrorText: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
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
