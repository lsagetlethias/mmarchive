import { describe, expect, it } from "vitest";
import { summarizeSelection } from "@mmarchive/shared";
import { MattermostApi } from "../src/mattermost/api.js";
import { MattermostClient } from "../src/mattermost/http-client.js";
import { buildInventory } from "../src/inventory/build-inventory.js";

/** L URL d une requete fetch, quelle que soit la forme de son premier argument. */
function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
}

const ACCOUNT = { id: "u".repeat(26), username: "alice", roles: "system_user" };
const TEAM = { id: "t".repeat(26), name: "produit", display_name: "Produit", type: "O" };

type FakeChannel = Record<string, unknown> & { id: string };

function channel(over: Record<string, unknown>): FakeChannel {
  return {
    id: "c".repeat(26),
    team_id: TEAM.id,
    type: "O",
    name: "canal",
    display_name: "Canal",
    header: "",
    purpose: "",
    create_at: 1,
    delete_at: 0,
    last_post_at: 1_700_000_000_000,
    total_msg_count: 10,
    ...over,
  };
}

const JOINED = channel({ id: "a".repeat(26), name: "town-square", display_name: "Town Square" });
const UNJOINED = channel({ id: "b".repeat(26), name: "tech", display_name: "Tech" });
const ARCHIVED = channel({
  id: "d".repeat(26),
  name: "vieux",
  display_name: "Vieux",
  delete_at: 1_600_000_000_000,
});
const PRIVATE_LEAK = channel({
  id: "e".repeat(26),
  name: "secret",
  display_name: "Secret",
  type: "P",
});

interface Scenario {
  readonly probeForbidden?: readonly string[];
  readonly includePrivateLeak?: boolean;
  readonly deletedForbidden?: boolean;
}

function makeApi(scenario: Scenario = {}): { api: MattermostApi; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const forbidden = new Set(scenario.probeForbidden ?? [ARCHIVED.id, UNJOINED.id]);

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(requestUrl(input));
    const path = url.pathname.replace("/api/v4", "");
    requests.push({ method: init?.method ?? "GET", path });

    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "x-version-id": "9.5.2" },
      });

    if (path === "/users/me") return json(ACCOUNT);
    if (path === "/system/ping") return json({ status: "OK" });
    if (path === "/config/client") return json({});
    if (path === "/users/me/teams") return json([TEAM]);
    if (path === "/teams") return json(url.searchParams.get("page") === "0" ? [TEAM] : []);
    if (path === `/users/me/teams/${TEAM.id}/channels`) return json([JOINED]);
    if (path === `/teams/${TEAM.id}/channels`) {
      if (url.searchParams.get("page") !== "0") return json([]);
      const list = [JOINED, UNJOINED];
      if (scenario.includePrivateLeak === true) list.push(PRIVATE_LEAK);
      return json(list);
    }
    if (path === `/teams/${TEAM.id}/channels/deleted`) {
      if (scenario.deletedForbidden === true) return json({ message: "no" }, 403);
      return json(url.searchParams.get("page") === "0" ? [ARCHIVED] : []);
    }
    const postsMatch = /^\/channels\/([a-z]+)\/posts$/.exec(path);
    if (postsMatch) {
      const channelId = postsMatch[1] ?? "";
      if (forbidden.has(channelId)) return json({ message: "forbidden" }, 403);
      return json({ order: [], posts: {} });
    }
    return json({ message: `route non simulee: ${path}` }, 404);
  };

  const client = new MattermostClient({
    baseUrl: "https://mm.example.org",
    token: "secret",
    rateLimit: 1000,
    sleep: async () => undefined,
    fetchImpl,
  });
  return { api: new MattermostApi(client), requests };
}

async function runInventory(scenario: Scenario = {}) {
  const { api, requests } = makeApi(scenario);
  const result = await buildInventory({
    api,
    toolVersion: "0.1.0",
    sourceUrl: "https://mm.example.org",
    clock: () => "2026-08-24T10:00:00.000Z",
  });
  return { result, requests };
}

