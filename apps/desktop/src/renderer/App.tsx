import { ThemeProvider } from "./theme/ThemeProvider";

export function App() {
  return (
    <ThemeProvider>
      <main className="h-full bg-ground text-ink">
        <h1 className="text-2xl font-semibold">Stubwise</h1>
      </main>
    </ThemeProvider>
  );
}
