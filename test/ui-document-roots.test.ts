import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {runRmlUiFixture} from "./native-fixture.js";

test("document roots retain separate identity, styles and attached descendants", t => {
    const directory = resolve("artifacts/ui-document-roots");
    mkdirSync(directory, {recursive:true});
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(`
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const html = document.documentElement;
        const body = document.body;
        const head = document.head;
        if (html === body || head === body || html !== document.documentElement) throw new Error("root identity");
        html.id = "root";
        body.id = "body";
        head.id = "head";
        html.lang = "fr";
        if (document.documentElement.lang !== "fr") throw new Error("reflected root language");
        function setWidth(element: HTMLElement): void { element.style.setProperty("--Width", "83px"); }
        setWidth(document.documentElement);
        const style = document.createElement("style");
        style.textContent = "html > .direct { width:var(--Width);height:11px; }";
        document.head.appendChild(style);
        const child = document.createElement("div");
        child.id = "direct";
        child.className = "direct";
        html.appendChild(child);
        const inner = document.createElement("div");
        inner.id = "inner";
        inner.style.cssText = "width:var(--Width);height:7px";
        document.body.appendChild(inner);
        function identity(element: HTMLElement): HTMLElement { return element; }
        if (identity(document.body) !== body) throw new Error("body helper identity");
        globalThis.close();
    `, {fileName:join(directory, "entry.ts")});
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-document-roots");
});
