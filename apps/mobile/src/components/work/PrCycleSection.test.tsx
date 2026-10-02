import { ApiError, createStubwiseClient } from "@stubwise/api-client";
import type { StubwiseClient } from "@stubwise/api-client";
import { prCycleSchema, readerSchema, ticketRepositorySchema } from "@stubwise/shared";
import type { PrCycle, Reader, TicketRepository } from "@stubwise/shared";
import NetInfo from "@react-native-community/netinfo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking, StyleSheet } from "react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import * as correctionMutations from "../../lib/correction-mutations";
import { settleMutations } from "../../test-utils/settle-mutations";
import { workKeys } from "../../lib/query-keys";
import { colors } from "../../theme/tokens";
import { PrCycleSection } from "./PrCycleSection";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TICKET_ID = "66666666-6666-4666-8666-666666666666";
const REPO_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_REPO_ID = "33333333-3333-4333-8333-333333333333";
const HELD_JOB_ID = "44444444-4444-4444-8444-444444444444";
const CORRECTION_ID = "55555555-5555-4555-8555-555555555555";
const PR_URL = "https://bitbucket.org/acme/portale-b2b/pull-requests/10";

/**
 * Ciclo COMPLETO (trappola delle fixture dell'app, CLAUDE.md): nei test il
 * client è un doppio e `readerSchema` non gira, quindi ogni campo dello schema
 * c'è — anche `heldReason`/`canResume`/`heldJobId`, che in produzione
 * arriverebbero dai `.default()`.
 */
function cycle(overrides: Partial<Reader<PrCycle>> = {}): Reader<PrCycle> {
  return {
    state: "reviewing",
    round: 0,
    maxRounds: 3,
    pendingRequest: false,
    lastRequest: null,
    canRequestCorrection: true,
    heldReason: null,
    canResume: false,
    heldJobId: null,
    ...overrides,
  };
}

/** Correzione ferma per budget che CHI GUARDA può riprendere (un maintainer). */
function heldCycle(overrides: Partial<Reader<PrCycle>> = {}): Reader<PrCycle> {
  return cycle({
    state: "correcting",
    canRequestCorrection: false,
    heldReason: "budget",
    canResume: true,
    heldJobId: HELD_JOB_ID,
    ...overrides,
  });
}

/** Voce COMPLETA di `ticket.repositories`: `cycle` compreso, anche quando è `null`. */
function repo(overrides: Partial<Reader<TicketRepository>> = {}): Reader<TicketRepository> {
  return {
    repositoryId: REPO_ID,
    repositorySlug: "portale-b2b",
    repositoryName: "Portale B2B",
    branch: "stubwise/ticket-247",
    prUrl: PR_URL,
    prState: "open",
    cycle: cycle(),
    ...overrides,
  };
}

/**
 * Il `fetch` del client: una SPIA che rifiuta, e l'`afterEach` verifica che
 * nessun test ci arrivi. Un metodo che la sezione chiamasse senza spia
 * finirebbe qui, e un test che si aspetta un errore passerebbe per il motivo
 * sbagliato.
 */
const fetchSpy = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(() =>
  Promise.reject(new Error("fetch non previsto nei test della sezione PR")),
);

/**
 * ⚠️ Il doppio è un client VERO (tipato, niente cast) con una spia su OGNI
 * metodo che la sezione chiama: `tickets.requestCorrection` («Chiedi
 * modifiche») e `tickets.runAi` («Riprendi»). Vedi CLAUDE.md, «il DOPPIO del
 * client nei test dell'app».
 */
function makeClient() {
  const client = createStubwiseClient({
    baseUrl: "https://stubwise.test",
    getAuthHeader: () => null,
    fetch: fetchSpy,
  });
  const requestCorrection = jest
    .spyOn(client.tickets, "requestCorrection")
    .mockResolvedValue({ correctionId: CORRECTION_ID });
  const runAi = jest.spyOn(client.tickets, "runAi").mockResolvedValue({ jobId: HELD_JOB_ID, status: "queued" });
  return { client, requestCorrection, runAi };
}

