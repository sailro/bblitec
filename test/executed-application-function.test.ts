import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { POSITION_VERTEX_WGSL } from "./program-snippets.js";
import { compileShaderMaterialFixture } from "./shader-material-fixture.js";

function refusal(source: string, fileName: string): string {
    try {
        compileSource(source, { fileName });
    } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
    }
    assert.fail("expected a refusal");
}

test("runs an imported shader builder with the declarations it reaches", () => {
    const result = compileSource(
        `
            import { createEngine } from "@babylonjs/lite";
            import { createBuiltMaterial } from "./fixtures/compiler-modules/shader-builders.js";

            async function main() {
                await createEngine({});
                createBuiltMaterial("raised");
            }
        `,
        { fileName: "test/executed-builder-entry.ts" },
    );
    const [program] = result.manifest.customShaderPrograms;
    // The argument picked the arm, the module constant spliced the sibling
    // module's value, and the number formatted as the running code does.
    assert.match(
        program?.vertexSource ?? "",
        /vec4<f32>\(input\.position, 1\.5\)/,
    );
    assert.match(
        program?.fragmentSource ?? "",
        /fn shade\(x: f32\) -> f32 \{ return x \* 0\.75; \}/,
    );
    assert.match(program?.fragmentSource ?? "", /0\.0, 0\.0, 0\.50\)/);
});

test("runs a builder beside its module's engine code with the pin's wgsl tag", () => {
    const result = compileSource(
        `
            import { createEngine, createShaderMaterial } from "babylon-lite";
            import { wgsl } from "babylon-lite/shader/wgsl.js";

            const TINT = wgsl\`vec4<f32>(0.25, 0.5, 1.0, 1.0)\`;

            function fragmentSource(): string {
                return wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> {
return \${TINT};
}\`;
            }

            async function main() {
                await createEngine({});
                createShaderMaterial({
                    name: "tagged",
                    vertexSource: \`${POSITION_VERTEX_WGSL}\`,
                    fragmentSource: fragmentSource(),
                    attributes: ["position"],
                    uniforms: ["worldViewProjection"],
                });
            }
            main();
        `,
    );
    assert.match(
        result.manifest.customShaderPrograms[0]?.fragmentSource ?? "",
        /return vec4<f32>\(0\.25, 0\.5, 1\.0, 1\.0\);/,
    );
});

test("refuses a shader builder that reaches the host", () => {
    assert.match(
        refusal(
            `
                import { createEngine } from "@babylonjs/lite";
                import { createHostMaterial } from "./fixtures/compiler-modules/shader-builders.js";

                async function main() {
                    await createEngine({});
                    createHostMaterial();
                }
            `,
            "test/executed-builder-host-entry.ts",
        ),
        /Builder 'hostSource' reads 'performance'/,
    );
});

/**
 * A factory reading its stages from the record a helper returns for an
 * option's presence: `hold` runs between the option's test and the material,
 * `vertex` and `fragment` spell the two sources, `member` adds to the record.
 */
const stageFactory = (stages: {
    hold: string;
    vertex: string;
    fragment: string;
    member?: string;
    check?: string;
}): string => `
    const VERTEX = \`${POSITION_VERTEX_WGSL}\`;
    const LIT = \`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(shaderUniforms.uGain); }\`;
    const FLAT = \`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(0.25); }\`;

    function stageSources(lit: boolean) {
        return { vertex: VERTEX, fragment: lit ? \`// lit\\n\${LIT}\` : \`// flat\\n\${FLAT}\`${stages.member ?? ""} };
    }

    function surface(gain?: { amount: number }): ShaderMaterial {
        const lit = gain !== undefined;
        ${stages.hold}
        const material = createShaderMaterial({
            vertexSource: ${stages.vertex},
            fragmentSource: ${stages.fragment},
            attributes: ["position"],
            uniforms: ["worldViewProjection", ...(lit ? [{ name: "uGain", type: "f32" as const, defaultValue: 0.5 }] : [])],
        });
        ${stages.check ?? ""}
        return material;
    }
`;

