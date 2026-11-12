import { createStore } from "../lib/store";

export type DetailsTab = "profile" | "routines" | "files";
export type SettingsSection = "general" | "providers" | "about";

const wide = () => matchMedia("(min-width: 900px)").matches;

export const ui = {
  sidebar: createStore<boolean>(wide() && localStorage.getItem("neo.sidebar") !== "closed"),
  details: createStore<DetailsTab | null>(null),
  settings: createStore<SettingsSection | null>(null),
  palette: createStore(false),
  newAgent: createStore(false),
};

export function toggleSidebar(open = !ui.sidebar.get()) {
  ui.sidebar.set(open);
  if (wide()) localStorage.setItem("neo.sidebar", open ? "open" : "closed");
}

export const closeSidebarOnMobile = () => {
  if (!wide()) ui.sidebar.set(false);
};
