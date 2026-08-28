import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { assertFrameAtlasRule } from "../src/lowering/pinned-frame-atlas.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

const packerModule = "src/sprite/shared/sprite-atlas-packer.ts";

class DoctoredPackerStore extends UpstreamSourceStore {
    public override getSourceFile(modulePath: string): ts.SourceFile {
        if (modulePath.replace(/\\/g, "/") !== packerModule) {
            return super.getSourceFile(modulePath);
        }
        const source = super.getSource(modulePath);
        const needle = "const padding = options.paddingPx ?? 1;";
        assert.ok(source.includes(needle));
        return ts.createSourceFile(
            packerModule,
            source.replace(
                needle,
                "const padding = options.paddingPx ?? 0;",
            ),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
    }
}

test("the native frame-atlas port accepts the pinned packing rule", () => {
    assert.doesNotThrow(() =>
        assertFrameAtlasRule(new LoweringContext()),
    );
});

test("a doctored frame-atlas default refuses native generation", () => {
    assert.throws(
        () =>
            assertFrameAtlasRule(
                new LoweringContext(new DoctoredPackerStore()),
            ),
        /sprite frame-atlas creation 'padding'/,
    );
});
