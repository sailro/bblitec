import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { VatLowerer } from "../src/lowering/vat-lowerer.js";
import { lowerPreparedVatValidation } from "../src/lowering/vat-prepared.js";
import { doctoredContext } from "./doctored-store.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const modulePath = "src/vat/vat-baker.ts";

test("prepared VAT checks follow changes in the pinned validation bodies", () => {
    const ordinary = lowerPreparedVatValidation(new LoweringContext());
    for (const [before, after, expected] of [
        ["value < 1", "value < 2", /value < 2\.0/],
        [
            "boneCount * frameCount * 16",
            "boneCount * frameCount * 8",
            /\* 8\.0/,
        ],
        ["clip.fps <= 0", "clip.fps < 0", /row\.fps < 0\.0/],
        [
            "values.length !== frameCount * valuesPerFrame",
            "values.length !== frameCount * valuesPerFrame + 1",
            /\+ 1\.0/,
        ],
    ] as const) {
        const changed = lowerPreparedVatValidation(
            doctoredContext(modulePath, before, after),
        );
        assert.notEqual(changed, ordinary);
        assert.match(changed, expected);
    }
});

test("VAT clip counting executes the pinned body, including changed arithmetic and defaults", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const contexts = [
        new LoweringContext(),
        doctoredContext(
            modulePath,
            "Math.round(group.duration * fps)",
            "Math.floor(group.duration * fps)",
        ),
        doctoredContext(
            modulePath,
            "group.frameRate || DEFAULT_FRAME_RATE",
            "group.frameRate ?? DEFAULT_FRAME_RATE",
        ),
    ];
    for (const [index, context] of contexts.entries()) {
        const file = context.sourceFile(modulePath);
        const constant = context.findNodes(
            file,
            (node): node is ts.VariableDeclaration =>
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === "DEFAULT_FRAME_RATE",
        )[0]!;
        const rate = context.numericValue(constant.initializer!, file);
        const declaration = context.functionDeclaration(
            modulePath,
            "clipFrameCount",
        ).declaration;
        const javascript = ts.transpileModule(declaration.getText(file), {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const durations = [0, 0.125, 1, 1.013, 2.5];
        const expected = durations.map((duration): number => {
            const value: unknown = runInNewContext(
                `${javascript}\nclipFrameCount({ duration });`,
                { duration, DEFAULT_FRAME_RATE: rate },
            );
            assert.equal(typeof value, "number");
            return value as number;
        });
        const emitted = new VatLowerer(context).lower({
            instances: false,
            baked: true,
        }).source;
        assert.match(emitted, /clipFrameCount/);
        const output = runGeneratedProgram(
            tools,
            `vat-clip-lowering-${index}`,
            `#include <bblite/js_data.hpp>
#include <cstdio>
constexpr double kVatDefaultFrameRate = ${context.doubleLiteral(rate)};
${cppFunction(emitted, "double vat_clip_frames(")}
int main() {
${durations.map((duration) => `    std::printf("%.17g\\n", vat_clip_frames(${context.doubleLiteral(duration)}));`).join("\n")}
}
`,
        );
        assert.deepEqual(output.trim().split(/\s+/).map(Number), expected);
    }
});
