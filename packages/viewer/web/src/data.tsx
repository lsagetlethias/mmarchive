import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { ArchiveClient, Channel, MetaInfo, User } from "./client/archive-client.js";
import { standardEmoji } from "./ui/emoji.js";
import type { RenderContext } from "./ui/markdown.js";

/**
 * Referentiels charges une fois pour toutes.
 *
 * Canaux, utilisateurs et emojis personnalises sont petits (quelques milliers
 * d entrees) et servent a chaque message affiche, pour resoudre un auteur, une
 * mention ou une reaction. Les redemander a chaque page ferait un appel par
 * message rendu.
 */
export interface Archive {
  readonly client: ArchiveClient;
  readonly meta: MetaInfo;
  readonly channels: readonly Channel[];
  readonly channelById: ReadonlyMap<number, Channel>;
  readonly userById: ReadonlyMap<number, User>;
  readonly render: RenderContext;
}

const ArchiveContext = createContext<Archive | undefined>(undefined);

export function useArchive(): Archive {
  const archive = useContext(ArchiveContext);
  if (archive === undefined) throw new Error("Archive non chargee.");
  return archive;
}

export type LoadState =
  | { readonly status: "chargement" }
  | { readonly status: "pret"; readonly archive: Archive }
  | { readonly status: "erreur"; readonly message: string };

export function ArchiveProvider({
  client,
  children,
  fallback,
}: {
  readonly client: ArchiveClient;
  readonly children: ReactNode;
  readonly fallback: (state: LoadState) => ReactNode;
}): ReactNode {
  const [state, setState] = useState<LoadState>({ status: "chargement" });

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const [meta, channels, users, emojis] = await Promise.all([
        client.meta(),
        client.channels(),
        client.users(),
        client.customEmojis(),
      ]);
      if (cancelled) return;

      const channelById = new Map(channels.map((channel) => [channel.id, channel]));
      const userById = new Map(users.map((user) => [user.id, user]));
      const customEmojis = new Set(emojis);
      const render: RenderContext = {
        usernames: new Set(users.map((user) => user.username.toLowerCase())),
        channels: new Map(channels.map((channel) => [channel.name.toLowerCase(), channel.id])),
        customEmojis,
        emojiUrl: (name) => client.emojiUrl(name),
        standardEmoji,
      };
      setState({
        status: "pret",
        archive: { client, meta, channels, channelById, userById, render },
      });
    };
    load().catch((error: unknown) => {
      if (cancelled) return;
      setState({
        status: "erreur",
        message: error instanceof Error ? error.message : "chargement impossible",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (state.status !== "pret") return fallback(state);
  return <ArchiveContext value={state.archive}>{children}</ArchiveContext>;
}

/**
 * Adresse d un avatar ou d un emoji, quel que soit le mode.
 *
 * Servi par un serveur, l adresse est connue immediatement. Lu depuis un index
 * sans serveur, l image vit dans le fichier et doit en etre extraite : le
 * composant affiche alors son repli jusqu a ce qu elle arrive.
 */
export function useAssetUrl(kind: "avatar" | "emoji", key: string | null): string | undefined {
  const { client } = useArchive();
  const direct =
    key === null ? "" : kind === "avatar" ? client.avatarUrl(key) : client.emojiUrl(key);
  const [resolved, setResolved] = useState<string | undefined>(direct === "" ? undefined : direct);

  useEffect(() => {
    if (key === null || direct !== "") {
      setResolved(direct === "" ? undefined : direct);
      return;
    }
    const loader = (client as { loadAsset?: (k: string, v: string) => Promise<string | null> })
      .loadAsset;
    if (loader === undefined) return;
    let cancelled = false;
    loader
      .call(client, kind, key)
      .then((url) => {
        if (!cancelled && url !== null) setResolved(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, kind, key, direct]);

  return resolved;
}

/** Nom affichable d un auteur, avec repli lisible quand le compte est inconnu. */
export function useAuthor(userId: number | null): { name: string; user: User | undefined } {
  const { userById } = useArchive();
  return useMemo(() => {
    if (userId === null) return { name: "Compte inconnu", user: undefined };
    const user = userById.get(userId);
    return { name: user?.display ?? user?.username ?? "Compte inconnu", user };
  }, [userId, userById]);
}

const DATE_FORMAT = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const TIME_FORMAT = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

export function formatDate(ms: number): string {
  return DATE_FORMAT.format(new Date(ms));
}

export function formatTime(ms: number): string {
  return TIME_FORMAT.format(new Date(ms));
}

/**
 * Cle de jour, dans le fuseau du lecteur.
 *
 * toISOString donnerait le jour en temps universel, alors que l heure et la date
 * affichees sont locales : autour de minuit, le separateur de jour annoncerait
 * une date et les messages en dessous en porteraient une autre.
 */
export function formatDay(ms: number): string {
  const date = new Date(ms);
  const mois = String(date.getMonth() + 1).padStart(2, "0");
  const jour = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear())}-${mois}-${jour}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} o`;
  const units = ["Ko", "Mo", "Go"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit] ?? ""}`;
}
