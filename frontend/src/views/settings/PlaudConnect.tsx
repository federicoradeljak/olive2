import type { ReactElement } from "react";
import { OAuthPasteConnect } from "./OAuthPasteConnect";

/**
 * Plaud OAuth 2.0 PKCE connect flow: start → open Plaud login → paste the
 * callback URL → done. Shared by the Integrations settings and PlaudModal.
 */
export function PlaudConnect(props: {
  onConnected: () => void;
  onCancel?: () => void;
  onDone?: () => void;
  autoStart?: boolean;
}): ReactElement {
  return (
    <OAuthPasteConnect
      {...props}
      service="Plaud"
      startUrl="/api/plaud/auth/start"
      completeUrl="/api/plaud/auth/complete"
      signInHint="Opens the official Plaud login in a new tab. Sign in and allow access."
      callbackPrefix="http://localhost:8199/auth/callback"
      successNote="Tokens refresh automatically. New recordings appear after the next sync."
      inputId="plaud-callback"
    />
  );
}
