import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("closed string helpers retain literal results through stylesheet installation", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        const ACCENT = "#123456";
        function frame(options: { width?: number; color?: string } = {}): string {
            const width = options.width ?? 3;
            const color = options.color ?? ACCENT;
            return \`border: \${width}px solid \${color};\`;
        }
        function skin(width: number): string { return frame({ width }); }
        const CSS = \`.history { \${skin(5)} } .plain { \${frame()} }\`;
        function install(css: string) {
            const sheet = document.createElement("style");
            sheet.textContent = css;
            document.head.appendChild(sheet);
        }
        async function main() {
            await createEngine({});
            install(CSS);
        }
        void main();
    `);
    assert.match(result.cpp, /ui_add_class_style[^\n]*"history"[^\n]*border:5px #123456/);
    assert.match(result.cpp, /ui_add_class_style[^\n]*"plain"[^\n]*border:3px #123456/);
});

test("runtime inputs cannot become static stylesheet strings through helpers", () => {
    assert.throws(() => compileSource(`
        import { createEngine } from "@babylonjs/lite";
        function frame(width: number): string { return \`.history { width: \${width}px; }\`; }
        async function main() {
            await createEngine({});
            const sheet = document.createElement("style");
            sheet.textContent = frame(Math.random());
            document.head.appendChild(sheet);
        }
        void main();
    `), /Expected a string literal/);
});

test("enum-indexed constant palettes preserve strings through nested stylesheet helpers", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        enum Tone { Ocean = "ocean", Sand = "sand" }
        interface Colors { fill: string; ink: string; }
        const palette: Record<Tone, Colors> = {
            [Tone.Ocean]: { fill: "#123456", ink: "white" },
            [Tone.Sand]: { fill: "#fedcba", ink: "black" }
        };
        function colors(tone: Tone): string {
            const selected = palette[tone];
            return \`background: \${selected.fill}; color: \${selected.ink};\`;
        }
        function skin(tone: Tone = Tone.Ocean): string { return colors(tone); }
        async function main() {
            await createEngine({});
            const sheet = document.createElement("style");
            sheet.textContent = \`.water { \${skin()} } .beach { \${skin(Tone.Sand)} }\`;
            document.head.appendChild(sheet);
        }
        void main();
    `);
    assert.match(result.cpp, /ui_add_class_style[^\n]*"water"[^\n]*background-color: #123456; color: white/);
    assert.match(result.cpp, /ui_add_class_style[^\n]*"beach"[^\n]*background-color: #fedcba; color: black/);
});

test("static string specialization evaluates argument effects once and preserves mutable reads", t => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("The native compiler is required."); return; }
    const result = compileSource(`
        enum Tone { Ocean = "ocean", Sand = "sand" }
        const labels: Record<Tone, string> = { [Tone.Ocean]: "Water", [Tone.Sand]: "Beach" };
        function main() {
        let keys = 0;
        function next(): Tone { keys++; return Tone.Ocean; }
        const selected = labels[next()];
        if (keys !== 1 || selected !== "Water") throw new Error("indexed key evaluated more than once");
        let calls = 0;
        function label(): string { calls++; return "ready"; }
        function consume(text: string): void { if (text !== "ready") throw new Error("argument value"); }
        consume(label());
        if (calls !== 1) throw new Error("argument evaluated more than once");
        const settings = { width: 4 };
        function read(): string { return \`\${settings.width}px\`; }
        const first = read();
        settings.width = 7;
        const second = read();
        if (first !== "4px" || second !== "7px") throw new Error("mutable read frozen");
        }
        main();
    `);
    const output = resolve("artifacts/static-string-helpers");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", source]);
    execFileSync(executable, { stdio: "pipe" });
});
