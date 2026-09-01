/**
 * Prepare l instance jetable pour le test d integration.
 *
 * Ce script n utilise PAS le client de l extracteur, et ce n est pas un detail
 * de commodite. `DECLARED_MUTATION_TEMPLATES` n autorise que trois ecritures,
 * rejoindre un canal, en sortir et rejoindre une team ; creer une team, des
 * canaux, des comptes et des messages en est hors par construction. Passer par
 * le client obligerait a y ouvrir une porte, et cette porte resterait ouverte
 * dans le code livre. Le seeding est donc du `fetch` brut, et le test qui
 * verifie l absence d ecriture continue de porter sur le vrai client.
 *
 * L etat construit est celui que le simulateur ne sait pas produire : un canal
 * public dont le compte est membre, un canal public qu il n a jamais rejoint,
 * un canal archive, et un compte desactive dont les messages subsistent.
 */

// Une variable definie mais vide donnerait une base d URL invalide, et des
// erreurs sans rapport avec la cause.
const BASE = (process.env["MM_INTEGRATION_URL"] ?? "").trim() || "http://localhost:8065";

interface Compte {
  readonly id: string;
  readonly token: string;
  readonly username: string;
}

export interface EtatSeme {
  readonly url: string;
  /**
   * Jeton d un compte STANDARD, celui qui extrait.
   *
   * Pas l administrateur, et la distinction n est pas cosmetique : un
   * administrateur systeme lit un canal public sans le rejoindre, donc
   * l inventaire le lui pre-coche et tout le modele de selection en trois temps
   * perd son objet. Le cadrage decrit le compte standard, qui est aussi le cas
   * le plus contraignant. Le test l a montre en echouant.
   */
  readonly lecteurToken: string;
  readonly adminToken: string;
  readonly teamId: string;
  readonly teamName: string;
  /** Canal public dont le compte d extraction est deja membre. */
  readonly canalMembre: { id: string; name: string; messages: number };
  /** Canal public que le compte n a jamais rejoint : le lire exige un join. */
  readonly canalNonRejoint: { id: string; name: string; messages: number };
  /** Canal archive cote Mattermost. */
  readonly canalArchive: { id: string; name: string; messages: number };
  readonly compteDesactive: string;
}

async function appel<T>(
  chemin: string,
  options: { methode?: string; corps?: unknown; token?: string } = {},
): Promise<T> {
  const reponse = await fetch(`${BASE}/api/v4${chemin}`, {
    method: options.methode ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    },
    ...(options.corps === undefined ? {} : { body: JSON.stringify(options.corps) }),
  });
  if (!reponse.ok) {
    throw new Error(
      `${options.methode ?? "GET"} ${chemin} : ${String(reponse.status)} ${await reponse.text()}`,
    );
  }
  return reponse.status === 204 ? (undefined as T) : ((await reponse.json()) as T);
}

