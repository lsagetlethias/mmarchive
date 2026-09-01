/**
 * Extraction contre un vrai Mattermost.
 *
 * Ne tourne que si `MM_INTEGRATION_URL` est fourni, donc jamais dans
 * `pnpm test` : il lui faut une instance, et trois a quatre minutes. Le script
 * `pnpm test:integration` monte le compose, attend l API et lance ce fichier.
 *
 * Ce qu il apporte que le simulateur ne peut pas apporter, et l exemple n est
 * pas theorique. L extracteur ecrivait `header`, `purpose` et `create_at` en dur
 * a vide pour chaque canal, et toute la suite de tests passait : le simulateur
 * ne renvoyait pas ces champs davantage, donc les tests verifiaient que le code
 * faisait ce que nous croyions de l API. Quand ils ont ete ajoutes au
 * simulateur, il a fallu les ecrire a la main, donc continuer a tester notre
 * propre hypothese. Seul un vrai serveur tranche.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { ArchiveChannel, ArchiveUser, SelectionFile } from "@mmarchive/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunOptions } from "../../packages/extractor/src/config/options.js";
import { runExtraction } from "../../packages/extractor/src/extract/orchestrator.js";
import { buildInventory } from "../../packages/extractor/src/inventory/build-inventory.js";
import { MattermostApi } from "../../packages/extractor/src/mattermost/api.js";
import { MattermostClient } from "../../packages/extractor/src/mattermost/http-client.js";
import { Logger } from "../../packages/extractor/src/ui/logger.js";
import { RunReporter } from "../../packages/extractor/src/ui/run-reporter.js";
import { type EtatSeme, retirerLectureSansAdhesion, semer } from "./seed.js";

// Vide vaut absent : sans cela le test partirait sur une base d URL invalide.
const URL_INSTANCE = (process.env["MM_INTEGRATION_URL"] ?? "").trim();

const silencieux = new Logger({ level: "error" });

/** Les tests n ecrivent rien sur la sortie standard. */
function rapporteurMuet(): RunReporter {
  return new RunReporter({
    estimatedMessages: 0,
    out: new Writable({
      write(_chunk, _enc, cb: () => void) {
        cb();
      },
    }),
    interactive: false,
  });
}

