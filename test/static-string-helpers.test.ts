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

test("numeric template substitutions share constant evaluation beside string helpers", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        const EDGE = 7;
        const GAP = EDGE + 3;
        const WIDTH = 2 * GAP;
        function unit(): string { return "px"; }
        const CSS = \`.panel { width: \${WIDTH}\${unit()}; margin-left: \${-2}px; }
            .other { width: \${2 * (7 + 3)}px; height: \${Math.max(12, 20)}px;
                margin-top: \${Math.PI}px; padding: \${(2 * GAP).toFixed(1)}px; }\`;
        async function main() {
            await createEngine({});
            const sheet = document.createElement("style");
            sheet.textContent = CSS;
            document.head.appendChild(sheet);
        }
        void main();
    `);
    assert.match(result.cpp, /ui_add_class_style[^\n]*"panel"[^\n]*width:\s*20px;\s*margin-left:\s*-2px/);
    assert.match(result.cpp, /ui_add_class_style[^\n]*"other"[^\n]*margin-top: 3\.141592653589793px; padding: 20\.0px/);
});

test("unknown explicit formatting precision cannot fold as omitted precision", () => {
    for (const method of ["toFixed", "toPrecision", "toExponential"]) {
        assert.throws(() => compileSource(`
            function main() {
                const text = \`\${(1.25).${method}(Math.random())}\`;
                if (text === "") throw new Error("unexpected empty value");
            }
            main();
        `), /requires a static number and integer precision/);
    }
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
        let mutable = 2;
        function change(): string { mutable = 5; calls++; return "next"; }
        const ordered = \`\${mutable}-\${change()}-\${mutable}\`;
        if (ordered !== "2-next-5" || calls !== 2) throw new Error("template read order");
        let steps = 0;
        function step(): number { steps++; return steps; }
        const stepped = \`\${step()}/\${step()}\`;
        if (stepped !== "1/2" || steps !== 2) throw new Error("template call order");
        function mutateParameter(value: number): string {
            value += 1;
            const before = \`\${value}\`;
            value += 2;
            return \`\${before}:\${value}\`;
        }
        if (mutateParameter(3) !== "4:6") throw new Error("mutable template parameter");
        function mutateText(value: string): string { value += "!"; return \`\${value}\`; }
        function mutateFlag(value: boolean): string { value = !value; return \`\${value}\`; }
        if (mutateText("ready") !== "ready!" || mutateFlag(true) !== "false")
            throw new Error("mutable primitive template parameters");
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