function makeTree(
  client: StubwiseClient,
  queryClient: QueryClient,
  ticketId: string,
  repositories: Reader<TicketRepository>[],
) {
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "viewer-1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <PrCycleSection ticketId={ticketId} ticketNumber={247} repositories={repositories} />
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

async function renderSection(client: StubwiseClient, repositories: Reader<TicketRepository>[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = jest.spyOn(queryClient, "invalidateQueries");
  const utils = await render(makeTree(client, queryClient, TICKET_ID, repositories));
  return {
    ...utils,
    queryClient,
    invalidatedKeys: () => invalidate.mock.calls.map(([filters]) => filters?.queryKey),
    rerenderWith: (ticketId: string, next: Reader<TicketRepository>[]) =>
      utils.rerender(makeTree(client, queryClient, ticketId, next)),
  };
}


beforeEach(() => {
  (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
  fetchSpy.mockClear();
});

afterEach(() => {
  // Nessun test va in rete: ogni chiamata passa da una spia del client.
  expect(fetchSpy).not.toHaveBeenCalled();
  // Una spia sul modulo (`useResumeCorrection`) non deve sopravvivere a un
  // test che fallisce prima del suo `mockRestore`.
  jest.restoreAllMocks();
});

/** Lo stile appiattito di un nodo. */
const styleOf = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style);

describe("PrCycleSection — la card della PR (pagina del ticket a tab)", () => {
  test("nessuna PR aperta sul ticket: la sezione non c'è", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ prUrl: null })]);
    expect(screen.queryByTestId("pr-cycle-section")).toBeNull();
  });

  test("lo stato viene dal server: chip maiuscolo col tono, il giro come dettaglio", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ cycle: cycle({ state: "correcting", round: 2, canRequestCorrection: false }) })]);
    expect(screen.getByTestId(`pr-cycle-chip-${REPO_ID}`)).toHaveTextContent("Correzione in corso");
    expect(styleOf(`pr-cycle-chip-${REPO_ID}`)).toMatchObject({ color: colors.sky, textTransform: "uppercase" });
    expect(screen.getByTestId(`pr-cycle-detail-${REPO_ID}`)).toHaveTextContent("Giro 2 di 3");
    expect(styleOf(`pr-cycle-detail-${REPO_ID}`).color).toBe(colors.faint);
  });

  test("correzione ferma per budget: chip col tono che chiede attenzione (`signal`), il motivo nel dettaglio", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ cycle: heldCycle({ canResume: false, heldJobId: HELD_JOB_ID }) })]);
    expect(screen.getByTestId(`pr-cycle-chip-${REPO_ID}`)).toHaveTextContent("Correzione ferma");
    expect(styleOf(`pr-cycle-chip-${REPO_ID}`).color).toBe(colors.signal);
    expect(screen.getByTestId(`pr-cycle-detail-${REPO_ID}`)).toHaveTextContent(
      "budget esaurito · chiedi a un maintainer di riprenderla",
    );
  });

  test.each([
    ["reviewing", "In attesa della review", colors.sky],
    ["changes_requested", "La review chiede modifiche", colors.signal],
    ["stopped_at_cap", "Ciclo fermo", colors.signal],
    ["correction_failed", "L'ultima correzione è fallita", colors.danger],
    ["idle", "Nessuna review ancora", colors.faint],
    ["approved", "Approvata dalla review", colors.ok],
  ] as const)("%s: chip «%s» col suo tono", async (state, text, color) => {
    const { client } = makeClient();
    await renderSection(client, [repo({ cycle: cycle({ state, round: state === "stopped_at_cap" ? 3 : 0 }) })]);
    expect(screen.getByTestId(`pr-cycle-chip-${REPO_ID}`)).toHaveTextContent(text);
    expect(styleOf(`pr-cycle-chip-${REPO_ID}`).color).toBe(color);
  });

  test("il dettaglio c'è solo dove aggiunge qualcosa: «pronta per il merge» sì, «in attesa della review» no", async () => {
    const { client } = makeClient();
    const { rerenderWith } = await renderSection(client, [repo({ cycle: cycle({ state: "approved" }) })]);
    expect(screen.getByTestId(`pr-cycle-detail-${REPO_ID}`)).toHaveTextContent("pronta per il merge");
    await rerenderWith(TICKET_ID, [repo({ cycle: cycle({ state: "reviewing" }) })]);
    expect(screen.getByTestId(`pr-cycle-chip-${REPO_ID}`)).toHaveTextContent("In attesa della review");
    expect(screen.queryByTestId(`pr-cycle-detail-${REPO_ID}`)).toBeNull();
  });

  test("il titolo è repository · PR #N: Bitbucket `/pull-requests/10`", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo()]);
    expect(screen.getByTestId(`pr-cycle-title-${REPO_ID}`)).toHaveTextContent("Portale B2B · PR #10 ↗");
  });

  test("GitHub `/pull/4`: PR #4", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ prUrl: "https://github.com/acme/api/pull/4" })]);
    expect(screen.getByTestId(`pr-cycle-title-${REPO_ID}`)).toHaveTextContent("Portale B2B · PR #4 ↗");
  });

  test("URL non riconosciuto: «PR» senza numero, mai un numero inventato", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ prUrl: "https://git.example.com/acme/portale/merge/abc" })]);
    expect(screen.getByTestId(`pr-cycle-title-${REPO_ID}`)).toHaveTextContent("Portale B2B · PR ↗");
  });

  test("senza `repositoryName` si mostra lo slug", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ repositoryName: undefined })]);
    expect(screen.getByTestId(`pr-cycle-title-${REPO_ID}`)).toHaveTextContent("portale-b2b · PR #10 ↗");
  });

  test.each([
    ["merged", "mergiata"],
    ["closed_unmerged", "chiusa"],
  ] as const)("PR %s: un'etichetta accanto al titolo", async (prState, label) => {
    const { client } = makeClient();
    await renderSection(client, [repo({ prState, cycle: cycle({ state: "approved", canRequestCorrection: false }) })]);
    expect(screen.getByTestId(`pr-cycle-state-${REPO_ID}`)).toHaveTextContent(label);
  });

  test.each(["merged", "closed_unmerged"] as const)(
    "PR %s approvata: il chip resta, «pronta per il merge» no",
    async (prState) => {
      const { client } = makeClient();
      await renderSection(client, [repo({ prState, cycle: cycle({ state: "approved", canRequestCorrection: false }) })]);
      expect(screen.getByTestId(`pr-cycle-chip-${REPO_ID}`)).toHaveTextContent("Approvata dalla review");
      expect(screen.queryByTestId(`pr-cycle-detail-${REPO_ID}`)).toBeNull();
    },
  );

  test("PR aperta: nessuna etichetta", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo()]);
    expect(screen.queryByTestId(`pr-cycle-state-${REPO_ID}`)).toBeNull();
  });

  test("chi ha chiesto, con il tempo relativo calcolato dalla data", async () => {
    const { client } = makeClient();
    const at = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await renderSection(client, [
      repo({
        cycle: cycle({ state: "approved", lastRequest: { via: "provider", platform: "bitbucket", name: "Alessandro Locatelli", at } }),
      }),
    ]);
    expect(screen.getByTestId(`pr-cycle-asked-${REPO_ID}`)).toHaveTextContent(
      "Modifiche richieste da Alessandro Locatelli su Bitbucket · 2 h fa",
    );
    expect(styleOf(`pr-cycle-asked-${REPO_ID}`).color).toBe(colors.faint);
  });

  test("una richiesta in coda lo dice, dopo il tempo", async () => {
    const { client } = makeClient();
    const at = new Date(Date.now() - 12 * 60_000).toISOString();
    await renderSection(client, [
      repo({
        cycle: cycle({
          state: "correcting",
          round: 1,
          canRequestCorrection: false,
          pendingRequest: true,
          lastRequest: { via: "stubwise", platform: null, name: "ada@acme.test", at },
        }),
      }),
    ]);
    expect(screen.getByTestId(`pr-cycle-chip-${REPO_ID}`)).toHaveTextContent("Correzione in corso");
    expect(screen.getByTestId(`pr-cycle-asked-${REPO_ID}`)).toHaveTextContent(
      "Modifiche richieste da ada@acme.test su Stubwise · 12 min fa · in coda · parte quando finisce il lavoro in corso sul ticket",
    );
  });

  test("nessuna richiesta umana: nessuna riga «chi ha chiesto»", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ cycle: cycle({ state: "approved" }) })]);
    expect(screen.queryByTestId(`pr-cycle-asked-${REPO_ID}`)).toBeNull();
  });

  test("niente più eyebrow «Pull request»: la tab lo dice già", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo()]);
    expect(screen.queryByText("Pull request")).toBeNull();
  });

  test("il bottone sta a tutta larghezza", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ cycle: cycle({ state: "changes_requested" }) })]);
    expect(styleOf(`pr-cycle-actions-${REPO_ID}`).flexDirection).toBe("column");
  });

  test("`cycle: null` (PR non di Stubwise, o server di prima): la card col titolo, niente chip né bottoni", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ cycle: null })]);
    expect(screen.getByTestId("pr-cycle-section")).toBeTruthy();
    expect(screen.getByTestId(`pr-cycle-open-${REPO_ID}`)).toBeTruthy();
    expect(screen.queryByTestId(`pr-cycle-chip-${REPO_ID}`)).toBeNull();
    expect(screen.queryByTestId(`pr-cycle-detail-${REPO_ID}`)).toBeNull();
    expect(screen.queryByTestId(`pr-cycle-request-${REPO_ID}`)).toBeNull();
    expect(screen.queryByTestId(`pr-cycle-resume-${REPO_ID}`)).toBeNull();
  });

  test("il titolo apre il link della PR", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const { client } = makeClient();
    await renderSection(client, [repo()]);
    await fireEvent.press(screen.getByTestId(`pr-cycle-open-${REPO_ID}`));
    expect(openURL).toHaveBeenCalledWith(PR_URL);
    openURL.mockRestore();
  });

  test("un URL della PR che non è http/https non diventa un link", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const { client } = makeClient();
    await renderSection(client, [repo({ prUrl: "javascript:alert(1)" })]);
    // La PR c'è (chip e titolo restano, senza la freccia), il link no.
    expect(screen.getByTestId(`pr-cycle-chip-${REPO_ID}`)).toBeTruthy();
    expect(screen.getByTestId(`pr-cycle-title-${REPO_ID}`)).toHaveTextContent("Portale B2B · PR");
    expect(screen.getByTestId(`pr-cycle-title-${REPO_ID}`)).not.toHaveTextContent("↗");
    expect(screen.queryByTestId(`pr-cycle-open-${REPO_ID}`)).toBeNull();
    expect(openURL).not.toHaveBeenCalled();
    openURL.mockRestore();
  });

  test("se nessuna app apre il link, il rifiuto di `openURL` è gestito", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockRejectedValue(new Error("no handler"));
    const { client } = makeClient();
    await renderSection(client, [repo()]);
    await fireEvent.press(screen.getByTestId(`pr-cycle-open-${REPO_ID}`));
    expect(openURL).toHaveBeenCalledWith(PR_URL);
    // Un giro di macrotask: è lì che una promise rifiutata senza gestore
    // viene segnalata, e Jest fa fallire il test che l'ha prodotta (provato
    // togliendo il `.catch`: il test diventa rosso con «no handler»).
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    openURL.mockRestore();
  });

  /**
   * TRAPPOLA 2 (CLAUDE.md): lo scenario con SOLO i campi nuovi popolati —
   * nessun `repositoryName`, il resto del ciclo ai valori neutri, e ciò che
   * la sezione ha di nuovo (`heldReason`, `canResume`, `heldJobId`) acceso.
   * Una fixture completata a zero non lo produce mai.
   */
  test("SOLO i campi nuovi popolati: ferma per limite, riprendibile — riga, tono e «Riprendi»", async () => {
    const { client } = makeClient();
    await renderSection(client, [
      {
        repositoryId: REPO_ID,
        repositorySlug: "portale-b2b",
        branch: "stubwise/ticket-247",
        prUrl: PR_URL,
        prState: "open",
        cycle: {
          state: "correcting",
          round: 0,
          maxRounds: 0,
          pendingRequest: false,
          lastRequest: null,
          canRequestCorrection: false,
          heldReason: "limit",
          canResume: true,
          heldJobId: HELD_JOB_ID,
        },
      },
    ]);
    expect(screen.getByTestId(`pr-cycle-chip-${REPO_ID}`)).toHaveTextContent("Correzione ferma");
    expect(styleOf(`pr-cycle-chip-${REPO_ID}`).color).toBe(colors.sky);
    expect(screen.getByTestId(`pr-cycle-detail-${REPO_ID}`)).toHaveTextContent("limite del provider raggiunto, riparte da sola");
    expect(screen.getByTestId(`pr-cycle-title-${REPO_ID}`)).toHaveTextContent("portale-b2b · PR #10 ↗");
    expect(screen.getByTestId(`pr-cycle-resume-${REPO_ID}`)).toBeTruthy();
    expect(screen.getByTestId(`pr-cycle-request-${REPO_ID}`).props.accessibilityState?.disabled).toBe(true);
  });

  test("server più vecchio del ciclo nuovo: la voce GREZZA, parsata come l'app la riceve, niente «Riprendi»", async () => {
    const { client } = makeClient();
    // Come arriva da un server di prima di E5/E7/G5: il ciclo senza i tre
    // campi. `readerSchema` li porta a `null`/`false`/`null`.
    const parsed = readerSchema(ticketRepositorySchema).parse({
      repositoryId: REPO_ID,
      repositorySlug: "portale-b2b",
      branch: "stubwise/ticket-247",
      prUrl: PR_URL,
      prState: "open",
      cycle: {
        state: "correcting",
        round: 1,
        maxRounds: 3,
        pendingRequest: false,
        lastRequest: null,
        canRequestCorrection: false,
      },
    });
    await renderSection(client, [parsed]);
    expect(screen.getByTestId(`pr-cycle-chip-${REPO_ID}`)).toHaveTextContent("Correzione in corso");
    expect(screen.getByTestId(`pr-cycle-detail-${REPO_ID}`)).toHaveTextContent("Giro 1 di 3");
    expect(screen.queryByTestId(`pr-cycle-resume-${REPO_ID}`)).toBeNull();
  });
});

