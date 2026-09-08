import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerPhysicsGravity } from "../src/lowering/physics-gravity-lowerer.js";
import { lowerPhysicsHeightfield, physicsHeightfieldModule } from "../src/lowering/physics-heightfield-lowerer.js";
import { importPinnedModuleWithExports } from "../src/pinned-shader-composer.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const store = new UpstreamSourceStore();
test("heightfield and gravity contracts reject unrepresented constructor or dispatch changes", () => {
    for (const [module, before, after, lower] of [
        [physicsHeightfieldModule, "[scaleX, 1, scaleZ]", "[scaleZ, 1, scaleX]", lowerPhysicsHeightfield],
        [physicsHeightfieldModule, "return { _hkShape: hkShape, _type: PhysicsShapeType.HEIGHTFIELD };", "return { _hkShape: hkShape, _type: PhysicsShapeType.MESH };", lowerPhysicsHeightfield],
        ["src/physics/havok.ts", "[gravity.x, gravity.y, gravity.z], worldPosition", "[gravity.z, gravity.y, gravity.x], worldPosition",
            (context: LoweringContext) => lowerPhysicsGravity(context, true)],
        ["src/physics/havok-floating-origin.ts", "setGravity: _setGravity", "setGravity: _setVelocityLimits",
            (context: LoweringContext) => lowerPhysicsGravity(context, false)],
    ] as const) {
        class Changed extends LoweringContext {
            public override sourceFile(path: string): ts.SourceFile {
                if (path !== module) return super.sourceFile(path);
                const source = store.getSource(path);
                assert(source.includes(before));
                return ts.createSourceFile(path, source.replace(before, after), ts.ScriptTarget.Latest, true);
            }
        }
        assert.throws(() => lower(new Changed(store)), /changed|exactly/);
    }
});

const tools = optionalNativeFixtureTools();
test("heightfields preserve pinned ground samples, rays, contacts and region gravity", { skip: !tools }, async () => {
    const pin = await importPinnedModuleWithExports<{
        optionsFromGroundMesh(mesh: { _cpuPositions: Float32Array; worldMatrix: Float32Array }): {
            numX: number; numZ: number; sizeX: number; sizeZ: number; data: Float32Array;
        };
    }>("physics/havok-heightfield.js", ["optionsFromGroundMesh"]);
    const floats = (values: ArrayLike<number>): string => [...new Uint32Array(Float32Array.from(values).buffer)]
        .map(word => `std::bit_cast<float>(${word}u)`).join(", ");
    const cases: string[] = [];
    const matrices = [[1, 1, 1], [1.5, 0.75, 1.5], [2, 1, 0.5], [0.5, 2, 2]].map(scale =>
        Float32Array.from([scale[0]!, 0, 0, 0, 0, scale[1]!, 0, 0, 0, 0, scale[2]!, 0, 1.125, 3.2, -0.375, 1]));
    // A non-diagonal transform observes every world-space coefficient in the pin.
    matrices.push(Float32Array.from([0.8, 0.2, 0.4, 0, 0.3, 1.1, -0.2, 0, -0.4, 0.1, 0.9, 0, -2.25, 4.5, 0.75, 1]));
    for (const count of [2, 3, 5]) for (const matrix of matrices) {
        const coordinates: number[] = [];
        for (let z = 0; z < count; ++z) for (let x = 0; x < count; ++x) {
            coordinates.push(x - (count - 1) / 2, ((x * 7 + z * 3) % 11) / 7, z - (count - 1) / 2);
        }
        const positions = Float32Array.from(coordinates);
        const expected = pin.optionsFromGroundMesh({ _cpuPositions: positions, worldMatrix: matrix });
        cases.push(`{
            const auto result = u::pinned_ground_heightfield({${floats(positions)}}, {${floats(matrix)}});
            assert(result.numX == ${expected.numX} && result.numZ == ${expected.numZ});
            assert(result.sizeX == ${expected.sizeX} && result.sizeZ == ${expected.sizeZ});
            assert((result.data == std::vector<float>{${floats(expected.data)}}));
        }`);
    }
    const output = resolve("artifacts/physics-heightfield");
    mkdirSync(output, { recursive: true });
    // The fixture also drives a region's gravity, which is the
    // floating-origin module's arm.
    emitUpstreamGenerated(output, ["core", "camera:free", "renderer:scene", "physics:world", "physics:heightfield", "physics:floating-origin"]);
    writeFileSync(join(output, "heightfield-ground-cases.inc"), cases.join("\n"));
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        "/DBBLITE_HAS_PHYSICS_HEIGHTFIELD=1", "/DBBLITE_HAS_PHYSICS_FLOATING_ORIGIN=1",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include", "/I", output,
        "/I", join(output, "upstream/include"), "/I", join(output, "upstream/src"),
        `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`, "/external:W0",
        "test/fixtures/physics-heightfield-check.cpp", join(output, "upstream/src/scene_core.cpp"),
        "/link", "/OPT:REF", `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`, "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib"]);
    const result = execFileSync(executable, { encoding: "utf8", env: { ...tools!.environment,
        PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}` } });
    assert.match(result, /physics-heightfield: ok/);
    writeFileSync(join(output, "measurements.txt"), result);
});
