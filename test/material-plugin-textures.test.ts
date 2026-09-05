/**
 * The material-plugin texture and sampler slice, end to end.
 *
 * Three halves meet here and each one is where a defect would hide:
 *
 *  * the FOLD, which sees a plugin through a bounded local factory and
 *    proves `getSamplers`, `bindTextures` and `getActiveTextures` name the
 *    same ordered list -- nothing upstream checks that, because upstream
 *    calls all three on live objects;
 *  * the COMPOSITION, which is still the pin's own `buildPluginFragment`
 *    turning those declarations into bindings the composed WGSL declares
 *    and the generated reflection numbers; and
 *  * the RUNTIME, where each material's own textures ride the record and
 *    both backends resolve a composed binding name through the generated
 *    `standard_plugin_bindings` table.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { CompileError, compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { sharedUpstreamStore } from "../src/upstream-source.js";
import { materialPluginListKey } from "../src/pinned-material-plugins.js";
import {
    pinnedStandardSupportBlock,
    standardBuiltinBindingNames,
    type PinnedStandardSupportOptions,
} from "../src/pinned-standard-variants.js";

/** A 1x1 PNG, so a plugin's file-texture arm needs no remote asset. */
const INLINE_PNG =
    "data:image/png;base64," +
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * A scene attaching `plugin` to one Standard material.
 *
 * The plugin text is spliced in as written so each test states exactly the
 * declaration it is about; everything around it is the smallest scene a
 * Standard plugin material needs.
 */
function pluginScene(plugin: string, before = ""): string {
    return `
        import {
            addToScene,
            createBox,
            createEngine,
            createSceneContext,
            createStandardMaterial,
            createTexture2DFromPixels,
            enableMaterialPlugins,
            loadTexture2D,
            registerScene,
        } from "@babylonjs/lite";
        ${before}
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const stripe = createTexture2DFromPixels(
                engine,
                new Uint8Array([255, 255, 255, 255]),
                1,
                1,
            );
            const tint = await loadTexture2D(engine, "${INLINE_PNG}", {});
            const material = createStandardMaterial();
            material.plugins = [${plugin}];
            const box = createBox(engine, { width: 1, height: 1, depth: 1 });
            box.material = material;
            addToScene(scene, box);
            enableMaterialPlugins(scene);
            await registerScene(scene);
        }
    `;
}

/** The pinned Sandblox stud plugin's own shape, parameterized by its body. */
const factoryDeclaration = `
    interface Pair { readonly a: Texture2D; readonly b: Texture2D; }
    function createPairPlugin(pair: Pair): MaterialPlugin {
        return {
            name: "pair",
            getSamplers: () => [
                { texture: "oneT", sampler: "oneS" },
                { texture: "twoT", sampler: "twoS" },
            ],
            getCustomCode: (shaderType) =>
                shaderType === "fragment"
                    ? {
                          CUSTOM_FRAGMENT_UPDATE_DIFFUSE:
                              "baseColor = baseColor * textureSample(oneT, oneS, vec2<f32>(0.0)).rgb * textureSample(twoT, twoS, vec2<f32>(0.0)).rgb;",
                      }
                    : null,
            bindTextures: (out) => {
                out.push({ texture: pair.a }, { texture: pair.b });
            },
            getActiveTextures: (out) => {
                out.push(pair.a, pair.b);
            },
        };
    }
`;

function refusal(source: string): string {
    try {
        compileSource(source);
    } catch (error) {
        assert.ok(error instanceof CompileError, String(error));
        return error.message;
    }
    throw new Error("expected a refusal");
}

/**
 * A scene attaching one plugin each to TWO Standard materials.
 *
 * The factory-bound half of the fold is only observable across calls: one
 * call binds its parameters once and nothing can collide with itself.
 */
function twoMaterialScene(
    first: string,
    second: string,
    before = "",
): string {
    return `
        import {
            addToScene,
            createBox,
            createEngine,
            createSceneContext,
            createStandardMaterial,
            createTexture2DFromPixels,
            enableMaterialPlugins,
            loadTexture2D,
            registerScene,
        } from "@babylonjs/lite";
        ${before}
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const stripe = createTexture2DFromPixels(
                engine,
                new Uint8Array([255, 255, 255, 255]),
                1,
                1,
            );
            const tint = await loadTexture2D(engine, "${INLINE_PNG}", {});
            const first = createStandardMaterial();
            first.plugins = [${first}];
            const second = createStandardMaterial();
            second.plugins = [${second}];
            const one = createBox(engine, { width: 1, height: 1, depth: 1 });
            one.material = first;
            const two = createBox(engine, { width: 1, height: 1, depth: 1 });
            two.material = second;
            addToScene(scene, one);
            addToScene(scene, two);
            enableMaterialPlugins(scene);
            await registerScene(scene);
        }
    `;
}

