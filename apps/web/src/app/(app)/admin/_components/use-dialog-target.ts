"use client";

import { useCallback, useState } from "react";

/**
 * Open state plus the item a dialog acts on. Closing only flips `open`; the target is kept until
 * the next `show`, so the dialog's title and text stay intact during its close animation.
 */
export function useDialogTarget<T>() {
  const [state, setState] = useState<{ open: boolean; target: T | null }>({ open: false, target: null });
  const show = useCallback((target: T) => setState({ open: true, target }), []);
  const onOpenChange = useCallback((open: boolean) => setState((current) => ({ ...current, open })), []);
  return { open: state.open, target: state.target, show, onOpenChange };
}
