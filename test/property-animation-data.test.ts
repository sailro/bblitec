import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { AnimationLowerer } from "../src/lowering/animation-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

function scene(body: string, declarations = ""): string {
    return `
        import { createEngine, createAnimationManager, createPropertyAnimationClip,
            createPropertyAnimationGroup, goToFrame, playAnimation, updateAnimationManager,
            enablePropertyAnimationBlending, setAnimationWeight, createBox,
            type AnimationManager, type PropertyAnimationClip } from "@babylonjs/lite";
        interface Target { position: { x: number }; value: number }
        ${declarations}
        async function main() {
            const engine = await createEngine({});
            const manager = createAnimationManager({ engine });
            ${body}
        }
    `;
}

const clip = `const clip = createPropertyAnimationClip("slide", [{ path: "position.x",
    keys: [{ frame: 0, value: -2 }, { frame: 10, value: 2 }] }], { frameRate: 10 });`;

const program = scene(`${clip}
    const target: Target = { position: { x: -2 }, value: 0 };
    const original = target.position;
    const group = createPropertyAnimationGroup(manager, target, clip, { loop: false });
    goToFrame(group, 5);
    if (observe(target) !== 0 || original.x !== 0) throw new Error("Seeking did not update the caller's object");
    playAnimation(group);
    updateAnimationManager(manager, 250);
    if (observe(target) !== 1) throw new Error("Live update did not update the caller's object");
    target.position = { x: 42 };
    goToFrame(group, 10);
    if (original.x !== 2 || observe(target) !== 42) throw new Error("Replacing a nested object retargeted the group");
    const scalar = createPropertyAnimationClip("value", [{ path: "value",
        keys: [{ frame: 0, value: 0 }, { frame: 10, value: 10 }] }], { frameRate: 10 });
    const scalarGroup = createPropertyAnimationGroup(manager, target, scalar, { loop: false });
    goToFrame(scalarGroup, 5);
    if (target.value !== 5) throw new Error("Direct scalar path did not bind");

    const literal = { value: 0 };
    const alias = literal;
    const typedAlias: { value: number } = literal;
    const literalGroup = createPropertyAnimationGroup(manager, literal, scalar, { loop: false });
    goToFrame(literalGroup, 5);
    if (alias.value !== 5 || typedAlias.value !== 5) throw new Error("Untyped record alias lost its scalar storage");

    const forwarded = { value: 0 };
    const forwardedAlias: { value: number } = forwarded;
    const forwardedGroup = bind(manager, forwarded, scalar);
    goToFrame(forwardedGroup, 5);
    if (forwardedAlias.value !== 5) throw new Error("Helper-forwarded target lost its shared object home");

    const retainedManager = createAnimationManager({ engine });
    let readRetained: () => number = () => -1;
    {
        const retained: { value: number } = { value: 0 };
        readRetained = () => retained.value;
        createPropertyAnimationGroup(retainedManager, retained, scalar, { loop: false });
    }
    updateAnimationManager(retainedManager, 500);
    if (readRetained() !== 5) throw new Error("Target did not survive its setup scope");

    const mixer = createAnimationManager({ engine });
    enablePropertyAnimationBlending(mixer);
    const mixed: Target = { position: { x: 0 }, value: 0 };
    const separate: Target = { position: { x: 0 }, value: 0 };
    const constant = createPropertyAnimationClip("constant", [{ path: "position.x",
        keys: [{ frame: 0, value: 4 }, { frame: 10, value: 4 }] }]);
    const aliasClip = createPropertyAnimationClip("alias", [{ path: "x",
        keys: [{ frame: 0, value: 8 }, { frame: 10, value: 8 }] }]);
    const first = createPropertyAnimationGroup(mixer, mixed, constant);
    const second = createPropertyAnimationGroup(mixer, mixed.position, aliasClip);
    const other = createPropertyAnimationGroup(mixer, separate, constant);
    setAnimationWeight(first, 0.25);
    setAnimationWeight(second, 0.5);
    setAnimationWeight(other, 0.5);
    updateAnimationManager(mixer, 0);
    if (mixed.position.x !== 5 || separate.position.x !== 2) throw new Error("Mixer lost resolved owner/property identity");

    const multiple: { position: { x: number }; value: number } = { position: { x: 0 }, value: 0 };
    const mixedPaths = createPropertyAnimationClip("multiple", [
        { path: "position.x", keys: [{ frame: 0, value: 4 }, { frame: 10, value: 4 }] },
        { path: "value", keys: [{ frame: 0, value: 8 }, { frame: 10, value: 8 }] },
    ]);
    const multiGroup = createPropertyAnimationGroup(manager, multiple, mixedPaths);
    goToFrame(multiGroup, 0);
    if (multiple.position.x !== 4 || multiple.value !== 8) throw new Error("Data paths were classified as incompatible native targets");

    let written = 0;
    const setterTarget = { set value(next: number) { written = next; } };
    const setterGroup = createPropertyAnimationGroup(manager, setterTarget, scalar);
    goToFrame(setterGroup, 5);
    if (written !== 5) throw new Error("Existing scalar setter binding changed");

    const missing: { nested: { position: { x: number } } | null } = { nested: null };
    const missingClip = createPropertyAnimationClip("missing", [{ path: "nested.position.x",
        keys: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }] }]);
    let refused = false;
    try { createPropertyAnimationGroup(manager, missing, missingClip); }
    catch { refused = true; }
    if (!refused) throw new Error("Null intermediate owner was accepted at group creation");
`, `
    function observe(target: Target): number { return target.position.x; }
    function bind(manager: AnimationManager, target: { value: number }, clip: PropertyAnimationClip) {
        return createPropertyAnimationGroup(manager, target, clip);
    }
`);

