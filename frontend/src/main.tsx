import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmHostRoot, ToastProvider } from "./components/ui";
import "./styles.css";
import { App } from "./App";
import { DebugQueuesPage } from "./views/DebugQueues";

const isDebugRoute =
  typeof window !== "undefined" &&
  (window.location.pathname === "/debug" || window.location.pathname.startsWith("/debug/"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmHostRoot />
      {isDebugRoute ? <DebugQueuesPage /> : <App />}
    </ToastProvider>
  </StrictMode>
);
