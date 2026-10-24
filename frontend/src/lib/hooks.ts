import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export interface Loadable<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  updatedAt: Date | null;
  reload: () => void;
}

/** Fetch on mount and every `intervalMs` (0 = once). Keeps last good data on error. */
export function useApi<T>(path: string | null, intervalMs = 0): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const alive = useRef(true);

  const load = useCallback(() => {
    if (!path) return;
    api
      .get<T>(path)
      .then((d) => {
        if (!alive.current) return;
        setData(d);
        setError(null);
        setUpdatedAt(new Date());
      })
      .catch((e: Error) => alive.current && setError(e.message))
      .finally(() => alive.current && setLoading(false));
  }, [path]);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    load();
    if (!intervalMs) return () => void (alive.current = false);
    const t = window.setInterval(load, intervalMs);
    return () => {
      alive.current = false;
      window.clearInterval(t);
    };
  }, [load, intervalMs]);

  return { data, error, loading, updatedAt, reload: load };
}
