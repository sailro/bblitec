import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    constructorEntryBody,
    markUnreferencedLocals,
    nativeDeclarationPatterns,
} from "../src/compiler/output-projection.js";
import type { NativeDeclaration } from "../src/compiler/native-declarations.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    lowerPhysicsViewer,
    physicsViewerModule,
} from "../src/lowering/physics-viewer-lowerer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

const store = new UpstreamSourceStore();
class ChangedContext extends LoweringContext {
    public constructor(
        private readonly module: string,
        private readonly before: string,
        private readonly after: string,
    ) {
        super(store);
    }
    public override sourceFile(module: string): ts.SourceFile {
        if (module !== this.module) return super.sourceFile(module);
        const source = store.getSource(module);
        assert(
            source.includes(this.before),
            "The mutation must reach the pin.",
        );
        return ts.createSourceFile(
            module,
            source.replace(this.before, this.after),
            ts.ScriptTarget.Latest,
            true,
        );
    }
}

test("viewer contracts cover body geometry, lifecycle and live node transforms", () => {
    lowerPhysicsViewer(new LoweringContext(store));
    for (const [before, after] of [
        ["_registered: false", "_registered: true"],
        ["viewer._bodies[i] === body", "viewer._bodies[i] !== body"],
        ["debugMesh.pickable = false", "debugMesh.pickable = true"],
        ["debugMesh.renderOrder = 1000", "debugMesh.renderOrder = 999"],
        ["viewer._bodies.splice(index, 1)", "viewer._bodies.splice(index, 2)"],
        [
            "viewer.scene._beforeRender.push(viewer._update)",
            "viewer.scene._beforeRender.unshift(viewer._update)",
        ],
        ["mesh.scaling.set(1, 1, 1)", "mesh.scaling.set(2, 1, 1)"],
        ["lines[o++] = a;", "lines[o++] = c;"],
    ])
        assert.throws(
            () =>
                lowerPhysicsViewer(
                    new ChangedContext(physicsViewerModule, before!, after!),
                ),
            /changed|exactly/,
        );
    assert.throws(
        () =>
            lowerPhysicsViewer(
                new ChangedContext(
                    "src/physics/havok.ts",
                    "geometryInfo[1] * 3",
                    "geometryInfo[1] * 2",
                ),
            ),
        /changed|exactly/,
    );
});

test("constructor projection omits only direct unread clock initializers", () => {
    const clock: NativeDeclaration = {
        kind: "declaration",
        type: "double",
        name: "unused",
        initializer: "bbl::pal::performance_milliseconds()",
        discardIfUnused: true,
    };
    const declarations = new Map([
        [`${clock.type} ${clock.name} = ${clock.initializer};`, clock],
    ]);
    assert.deepEqual(
        constructorEntryBody(
            [
                "double unused = bbl::pal::performance_milliseconds();",
                "auto mesh = create_mesh();",
            ],
            nativeDeclarationPatterns(declarations),
        ),
        ["", "auto mesh = create_mesh();"],
    );
    const usedClock: NativeDeclaration = {
        ...clock,
        name: "clock",
    };
    assert.deepEqual(
        constructorEntryBody(
            [
                "double clock = bbl::pal::performance_milliseconds();",
                "mesh.radius = clock;",
            ],
            nativeDeclarationPatterns(
                new Map([
                    [
                        `double ${usedClock.name} = ${usedClock.initializer};`,
                        usedClock,
                    ],
                ]),
            ),
        ),
        [
            "double clock = bbl::pal::performance_milliseconds();",
            "mesh.radius = clock;",
        ],
    );
    for (const [name, initializer] of [
        ["clock", "1.0 + bbl::pal::performance_milliseconds()"],
        ["clock", "query_clock()"],
    ] as const) {
        const declaration: NativeDeclaration = {
            kind: "declaration",
            type: "double",
            name,
            initializer,
        };
        const body = [`double ${name} = ${initializer};`];
        assert.deepEqual(
            constructorEntryBody(
                body,
                nativeDeclarationPatterns(new Map([[body[0]!, declaration]])),
            ),
            body,
        );
    }
});

test("structured declaration projection handles multiline templates, optionals and deferred blocks", () => {
    const template: NativeDeclaration = {
        kind: "declaration",
        type: "auto",
        name: "template_value",
        initializer: "std::array{\n    1,\n    2,\n}",
    };
    const optional: NativeDeclaration = {
        kind: "declaration",
        type: "std::optional<std::string>",
        name: "optional_value",
        initializer: "",
        initialization: "default",
    };
    const clock: NativeDeclaration = {
        kind: "declaration",
        type: "double",
        name: "erased_clock",
        initializer: "bbl::pal::performance_milliseconds()",
        discardIfUnused: true,
    };
    const declarations = new Map<string, NativeDeclaration>([
        ["auto template_value = std::array{\n    1,\n    2,\n};", template],
        ["std::optional<std::string> optional_value{};", optional],
        ["double erased_clock = bbl::pal::performance_milliseconds();", clock],
    ]);
    const body = [
        "auto template_value = std::array{\n    1,\n    2,\n};",
        "    std::optional<std::string> optional_value{};",
        "    bbl::defer_start_continuation(engine, [&]() {\n" +
            "        double erased_clock = bbl::pal::performance_milliseconds(\n" +
            "            );\n" +
            "    });",
    ];
    declarations.set(
        "double erased_clock = bbl::pal::performance_milliseconds(\n    );",
        clock,
    );
    markUnreferencedLocals(body, nativeDeclarationPatterns(declarations));
    assert.match(body[0]!, /^\[\[maybe_unused\]\] auto template_value/);
    assert.match(body[1]!, /^\s*\[\[maybe_unused\]\] std::optional/);
    assert.doesNotMatch(body[2]!, /erased_clock/);
});

test("body viewer compilation isolates startup and refuses observable bootstrap-dependent results", () => {
    const source = readFileSync("test/fixtures/physics-viewer.ts", "utf8");
    const options = { fileName: "viewer.ts" };
    const result = compileSource(source, options);
    const main = result.cpp;
    const extraction = main.slice(
        main.indexOf("static void extract_physics_constructor_inputs"),
        main.indexOf("int main("),
    );
    assert.match(extraction, /create_physics_aggregate/);
    assert.doesNotMatch(extraction, /start_engine/);
    assert.match(main.slice(main.indexOf("int main(")), /start_engine/);
    const sceneRead = compileSource(
        source
            .replace("createEngine,", "addToScene, createEngine,")
            .replace(
                "showPhysicsBody(viewer, aggregate.body);",
                "addToScene(viewer.scene, mesh); showPhysicsBody(viewer, aggregate.body);",
            ),
        options,
    );
    assert.match(sceneRead.cpp, /add_to_scene\(\(v_viewer\)->scene, v_mesh\)/);
    for (const statement of [
        "const debug = showPhysicsBody(viewer, aggregate.body);",
        "if (showPhysicsBody(viewer, aggregate.body)) mesh.position.x = 2;",
    ]) {
        assert.throws(
            () =>
                compileSource(
                    source.replace(
                        "showPhysicsBody(viewer, aggregate.body);",
                        statement,
                    ),
                    options,
                ),
            /discarded showPhysicsBody/,
        );
    }
    const observed = compileSource(
        source.replace(
            "registerScene(scene);",
            "for (const shown of scene.meshes) { shown.position.x = 2; } registerScene(scene);",
        ),
        options,
    );
    assert.match(
        observed.cpp,
        /require_runtime_execution\("observable scene mesh membership"\)/,
    );
});
