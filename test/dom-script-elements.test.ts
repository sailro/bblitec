import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/dom-script-elements");

function compileEntry(body: string): string {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    return compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        ${body}`,
        { fileName: join(directory, "entry.ts") },
    ).cpp;
}

test("an external script element is retained and fails to load: error fires after append, load never", (t) => {
    const cpp = compileEntry(`
        const log = document.createElement("div");
        log.id = "log";
        document.body.append(log);
        let order = "";
        function record(value: string): void { order += value; log.textContent = order; }
        const id = "T-1";
        function appendTag(doc: Document | undefined): void {
            if (!doc || doc.querySelector(\`script[data-tag="\${id}"]\`)) {
                record("Q");
                return;
            }
            const script = doc.createElement("script");
            // A created script is force-async until the property is written.
            record(script.async ? "a" : "x");
            script.async = true;
            script.src = \`https://example.invalid/tag.js?id=\${encodeURIComponent(id)}\`;
            script.dataset.tag = id;
            record(script.src === "https://example.invalid/tag.js?id=T-1" ? "s" : "x");
            script.addEventListener("error", (e) => {
                record(e.type === "error" && e.target === script ? "E" : "x");
            }, { once: true });
            script.addEventListener("load", () => record("L"));
            doc.head.appendChild(script);
            record("A");
        }
        appendTag(document);
        appendTag(document);
        const relative = document.createElement("script");
        relative.src = "scripts/x.js";
        relative.async = false;
        record(relative.src === "http://localhost/scripts/x.js" && !relative.async ? "r" : "x");
        // A detached script and a data block never load.
        const detached = document.createElement("script");
        detached.src = "detached.js";
        detached.addEventListener("error", () => record("D"));
        const data = document.createElement("script");
        data.type = "application/json";
        data.src = "data.json";
        data.addEventListener("error", () => record("J"));
        document.head.append(data);
        // Inline script text has no engine to run it.
        const inline = document.createElement("script");
        inline.append("1");
        try { document.body.append(inline); } catch { record("I"); }
        // Removed and aborted listeners never run; src added while connected prepares.
        const late = document.createElement("script");
        document.body.append(late);
        const never = (): void => record("N");
        late.addEventListener("error", never);
        late.removeEventListener("error", never);
        const controller = new AbortController();
        late.addEventListener("error", () => record("S"), { signal: controller.signal });
        controller.abort();
        late.addEventListener("error", () => {
            record("e");
            globalThis.close();
        });
        late.setAttribute("src", "late.js");
        record("|");
    `);
    writeFileSync(join(directory, "program.hpp"), cpp);
    assert.match(cpp, /bbl::ui_set_script_async\([^;]+, true\)/);
    assert.match(cpp, /bbl::on_dom_pointer\([^;]+"error"/);
    assert.match(cpp, /bbl::off_dom_pointer\([^;]+"error"/);
    assert.match(
        cpp,
        /bbl::ui_get_url_attribute\([^;]+"src", "http:\/\/localhost\/"\)/,
    );
    runRmlUiFixture(t, "dom-script-elements", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("inline script text refuses at generation", () => {
    for (const write of [
        "script.textContent = 'run()';",
        "script.innerText = 'run()';",
        "script.innerHTML = 'run()';",
    ])
        assert.throws(
            () =>
                compileEntry(`
                const script = document.createElement("script");
                ${write}
                document.head.append(script);
            `),
            /Inline script text does not run natively: there is no JavaScript engine/,
            write,
        );
});
