import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("dynamic DOM query deferral preserves receivers, arguments and optional short circuits", (t) => {
    const directory = resolve("artifacts/deferred-dom-queries");
    mkdirSync(directory, { recursive: true });
    const source = `
        let order = "";
        let caught = 0;
        const root = document.createElement("div");
        root.id = "target";
        document.body.appendChild(root);
        function doc(): Document { order += "D"; return document; }
        function element(): HTMLElement { order += "E"; return root; }
        function selector(): string { order += "Q"; return "#" + root.id; }
        try { doc().querySelector(selector()); } catch (error) {
            if (!error.message.includes("dom:querySelector.dynamic-selector")) throw error;
            caught++;
        }
        try { doc().querySelectorAll(selector()); } catch (error) { caught++; }
        try { element().matches(selector()); } catch (error) { caught++; }
        try { element().closest(selector()); } catch (error) { caught++; }
        const documents: Array<Document | null> = [null];
        const elements: Array<HTMLElement | null> = [null];
        if ((documents[0]?.querySelector(selector()) ?? null) !== null) throw new Error("absent document");
        if (elements[0]?.querySelectorAll(selector()) !== undefined) throw new Error("absent element");
        if (caught !== 4 || order !== "DQDQEQEQ") throw new Error("query effects " + order);
        try { doc().querySelector(":disabled"); } catch (error) { caught++; }
        try { doc().querySelectorAll(":not(:disabled)"); } catch (error) { caught++; }
        try { element().matches(":focus"); } catch (error) { caught++; }
        try { element().closest(":hover"); } catch (error) { caught++; }
        if (elements[0]?.matches(":disabled") !== undefined) throw new Error("absent state query");
        if (caught !== 8 || order !== "DQDQEQEQDDEE") throw new Error("state query effects " + order);
        if (document.querySelector("#target") !== root) throw new Error("static query changed");
        globalThis.close();
    `;
    assert.throws(
        () => compileSource(source),
        /string|literal|Builder 'selector' reads a module-scope/i,
    );
    const result = compileSource(source, {
        fileName: join(directory, "entry.ts"),
        deferredCapabilities: "runtime-throw",
    });
    const sites = result.manifest.deferredCapabilities ?? [];
    assert.equal(sites.length, 11);
    assert.equal(
        sites.filter((site) => site.id.endsWith("interaction-selector")).length,
        5,
    );
    assert.ok(
        sites.every(
            (site) => site.operation === "call" && site.timing === "throw",
        ),
    );
    assert.ok(sites.every((site) => site.signature.includes("selectors")));
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "deferred-dom-queries", {
        macros: { BBLITE_WORKERS: 1, BBLITE_HAS_DOM_INPUT: 1 },
    });
});

test("authored Document-shaped objects retain their own query methods", () => {
    const result = compileSource(
        `
        const doc = { querySelector(selector: string): string { return selector + "!"; } };
        if (doc.querySelector("value") !== "value!") throw new Error("authored query");
    `,
        { deferredCapabilities: "runtime-throw" },
    );
    assert.equal(result.manifest.deferredCapabilities, undefined);
});
