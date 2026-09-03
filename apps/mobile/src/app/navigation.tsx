import { NavigationContainer, useNavigation } from "@react-navigation/native";
import type { NavigatorScreenParams } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NativeStackNavigationProp, NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { SectionLabel } from "../components/SectionLabel";
import { InboxCardScreen } from "../screens/inbox/InboxCardScreen";
import { InboxScreen } from "../screens/inbox/InboxScreen";
import { LoginScreen } from "../screens/auth/LoginScreen";
import { OnboardingScreen } from "../screens/auth/OnboardingScreen";
import { useUnreadCount } from "../lib/inbox-mutations";
import { colors } from "../theme/tokens";
import { fontFamily } from "../theme/typography";
import { buildLinking, getPendingDeepLink, resolveDeepLinkTarget, setPendingDeepLink } from "./linking";
import { useAuth } from "./providers";

export type AuthStackParamList = {
  Login: undefined;
  Onboarding: undefined;
};

export type InboxStackParamList = {
  List: undefined;
  Card: { id: string };
};

export type ProjectsStackParamList = {
  List: undefined;
  Detail: { id: string };
  Ticket: { id: string };
};

export type MainTabParamList = {
  Inbox: NavigatorScreenParams<InboxStackParamList>;
  Projects: NavigatorScreenParams<ProjectsStackParamList>;
  Backlog: undefined;
  Docs: undefined;
};