describe("inventaire", () => {
  it("n emet strictement aucune requete d ecriture", async () => {
    // Verification defensive numero 3 : la sous-commande inventory ne doit
    // jamais rien modifier sur l instance, quel que soit le contenu rencontre.
    const { requests } = await runInventory();
    const writes = requests.filter((request) => request.method !== "GET");
    expect(writes).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
  });

  it("ne demande jamais l ajout d un membre", async () => {
    const { requests } = await runInventory();
    expect(requests.filter((r) => r.path.endsWith("/members"))).toEqual([]);
  });

  it("ne marque aucun canal comme lu", async () => {
    // POST /channels/members/{user_id}/view est nomme "view" mais ecrit.
    const { requests } = await runInventory();
    expect(requests.filter((r) => r.path.includes("/view"))).toEqual([]);
  });

  it("coche par defaut les canaux deja rejoints et rien d autre", async () => {
    const { result } = await runInventory();
    const channels = result.file.teams[0]?.channels ?? [];
    const selected = channels.filter((c) => c.selected).map((c) => c.name);
    expect(selected).toEqual(["town-square"]);
  });

  it("laisse a false les canaux qui demanderaient un join", async () => {
    const { result } = await runInventory();
    const tech = result.file.teams[0]?.channels.find((c) => c.name === "tech");
    expect(tech?.joined).toBe(false);
    expect(tech?.selected).toBe(false);
    expect(tech?.readable).toBe(false);
    expect(summarizeSelection(result.file).joinsInduced).toBe(0);
  });

  it("marque lisible un canal non rejoint que le serveur laisse lire", async () => {
    // Cas du compte system admin, ou d un scheme de permissions permissif :
    // on le decouvre en sondant, jamais en deduisant du role.
    const { result } = await runInventory({ probeForbidden: [ARCHIVED.id] });
    const tech = result.file.teams[0]?.channels.find((c) => c.name === "tech");
    expect(tech?.readable).toBe(true);
    expect(tech?.selected).toBe(true);
    expect(summarizeSelection(result.file).joinsInduced).toBe(0);
  });

  it("consigne un warning pour un canal archive illisible", async () => {
    const { result } = await runInventory();
    const warning = result.warnings.find((w) => w.code === "ARCHIVED_CHANNEL_FORBIDDEN");
    expect(warning?.channel_id).toBe(ARCHIVED.id);
    const vieux = result.file.teams[0]?.channels.find((c) => c.name === "vieux");
    expect(vieux?.archived).toBe(true);
    expect(vieux?.readable).toBe(false);
    expect(vieux?.selected).toBe(false);
  });

  it("ecarte un canal non public renvoye par le serveur", async () => {
    // Verification defensive numero 1, appliquee a la source : meme si l API
    // renvoie un canal prive dans un listing public, il ne doit pas entrer.
    const { result } = await runInventory({ includePrivateLeak: true });
    const names = result.file.teams[0]?.channels.map((c) => c.name) ?? [];
    expect(names).not.toContain("secret");
  });

  it("survit a un 403 sur la liste des canaux archives", async () => {
    const { result } = await runInventory({ deletedForbidden: true });
    const names = result.file.teams[0]?.channels.map((c) => c.name) ?? [];
    // Les canaux sont ordonnes par display_name : "Tech" precede "Town Square".
    expect(names).toEqual(["tech", "town-square"]);
  });

  it("renseigne la tracabilite dans le bloc meta", async () => {
    const { result } = await runInventory();
    expect(result.file.meta.source_url).toBe("https://mm.example.org");
    expect(result.file.meta.account.username).toBe("alice");
    expect(result.file.meta.account.is_system_admin).toBe(false);
    expect(result.serverVersion).toBe("9.5.2");
  });
});
