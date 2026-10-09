import { openAgentSession, replaceWithAgentSession } from "./open-agent-session";

function fakeNavigation(stackKey = "stack-inbox") {
  const calls: string[] = [];
  const navigate = jest.fn(() => calls.push("navigate"));
  const dispatch = jest.fn(() => calls.push("dispatch"));
  const getState = jest.fn(() => ({ key: stackKey }));
  return { navigation: { navigate, dispatch, getState }, navigate, dispatch, calls };
}

describe("openAgentSession", () => {
  test("riapre la sessione che c'è già invece di impilarne un doppione (`pop: true`)", () => {
    const { navigation, navigate } = fakeNavigation();
    openAgentSession(navigation, { id: "s1" });
    expect(navigate).toHaveBeenCalledWith("AgentSession", { id: "s1" }, { pop: true });
  });
});

describe("replaceWithAgentSession", () => {
  test("apre la sessione, POI toglie la schermata col pop mirato al SUO stack", () => {
    const { navigation, navigate, dispatch, calls } = fakeNavigation("stack-inbox");
    replaceWithAgentSession(navigation, { id: "s1", focus: "question" });
    expect(navigate).toHaveBeenCalledWith("AgentSession", { id: "s1", focus: "question" }, { pop: true });
    // Il bersaglio è lo stack della schermata: un pop che non trova niente da
    // togliere lì NON sale al root (dove chiuderebbe la sessione appena aperta).
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "POP", target: "stack-inbox" }));
    expect(calls).toEqual(["navigate", "dispatch"]);
  });

  test("il bersaglio è letto PRIMA di aprire la sessione", () => {
    const { navigation, dispatch } = fakeNavigation("stack-projects");
    navigation.navigate.mockImplementation(() => {
      navigation.getState.mockReturnValue({ key: "root" });
      return 0;
    });
    replaceWithAgentSession(navigation, { id: "s1" });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ target: "stack-projects" }));
  });
});
