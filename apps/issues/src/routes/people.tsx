import { createFileRoute } from "@tanstack/react-router";

import { Page } from "../app/page.js";
import { People } from "../app/people.js";

/**
 * `/people` — the roster.
 *
 * Its own address rather than a panel, because "who is in this workspace and what are they
 * carrying" is a place somebody navigates to and links other people at, and because it is the one
 * screen in the app whose content is not issues.
 */
export const Route = createFileRoute("/people")({
  component: () => (
    <Page title="People">
      <People />
    </Page>
  ),
});
