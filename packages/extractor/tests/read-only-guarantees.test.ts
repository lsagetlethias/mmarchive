import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DECLARED_MUTATION_TEMPLATES, MM, type EndpointCall } from "../src/mattermost/endpoints.js";
import { ConsentViolationError, ForbiddenMutationError } from "../src/mattermost/errors.js";
import { MattermostClient } from "../src/mattermost/http-client.js";
import { MutationGate, grantConsent, noConsent } from "../src/mattermost/mutation-gate.js";

/** L URL d une requete fetch, quelle que soit la forme de son premier argument. */
function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const CHANNEL = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_CHANNEL = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const TEAM = "tttttttttttttttttttttttttt";
const USER = "uuuuuuuuuuuuuuuuuuuuuuuuuu";

/** Invoque chaque entree du catalogue avec des arguments plausibles. */
function everyEndpointCall(): EndpointCall[] {
  return [
    MM.getMe(),
    MM.ping(),
    MM.getClientConfig(),
    MM.getMyTeams(),
    MM.getAllTeams(0, 200),
    MM.getMyChannelsForTeam(TEAM),
    MM.getPublicChannelsForTeam(TEAM, 0, 200),
    MM.getDeletedChannelsForTeam(TEAM, 0, 200),
    MM.getChannel(CHANNEL),
    MM.getChannelPosts(CHANNEL, { perPage: 200 }),
    MM.getPinnedPosts(CHANNEL),
    MM.getUsersByIds([USER]),
    MM.getBulkReactions(["p".repeat(26)]),
    MM.getUserImage(USER),
    MM.getCustomEmojis(0, 200),
    MM.getEmojiImage("e".repeat(26)),
    MM.getFile("f".repeat(26)),
    MM.getFileInfo("f".repeat(26)),
    MM.addChannelMember(CHANNEL, USER),
    MM.removeChannelMember(CHANNEL, USER),
    MM.addTeamMember(TEAM, USER),
  ];
}

function fetchSpy(
  status = 200,
  body: unknown = {},
): {
  impl: typeof fetch;
  calls: { method: string; url: string }[];
} {
  const calls: { method: string; url: string }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: requestUrl(input) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function makeClient(fetchImpl: typeof fetch): MattermostClient {
  return new MattermostClient({
    baseUrl: "https://mm.example.org",
    token: "secret-token",
    rateLimit: 1000,
    sleep: async () => undefined,
    fetchImpl,
  });
}

describe("catalogue d endpoints", () => {
  it("ne declare aucune mutation en dehors des trois recensees", () => {
    const mutating = everyEndpointCall().filter((call) => call.mutates);
    const templates = [...new Set(mutating.map((c) => c.template))].sort();
    expect(templates).toEqual([...DECLARED_MUTATION_TEMPLATES].sort());
  });

  it("n autorise que deux POST de lecture, et ils sont documentes comme tels", () => {
    const readingPosts = everyEndpointCall().filter(
      (call) => call.method !== "GET" && !call.mutates,
    );
    expect(readingPosts.map((c) => c.template).sort()).toEqual([
      "/posts/ids/reactions",
      "/users/ids",
    ]);
  });

  it("n utilise jamais le parametre since de l API, incompatible avec la pagination", () => {
    const posts = MM.getChannelPosts(CHANNEL, { perPage: 200, before: "p".repeat(26) });
    expect(Object.keys(posts.query ?? {})).not.toContain("since");
  });

  it("encode les segments dynamiques pour empecher toute evasion de chemin", () => {
    const call = MM.getChannel("../../config");
    expect(call.path).toBe("/channels/..%2F..%2Fconfig");
    expect(call.path).not.toContain("/../");
  });

  it("garde les identifiants hors des gabarits utilises dans les logs", () => {
    for (const call of everyEndpointCall()) {
      expect(call.template).not.toContain(CHANNEL);
      expect(call.template).not.toContain(TEAM);
      expect(call.template).not.toContain(USER);
    }
  });
});

describe("client HTTP, refus des mutations", () => {
  it("refuse un endpoint mutant sans emettre la moindre requete", async () => {
    const { impl, calls } = fetchSpy();
    const client = makeClient(impl);

    await expect(client.json(MM.addChannelMember(CHANNEL, USER), z.unknown())).rejects.toThrow(
      ForbiddenMutationError,
    );
    await expect(client.json(MM.addTeamMember(TEAM, USER), z.unknown())).rejects.toThrow(
      ForbiddenMutationError,
    );
    await expect(client.binary(MM.removeChannelMember(CHANNEL, USER))).rejects.toThrow(
      ForbiddenMutationError,
    );

    expect(calls).toHaveLength(0);
  });

  it("n emet que des GET sur un parcours de lecture complet", async () => {
    const { impl, calls } = fetchSpy(200, []);
    const client = makeClient(impl);

    await client.json(MM.getMe(), z.unknown());
    await client.json(MM.getMyTeams(), z.unknown());
    await client.json(MM.getPublicChannelsForTeam(TEAM, 0, 200), z.unknown());
    await client.json(MM.getChannelPosts(CHANNEL, { perPage: 200 }), z.unknown());

    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "GET"]);
  });

  it("envoie POST /users/ids, qui est une lecture malgre son verbe", async () => {
    const { impl, calls } = fetchSpy(200, []);
    const client = makeClient(impl);
    await client.json(MM.getUsersByIds([USER]), z.unknown());
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/api/v4/users/ids");
  });
});

