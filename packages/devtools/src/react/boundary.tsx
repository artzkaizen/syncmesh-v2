import type { ErrorInfo, ReactNode } from "react";

import { Component } from "react";

import { COLOR, FONT, RADIUS, SEVERITY_COLOR, SEVERITY_TINT, SPACE, TEXT } from "../tokens.js";

/**
 * One panel's crash, contained to that panel's body.
 *
 * Without this, a devtool is strictly worse than no devtool. React unmounts the whole tree from
 * the nearest boundary upwards, and with no boundary anywhere that tree is the app's — so a panel
 * that reads a field the mesh stopped returning takes down the shell, the bubble, and the page it
 * was installed to inspect. An inspector that can kill its subject is not a diagnostic tool.
 *
 * So the boundary sits around the panel body and nowhere else. Everything outside it — the tab
 * bar, the dock controls, the resize grip, the bubble — keeps working, which means the reader's
 * next move is one click away: switch to another tab and it renders, because it was never
 * unmounted. The tab that broke shows what it threw, in the space it would have filled.
 *
 * The error is **shown**, never swallowed. A boundary that rendered "something went wrong" would
 * have turned a stack trace into a shrug, and the person reading it is a developer who came here
 * for exactly that stack.
 */

export interface PanelBoundaryProps {
  /** The tab's id. Changing it resets the boundary, so re-opening a crashed panel tries again. */
  readonly id: string;
  /** Named in the message, because "a panel failed" is not a sentence anyone can act on. */
  readonly label: string;
  /** Where a host sends it: a console, a session recorder, an issue. */
  readonly onError?: ((cause: unknown, info: ErrorInfo) => void) | undefined;
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly id: string;
  /** What the panel threw, or `undefined` while it is behaving. */
  readonly cause: unknown;
  /** React's component stack, which names the component a bare `Error` cannot. */
  readonly where: string | undefined;
}

/** `unknown`, because a throw is not obliged to be an `Error` and pretending otherwise loses it. */
const messageOf = (cause: unknown): string =>
  cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : "the panel threw a value that was not an Error";

const stackOf = (cause: unknown): string | undefined =>
  cause instanceof Error ? cause.stack : undefined;

const FRAME = {
  margin: SPACE.lg,
  padding: SPACE.lg,
  border: `1px solid ${SEVERITY_COLOR.critical}`,
  background: SEVERITY_TINT.critical,
  borderRadius: RADIUS.md,
  display: "grid",
  gap: SPACE.sm,
};

const TRACE = {
  ...TEXT.xs,
  fontFamily: FONT.mono,
  color: COLOR.textDim,
  margin: 0,
  maxHeight: 220,
  overflow: "auto",
  whiteSpace: "pre-wrap",
} as const;

export class PanelBoundary extends Component<PanelBoundaryProps, BoundaryState> {
  constructor(props: PanelBoundaryProps) {
    super(props);
    this.state = { id: props.id, cause: undefined, where: undefined };
  }

  /** A different tab is a different panel: it has not failed, and must not inherit a red box. */
  static getDerivedStateFromProps(
    props: PanelBoundaryProps,
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    return props.id === state.id ? null : { id: props.id, cause: undefined, where: undefined };
  }

  static getDerivedStateFromError(cause: unknown): Partial<BoundaryState> {
    return { cause };
  }

  override componentDidCatch(cause: unknown, info: ErrorInfo): void {
    this.setState({ where: info.componentStack ?? undefined });
    this.props.onError?.(cause, info);
  }

  override render(): ReactNode {
    const { cause, where } = this.state;
    if (cause === undefined) return this.props.children;
    const stack = stackOf(cause) ?? where;
    return (
      <div role="alert" style={FRAME}>
        <div style={{ ...TEXT.sm, color: SEVERITY_COLOR.critical }}>
          The {this.props.label} panel stopped
        </div>
        <div style={{ ...TEXT.sm, color: COLOR.text, fontFamily: FONT.mono }}>
          {messageOf(cause)}
        </div>
        <div style={{ ...TEXT.xs, color: COLOR.textFaint }}>
          Every other tab is still running — switch to one and come back. Reopening this tab tries
          it again.
        </div>
        {stack === undefined ? null : <pre style={TRACE}>{stack}</pre>}
      </div>
    );
  }
}