describe.skipIf(URL_INSTANCE === "")("extraction contre un Mattermost reel", () => {
  let etat: EtatSeme;
  let api: MattermostApi;
  let client: MattermostClient;
  let sortie: string;
  let selection: SelectionFile;

  beforeAll(async () => {
    etat = await semer();
    client = new MattermostClient({
      baseUrl: etat.url,
      token: etat.lecteurToken,
      rateLimit: 50,
    });
    api = new MattermostApi(client);
    sortie = await mkdtemp(join(tmpdir(), "mmarchive-integration-"));

    const inventaire = await buildInventory({
      api,
      toolVersion: "test",
      sourceUrl: etat.url,
      probeUnjoined: true,
    });
    selection = inventaire.file;
  }, 120_000);

  afterAll(async () => {
    await rm(sortie, { recursive: true, force: true });
  });

  function canalDeLaSelection(nom: string) {
    return selection.teams.flatMap((t) => t.channels).find((c) => c.name === nom);
  }

  describe("l inventaire", () => {
    it("distingue le canal rejoint de celui qui ne l est pas", () => {
      // La distinction qui commande tout le modele de selection : lire un canal
      // non rejoint exige un join, et un join publie un message systeme visible.
      expect(canalDeLaSelection(etat.canalMembre.name)?.joined).toBe(true);
      expect(canalDeLaSelection(etat.canalNonRejoint.name)?.joined).toBe(false);
    });

    it("voit le canal archive et le marque comme tel", () => {
      expect(canalDeLaSelection(etat.canalArchive.name)?.archived).toBe(true);
    });

    it("pre-coche un canal non rejoint quand l instance en autorise la lecture", () => {
      // Contre-intuitif, et c est LA decouverte de ce test. Un Mattermost neuf
      // accorde `read_public_channel` au role `team_user` : un compte standard
      // lit donc un canal public de sa team sans en etre membre, et l inventaire
      // le lui pre-coche a raison, puisque l extraire n ecrira rien.
      //
      // Sur l archive de reference, 758 canaux ont ete extraits dont 88
      // seulement ou le compte etait deja membre, et aucun n a eu besoin d etre
      // rejoint. Le premier paragraphe de CLAUDE.md decrivait l inverse.
      expect(canalDeLaSelection(etat.canalMembre.name)?.selected).toBe(true);
      expect(canalDeLaSelection(etat.canalNonRejoint.name)?.selected).toBe(true);
      expect(canalDeLaSelection(etat.canalNonRejoint.name)?.joined).toBe(false);
    });

    it("exige un join des que l instance refuse cette lecture", async () => {
      // L autre configuration, celle que le cadrage decrit, et le seul cas ou
      // le modele de selection en trois temps sert a quelque chose. Il n etait
      // jusqu ici verifie que contre un simulateur, c est a dire contre notre
      // propre hypothese.
      await retirerLectureSansAdhesion(etat.adminToken);
      const apres = await buildInventory({
        api,
        toolVersion: "test",
        sourceUrl: etat.url,
        probeUnjoined: true,
      });
      const canal = apres.file.teams
        .flatMap((t) => t.channels)
        .find((c) => c.name === etat.canalNonRejoint.name);
      expect(canal?.readable).toBe(false);
      // Non pre-coche : l extraire publierait un message systeme visible de tous
      // ses membres, ce que l outil ne fait jamais sans designation nominative.
      expect(canal?.selected).toBe(false);
    }, 60_000);
  });

  describe("l extraction", () => {
    beforeAll(async () => {
      const aExtraire: SelectionFile = {
        ...selection,
        teams: selection.teams.map((team) => ({
          ...team,
          channels: team.channels.map((canal) => ({
            ...canal,
            selected: canal.name === etat.canalMembre.name,
          })),
        })),
      };
      const runOptions: RunOptions = {
        connection: { url: etat.url, token: etat.lecteurToken },
        file: undefined,
        out: sortie,
        yes: true,
        joinTeams: false,
        leaveAfter: false,
        since: undefined,
        resume: false,
        skipFiles: false,
        maxFileSizeBytes: 1024 * 1024,
        includeEmails: false,
        concurrency: 2,
        rateLimit: 50,
        postsPageSize: 200,
      };
      await runExtraction({
        api,
        client,
        account: await api.getMe(),
        runOptions,
        selection: aExtraire,
        selectionMode: "file",
        totalPublicChannels: selection.teams.flatMap((t) => t.channels).length,
        logger: silencieux,
        // Aucun join : le canal non rejoint n est pas selectionne, et repondre
        // faux garantit qu aucune ecriture ne peut avoir lieu.
        confirmJoins: () => Promise.resolve(false),
        reporter: rapporteurMuet(),
      });
    }, 180_000);

    async function lire<T>(fichier: string): Promise<T[]> {
      const brut = await readFile(join(sortie, fichier), "utf8");
      return brut
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as T);
    }

    it("renseigne l en-tete, l objet et la date de creation du canal", async () => {
      // LE test de ce fichier. Ces trois champs etaient ecrits en dur a vide, et
      // aucun test contre simulateur ne pouvait le montrer.
      const canaux = await lire<ArchiveChannel>("channels.ndjson");
      const canal = canaux.find((c) => c.name === etat.canalMembre.name);
      expect(canal?.purpose).toBe("Objet de Canal rejoint");
      expect(canal?.header).toBe("En-tete de Canal rejoint");
      expect(canal?.create_at).toBeGreaterThan(0);
    });

    it("conserve un compte desactive et ses messages", async () => {
      const comptes = await lire<ArchiveUser>("users.ndjson");
      const desactive = comptes.find((u) => u.id === etat.compteDesactive);
      expect(desactive, "le compte desactive doit rester dans l annuaire").toBeDefined();
      expect(desactive?.delete_at).toBeGreaterThan(0);
    });

    it("ecrit tous les messages du canal selectionne", async () => {
      const posts = await lire<{ user_id: string }>(`posts/${etat.canalMembre.id}.ndjson`);
      // Les messages du seed, plus les messages systeme que Mattermost ajoute a
      // la creation du canal et a chaque arrivee.
      expect(posts.length).toBeGreaterThanOrEqual(etat.canalMembre.messages);
    });

    it("n a pas extrait le canal non selectionne", async () => {
      await expect(lire(`posts/${etat.canalNonRejoint.id}.ndjson`)).rejects.toThrow();
    });
  });
});
