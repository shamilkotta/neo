import { createStore } from "./store";

export type Theme = "light" | "dark" | "system";

const stored = (): Theme => {
  const t = localStorage.getItem("neo.theme");
  return t === "light" || t === "dark" ? t : "system";
};

export const theme = createStore<Theme>(stored());

const media = matchMedia("(prefers-color-scheme: dark)");

function apply() {
  const t = theme.get();
  const dark = t === "dark" || (t === "system" && media.matches);
  document.documentElement.classList.toggle("dark", dark);
}

media.addEventListener("change", apply);

export function setTheme(t: Theme) {
  if (t === "system") localStorage.removeItem("neo.theme");
  else localStorage.setItem("neo.theme", t);
  theme.set(t);
  apply();
}

export const cycleTheme = () =>
  setTheme(
    ({ system: "light", light: "dark", dark: "system" } as const)[theme.get()],
  );
