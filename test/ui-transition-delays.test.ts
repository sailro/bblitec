import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/ui-transition-delays");

// Stylesheets installed through an idempotent helper (generation-known text,
// so no runtime installation bridge), transition and animation shorthands in
// sheet rules, and per-element delay lists written at runtime: inline lists,
// custom properties and negative delays.
const program = `
    function installStyle(id: string, css: string, refresh = false): HTMLStyleElement {
        let style = document.getElementById(id) as HTMLStyleElement | null;
        if (!style) {
            style = document.createElement("style");
            style.id = id;
            style.textContent = css;
            document.head.appendChild(style);
        } else if (refresh) {
            style.textContent = css;
        }
        return style;
    }
    const LEAD = 40;
    installStyle("delay-sheet", \`
        .pill { opacity: 0; width: 10px; height: 10px; transition: opacity 100ms linear, width 100ms linear \${LEAD + 60}ms; }
        .pill.open { opacity: 1; width: 110px; }
        .later { opacity: 0; transition: opacity 100ms linear; transition-delay: 200ms; }
        .reset { opacity: 0; transition-delay: 200ms; transition: opacity 100ms linear; }
        .own { opacity: 0; transition: opacity 100ms linear 50ms; }
        .later.on, .reset.on, .own.on { opacity: 1; }
        .dot { width: 4px; height: 4px; animation: pulse 400ms linear infinite; animation-delay: var(--delay, 0ms); }
        @keyframes pulse { from { opacity: 0; } to { opacity: 1; } }
    \`);
    installStyle("delay-sheet", ".ignored { opacity: 0.5; }");
    function hideCss(exempt: string): string {
        return \`body.hidden > *:not(.\${exempt}) { display: none; }\`;
    }
    installStyle("hide-sheet", hideCss("pill"));
    const badge = document.createElement("div");
    badge.id = "badge";
    badge.style.cssText = ["position:absolute", "left:12px", "transition:opacity 90ms linear"].join(";");
    document.body.appendChild(badge);
    const springMs = Number("120");
    const pill = document.createElement("div");
    pill.id = "pill";
    pill.className = "pill";
    pill.style.transitionDelay = \`\${springMs}ms, \${springMs * 2}ms\`;
    document.body.appendChild(pill);
    for (const name of ["later", "reset", "own"]) {
        const element = document.createElement("div");
        element.id = name;
        element.className = name;
        document.body.appendChild(element);
    }
    const stars: [string, number][] = [["star", 0.3]];
    for (const [id, delay] of stars) {
        const star = document.createElement("i");
        star.id = id;
        star.className = "dot";
        star.style.animationDelay = \`\${delay}s\`;
        document.body.appendChild(star);
    }
    for (const [id, delay] of [["mote", -0.1], ["late-mote", -0.9]] as const) {
        const mote = document.createElement("i");
        mote.id = id;
        mote.className = "dot";
        mote.style.setProperty("--delay", \`\${delay}s\`);
        document.body.appendChild(mote);
    }
    globalThis.close();
`;

test("delay longhands lower in strict mode from inline writes and helper-installed sheets", () => {
    const result = compileSource(program);
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.match(
        result.cpp,
        /ui_set_style_property\([^;]+"transition-delay", bbl::js::concat\(/,
    );
    assert.match(result.cpp, /ui_set_style_property\([^;]+"animation-delay"/);
    assert.match(result.cpp, /transition-delay:200ms/);
    assert.match(result.cpp, /animation-delay:var\(--delay, 0ms\)/);
    const deferred = compileSource(program, {
        deferredCapabilities: "runtime-throw",
    });
    assert.equal(deferred.manifest.deferredCapabilities, undefined);
});

test("delay longhands run natively: item lists, shorthand resets, variables and negative delays", (t) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        ${program}`,
        { fileName: join(directory, "entry.ts") },
    );
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-transition-delays", {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
});
