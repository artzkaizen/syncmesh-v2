import { createFileRoute } from "@tanstack/react-router";

/**
 * `/` — the list, with nothing open beside it.
 *
 * It draws nothing, and that is the whole of it: the header, the sidebar and the list belong to
 * the layout above, and this route exists to say that the detail slot is empty. Rendering `null`
 * from a real route rather than making the panel conditional in the layout is what keeps "no
 * issue is open" a URL — closing the panel is `navigate({ to: "/" })`, so it lands in history and
 * the back button reopens what was just closed.
 */
export const Route = createFileRoute("/_shell/")({ component: () => null });
