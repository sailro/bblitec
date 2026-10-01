import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
    runRmlUiFixture,
} from "./native-fixture.js";

test("nullable boolean logical values retain the selected tag and operand effects", async (t) => {
    const cases: string[] = [];
    for (const absent of [null, undefined]) {
        const type = `boolean | ${String(absent)}`;
        const suffix = absent === null ? "Null" : "Undefined";
        cases.push(`
            function left${suffix}(value: ${type}): ${type} { reads++; return value; }
            function right${suffix}(value: ${type}): ${type} { effects++; return value; }
            function and${suffix}(a: ${type}, b: ${type}): ${type} {
                return left${suffix}(a) && right${suffix}(b);
            }
            function or${suffix}(a: ${type}, b: ${type}): ${type} {
                return left${suffix}(a) || right${suffix}(b);
            }
        `);
        for (const left of [false, true, absent]) {
            for (const right of [false, true, absent]) {
                for (const operator of ["and", "or"] as const) {
                    const expected =
                        operator === "and" ? left && right : left || right;
                    const effects =
                        operator === "and" ? Number(!!left) : Number(!left);
                    cases.push(`
                        reads = 0; effects = 0;
                        if (${operator}${suffix}(${String(left)}, ${String(right)}) !== ${String(expected)} ||
                            reads !== 1 || effects !== ${effects})
                            throw new Error("${operator} ${String(left)} ${String(right)} selection");
                    `);
                }
            }
        }
    }
    const result = compileSource(
        `let reads = 0; let effects = 0; ${cases.join("\n")}
        function readObject(value: {enabled: boolean} | undefined): {enabled: boolean} | undefined {
            reads++; return value;
        }
        function objectAnd(value: {enabled: boolean} | undefined): boolean | undefined {
            const selected = readObject(value);
            return selected && rightUndefined(selected.enabled);
        }
        function nullableObjectAnd(value: {enabled: boolean} | null): boolean | null {
            return value && rightNull(value.enabled);
        }
        reads = 0; effects = 0;
        if (objectAnd(undefined) !== undefined || reads !== 1 || effects !== 0)
            throw new Error("object absence selection");
        if (objectAnd({enabled: false}) !== false || reads !== 2 || effects !== 1)
            throw new Error("present false object selection");
        if (objectAnd({enabled: true}) !== true || reads !== 3 || effects !== 2)
            throw new Error("present true object selection");
        if (nullableObjectAnd(null) !== null || effects !== 2 ||
            nullableObjectAnd({enabled: false}) !== false || effects !== 3)
            throw new Error("null object selection");
        `,
    );
    const native = optionalNativeFixtureTools(false);
    await t.test("native", { skip: !native }, () => {
        runGeneratedProgram(native!, "nullable-boolean-logical", result.cpp);
    });
});

test("optional DOM tree receivers preserve conjunction values and lazy effects natively", (t) => {
    const directory = resolve("artifacts/optional-dom-parent");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(`
        const element = document.createElement("span");
        const parent = document.createElement("div");
        let effects = 0;
        let reads = 0;
        function reached(): boolean { effects++; return true; }
        function readElement(): HTMLElement { reads++; return element; }
        function condition(el: HTMLElement): boolean {
            if (el.classList.contains("item") &&
                el.parentElement?.classList.contains("parent") &&
                el.parentElement.classList.contains("open") && reached()) return true;
            return false;
        }
        function value(el: HTMLElement): boolean | undefined {
            return el.classList.contains("item") &&
                el.parentElement?.classList.contains("parent") &&
                el.parentElement.classList.contains("open") && reached();
        }
        if (condition(element) || value(element) !== false || effects !== 0)
            throw new Error("false first operand evaluated the parent");
        element.classList.add("item");
        if (condition(element) || value(element) !== undefined || effects !== 0)
            throw new Error("detached element lost absence or reached the RHS");
        const missing = element.parentElement?.classList.contains("parent") && reached();
        if (missing !== undefined || effects !== 0)
            throw new Error("bound conjunction lost absence");
        if (readElement().parentElement?.classList.contains("parent") !== undefined || reads !== 1)
            throw new Error("nullable receiver was evaluated twice");
        parent.appendChild(element);
        if (condition(element) || value(element) !== false || effects !== 0)
            throw new Error("missing parent class was not false");
        parent.classList.add("parent");
        if (condition(element) || value(element) !== false || effects !== 0)
            throw new Error("missing final class evaluated the RHS");
        parent.classList.add("open");
        if (!condition(element) || value(element) !== true || effects !== 2)
            throw new Error("detached subtree lost a present parent");
        document.body.appendChild(parent);
        if (!condition(element) || value(element) !== true || effects !== 4)
            throw new Error("attached tree conjunction");
        if (readElement().parentElement?.classList.contains("parent") !== true || reads !== 2)
            throw new Error("present receiver was evaluated twice");
        element.remove();
        if (condition(element) || value(element) !== undefined || effects !== 4)
            throw new Error("removed parent was cached");
        function alternative(el: HTMLElement): boolean | undefined {
            return el.parentElement?.classList.contains("parent") ||
                (reached() && el.parentElement?.classList.contains("open"));
        }
        if (alternative(element) !== undefined || effects !== 5)
            throw new Error("false OR arm did not preserve undefined");
        parent.appendChild(element);
        if (alternative(element) !== true || effects !== 5)
            throw new Error("true OR arm evaluated its RHS");
        globalThis.close();
    `);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    emitUpstreamGenerated(directory, ["core", "backend:sdl"]);
    runRmlUiFixture(t, "optional-dom-parent", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
            BBLITE_HAS_PBR_RENDERER: 0,
            BBLITE_HAS_SDL_GPU: 1,
            BBLITE_HAS_DAWN: 0,
        },
        includeDirectories: [join(directory, "upstream/include")],
    });
});

test("optional DOM class receivers keep unsupported member arguments explicit", () => {
    assert.throws(
        () =>
            compileSource(`
            const element = document.createElement("span");
            const name = document.body.textContent;
            element.parentElement?.classList.contains(name!);
        `),
        /Expected a string literal/,
    );
});
