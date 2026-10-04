import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { hostPageCompileOptions, readHostPage } from "../src/host-page.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("classic scripts observe parser prefixes and microtasks before module evaluation", (t) => {
    const directory = resolve("artifacts/page-startup");
    mkdirSync(directory, { recursive: true });
    const entry = `
        import "./dependency.js";
        if (document.body.dataset.order !== "SMEND") throw new Error("entry order");
        globalThis.close();
    `;
    writeFileSync(join(directory, "entry.ts"), entry);
    writeFileSync(
        join(directory, "dependency.ts"),
        `
        if (document.body.dataset.order !== "SMEN") throw new Error("dependency order");
        document.body.dataset.order = "SMEND";
    `,
    );
    const path = join(directory, "page.html");
    writeFileSync(
        path,
        `<!doctype html>
        <html><head><title>Ordered startup</title></head><body>
        <section id="parent"><div id="before"></div>
        <script>(function () {
            var parent = document.getElementById("parent");
            var before = document.getElementById("before");
            if (!parent || !before || !parent.contains(before)) throw new Error("missing prefix");
            if (document.getElementById("after")) throw new Error("future element visible");
            document.body.dataset.order = "S";
            Promise.resolve().then(function () {
                if (document.getElementById("after")) throw new Error("microtask saw future element");
                if (document.body.dataset.order !== "S") throw new Error("initial script order");
                document.body.dataset.order = "SM";
            });
        })();</script>
        <div id="after"></div></section>
        <script>(function () {
            if (document.body.dataset.order !== "SM") throw new Error("microtask order");
            document.body.dataset.order = "SME";
            throw new Error("expected startup error");
        })();</script>
        <script>(function () {
            if (!document.getElementById("after")) throw new Error("missing later element");
            if (document.body.dataset.order !== "SME") throw new Error("error continuation order");
            document.body.dataset.order = "SMEN";
        })();</script>
        <script type="module" src="/entry.ts"></script>
        </body></html>`,
    );
    const host = readHostPage({ path });
    assert.equal(host.startup?.length, 3);
    const result = compileSource(entry, hostPageCompileOptions(host));
    assert.ok(
        result.manifest.inputs.some((input) => input.endsWith("page.html")),
    );
    assert.ok(
        result.manifest.inputs.every(
            (input) => !input.includes("inline-classic"),
        ),
    );
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "page-startup", {
        macros: { BBLITE_WORKERS: 1, BBLITE_HAS_DOM_INPUT: 1 },
    });
});

test("retained dataset compound writes cannot disappear as browser instrumentation", () => {
    assert.throws(
        () =>
            compileSource(
                'document.body.setAttribute("data-order", "start"); document.body.dataset.order += "next"; globalThis.close();',
            ),
        /Compound retained dataset assignments/,
    );
});
