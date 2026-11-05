"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type ToastKind = "pending" | "success" | "error";
export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  href?: string;
}

interface ToastApi {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => number;
  update: (id: number, t: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const scheduleDismiss = useCallback((id: number, kind: ToastKind) => {
    if (kind !== "pending") setTimeout(() => dismiss(id), kind === "error" ? 7000 : 4500);
  }, [dismiss]);

  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId++;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      scheduleDismiss(id, t.kind);
      return id;
    },
    [scheduleDismiss],
  );

  const update = useCallback(
    (id: number, patch: Partial<Omit<Toast, "id">>) => {
      setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      if (patch.kind) scheduleDismiss(id, patch.kind);
    },
    [scheduleDismiss],
  );

  const value = useMemo(() => ({ toasts, push, update, dismiss }), [toasts, push, update, dismiss]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useToasts() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToasts must be used inside ToastProvider");
  return v;
}