/** Every native local the emitted entry body declares, in emission order. */
function declaredLocals(cpp: string): string[] {
    return [...cpp.matchAll(
        /^\s*(?:\[\[maybe_unused\]\] )?(?:auto&&|auto&|auto|double|bool|std::string) (v_[A-Za-z0-9_]+) =/gm,
    )].map((match) => match[1]!);
}

test("folds a MaterialPlugin through a bounded local factory call", () => {
    const result = compileSource(
        pluginScene("createPairPlugin({ a: stripe, b: tint })", factoryDeclaration),
    );

    // The factory's parameter is bound to the call site's own record, so the
    // captured textures lower to the locals the scene created them in.
    assert.match(
        result.cpp,
        /bbl::set_material_plugins\(v_engine, v_material, static_cast<std::uint8_t>\(1\)\);/,
    );
    assert.match(
        result.cpp,
        /bbl::add_material_plugin_pixels_texture\(v_engine, v_material, v_stripe\);/,
    );
    assert.match(
        result.cpp,
        /bbl::add_material_plugin_file_texture\(v_engine, v_material, v_tint\);/,
    );
    // Both producers reach the one feature that gates the setter
    // translation unit's plugin arm and both backends' bind path.
    assert.ok(
        result.manifest.features.includes("material:plugin-textures"),
    );
});