describe("PrCycleSection — «Chiedi modifiche»", () => {
  test("il bottone lo accende SOLO `canRequestCorrection`: spento durante una correzione", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ cycle: cycle({ state: "correcting", round: 1, canRequestCorrection: false }) })]);
    expect(screen.getByTestId(`pr-cycle-request-${REPO_ID}`).props.accessibilityState?.disabled).toBe(true);
  });

  test("acceso con `canRequestCorrection`, qualunque sia lo stato", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ cycle: cycle({ state: "approved", canRequestCorrection: true }) })]);
    expect(screen.getByTestId(`pr-cycle-request-${REPO_ID}`).props.accessibilityState?.disabled).toBe(false);
  });

  test("bottone → pannello → nota → conferma: la richiesta parte e il pannello si chiude", async () => {
    const { client, requestCorrection, runAi } = makeClient();
    const { queryClient } = await renderSection(client, [repo({ cycle: cycle({ state: "changes_requested" }) })]);

    await fireEvent.press(screen.getByTestId(`pr-cycle-request-${REPO_ID}`));
    await waitFor(() => expect(screen.getByTestId("correction-sheet-note")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("correction-sheet-note"), "Rinomina anche il test");
    await fireEvent.press(screen.getByTestId("correction-sheet-confirm"));

    await waitFor(() =>
      expect(requestCorrection).toHaveBeenCalledWith(TICKET_ID, REPO_ID, { note: "Rinomina anche il test" }),
    );
    await waitFor(() => expect(screen.queryByTestId("correction-sheet-note")).toBeNull());
    expect(runAi).not.toHaveBeenCalled();
    await settleMutations(queryClient);
  });

  test("409: l'errore si legge nel pannello, che resta aperto", async () => {
    const { client, requestCorrection } = makeClient();
    requestCorrection.mockRejectedValue(new ApiError(409, "…", "correction_in_flight"));
    const { queryClient } = await renderSection(client, [repo()]);

    await fireEvent.press(screen.getByTestId(`pr-cycle-request-${REPO_ID}`));
    await waitFor(() => expect(screen.getByTestId("correction-sheet-confirm")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("correction-sheet-confirm"));

    await waitFor(() => expect(screen.getByText("C'è già una correzione in corso su questa PR")).toBeTruthy());
    expect(screen.getByTestId("correction-sheet-note")).toBeTruthy();
    await settleMutations(queryClient);
  });

  test("PR mergiata: lo stato resta, il bottone no", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ prState: "merged", cycle: cycle({ state: "approved", canRequestCorrection: false }) })]);
    expect(screen.getByTestId(`pr-cycle-chip-${REPO_ID}`)).toBeTruthy();
    expect(screen.queryByTestId(`pr-cycle-request-${REPO_ID}`)).toBeNull();
  });

  test("due repository: il bottone della seconda chiede sulla seconda", async () => {
    const { client, requestCorrection } = makeClient();
    const { queryClient } = await renderSection(client, [
      repo(),
      repo({ repositoryId: OTHER_REPO_ID, repositoryName: "API", prUrl: `${PR_URL}1` }),
    ]);

    await fireEvent.press(screen.getByTestId(`pr-cycle-request-${OTHER_REPO_ID}`));
    await waitFor(() => expect(screen.getByTestId("correction-sheet-confirm")).toBeTruthy());
    // Il nome compare due volte: nel titolo della card e nel pannello, che
    // dice su quale repository si agisce.
    expect(screen.getByTestId(`pr-cycle-title-${OTHER_REPO_ID}`)).toHaveTextContent(/^API · PR/);
    expect(screen.getAllByText("API")).toHaveLength(1);
    await fireEvent.press(screen.getByTestId("correction-sheet-confirm"));

    await waitFor(() => expect(requestCorrection).toHaveBeenCalledWith(TICKET_ID, OTHER_REPO_ID, {}));
    await settleMutations(queryClient);
  });
});

