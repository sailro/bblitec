import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const deferredCapabilities = "runtime-throw" as const;

test("deferred script members retain exact typed sites", () => {
    const result = compileSource(
        `
        const script = document.createElement('script');
        script.src = 'module.js';script.async = true;
        const listener = () => { atob(script.src); };
        script.addEventListener('error', listener);
        script.removeEventListener('error', listener);
    `,
        { deferredCapabilities },
    );
    const ids = new Set(
        result.manifest.deferredCapabilities?.map((site) => site.id),
    );
    for (const id of [
        "HTMLScriptElement.src",
        "HTMLScriptElement.async",
        "HTMLScriptElement.addEventListener",
        "HTMLScriptElement.removeEventListener",
    ])
        assert.ok(ids.has(`dom:${id}`), id);
});
