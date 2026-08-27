import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Boot } from "./boot.js";
import "./ui/styles.css";

const root = document.getElementById("racine");
if (root === null) throw new Error("Point de montage absent.");

createRoot(root).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
