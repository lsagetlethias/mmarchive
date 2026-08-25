/**
 * Conventional commits, in English.
 *
 * The repository documentation and code comments stay in French for now; only
 * commits and pull requests follow the convention, since they are what a
 * contributor sees first on the forge.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      ["shared", "extractor", "viewer", "format", "cli", "ci", "deps", "docs"],
    ],
    "body-max-line-length": [2, "always", 100],
  },
};
