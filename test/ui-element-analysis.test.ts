import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { UiProjection } from "../src/compiler/ui-projection.js";
import {
    dataTypeMayHoldUiElement,
    typeMayMapToUiElement,
} from "../src/compiler/ui-element-analysis.js";

test("checker types reach the UI element handle only through DOM element interfaces", () => {
    const directory = resolve("artifacts/ui-element-analysis");
    mkdirSync(directory, { recursive: true });
    const frontend = createCompilerProgram(
        `
        interface Panel { label: HTMLElement; }
        declare const element: HTMLElement;
        declare const canvas: HTMLCanvasElement | null;
        declare const generic: Element;
        declare const count: number;
        declare const text: string | undefined;
        declare const panel: Panel;
        declare const pending: Promise<HTMLDivElement>;
        declare const labels: Map<string, HTMLElement>;
        declare const table: Map<string, number>;
        declare const target: EventTarget;
        declare const present: NonNullable<HTMLElement | null>;
        declare const mixed: HTMLButtonElement | number;
        function identity<T>(value: T): T { const held = value; return held; }
        `,
        join(directory, "types.ts"),
    );
    const typeOf = (name: string): ts.Type => {
        let found: ts.Type | undefined;
        const visit = (node: ts.Node): void => {
            if (
                (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
                ts.isIdentifier(node.name) &&
                node.name.text === name
            )
                found = frontend.checker.getTypeAtLocation(node.name);
            ts.forEachChild(node, visit);
        };
        visit(frontend.sourceFile);
        assert.ok(found, name);
        return found;
    };
    const may = (name: string): boolean =>
        typeMayMapToUiElement(typeOf(name), frontend.checker);
    for (const name of [
        "element",
        "canvas",
        "generic",
        "pending",
        "labels",
        "present",
        "mixed",
        "value",
    ])
        assert.equal(may(name), true, name);
    for (const name of ["count", "text", "panel", "table", "target"])
        assert.equal(may(name), false, name);
});

test("data values hold UI elements only as the handle or a narrowable event target", () => {
    const element = { kind: "handle", handle: "ui-element" } as const;
    assert.equal(dataTypeMayHoldUiElement(element), true);
    assert.equal(
        dataTypeMayHoldUiElement({ kind: "optional", inner: element }),
        true,
    );
    assert.equal(dataTypeMayHoldUiElement({ kind: "event-target" }), true);
    assert.equal(
        dataTypeMayHoldUiElement({
            kind: "union",
            members: [{ kind: "number" }, element],
        }),
        true,
    );
    assert.equal(dataTypeMayHoldUiElement({ kind: "number" }), false);
    assert.equal(
        dataTypeMayHoldUiElement({ kind: "handle", handle: "mesh" }),
        false,
    );
    assert.equal(dataTypeMayHoldUiElement({ kind: "vector", element }), false);
    assert.equal(
        dataTypeMayHoldUiElement({
            kind: "optional",
            inner: { kind: "struct", name: "Panel" },
        }),
        false,
    );
});

interface Comparison {
    decided: Map<string, number>;
    lowered: Map<string, number>;
    mismatches: string[];
}

/**
 * Compiles `source` and, at every UI element query the analysis decides,
 * lowers the same expression in a declined probe to compare the answers.
 */
function compareWithLowering(
    source: string,
    options: Parameters<typeof compileSource>[1] = {},
): Comparison {
    const comparison: Comparison = {
        decided: new Map(),
        lowered: new Map(),
        mismatches: [],
    };
    const count = (map: Map<string, number>, key: string): void => {
        map.set(key, (map.get(key) ?? 0) + 1);
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Saved for .call(this, ...) and exact restoration.
    const analyze = UiProjection.prototype.analyzedUiElementMetadata;
    UiProjection.prototype.analyzedUiElementMetadata = function (expression) {
        const analyzed = analyze.call(this, expression);
        const site = `${ts.SyntaxKind[expression.kind]} ${expression.getText()}`;
        if (analyzed === "lower") {
            count(comparison.lowered, site);
            return analyzed;
        }
        count(
            comparison.decided,
            `${analyzed ? `element<${analyzed.tag ?? ""}>` : "none"} ${site}`,
        );
        let lowered: unknown;
        try {
            lowered = this.loweredUiElementMetadata(expression);
        } catch (error) {
            lowered = `threw ${String(error)}`;
        }
        if (!isDeepStrictEqual(analyzed, lowered))
            comparison.mismatches.push(
                `${site}: analyzed ${JSON.stringify(analyzed)}, lowered ${JSON.stringify(lowered)}`,
            );
        return analyzed;
    };
    try {
        compileSource(source, options);
    } finally {
        UiProjection.prototype.analyzedUiElementMetadata = analyze;
    }
    return comparison;
}

function decidedSites(comparison: Comparison, prefix: string): string[] {
    return [...comparison.decided.keys()].filter((key) =>
        key.startsWith(prefix),
    );
}

test("the analysis answers retained UI queries exactly as lowering them does", () => {
    const directory = resolve("artifacts/ui-element-analysis");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const comparison = compareWithLowering(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const root = document.createElement("div");
        root.id = "panel";
        const first = document.createElement("button");
        first.className = "entry";
        root.appendChild(first);
        document.body.appendChild(root);
        interface Stats { count: number; label: string; }
        const stats: Stats = { count: 0, label: "hud" };
        class Panel {
            node: HTMLElement | null = null;
            title: HTMLElement;
            clicks = 0;
            stats: Stats = { count: 1, label: "panel" };
            constructor() {
                this.title = document.createElement("span");
                this.title.textContent = "title";
                root.appendChild(this.title);
            }
            build(): void { this.node = document.createElement("div"); }
            render(): void {
                this.clicks = this.clicks + this.stats.count;
                this.title.textContent = this.clicks > 1 ? "many" : "one";
                this.node?.appendChild(document.createElement("i"));
                this.stats.label = String(this.clicks);
            }
        }
        const panel = new Panel();
        panel.build();
        panel.render();
        const style = document.createElement("style");
        style.textContent = ".entry { color: red; }";
        document.head.appendChild(style);
        const selected = root.querySelector(".entry");
        if (selected !== first) throw new Error("query");
        if (first.closest("#panel") !== root) throw new Error("closest");
        const labels: HTMLElement[] = [first];
        labels[0]!.textContent = stats.count > 0 ? stats.label : "none";
        const chosen = stats.count > 0 ? first : root;
        chosen.textContent = "chosen";
        (stats.count > 0 ? first : root).textContent = "conditional";
        interface View { label: HTMLElement; optional: HTMLElement | null; }
        const view: View = { label: first, optional: null };
        view.label.textContent = "record";
        if (view.optional) view.optional.textContent = "optional";
        view.optional?.remove();
        document.getElementById("missing")?.remove();
        stats.count = stats.label.length + labels.length;
        if (stats.count < 0) throw new Error("count");
        globalThis.close();
        `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.deepEqual(comparison.mismatches, []);
    // Retained handles on `this` answer from their bound value, tag included.
    assert.ok(
        decidedSites(
            comparison,
            "element<span> PropertyAccessExpression this.title",
        ).length > 0,
    );
    // Plain data on `this`, other typed members, calls, optional chains and
    // members of conditionals are not elements.
    for (const prefix of [
        "none PropertyAccessExpression this.clicks",
        "none PropertyAccessExpression this.stats",
        "none PropertyAccessExpression stats.count",
        "none PropertyAccessExpression (stats.count > 0 ? first : root).textContent",
        "none CallExpression String(this.clicks)",
        "none CallExpression view.optional?.remove()",
    ])
        assert.ok(decidedSites(comparison, prefix).length > 0, prefix);
    // Element-typed reads, bound names and lookups still lower.
    for (const site of [
        "PropertyAccessExpression view.label",
        "PropertyAccessExpression view.optional",
        "Identifier chosen",
        'CallExpression root.querySelector(".entry")',
    ])
        assert.ok(comparison.lowered.has(site), site);
});

test("the analysis answers canvas and presentation-host queries exactly as lowering them does", () => {
    for (const source of [
        `
        import { createEngine } from "babylon-lite";
        const engine = await createEngine({});
        const canvas = document.createElement("canvas");
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "rgba(255,96,32,0.5)";
        context.fillRect(canvas.width * 0.3, 4.25, -6.5, canvas.height * 0.1);
        document.body.appendChild(canvas);
        `,
        `
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#102030";
        const width = canvas.width;
        const height = canvas.height;
        context.fillRect(0, 0, width, height);
        canvas.dataset.ready = "true";
        `,
    ]) {
        const comparison = compareWithLowering(source);
        assert.deepEqual(comparison.mismatches, []);
        assert.ok(comparison.decided.size > 0);
    }
});
