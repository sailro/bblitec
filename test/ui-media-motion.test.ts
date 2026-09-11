import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("reduced-motion source and host rules share the native condition", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        await createEngine({});
        const sheet = document.createElement("style");
        sheet.textContent = "@media (prefers-reduced-motion: reduce){.panel{animation:none;transition:none;}}@media (prefers-reduced-motion: no-preference){.panel{opacity:0.5;}}";
        document.head.appendChild(sheet);
        const panel = document.createElement("div");
        panel.className = "panel";
        document.body.appendChild(panel);
    `, { nativeHostUi: { sourcePath: "fixture.json", elements: [], styleRules: [
        { kind: "class", primary: "panel", reducedMotion: true, style: "animation:none;" },
    ] } });
    assert.match(result.cpp, /ui_add_style_rule[^\n]+UiMotionPreference::Reduce/);
    assert.match(result.cpp, /ui_add_style_rule[^\n]+UiMotionPreference::NoPreference/);
    assert.match(result.cpp, /ui_add_host_style_rule[^\n]+UiMotionPreference::Reduce/);
});

test("reduced-motion changes update conditional styles without altering the system preference", t => {
    runRmlUiFixture(t, "ui-media-motion");
});

test("media rules refuse structural grid substitutions", () => {
    for (const columns of ["repeat(2, 40px)", "40px 1fr"]) {
        assert.throws(() => compileSource(`
            import { createEngine } from "@babylonjs/lite";
            await createEngine({});
            const sheet = document.createElement("style");
            sheet.textContent = "@media (prefers-reduced-motion: reduce){.panel{display:grid;grid-template-columns:${columns};}}";
            document.head.appendChild(sheet);
        `), /structural grid substitution is not accepted inside a media query/);
    }
});
