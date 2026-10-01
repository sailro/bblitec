import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

/**
 * A module-scope string constant a required-text position reads (a shader
 * source) answers its text when its binding holds run-time data: the
 * constant runs at generation, as its module runs it, once.
 */

const scene = (prelude: string, main = "") => `
    import { createBox, createEngine, createShaderMaterial, wgsl } from "@babylonjs/lite";

    const OUTPUT = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};\`;
    const VERTEX = \`@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}\`;
    const FRAGMENT = \`@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return vec4<f32>(laneBase(), 0.0, 0.0, 1.0);}\`;
${prelude}
    async function main() {
        const engine = await createEngine({});
        ${main}
        const material = createShaderMaterial({
            vertexSource: wgsl\`\${\`\${OUTPUT}\\n\${VERTEX}\`}\`,
            fragmentSource: wgsl\`\${\`\${BLOCK}\\n\${OUTPUT}\\n\${FRAGMENT}\`}\`,
            attributes: ["position"],
            uniforms: ["worldViewProjection"],
        });
        const box = createBox(engine);
        box.material = material;
    }
`;

const fragment = (prelude: string, main?: string) =>
    compileSource(scene(prelude, main)).manifest.customShaderPrograms[0]!
        .fragmentSource;

// A record field plus one lowers to a run-time sum, so the template holding
// it is run-time data; the builder takes a callback and a module function.
const builder = `
    const LANES = { base: 39 } as const;
    function readerWgsl(name: string, read: (lane: string) => string, lane: number): string {
        return \`fn \${name}() -> f32 { return f32(\${read("x")}) + \${lane}.0; }\`;
    }
    const DIGITS = [0.82, 0.68].map((c) => c.toFixed(1)).join("_");
    const BLOCK = \`// lanes \${LANES.base + 1} \${DIGITS}
\${readerWgsl("laneBase", (lane) => \`\${lane.length}\`, LANES.base)}\`;
`;

test("runs a module constant whose initializer generation cannot fold", () => {
    const source = fragment(builder);
    assert.match(source, /\/\/ lanes 40 0\.8_0\.7/);
    assert.match(
        source,
        /fn laneBase\(\) -> f32 \{ return f32\(1\) \+ 39\.0; \}/,
    );
});

test("runs a module constant whose module holds run-time state", () => {
    const source = fragment(
        `${builder}
    let published = 0;
    export function publish(value: number): void { published = value; }`,
        "publish(BLOCK.length); console.log(BLOCK);",
    );
    assert.match(source, /fn laneBase\(\) -> f32/);
});

test("refuses a module constant whose run would not describe the program's", () => {
    for (const varying of ["Math.random()", "Date.now()"]) {
        assert.throws(
            () =>
                fragment(`
    const BLOCK = \`fn laneBase() -> f32 { return \${${varying}}; }\`;
`),
            /Expected a string literal|without a static string|Template substitutions/,
        );
    }
});

// A module without run-time state folds its constants from their
// initializers, and a computed one is no array literal.
function deckModule(after: string): string {
    const directory = resolve("artifacts/executed-module-constants");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "deck.ts"),
        `
    const ORDER: readonly ("left" | "up" | "right")[] = ["left", "up", "right"];
    const LABELS: { action: string; label: string }[] = [
        { action: "up", label: "Up arrow" },
        { action: "left", label: "Left arrow" },
        { action: "right", label: "Right arrow" },
    ];
    const KEYS: readonly { action: string; label: string }[] = ORDER.map((action) => ({
        action,
        label: LABELS.find((entry) => entry.action === action)!.label,
    }));
    export function createDeck(): HTMLElement {
        const row = document.createElement("div");
        for (const key of KEYS) {
            const cell = document.createElement("span");
            cell.dataset.action = key.action;
            cell.textContent = key.label;
            row.appendChild(cell);
        }
        return row;
    }
    ${after}`,
    );
    const fileName = join(directory, "entry.ts");
    const source = `import { createDeck } from "./deck";
document.body.appendChild(createDeck());`;
    writeFileSync(fileName, source);
    return compileSource(source, { fileName }).cpp;
}

test("unrolls a static iteration over a module constant the program computes", () => {
    const labels = [...deckModule("").matchAll(/"(Left|Up|Right) arrow"/g)].map(
        ([, label]) => label,
    );
    assert.deepEqual(labels, ["Left", "Up", "Right"]);
});

test("leaves a module constant built from a written one to its refusal", () => {
    for (const write of [
        `LABELS[0]!.label = "Moved";`,
        `for (const entry of LABELS) entry.label = entry.label.toUpperCase();`,
        `const first = LABELS.find((entry) => entry.action === "up")!; first.label = "x";`,
        `Object.assign(LABELS[0]!, { label: "z" });`,
    ]) {
        assert.throws(
            () => deckModule(write),
            /Expected a static array literal/,
        );
    }
});
