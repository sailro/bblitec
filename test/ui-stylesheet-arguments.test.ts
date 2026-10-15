import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import type { CompileOptions } from "../src/compiler/types.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/ui-stylesheet-arguments");

// An idempotent installer owning every sheet: feature modules pass their
// module-local text through its parameter, and a refresh replaces it.
const modules: Readonly<Record<string, string>> = {
    "worker.ts": "self.close();",
    "registry.ts": `
        export function installUiStyle(id: string, css: string, refresh = false): HTMLStyleElement {
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
        }`,
    // A typed record: its fields carry no generation-known text, so the
    // sheets reading them fold only by running their constants.
    "palette.ts": `
        export type Tone = "calm" | "alert";
        export const FILL: Readonly<Record<Tone, string>> = { calm: "rgb(0, 128, 0)", alert: "rgb(255, 0, 0)" };`,
    "alert.ts": `
        import { installUiStyle } from "./registry";
        import { FILL } from "./palette";
        const CSS = \`.alert { position: absolute; top: 0; width: 40px; height: 10px; background-color: \${FILL.alert}; }\`;
        export function installAlertStyles(): void { installUiStyle("alert-sheet", CSS); }
        export function refreshAlertStyles(): void {
            installUiStyle("alert-sheet", \`.alert { position: absolute; top: 0; width: 60px; height: 10px; background-color: \${FILL["calm"]}; }\`, true);
        }`,
    "calm.ts": `
        import { installUiStyle } from "./registry";
        const CSS = ".calm { position: absolute; top: 20px; width: 30px; height: 10px; background-color: rgb(0, 0, 255); }";
        function ensure(css: string): void { installUiStyle("calm-sheet", css); }
        export function installCalmStyles(): void { ensure(CSS); }`,
    "masked.ts": `
        import { installUiStyle } from "./registry";
        const CSS = ".masked { mask: none; }";
        export function installMaskedStyles(): void { installUiStyle("masked-sheet", CSS); }`,
    "runtime.ts": `
        import { installUiStyle } from "./registry";
        export function installMeasuredStyles(): void {
            installUiStyle("measured-sheet", \`.measured { width: \${performance.now()}px; }\`);
        }`,
    "rebound.ts": `
        import { FILL } from "./palette";
        const CSS = \`.rebound { color: \${FILL.alert}; }\`;
        function install(css: string): void {
            css = css.trim();
            const style = document.createElement("style");
            style.textContent = css;
            document.head.appendChild(style);
        }
        export function installReboundStyles(): void { install(CSS); }`,
};

const program = `
    import { installAlertStyles, refreshAlertStyles } from "./alert";
    import { installCalmStyles } from "./calm";
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
    worker.terminate();
    installAlertStyles();
    installCalmStyles();
    installAlertStyles();
    const alert = document.createElement("div");
    alert.id = "alert";
    alert.className = "alert";
    document.body.appendChild(alert);
    const calm = document.createElement("div");
    calm.id = "calm";
    calm.className = "calm";
    document.body.appendChild(calm);
    const badge = document.createElement("div");
    badge.id = "badge";
    badge.style.cssText = [
        "position:absolute", "top:40px",
        "width:20px", "height:10px", "background-color:rgb(255, 255, 0)",
    ].join(";");
    document.body.appendChild(badge);
    const refresh = document.createElement("button");
    refresh.id = "refresh";
    refresh.addEventListener("click", () => { refreshAlertStyles(); });
    document.body.appendChild(refresh);
    globalThis.close();
`;

function compileEntry(
    source: string,
    options: CompileOptions = {},
): ReturnType<typeof compileSource> {
    mkdirSync(directory, { recursive: true });
    for (const [name, text] of Object.entries(modules))
        writeFileSync(join(directory, name), text);
    return compileSource(source, {
        ...options,
        fileName: join(directory, "entry.ts"),
    });
}

test("stylesheet text reaches an installer's parameter as each call site's generation-known text", () => {
    for (const options of [
        {},
        { deferredCapabilities: "runtime-throw" as const },
    ]) {
        const { cpp, manifest } = compileEntry(program, options);
        assert.equal(manifest.deferredCapabilities, undefined);
        for (const rule of [
            /ui_add_class_style\([^;]+"alert", "[^"]*width:40px;[^"]*background-color:rgb\(255, 0, 0\)/,
            /ui_add_class_style\([^;]+"alert", "[^"]*width:60px;[^"]*background-color:rgb\(0, 128, 0\)/,
            /ui_add_class_style\([^;]+"calm", "[^"]*width:30px;[^"]*background-color:rgb\(0, 0, 255\)/,
            /ui_set_attribute\([^;]+"style", "position:absolute;top:40px;width:20px;height:10px;--bbl-background-color:rgb\(255, 255, 0\)/,
        ])
            assert.match(cpp, rule);
    }
});

test("a helper-installed sheet refuses or traps at its own source", () => {
    const source = `import { installMaskedStyles } from "./masked"; installMaskedStyles();`;
    assert.throws(
        () => compileEntry(source),
        /masked\.ts:\d+:\d+: Retained UI style property 'mask'/,
    );
    const { manifest } = compileEntry(source, {
        deferredCapabilities: "runtime-throw",
    });
    assert.deepEqual(
        manifest.deferredCapabilities?.map(({ id, file }) => [
            id,
            file.split("/").at(-1),
        ]),
        [["css:property:mask", "masked.ts"]],
    );
});

test("stylesheet and declaration text generation cannot read refuses at its sink", () => {
    for (const options of [
        {},
        { deferredCapabilities: "runtime-throw" as const },
    ]) {
        for (const [source, refusal] of [
            [
                `import { installMeasuredStyles } from "./runtime"; installMeasuredStyles();`,
                /'css' is bound as data without a static string/,
            ],
            [
                // A parameter its body rebinds no longer holds its argument.
                `import { installReboundStyles } from "./rebound"; installReboundStyles();`,
                /'css' is bound as data without a static string/,
            ],
            [
                `const panel = document.createElement("div");
                 panel.style.cssText = String(performance.now());`,
                /Native UI cssText must be a template/,
            ],
            [
                `const palette: Record<string, string> = { red: "red" };
                 palette.red = String(performance.now());
                 const sheet = document.createElement("style");
                 sheet.textContent = \`.panel { color: \${palette.red}; }\`;`,
                /string literal/,
            ],
        ] as const)
            assert.throws(() => compileEntry(source, options), refusal);
    }
});

test("helper-installed sheets apply natively and a refresh replaces one", (t) => {
    writeFileSync(join(directory, "program.hpp"), compileEntry(program).cpp);
    runRmlUiFixture(t, "ui-stylesheet-arguments", {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
});
