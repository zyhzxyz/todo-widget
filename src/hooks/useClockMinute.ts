import { useEffect, useState } from "react";

/** Refresh date-dependent views at minute boundaries and after sleep/backgrounding. */
export function useClockMinute(): number {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const refresh = () => setMinute(Math.floor(Date.now() / 60_000));
    const timer = window.setInterval(refresh, 1000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return minute;
}
