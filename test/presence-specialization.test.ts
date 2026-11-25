import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runSelfCheckingProgram } from "./self-checking-program.js";

test("a shared body specializes on the presence its argument proves", (t) => {
    // `doc.v ?? 0.2` is never nullish: each body that tests its parameter's
    // presence -- a comparison, a default, or handing it to one that does --
    // runs as the body for a present parameter. A record it returns beside
    // a run-time text keeps the text its present branch chose.
    const source = `
function present(tone: number | undefined): string { return tone === undefined ? "absent" : "present"; }
function loose(tone: number | null | undefined): string { return tone == null ? "absent" : "present"; }
function defaulted(tone: number = 7): number { return tone; }
function forwards(tone: number | undefined): string { return present(tone); }
function prelude(tone: number | null): string {
    if (tone === null) return "none";
    return \`k=\${tone.toFixed(3)}\`;
}
function lane(source: string, tone: number | undefined): { vertex: string; fragment: string } {
    if (tone === undefined) return { vertex: source, fragment: prelude(null) };
    return { vertex: source.replace("a", "b"), fragment: prelude(tone) };
}
function read(text: string | null): string {
    const config = JSON.parse(text ?? "{}") as { v?: number };
    const tone = config.v ?? 0.2;
    const picked = lane("xa", tone);
    return [
        present(tone),
        loose(tone),
        String(defaulted(tone)),
        forwards(tone),
        present(config.v),
        picked.vertex,
        picked.fragment,
    ].join(" ");
}
const absent = read(null);
const given = read('{"v":0.5}');
if (absent !== "present present 0.2 present absent xb k=0.200") throw new Error(absent);
if (given !== "present present 0.5 present present xb k=0.500") throw new Error(given);
`;
    return runSelfCheckingProgram(t, "presence-specialization", source, {
        compile: { fileName: resolve("presence-specialization.ts") },
        expectedOutput: "",
    });
});

test("a shader stage reads the text a presence-specialized body returns", () => {
    const source = `
import { createEngine, createShaderMaterial, wgsl } from "babylon-lite";
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn main(@location(0) position: vec3<f32>) -> VertexOutput { var out: VertexOutput; out.position = vec4<f32>(position, 1.0); return out; }\`;
const FRAGMENT = "@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }";
function lane(source: string, tone: number | undefined): { vertex: string; tone: number } {
    if (tone === undefined) return { vertex: source, tone: 0 };
    return { vertex: source.replace("1.0); return out;", "1.0 + 0.0); return out;"), tone };
}
async function main(): Promise<void> {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const engine = await createEngine(canvas);
    const config = JSON.parse(localStorage.getItem("tone") ?? "{}") as { v?: number };
    const picked = lane(VERTEX, config.v ?? 0.2);
    const material = createShaderMaterial({ name: "lane", vertexSource: wgsl\`\${picked.vertex}\`, fragmentSource: wgsl\`\${FRAGMENT}\`, attributes: ["position"] });
    document.title = \`\${material !== undefined} \${picked.tone} \${engine !== undefined}\`;
}
void main();
`;
    // The stage holds the text the present branch chose.
    const { manifest } = compileSource(source);
    assert.match(JSON.stringify(manifest), /1\.0 \+ 0\.0\); return out;/);
});
