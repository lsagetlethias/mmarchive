import type { Channel } from "../client/archive-client.js";

export type ChannelOrder = "activite" | "nom-asc" | "nom-desc" | "messages-desc" | "messages-asc";

export const CHANNEL_ORDERS: readonly { readonly value: ChannelOrder; readonly label: string }[] = [
  { value: "activite", label: "Activite recente" },
  { value: "nom-asc", label: "Nom, de A a Z" },
  { value: "nom-desc", label: "Nom, de Z a A" },
  { value: "messages-desc", label: "Plus de messages" },
  { value: "messages-asc", label: "Moins de messages" },
];

export function parseChannelOrder(value: string): ChannelOrder {
  return CHANNEL_ORDERS.find((order) => order.value === value)?.value ?? "activite";
}

const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });

function byName(a: Channel, b: Channel): number {
  return collator.compare(a.displayName, b.displayName);
}

export function sortChannels(
  channels: readonly Channel[],
  order: ChannelOrder,
): readonly Channel[] {
  switch (order) {
    // L index livre deja les canaux du plus recemment actif au plus ancien.
    case "activite":
      return channels;
    case "nom-asc":
      return channels.toSorted(byName);
    case "nom-desc":
      return channels.toSorted((a, b) => byName(b, a));
    case "messages-desc":
      return channels.toSorted((a, b) => b.posts - a.posts || byName(a, b));
    case "messages-asc":
      return channels.toSorted((a, b) => a.posts - b.posts || byName(a, b));
  }
}