test("keeps optional mesh identity and Standard inputs for plugin composition", () => {
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createEngine,
            createSceneContext,
            createStandardMaterial,
            enableMaterialPlugins,
            loadTexture2D,
            registerScene,
            type Mesh,
        } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            let mesh: Mesh;
            try {
                mesh = createBox(engine, { width: 1, height: 1, depth: 1 });
            } catch {
                throw new Error("mesh creation failed");
            }
            const material = createStandardMaterial();
            material.diffuseTexture = await loadTexture2D(engine, "${INLINE_PNG}", {});
            material.alpha = 0.5;
            material.plugins = [{
                name: "fade",
                getCustomCode: (shaderType) =>
                    shaderType === "fragment"
                        ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: "alpha *= 0.5;" }
                        : null,
            }];
            mesh.material = material;
            addToScene(scene, mesh);
            enableMaterialPlugins(scene);
            await registerScene(scene);
        }
    `);

    assert.deepEqual(result.manifest.standardMaterialPluginInputs, [[{
        diffuseTexture: {},
        alpha: 0.5,
        pluginIndex: 1,
    }]]);
    assert.equal(result.manifest.sceneMeshes[0]?.standardMaterial, true);
    assert.equal(
        result.manifest.sceneMeshes[0]?.standardMaterialPluginIndex,
        1,
    );
});

test("binds a plugin's textures in getSamplers order", () => {
    const result = compileSource(
        pluginScene("createPairPlugin({ a: tint, b: stripe })", factoryDeclaration),
    );
    const pixels = result.cpp.indexOf("add_material_plugin_pixels_texture");
    const file = result.cpp.indexOf("add_material_plugin_file_texture");

    // `bindTextures` pushed the file texture first here, and the record's
    // order is that order rather than the creation order.
    assert.ok(file >= 0 && pixels >= 0);
    assert.ok(
        file < pixels,
        "the record takes the textures in bindTextures order",
    );
});

test("clears a material's plugin textures before appending them", () => {
    const result = compileSource(
        pluginScene("createPairPlugin({ a: stripe, b: tint })", factoryDeclaration),
    );
    const setter = result.cpp.indexOf("bbl::set_material_plugins(");
    const first = result.cpp.indexOf("bbl::add_material_plugin_");

    // The index setter clears the list, so it has to be emitted first: a
    // second `plugins` write then replaces the textures the way reassigning
    // the array replaces them upstream.
    assert.ok(setter >= 0 && first > setter);
});

test("refuses a plugin factory whose body is more than one return", () => {
    const message = refusal(
        pluginScene("createPairPlugin({ a: stripe, b: tint })", `
            function createPairPlugin(pair: { a: Texture2D; b: Texture2D }): MaterialPlugin {
                const name = "pair";
                return {
                    name,
                    getCustomCode: (shaderType) =>
                    shaderType === "fragment"
                        ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: "let unused = 0.0;" }
                        : null,
                };
            }
        `),
    );

    assert.match(
        message,
        /factory createPairPlugin's body is one return of a value/,
    );
});

test("refuses a plugin factory reached through anything but an identifier", () => {
    const message = refusal(
        pluginScene("factories.make(stripe)", `
            const factories = {
                make: (_t: Texture2D): MaterialPlugin => ({
                    name: "pair",
                    getCustomCode: (shaderType) =>
                    shaderType === "fragment"
                        ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: "let unused = 0.0;" }
                        : null,
                }),
            };
        `),
    );

    assert.match(message, /A MaterialPlugin factory is named by a plain identifier/);
});

test("refuses a sampler declaration missing half its pair", () => {
    const message = refusal(
        pluginScene(`{
            name: "half",
            getSamplers: () => [{ texture: "oneT" }],
            getCustomCode: (shaderType) =>
                    shaderType === "fragment"
                        ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: "let unused = 0.0;" }
                        : null,
            bindTextures: (out) => { out.push({ texture: stripe }); },
            getActiveTextures: (out) => { out.push(stripe); },
        }`),
    );

    assert.match(message, /names both its texture and its sampler/);
});

test("refuses a sampler name two declarations share", () => {
    const message = refusal(
        pluginScene(`{
            name: "twice",
            getSamplers: () => [
                { texture: "oneT", sampler: "oneS" },
                { texture: "oneT", sampler: "twoS" },
            ],
            getCustomCode: (shaderType) =>
                    shaderType === "fragment"
                        ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: "let unused = 0.0;" }
                        : null,
            bindTextures: (out) => {
                out.push({ texture: stripe }, { texture: tint });
            },
            getActiveTextures: (out) => { out.push(stripe, tint); },
        }`),
    );

    assert.match(message, /declared twice by this material's plugins/);
});

test("refuses a sampler type the pin does not default to", () => {
    const message = refusal(
        pluginScene(`{
            name: "unfiltered",
            getSamplers: () => [
                {
                    texture: "oneT",
                    sampler: "oneS",
                    samplerType: "sampler_non_filtering" as const,
                },
            ],
            getCustomCode: (shaderType) =>
                    shaderType === "fragment"
                        ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: "let unused = 0.0;" }
                        : null,
            bindTextures: (out) => { out.push({ texture: stripe }); },
            getActiveTextures: (out) => { out.push(stripe); },
        }`),
    );

    assert.match(message, /a non-filtering sampler is a bind-group layout entry of its own/);
});

test("refuses a bindTextures list shorter than the declarations", () => {
    const message = refusal(
        pluginScene(`{
            name: "short",
            getSamplers: () => [
                { texture: "oneT", sampler: "oneS" },
                { texture: "twoT", sampler: "twoS" },
            ],
            getCustomCode: (shaderType) =>
                    shaderType === "fragment"
                        ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: "let unused = 0.0;" }
                        : null,
            bindTextures: (out) => { out.push({ texture: stripe }); },
            getActiveTextures: (out) => { out.push(stripe); },
        }`),
    );

    assert.match(message, /declares 2 sampler pair\(s\) and binds 1 texture\(s\)/);
});

test("refuses getActiveTextures naming a different texture than bindTextures", () => {
    const message = refusal(
        pluginScene(`{
            name: "mismatched",
            getSamplers: () => [
                { texture: "oneT", sampler: "oneS" },
                { texture: "twoT", sampler: "twoS" },
            ],
            getCustomCode: (shaderType) =>
                    shaderType === "fragment"
                        ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: "let unused = 0.0;" }
                        : null,
            bindTextures: (out) => {
                out.push({ texture: stripe }, { texture: tint });
            },
            getActiveTextures: (out) => { out.push(tint, stripe); },
        }`),
    );

    assert.match(
        message,
        /reports a different texture at position 0 than it binds there/,
    );
});

test("refuses samplers with no bindTextures, and bindTextures with no samplers", () => {
    assert.match(
        refusal(
            pluginScene(`{
                name: "unfilled",
                getSamplers: () => [{ texture: "oneT", sampler: "oneS" }],
                getCustomCode: (shaderType) =>
                    shaderType === "fragment"
                        ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: "let unused = 0.0;" }
                        : null,
            }`),
        ),
        /declares samplers with no bindTextures/,
    );
    assert.match(
        refusal(
            pluginScene(`{
                name: "undeclared",
                getCustomCode: (shaderType) =>
                    shaderType === "fragment"
                        ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: "let unused = 0.0;" }
                        : null,
                bindTextures: (out) => { out.push({ texture: stripe }); },
                getActiveTextures: (out) => { out.push(stripe); },
            }`),
        ),
        /declares no samplers/,
    );
});

test("refuses samplers on a PBR material's plugin", () => {
    const message = refusal(`
        import {
            createEngine,
            createPbrMaterial,
            createTexture2DFromPixels,
        } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const stripe = createTexture2DFromPixels(
                engine,
                new Uint8Array([255, 255, 255, 255]),
                1,
                1,
            );
            const material = createPbrMaterial({});
            material.plugins = [{
                name: "pbr",
                getSamplers: () => [{ texture: "oneT", sampler: "oneS" }],
                getCustomCode: (shaderType) =>
                    shaderType === "fragment"
                        ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: "let unused = 0.0;" }
                        : null,
                bindTextures: (out) => { out.push({ texture: stripe }); },
                getActiveTextures: (out) => { out.push(stripe); },
            }];
        }
    `);

    assert.match(
        message,
        /needs the PBR family's own plugin bind-group contract/,
    );
});

test("keys two plugin lists apart by their sampler declarations", () => {
    const custom = { CUSTOM_FRAGMENT_UPDATE_ALPHA: "" };
    const one = materialPluginListKey([
        { name: "p", fragment: custom, samplers: [{ texture: "oneT", sampler: "oneS" }] },
    ]);
    const two = materialPluginListKey([
        { name: "p", fragment: custom, samplers: [{ texture: "twoT", sampler: "twoS" }] },
    ]);
    const none = materialPluginListKey([{ name: "p", fragment: custom }]);

    // The pin's own `pluginSignature` reads `getSamplers()` into the key, so
    // this port's partition of the scene's lists has to read it too --
    // otherwise two lists composing different bindings would share an index.
    assert.notEqual(one, two);
    assert.notEqual(one, none);
});

test("composes the plugin's sampler declarations into the Standard fragment", async () => {
    const { enablePinnedMaterialPlugins, standardPluginBindingTable } =
        await import("../src/pinned-material-plugins.js");
    const { composePinnedStandardVariant } = await import(
        "../src/pinned-standard-variants.js"
    );
    const manifest = {
        name: "compose-probe",
        fragment: {
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE:
                "baseColor = baseColor * textureSample(probeT, probeS, vec2<f32>(0.0)).rgb;",
        },
        samplers: [
            { texture: "probeT", sampler: "probeS" },
            { texture: "otherT", sampler: "otherS" },
        ],
    };
    await enablePinnedMaterialPlugins([[manifest]]);
    const variant = await composePinnedStandardVariant({ pluginIndex: 1 });

    // The declarations are the pin's: `buildPluginFragment` turned them into
    // bindings and `composeShader` numbered them past the mesh and material
    // blocks, so the group and the indices are composed rather than assigned
    // here.
    assert.match(
        variant.fragmentWgsl,
        /@group\(1\)\s*@binding\(2\)\s*var probeT:texture_2d<f32>;/,
    );
    assert.match(
        variant.fragmentWgsl,
        /@group\(1\)\s*@binding\(3\)\s*var probeS:sampler;/,
    );
    assert.match(
        variant.fragmentWgsl,
        /@group\(1\)\s*@binding\(5\)\s*var otherS:sampler;/,
    );
    // And the table both backends resolve through is read back off the pin's
    // own composed fragment, in the same order.
    assert.deepEqual(await standardPluginBindingTable(), [[
        { texture: "probeT", sampler: "probeS" },
        { texture: "otherT", sampler: "otherS" },
    ]]);
});

/** The support block with everything but the plugin bindings emptied. */
function supportBlock(
    pluginBindings: PinnedStandardSupportOptions["pluginBindings"],
): string {
    return pinnedStandardSupportBlock(
        new LoweringContext(sharedUpstreamStore()),
        {
            selectors: [],
            uvTransform: false,
            plugins: pluginBindings !== undefined,
            renderableMeshFeatures: [],
            ...(pluginBindings ? { pluginBindings } : {}),
        },
    );
}

test("emits one plugin binding row per declaration, keyed by signature index", () => {
    const header = supportBlock([
        [{ texture: "aT", sampler: "aS" }],
        [
            { texture: "bT", sampler: "bS" },
            { texture: "cT", sampler: "cS" },
        ],
    ]);

    assert.match(header, /\{"aT", "aS", 1, 0\},/);
    assert.match(header, /\{"bT", "bS", 2, 0\},/);
    assert.match(header, /\{"cT", "cS", 2, 1\},/);
    assert.match(header, /standard_plugin_binding_for\(/);
});

test("emits no plugin binding table for a scene whose plugins declare none", () => {
    // The neutrality that matters: a plugin-free scene, and a plugin scene
    // that binds nothing, both compile the header they compiled before this
    // family existed.
    assert.doesNotMatch(supportBlock(undefined), /standard_plugin_bindings/);
    assert.doesNotMatch(supportBlock([[]]), /standard_plugin_bindings/);
});

test("both backends resolve a plugin binding through the generated table", () => {
    const backends = [
        "native/src/pal_dawn.cpp",
        "native/src/pal_sdl_gpu.cpp",
    ];
    for (const path of backends) {
        const source = readFileSync(resolve(path), "utf8");
        // The same recorded metadata on both sides: the row is found by the
        // material's own signature index, never by a scene-specific slot.
        assert.match(
            source,
            /upstream::standard_plugin_binding_for\(\s*\n?\s*(binding\.)?name,\s*\n?\s*material->plugin_signature_index\)/,
            `${path} resolves a plugin binding by name and signature index`,
        );
        // Uploaded once per material through the shared cache, and released
        // through the same reference count every caller-owned family uses.
        assert.match(
            source,
            /material->plugin_textures/,
            `${path} uploads the record's plugin textures`,
        );
        assert.match(
            source,
            /Plugin material texture reference count underflow\./,
            `${path} releases its share of the per-material upload`,
        );
        // Every added line is behind the capability define, so a scene
        // reaching no plugin texture compiles none of it.
        assert.match(
            source,
            /#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES/,
            `${path} gates the plugin texture path`,
        );
    }
});

