/**
 * Tracks one user-triggered write. Unlike a cached mutation, the arguments are
 * never retained after the call, so a webhook URL passed to a write does not
 * linger in any cache.
 */

import { useCallback, useRef, useState } from "react";

export interface ActionState {
  pending: boolean;
  error: unknown;
}

export function useAction() {
  const [state, setState] = useState<ActionState>({ pending: false, error: null });
  const running = useRef(false);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
    if (running.current) return { ok: false };
    running.current = true;
    setState({ pending: true, error: null });
    try {
      const value = await fn();
      setState({ pending: false, error: null });
      return { ok: true, value };
    } catch (error) {
      setState({ pending: false, error });
      return { ok: false };
    } finally {
      running.current = false;
    }
  }, []);

  const reset = useCallback(() => setState({ pending: false, error: null }), []);

  return { ...state, run, reset };
}
