import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * L archive doit pouvoir etre consultee sur un reseau ferme : aucune ressource
 * ne peut etre chargee depuis un service tiers. Les polices sont celles du
 * systeme, les icones sont des SVG en ligne, et les emojis personnalises
 * viennent de l archive elle meme.
 */
export default defineConfig({
  root: "web",
  // Chemins relatifs : ouverte depuis un disque, la page resoudrait sinon
  // "/assets/..." depuis la racine du systeme de fichiers.
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Un seul fichier de sortie par type facilite la copie du mode lite : le
    // dossier produit se deplace tel quel.
    assetsInlineLimit: 4096,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4173",
      "/files": "http://127.0.0.1:4173",
      "/avatars": "http://127.0.0.1:4173",
      "/emoji": "http://127.0.0.1:4173",
    },
  },
});
