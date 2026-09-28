import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { Picker } from "../app/picker.js";

/**
 * `/identity` — going in as somebody else, once this install has already gone in as someone.
 *
 * The same component a first launch draws, which is the whole reason `Picker` takes no router: on
 * a fresh install it stands in place of the app (`app/workspace.tsx`), and here it is a page with
 * a list behind it. What differs is only what happens afterwards, and that is this file's one job.
 */
export const Route = createFileRoute("/identity")({ component: Identity });

function Identity() {
  const navigate = useNavigate();
  return (
    // `replace`, because the answer to "who are you" should not be a page the back button can
    // return to: a history entry that re-asks after it has been answered is one a stray gesture
    // turns into the list being drawn as two different people in two frames
    <Picker onEntered={() => void navigate({ replace: true, to: "/" })} />
  );
}