describe("MutationGate", () => {
  function gateWith(consentChannels: string[], joined: string[] = []) {
    const executed: EndpointCall[] = [];
    const gate = new MutationGate({
      executor: async (call) => {
        executed.push(call);
        return null;
      },
      consent:
        consentChannels.length === 0
          ? noConsent()
          : grantConsent({
              channelIds: consentChannels,
              teamIds: [],
              grantedAt: "2026-08-24T10:00:00.000Z",
              source: "interactive",
            }),
      selfUserId: USER,
      previouslyJoinedChannelIds: joined,
      clock: () => "2026-08-24T10:00:00.000Z",
    });
    return { gate, executed };
  }

  it("refuse de rejoindre un canal absent du consentement, sans requete", async () => {
    const { gate, executed } = gateWith([CHANNEL]);
    await expect(gate.joinChannel(OTHER_CHANNEL)).rejects.toThrow(ConsentViolationError);
    expect(executed).toHaveLength(0);
  });

  it("refuse toute mutation quand aucun consentement n a ete accorde", async () => {
    const { gate, executed } = gateWith([]);
    await expect(gate.joinChannel(CHANNEL)).rejects.toThrow(ConsentViolationError);
    await expect(gate.joinTeam(TEAM)).rejects.toThrow(ConsentViolationError);
    expect(executed).toHaveLength(0);
  });

  it("rejoint un canal consenti et consigne la mutation", async () => {
    const { gate, executed } = gateWith([CHANNEL]);
    const performed = await gate.joinChannel(CHANNEL);

    expect(executed).toHaveLength(1);
    expect(executed[0]?.template).toBe("/channels/{channel_id}/members");
    expect(executed[0]?.body).toEqual({ user_id: USER });
    expect(performed.kind).toBe("join_channel");
    expect(gate.channelsJoinedByTool).toEqual([CHANNEL]);
  });

  it("refuse de quitter un canal que l outil n a pas rejoint", async () => {
    // Sans ce garde-fou, --leave-after ferait sortir l utilisateur de canaux
    // dont il etait membre depuis toujours, de facon invisible et definitive.
    const { gate, executed } = gateWith([CHANNEL]);
    await expect(gate.leaveChannel(CHANNEL)).rejects.toThrow(ConsentViolationError);
    expect(executed).toHaveLength(0);
  });

  it("autorise a quitter un canal rejoint lors d un run precedent", async () => {
    const { gate, executed } = gateWith([], [CHANNEL]);
    await gate.leaveChannel(CHANNEL);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.method).toBe("DELETE");
    expect(gate.channelsJoinedByTool).toEqual([]);
  });

  it("ne permet pas de quitter deux fois le meme canal", async () => {
    const { gate } = gateWith([CHANNEL], [CHANNEL]);
    await gate.leaveChannel(CHANNEL);
    await expect(gate.leaveChannel(CHANNEL)).rejects.toThrow(ConsentViolationError);
  });
});
