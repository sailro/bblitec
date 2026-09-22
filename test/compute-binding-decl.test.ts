import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    computeBindingFactories,
    lowerComputeBindingDecl,
} from "../src/lowering/compute-binding-decl-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

type Scalar = string | number | boolean;
test("compute binding declarations retain forwarded options and identity", () => {
    const result = compileSource(`
import {computeUniformBufferBinding,computeStorageTextureViewBinding} from "@babylonjs/lite";
const create=(name:string,options:Parameters<typeof computeUniformBufferBinding>[1])=>computeUniformBufferBinding(name,options);
const buffer=create("params",{group:1,binding:2,dynamicOffset:true,minBindingSize:32});
const alias=buffer,other=create("params",{group:1,binding:2});
if(buffer!==alias||buffer===other||buffer.name!=="params"||buffer.group!==1||buffer.binding!==2)throw new Error("binding identity");
const texture=computeStorageTextureViewBinding("output",{group:0,binding:0,access:"write-only",format:"rg32float",viewDimension:"2d"});
if(texture.name!=="output")throw new Error("texture declaration");`);
    assert.ok(result.manifest.features.includes("compute:binding-decl"));
    assert.match(result.cpp, /compute_uniform_buffer_binding/);
});
interface Declaration {
    name: string;
    group: number;
    binding: number;
    _kind: number;
    _layout: Record<string, Record<string, Scalar>>;
    _data: string | Record<string, Scalar>;
}
test("compute binding declarations match pinned defaults, layouts and validation", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const cases: [string, Record<string, Scalar>][] = [
        ["computeStorageBufferBinding", { group: 0, binding: 2 }],
        [
            "computeStorageBufferBinding",
            {
                group: 2,
                binding: 3,
                access: "read-write",
                dynamicOffset: true,
                minBindingSize: 48,
            },
        ],
        [
            "computeStorageBufferBinding",
            { group: 0, binding: 0, access: "bad" },
        ],
        ["computeUniformBufferBinding", { group: 1, binding: 2 }],
        [
            "computeUniformBufferBinding",
            { group: 1, binding: 3, dynamicOffset: true, minBindingSize: 0 },
        ],
        ["computeTextureBinding", { group: 0, binding: 0 }],
        ["computeTextureBinding", { group: 0, binding: 0, multisampled: true }],
        [
            "computeTextureBinding",
            { group: 0, binding: 0, multisampled: true, sampleType: "float" },
        ],
        [
            "computeTextureViewBinding",
            {
                group: 0,
                binding: 0,
                sampleType: "unfilterable-float",
                viewDimension: "2d-array",
            },
        ],
        [
            "computeStorageTextureBinding",
            { group: 0, binding: 0, format: "rgba16float" },
        ],
        [
            "computeStorageTextureBinding",
            { group: 0, binding: 0, format: "rg32float" },
        ],
        [
            "computeStorageTextureViewBinding",
            {
                group: 0,
                binding: 0,
                format: "rg32float",
                access: "read-write",
                viewDimension: "2d",
            },
        ],
        ["computeSamplerBinding", { group: 0, binding: 0 }],
        [
            "computeSamplerBinding",
            { group: 0, binding: 0, type: "non-filtering" },
        ],
    ];
    const snake = (name: string) =>
        name.replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase());
    const cpp = (value: Scalar) =>
        typeof value === "string" ? JSON.stringify(value) : String(value);
    const checks: string[] = [];
    for (const [name, options] of cases) {
        const factory = computeBindingFactories[name]!;
        const pin = await importPinnedModule<
            Record<
                string,
                (name: string, options: Record<string, Scalar>) => Declaration
            >
        >(`compute/${factory.module}.js`);
        let result: Declaration | undefined, error: string | undefined;
        try {
            result = pin[name]!("input", options);
        } catch (caught) {
            if (!(caught instanceof Error)) throw caught;
            error = caught.message;
        }
        checks.push(
            "{ bbl::ComputeBindingOptions options;",
            ...Object.entries(options).map(
                ([name, value]) => `options.${snake(name)}=${cpp(value)};`,
            ),
        );
        const call = `bbl::${factory.cpp}("input",options)`;
        if (error !== undefined) {
            checks.push(
                `bool rejected=false;try{(void)${call};}catch(const std::exception& e){rejected=std::string(e.what())==${JSON.stringify(error)};}assert(rejected);`,
            );
        } else {
            assert.ok(result);
            checks.push(
                `auto value=${call};auto other=${call};assert(value!=other&&value->name=="input"&&value->group==${result.group}&&value->binding==${result.binding}&&value->kind==${result._kind});`,
            );
            for (const [kind, fields] of Object.entries(result._layout)) {
                const owner = `value->layout.${snake(kind)}`;
                checks.push(`assert(${owner}.has_value());`);
                if (kind === "buffer")
                    checks.push(
                        `assert(${owner}->min_binding_size.has_value()==${"minBindingSize" in fields});`,
                    );
                for (const [key, value] of Object.entries(fields))
                    checks.push(
                        `assert(${owner}->${snake(key)}${key === "minBindingSize" ? ".value()" : ""}==${cpp(value)});`,
                    );
            }
            if (typeof result._data === "string")
                checks.push(
                    `assert(value->data.sampler_type==${cpp(result._data)});`,
                );
            else
                for (const [key, value] of Object.entries(result._data))
                    checks.push(
                        `assert(value->data.${snake(key)}==${cpp(value)});`,
                    );
        }
        checks.push("}");
    }
    const directory = resolve("artifacts/compute-binding-decl-check");
    mkdirSync(directory, { recursive: true });
    const file = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        file,
        `${lowerComputeBindingDecl(new LoweringContext()).source}\n#include <cassert>\nint main(){${checks.join("\n")} }`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        file,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
