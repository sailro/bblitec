import assert from "node:assert/strict";
import test from "node:test";
import { doubleLiteral } from "../src/cpp-literals.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    lowerParallaxOcclusion,
    lowerParallaxOcclusionUnit,
} from "../src/lowering/parallax-occlusion.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { doctoredContext } from "./doctored-store.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const modulePath = "src/material/parallax/parallax-occlusion.ts";

interface PinnedParallax {
    _copyParallaxOcclusionProps(props: unknown): unknown;
    _writeParallaxUniforms(
        data: Float32Array,
        props: unknown,
        height: number,
        sampling: number,
        matrix: number,
        translation: number,
        base?: ArrayLike<number>,
        invertY?: boolean,
    ): void;
}

test("parallax occlusion lowers the pin's validation, getters and writer", () => {
    const ordinary = lowerParallaxOcclusion(new LoweringContext());
    for (const name of [
        "validate_parallax_steps",
        "copy_parallax_occlusion_props",
        "parallax_height_texture",
        "standard_parallax_height_texture",
        "write_parallax_uniforms",
        "write_parallax_uniforms_over",
    ])
        assert.match(ordinary, new RegExp(`\\b${name}\\(`));
    // The pin's defaults and messages come from its own declarations.
    const doctored = lowerParallaxOcclusion(
        doctoredContext(
            modulePath,
            "data[samplingOffset] = props.minSteps ?? 8;",
            "data[samplingOffset] = props.minSteps ?? 9;",
        ),
    );
    assert.notEqual(doctored, ordinary);
    assert.match(doctored, /9\.0/);
    // Both setters keep the shape the native store restates.
    const unit = lowerParallaxOcclusionUnit(new LoweringContext());
    assert.match(unit.source, /copy_parallax_occlusion_props\(\*props\)/);
    assert.throws(
        () =>
            lowerParallaxOcclusionUnit(
                doctoredContext(
                    "src/material/pbr/set-parallax-occlusion.ts",
                    "material._parallaxOcclusion = state;",
                    "material._parallaxOcclusion = state; material.alpha = 0.5;",
                ),
            ),
        /setPbrParallaxOcclusion/,
    );
});

test("parallax uniforms and validation match the pin", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const pin = await importPinnedModule<PinnedParallax>(
        "material/parallax/parallax-occlusion.js",
    );
    const texture = {
        texture: { format: "rgba8unorm" },
        uScale: 2,
        vScale: 0.5,
        uOffset: 0.25,
        vOffset: -0.125,
        uAng: 0.3,
    };
    const props = {
        heightTexture: texture,
        heightScale: 0.144,
        heightCenter: 0.25,
        heightChannel: "a",
        minSteps: 4,
        maxSteps: 8,
        refinementSteps: 4,
    };
    const expected: number[][] = [];
    for (const [base, invertY] of [
        [undefined, false],
        [[1.5, 0.75, 0.1, 0.2], false],
        [[1.5, 0.75, 0.1, 0.2], true],
    ] as const) {
        const data = new Float32Array(16);
        pin._writeParallaxUniforms(data, props, 0, 4, 8, 12, base, invertY);
        expected.push([...data]);
    }
    const messages = [
        { ...props, heightScale: -1 },
        { ...props, heightChannel: "x" },
        { ...props, maxSteps: 2 },
        { ...props, refinementSteps: 33 },
    ].map((invalid) => {
        try {
            pin._copyParallaxOcclusionProps(invalid);
            return "accepted";
        } catch (error) {
            return `${(error as Error).name}: ${(error as Error).message}`;
        }
    });
    const nativeProps = (
        overrides: Partial<Record<keyof typeof props, number | string>>,
    ): string => {
        const value = { ...props, ...overrides };
        const number = (field: number | string): string =>
            doubleLiteral(Number(field));
        return `[] {
        bbl::ParallaxOcclusionProps props{};
        props.height_texture.bytes = bbl::SharedTextureBytes(std::vector<std::uint8_t>{1});
        props.height_texture.uv_transform = {2.0, 0.5, 0.25, -0.125, 0.3};
        props.height_scale = ${number(value.heightScale)};
        props.height_center = ${number(value.heightCenter)};
        props.height_channel = std::string(${JSON.stringify(value.heightChannel)});
        props.min_steps = ${number(value.minSteps)};
        props.max_steps = ${number(value.maxSteps)};
        props.refinement_steps = ${number(value.refinementSteps)};
        return props;
    }()`;
    };
    const output = runGeneratedProgram(
        tools,
        "parallax-occlusion",
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <bblite/js_error.hpp>
#include <cstdio>
namespace bbl::upstream {
inline std::string parallax_texture_format(const TextureData& texture) {
    return texture.srgb ? "rgba8unorm-srgb" : "rgba8unorm";
}
${lowerParallaxOcclusion(new LoweringContext())}
}
int main() {
    using namespace bbl;
    const ParallaxOcclusionProps props = ${nativeProps({})};
    const auto print = [](const std::array<float, 16>& data) {
        for (float value : data) std::printf("%.9g ", static_cast<double>(value));
        std::printf("\\n");
    };
    std::array<float, 16> data{};
    upstream::write_parallax_uniforms(data, props, 0, 4, 8, 12);
    print(data);
    for (const bool invert : {false, true}) {
        data = {};
        upstream::write_parallax_uniforms_over(data, props, 0, 4, 8, 12, {1.5f, 0.75f, 0.1f, 0.2f}, invert);
        print(data);
    }
    for (const ParallaxOcclusionProps& invalid : {${nativeProps({ heightScale: -1 })}, ${nativeProps({ heightChannel: "x" })}, ${nativeProps({ maxSteps: 2 })}, ${nativeProps({ refinementSteps: 33 })}}) {
        try {
            static_cast<void>(upstream::copy_parallax_occlusion_props(invalid));
            std::printf("accepted\\n");
        } catch (const js::NamedError& error) {
            std::printf("%s: %s\\n", error.name.c_str(), error.what());
        }
    }
}
`,
    );
    const lines = output.trim().split(/\r?\n/);
    assert.deepEqual(
        lines.slice(0, 3).map((line) =>
            line
                .trim()
                .split(/\s+/)
                .map((value) => Math.fround(Number(value))),
        ),
        expected,
    );
    assert.deepEqual(lines.slice(3), messages);
});
