import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { hasOnlyReportingEffects } from "../src/compiler/canvas-instrumentation.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

for (const [name, handler, setup] of [
    [
        "default-parameter",
        "(_error: unknown, value = recover()) => console.error(value)",
        "",
    ],
    [
        "property-getter",
        "() => console.error(record.value)",
        "const record = {get value(): number { return recover(); }};",
    ],
    [
        "indexed-getter",
        '() => console.error(record["value"])',
        "const record = {get value(): number { return recover(); }};",
    ],
] as const) {
    test(`entry reporter preserves ${name} recovery effects before realm activation`, (t) => {
        const source = `
            let recovered = 0;
            function recover(): number {
                if (++recovered !== 1) throw new Error("repeated recovery");
                return recovered;
            }
            ${setup}
            async function main(): Promise<void> { throw new Error("expected"); }
            main().catch(${handler})
        `;
        const terminal = compileSource(`${source};`);
        assert.ok(terminal.manifest.features.includes("platform:workers"));
        const result = compileSource(`${source}.then(() => {
            if (recovered !== 1) throw new Error("missing recovery");
            globalThis.close();
        });`);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(tools, `entry-reporter-${name}`, result.cpp, {
            defines: ["BBLITE_WORKERS=1"],
            timeoutMs: 10000,
            expectedOutput: "",
        });
    });
}

test("entry reporters preserve the owned-error destructuring boundary", () => {
    assert.throws(
        () =>
            compileSource(`
        async function main(): Promise<void> { throw new Error("expected"); }
        main().catch(({message}) => console.error(message));
    `),
        /Object destructuring is not supported for data/,
    );
});

test("owned rejection text remains a terminal reporting adaptation", () => {
    const result = compileSource(`
        async function main(): Promise<void> { throw new Error("expected"); }
        main().catch((error) => console.error(String(error)));
    `);
    assert.ok(!result.manifest.features.includes("platform:workers"));
});

test("a local function sharing a realm service name keeps ordinary argument lowering", () => {
    const result = compileSource(`
        export {};
        function close(): number { return 1; }
        async function main(): Promise<void> { throw new Error("expected"); }
        main().catch(() => console.error(close()));
    `);
    assert.ok(result.manifest.features.includes("platform:workers"));
});

