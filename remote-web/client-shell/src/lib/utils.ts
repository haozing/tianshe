import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function currentRoute() {
  const query = new URLSearchParams(window.location.search);
  return query.get("route") || window.location.hash.replace(/^#/, "") || "/stores";
}

export function navigate(route: string) {
  window.location.hash = route;
}

export function isActiveRoute(current: string, route: string) {
  if (route === "/") return current === "/";
  return current === route || current.startsWith(route + "/");
}