const stageScene = (stages: Parameters<typeof stageFactory>[0]): string => `
    import { createBox, createEngine, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
    ${stageFactory(stages)}
    async function main() {
        const engine = await createEngine({});
        const lit = createBox(engine);
        lit.material = surface({ amount: 0.5 });
        const flat = createBox(engine);
        flat.material = surface();
    }
`;

const stageFragments = (stages: Parameters<typeof stageFactory>[0]) =>
    compileSource(stageScene(stages)).manifest.customShaderPrograms.map(
        (program) => program.fragmentSource,
    );

const heldStages = {
    hold: "const sources = stageSources(lit);",
    vertex: "wgsl`${sources.vertex}`",
    fragment: "wgsl`${sources.fragment}`",
};

test("reads a stage from the record a helper call returns", () => {
    for (const stages of [
        heldStages,
        // Read where the call is.
        {
            hold: "",
            vertex: "stageSources(lit).vertex",
            fragment: "wgsl`${stageSources(lit).fragment}`",
        },
        // A member the generation realm does not carry leaves the literal.
        {
            ...heldStages,
            member: ", box: (engine: EngineContext) => createBox(engine)",
        },
    ]) {
        const [lit, flat] = stageFragments(stages);
        assert.match(lit ?? "", /^\/\/ lit\n@fragment/);
        assert.match(flat ?? "", /^\/\/ flat\n@fragment/);
    }
});

test("reads the arm a settled conditional selects as a stage", () => {
    const [lit, flat] = stageFragments({
        ...heldStages,
        fragment: "lit ? sources.fragment : FLAT",
    });
    assert.match(lit ?? "", /^\/\/ lit\n@fragment/);
    assert.match(flat ?? "", /^@fragment fn mainFragment.*0\.25/);
});

test("refuses a helper's record a later read would not see as declared", () => {
    for (const hold of [
        // Written through after the call.
        "const sources = stageSources(lit); sources.fragment = FLAT;",
        // An argument rebound after the call.
        "let mode = lit; const sources = stageSources(mode); mode = !mode;",
    ])
        assert.match(
            refusal(
                stageScene({ ...heldStages, hold }),
                "test/executed-stage-entry.ts",
            ),
            /Expected a string literal|without a static string/,
        );
});

test("selects a helper-built stage per outcome of a run-time option", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    // Each outcome's material declares what its own stage reads; a call
    // whose material goes nowhere still runs its outcome's arm.
    const { compiled, cpp } = compileShaderMaterialFixture(`
    import { createEngine, createShaderMaterial, getShaderUniform, wgsl, type ShaderMaterial } from "babylon-lite";
    let tally = 0;
    ${stageFactory({
        ...heldStages,
        check: `tally += lit ? 10 : 1;
        let declared = 0;
        for (const name of ["uGain"]) {
            try { if (getShaderUniform(material, name) === 0.5) declared++; } catch (error) { declared--; }
        }
        if (declared !== (lit ? 1 : -1)) throw new Error("stage variant");`,
    })}
    async function main() {
        await createEngine({});
        const rows = JSON.parse('[{"gain":0.5},{"gain":null}]') as { gain: number | null }[];
        let built = 0;
        for (const row of rows) {
            const gain = row.gain === null ? undefined : { amount: row.gain };
            if (surface(gain)) built++;
            surface(gain);
        }
        if (built !== 2 || tally !== 22) throw new Error("rows");
    }
    main();`);
    assert.equal(compiled.manifest.customShaderPrograms.length, 2);
    runGeneratedProgram(
        native,
        "executed-application-function/stage-outcomes",
        `${cpp}\n#define main generated_main\n${compiled.cpp}\n#undef main\nint main(){assert(generated_main()==0);}`,
        { expectedOutput: "" },
    );
});

/**
 * A factory composing its fragment from the boolean `flags` of an options
 * record the caller names; `options` builds that record from a parsed row
 * and `after` runs on the material the call returns.
 */
