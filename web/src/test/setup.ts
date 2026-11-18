import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { setListing } from "../github/listing-store";

afterEach(() => {
  setListing(null);
  // Node-environment suites (the CI guard tests) have no DOM to reset.
  if (typeof window === "undefined") return;
  cleanup();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
