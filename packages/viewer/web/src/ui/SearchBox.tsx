import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";
import { useArchive } from "../data.js";
import { navigate, searchHref } from "../route.js";
import {
  appliquerCompletion,
  completionEnCours,
  filtrerSuggestions,
  type Suggestion,
} from "./completion.js";

/**
 * Champ de recherche, avec proposition des valeurs de `from:` et `in:`.
 *
 * Aucune route ni aucun aller-retour reseau : l annuaire et la liste des canaux
 * sont deja charges au demarrage, ce sont ceux qui resolvent les mentions.
 *
 * Le motif est celui d une liste deroulante ARIA, et ce n est pas du zele. Sans
 * `aria-activedescendant`, le lecteur d ecran annonce le champ mais rien de ce
 * qui defile dedans, et la fonctionnalite n existe que pour ceux qui voient.
 */
export function SearchBox({ initial }: { readonly initial: string }): ReactNode {
  const { channels, userById } = useArchive();
  const [draft, setDraft] = useState(initial);
  const [position, setPosition] = useState(initial.length);
  const [surligne, setSurligne] = useState(0);
  const [ouvert, setOuvert] = useState(false);
  const champ = useRef<HTMLInputElement>(null);

  const candidats = useMemo(() => {
    const comptes: Suggestion[] = [...userById.values()]
      .filter((user) => user.username !== "")
      .map((user) => ({
        valeur: user.username,
        libelle: user.display === "" ? user.username : user.display,
        detail: user.deactivated ? "compte desactive" : (user.position ?? undefined),
      }));
    const canaux: Suggestion[] = channels.map((canal) => ({
      valeur: canal.name,
      libelle: canal.displayName === "" ? canal.name : canal.displayName,
      detail: canal.archived ? "canal archive" : undefined,
    }));
    return { from: comptes, in: canaux };
  }, [channels, userById]);

  const completion = ouvert ? completionEnCours(draft, position) : undefined;
  const suggestions =
    completion === undefined
      ? []
      : filtrerSuggestions(candidats[completion.modificateur], completion.prefixe);
  const deroule = suggestions.length > 0;

  const majSaisie = (valeur: string, curseur: number): void => {
    setDraft(valeur);
    setPosition(curseur);
    setSurligne(0);
    setOuvert(true);
  };

  const choisir = (suggestion: Suggestion): void => {
    if (completion === undefined) return;
    const applique = appliquerCompletion(draft, completion, suggestion.valeur);
    setDraft(applique.texte);
    setPosition(applique.position);
    setOuvert(false);
    // Le curseur doit suivre : sans cela il reste ou il etait, et la frappe
    // suivante s insere au milieu de ce qu on vient de completer.
    const element = champ.current;
    if (element !== null) {
      queueMicrotask(() => {
        element.focus();
        element.setSelectionRange(applique.position, applique.position);
      });
    }
  };

  const touche = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (!deroule) {
      // Fermer sur Echap meme sans liste : le champ garde sa saisie, seule la
      // proposition disparait, ce qui est ce qu on attend d Echap.
      if (event.key === "Escape") setOuvert(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSurligne((n) => (n + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSurligne((n) => (n - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter") {
      const choix = suggestions[surligne];
      if (choix !== undefined) {
        // La liste ouverte capture Entree : soumettre ici lancerait une
        // recherche sur un modificateur inacheve.
        event.preventDefault();
        choisir(choix);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOuvert(false);
    } else if (event.key === "Tab") {
      const choix = suggestions[surligne];
      if (choix !== undefined) {
        event.preventDefault();
        choisir(choix);
      }
    }
  };

  const soumettre = (event: FormEvent): void => {
    event.preventDefault();
    setOuvert(false);
    navigate(searchHref(draft).slice(1));
  };

  const idListe = "suggestions-recherche";
  const idOption = (index: number): string => `${idListe}-${String(index)}`;

  return (
    <search className="recherche">
      <form onSubmit={soumettre}>
        <div className="champ-recherche">
          <input
            ref={champ}
            type="search"
            value={draft}
            role="combobox"
            aria-expanded={deroule}
            aria-controls={idListe}
            aria-autocomplete="list"
            {...(deroule ? { "aria-activedescendant": idOption(surligne) } : {})}
            onChange={(event) => {
              majSaisie(
                event.target.value,
                event.target.selectionStart ?? event.target.value.length,
              );
            }}
            onKeyUp={(event) => {
              // Les fleches et les clics deplacent le curseur sans changer la
              // valeur : sans cela, corriger au milieu proposerait encore les
              // valeurs du mot precedent.
              const cible = event.currentTarget;
              setPosition(cible.selectionStart ?? cible.value.length);
            }}
            onClick={(event) => {
              setPosition(event.currentTarget.selectionStart ?? draft.length);
              setOuvert(true);
            }}
            onFocus={() => {
              setOuvert(true);
            }}
            onBlur={() => {
              // Retarde : un clic sur une proposition passe par le blur du
              // champ avant d atteindre la liste, et fermer tout de suite
              // annulerait le choix.
              setTimeout(() => {
                setOuvert(false);
              }, 120);
            }}
            onKeyDown={touche}
            placeholder="Rechercher, par exemple from:alice in:general"
            aria-label="Rechercher dans l archive"
          />
          {deroule ? (
            <div className="suggestions" id={idListe} role="listbox" aria-label="Propositions">
              {suggestions.map((suggestion, index) => (
                <div
                  key={suggestion.valeur}
                  id={idOption(index)}
                  role="option"
                  // Focusable par programme seulement : le focus reste sur le
                  // champ, et `aria-activedescendant` designe l option active.
                  // C est le motif de liste deroulante, et mettre les options
                  // dans l ordre de tabulation le casserait.
                  tabIndex={-1}
                  aria-selected={index === surligne}
                  className={index === surligne ? "suggestion active" : "suggestion"}
                  onMouseDown={(event) => {
                    // `mousedown` et non `click` : le clic arrive apres le blur,
                    // qui a deja ferme la liste.
                    event.preventDefault();
                    choisir(suggestion);
                  }}
                  onMouseEnter={() => {
                    setSurligne(index);
                  }}
                >
                  <span className="suggestion-valeur">{suggestion.valeur}</span>
                  {suggestion.libelle === suggestion.valeur ? null : (
                    <span className="suggestion-libelle">{suggestion.libelle}</span>
                  )}
                  {suggestion.detail === undefined ? null : (
                    <span className="suggestion-detail">{suggestion.detail}</span>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <button type="submit">Chercher</button>
      </form>
    </search>
  );
}