const namedOptionsScene = (scene: {
    flags: readonly string[];
    rows: string;
    options: string;
    after?: string;
}): string => `
    import { createEngine, createShaderMaterial, getShaderUniform, setShaderUniform, type ShaderMaterial } from "babylon-lite";

    const VERTEX = \`${POSITION_VERTEX_WGSL}\`;
    interface SurfaceOptions {
        ${scene.flags.map((flag) => `${flag}: boolean;`).join(" ")}
        gain?: { amount: number };
        tone: { warm: boolean };
    }

    function surface(opts: SurfaceOptions): ShaderMaterial {
        let fragment = "@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(TONE * GAIN); }";
        ${scene.flags.map((flag) => `if (opts.${flag}) fragment = "// ${flag}\\n" + fragment;`).join("\n        ")}
        fragment = fragment.replace("TONE", opts.tone.warm ? "0.75" : "0.25");
        fragment = fragment.replace("GAIN", opts.gain ? "shaderUniforms.uGain" : "1.0");
        return createShaderMaterial({
            vertexSource: VERTEX,
            fragmentSource: fragment,
            attributes: ["position"],
            uniforms: ["worldViewProjection", ...(opts.gain ? [{ name: "uGain", type: "f32" as const, defaultValue: opts.gain.amount }] : [])],
        });
    }

    async function main() {
        await createEngine({});
        const rows = JSON.parse('${scene.rows}') as { ${scene.flags.map((flag) => `${flag}: boolean;`).join(" ")} gain: number | null; warm: boolean }[];
        let glowing = 0;
        for (const row of rows) {
            const options = ${scene.options};
            const material = surface(options);
            ${scene.after ?? ""}
        }
        if (glowing !== 1) throw new Error("variants");
    }
    main();`;

test("selects a material per outcome of a named record's members", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    // A boolean member, a member only some rows write and a nested record's
    // boolean each select; the merged material then resolves a uniform's
    // name against its own variant, which declares it or does not.
    const { compiled, cpp } = compileShaderMaterialFixture(
        namedOptionsScene({
            flags: ["lit"],
            rows: '[{"lit":true,"gain":0.5,"warm":false},{"lit":false,"gain":null,"warm":true},{"lit":true,"gain":null,"warm":true}]',
            options:
                "{ lit: row.lit, tone: { warm: row.warm }, ...(row.gain === null ? {} : { gain: { amount: row.gain } }) }",
            after: `let declared = false;
            for (const name of ["uGain"]) {
                try { declared = getShaderUniform(material, name) === 0.5; } catch (error) { declared = false; }
            }
            if (declared !== (row.gain !== null)) throw new Error("declared");
            if (row.gain !== null) {
                setShaderUniform(material, "uGain", row.gain + 1);
                if (getShaderUniform(material, "uGain") === 1.5) glowing++;
            }`,
        }),
    );
    assert.equal(compiled.manifest.customShaderPrograms.length, 8);
    runGeneratedProgram(
        native,
        "executed-application-function/member-outcomes",
        `${cpp}\n#define main generated_main\n${compiled.cpp}\n#undef main\nint main(){assert(generated_main()==0);}`,
        { expectedOutput: "" },
    );
});

test("selects a material per outcome of a parsed document member's presence", () => {
    // Each arm finds `settings.light` an object or absent, so the callee's
    // `opts.light !== undefined` and `opts.light ?` settle in both.
    const compiled = compileSource(`
        import { createEngine, createSceneContext, createShaderMaterial, wgsl } from "@babylonjs/lite";
        interface Settings { light?: { strength: number } }
        const VERTEX = \`${POSITION_VERTEX_WGSL}\`;
        function material(opts: { light?: { strength: number } }) {
            const prelude = opts.light !== undefined ? "fn lit() -> f32 { return 1.0; }" : "fn lit() -> f32 { return 0.0; }";
            const gain = opts.light ? "2.0" : "3.0";
            return createShaderMaterial({ name: "m", vertexSource: wgsl\`\${VERTEX}\`, fragmentSource: wgsl\`\${prelude}
@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(lit() * \${gain}); }\`, attributes: ["position"], uniforms: ["worldViewProjection"] });
        }
        async function main(): Promise<void> {
            const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
            createSceneContext(engine);
            const settings = JSON.parse(String(Date.now())) as Settings;
            console.log(material({ light: settings.light }) !== undefined);
        }
        void main();
    `);
    assert.deepEqual(
        compiled.manifest.customShaderPrograms
            .map((program) =>
                /return ([01])\.0; \}[^]*lit\(\) \* ([23])\.0/
                    .exec(program.fragmentSource)
                    ?.slice(1)
                    .join(" "),
            )
            .sort(),
        ["0 3", "1 2"],
    );
});

