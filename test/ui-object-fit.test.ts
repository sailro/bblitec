import assert from "node:assert/strict";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {PNG} from "pngjs";
import {compileSource} from "../src/compiler.js";
import {runRmlUiFixture} from "./native-fixture.js";

function compileFit(value: string): string {
    return compileSource(`
        import {createEngine} from "@babylonjs/lite";
        await createEngine({});
        const image = document.createElement("img");
        image.style.cssText = "width:100px;height:100px;object-fit:${value}";
        document.body.appendChild(image);
        image.addEventListener("click", () => { image.style.objectFit = "cover"; });
    `).cpp;
}

test("retained object-fit validates declarations and projects live style writes", () => {
    for (const value of ["fill", "contain", "cover", "none", "scale-down"]) {
        const cpp = compileFit(value);
        assert.ok(cpp.includes(`object-fit:${value}`));
        assert.match(cpp, /ui_set_style_property\([^\n]+"object-fit", "cover"/);
    }
    assert.throws(() => compileFit("stretch"), /object-fit.*only fill, contain, cover, none and scale-down/);
});

test("native image fitting preserves layout and clips painted geometry", t => {
    const output = resolve("artifacts/ui-object-fit");
    mkdirSync(output, {recursive:true});
    for (const [name, width, height] of [["wide", 200, 100], ["tall", 40, 80]] as const) {
        const raster = new PNG({width, height});
        for (let i = 0; i < raster.data.length; i += 4) raster.data.set([200, 100, 50, 255], i);
        writeFileSync(join(output, `${name}.png`), PNG.sync.write(raster));
    }
    runRmlUiFixture(t, "ui-object-fit", {imageDecoder:true});
});
