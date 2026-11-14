import { createStore } from "./store";
import { errorText } from "./format";

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
}

export const toasts = createStore<Toast[]>([]);
let next = 1;

export function toast(text: string, kind: Toast["kind"] = "info") {
  const id = next++;
  toasts.set((all) => [...all.slice(-3), { id, kind, text }]);
  setTimeout(() => dismiss(id), kind === "error" ? 6000 : 3200);
}

export const dismiss = (id: number) =>
  toasts.set((all) => all.filter((t) => t.id !== id));

export async function attempt<T>(
  fn: () => Promise<T>,
  done?: string,
): Promise<T | undefined> {
  try {
    const value = await fn();
    if (done) toast(done, "success");
    return value;
  } catch (e) {
    toast(errorText(e), "error");
    return undefined;
  }
}