test("reads the pinned plugin sampler contract from the pin", () => {
    const context = new LoweringContext(sharedUpstreamStore());
    const { declaration } = context.functionDeclaration(
        "src/material/plugin/plugin-bridge-shared.ts",
        "buildPluginFragment",
    );

    // The anchor: `buildPluginFragment` still turns each `getSamplers` entry
    // into a texture binding and a sampler binding, defaulting both WGSL
    // types beside the property it reads. The fold reads those two defaults
    // from exactly these expressions, so a pin that renamed or retyped one
    // fails at generation rather than composing a binding this port cannot
    // bind.
    const defaults = context.findNodes(
        declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
            ts.isPropertyAccessExpression(node.left) &&
            ts.isStringLiteral(node.right),
    ).map((node) => [
        (node.left as ts.PropertyAccessExpression).name.text,
        (node.right as ts.StringLiteral).text,
    ]);

    assert.deepEqual(defaults, [
        ["textureType", "texture_2d<f32>"],
        ["samplerType", "sampler"],
    ]);
    // And it still pushes them as a pair, texture first: the record's
    // ordinal is a position in that pairing.
    const pushed = context.findNodes(
        declaration,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "push" &&
            node.arguments.length === 2,
    );
    assert.equal(pushed.length, 1);
});

