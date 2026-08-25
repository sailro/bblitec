/**
 * The additive-animation anchors: the generated `setAnimationAdditive`
 * writers and the loader's additive mixer arm are lowered against the
 * pinned `weighted-gltf-mixer.ts`, and these tests prove the anchors are
 * live — the emission carries the pinned shapes, and a doctored pin
 * refuses generation instead of shipping stale C++.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { AnimationLowerer } from "../src/lowering/animation-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

const MIXER_MODULE = "src/animation/weighted-gltf-mixer.ts";

/**
 * A store serving one module with an exact edit applied. The base store
 * pre-parses modules while constructing, so the edited module bypasses
 * that cache with a doctored parse of its own.
 */
class DoctoredStore extends UpstreamSourceStore {
    private edits:
        | ReadonlyMap<string, readonly [string, string]>
        | undefined;
    private readonly doctoredFiles = new Map<
        string,
        ts.SourceFile
    >();

    public withEdits(
        edits: ReadonlyMap<string, readonly [string, string]>,
    ): this {
        this.edits = edits;
        return this;
    }

    public override getSource(modulePath: string): string {
        const source = super.getSource(modulePath);
        const edit = this.edits?.get(
            modulePath.replace(/\\/g, "/"),
        );
        if (!edit) return source;
        assert.ok(
            source.includes(edit[0]),
            `the pinned source no longer contains '${edit[0]}'`,
        );
        return source.replace(edit[0], edit[1]);
    }

    public override getSourceFile(
        modulePath: string,
    ): ts.SourceFile {
        const normalized = modulePath.replace(/\\/g, "/");
        if (!this.edits?.has(normalized)) {
            return super.getSourceFile(modulePath);
        }
        const cached = this.doctoredFiles.get(normalized);
        if (cached) return cached;
        const file = ts.createSourceFile(
            normalized,
            this.getSource(normalized),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        this.doctoredFiles.set(normalized, file);
        return file;
    }
}

function doctoredContext(
    needle: string,
    replacement: string,
): LoweringContext {
    return new LoweringContext(
        new DoctoredStore().withEdits(
            new Map([[MIXER_MODULE, [needle, replacement]]]),
        ),
    );
}

test("the additive group writers carry the pinned conversion and guard", () => {
    const lowered = new AnimationLowerer(
        new LoweringContext(),
    ).lowerGroupOperations({ additive: true, groupTime: true });
    // The frame arm divides by the pinned default rate — the setter's own
    // `|| 60` and the group factory's DEFAULT_FRAME_RATE, asserted equal.
    assert.match(
        lowered.source,
        /set_animation_additive\(\s*engine,\s*group,\s*reference_frame \/ 60\.0f\);/,
    );
    // The pinned finite/non-negative reference guard.
    assert.match(
        lowered.source,
        /!std::isfinite\(reference_time\) \|\|\s*reference_time < 0\.0f/,
    );
    // The additive mark takes the same writer route as every other group
    // field, and the owner enable installs the glTF mixer handler.
    assert.match(lowered.source, /asset\.set_clip_additive/);
    assert.match(
        lowered.source,
        /category_handler =\s*AnimationCategoryHandler::gltf_mixer;/,
    );
    // The direct currentTime write reaches the loader's own time writer.
    assert.match(
        lowered.source,
        /void set_animation_current_time\(/,
    );
    assert.doesNotMatch(
        // Without the reaches, neither writer is emitted — the gates keep
        // untouched scenes byte-identical.
        new AnimationLowerer(new LoweringContext())
            .lowerGroupOperations()
            .source,
        /set_animation_additive|set_animation_current_time/,
    );
});

test("the loader's additive arm mirrors accumulateAdditiveGroup", () => {
    const adapter = new GltfLowerer(
        new LoweringContext(),
    ).lowerLoaderAdapter({
        animationBlending: true,
        animationAdditive: true,
        managedGroups: true,
    });
    // The pass condition and the advance-only arm.
    assert.match(
        adapter.source,
        /if \(clip\.stopped \|\| !clip\.additive\) continue;/,
    );
    assert.match(adapter.source, /if \(clip\.additive\) continue;/);
    // The qualifying skip's additive half.
    assert.match(
        adapter.source,
        /entry\.weight != 1\.0f \|\|\s*animation_runtime->clips\[entry\.clip\]\.additive/,
    );
    // Reference-time sampling and the weighted difference.
    assert.match(
        adapter.source,
        /clip\.additive_reference_time\);/,
    );
    assert.match(
        adapter.source,
        /\(sample\.x - reference\.x\) \* weight/,
    );
    // reference^-1 * sample onto the base before the weighted slerp.
    assert.match(
        adapter.source,
        /quat_multiply\(node\.rotation, delta\)/,
    );
    // The writer the group operation reaches.
    assert.match(adapter.source, /asset\.set_clip_additive =/);
    // The seek freeze holds a paused clip where the scene put it.
    assert.match(
        adapter.source,
        /seek \? \(clip\.stopped \|\| !clip\.playing\)/,
    );
});

test("a doctored additive difference refuses generation", () => {
    assert.throws(
        () =>
            new GltfLowerer(
                doctoredContext(
                    "target.trs[base + T_OFF] = target.trs[base + T_OFF]! + (scratch.sample[0]! - scratch.reference[0]!) * weight;",
                    "target.trs[base + T_OFF] = target.trs[base + T_OFF]! + (scratch.sample[0]! + scratch.reference[0]!) * weight;",
                ),
            ).lowerLoaderAdapter({
                animationBlending: true,
                animationAdditive: true,
            }),
        /additive translation difference/,
    );
});

test("a doctored additive reference rate refuses generation", () => {
    assert.throws(
        () =>
            new AnimationLowerer(
                doctoredContext(
                    "(group.frameRate || 60)",
                    "(group.frameRate || 30)",
                ),
            ).lowerGroupOperations({ additive: true }),
        /Additive reference-time resolution/,
    );
});

test("a doctored owner enable refuses generation", () => {
    assert.throws(
        () =>
            new AnimationLowerer(
                doctoredContext(
                    "enableAnimationBlending(owner);",
                    "void owner;",
                ),
            ).lowerGroupOperations({ additive: true }),
        /enableAnimationBlending/,
    );
});