describe("PrCycleSection — «Riprendi» una correzione ferma (G5)", () => {
  test("con `canResume` E `heldJobId`: manda run-ai con QUELLA correzione", async () => {
    const { client, runAi, requestCorrection } = makeClient();
    const { queryClient, invalidatedKeys } = await renderSection(client, [repo({ cycle: heldCycle() })]);

    expect(screen.getByText("Riprendi la correzione")).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`pr-cycle-resume-${REPO_ID}`));

    await waitFor(() => expect(runAi).toHaveBeenCalledWith(TICKET_ID, { resumeCorrectionJobId: HELD_JOB_ID }));
    expect(requestCorrection).not.toHaveBeenCalled();
    await settleMutations(queryClient);
    expect(invalidatedKeys()).toContainEqual(workKeys.all(TICKET_ID));
    expect(screen.queryByTestId(`pr-cycle-resume-error-${REPO_ID}`)).toBeNull();
  });

  test("`canResume` senza `heldJobId`: «Riprendi» NON si offre (sarebbe un fix nuovo)", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ cycle: heldCycle({ heldJobId: null }) })]);
    expect(screen.queryByTestId(`pr-cycle-resume-${REPO_ID}`)).toBeNull();
  });

  test("`heldJobId` senza `canResume` (ferma per budget, chi guarda è un operatore): niente «Riprendi»", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ cycle: heldCycle({ canResume: false }) })]);
    expect(screen.queryByTestId(`pr-cycle-resume-${REPO_ID}`)).toBeNull();
  });

  test("409 `correction_not_held`: la frase sotto la riga, e il ticket si ricarica", async () => {
    const { client, runAi } = makeClient();
    runAi.mockRejectedValue(new ApiError(409, "…", "correction_not_held"));
    const { queryClient, invalidatedKeys } = await renderSection(client, [repo({ cycle: heldCycle() })]);

    await fireEvent.press(screen.getByTestId(`pr-cycle-resume-${REPO_ID}`));

    await waitFor(() =>
      expect(screen.getByTestId(`pr-cycle-resume-error-${REPO_ID}`).props.children).toBe(
        "Questa correzione non è più ferma: il ticket è stato ricaricato",
      ),
    );
    expect(invalidatedKeys()).toContainEqual(workKeys.all(TICKET_ID));
    await settleMutations(queryClient);
  });

  test("409 `job_in_flight`: STESSO status, ma il ticket NON si ricarica — decide il `code`", async () => {
    const { client, runAi } = makeClient();
    runAi.mockRejectedValue(new ApiError(409, "…", "job_in_flight"));
    const { queryClient, invalidatedKeys } = await renderSection(client, [repo({ cycle: heldCycle() })]);

    await fireEvent.press(screen.getByTestId(`pr-cycle-resume-${REPO_ID}`));

    await waitFor(() =>
      expect(screen.getByTestId(`pr-cycle-resume-error-${REPO_ID}`).props.children).toBe(
        "C'è già un job in corso su questo ticket",
      ),
    );
    expect(invalidatedKeys()).not.toContainEqual(workKeys.all(TICKET_ID));
    await settleMutations(queryClient);
  });

  test("403 `needs_maintainer`: la frase del maintainer sotto la riga", async () => {
    const { client, runAi } = makeClient();
    runAi.mockRejectedValue(new ApiError(403, "…", "needs_maintainer"));
    const { queryClient } = await renderSection(client, [repo({ cycle: heldCycle() })]);

    await fireEvent.press(screen.getByTestId(`pr-cycle-resume-${REPO_ID}`));

    await waitFor(() =>
      expect(screen.getByTestId(`pr-cycle-resume-error-${REPO_ID}`).props.children).toBe(
        "Questa correzione è ferma per budget esaurito: solo un maintainer può riprenderla, chiedilo a uno di loro",
      ),
    );
    await settleMutations(queryClient);
  });

  test("l'errore sta sotto la riga che l'ha prodotto, non sotto le altre", async () => {
    const { client, runAi } = makeClient();
    runAi.mockRejectedValue(new ApiError(403, "…", "needs_maintainer"));
    const { queryClient } = await renderSection(client, [
      repo({ cycle: heldCycle() }),
      repo({ repositoryId: OTHER_REPO_ID, repositoryName: "API", prUrl: `${PR_URL}1`, cycle: heldCycle() }),
    ]);

    await fireEvent.press(screen.getByTestId(`pr-cycle-resume-${OTHER_REPO_ID}`));

    await waitFor(() => expect(screen.getByTestId(`pr-cycle-resume-error-${OTHER_REPO_ID}`)).toBeTruthy());
    expect(screen.queryByTestId(`pr-cycle-resume-error-${REPO_ID}`)).toBeNull();
    await settleMutations(queryClient);
  });

  test("PR mergiata con una correzione ferma: «Riprendi» sì, «Applica» no", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ prState: "merged", cycle: heldCycle() })]);
    expect(screen.getByTestId(`pr-cycle-resume-${REPO_ID}`)).toBeTruthy();
    expect(screen.queryByTestId(`pr-cycle-request-${REPO_ID}`)).toBeNull();
  });

  test("una ripresa in volo su una riga spegne le azioni delle ALTRE righe", async () => {
    const { client, runAi } = makeClient();
    runAi.mockReturnValue(new Promise(() => {}));
    await renderSection(client, [
      repo({ cycle: heldCycle() }),
      repo({
        repositoryId: OTHER_REPO_ID,
        repositoryName: "API",
        prUrl: `${PR_URL}1`,
        cycle: heldCycle({ canRequestCorrection: true }),
      }),
    ]);
    // Prima della ripresa entrambe le azioni dell'altra riga sono accese: è
    // quello che fa discriminare le due asserzioni sotto.
    expect(screen.getByTestId(`pr-cycle-resume-${OTHER_REPO_ID}`).props.accessibilityState?.disabled).toBe(false);
    expect(screen.getByTestId(`pr-cycle-request-${OTHER_REPO_ID}`).props.accessibilityState?.disabled).toBe(false);

    await fireEvent.press(screen.getByTestId(`pr-cycle-resume-${REPO_ID}`));

    await waitFor(() =>
      expect(screen.getByTestId(`pr-cycle-resume-${OTHER_REPO_ID}`).props.accessibilityState?.disabled).toBe(true),
    );
    expect(screen.getByTestId(`pr-cycle-request-${OTHER_REPO_ID}`).props.accessibilityState?.disabled).toBe(true);
    // «Ripresa…» la dice solo la riga che ha premuto.
    expect(screen.getAllByText("Ripresa…")).toHaveLength(1);
  });

  test("due tap su righe diverse prima del render: l'esito va sotto la riga PARTITA, non l'ultima", async () => {
    const { client, runAi } = makeClient();
    let rejectFirst: (error: unknown) => void = () => {};
    runAi.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    // Una spia sul `resume` che l'hook restituisce: prova che ENTRAMBI i tap
    // sono arrivati al gestore (altrimenti «una sola run-ai» passerebbe anche
    // se il secondo tap non fosse mai partito, e il test sarebbe vacuo) e che
    // la guardia ha scartato il secondo (`false`).
    const realUseResume = correctionMutations.useResumeCorrection;
    const resumeResults: boolean[] = [];
    const useResumeSpy = jest.spyOn(correctionMutations, "useResumeCorrection").mockImplementation((ticketId) => {
      const real = realUseResume(ticketId);
      return {
        ...real,
        resume: (heldJobId, onDone) => {
          const started = real.resume(heldJobId, onDone);
          resumeResults.push(started);
          return started;
        },
      };
    });
    const { queryClient } = await renderSection(client, [
      repo({ cycle: heldCycle() }),
      repo({ repositoryId: OTHER_REPO_ID, repositoryName: "API", prUrl: `${PR_URL}1`, cycle: heldCycle() }),
    ]);
    const first = screen.getByTestId(`pr-cycle-resume-${REPO_ID}`);
    const second = screen.getByTestId(`pr-cycle-resume-${OTHER_REPO_ID}`);

    // I due tap nello STESSO frame: entrambi dentro un solo `act`, quindi il
    // secondo arriva su un bottone ancora acceso — nessun render in mezzo che
    // lo spenga. `fireEvent.press` non lo permette (ogni chiamata è un `act`
    // a sé, e il render dopo il primo spegne già il secondo bottone): si
    // chiama il gestore che il `Pressable` espone sull'host, quello che
    // React Native usa per l'attivazione da tastiera e accessibilità.
    const tap = (element: typeof first) =>
      (element.props.onClick as (event: { nativeEvent: object }) => void)({ nativeEvent: {} });
    await act(async () => {
      tap(first);
      tap(second);
    });
    expect(resumeResults).toEqual([true, false]);
    expect(runAi).toHaveBeenCalledTimes(1);
    expect(runAi).toHaveBeenCalledWith(TICKET_ID, { resumeCorrectionJobId: HELD_JOB_ID });

    await act(async () => {
      rejectFirst(new ApiError(403, "…", "needs_maintainer"));
    });

    await waitFor(() => expect(screen.getByTestId(`pr-cycle-resume-error-${REPO_ID}`)).toBeTruthy());
    expect(screen.queryByTestId(`pr-cycle-resume-error-${OTHER_REPO_ID}`)).toBeNull();
    await settleMutations(queryClient);
    useResumeSpy.mockRestore();
  });

  test("l'errore di ripresa sparisce aprendo il pannello di «Applica»", async () => {
    const { client, runAi } = makeClient();
    runAi.mockRejectedValue(new ApiError(403, "…", "needs_maintainer"));
    const { queryClient } = await renderSection(client, [
      repo({ cycle: heldCycle({ canRequestCorrection: true }) }),
    ]);

    await fireEvent.press(screen.getByTestId(`pr-cycle-resume-${REPO_ID}`));
    await waitFor(() => expect(screen.getByTestId(`pr-cycle-resume-error-${REPO_ID}`)).toBeTruthy());
    await settleMutations(queryClient);

    await fireEvent.press(screen.getByTestId(`pr-cycle-request-${REPO_ID}`));
    await waitFor(() => expect(screen.getByTestId("correction-sheet-note")).toBeTruthy());
    expect(screen.queryByTestId(`pr-cycle-resume-error-${REPO_ID}`)).toBeNull();
  });

  test("l'errore di ripresa sparisce dopo una ripresa riuscita", async () => {
    const { client, runAi } = makeClient();
    runAi.mockRejectedValueOnce(new ApiError(409, "…", "job_in_flight"));
    const { queryClient } = await renderSection(client, [repo({ cycle: heldCycle() })]);

    await fireEvent.press(screen.getByTestId(`pr-cycle-resume-${REPO_ID}`));
    await waitFor(() => expect(screen.getByTestId(`pr-cycle-resume-error-${REPO_ID}`)).toBeTruthy());
    await settleMutations(queryClient);

    await fireEvent.press(screen.getByTestId(`pr-cycle-resume-${REPO_ID}`));
    await waitFor(() => expect(runAi).toHaveBeenCalledTimes(2));
    await settleMutations(queryClient);
    expect(screen.queryByTestId(`pr-cycle-resume-error-${REPO_ID}`)).toBeNull();
  });
});

