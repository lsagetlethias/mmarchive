import { useEffect, useState } from "react";

export type Route =
  | { readonly view: "accueil" }
  | { readonly view: "canal"; readonly channelId: number; readonly focusId?: number }
  | { readonly view: "recherche"; readonly query: string }
  | { readonly view: "annuaire" }
  /** Permalien Mattermost : l identifiant d origine, a resoudre. */
  | { readonly view: "permalien"; readonly pid: string };

/**
 * Routage par fragment plutot que par chemin.
 *
 * Le fragment ne demande aucune reecriture cote serveur, et surtout il survit a
 * une ouverture par double clic depuis le disque : le mode lite doit fonctionner
 * sans serveur du tout.
 */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  const parts = path.split("/").filter((part) => part !== "");
  const [head, first, second, third] = parts;

  if (head === "canal" && first !== undefined) {
    const channelId = Number(first);
    if (Number.isInteger(channelId) && channelId > 0) {
      const focusId = second === "m" && third !== undefined ? Number(third) : Number.NaN;
      return Number.isInteger(focusId) && focusId > 0
        ? { view: "canal", channelId, focusId }
        : { view: "canal", channelId };
    }
  }
  if (head === "recherche") {
    return { view: "recherche", query: decodeURIComponent(parts.slice(1).join("/")) };
  }
  if (head === "annuaire") return { view: "annuaire" };
  if (head === "message" && first !== undefined) return { view: "permalien", pid: first };
  return { view: "accueil" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(globalThis.location.hash));
  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseRoute(globalThis.location.hash));
    };
    globalThis.addEventListener("hashchange", onChange);
    return () => {
      globalThis.removeEventListener("hashchange", onChange);
    };
  }, []);
  return route;
}

export function navigate(to: string): void {
  globalThis.location.hash = to;
}

export function channelHref(channelId: number, messageId?: number): string {
  return messageId === undefined
    ? `#/canal/${String(channelId)}`
    : `#/canal/${String(channelId)}/m/${String(messageId)}`;
}

export function searchHref(query: string): string {
  return `#/recherche/${encodeURIComponent(query)}`;
}
