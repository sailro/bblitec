import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools();
const dxc = discoverDevelopmentTools().dxc;
test("SDL D3D12 descriptor rollover preserves graphics and compute tables", { skip: !nativeTools || !dxc }, () => {
    const output = resolve("artifacts/test-sdl-descriptor-heaps");
    mkdirSync(output, { recursive: true });
    const shaders = {
        vertex: `Texture2D<float4> tex : register(t0, space0);
SamplerState samp : register(s0, space0);
struct Out { float4 position : SV_Position; float4 color : TEXCOORD0; };
Out main(uint id : SV_VertexID) {
    Out o; float2 p = float2((id << 1) & 2, id & 2);
    o.position = float4(p * 2 - 1, 0, 1);
    o.color = tex.SampleLevel(samp, float2(.5, .5), 0); return o;
}`,
        fragment: `Texture2D<float4> a : register(t0, space2);
Texture2D<float4> b : register(t1, space2);
SamplerState sa : register(s0, space2); SamplerState sb : register(s1, space2);
float4 main(float4 position : SV_Position, float4 color : TEXCOORD0) : SV_Target0 {
    return (color + a.Sample(sa, float2(.5, .5)) + b.Sample(sb, float2(.5, .5))) / 3;
}`,
        compute: `Texture2D<float4> a : register(t0, space0);
Texture2D<float4> b : register(t1, space0); Texture2D<float4> c : register(t2, space0);
Texture2D<float4> extra : register(t3, space0);
SamplerState sa : register(s0, space0); SamplerState sb : register(s1, space0); SamplerState sc : register(s2, space0);
RWTexture2D<float4> image : register(u0, space1);
RWStructuredBuffer<float4> buffer : register(u1, space1);
cbuffer Slot : register(b0, space2) { uint slot; };
[numthreads(1, 1, 1)] void main() {
    float4 value = (a.SampleLevel(sa, float2(.5,.5), 0) + b.SampleLevel(sb, float2(.5,.5), 0) +
        c.SampleLevel(sc, float2(.5,.5), 0)) / 3;
    value = (value + extra.Load(int3(0,0,0))) / 2;
    image[uint2(slot,0)] = value; buffer[slot] = value;
}`,
    };
    for (const [stage, source] of Object.entries(shaders)) {
        const input = join(output, `${stage}.hlsl`);
        writeFileSync(input, source);
        execFileSync(dxc!, ["-T", `${stage === "vertex" ? "vs" : stage === "fragment" ? "ps" : "cs"}_6_0`,
            "-E", "main", "-WX", "-Fo", join(output, `${stage}.dxil`), input], { stdio: "pipe" });
    }
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
        `/I${join(nativeFixtureVcpkgRoot, "include")}`, resolve("test/fixtures/sdl-descriptor-heaps-check.cpp"),
        `/Fe:${executable}`, `/Fo:${join(output, "check.obj")}`, "/link", `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`, "SDL3.lib"]);
    for (const phase of ["graphics", "graphics-exact", "compute", "mixed"]) {
        const result = execFileSync(executable, [output, phase], { encoding: "utf8", timeout: 30000, windowsHide: true,
            env: { ...process.env, SDL_ASSERT: "always_ignore", PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}` } });
        assert.match(result, new RegExp(`${phase}: 1100 operations preserved descriptor bindings`));
    }
});