describe("PrCycleSection — senza rete", () => {
  const OFFLINE_TEXT = "// senza rete non si chiedono né si riprendono correzioni";

  beforeEach(() => {
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
  });

  test("«Riprendi» spento, e la sezione dice perché", async () => {
    const { client, runAi } = makeClient();
    await renderSection(client, [repo({ cycle: heldCycle() })]);

    expect(screen.getByTestId(`pr-cycle-resume-${REPO_ID}`).props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByTestId("pr-cycle-offline").props.children).toBe(OFFLINE_TEXT);
    await fireEvent.press(screen.getByTestId(`pr-cycle-resume-${REPO_ID}`));
    expect(runAi).not.toHaveBeenCalled();
  });

  test("anche quando l'unica azione è «Applica»: spento, e la frase c'è", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ cycle: cycle({ canRequestCorrection: true }) })]);

    expect(screen.getByTestId(`pr-cycle-request-${REPO_ID}`).props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByTestId("pr-cycle-offline").props.children).toBe(OFFLINE_TEXT);
  });

  test("una frase sola per la sezione, anche con più righe", async () => {
    const { client } = makeClient();
    await renderSection(client, [
      repo({ cycle: heldCycle() }),
      repo({ repositoryId: OTHER_REPO_ID, repositoryName: "API", prUrl: `${PR_URL}1` }),
    ]);
    expect(screen.getAllByText(OFFLINE_TEXT)).toHaveLength(1);
  });

  test("nessuna azione offerta (PR chiusa, nessuna correzione ferma): nessuna frase", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ prState: "merged", cycle: cycle({ state: "approved", canRequestCorrection: false }) })]);
    expect(screen.queryByTestId("pr-cycle-offline")).toBeNull();
  });
});

