import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/** La riduzione del movimento di sistema: letta all'avvio e seguita nei cambi. */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive) setReduce(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      alive = false;
      subscription?.remove();
    };
  }, []);
  return reduce;
}
