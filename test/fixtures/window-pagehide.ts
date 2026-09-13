const worker = new Worker(new URL("./window-pagehide-worker.ts", import.meta.url), {type: "module"});
worker.terminate();
let order = "";
window.addEventListener("click", event => {
    const lifecycle = event as unknown as {persisted?: boolean};
    if (lifecycle.persisted === false || lifecycle.persisted !== undefined) throw new Error("Absent lifecycle field");
});
function removed(): void { throw new Error("Removed lifecycle listener ran"); }
window.addEventListener("pagehide", removed);
window.removeEventListener("pagehide", removed);
window.addEventListener("pagehide", () => { order += "capture;"; }, {capture: true});
window.addEventListener("pagehide", (event: PageTransitionEvent) => {
    if (event.type !== "pagehide" || event.target !== document || event.currentTarget !== window ||
        event.eventPhase !== 2 || !event.bubbles || !event.cancelable || event.composed ||
        !event.isTrusted || event.persisted !== false) throw new Error("Page-transition event payload");
    event.preventDefault();
    if (!event.defaultPrevented) throw new Error("Page-transition cancellation state");
    order += "target;";
    queueMicrotask(() => { order += "microtask;"; });
}, {once: true});
window.addEventListener("pagehide", () => {
    if (order !== "capture;target;microtask;") throw new Error("Lifecycle listener order: " + order);
    localStorage.setItem("pagehide-result", order);
});
globalThis.close();
