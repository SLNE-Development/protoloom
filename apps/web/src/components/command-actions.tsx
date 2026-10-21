"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** A page-specific entry in the command dialog's "Actions" group. */
export interface CommandAction {
  /** Unique among the actions on screen; also the cmdk item value. */
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Extra words the filter matches. */
  keywords?: string[];
  onSelect: () => void;
}

interface CommandMenuState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Page actions currently registered, in registration order. */
  actions: CommandAction[];
  register: (owner: symbol, actions: CommandAction[]) => void;
  unregister: (owner: symbol) => void;
}

const CommandMenuContext = createContext<CommandMenuState | null>(null);

/** Holds the command dialog's open state and the actions pages register. Mounted once in the app shell. */
export function CommandMenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [registry, setRegistry] = useState<Map<symbol, CommandAction[]>>(() => new Map());

  const register = useCallback((owner: symbol, actions: CommandAction[]) => {
    setRegistry((current) => new Map(current).set(owner, actions));
  }, []);
  const unregister = useCallback((owner: symbol) => {
    setRegistry((current) => {
      const next = new Map(current);
      next.delete(owner);
      return next;
    });
  }, []);
  const toggle = useCallback(() => setOpen((value) => !value), []);

  const value = useMemo<CommandMenuState>(
    () => ({ open, setOpen, toggle, actions: [...registry.values()].flat(), register, unregister }),
    [open, toggle, registry, register, unregister],
  );
  return <CommandMenuContext.Provider value={value}>{children}</CommandMenuContext.Provider>;
}

/** The command dialog's state; throws outside {@link CommandMenuProvider}. */
export function useCommandMenu(): CommandMenuState {
  const state = useContext(CommandMenuContext);
  if (!state) throw new Error("useCommandMenu must be used inside CommandMenuProvider");
  return state;
}

/**
 * Registers page-specific command dialog actions (for example "Copy coordinate" on a version
 * page) while the calling component is mounted. The latest `actions` are used without
 * re-registering on every render; changing the set of ids re-registers.
 */
export function useCommandActions(actions: CommandAction[]): void {
  const { register, unregister } = useCommandMenu();
  const owner = useRef(Symbol("command-actions")).current;
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });
  const ids = actions.map((action) => `${action.id}\u0000${action.label}`).join("\u0001");

  useEffect(() => {
    register(
      owner,
      latest.current.map((action) => ({
        ...action,
        onSelect: () => latest.current.find((current) => current.id === action.id)?.onSelect(),
      })),
    );
    return () => unregister(owner);
  }, [ids, owner, register, unregister]);
}
