import { act, render } from "@testing-library/react-native";
import { Text } from "react-native";
import "../../i18n";
import { WISEY_STAGE_MS, WISEY_WORD_MS } from "../../lib/wisey-phase";
import { useWisey, WiseyProvider, type WiseyStore } from "./WiseyProvider";

/**
 * LO STATO DI WISEY, sopra il navigator (design §10). La schermata e
 * l'icona della barra leggono lo stesso store; i timer della risposta finta
 * vivono qui, così una risposta prosegue e finisce anche fuori dalla tab.
 */
let store: WiseyStore;

function Probe() {
  store = useWisey();
  return <Text>{store.phase}</Text>;
}

async function mount() {
  await render(
    <WiseyProvider>
      <Probe />
    </WiseyProvider>,
  );
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

/**
 * Fino all'ultima parola della risposta, e NON oltre: un tempo largo a caso
 * (tipo 200 parole) coprirebbe anche il giro di «fatto» e nasconderebbe
 * proprio la differenza fra «resta» e «torna a riposo».
 */
async function finishAnswer() {
  await advance(WISEY_STAGE_MS.thinking);
  for (let step = 0; step < 500 && store.stage === "answering"; step += 1) {
    await advance(WISEY_WORD_MS);
  }
  expect(store.stage).not.toBe("answering");
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("WiseyProvider", () => {
  test("una risposta finita mentre la tab Wisey NON è a fuoco resta su «fatto»", async () => {
    await mount();
    await act(async () => store.setTabFocused(true));
    await act(async () => store.send("Come va il mio progetto?"));
    await act(async () => store.setTabFocused(false));
    await finishAnswer();
    expect(store.phase).toBe("done");
    // …e ci resta, per quanto tempo passi.
    await advance(60_000);
    expect(store.phase).toBe("done");
    expect(store.doneUnseen).toBe(true);
  });

  test("aprendo la tab, «fatto» fa un giro e poi torna a riposo", async () => {
    await mount();
    await act(async () => store.send("Come va il mio progetto?"));
    await finishAnswer();
    expect(store.phase).toBe("done");

    await act(async () => store.setTabFocused(true));
    expect(store.doneUnseen).toBe(false);
    expect(store.phase).toBe("done");
    await advance(WISEY_STAGE_MS.done - 1);
    expect(store.phase).toBe("done");
    await advance(1);
    expect(store.phase).toBe("rest");
  });

  test("una risposta finita sulla tab Wisey fa un giro di «fatto» e torna a riposo, come prima", async () => {
    await mount();
    await act(async () => store.setTabFocused(true));
    await act(async () => store.send("Come va il mio progetto?"));
    await finishAnswer();
    expect(store.phase).toBe("done");
    expect(store.doneUnseen).toBe(false);
    await advance(WISEY_STAGE_MS.done);
    expect(store.phase).toBe("rest");
  });

  test("la risposta prosegue anche uscendo dalla tab a metà", async () => {
    await mount();
    await act(async () => store.setTabFocused(true));
    await act(async () => store.send("Come va il mio progetto?"));
    expect(store.phase).toBe("think");
    await act(async () => store.setTabFocused(false));
    await finishAnswer();
    const last = store.messages[store.messages.length - 1]!;
    expect(last.role).toBe("wisey");
    expect(store.visibleText(store.messages.length - 1)).toBe(last.text);
  });

  test("il campo: fuoco e testo fanno «ti ascolta», e un invio svuota il testo", async () => {
    await mount();
    await act(async () => store.setTabFocused(true));
    await act(async () => store.setDraft("ciao"));
    expect(store.phase).toBe("listen");
    expect(store.canSend).toBe(true);
    await act(async () => store.send(store.draft));
    expect(store.draft).toBe("");
    expect(store.canSend).toBe(false);
  });
});
