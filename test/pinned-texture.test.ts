import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedRgbdHeader } from "../src/lowering/pinned-rgbd.js";
import { pinnedTextureHeader } from "../src/lowering/pinned-texture.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { emitShaderCppExpression } from "../src/shader-cpp-emitter.js";
import { parseWgslExpression } from "../src/shader-ir.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

class EditedStore extends UpstreamSourceStore {
    public edits = new Map<string, (source: string) => string>();
    public override getSourceFile(module: string): ts.SourceFile {
        const edit = this.edits?.get(module);
        return edit ? ts.createSourceFile(module, edit(super.getSource(module)), ts.ScriptTarget.Latest, true) : super.getSourceFile(module);
    }
}

test("texture headers follow changed pinned arithmetic and constants", () => {
    const store = new EditedStore();
    store.edits.set("src/frame-graph/transmission.ts", text => text.replaceAll("1024", "512").replace("REFRACTION_LOD_BIAS = 4", "REFRACTION_LOD_BIAS = 3"));
    store.edits.set("src/resource/trilinear-anisotropic-sampler.ts", text => text.replace("maxAnisotropy: 4", "maxAnisotropy: 2"));
    store.edits.set("src/loader-env/rgbd-decode.ts", text => text.replace("vec3f(2.2)", "vec3f(2.4)"));
    const context = new LoweringContext(store);
    const texture = pinnedTextureHeader(context);
    assert.match(texture, /transmission_grab_size = 512/);
    assert.match(texture, /transmission_sampler_max_anisotropy = 2/);
    assert.match(texture, /biased_mip_level_count\(width, height, \(3.0\)\)/);
    const rgbd = pinnedRgbdHeader(context);
    assert.match(rgbd, /2.4f/);
    assert.equal(rgbd.match(/static const std::array<float, 256>/g)?.length, 1);
});

test("RGBD typed selection tolerates formatting and refuses unbound output dependencies", () => {
    const baseline = pinnedRgbdHeader(new LoweringContext());
    const store = new EditedStore();
    store.edits.set("src/loader-env/rgbd-decode.ts", text => text.replaceAll(";", "; /* nested /* comment */ */\n"));
    assert.equal(pinnedRgbdHeader(new LoweringContext(store)), baseline);
    store.edits.set("src/loader-env/rgbd-decode.ts", text => text.replace("c.rgb", "other.rgb"));
    assert.throws(() => pinnedRgbdHeader(new LoweringContext(store)), /Unbound WGSL/);
    store.edits.set("src/loader-env/rgbd-decode.ts", text => text.replace("textureStore(o", "if(c.a > 0.5){textureStore(o").replace(",1));}`", ",1));}}`"));
    assert.throws(() => pinnedRgbdHeader(new LoweringContext(store)), /unconditional output/);
    store.edits.set("src/loader-env/rgbd-decode.ts", text => text.replace("vec2u(g.x", "vec2u(g.y"));
    assert.throws(() => pinnedRgbdHeader(new LoweringContext(store)), /texel mapping/);
    store.edits.set("src/loader-env/rgbd-decode.ts", text => text.replaceAll('format: "rgba8unorm"', 'format: "rgba16float"'));
    assert.throws(() => pinnedRgbdHeader(new LoweringContext(store)), /rgba8unorm/);
});

test("float shader expression projection preserves swizzles, broadcasts and refusal boundaries", () => {
    const value = parseWgslExpression("vec4f(max(v.zyx, vec3f(1e-3)), 1)");
    const result = emitShaderCppExpression(value, new Map([["v", [{ cpp: "x" }, { cpp: "y" }, { cpp: "z" }]]]));
    assert.deepEqual(result.components, ["std::max(z, 0.001f)", "std::max(y, 0.001f)", "std::max(x, 0.001f)", "1.0f"]);
    assert.throws(() => emitShaderCppExpression({ kind: "call", name: "unknown", arguments: [] }, new Map()), /Unsupported WGSL call/);
});

test("WGSL abstract arithmetic materializes only at a concrete float sink", () => {
    const emit = (expression: string): string[] => emitShaderCppExpression(parseWgslExpression(expression), new Map()).components;
    assert.deepEqual(emit("vec3f(16777216.0 + 1.0 - 16777216.0)"), ["1.0f", "1.0f", "1.0f"]);
    assert.deepEqual(emit("vec2f(1 / 255, 1.0 / 255.0)"), ["0.0f", "0.00392156862745098f"]);
    assert.deepEqual(emit("vec2f(max(2, 7))"), ["7.0f", "7.0f"]);
    assert.throws(() => emit("vec2f(9007199254740992)"), /exact range/);
    assert.throws(() => emit("vec2f(1e100)"), /materialize/);
});

const tools = optionalNativeFixtureTools();
test("generated RGBD preserves every byte-pair result and transmission mip counts", { skip: !tools }, () => {
    const output = resolve("artifacts/pinned-texture-check");
    mkdirSync(output, { recursive: true });
    const context = new LoweringContext();
    writeFileSync(join(output, "pinned_rgbd.hpp"), pinnedRgbdHeader(context));
    writeFileSync(join(output, "pinned_texture.hpp"), pinnedTextureHeader(context));
    const executable = join(output, "pinned-texture-check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", "/fp:precise",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native/include", "test/fixtures/pinned-texture-check.cpp"]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /pinned-texture-check: ok/);
});
