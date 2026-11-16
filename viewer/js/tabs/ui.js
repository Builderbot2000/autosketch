// Small DOM helpers shared by the management UI's tab modules (docs/design/15-management-ui.md).
// Loaded only with the first tab that needs it, never by the Observe tab.

/** `h("div", {class: "x", onclick}, ...children)`. */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Polls `fn` every `ms` while started; stops on `stop()`. Errors are passed to `onError`. */
export function poller(fn, ms, onError = () => {}) {
  let timer = null;
  const tick = async () => {
    try {
      await fn();
    } catch (e) {
      onError(e);
    }
    if (timer !== null) timer = setTimeout(tick, ms);
  };
  return {
    start() {
      if (timer === null) timer = setTimeout(tick, ms);
    },
    stop() {
      clearTimeout(timer);
      timer = null;
    },
  };
}
