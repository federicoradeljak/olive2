import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmHostRoot, ToastProvider } from "./components/ui";
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmHostRoot />
      <App />
    </ToastProvider>
  </StrictMode>
);
