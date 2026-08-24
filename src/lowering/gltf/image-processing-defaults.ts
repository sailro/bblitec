import ts from "typescript";
import { floatLiteral } from "../../cpp-literals.js";
import {
    pinnedAssignments,
    refuseModule,
    refuseNode,
    unwrapPin,
} from "./shared.js";

/**
 * The image-processing defaults the pinned EXT_lights_image_based
 * `_sceneSetup` writes (`gltf-ext-lights-image-based.ts`): exposure and
 * contrast flow as constants, and tone mapping must be enabled — the
 * environment record has no arm for an IBL asset that leaves it off.
 */
export function lowerImageProcessingDefaultsCpp(
    file: ts.SourceFile,
): string {
    const symbol = "EXT_lights_image_based";
    const numericFor = (property: string): number => {
        const path = `scene.imageProcessing.${property}`;
        const found = pinnedAssignments(file, path);
        if (found.length !== 1) {
            refuseModule(
                symbol,
                `no longer writes ${path} exactly once`,
            );
        }
        const value = unwrapPin(found[0]!.right);
        if (!ts.isNumericLiteral(value)) {
            refuseNode(
                symbol,
                file,
                found[0]!,
                `no longer writes a constant ${property}`,
            );
        }
        return Number(value.text);
    };
    const exposure = numericFor("exposure");
    const contrast = numericFor("contrast");
    const toneMapping = pinnedAssignments(
        file,
        "scene.imageProcessing.toneMappingEnabled",
    );
    if (
        toneMapping.length !== 1 ||
        unwrapPin(toneMapping[0]!.right).kind !==
            ts.SyntaxKind.TrueKeyword
    ) {
        refuseModule(
            symbol,
            "no longer enables tone mapping exactly once",
        );
    }
    return [
        `    environment.exposure = ${floatLiteral(exposure)};`,
        `    environment.contrast = ${floatLiteral(contrast)};`,
        "    environment.tone_mapping_enabled = true;",
    ].join("\n");
}