describe("PrCycleSection — con la rete", () => {
  test("nessun avviso di rete", async () => {
    const { client } = makeClient();
    await renderSection(client, [repo({ cycle: heldCycle() })]);
    expect(screen.queryByTestId("pr-cycle-offline")).toBeNull();
  });
});

/**
 * La schermata del ticket può passare a un ALTRO ticket senza smontare la
 * sezione (stessa rotta, parametro diverso): lo stato locale — l'errore di
 * ripresa sotto una riga, il pannello aperto su un repository — era di quel
 * ticket, e non deve comparire sotto le PR dell'altro, che possono avere gli
 * STESSI repository.
 */
describe("PrCycleSection — cambiare ticket senza smontare azzera lo stato locale", () => {
  test("l'errore di ripresa del ticket di prima sparisce", async () => {
    const { client, runAi } = makeClient();
    runAi.mockRejectedValue(new ApiError(403, "…", "needs_maintainer"));
    const { queryClient, rerenderWith } = await renderSection(client, [repo({ cycle: heldCycle() })]);

    await fireEvent.press(screen.getByTestId(`pr-cycle-resume-${REPO_ID}`));
    await waitFor(() => expect(screen.getByTestId(`pr-cycle-resume-error-${REPO_ID}`)).toBeTruthy());
    await settleMutations(queryClient);

    await rerenderWith(OTHER_TICKET_ID, [repo({ cycle: heldCycle() })]);

    expect(screen.getByTestId(`pr-cycle-resume-${REPO_ID}`)).toBeTruthy();
    expect(screen.queryByTestId(`pr-cycle-resume-error-${REPO_ID}`)).toBeNull();
  });

  test("il pannello aperto sul ticket di prima si chiude", async () => {
    const { client, requestCorrection } = makeClient();
    const { rerenderWith } = await renderSection(client, [repo()]);

    await fireEvent.press(screen.getByTestId(`pr-cycle-request-${REPO_ID}`));
    await waitFor(() => expect(screen.getByTestId("correction-sheet-note")).toBeTruthy());

    await rerenderWith(OTHER_TICKET_ID, [repo()]);

    expect(screen.getByTestId(`pr-cycle-request-${REPO_ID}`)).toBeTruthy();
    expect(screen.queryByTestId("correction-sheet-note")).toBeNull();
    expect(requestCorrection).not.toHaveBeenCalled();
  });
});

test("la fixture `cycle()` è un ciclo valido per lo schema (niente campi inventati o mancanti)", () => {
  expect(() => prCycleSchema.strict().parse(cycle())).not.toThrow();
  expect(() => prCycleSchema.strict().parse(heldCycle())).not.toThrow();
});
