import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/ui-runtime-image-src");
const publicDir = join(directory, "public");

function writeImages(): void {
    mkdirSync(join(publicDir, "assets/ui"), { recursive: true });
    for (const [name, color] of [
        ["red", [255, 0, 0]],
        ["green", [0, 255, 0]],
        ["blue", [0, 0, 255]],
    ] as const) {
        const raster = new PNG({ width: 4, height: 4 });
        for (let i = 0; i < raster.data.length; i += 4)
            raster.data.set([...color, 255], i);
        writeFileSync(
            join(publicDir, `assets/ui/${name}.png`),
            PNG.sync.write(raster),
        );
    }
}

function compileEntry(body: string) {
    writeImages();
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    return compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const BASE = import.meta.env.BASE_URL;
        const appUrl = (path: string): string => BASE + path.replace(/^\\/+/, "");
        ${body}`,
        { fileName: join(directory, "entry.ts"), publicDir },
    );
}

test("runtime img src selects packaged images the URL inference finds, with load and error", (t) => {
    const result = compileEntry(`
        const sheet = document.createElement("style");
        sheet.textContent = "img{position:absolute;top:0;width:10px;height:10px}" +
            "#a{left:0}#c0{left:20px}#c1{left:40px}#d0{left:60px}#d1{left:80px}" +
            "#f0{left:100px}#f1{left:120px}#g0{left:140px}#g1{left:160px}#g2{left:180px}" +
            "#f2{left:200px}#d2{left:220px}#g3{left:240px}";
        document.head.append(sheet);
        const log = document.createElement("div");
        log.id = "log";
        document.body.append(log);
        let order = "";
        let events = 0;
        function record(value: string): void {
            order += value;
            log.textContent = order;
            if (++events === 4) globalThis.close();
        }
        function place(img: HTMLImageElement, id: string): void {
            img.id = id;
            document.body.append(img);
        }
        // A helper call with a literal path.
        const a = document.createElement("img");
        a.addEventListener("load", () => record(a.complete && a.naturalWidth === 4 ? "A" : "x"));
        a.src = appUrl("/assets/ui/red.png");
        place(a, "a");
        // A record field read from a descriptor table.
        const DEFS = [{ id: "c0", icon: "/assets/ui/green.png" }, { id: "c1", icon: "/assets/ui/blue.png" }];
        for (const def of DEFS) {
            const img = document.createElement("img");
            img.src = appUrl(def.icon);
            place(img, def.id);
        }
        // A frozen table looked up by a key parameter.
        const ICONS = Object.freeze({ play: appUrl("/assets/ui/red.png"), stop: appUrl("/assets/ui/blue.png") });
        function icon(name: keyof typeof ICONS, id: string): void {
            const img = document.createElement("img");
            img.src = ICONS[name];
            place(img, id);
        }
        icon("play", "d0");
        icon("stop", "d1");
        // An interface method's optional icon overrides its kind's default.
        type Kind = "red" | "green";
        interface Fx { burst(kind: Kind, id: string, icon?: string): void }
        function createFx(): Fx {
            const iconUrl = (kind: Kind): string => appUrl(\`/assets/ui/\${kind}.png\`);
            return {
                burst(kind: Kind, id: string, icon?: string): void {
                    const img = document.createElement("img");
                    img.src = icon ?? iconUrl(kind);
                    place(img, id);
                },
            };
        }
        const fx = createFx();
        fx.burst("green", "f0");
        fx.burst("red", "f1", appUrl("/assets/ui/blue.png"));
        // An optional image tested truthy, else the empty source.
        function toast(id: string, image?: string): HTMLImageElement {
            const img = document.createElement("img");
            const chosen = image ?? "";
            img.src = chosen ? appUrl(chosen) : "";
            place(img, id);
            return img;
        }
        toast("g0", "/assets/ui/blue.png");
        const empty = toast("g1");
        empty.onerror = () => record("E");
        // The empty source already failed: a handler set afterwards still runs (a task).
        const missing = toast("g2", "/assets/ui/missing.png");
        missing.addEventListener("error", () => record("M"));
        // Selections a run-time value decides.
        const night = performance.now() < 0;
        fx.burst(night ? "red" : "green", "f2");
        icon(night ? "play" : "stop", "d2");
        toast("g3", night ? undefined : "/assets/ui/red.png");
        const preload = new Image();
        preload.onload = () => record(preload.naturalHeight === 4 ? "P" : "x");
        preload.onerror = () => record("x");
        preload.src = appUrl("/assets/ui/green.png");
    `);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    const outputs = result.manifest.assets.map((asset) => asset.output).sort();
    for (const name of ["red", "green", "blue"])
        assert.ok(outputs.includes(`assets/ui/${name}.png`), name);
    assert.ok(!outputs.some((output) => output.includes("missing")));
    assert.match(result.cpp, /bbl::set_dom_pointer_handler\([^;]+"error"/);
    assert.match(result.cpp, /bbl::ui_create_element\([^;]+"img"\)/);
    runRmlUiFixture(t, "ui-runtime-image-src", {
        imageDecoder: true,
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("application images retain both logical and hashed outputs for one source", () => {
    const result = compileEntry(`
        const img = document.createElement("img");
        img.src = appUrl("/assets/ui/red.png");
        document.body.append(img);
        const panel = document.createElement("div");
        panel.style.borderImage = "url('/assets/ui/red.png') 1 / 2px stretch";
        document.body.append(panel);
    `);
    const assets = result.manifest.assets.filter((asset) =>
        asset.source.endsWith("/assets/ui/red.png"),
    );
    assert.equal(assets.length, 2);
    assert.ok(assets.every((asset) => asset.kind === "texture"));
    assert.equal(assets[0]!.source, assets[1]!.source);
    assert.ok(assets.some((asset) => asset.output === "assets/ui/red.png"));
    assert.ok(
        assets.some((asset) => /^[a-f0-9]+-red\.png$/.test(asset.output)),
    );
    for (const asset of assets) assert.ok(result.cpp.includes(asset.output));
});

test("runtime img src strings generation cannot bound refuse", () => {
    for (const [body, pattern] of [
        [
            `const img = document.createElement("img"); img.src = localStorage.getItem("icon") ?? "";`,
            /An img src write requires sources generation can package/,
        ],
        [
            `const img = document.createElement("img"); const pick = (big: boolean): string => big ? "http://localhost/assets/ui/red.png" : appUrl("/assets/ui/blue.png"); img.src = pick(Date.now() > 0);`,
            /img src candidate 'http:\/\/localhost\/assets\/ui\/red.png' must be a root-relative or relative URL/,
        ],
    ] as const)
        assert.throws(() => compileEntry(body), pattern, body);
});
