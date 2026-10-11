import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerComputeBindings } from "../src/lowering/compute-bindings-lowerer.js";
import { lowerComputeOneShot } from "../src/lowering/compute-one-shot-lowerer.js";
import { lowerComputeTextureMipmaps } from "../src/lowering/compute-texture-mipmaps-lowerer.js";
import { lowerProceduralSkyLoader } from "../src/lowering/procedural-sky-loader.js";
import {
    lowerProceduralSkyAtmosphere,
    proceduralSkyModule,
} from "../src/lowering/procedural-sky-atmosphere.js";
import { lowerStorageBuffer } from "../src/lowering/storage-buffer-lowerer.js";
import { lowerStorageReadback } from "../src/lowering/storage-readback-lowerer.js";
import {
    ySortCoreCpp,
    ySortModule,
} from "../src/lowering/sprite-y-sort-lowerer.js";
import { doctoredContext } from "./doctored-store.js";

interface TransportCase {
    name: string;
    module: string;
    lower: (context: LoweringContext) => unknown;
    neutral: readonly (readonly [string, string])[];
    refused: readonly [string, string];
}

const cases: readonly TransportCase[] = [
    {
        name: "compute resource selection",
        module: "src/compute/compute-bindings.ts",
        lower: lowerComputeBindings,
        neutral: [
            ["Object.keys(resources)", "Object /* keys */ . keys((resources))"],
            ["volatileEntries[i]!", "(volatileEntries /* cached */)[i]!"],
        ],
        refused: ["Object.keys(resources)", "Object.values(resources)"],
    },
    {
        name: "one-shot destructuring",
        module: "src/compute/compute-one-shot.ts",
        lower: lowerComputeOneShot,
        neutral: [
            [
                "const [oneShot, generation] of batch",
                "const [oneShot /* shot */, generation] of (batch)",
            ],
        ],
        refused: [
            "const [oneShot, generation] of batch",
            "const [oneShot, generation = 0] of batch",
        ],
    },
    {
        name: "storage upload transport",
        module: "src/resource/storage-buffer.ts",
        lower: lowerStorageBuffer,
        neutral: [
            [
                "engine._device.queue.writeBuffer",
                "(engine /* device */ . _device . queue).writeBuffer",
            ],
        ],
        refused: [
            "engine._device.queue.writeBuffer",
            "engine._device.queue.writeTexture",
        ],
    },
    {
        name: "storage readback transport",
        module: "src/resource/storage-buffer.ts",
        lower: lowerStorageReadback,
        neutral: [
            [
                "buffer._readback ??= device.createBuffer({",
                "buffer._readback ??= (device /* staging */).createBuffer({",
            ],
        ],
        refused: [
            "buffer._readback ??= device.createBuffer({",
            "buffer._readback ??= device.createTexture({",
        ],
    },
    {
        name: "mipmap range",
        module: "src/texture/mipmap-preparation.ts",
        lower: lowerComputeTextureMipmaps,
        neutral: [
            [
                "const level of prepared",
                "const level of (prepared /* snapshot */)",
            ],
        ],
        refused: ["const level of prepared", "const level of prepared.other"],
    },
    {
        name: "sky retained texture",
        module: proceduralSkyModule,
        lower: (context) => lowerProceduralSkyLoader(context, "{}"),
        neutral: [
            [
                "acquireGPUTexture(texture);",
                "acquireGPUTexture((texture /* lease */));",
            ],
            [
                "const [irradiance, image]",
                "const [irradiance /* light */, image]",
            ],
        ],
        refused: [
            "acquireGPUTexture(texture);",
            "acquireGPUTexture(otherTexture);",
        ],
    },
    {
        name: "sky array constructor",
        module: proceduralSkyModule,
        lower: lowerProceduralSkyAtmosphere,
        neutral: [["new F32(27)", "new (F32 /* harmonics */)(27)"]],
        refused: ["new F32(27)", "new UnknownArray(27)"],
    },
    {
        name: "Y-sort upload transport",
        module: ySortModule,
        lower: ySortCoreCpp,
        neutral: [
            [
                "device.queue.writeBuffer(instanceBuffer, offsetBytes, state._packedInstances.buffer,",
                "(device /* upload */ . queue).writeBuffer(instanceBuffer, offsetBytes, (state._packedInstances.buffer),",
            ],
            ["layer._dirtyMin = 0;", "layer /* consume */ . _dirtyMin = (0);"],
            [
                "return layer._version;",
                "return (layer /* version */ . _version);",
            ],
        ],
        refused: [
            "device.queue.writeBuffer(instanceBuffer,",
            "device.queue.writeBuffer(otherBuffer,",
        ],
    },
];

for (const entry of cases) {
    test(`${entry.name} uses AST contracts for native transport`, () => {
        const original = entry.lower(new LoweringContext());
        for (const [needle, replacement] of entry.neutral)
            assert.deepEqual(
                entry.lower(doctoredContext(entry.module, needle, replacement)),
                original,
                replacement,
            );
        assert.throws(() =>
            entry.lower(doctoredContext(entry.module, ...entry.refused)),
        );
    });
}

test("mipmap array indices use the shared expression lowerer", () => {
    const path = "src/compute/compute-storage-texture-mipmaps.ts";
    assert.deepEqual(
        lowerComputeTextureMipmaps(
            doctoredContext(
                path,
                "textures[i]!",
                "(textures /* source */)[i as number]!",
            ),
        ),
        lowerComputeTextureMipmaps(new LoweringContext()),
    );
    const changed = lowerComputeTextureMipmaps(
        doctoredContext(path, "textures[i]!", "textures[i + 1]!"),
    );
    assert.ok(
        changed.source.includes(
            "textures[static_cast<std::size_t>((i + 1.0))]",
        ),
    );
});

test("expression choices preserve optional access and unmatched boundaries", () => {
    const context = new LoweringContext();
    const file = ts.createSourceFile(
        "choice.ts",
        "(state /* optional */ ?. shots . delete);",
        ts.ScriptTarget.Latest,
        true,
    );
    const statement = file.statements[0]!;
    assert.ok(ts.isExpressionStatement(statement));
    const expression = statement.expression;
    assert.equal(
        context.matchingExpressionShape(expression, [
            "state.shots.delete",
            "state?.shots.delete",
        ]),
        "state?.shots.delete",
    );
    assert.equal(
        context.matchingExpressionShape(expression, ["state.shots.delete"]),
        undefined,
    );
    assert.equal(
        context.matchingExpressionShape(undefined, ["state?.shots.delete"]),
        undefined,
    );
});