test("the same ownership and blending assertions pass on the pinned implementation", async () => {
    // Only engine creation is a fixture: property interpolation, binding,
    // seeking, playback and mixing execute the installed pin unchanged.
    const pin = await import("@babylonjs/lite");
    const javascript = ts.transpileModule(program.replace(/import\s*\{[^}]+\}\s*from\s*"@babylonjs\/lite";/, ""), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const names = ["createEngine", "createAnimationManager", "createPropertyAnimationClip", "createPropertyAnimationGroup",
        "goToFrame", "playAnimation", "updateAnimationManager", "enablePropertyAnimationBlending", "setAnimationWeight"] as const;
    const run = new Function(...names, `${javascript}\nreturn main();`);
    await run(...names.map((name) => name === "createEngine" ? async () => ({}) : pin[name]));
});

test("plain-data target fields bind independently of native lane spelling", () => {
    const result = compileSource(program);
    assert.match(result.cpp, /PropertyAnimationTargetKind::callback/);
    assert.match(result.cpp, /property_animation_owner/);
    const shared = compileSource(scene(`${clip}
        const target: Target = { position: { x: -2 }, value: 0 };
        const mesh = createBox(engine);
        createPropertyAnimationGroup(manager, target, clip);
        createPropertyAnimationGroup(manager, mesh, clip);
    `));
    assert.match(shared.cpp, /PropertyAnimationTargetKind::mesh/);
    assert.match(shared.cpp, /PropertyAnimationTargetKind::callback/);
});

test("data bindings refuse missing, readonly and nonnumeric leaves", () => {
    for (const [declaration, path, diagnostic] of [
        ["const target: { position: { y: number } } = { position: { y: 0 } };", "position.x", /has no field 'x'/],
        ["const target: { readonly value: number } = { value: 0 };", "value", /mutable numeric data field/],
        ["const target = { value: true };", "value", /mutable numeric data field/],
    ] as const) {
        assert.throws(() => compileSource(scene(`${declaration}
            const clip = createPropertyAnimationClip("bad", [{ path: "${path}",
                keys: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }] }]);
            createPropertyAnimationGroup(manager, target, clip);
        `)), diagnostic);
    }
});

const tools = optionalNativeFixtureTools(false);
test("native seeking and ticking write the retained data owner", { skip: !tools }, () => {
    const output = resolve("artifacts/property-animation-data-check");
    const headers = join(output, "bblite/upstream");
    mkdirSync(headers, { recursive: true });
    const lowered = new AnimationLowerer(new LoweringContext()).lowerPropertyAnimation({ managedGroups: true, blending: true });
    writeFileSync(join(headers, "property_animation.hpp"), lowered.header);
    writeFileSync(join(output, "property_animation.cpp"), lowered.source);
    // Collection is test instrumentation at public update boundaries. It
    // exercises the generated writer and caller closure after setup returns.
    const compiled = compileSource(program).cpp.replaceAll(
        "bbl::update_animation_manager(",
        "bbl::js::collect_cycles(); bbl::update_animation_manager(",
    );
    writeFileSync(join(output, "program.hpp"), compiled);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2", "/Gy",
        "/I", "native/include", "/I", output, `/Fo:${output}\\`, `/Fe:${executable}`,
        join(output, "property_animation.cpp"), "test/fixtures/property-animation-data-check.cpp",
        "/link", "/OPT:REF",
    ]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /property-animation-data-check: ok/);
});