test("names the run-time tests a call compiles too many outcomes of", () => {
    assert.match(
        refusal(
            namedOptionsScene({
                flags: ["a", "b", "c", "d", "e"],
                rows: '[{"a":true,"b":false,"c":true,"d":false,"e":true,"gain":null,"warm":false}]',
                options:
                    "{ a: row.a, b: row.b, c: row.c, d: row.d, e: row.e, tone: { warm: false } }",
                after: "if (material) glowing++;",
            }),
            "test/executed-options-entry.ts",
        ),
        /compiles once per outcome of at most 4 run-time tests; it reads 5: options\.a, options\.b, options\.c, options\.d, options\.e\./,
    );
});

test("names the run-time tests whose outcomes make too many arms for one call", () => {
    // Two tests of ten constant-table keys each make 100 arms.
    const shades = Array.from(
        "abcdefghij",
        (key, index) => `${key}: "0.${index}"`,
    );
    const source = `import { createEngine, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*TONE*/ * /*TINT*/, 1.0);
  return out;
}\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.5, 0.2, 1.0); }\`;
const SHADES = { ${shades.join(", ")} } as const;
type Shade = keyof typeof SHADES;
function material(engine: EngineContext, tone: Shade, tint: Shade): ShaderMaterial {
    const vertex = VERTEX.replace("/*TONE*/", SHADES[tone]).replace("/*TINT*/", SHADES[tint]);
    return createShaderMaterial({ vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    const shades = Object.keys(SHADES) as Shade[];
    for (const tone of shades) for (const tint of shades) material(engine, tone, tint);
}
void main();
`;
    assert.match(
        refusal(source, "test/executed-arms-entry.ts"),
        /compiles once per outcome of run-time tests in at most 81 arms; its tests make 100: tone, tint\./,
    );
});

test("a call whose outcome refuses names the arm's refusal, then the call's", () => {
    // Compiled once, the builder reads a run-time stage; per outcome, the
    // arm holding a gain stops at its own unsupported read.
    const message = refusal(
        `import { createEngine, createShaderMaterial, wgsl, type ShaderMaterial } from "@babylonjs/lite";
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
interface Gain { readonly amount: number }
function surface(gain?: Gain): ShaderMaterial {
    const vertex = VERTEX.replace("/*S*/", gain ? "2.0" : "1.0");
    const projection = (): string => vertex;
    const material = createShaderMaterial({ vertexSource: wgsl\`\${projection()}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
    if (gain && material.attributes.indexOf("uv") < 0) throw new Error("uv");
    return material;
}
async function main(): Promise<void> {
    await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    const gained = Math.random() < 2;
    surface(gained ? { amount: 1 } : undefined);
}
void main();
`,
        "test/executed-arm-refusal-entry.ts",
    );
    assert.match(
        message,
        /^test\/executed-arm-refusal-entry\.ts:10:\d+: Unsupported property value 'material\.attributes\.indexOf'/,
    );
    assert.match(
        message,
        /\(An arm of a call compiled once per outcome of gained refuses so; compiled once, the call refuses at test\/executed-arm-refusal-entry\.ts:8:\d+: Builder 'projection' closes over 'vertex', whose value generation does not know\.\)$/,
    );
});