async function creerCompte(username: string, email: string): Promise<Compte> {
  const motDePasse = "Integration-1234";
  // Le premier compte cree sur une base vide devient administrateur : c est le
  // chemin normal de l API, et il evite l assistant de configuration.
  const cree = await appel<{ id: string }>("/users", {
    methode: "POST",
    corps: { email, username, password: motDePasse },
  });
  const reponse = await fetch(`${BASE}/api/v4/users/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login_id: username, password: motDePasse }),
  });
  const token = reponse.headers.get("token");
  if (token === null) throw new Error(`aucun jeton rendu a la connexion de ${username}`);
  return { id: cree.id, token, username };
}

async function creerCanal(
  token: string,
  teamId: string,
  name: string,
  display: string,
): Promise<string> {
  const canal = await appel<{ id: string }>("/channels", {
    methode: "POST",
    token,
    corps: {
      team_id: teamId,
      name,
      display_name: display,
      type: "O",
      purpose: `Objet de ${display}`,
      header: `En-tete de ${display}`,
    },
  });
  return canal.id;
}

async function poster(
  token: string,
  channelId: string,
  messages: readonly string[],
): Promise<void> {
  for (const message of messages) {
    await appel("/posts", { methode: "POST", token, corps: { channel_id: channelId, message } });
  }
}

export async function semer(): Promise<EtatSeme> {
  const marque = String(Date.now()).slice(-8);
  // L administrateur seme, il n extrait pas : l extraction se fait avec
  // `lecteur`, un compte standard, qui est le cas que le cadrage decrit et le
  // plus contraignant.
  const admin = await creerCompte(`admin${marque}`, `admin${marque}@exemple.test`);
  const autre = await creerCompte(`autre${marque}`, `autre${marque}@exemple.test`);
  const partant = await creerCompte(`partant${marque}`, `partant${marque}@exemple.test`);
  const lecteur = await creerCompte(`lecteur${marque}`, `lecteur${marque}@exemple.test`);

  const team = await appel<{ id: string; name: string }>("/teams", {
    methode: "POST",
    token: admin.token,
    corps: { name: `equipe${marque}`, display_name: "Equipe de test", type: "O" },
  });
  for (const compte of [autre, partant, lecteur]) {
    await appel(`/teams/${team.id}/members`, {
      methode: "POST",
      token: admin.token,
      corps: { team_id: team.id, user_id: compte.id },
    });
  }

  const membre = await creerCanal(admin.token, team.id, `membre${marque}`, "Canal rejoint");
  await poster(admin.token, membre, ["bonjour", "un second message", "un troisieme"]);
  // Le compte qui extraira est membre de celui-ci et d aucun autre.
  await appel(`/channels/${membre}/members`, {
    methode: "POST",
    token: lecteur.token,
    corps: { user_id: lecteur.id },
  });

  // Cree par un autre compte, et celui qui extrait ne le rejoint jamais. Selon
  // la configuration de l instance, le lire exige un join ou non : c est
  // precisement ce que ce test verifie dans les deux sens.
  const nonRejoint = await creerCanal(autre.token, team.id, `ferme${marque}`, "Canal non rejoint");
  await poster(autre.token, nonRejoint, ["message hors de portee", "un autre"]);

  const archive = await creerCanal(admin.token, team.id, `archive${marque}`, "Canal archive");
  await poster(admin.token, archive, ["dernier mot avant archivage"]);
  await appel(`/channels/${archive}`, { methode: "DELETE", token: admin.token });

  // Un compte desactive dont les messages restent : le format impose de le
  // conserver, ses messages le referencant encore. Il doit rejoindre le canal
  // avant d y ecrire, poster dans un canal dont on n est pas membre etant refuse.
  await appel(`/channels/${membre}/members`, {
    methode: "POST",
    token: partant.token,
    corps: { user_id: partant.id },
  });
  await poster(partant.token, membre, ["message d un compte qui partira"]);
  await appel(`/users/${partant.id}/active`, {
    methode: "PUT",
    token: admin.token,
    corps: { active: false },
  });

  return {
    url: BASE,
    lecteurToken: lecteur.token,
    adminToken: admin.token,
    teamId: team.id,
    teamName: team.name,
    canalMembre: { id: membre, name: `membre${marque}`, messages: 4 },
    canalNonRejoint: { id: nonRejoint, name: `ferme${marque}`, messages: 2 },
    canalArchive: { id: archive, name: `archive${marque}`, messages: 1 },
    compteDesactive: partant.id,
  };
}

/**
 * Retire au role `team_user` le droit de lire un canal public sans le rejoindre.
 *
 * C est la configuration que decrit le cadrage, et ce n est PAS celle par
 * defaut : un Mattermost neuf accorde `read_public_channel` a `team_user`, donc
 * un compte standard lit les messages d un canal public de sa team sans en etre
 * membre. Le test le verifie dans les deux sens, parce que les deux existent :
 * sur l archive de reference, 758 canaux ont ete extraits dont 88 seulement ou
 * le compte etait deja membre, et aucun n a eu besoin d etre rejoint.
 *
 * Rend les permissions d origine, pour que l appelant puisse les restaurer.
 */
export async function retirerLectureSansAdhesion(adminToken: string): Promise<string[]> {
  const role = await appel<{ id: string; permissions: string[] }>("/roles/name/team_user", {
    token: adminToken,
  });
  await appel(`/roles/${role.id}/patch`, {
    methode: "PUT",
    token: adminToken,
    corps: { permissions: role.permissions.filter((p) => p !== "read_public_channel") },
  });
  return role.permissions;
}
