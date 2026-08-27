import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { HttpArchiveClient } from "./client/http-client.js";
import { ArchiveProvider, type LoadState } from "./data.js";
import "./ui/styles.css";

const root = document.getElementById("racine");
if (root === null) throw new Error("Point de montage absent.");

function Fallback(state: LoadState): React.ReactNode {
  if (state.status === "erreur") {
    return (
      <div className="ecran-etat">
        <h1>Archive illisible</h1>
        <p>{state.message}</p>
        <p className="vue-detail">
          Verifiez que l index a bien ete construit et que le serveur le trouve.
        </p>
      </div>
    );
  }
  return (
    <div className="ecran-etat">
      <p className="chargement">Ouverture de l archive</p>
    </div>
  );
}

createRoot(root).render(
  <StrictMode>
    <ArchiveProvider client={new HttpArchiveClient()} fallback={Fallback}>
      <App />
    </ArchiveProvider>
  </StrictMode>,
);