test("reporting ownership admits confined diagnostic DOM and rejects hidden application effects", () => {
    const cases = [
        [
            true,
            `(error: unknown) => {
            const canvas = document.getElementById("surface") as HTMLCanvasElement | null;
            if (canvas) canvas.dataset.error = String(error instanceof Error ? error.message : error);
            const node = document.createElement("pre");
            const style = node.style;
            style.cssText = "color:red";
            node.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
            document.body.appendChild(node);
            console.error(error);
        }`,
        ],
        [
            true,
            `(error: unknown) => {
            const node = document.createElement("div");
            const child = document.createElement("code");
            child.textContent = String(error);
            node.append(child);
            document.body.append(node);
        }`,
        ],
        [true, "console.error"],
        [
            true,
            `(error: unknown) => {
                document.querySelector("canvas")?.setAttribute("data-error", String(error));
                console.error(error);
            }`,
        ],
        [
            false,
            `(error: unknown) => {
                document.querySelector("canvas")?.setAttribute("data-error", String(error));
            }`,
        ],
        [
            false,
            `(error: unknown) => {
                document.querySelector("canvas")?.setAttribute("data-error", (console.error(error), "failed"));
            }`,
        ],
        [
            false,
            `(error: unknown) => {
                document.querySelector("canvas")?.setAttribute("class", String(error));
                console.error(error);
            }`,
        ],
        [
            false,
            `(error: unknown) => {
                document.querySelector("canvas")?.setAttribute("data-error", String(state));
                console.error(error);
            }`,
        ],
        [
            false,
            `(error: unknown) => {
                document.querySelector("canvas")?.setAttribute("data-error", String(recover()));
                console.error(error);
            }`,
        ],
        [
            false,
            `(error: unknown) => {
                document.querySelector<HTMLCanvasElement>(String(recover()))?.setAttribute("data-error", String(error));
                console.error(error);
            }`,
        ],
        [false, "() => {}"],
        [false, "() => 42"],
        [false, "(error: unknown) => { if (false) console.error(error); }"],
        [false, "(error: unknown) => false ? console.error(error) : undefined"],
        [false, "(error: unknown) => (console.error(error), 42)"],
        [false, "(error: unknown) => { state.count++; console.error(error); }"],
        [false, "(error: unknown) => console.error(state.value)"],
        [false, '() => console[(recover(), "error")]()'],
        [false, "(error: unknown) => acquireConsole().error(error)"],
        [
            false,
            "(error: unknown) => { const node = document.createElement('pre'); state.node = node; console.error(error); }",
        ],
        [
            false,
            "(error: unknown) => { document.body.textContent = String(error); console.error(error); }",
        ],
        [
            false,
            "(error: unknown) => { const node = document.createElement('diagnostic-widget'); node.textContent = String(error); document.body.append(node); }",
        ],
        [false, "(error = recover()) => console.error(error)"],
        [
            false,
            "(error: unknown) => { globalThis.close(); console.error(error); }",
        ],
        [
            false,
            "(error: unknown) => { setTimeout(() => recover(), 0); console.error(error); }",
        ],
        [false, "(error: unknown) => console.error(String(state))"],
    ] as const;
    const source = `
        const state = {count: 0, node: document.body, get value() { return recover(); }};
        function recover(): number { return ++state.count; }
        function acquireConsole(): Console { recover(); return console; }
        ${cases.map(([, handler], index) => `const handler${index} = ${handler};`).join("\n")}
    `;
    const { checker, sourceFile } = createCompilerProgram(
        source,
        "reporting-ownership.ts",
    );
    const handlers = sourceFile.statements
        .filter(ts.isVariableStatement)
        .slice(1);
    assert.equal(handlers.length, cases.length);
    for (const [index, statement] of handlers.entries()) {
        const handler = statement.declarationList.declarations[0]!.initializer!;
        assert.equal(
            hasOnlyReportingEffects(checker, handler, {
                ownedRejection: true,
                allowReportingDom: true,
                isUnobservedWrite: () => false,
            }),
            cases[index]![0],
            cases[index]![1],
        );
    }
    const domHandler =
        handlers[0]!.declarationList.declarations[0]!.initializer!;
    assert.equal(
        hasOnlyReportingEffects(checker, domHandler, {
            ownedRejection: false,
            allowReportingDom: false,
            isUnobservedWrite: () => false,
        }),
        false,
    );
});

test("empty and value-returning rejection handlers retain native recovery", (t) => {
    for (const handler of ["() => {}", "() => 42"]) {
        const source = `
            async function main(): Promise<${handler.includes("42") ? "number" : "void"}> { throw new Error("expected"); }
            main().catch(${handler})
        `;
        assert.ok(
            compileSource(`${source};`).manifest.features.includes(
                "platform:workers",
            ),
        );
        const result = compileSource(
            `${source}.then(() => { globalThis.close(); });`,
        );
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(
            tools,
            `entry-reporter-recovery-${handler.includes("42") ? "value" : "empty"}`,
            result.cpp,
            {
                defines: ["BBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    }
});

test("confined entry diagnostic DOM does not activate retained UI", (t) => {
    const result = compileSource(`
        async function main(): Promise<void> { }
        main().catch((error) => {
            const canvas = document.getElementById("surface") as HTMLCanvasElement | null;
            if (canvas) canvas.dataset.error = error instanceof Error ? error.message : String(error);
            const report = document.createElement("pre");
            report.style.cssText = "color:red";
            report.textContent = String(error);
            document.body.appendChild(report);
            console.error(error);
        });
    `);
    assert.ok(!result.manifest.features.includes("platform:workers"));
    assert.ok(!result.manifest.features.includes("ui:rml"));
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "entry-confined-reporting-dom", result.cpp, {
        timeoutMs: 10000,
        expectedOutput: "",
    });
});

test("queried canvas metadata reporting preserves one terminal entry execution", (t) => {
    const result = compileSource(`
        let starts = 0;
        function initialize(): number { return ++starts; }
        const initialized = initialize();
        async function main(): Promise<void> {
            if (initialized !== 1 || starts !== 1)
                throw new Error("entry initialization count");
        }
        main().catch((error) => {
            document.querySelector("canvas")?.setAttribute("data-failure", error);
            console.error(error);
        });
    `);
    assert.ok(!result.manifest.features.includes("platform:workers"));
    assert.ok(!result.manifest.features.includes("ui:rml"));
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "entry-canvas-metadata-reporter", result.cpp, {
        timeoutMs: 10000,
        expectedOutput: "",
    });
});