export type RootStackParamList = {
  Auth: NavigatorScreenParams<AuthStackParamList>;
  Main: NavigatorScreenParams<MainTabParamList>;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();
const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const InboxStack = createNativeStackNavigator<InboxStackParamList>();
const ProjectsStack = createNativeStackNavigator<ProjectsStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

/**
 * Schermate placeholder per i tab: il contenuto vero arriva coi Task
 * 14–18. Qui servono solo a dare un albero di navigazione reale su cui
 * verificare tema, tab bar e deep link — e a mostrare il param `id` così i
 * test del deep link possono verificarlo senza aspettare l'Inbox vera.
 */
function Placeholder({ label }: { label: string }) {
  return (
    <View style={styles.placeholder}>
      <SectionLabel>{label}</SectionLabel>
    </View>
  );
}

function ProjectsListScreen() {
  const { t } = useTranslation();
  return <Placeholder label={t("mobile.tabs.projects")} />;
}

function ProjectDetailScreen({ route }: NativeStackScreenProps<ProjectsStackParamList, "Detail">) {
  return <Placeholder label={`Project ${route.params.id}`} />;
}

function TicketScreen({ route }: NativeStackScreenProps<ProjectsStackParamList, "Ticket">) {
  return <Placeholder label={`Ticket ${route.params.id}`} />;
}

function BacklogScreen() {
  const { t } = useTranslation();
  return <Placeholder label={t("mobile.tabs.backlog")} />;
}

function DocsScreen() {
  const { t } = useTranslation();
  return <Placeholder label={t("mobile.tabs.docs")} />;
}

function InboxNavigator() {
  return (
    <InboxStack.Navigator screenOptions={{ headerShown: false }}>
      <InboxStack.Screen name="List" component={InboxScreen} />
      <InboxStack.Screen name="Card" component={InboxCardScreen} />
    </InboxStack.Navigator>
  );
}

function ProjectsNavigator() {
  return (
    <ProjectsStack.Navigator screenOptions={{ headerShown: false }}>
      <ProjectsStack.Screen name="List" component={ProjectsListScreen} />
      <ProjectsStack.Screen name="Detail" component={ProjectDetailScreen} />
      <ProjectsStack.Screen name="Ticket" component={TicketScreen} />
    </ProjectsStack.Navigator>
  );
}

/** Sigla mono + etichetta della tab bar, nei due stati del canvas (attiva/spenta). */
function TabGlyph({ code, label, focused }: { code: string; label: string; focused: boolean }) {
  return (
    <View style={styles.tabGlyph}>
      <Text style={[styles.tabCode, { color: focused ? colors.signal : colors.faint }]}>{code}</Text>
      <Text style={[styles.tabLabel, { color: focused ? colors.fg : colors.muted }]}>{label}</Text>
    </View>
  );
}

/**
 * Monta l'app "vera" (autenticata). Al primo render consuma un eventuale
 * deep link rimasto in sospeso da prima del login (vedi
 * `linking.ts`): `Main` è il primo posto in cui gli screen di destinazione
 * (`Inbox/Card`, `Projects/Detail`, `Projects/Ticket`) esistono davvero
 * nell'albero, quindi è anche il primo momento in cui si può navigarci.
 */
function MainNavigator() {
  // Tipizzato sul RootStack (l'ANTENATO di questo componente: `MainNavigator`
  // è il `component` dello screen "Main" del RootStack, non un discendente
  // del proprio `Tab.Navigator`, che ritorna qui sotto): `.navigate("Main",
  // {screen,params})` con i param annidati è il modo corretto di raggiungere
  // uno screen di un navigator FIGLIO da qui, non `.navigate("Inbox", …)`
  // diretto — "Inbox" non è uno screen del RootStack.
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { t } = useTranslation();
  // Il conteggio non letto (campanella web, badge qui): poller di 30s via
  // TanStack Query, vedi `useUnreadCount` in `lib/inbox-mutations.ts`. `0`
  // (o non ancora caricato) non mostra badge — `tabBarBadge` a `0` lo
  // renderebbe comunque (bottom-tabs non nasconde uno "0"), quindi lo si
  // passa come `undefined`.
  const unreadCount = useUnreadCount();
  const badge = unreadCount.data !== undefined && unreadCount.data > 0 ? String(unreadCount.data) : undefined;

  useEffect(() => {
    const pending = getPendingDeepLink();
    if (!pending) return;
    setPendingDeepLink(null);
    const target = resolveDeepLinkTarget(pending);
    if (!target) return;
    if (target.area === "inbox") {
      navigation.navigate("Main", { screen: "Inbox", params: { screen: "Card", params: { id: target.id } } });
    } else if (target.area === "projects") {
      navigation.navigate("Main", { screen: "Projects", params: { screen: "Detail", params: { id: target.id } } });
    } else if (target.area === "tickets") {
      navigation.navigate("Main", { screen: "Projects", params: { screen: "Ticket", params: { id: target.id } } });
    }
  }, [navigation]);

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: styles.tabBar,
        tabBarShowLabel: false,
      }}
    >
      <Tab.Screen
        name="Inbox"
        component={InboxNavigator}
        options={{
          tabBarIcon: ({ focused }) => <TabGlyph code="INB" label={t("mobile.tabs.inbox")} focused={focused} />,
          tabBarBadge: badge,
        }}
      />
      <Tab.Screen
        name="Projects"
        component={ProjectsNavigator}
        options={{
          tabBarIcon: ({ focused }) => <TabGlyph code="PRJ" label={t("mobile.tabs.projects")} focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Backlog"
        component={BacklogScreen}
        options={{
          tabBarIcon: ({ focused }) => <TabGlyph code="BLG" label={t("mobile.tabs.backlog")} focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Docs"
        component={DocsScreen}
        options={{
          tabBarIcon: ({ focused }) => <TabGlyph code="DOC" label={t("mobile.tabs.docs")} focused={focused} />,
        }}
      />
    </Tab.Navigator>
  );
}

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Onboarding" component={OnboardingScreen} />
    </AuthStack.Navigator>
  );
}

/**
 * Radice della navigazione: `Auth` (Login → Onboarding) finché
 * `justLoggedIn` non torna `false`, poi `Main`. Vedi il commento su
 * `justLoggedIn` in `providers.tsx` per il perché di questa condizione
 * invece del solo `status`.
 */
export function RootNavigator() {
  const { status, justLoggedIn } = useAuth();
  const isAuthenticated = useMemo(() => () => status === "authenticated" && !justLoggedIn, [status, justLoggedIn]);
  const linking = useMemo(() => buildLinking(isAuthenticated), [isAuthenticated]);

  if (status === "loading") return null;

  const showMain = status === "authenticated" && !justLoggedIn;

  return (
    <NavigationContainer linking={linking}>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {showMain ? (
          <RootStack.Screen name="Main" component={MainNavigator} />
        ) : (
          <RootStack.Screen name="Auth" component={AuthNavigator} />
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    alignItems: "center",
    backgroundColor: colors.ink950,
    flex: 1,
    justifyContent: "center",
  },
  tabBar: {
    backgroundColor: colors.ink900,
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  tabGlyph: {
    alignItems: "center",
    gap: 3,
  },
  tabCode: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 2,
  },
  tabLabel: {
    fontSize: 10,
  },
});
