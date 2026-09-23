import { act, screen } from "@testing-library/react-native";

/**
 * Fa scattare il «trascina per aggiornare» di una schermata, nei test.
 *
 * Il `RefreshControl` passa come PROP (`refreshControl`) allo `ScrollView`, e
 * il mock di `ScrollView` di React Native non lo rende come figlio: cercarlo
 * per `testID` non lo trova. È però nelle props del nodo nell'albero
 * serializzato, ed è lì che lo si prende — per `testID`, così un test non può
 * far scattare per sbaglio quello di un'altra schermata.
 */
type Node = { props?: Record<string, unknown>; children?: unknown };

function findRefreshControl(tree: unknown, testID: string): { props: { onRefresh: () => void; refreshing: boolean } } | null {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = findRefreshControl(child, testID);
      if (found) return found;
    }
    return null;
  }
  if (tree === null || typeof tree !== "object") return null;
  const node = tree as Node;
  const control = node.props?.refreshControl as { props?: { testID?: string } } | undefined;
  if (control?.props?.testID === testID) return control as never;
  return findRefreshControl(node.children, testID);
}

export function refreshControlOf(testID: string): { onRefresh: () => void; refreshing: boolean } {
  const control = findRefreshControl(screen.toJSON(), testID);
  if (control === null) throw new Error(`nessun RefreshControl con testID ${testID}`);
  return control.props;
}

export async function pullToRefresh(testID: string): Promise<void> {
  const { onRefresh } = refreshControlOf(testID);
  await act(async () => {
    onRefresh();
  });
}
