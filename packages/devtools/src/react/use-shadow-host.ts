import { Result, TaggedError } from "@syncmesh/result";
import { useEffect, useState } from "react";

import { STYLESHEET } from "../css.js";
import { documentOf } from "../dom.js";
import { Z_LAYER } from "../tokens.js";

/**
 * The panel lives in a shadow root, and that is the whole styling isolation strategy.
 *
 * Inline styles alone stop us leaking *out*, but they do nothing about leaking *in*: a host page
 * with `* { box-sizing: content-box }`, a Tailwind preflight that strips `button` chrome, or a
 * `[role="table"] { display: table }` rule written for its own tables will reach any element we put
 * in its document. A shadow root is the only boundary in the platform that stops author styles in
 * both directions at once, and it costs one element and no bytes. Inherited properties — `font`,
 * `color`, `line-height` — still cross it, so `:host` sets `all: initial` and puts ours back.
 *
 * The host element covers the viewport and is `pointer-events: none`, with the bubble and the panel
 * opting back in. An overlay that swallows clicks is a devtool that breaks the app it is inspecting.
 */

/** Constructable stylesheets are refused by Safari before 16.4; the `<style>` element is the fallback. */
class StylesheetRefused extends TaggedError("StylesheetRefused")<{ readonly cause: unknown }> {}

const adopt = (shadow: ShadowRoot, doc: Document) => {
  const constructed = Result.try({
    try: () => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLESHEET);
      shadow.adoptedStyleSheets = [sheet];
    },
    catch: (cause) => new StylesheetRefused({ cause }),
  });
  if (constructed.isOk()) return;
  const style = doc.createElement("style");
  style.textContent = STYLESHEET;
  shadow.append(style);
};

/**
 * `undefined` until there is a document, which on a server-rendered app is forever — the caller
 * renders nothing and the devtools cost that page a function call.
 */
export function useShadowHost(): ShadowRoot | undefined {
  const [root, setRoot] = useState<ShadowRoot | undefined>(undefined);
  useEffect(() => {
    const doc = documentOf();
    if (doc === undefined) return;
    const host = doc.createElement("div");
    host.setAttribute("data-syncmesh-devtools", "");
    host.style.cssText = `position:fixed;inset:0;z-index:${Z_LAYER};pointer-events:none;`;
    const shadow = host.attachShadow({ mode: "open" });
    adopt(shadow, doc);
    doc.body.append(host);
    setRoot(shadow);
    return () => {
      host.remove();
    };
  }, []);
  return root;
}
