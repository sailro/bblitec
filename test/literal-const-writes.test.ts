import { resolve } from "node:path";
import test from "node:test";
import { runSelfCheckingProgram } from "./self-checking-program.js";

// An object-literal `const` resolves to its literal only where nothing
// writes through it (`StaticEvaluator.isWrittenThrough`). A write through
// each shape a program hands a member on reaches it: what the program reads
// back afterwards is what JavaScript reads.
const shapes: readonly (readonly [string, string, string])[] = [
    [
        "literal argument",
        "function widen(holder: { opts: { width: number } }): void { holder.opts.width = 2; }",
        "widen({ opts: params.wood });",
    ],
    [
        "returning call",
        "function woodOf(owner: typeof params): { width: number } { return owner.wood; }",
        "woodOf(params).width = 2;",
    ],
    [
        "library container",
        "",
        'const kept = new Map<string, { width: number }>(); kept.set("w", params.wood); kept.get("w")!.width = 2;',
    ],
    ["library writer", "", "Object.assign(params.wood, { width: 2 });"],
];

for (const [shape, helpers, write] of shapes)
    test(`an object-literal const written through a ${shape} reads back the written member`, (t) =>
        runSelfCheckingProgram(
            t,
            `literal-const-writes-${shape.replace(" ", "-")}`,
            `
            function read(): string {
                const params = { wood: { width: 1.5 }, label: "plank" };
                ${helpers}
                ${write}
                return params.wood.width.toFixed(1) + " " + params.label;
            }
            if (read() !== "2.0 plank") throw new Error("${shape}: " + read());
            `,
            {
                compile: {
                    fileName: resolve(
                        `literal-const-writes-${shape.replace(" ", "-")}.ts`,
                    ),
                },
                expectedOutput: "",
            },
        ));
