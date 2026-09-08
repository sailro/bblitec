import assert from "node:assert/strict";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

/**
 * A store serving pinned modules with exact edits applied, for proving
 * that a lowering is live: a doctored pin must move -- or refuse -- the
 * emission. The base store pre-parses modules while constructing, so an
 * edited module bypasses that cache with a doctored parse of its own.
 */
export class DoctoredStore extends UpstreamSourceStore {
    private edits:
        | ReadonlyMap<string, readonly [string, string]>
        | undefined;
    private readonly doctoredFiles = new Map<string, ts.SourceFile>();

    public withEdits(
        edits: ReadonlyMap<string, readonly [string, string]>,
    ): this {
        this.edits = edits;
        return this;
    }

    public override getSource(modulePath: string): string {
        const source = super.getSource(modulePath);
        const edit = this.edits?.get(modulePath.replace(/\\/g, "/"));
        if (!edit) return source;
        assert.ok(
            source.includes(edit[0]),
            `the pinned source no longer contains '${edit[0]}'`,
        );
        return source.replace(edit[0], edit[1]);
    }

    public override getSourceFile(modulePath: string): ts.SourceFile {
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

/** A lowering context over one pinned module with one exact edit applied. */
export function doctoredContext(
    modulePath: string,
    needle: string,
    replacement: string,
): LoweringContext {
    return new LoweringContext(
        new DoctoredStore().withEdits(
            new Map([[modulePath, [needle, replacement]]]),
        ),
    );
}