/**
 * A factory whose parameter is named `stripe` -- the scene's own local.
 *
 * The binding declares a native local of its own, so the parameter and the
 * scene's texture would have shared one C++ name under an unprefixed scope.
 */
const shadowingFactory = `
    function createShadowPlugin(stripe: Texture2D): MaterialPlugin {
        return {
            name: "shadowing",
            getSamplers: () => [{ texture: "oneT", sampler: "oneS" }],
            getCustomCode: (shaderType) =>
                shaderType === "fragment"
                    ? {
                          CUSTOM_FRAGMENT_UPDATE_DIFFUSE:
                              "baseColor = baseColor * textureSample(oneT, oneS, vec2<f32>(0.0)).rgb;",
                      }
                    : null,
            bindTextures: (out) => { out.push({ texture: stripe }); },
            getActiveTextures: (out) => { out.push(stripe); },
        };
    }
`;

test("gives each factory call its own scope, so two calls do not collide", () => {
    const result = compileSource(
        twoMaterialScene(
            "createPairPlugin({ a: stripe, b: tint })",
            "createPairPlugin({ a: tint, b: stripe })",
            factoryDeclaration,
        ),
    );
    const locals = declaredLocals(result.cpp);

    // The defect this stands on: an empty scope prefix spelled every
    // factory-bound parameter `v_<name>`, so a second call redefined the
    // first call's local in the same C++ block.
    assert.deepEqual(
        locals.filter((name, index) => locals.indexOf(name) !== index),
        [],
        `a native local is declared twice: ${locals.join(", ")}`,
    );
    // Both calls still bound the call site's own textures, in their own
    // bindTextures order.
    const bound = [...result.cpp.matchAll(
        /bbl::add_material_plugin_(pixels|file)_texture\(/g,
    )].map((match) => match[1]);
    assert.deepEqual(bound, ["pixels", "file", "file", "pixels"]);
});

test("keeps a factory parameter apart from the scene local it shadows", () => {
    const result = compileSource(
        twoMaterialScene(
            "createShadowPlugin(stripe)",
            "createShadowPlugin(tint)",
            shadowingFactory,
        ),
    );
    const locals = declaredLocals(result.cpp);

    assert.deepEqual(
        locals.filter((name, index) => locals.indexOf(name) !== index),
        [],
        `a native local is declared twice: ${locals.join(", ")}`,
    );
    // The scene's own `stripe` still names the texture it created, and the
    // parameter binding is a local of its own beside it.
    assert.match(
        result.cpp,
        /bbl::add_material_plugin_pixels_texture\(v_engine, v_first, v_[A-Za-z0-9_]*stripe\);/,
    );
    assert.match(
        result.cpp,
        /bbl::add_material_plugin_file_texture\(v_engine, v_second, v_[A-Za-z0-9_]*stripe\);/,
    );
});

test("keeps two factories sharing a parameter name on distinct textures", () => {
    const factories = `
        function createOnePlugin(tex: Texture2D): MaterialPlugin {
            return {
                name: "one",
                getSamplers: () => [{ texture: "oneT", sampler: "oneS" }],
                getCustomCode: (shaderType) =>
                    shaderType === "fragment"
                        ? {
                              CUSTOM_FRAGMENT_UPDATE_DIFFUSE:
                                  "baseColor = baseColor * textureSample(oneT, oneS, vec2<f32>(0.0)).rgb;",
                          }
                        : null,
                bindTextures: (out) => { out.push({ texture: tex }); },
                getActiveTextures: (out) => { out.push(tex); },
            };
        }
        function createTwoPlugin(tex: Texture2D): MaterialPlugin {
            return {
                name: "two",
                getSamplers: () => [{ texture: "twoT", sampler: "twoS" }],
                getCustomCode: (shaderType) =>
                    shaderType === "fragment"
                        ? {
                              CUSTOM_FRAGMENT_UPDATE_DIFFUSE:
                                  "baseColor = baseColor * textureSample(twoT, twoS, vec2<f32>(0.0)).rgb;",
                          }
                        : null,
                bindTextures: (out) => { out.push({ texture: tex }); },
                getActiveTextures: (out) => { out.push(tex); },
            };
        }
    `;
    const result = compileSource(
        twoMaterialScene(
            "createOnePlugin(stripe)",
            "createTwoPlugin(tint)",
            factories,
        ),
    );
    const locals = declaredLocals(result.cpp);

    // Two `tex` parameters, two distinct textures: the pair that used to
    // render one C++ name twice and, at the proof, made two different
    // textures compare equal.
    assert.deepEqual(
        locals.filter((name, index) => locals.indexOf(name) !== index),
        [],
        `a native local is declared twice: ${locals.join(", ")}`,
    );
    assert.match(
        result.cpp,
        /bbl::add_material_plugin_pixels_texture\(v_engine, v_first, /,
    );
    assert.match(
        result.cpp,
        /bbl::add_material_plugin_file_texture\(v_engine, v_second, /,
    );
});

test("proves the two texture members agree by what they name, not by spelling", () => {
    // The agreement proof reads the declaration each reference resolves to,
    // so a plugin naming one texture in `bindTextures` and another in
    // `getActiveTextures` refuses even where the two render alike.
    const message = refusal(
        twoMaterialScene(
            "createPairPlugin({ a: stripe, b: tint })",
            `{
                name: "crossed",
                getSamplers: () => [{ texture: "oneT", sampler: "oneS" }],
                getCustomCode: (shaderType) =>
                    shaderType === "fragment"
                        ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: "let unused = 0.0;" }
                        : null,
                bindTextures: (out) => { out.push({ texture: stripe }); },
                getActiveTextures: (out) => { out.push(tint); },
            }`,
            factoryDeclaration,
        ),
    );

    assert.match(
        message,
        /reports a different texture at position 0 than it binds there/,
    );
});

test("refuses a plugin declaring one of the pin's own Standard binding names", () => {
    // Both halves of a built-in pair, and both with and without the
    // material carrying the built-in texture itself: the composed variant
    // declares the name for its own arms, so the refusal cannot depend on
    // which arms this material happened to reach.
    for (const declaration of [
        `{ texture: "dT", sampler: "oneS" }`,
        `{ texture: "oneT", sampler: "dS" }`,
    ]) {
        for (const diffuse of ["", "material.diffuseTexture = tint;"]) {
            const message = refusal(
                pluginScene(
                    `{
                        name: "collides",
                        getSamplers: () => [${declaration}],
                        getCustomCode: (shaderType) =>
                            shaderType === "fragment"
                                ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: "let unused = 0.0;" }
                                : null,
                        bindTextures: (out) => { out.push({ texture: stripe }); },
                        getActiveTextures: (out) => { out.push(stripe); },
                    }`,
                ).replace(
                    "const box = createBox(",
                    `${diffuse}\n            const box = createBox(`,
                ),
            );

            assert.match(
                message,
                /is a name the pin's own Standard bindings are declared under/,
                `${declaration} with '${diffuse}'`,
            );
        }
    }
});

test("reads the refused built-in names from the generated binding table", () => {
    // One list, two consumers: the emitted `standard_binding_resources`
    // rows and the fold's refusal. A second spelling is how the two would
    // disagree about what a composed variant already declares.
    const header = supportBlock(undefined);
    for (const name of standardBuiltinBindingNames()) {
        assert.ok(
            header.includes(`"${name}"`),
            `${name} is a row of the generated table`,
        );
    }
    assert.equal(standardBuiltinBindingNames().size, 16);
});

test("refuses two plugins on one material declaring the same names", () => {
    const shared = (name: string) =>
        `{
            name: "${name}",
            getSamplers: () => [{ texture: "oneT", sampler: "oneS" }],
            getCustomCode: (shaderType) =>
                shaderType === "fragment"
                    ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: "let unused = 0.0;" }
                    : null,
            bindTextures: (out) => { out.push({ texture: stripe }); },
            getActiveTextures: (out) => { out.push(stripe); },
        }`;
    const message = refusal(
        pluginScene(`${shared("first")}, ${shared("second")}`),
    );

    // The pin composes ONE fragment out of the whole list, so the second
    // plugin's declaration is a redefinition exactly as a repeat inside one
    // plugin is -- and the refusal names the plugin that took it first.
    assert.match(
        message,
        /'oneT' is declared twice by this material's plugins \(already by "first"\)/,
    );
});

test("keeps two plugins with distinct names, in the order the scene wrote them", () => {
    const plugin = (name: string, prefix: string) =>
        `{
            name: "${name}",
            getSamplers: () => [{ texture: "${prefix}T", sampler: "${prefix}S" }],
            getCustomCode: (shaderType) =>
                shaderType === "fragment"
                    ? {
                          CUSTOM_FRAGMENT_UPDATE_DIFFUSE:
                              "baseColor = baseColor * textureSample(${prefix}T, ${prefix}S, vec2<f32>(0.0)).rgb;",
                      }
                    : null,
            bindTextures: (out) => { out.push({ texture: ${prefix === "one" ? "stripe" : "tint"} }); },
            getActiveTextures: (out) => { out.push(${prefix === "one" ? "stripe" : "tint"}); },
        }`;
    const result = compileSource(
        pluginScene(`${plugin("first", "one")}, ${plugin("second", "two")}`),
    );

    // Distinct names still compose, and the record takes the two plugins'
    // textures in list order -- the order `bindPluginTextures` pushes them.
    const bound = [...result.cpp.matchAll(
        /bbl::add_material_plugin_(pixels|file)_texture\(/g,
    )].map((match) => match[1]);
    assert.deepEqual(bound, ["pixels", "file"]);
});
