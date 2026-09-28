import { createFileRoute } from "@tanstack/react-router";

import { Page } from "../app/page.js";
import { Settings } from "../app/settings.js";

/**
 * `/settings` — everything about this install.
 *
 * A sibling of the list's layout and not a child of it: none of the filters down the left applies
 * to a relay URL, and the header's live totals are about a workspace this screen is not looking at.
 */
export const Route = createFileRoute("/settings")({
  component: () => (
    <Page title="Settings">
      <Settings />
    </Page>
  ),
});
