import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { constructorEntryBody } from "../src/compiler/output-projection.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerPhysicsViewer, physicsViewerModule } from "../src/lowering/physics-viewer-lowerer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

const store = new UpstreamSourceStore();
class ChangedContext extends LoweringContext {
    public constructor(private readonly module: string, private readonly before: string, private readonly after: string) { super(store); }
    public override sourceFile(module: string): ts.SourceFile {
        if (module !== this.module) return super.sourceFile(module);
        const source = store.getSource(module);
        assert(source.includes(this.before), "The mutation must reach the pin.");
        return ts.createSourceFile(module, source.replace(this.before, this.after), ts.ScriptTarget.Latest, true);
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
        ["viewer.scene._beforeRender.push(viewer._update)", "viewer.scene._beforeRender.unshift(viewer._update)"],
        ["mesh.scaling.set(1, 1, 1)", "mesh.scaling.set(2, 1, 1)"],
        ["lines[o++] = a;", "lines[o++] = c;"],
    ]) assert.throws(() => lowerPhysicsViewer(new ChangedContext(physicsViewerModule, before!, after!)), /changed|exactly/);
    assert.throws(() => lowerPhysicsViewer(new ChangedContext("src/physics/havok.ts", "geometryInfo[1] * 3", "geometryInfo[1] * 2")), /changed|exactly/);
});

test("constructor projection omits only direct unread clock initializers", () => {
    assert.deepEqual(constructorEntryBody(["double unused = bbl::pal::performance_milliseconds();", "auto mesh = create_mesh();"]), ["", "auto mesh = create_mesh();"]);
    for (const body of [
        ["double clock = bbl::pal::performance_milliseconds();", "mesh.radius = clock;"],
        ["double clock = 1.0 + bbl::pal::performance_milliseconds();"],
        ["double clock = query_clock();"],
    ]) assert.deepEqual(constructorEntryBody(body), body);
});

test("body viewer compilation isolates startup and refuses observable bootstrap-dependent results", () => {
    const source = readFileSync("test/fixtures/physics-viewer.ts", "utf8");
    const options = { fileName: "viewer.ts" };
    const result = compileSource(source, options);
    const main = result.cpp;
    const extraction = main.slice(main.indexOf("static void extract_physics_constructor_inputs"), main.indexOf("int main("));
    assert.match(extraction, /create_physics_aggregate/);
    assert.doesNotMatch(extraction, /start_engine/);
    assert.match(main.slice(main.indexOf("int main(")), /start_engine/);
    for (const statement of ["const debug = showPhysicsBody(viewer, aggregate.body);", "if (showPhysicsBody(viewer, aggregate.body)) mesh.position.x = 2;"]) {
        assert.throws(() => compileSource(source.replace("showPhysicsBody(viewer, aggregate.body);", statement), options), /discarded showPhysicsBody/);
    }
    const observed = compileSource(source.replace("registerScene(scene);", "for (const shown of scene.meshes) { shown.position.x = 2; } registerScene(scene);"), options);
    assert.match(observed.cpp, /require_runtime_execution\("observable scene mesh membership"\)/);
});
