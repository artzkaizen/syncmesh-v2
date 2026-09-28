import { COLOR, FONT, RADIUS, TEXT } from "./tokens.js";

/**
 * One stylesheet, injected once into the shadow root — and nothing else.
 *
 * Layout and colour are inline `style` objects at the component that owns them, because inline
 * styles are impossible for a host page to override and need no runtime to produce. What is here
 * is the part inline styles cannot express: `:hover`, `:focus-visible`, `::placeholder`, the
 * scrollbar, and the element resets that undo a browser's defaults for `button`, `input` and
 * `select`. Every rule is scoped by the {@link PREFIX} as well as by the shadow boundary, so the
 * sheet stays readable in a devtools inspector that shows it without its root.
 *
 * There is deliberately no CSS-in-JS here. A devtool that pulls a styling runtime into an app's
 * bundle has made itself expensive to install, and the first thing anyone does with something
 * expensive to install is not install it.
 */

/** Every class this package writes begins with it. Short, because it appears on every element. */
export const PREFIX = "sm-dt";

const c = COLOR;

export const STYLESHEET = `
:host {
  all: initial;
  font-family: ${FONT.sans};
  font-size: ${TEXT.sm.fontSize}px;
  line-height: ${TEXT.sm.lineHeight};
  color: ${c.text};
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
  color-scheme: dark;
}
.${PREFIX}-root, .${PREFIX}-root * { box-sizing: border-box; }
.${PREFIX}-root ::selection { background: rgba(255, 255, 255, 0.18); }

.${PREFIX}-root button,
.${PREFIX}-root input,
.${PREFIX}-root select {
  font: inherit;
  color: inherit;
  margin: 0;
  background: none;
  border: 0;
  border-radius: 0;
  appearance: none;
  -webkit-appearance: none;
}
.${PREFIX}-root button { cursor: pointer; }
.${PREFIX}-root :focus { outline: none; }
.${PREFIX}-root :focus-visible {
  outline: 1px solid ${c.focus};
  outline-offset: 1px;
}

.${PREFIX}-bubble {
  display: grid;
  place-items: center;
  background: ${c.surface};
  border: 1px solid ${c.hairline};
  border-radius: ${RADIUS.lg}px;
  color: ${c.textDim};
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
  transition: color 120ms ease, border-color 120ms ease, transform 120ms ease;
}
.${PREFIX}-bubble:hover {
  color: ${c.text};
  border-color: ${c.hairlineStrong};
  transform: translateY(-1px);
}

.${PREFIX}-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: ${RADIUS.sm}px;
  color: ${c.textDim};
  transition: color 100ms ease, background 100ms ease;
}
.${PREFIX}-btn:hover { color: ${c.text}; background: ${c.hover}; }
.${PREFIX}-btn[aria-pressed="true"] { color: ${c.text}; background: ${c.raised}; }

/* The underline is a child so it can slide; the tab only dims and brightens. */
.${PREFIX}-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0 12px;
  height: 100%;
  color: ${c.textFaint};
  white-space: nowrap;
  transition: color 100ms ease;
}
.${PREFIX}-tab:hover { color: ${c.textDim}; }
.${PREFIX}-tab[aria-selected="true"] { color: ${c.text}; }
.${PREFIX}-tab[aria-selected="true"]::after {
  content: "";
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -1px;
  height: 1px;
  background: ${c.text};
}

/* A left-rail row: the raised fill and the chevron are what "you are here" looks like. */
.${PREFIX}-side {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: ${RADIUS.md}px;
  color: ${c.textDim};
  text-align: left;
  transition: color 100ms ease, background 100ms ease;
}
.${PREFIX}-side:hover { color: ${c.text}; background: ${c.hover}; }
.${PREFIX}-side[aria-current="true"] {
  color: ${c.text};
  background: ${c.raised};
  border-color: ${c.hairline};
}

/* Rows fill on hover rather than outline: a border appearing would shift the text beside it. */
.${PREFIX}-row {
  display: flex;
  align-items: center;
  width: 100%;
  transition: background 90ms ease;
}
.${PREFIX}-row:hover { background: ${c.hover}; }
.${PREFIX}-action {
  opacity: 0;
  color: ${c.textDim};
  transition: opacity 90ms ease, color 90ms ease;
}
.${PREFIX}-row:hover .${PREFIX}-action, .${PREFIX}-action:focus-visible { opacity: 1; }
.${PREFIX}-action:hover { color: ${c.text}; }

.${PREFIX}-input, .${PREFIX}-select {
  background: ${c.sunken};
  border: 1px solid ${c.hairline};
  border-radius: ${RADIUS.md}px;
  color: ${c.text};
  transition: border-color 100ms ease;
}
.${PREFIX}-input:focus-within, .${PREFIX}-input:hover,
.${PREFIX}-select:hover, .${PREFIX}-select:focus { border-color: ${c.hairlineStrong}; }
.${PREFIX}-input input::placeholder { color: ${c.textFaint}; }
.${PREFIX}-select option { background: ${c.surface}; color: ${c.text}; }

/* The gridline crossing. Two hairlines through a point, drawn brighter than the lines they mark. */
.${PREFIX}-cross {
  position: absolute;
  width: 9px;
  height: 9px;
  pointer-events: none;
}
.${PREFIX}-cross::before, .${PREFIX}-cross::after {
  content: "";
  position: absolute;
  background: ${c.crosshair};
}
.${PREFIX}-cross::before { left: 0; right: 0; top: 4px; height: 1px; }
.${PREFIX}-cross::after { top: 0; bottom: 0; left: 4px; width: 1px; }

/* The drag edge is 1px of border and 7px of target: visible hairline, forgiving hit area. */
.${PREFIX}-grip { background: transparent; transition: background 120ms ease; }
.${PREFIX}-grip:hover, .${PREFIX}-grip[data-dragging="true"] { background: ${c.hairlineStrong}; }

.${PREFIX}-scroll { overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.${PREFIX}-scroll::-webkit-scrollbar { width: 9px; height: 9px; }
.${PREFIX}-scroll::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.12);
  border: 3px solid transparent;
  background-clip: content-box;
  border-radius: ${RADIUS.pill}px;
}
.${PREFIX}-scroll::-webkit-scrollbar-thumb:hover { background-color: rgba(255, 255, 255, 0.22); }
.${PREFIX}-scroll::-webkit-scrollbar-track { background: transparent; }

@media (prefers-reduced-motion: reduce) {
  .${PREFIX}-root * { transition-duration: 1ms !important; }
}
`;
