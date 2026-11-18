import { useHandleSignInCallback } from "@logto/react";
import { useNavigate } from "react-router";
import { PlainLayout } from "../components/Shell";
import { ErrorLine, LoadingRows } from "../components/ui";
import { PATHS } from "../paths";

/** `/callback`: completes the Logto sign-in redirect, then returns to the app. */
export function LogtoCallback() {
  const navigate = useNavigate();
  const { error } = useHandleSignInCallback(() => navigate(PATHS.home, { replace: true }));
  return (
    <PlainLayout>
      {error ? (
        <ErrorLine
          message="Sign-in couldn’t be completed."
          onRetry={() => navigate(PATHS.home, { replace: true })}
          retryLabel="Back to start"
        />
      ) : (
        <LoadingRows rows={1} />
      )}
    </PlainLayout>
  );
}
