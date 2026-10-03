import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runRmlUiFixture,
} from "./native-fixture.js";

const prefix = `import {createEngine} from "@babylonjs/lite"; await createEngine({});const panel=document.createElement("div");`;

test("physical float and clear share static and dynamic RmlUi admission in both modes", () => {
    for (const deferredCapabilities of [undefined, "runtime-throw"] as const) {
        const result = compileSource(
            prefix +
                `
            panel.style.cssText="float:left;clear:both";
            panel.style.float="right";
            panel.style.cssFloat="left";
            panel.style.setProperty("clear","left");
            const sheet=document.createElement("style");sheet.textContent=".panel{float:none;clear:right}";
            let side="left";panel.style.float=side;side="none";panel.style.clear=side;
            if(panel.style.getPropertyValue("float")!=="left")throw new Error("authored float");
            if(panel.style.cssFloat!==panel.style.float)throw new Error("float alias");
            panel.style.removeProperty("float");
        `,
            deferredCapabilities ? { deferredCapabilities } : {},
        );
        assert.equal(result.manifest.deferredCapabilities, undefined);
        assert.match(result.cpp, /ui_set_style_property/);
        assert.match(result.cpp, /ui_get_style_property\([^\n]*"float"/);
        assert.doesNotMatch(result.cpp, /css-float/);
    }
});

test("logical float and clear keywords keep the explicit admission boundary", () => {
    for (const deferredCapabilities of [undefined, "runtime-throw"] as const)
        for (const property of ["float", "clear"])
            for (const value of ["inline-start", "inline-end"])
                for (const write of [
                    `panel.style.${property}="${value}";`,
                    `panel.style.cssText="${property}:${value}";`,
                    `panel.style.setProperty("${property}","${value}");`,
                ])
                    assert.throws(
                        () =>
                            compileSource(
                                prefix + write,
                                deferredCapabilities
                                    ? { deferredCapabilities }
                                    : {},
                            ),
                        /Retained UI style property/,
                    );
});

test("RmlUi float and clear layout responds to live CSSOM writes and removal", (t) => {
    assert.ok(optionalNativeFixtureTools(), "Native fixture compiler required");
    assert.ok(
        existsSync(
            resolve(
                process.env.BBLITE_RMLUI_DIR ?? "artifacts/tools/rmlui",
                "lib/rmlui.lib",
            ),
        ),
        "Pinned RmlUi library required",
    );
    runRmlUiFixture(t, "ui-floats");
});
