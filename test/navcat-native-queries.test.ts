/**
 * The Navcat API compiled natively from the pin's sources answers the
 * demo's queries exactly as the pin's own build does in Node: every path
 * point, node reference and debug primitive, for each start, destination
 * and filter the demo page selects, and after a mesh replacement.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const NAVMESH = "corpus/babylon-lite/lab/public/navcat/demo-navmesh.json";

/** The demo page's selectable endpoints (`start`, `end`) and filters. */
const QUERIES = [2, -2].flatMap((start) =>
    [-2, 2].flatMap((end) =>
        (["default", "blocked", "cost"] as const).map((filter) => ({
            start,
            end,
            filter,
        })),
    ),
);

/** The demo's two filters, as one source both runs evaluate, typed as the pin's options. */
const FILTER_SOURCE = `function filterFor(name: string): NavcatFilter | null {
    return name === "blocked"
        ? { pass: (node) => node.area !== 2 }
        : name === "cost"
          ? { cost: (a, b, current) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * (current.area === 2 ? 4 : 1) }
          : null;
}`;

interface Answer {
    success: boolean;
    complete: boolean;
    points: string;
    nodeRefs: string;
    primitives: string[];
}

/** One query's answer as text: numbers as JavaScript prints them, so equal text is equal bits. */
const ANSWER_SOURCE = `function answer(path: NavcatPathResult, primitives: NavcatDebugGeometry[]) {
    return {
        success: path.success,
        complete: path.complete,
        points: path.points.map((p) => \`\${p.position.x} \${p.position.y} \${p.position.z} \${p.nodeRef === null ? "null" : p.nodeRef} \${p.offMesh ? "off" : "on"}\`).join(";"),
        nodeRefs: path.nodeRefs.join(","),
        primitives: primitives.map((p) => [p.kind, Array.from(p.positions).join(","), Array.from(p.colors).join(","), p.indices ? Array.from(p.indices).join(",") : "-"].join("|")),
    };
}`;

/** The helpers both runs evaluate, as Node runs the TypeScript. */
function helpers(): {
    filterFor: (
        name: string,
    ) => Parameters<typeof import("@babylonjs/lite").setNavcatFilter>[1];
    answer: (path: unknown, primitives: unknown) => Answer;
} {
    const exports: Record<string, unknown> = {};
    runInNewContext(
        ts.transpileModule(
            `${FILTER_SOURCE}
${ANSWER_SOURCE}
export { filterFor, answer };`,
            {
                compilerOptions: {
                    module: ts.ModuleKind.CommonJS,
                    target: ts.ScriptTarget.ES2022,
                },
            },
        ).outputText,
        { exports },
    );
    return exports as ReturnType<typeof helpers>;
}

async function pinnedAnswers(json: string): Promise<Answer[]> {
    const lite = await import("@babylonjs/lite");
    const { filterFor, answer } = helpers();
    const manager = await lite.createNavcatManager(json);
    const answers: Answer[] = [];
    for (const replaced of [false, true]) {
        if (replaced) lite.replaceNavcatMesh(manager, json);
        for (const { start, end, filter } of QUERIES) {
            lite.setNavcatFilter(manager, filterFor(filter));
            const path = lite.findNavcatPath(
                manager,
                { x: -4, y: 0, z: start },
                { x: 4, y: 0, z: end },
                undefined,
                { keepSearch: true },
            );
            answers.push(
                answer(
                    path,
                    await lite.createNavcatDebugGeometry(manager, {
                        search: path,
                    }),
                ),
            );
        }
    }
    lite.disposeNavcatManager(manager);
    return answers;
}

test("native Navcat queries answer the demo's routes exactly as the pin", async (t) => {
    const json = readFileSync(NAVMESH, "utf8");
    const expected = await pinnedAnswers(json);
    assert.equal(expected.length, QUERIES.length * 2);
    assert.ok(expected.every((answer) => answer.success));
    const directory = resolve("artifacts/navcat-native-queries");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(
        `import {
    createNavcatManager,
    createNavcatDebugGeometry,
    disposeNavcatManager,
    findNavcatPath,
    replaceNavcatMesh,
    setNavcatFilter,
} from "babylon-lite";
import type { NavcatDebugGeometry, NavcatFilter, NavcatPathResult } from "babylon-lite";

${FILTER_SOURCE}

${ANSWER_SOURCE}

const json = ${JSON.stringify(json)};
// Data the run reads, as the demo reads its page's selections: one loop serves every query.
const queries = JSON.parse(${JSON.stringify(JSON.stringify(QUERIES))}) as { start: number; end: number; filter: string }[];
const expected = JSON.parse(${JSON.stringify(JSON.stringify(expected))}) as { success: boolean; complete: boolean; points: string; nodeRefs: string; primitives: string[] }[];

void (async () => {
    const manager = await createNavcatManager(json);
    let index = 0;
    for (const replaced of [false, true]) {
        if (replaced) replaceNavcatMesh(manager, json);
        for (const query of queries) {
            setNavcatFilter(manager, filterFor(query.filter));
            const path = findNavcatPath(manager, { x: -4, y: 0, z: query.start }, { x: 4, y: 0, z: query.end }, undefined, { keepSearch: true });
            const got = answer(path, await createNavcatDebugGeometry(manager, { search: path }));
            const want = expected[index]!;
            const label = "query " + index + " (" + query.start + " to " + query.end + ", " + query.filter + (replaced ? ", replaced" : "") + ")";
            if (got.success !== want.success || got.complete !== want.complete) throw new Error(label + " result flags");
            if (got.points !== want.points) throw new Error(label + " points " + got.points);
            if (got.nodeRefs !== want.nodeRefs) throw new Error(label + " node references " + got.nodeRefs);
            if (got.primitives.length !== want.primitives.length) throw new Error(label + " debug primitive count");
            for (let i = 0; i < got.primitives.length; i++) {
                const have = got.primitives[i]!;
                const wanted = want.primitives[i]!;
                if (have === wanted) continue;
                let at = 0;
                while (have[at] === wanted[at]) at++;
                throw new Error(label + " debug primitive " + i + " at " + at + ": " + have.slice(Math.max(0, at - 40), at + 40) + " / " + wanted.slice(Math.max(0, at - 40), at + 40));
            }
            index++;
        }
    }
    disposeNavcatManager(manager);
    let message = "";
    try {
        findNavcatPath(manager, { x: -4, y: 0, z: 2 }, { x: 4, y: 0, z: -2 });
    } catch (error) {
        message = error instanceof Error ? error.message : "not an Error";
    }
    if (message !== "#666") throw new Error("disposed manager query threw '" + message + "'");
    globalThis.close();
})();
`,
        { fileName: join(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "navcat-native-queries", result.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        timeoutMs: 60000,
        expectedOutput: "",
    });
});
