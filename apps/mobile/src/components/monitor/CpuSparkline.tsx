import { Svg, Polyline, Line } from "react-native-svg";
import { colors } from "../../theme/tokens";

/**
 * Lo STORICO DELLA CPU di un server (23 set 2026, hub di progetto, tappa 3):
 * gli ultimi campioni che la rotta manda in `recentCpu`, dal più vecchio al
 * più recente.
 *
 * Con `react-native-svg`, già dipendenza dell'app per le icone: nessuna
 * libreria di grafici, nessun build nativo da rifare.
 *
 * ⚠️ La scala verticale è FISSA 0–100, non adattata ai dati: una CPU che
 * oscilla fra 2% e 4% disegnata su una scala 2–4 sembrerebbe un server in
 * affanno. È un grafico che si guarda per sapere «quanto è carico», e la
 * risposta dipende dal livello assoluto, non dalla forma.
 *
 * Con meno di due punti non c'è una linea da disegnare: il componente non
 * rende niente, e il valore attuale (scritto accanto dal chiamante) basta.
 */
export function CpuSparkline({
  values,
  width = 280,
  height = 48,
  testID,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  testID?: string;
}) {
  if (values.length < 2) return null;
  const step = width / (values.length - 1);
  const y = (pct: number) => height - (Math.min(100, Math.max(0, pct)) / 100) * height;
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" testID={testID}>
      <Line x1={0} y1={height - 0.5} x2={width} y2={height - 0.5} stroke={colors.line} strokeWidth={1} />
      <Polyline points={points} fill="none" stroke={colors.signal} strokeWidth={1.5} />
    </Svg>
  );
}
