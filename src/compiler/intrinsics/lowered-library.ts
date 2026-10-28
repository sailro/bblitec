/**
 * A lowered library's public calls (`LOWERED_LIBRARIES`), each the pinned
 * function of its name in the library's generated header, its arguments
 * and result read by the pinned signature's types: the library's records
 * the program holds by reference, its options records filled field by
 * field, the engine and scene a call names, and the program's PBR material
 * as `library::PbrMaterial`.
 */
import ts from "typescript";
import { cppIdentifier, snakeCase } from "../../cpp-literals.js";
import type { LoweringServices } from "../lowering-services.js";
import { pinnedRecordHandleKind } from "../data-types.js";
import { LOWERED_LIBRARIES } from "../lowered-record-surface.js";
import { calledDeclaration } from "../symbols.js";
import { argumentAt } from "../syntax.js";
import { valueKinds } from "../type-facts.js";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { libraryOptions } from "./retained-options.js";
import {
    type PackagedResponseContext,
    registeredPackagedUrl,
} from "../static-fetch.js";

export interface LoweredLibraryIntrinsicContext
    extends
        IntrinsicCallContext,
        PackagedResponseContext,
        Pick<LoweringServices, "requireEngine"> {}

/** A declared type's pinned name: `T`, or `T` of `Promise<T>`. */
function declaredName(node: ts.TypeNode | undefined): string | undefined {
    if (
        !node ||
        !ts.isTypeReferenceNode(node) ||
        !ts.isIdentifier(node.typeName)
    )
        return undefined;
    if (node.typeName.text === "Promise") {
        const inner = declaredName(node.typeArguments?.[0]);
        return inner && `Promise<${inner}>`;
    }
    return node.typeName.text;
}

export function compileLoweredLibraryIntrinsic(
    context: LoweredLibraryIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    const entry = LOWERED_LIBRARIES.find(({ library }) =>
        library.roots.has(name),
    );
    if (!entry) return undefined;
    context.reachFeature(entry.feature, call);
    const declaration = calledDeclaration(context.checker, call);
    if (!declaration || !ts.isFunctionDeclaration(declaration))
        return context.fail(call, `${name} has no pinned declaration.`);
    const parameters = declaration.parameters;
    context.expectArgumentCount(
        call,
        parameters.filter((parameter) => !parameter.questionToken).length,
        parameters.length,
    );
    const argument = (
        parameter: ts.ParameterDeclaration,
        index: number,
    ): string => {
        const site = argumentAt(call, index);
        const type = declaredName(parameter.type);
        const label = ts.isIdentifier(parameter.name)
            ? parameter.name.text
            : `argument ${index + 1}`;
        const held = (value: Value, kind: Value["kind"], prefix: string) => {
            context.expectKind(value, kind, site);
            return context.bindings.pinValueToTemporary(value, prefix, site)
                .cpp;
        };
        switch (type) {
            case "EngineContext":
                return `bbl::StoredEngine(${held(context.compileValue(site), "engine", "library_engine")})`;
            case "SceneContext":
                // What the library adds draws in the scene's own pass.
                for (const feature of entry.sceneFeatures)
                    context.reachFeature(feature, call);
                return `${held(context.compileValue(site), "scene", "library_scene")}.state`;
            case "PbrMaterialProps": {
                const material = context.compileValue(site);
                context.expectKind(material, "material", site);
                return `bbl::library::pbr_material(bbl::StoredEngine(${context.requireEngine(material, site)}), ${material.cpp})`;
            }
            case "MeshLoDSource":
                // A URL, whose packaged file (or HTTP resource) the
                // library's range requests read; its in-memory sources are
                // not lowered.
                return registeredPackagedUrl(context, call, site, {
                    accepts: (source) => source.endsWith(".mlod"),
                    refusal:
                        "A MeshLoD source URL must select packaged .mlod files or name an absolute HTTP(S) URL: a literal, or a runtime string whose candidates generation can find.",
                    label: "mesh_lod_url",
                    stem: "packaged_mesh_lod",
                }).url;
        }
        if (type && entry.library.records.includes(type)) {
            // A record the program holds (an asset, an instance), or an
            // options record it spells as an object literal.
            const handle = pinnedRecordHandleKind(type);
            return handle
                ? held(context.compileValue(site), handle, snakeCase(type))
                : libraryOptions(
                      context,
                      call,
                      call.arguments[index],
                      `bbl::${type}`,
                      index,
                  );
        }
        // One kind of value: a literal union (`MeshLoDDebugView`) included.
        const [kind, ...others] = valueKinds(
            context.checker.getTypeAtLocation(parameter),
        );
        if (
            others.length > 0 ||
            (kind !== "number" && kind !== "boolean" && kind !== "string")
        )
            return context.fail(
                site,
                `${name} takes ${label} as a value the native library does not read.`,
            );
        // Held in order: a later argument's options fill emits ahead of the call.
        return context.bindings.pinValueToTemporary(
            {
                kind: "data",
                cpp: context.dataLowerer.compileForSink(site, { kind }),
                dataType: { kind },
            },
            `library_${snakeCase(label)}`,
            site,
        ).cpp;
    };
    // Each argument in order (an absent trailing option stays absent).
    const cpp = `bbl::${cppIdentifier(snakeCase(name))}(${parameters
        .slice(0, call.arguments.length)
        .map(argument)
        .join(", ")})`;
    if (declaration.type?.kind === ts.SyntaxKind.VoidKeyword)
        return { kind: "void", cpp };
    // A library record the program holds, or a promise of one.
    const result = declaredName(declaration.type);
    const promised = result?.match(/^Promise<(.+)>$/)?.[1];
    const handle = pinnedRecordHandleKind(promised ?? result ?? "");
    if (!handle)
        return context.fail(call, `${name}'s result is not read natively yet.`);
    const record = context.dataLowerer.leafValue(promised ? "" : cpp, {
        kind: "handle",
        handle,
    });
    return promised
        ? {
              kind: "promise",
              cpp,
              promiseType: context.dataTypes.cppType({ kind: "handle", handle }),
              promiseResult: record,
          }
        : record;
}
