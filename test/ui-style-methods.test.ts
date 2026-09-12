import assert from "node:assert/strict";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {runRmlUiFixture} from "./native-fixture.js";

test("CSS declaration methods share field storage and preserve custom property casing", t => {
    const directory = resolve("artifacts/ui-style-methods");
    mkdirSync(directory, {recursive:true});
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(`
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const panel = document.createElement("div");
        panel.id = "panel";
        panel.style.cssText = "--Span:40px;--span:5px;--Tone:red;height:20px;--Inline:'position:fixed;font:bold 20px serif;';--Nested:[{a;b}]";
        if (panel.style.getPropertyValue("--Inline") !== "'position:fixed;font:bold 20px serif;'" ||
            panel.style.getPropertyValue("--Nested") !== "[{a;b}]") throw new Error("inline custom values");
        panel.style.setProperty("--Text", "'position:fixed;font:bold 20px serif;'");
        if (panel.style.getPropertyValue("--Text") !== "'position:fixed;font:bold 20px serif;'")
            throw new Error("custom declaration contents");
        panel.style.setProperty("--Span", "60px");
        if (panel.style.getPropertyValue("--Span") !== "60px" || panel.style.getPropertyValue("--span") !== "5px")
            throw new Error("case-sensitive custom properties");
        panel.style.setProperty("height", "30px", "");
        if (panel.style.height !== "30px" || panel.style.removeProperty("height") !== "30px" || panel.style.height !== "")
            throw new Error("shared field storage and removal");
        if (panel.style.removeProperty("--absent") !== "") throw new Error("absent declaration");
        const child = document.createElement("div");
        child.id = "child";
        child.style.cssText = "width:var(--Span,20px);height:10px;background-color:var(--Tone,green)";
        panel.appendChild(child);
        document.body.appendChild(panel);
        const other = document.createElement("div");
        other.id = "other";
        document.body.appendChild(other);
        let selected = panel;
        function change(): string { selected = other; return "blue"; }
        selected.style.setProperty("--Tone", change());
        if (panel.style.getPropertyValue("--Tone") !== "blue" || other.style.getPropertyValue("--Tone") !== "")
            throw new Error("style receiver before value effects");
        globalThis.close();
    `, {fileName:join(directory, "entry.ts")});
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-style-methods");
});

test("CSS method priority and unsupported property names refuse explicitly", () => {
    const prefix = `import {createEngine} from "@babylonjs/lite"; await createEngine({}); const element = document.createElement("div");`;
    assert.throws(() => compileSource(prefix + `element.style.setProperty("color", "red", "important");`), /priority/);
    assert.throws(() => compileSource(prefix + `element.style.setProperty("imaginary-property", "red");`), /reviewed retained-UI surface/);
});