test("an outcome whose call always throws stores no result", (t) => {
    // The facade material is built only where the spread wrote a base, but
    // the call splits on the base's presence: the arm without one, which no
    // run reaches, throws in the helper and assigns nothing.
    const { compiled, cpp } = compileShaderMaterialFixture(`
    import { createEngine, createShaderMaterial, wgsl, type ShaderMaterial } from "babylon-lite";
    const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
    const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
    interface Base { readonly id: number }
    interface Facade { readonly bold: boolean }
    interface SurfaceOptions { readonly name: string; readonly base?: Base; readonly facade?: Facade }
    function surface(opts: SurfaceOptions): ShaderMaterial {
        if (opts.facade && !opts.base) throw new Error("a facade requires a base");
        const vertex = VERTEX.replace("/*S*/", opts.base ? "2.0" : "1.0");
        const projection = (facade: boolean): string => vertex.replace("/*F*/", facade ? "f" : "");
        return createShaderMaterial({ name: opts.name, vertexSource: wgsl\`\${projection(!!opts.facade)}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
    }
    function facadeOf(base: Base, other: Base | undefined, facade?: Facade): ShaderMaterial | undefined {
        const chosen = other ?? base;
        const distinct = chosen !== base;
        const options = { name: "body", ...(distinct ? { base: chosen } : {}) };
        return facade && distinct ? surface({ ...options, name: "facade", facade }) : undefined;
    }
    async function main() {
        await createEngine({});
        const paired = Math.random() < 2;
        if (!facadeOf({ id: 1 }, paired ? { id: 2 } : undefined, paired ? { bold: true } : undefined)) throw new Error("facade");
    }
    main();`);
    assert.deepEqual(
        compiled.manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([0-9.]+)/.exec(program.vertexSource)?.[1],
        ),
        ["2.0"],
    );
    assert.match(
        compiled.cpp,
        /\} else \{\s+std::rethrow_exception\(bbl::js::make_error\("Error", "a facade requires a base"/,
    );
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    runGeneratedProgram(
        native,
        "executed-application-function/throwing-outcome",
        `${cpp}\n#define main generated_main\n${compiled.cpp}\n#undef main\nint main(){assert(generated_main()==0);}`,
        { expectedOutput: "" },
    );
});

const pluginScene = (plugin: string, prelude = ""): string => `
    import {
        addToScene,
        createBox,
        createEngine,
        createSceneContext,
        createStandardMaterial,
        enableMaterialPlugins,
        registerScene,
        type MaterialPlugin,
    } from "@babylonjs/lite";

    ${prelude}

    async function main() {
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const box = createBox(engine);
        const material = createStandardMaterial();
        material.plugins = [${plugin}];
        box.material = material;
        addToScene(scene, box);
        enableMaterialPlugins(scene);
        await registerScene(scene);
    }
`;

test("runs getCustomCode over the bindings its factory folds", () => {
    const result = compileSource(
        pluginScene(
            "createTint(HALF)",
            `
            const HALF = 0.5;
            function createTint(scale: number): MaterialPlugin {
                return {
                    name: "tint",
                    getCustomCode(shaderType) {
                        if (shaderType !== "fragment") return null;
                        return { CUSTOM_FRAGMENT_UPDATE_ALPHA: \`alpha *= \${scale.toFixed(2)};\` };
                    },
                };
            }
            `,
        ),
    );
    assert.match(JSON.stringify(result.manifest), /alpha \*= 0\.50;/);
});

test("refuses getCustomCode reading state the pin would read at run time", () => {
    assert.match(
        refusal(
            pluginScene(
                "createCounted()",
                `
                let calls = 0;
                function createCounted(): MaterialPlugin {
                    return {
                        name: "counted",
                        getCustomCode: (shaderType) =>
                            shaderType === "fragment"
                                ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: \`alpha *= \${calls}.0;\` }
                                : null,
                    };
                }
                `,
            ),
            "test/executed-plugin-entry.ts",
        ),
        /getCustomCode reads a module-scope 'let' or 'var'/,
    );
});
