import {
    contextCanvas,
    isStringValue,
    optionalPresentCpp,
    presenceFlagCpp,
    valueForKind,
} from "./types.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import {
    emissionArray,
    EmissionSet,
    EmissionMap,
    EmissionWeakMap,
    journaled,
    writable,
} from "./emission-transaction.js";
import ts from "typescript";
import { doubleLiteral } from "../cpp-literals.js";
import {
    deferredUiStyleCapability,
    visitUiStyleSheetDeclarations,
} from "../deferred-ui-style.js";
import { parseUiBorderImage, renderUiBorderImage } from "../ui-border-image.js";
import { uiGradientBackground } from "../ui-gradient-background.js";
import { supportedUiGridPlacement, supportedUiGridTracks } from "../ui-grid.js";
import { supportedUiBoxShadow, supportedUiFilter } from "../ui-filters.js";
import {
    supportedUiImageBackground,
    uiBackgroundImageSource,
    nativeUiImageProperty,
} from "../ui-image-background.js";
import {
    findUiCssSyntax,
    stripUiCssComments,
    uiCssBlockEnd,
    uiCssSyntaxIndices,
} from "../ui-css-syntax.js";
import {
    isUiGeneratedPart,
    parseUiGeneratedContent,
    uiGeneratedContentCpp,
    uiGeneratedPartCpp,
    type UiGeneratedContent,
    type UiGeneratedPart,
} from "../ui-generated-content.js";
import {
    documentLookupId,
    parseUiSelectorSequence,
    splitUiSelectorList,
    uiSelectorSequenceCss,
    uiSelectorSequenceCpp,
    type UiSelectorStep,
} from "../ui-selector.js";
import {
    isUiLayoutProperty,
    supportedUiLayoutValue,
    uiLogicalSpacingProperties,
} from "../ui-layout.js";
import {
    nativeHostUiStyleRules,
    uiStyleSelector,
    uiStyleSelectorCppKind,
    uiStyleSelectorDescriptor,
    uiStyleInteractionStateCount,
    uiStyleRuleNeedsRuntimeMatch,
    uiStyleRuleHasConditions,
    uiMotionPreferenceCpp,
    isUiScrollbarPart,
    uiScrollbarPartCpp,
    isUiRangePart,
    uiRangePartCpp,
    type UiStyleSelectorShape,
    type UiStyleSelectorKind,
} from "../ui-style-rule.js";
import { nativeHostUiElements } from "../native-host-ui.js";
import { validateFileAccept } from "./browser-file.js";
import { CompileError } from "./compile-error.js";
import { documentEngine } from "./window-events.js";
import {
    elementDomHandlerFamily,
    emitDomEventHandler,
    eventHandlerResult,
    pinDetached,
} from "./dom-listeners.js";
import {
    elementInterfaceTag,
    eventTargetCpp,
    isDocumentReceiver,
    isDomReceiver,
} from "./dom-targets.js";
import { registerUiImageAsset } from "./assets.js";
import {
    canvasContextIds,
    engineCanvasIds,
    primaryCanvasIds,
} from "./browser-erasure.js";
import type { LoweringServices } from "./lowering-services.js";
import { declaredSymbol } from "./symbols.js";
import { uiMarkupValueShape, type UiMarkupShape } from "./ui-markup-values.js";
import { argumentAt } from "./syntax.js";
import type { NativeHostUiNode, RefusalSite, Value } from "./types.js";
import {
    dataTypeMayHoldUiElement,
    typeMayMapToUiElement,
} from "./ui-element-analysis.js";

interface LoweredUiStyleRule extends UiStyleSelectorShape {
    // Preserve source selector and declaration metadata through native emission.
    kind: Exclude<UiStyleSelectorKind, "tag-attribute">;
    hover: boolean;
    maxWidth?: number;
    containerMaxWidth?: number;
    reducedMotion?: boolean;
    orientation?: "portrait" | "landscape";
    style: string;
    selector: string;
    site?: ts.Node;
    ownerId?: number;
    sequence?: UiSelectorStep[];
    content?: UiGeneratedContent;
}

interface UiStaticMarkupNode {
    id: number;
    tag: string;
    classes: ReadonlySet<string>;
    attributes: ReadonlyMap<string, string>;
    children: UiStaticMarkupNode[];
}

type UiMarkupPart =
    | string
    | { kind: "text"; expression: ts.Expression }
    | { kind: "stored"; expression: ts.Expression; shape: UiMarkupShape }
    | {
          kind: "choice";
          condition: ts.Expression;
          yes: UiMarkupPart[];
          no: UiMarkupPart[];
      };

/** Compiler state: written in place only through `writable()`; its sets are journaled. */
interface UiStaticElement {
    readonly tag: string;
    /** Every exact class set the element can have at a projected boundary. */
    readonly classAlternatives: readonly Set<string>[];
    readonly classMayMutateDynamically: boolean;
    readonly ids: Set<string>;
    readonly children: Set<number>;
    readonly markupChildren: readonly UiStaticMarkupNode[];
    /** Reachable complete inline declaration lists, not assignment history. */
    readonly styles: readonly string[];
    readonly styleShapeKnown: boolean;
    readonly styleMayMutateDynamically: boolean;
    readonly mutableClasses: Set<string>;
    readonly classShapeKnown: boolean;
    /** False when known child construction sites can occur a runtime number of times. */
    readonly childCardinalityKnown: boolean;
    readonly childShapeKnown: boolean;
}

/** What `uiElementValue` knows of the element an expression names. */
interface UiElementMetadata {
    tag: string | undefined;
}

interface UiPendingClassQuery {
    root: Value;
    className: string;
    site: ts.Node;
}

interface UiUnknownClassMutation {
    className: string;
    site: ts.Node;
}

interface UiUnknownAttributeMutation {
    attribute: "class" | "id";
    /** Known construction target; absent when a runtime lookup selected it. */
    targetId?: number;
    site: ts.Node;
}

interface UiProjectionContext extends Pick<
    LoweringServices,
    | "activeThis"
    | "assets"
    | "assetOutputs"
    | "assetPayloads"
    | "attributeRefusalsTo"
    | "allocateTemporaryCppName"
    | "sourceFile"
    | "sourceFiles"
    | "checker"
    | "compileBoolean"
    | "conditions"
    | "compileNumber"
    | "compilePlatformCall"
    | "callbacks"
    | "compileStringLiteral"
    | "compileValue"
    | "cppString"
    | "dataLowerer"
    | "defaultEngine"
    | "deferredCapabilities"
    | "emit"
    | "emitDiscardedValue"
    | "evaluator"
    | "expectKind"
    | "expectSameEngine"
    | "fail"
    | "failAtFile"
    | "hasFeature"
    | "hasPresentationHost"
    | "isCanvasElement"
    | "libraryGlobal"
    | "isInFrameCallback"
    | "isInRuntimeControlFlow"
    | "bindings"
    | "sharedClosures"
    | "captureEmittedLines"
    | "enterRuntimeControlFlow"
    | "leaveRuntimeControlFlow"
    | "options"
    | "probeEmission"
    | "reachFeature"
    | "assetRegistry"
    | "reachJsData"
    | "requireDefaultEngine"
    | "requireEngine"
    | "requirePresentationHost"
    | "resolveRecordMember"
    | "resolveThisField"
    | "symbols"
    | "unwrap"
> {}

/** String IDL attributes reflecting one content attribute. */
interface UiReflectedAttribute {
    attribute: string;
    readable: boolean;
    tag?: string;
}
const UI_REFLECTED_ATTRIBUTES: ReadonlyMap<string, UiReflectedAttribute> =
    new Map<string, UiReflectedAttribute>([
        ["id", { attribute: "id", readable: true }],
        ["className", { attribute: "class", readable: true }],
        ["lang", { attribute: "lang", readable: true }],
        ["type", { attribute: "type", readable: false }],
        ...["min", "max", "step"].map(
            (name): [string, UiReflectedAttribute] => [
                name,
                { attribute: name, readable: true, tag: "input" },
            ],
        ),
    ]);

export class UiProjection {
    public constructor(private readonly context: UiProjectionContext) {}

    private readonly uiMarkupAlternativeOwners = new EmissionSet<number>();
    private readonly uiMarkupNodeIds = new EmissionMap<number, number>();

    private uiRuleSuffix(
        rule: Pick<
            LoweredUiStyleRule,
            "pseudo" | "content" | "range" | "containerMaxWidth" | "orientation"
        > & { sequence?: readonly UiSelectorStep[] },
    ): string {
        const cppString = (value: string) => this.context.cppString(value);
        const slots: [boolean, string][] = [
            [
                rule.sequence !== undefined,
                uiSelectorSequenceCpp(rule.sequence ?? [], cppString),
            ],
            [
                Boolean(rule.pseudo),
                `bbl::UiGeneratedPart::${uiGeneratedPartCpp(rule.pseudo)}, ${uiGeneratedContentCpp(rule.content, cppString)}`,
            ],
            [
                Boolean(rule.range),
                `bbl::UiRangePart::${uiRangePartCpp(rule.range)}`,
            ],
            [
                rule.containerMaxWidth !== undefined,
                doubleLiteral(rule.containerMaxWidth ?? -1),
            ],
            [
                rule.orientation !== undefined,
                `bbl::UiOrientation::${rule.orientation === "portrait" ? "Portrait" : "Landscape"}`,
            ],
        ];
        let last = slots.length - 1;
        while (last >= 0 && !slots[last]![0]) --last;
        return last < 0
            ? ""
            : `, ${slots
                  .slice(0, last + 1)
                  .map(([, value]) => value)
                  .join(", ")}`;
    }

    public registerImageSource(source: string): void {
        if (source) registerUiImageAsset(this.context, source, source);
    }

    public documentEngine(node: ts.Node): string {
        if (
            !this.context.options.workers &&
            this.context.defaultEngine() === undefined
        )
            throw new ApplicationRealmRequired();
        return (
            documentEngine(this.context, node) ??
            this.context.requireDefaultEngine(node)
        );
    }

    /** Calls through stored Documents retain the selected owner before arguments run. */
    public documentReceiverEngine(
        expression: ts.Expression,
        prepared?: Value,
    ): string {
        if (this.context.libraryGlobal(expression) === "document")
            return this.documentEngine(expression);
        const value = prepared ?? this.context.compileValue(expression);
        const target = pinDetached(
            this.context,
            {
                kind: "data",
                cpp: eventTargetCpp(this.context, value, expression),
                dataType: { kind: "event-target" },
            },
            "document_receiver",
            expression,
        );
        const engine = this.context.allocateTemporaryCppName("document_owner");
        this.context.emit({
            kind: "expression",
            code: `auto& ${engine} = bbl::dom_document_owner(${target.cpp});`,
        });
        return engine;
    }

    private documentRootTag(expression: ts.Expression): string | undefined {
        const owner = this.context.unwrap(expression);
        if (
            !ts.isPropertyAccessExpression(owner) ||
            !["documentElement", "head", "body"].includes(owner.name.text) ||
            this.context.libraryGlobal(owner.expression) !== "document"
        )
            return undefined;
        return owner.name.text === "documentElement" ? "html" : owner.name.text;
    }

    public documentRootValue(expression: ts.Expression): Value | undefined {
        const tag = this.documentRootTag(expression);
        if (!tag) return undefined;
        const owner = this.context.unwrap(expression);
        const engine = this.documentEngine(owner);
        this.context.reachFeature("ui:rml", owner);
        if (!this.uiDocumentRootIds.has("html")) {
            for (const tag of ["html", "head", "body"])
                this.uiDocumentRootIds.set(
                    tag,
                    this.createUiStaticElement(tag),
                );
            const html = this.uiDocumentRootIds.get("html")!;
            const body = this.uiStaticElements.get(
                this.uiDocumentRootIds.get("body")!,
            )!;
            for (const child of this.uiStaticRootOrder)
                body.children.add(child);
            this.uiStaticElements
                .get(html)!
                .children.add(this.uiDocumentRootIds.get("head")!);
            this.uiStaticElements
                .get(html)!
                .children.add(this.uiDocumentRootIds.get("body")!);
            this.uiStaticRootOrder.splice(
                0,
                this.uiStaticRootOrder.length,
                html,
            );
        }
        const part = tag === "html" ? "Html" : tag === "head" ? "Head" : "Body";
        return {
            kind: "ui-element",
            cpp: `bbl::ui_document_root(${engine}, bbl::UiDocumentPart::${part})`,
            engineCpp: engine,
            uiTag: tag,
            uiStaticId: this.uiDocumentRootIds.get(tag)!,
            truthinessCpp: "true",
        };
    }

    public booleanAttribute(
        element: Value,
        property: string,
        site: ts.Node,
    ): string | undefined {
        if (property === "open") {
            if (element.uiTag && element.uiTag !== "details")
                this.context.fail(site, "UI open requires a details element.");
            return property;
        }
        if (property !== "hidden" && property !== "disabled") return undefined;
        if (
            property === "disabled" &&
            element.uiTag &&
            !["button", "input", "textarea", "select", "option"].includes(
                element.uiTag,
            )
        ) {
            this.context.fail(
                site,
                "UI disabled requires a supported form control.",
            );
        }
        return property;
    }

    public uiElementValue(expression: ts.Expression): Value | undefined {
        const root = this.documentRootValue(expression);
        if (root) return root;
        const owner = this.context.unwrap(expression);
        const asElement = (value: Value | undefined): Value | undefined => {
            if (!value) return undefined;
            if (this.presentsPrimaryCanvas(value)) {
                return Object.assign(
                    writable(value),
                    this.primaryPresentationCanvas(owner),
                );
            }
            const tracked = this.trackedUiElementMetadata(value);
            const withTrackedTag = (
                element: Value<"ui-element">,
            ): Value<"ui-element"> => {
                const uiTag =
                    element.uiTag === undefined ? tracked.tag : undefined;
                const uiStaticId =
                    element.uiStaticId === undefined
                        ? tracked.staticId
                        : undefined;
                return uiTag === undefined && uiStaticId === undefined
                    ? element
                    : {
                          ...element,
                          ...(uiTag === undefined ? {} : { uiTag }),
                          ...(uiStaticId === undefined ? {} : { uiStaticId }),
                      };
            };
            if (value.kind === "ui-element") {
                return withTrackedTag(value);
            }
            if (value.kind !== "data" || !value.dataType) {
                return undefined;
            }
            const target = this.narrowedTargetElement(value, expression);
            if (target) return target;
            const narrowed = this.context.dataLowerer.narrowOptional(
                value,
                expression,
            );
            if (
                narrowed.kind === "data" &&
                narrowed.dataType?.kind === "event-target"
            )
                return undefined;
            if (narrowed.kind === "ui-element") {
                return withTrackedTag(narrowed);
            }
            if (
                value.dataType.kind !== "optional" ||
                value.dataType.inner.kind !== "handle" ||
                value.dataType.inner.handle !== "ui-element"
            ) {
                return undefined;
            }
            return withTrackedTag(
                valueForKind("ui-element", {
                    ...value,

                    cpp: `(*${value.cpp})`,
                    dataType: value.dataType.inner,
                    optionalFoundCpp:
                        presenceFlagCpp(value) ?? optionalPresentCpp(value.cpp),
                    engineCpp: value.engineCpp ?? this.documentEngine(owner),
                }),
            );
        };
        if (ts.isIdentifier(owner)) {
            return asElement(this.context.bindings.lookupOptional(owner));
        }
        if (
            ts.isPropertyAccessExpression(owner) &&
            owner.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
            return asElement(this.context.resolveThisField(owner.name.text));
        }
        const drawn =
            ts.isPropertyAccessExpression(owner) && owner.name.text === "canvas"
                ? contextCanvas(this.uiElementValue(owner.expression))
                : undefined;
        if (drawn) return drawn;
        if (
            ts.isPropertyAccessExpression(owner) ||
            ts.isElementAccessExpression(owner)
        ) {
            // This is also an erasure probe, not permission to lower arbitrary
            // members (such as Set.add or a captured GPU device's queue).
            const type = this.context.dataLowerer.dataTypeAt(expression);
            const inner = type?.kind === "optional" ? type.inner : type;
            if (inner?.kind !== "handle" || inner.handle !== "ui-element") {
                return undefined;
            }
        }
        if (ts.isPropertyAccessExpression(owner)) {
            let value =
                this.context.resolveRecordMember(owner) ??
                this.context.dataLowerer.compileDataPath(owner, "read");
            if (!value) {
                const type = this.context.dataLowerer.dataTypeAt(owner);
                const inner = type?.kind === "optional" ? type.inner : type;
                if (inner?.kind === "event-target")
                    value = this.context.compileValue(owner);
            }
            // Tree reads can produce a nullable element directly rather than
            // a stored data path. Its presence and handle share one evaluation.
            if (value?.dataType?.kind === "optional")
                value = this.context.bindings.pinValueToTemporary(
                    value,
                    "ui_receiver",
                    owner,
                );
            return asElement(value);
        }
        if (ts.isElementAccessExpression(owner)) {
            return asElement(
                this.context.dataLowerer.compileDataPath(owner, "read"),
            );
        }
        if (ts.isCallExpression(owner)) {
            const callee = this.context.unwrap(owner.expression);
            if (
                ts.isPropertyAccessExpression(callee) &&
                callee.name.text === "getContext"
            ) {
                const canvas = this.uiElementValue(callee.expression);
                if (canvas?.uiCanvas) {
                    return { ...canvas, uiCanvasContext: true };
                }
            }
            if (
                ts.isPropertyAccessExpression(callee) &&
                this.isUiElementLookup(owner, callee)
            ) {
                const value = this.context.compilePlatformCall(owner);
                return asElement(
                    value?.kind === "data" &&
                        value.dataType?.kind === "optional"
                        ? this.context.bindings.pinValueToTemporary(
                              value,
                              "ui_lookup",
                              owner,
                          )
                        : value,
                );
            }
        }
        return undefined;
    }

    /**
     * An event target the program narrowed to an element interface, viewed
     * as that element; the view throws when the target is not an Element of
     * its owning document.
     */
    public narrowedTargetElement(
        value: Value,
        expression: ts.Expression,
    ): Value<"ui-element"> | undefined {
        const target = this.narrowedTarget(value, expression);
        return target === undefined ? undefined : this.targetElement(target);
    }

    /** The element view of a pinned event target. */
    public targetElement(target: string): Value<"ui-element"> {
        return valueForKind("ui-element", {
            cpp: `bbl::dom_target_element(${target})`,
            dataType: { kind: "handle", handle: "ui-element" },
            engineCpp: `bbl::dom_target_owner(${target})`,
        });
    }

    /** An event target the program narrowed to an element interface, pinned for one read. */
    public narrowedTarget(
        value: Value,
        expression: ts.Expression,
    ): string | undefined {
        if (value.kind !== "data") return undefined;
        const optional = value.dataType?.kind === "optional";
        const inner =
            value.dataType?.kind === "optional"
                ? value.dataType.inner
                : value.dataType;
        const requested = this.context.dataLowerer.dataTypeAt(expression);
        if (
            inner?.kind !== "event-target" ||
            requested?.kind !== "handle" ||
            requested.handle !== "ui-element"
        )
            return undefined;
        const narrowed = this.context.dataLowerer.narrowOptional(
            value,
            expression,
            optional,
        );
        if (
            narrowed.kind !== "data" ||
            narrowed.dataType?.kind !== "event-target"
        )
            return undefined;
        const selected = { ...narrowed };
        delete selected.nativeBinding;
        return this.context.bindings.pinValueToTemporary(
            selected,
            "event_target",
            expression,
        ).cpp;
    }

    /**
     * The element's tag, or the one its declared HTML interface names when
     * storage (a record field, a container) did not carry the tag.
     */
    public declaredUiTag(
        element: Value,
        expression: ts.Expression,
    ): string | undefined {
        if (element.uiTag !== undefined) return element.uiTag;
        return elementInterfaceTag(
            this.context.checker
                .getNonNullableType(
                    this.context.checker.getTypeAtLocation(expression),
                )
                .getSymbol()?.name ?? "",
        );
    }

    /** Evaluate helper receivers at admitted operations, not during erasure probes. */
    public compileUiElementReceiver(
        expression: ts.Expression,
    ): Value | undefined {
        const known = this.uiElementValue(expression);
        if (known)
            return known.engineCpp
                ? known
                : { ...known, engineCpp: this.documentEngine(expression) };
        if (!ts.isCallExpression(this.context.unwrap(expression)))
            return undefined;
        const type = this.context.dataLowerer.dataTypeAt(expression);
        if (type?.kind !== "handle" || type.handle !== "ui-element")
            return undefined;
        const value = this.context.dataLowerer.narrowOptional(
            this.context.compileValue(expression),
            expression,
        );
        if (value.kind !== "ui-element")
            this.context.fail(
                expression,
                "A DOM helper must return a retained element.",
            );
        return this.context.bindings.pinValueToTemporary(
            value,
            "ui_receiver",
            expression,
        );
    }

    /** Whether `uiElementValue` answers a UI element here, and its tag. */
    private uiElementMetadata(
        expression: ts.Expression,
    ): UiElementMetadata | undefined {
        const analyzed = this.analyzedUiElementMetadata(expression);
        return analyzed === "lower"
            ? this.loweredUiElementMetadata(expression)
            : analyzed;
    }

    /**
     * `uiElementMetadata` without lowering where `uiElementValue`'s arm is
     * decided before it lowers anything: a `this` field by its bound value,
     * another member or element read by its checker type, a call by its
     * method. "lower" everywhere else.
     */
    public analyzedUiElementMetadata(
        expression: ts.Expression,
    ): UiElementMetadata | undefined | "lower" {
        // A document root selects its engine, which can refuse.
        if (this.documentRootTag(expression)) return "lower";
        const owner = this.context.unwrap(expression);
        if (
            ts.isPropertyAccessExpression(owner) &&
            owner.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
            const value =
                this.context.activeThis()?.recordProperties?.[owner.name.text];
            if (!value) return undefined;
            if (this.presentsPrimaryCanvas(value)) return "lower";
            if (value.kind === "ui-element")
                return { tag: this.trackedUiElementMetadata(value).tag };
            return value.kind === "data" &&
                value.dataType &&
                dataTypeMayHoldUiElement(value.dataType)
                ? "lower"
                : undefined;
        }
        if (
            ts.isPropertyAccessExpression(owner) ||
            ts.isElementAccessExpression(owner)
        ) {
            return typeMayMapToUiElement(
                this.context.checker.getTypeAtLocation(expression),
                this.context.checker,
            )
                ? "lower"
                : undefined;
        }
        if (ts.isCallExpression(owner)) {
            const callee = this.context.unwrap(owner.expression);
            return ts.isPropertyAccessExpression(callee) &&
                (callee.name.text === "getContext" ||
                    this.isUiElementLookup(owner, callee))
                ? "lower"
                : undefined;
        }
        return "lower";
    }

    /** A call `uiElementValue` lowers through the platform call: a query, a closest ancestor, a host lookup. */
    private isUiElementLookup(
        call: ts.CallExpression,
        callee: ts.PropertyAccessExpression,
    ): boolean {
        if (isDocumentReceiver(this.context, callee.expression))
            return this.isNativeHostUiLookup(call);
        return (
            callee.name.text === "querySelector" ||
            callee.name.text === "closest"
        );
    }

    /** `uiElementMetadata` by lowering the expression in a declined probe. */
    public loweredUiElementMetadata(
        expression: ts.Expression,
    ): UiElementMetadata | undefined {
        let metadata: UiElementMetadata | undefined;
        this.context.probeEmission(() => {
            const element = this.uiElementValue(expression);
            if (element?.kind === "ui-element")
                metadata = { tag: element.uiTag };
            return undefined;
        });
        return metadata;
    }

    /** A browser value naming the primary canvas, which a presentation host lowers to its element. */
    private presentsPrimaryCanvas(value: Value): boolean {
        return (
            this.context.hasPresentationHost() &&
            value.browserValue?.kind === "object" &&
            !!value.browserValue.primaryCanvas
        );
    }

    /** An element value's tag and construction identity, or what its data storage recorded. */
    private trackedUiElementMetadata(value: Value): {
        tag: string | undefined;
        staticId: number | undefined;
    } {
        const stored =
            this.uiElementMetadataByDataStorage.get(value.cpp) ??
            (value.optionalStorageCpp
                ? this.uiElementMetadataByDataStorage.get(
                      value.optionalStorageCpp,
                  )
                : undefined);
        return {
            tag: value.uiTag ?? stored?.tag,
            staticId: value.uiStaticId ?? stored?.staticId,
        };
    }

    public uiCreatedElementTag(expression: ts.Expression): string | undefined {
        const direct = this.uiElementMetadata(expression)?.tag;
        if (direct) return direct;
        if (isDomReceiver(this.context, expression, "HTMLStyleElement"))
            return "style";
        const owner = this.context.unwrap(expression);
        if (!ts.isIdentifier(owner)) return undefined;
        const declaration =
            this.context.symbols.valueSymbol(owner)?.valueDeclaration;
        if (
            !declaration ||
            !ts.isVariableDeclaration(declaration) ||
            !declaration.initializer
        ) {
            return undefined;
        }
        return this.uiCreationTag(declaration.initializer);
    }

    public uiCreationTag(expression: ts.Expression): string | undefined {
        const creation = this.uiCreationCall(expression);
        const tag = creation
            ? this.tryUiStaticString(argumentAt(creation, 0))
            : undefined;
        return tag?.toLowerCase();
    }

    public uiCreationCall(
        expression: ts.Expression,
    ): ts.CallExpression | undefined {
        const initializer = this.context.unwrap(expression);
        return ts.isCallExpression(initializer) &&
            ts.isPropertyAccessExpression(initializer.expression) &&
            initializer.expression.name.text === "createElement" &&
            initializer.arguments.length === 1
            ? initializer
            : undefined;
    }

    /** Whether an expression is already known to produce retained UI state. */
    public isNativeUiValueExpression(expression: ts.Expression): boolean {
        if (this.documentRootTag(expression)) return true;
        if (this.primaryCanvasDataset(expression)) return true;
        const value = this.context.unwrap(expression);
        if (
            ts.isPropertyAccessExpression(value) &&
            value.name.text === "activeElement" &&
            this.context.libraryGlobal(value.expression) === "document"
        )
            return true;
        if (ts.isElementAccessExpression(value)) {
            const dataType = this.context.dataLowerer.dataTypeAt(value);
            return (
                dataType?.kind === "handle" && dataType.handle === "ui-element"
            );
        }
        if (ts.isIdentifier(value)) {
            return (
                this.context.bindings.lookupOptional(value)?.kind ===
                "ui-element"
            );
        }
        if (ts.isPropertyAccessExpression(value)) {
            return this.uiElementMetadata(value) !== undefined;
        }
        if (!ts.isCallExpression(value)) return false;
        // Classifying a lookup must not evaluate its ID argument. The normal
        // call lowerer owns those effects when the expression is reached.
        if (this.isNativeHostUiLookup(value)) return true;
        if (this.uiElementMetadata(value) !== undefined) {
            return true;
        }
        const callee = this.context.unwrap(value.expression);
        const createsElement =
            ts.isPropertyAccessExpression(callee) &&
            (callee.name.text === "createElement" ||
                callee.name.text === "createElementNS") &&
            isDocumentReceiver(this.context, callee.expression) &&
            value.arguments[0] !== undefined &&
            (ts.isStringLiteral(value.arguments[0]) ||
                ts.isNoSubstitutionTemplateLiteral(value.arguments[0]));
        return createsElement || this.isNativeUiHelperCall(value);
    }

    public uiStringCpp(expression: ts.Expression, purpose: string): string {
        const staticValue = this.tryUiStaticString(expression);
        if (staticValue !== undefined) {
            return this.context.cppString(staticValue);
        }
        const value = this.context.dataLowerer.stringReceiver(
            this.context.compileValue(expression),
            expression,
        );
        if (isStringValue(value)) {
            return value.cpp;
        }
        this.context.fail(
            expression,
            `${purpose} requires a string, received ${value.kind}.`,
        );
    }

    public uiAttributeName(expression: ts.Expression): string {
        return this.context.compileStringLiteral(expression);
    }

    public uiStylePropertyName(expression: ts.Expression): string {
        return UiProjection.cssPropertyName(
            this.context.compileStringLiteral(expression),
        );
    }

    private static cssPropertyName(name: string): string {
        return name.startsWith("--")
            ? name
            : name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    }

    private static isCustomStyleProperty(name: string): boolean {
        return /^--[A-Za-z0-9_-]+$/.test(name) && !name.startsWith("--bbl-");
    }

    public tryUiStaticString(expression: ts.Expression): string | undefined {
        try {
            return this.context.evaluator.compileStringLiteral(expression);
        } catch (error) {
            if (error instanceof CompileError) return undefined;
            throw error;
        }
    }

    private collectUiStringParts(
        expression: ts.Expression,
    ): Array<string | ts.Expression> | undefined {
        const parts: Array<string | ts.Expression> = [];
        const collect = (node: ts.Expression): boolean => {
            const value = this.tryUiStaticString(node);
            if (value !== undefined) {
                parts.push(value);
                return true;
            }
            const current = this.context.unwrap(node);
            if (ts.isTemplateExpression(current)) {
                parts.push(current.head.text);
                for (const span of current.templateSpans) {
                    parts.push(span.expression, span.literal.text);
                }
                return true;
            }
            return (
                ts.isBinaryExpression(current) &&
                current.operatorToken.kind === ts.SyntaxKind.PlusToken &&
                collect(current.left) &&
                collect(current.right)
            );
        };
        return collect(expression) ? parts : undefined;
    }

    private uiTemplateSubstitutionCpp(
        expression: ts.Expression,
        purpose: string,
        allowStringFallback = false,
    ): string {
        const logical = this.context.unwrap(expression);
        if (
            allowStringFallback &&
            ts.isBinaryExpression(logical) &&
            logical.operatorToken.kind === ts.SyntaxKind.BarBarToken
        ) {
            const left = this.context.compileValue(logical.left);
            const right = this.context.compileValue(logical.right);
            if (isStringValue(left) && isStringValue(right)) {
                return (
                    `(!std::string(${left.cpp}).empty()` +
                    ` ? std::string(${left.cpp})` +
                    ` : std::string(${right.cpp}))`
                );
            }
        }
        return this.uiTemplateValueCpp(
            this.context.compileValue(expression),
            expression,
            purpose,
        );
    }

    private uiTemplateValueCpp(
        value: Value,
        expression: ts.Expression,
        purpose: string,
    ): string {
        if (value.staticString !== undefined) {
            return this.context.cppString(value.staticString);
        }
        if (value.staticNumber !== undefined) {
            return this.context.cppString(String(value.staticNumber));
        }
        if (value.kind === "number") {
            return `bbl::js::number_to_string(${value.cpp})`;
        }
        if (isStringValue(value)) {
            return value.cpp;
        }
        this.context.fail(
            expression,
            `${purpose} template substitutions must be strings or numbers.`,
        );
    }

    public uiBooleanCpp(expression: ts.Expression, purpose: string): string {
        const value = this.context.compileValue(expression);
        if (
            value.kind === "boolean" ||
            (value.kind === "data" && value.dataType?.kind === "boolean")
        ) {
            return value.cpp;
        }
        this.context.fail(
            expression,
            `${purpose} requires a boolean, received ${value.kind}.`,
        );
    }

    public createUiStaticElement(tag: string): number {
        const id = this.uiElementIds++;
        this.uiStaticElements.set(id, {
            tag,
            classAlternatives: [new EmissionSet()],
            classMayMutateDynamically: false,
            ids: new EmissionSet(),
            children: new EmissionSet(),
            markupChildren: [],
            styles: [""],
            styleShapeKnown: true,
            styleMayMutateDynamically: false,
            mutableClasses: new EmissionSet(),
            classShapeKnown: true,
            childCardinalityKnown: true,
            childShapeKnown: true,
        });
        return id;
    }

    private uiStaticElement(value: Value): UiStaticElement | undefined {
        return value.uiStaticId === undefined
            ? undefined
            : this.uiStaticElements.get(value.uiStaticId);
    }

    private uiStringCandidates(
        expression: ts.Expression,
        budget = 32,
    ): string[] | undefined {
        const exact = this.tryUiStaticString(expression);
        if (exact !== undefined) return [exact];
        const value = this.context.unwrap(expression);
        if (ts.isConditionalExpression(value)) {
            const whenTrue = this.uiStringCandidates(value.whenTrue, budget);
            const whenFalse = this.uiStringCandidates(value.whenFalse, budget);
            if (!whenTrue || !whenFalse) return undefined;
            return [...new EmissionSet([...whenTrue, ...whenFalse])].slice(
                0,
                budget,
            );
        }
        if (
            ts.isBinaryExpression(value) &&
            value.operatorToken.kind === ts.SyntaxKind.PlusToken
        ) {
            const left = this.uiStringCandidates(value.left, budget);
            const right = this.uiStringCandidates(value.right, budget);
            if (!left || !right || left.length * right.length > budget) {
                return undefined;
            }
            return left.flatMap((prefix) =>
                right.map((suffix) => prefix + suffix),
            );
        }
        return undefined;
    }

    private static uiClassSetKey(classes: ReadonlySet<string>): string {
        return [...classes].sort().join("\u0000");
    }

    private setUiClassAlternatives(
        element: UiStaticElement,
        alternatives: readonly ReadonlySet<string>[],
    ): void {
        const unique = new EmissionMap<string, Set<string>>();
        for (const alternative of alternatives) {
            const stored = new EmissionSet(alternative);
            unique.set(UiProjection.uiClassSetKey(stored), stored);
        }
        if (unique.size > 32) {
            writable(element).classShapeKnown = false;
            return;
        }
        writable(element).classAlternatives = [...unique.values()];
    }

    public recordUiStaticAttribute(
        value: Value,
        name: string,
        expression: ts.Expression,
        knownValue?: string,
    ): void {
        const element = this.uiStaticElement(value);
        const candidates =
            knownValue === undefined
                ? this.uiStringCandidates(expression)
                : [knownValue];
        if (!element || !candidates) {
            this.uiUnknownAttributeMutations.push({
                attribute: name as "class" | "id",
                ...(value.uiStaticId === undefined
                    ? {}
                    : { targetId: value.uiStaticId }),
                site: expression,
            });
        }
        if (!element) return;
        if (name === "class") {
            if (!candidates) {
                writable(element).classShapeKnown = false;
                return;
            }
            const alternatives: Set<string>[] = [];
            for (const candidate of candidates) {
                const classes = new EmissionSet<string>();
                for (const token of candidate.split(/\s+/).filter(Boolean)) {
                    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(token)) {
                        classes.add(token);
                    } else {
                        writable(element).classShapeKnown = false;
                    }
                }
                alternatives.push(classes);
            }
            const dynamic = this.uiStaticMutationIsDynamic();
            if (dynamic) writable(element).classMayMutateDynamically = true;
            this.setUiClassAlternatives(
                element,
                dynamic || element.classMayMutateDynamically
                    ? [...element.classAlternatives, ...alternatives]
                    : alternatives,
            );
        } else if (name === "id") {
            if (!candidates) return;
            for (const candidate of candidates) {
                if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(candidate)) {
                    element.ids.add(candidate);
                }
            }
        }
    }

    public recordUiStaticClass(
        value: Value,
        name: string,
        method: "add" | "remove" | "toggle",
        enabled: string,
    ): void {
        const element = this.uiStaticElement(value);
        if (!element) return;
        if (this.uiStaticMutationIsDynamic()) {
            writable(element).classMayMutateDynamically = true;
        }
        element.mutableClasses.add(name);
        const alternatives: Set<string>[] = [...element.classAlternatives];
        for (const current of element.classAlternatives) {
            const mutate = (add: boolean): void => {
                const next = new EmissionSet(current);
                if (add) next.add(name);
                else next.delete(name);
                alternatives.push(next);
            };
            if (
                method === "add" ||
                (method === "toggle" && enabled === "true")
            ) {
                mutate(true);
            } else if (
                method === "remove" ||
                (method === "toggle" && enabled === "false")
            ) {
                mutate(false);
            } else {
                mutate(true);
                mutate(false);
            }
        }
        this.setUiClassAlternatives(element, alternatives);
    }

    private recordUiStaticStyles(
        element: UiStaticElement,
        styles: readonly string[],
    ): void {
        const wasKnown = element.styleShapeKnown;
        const currentMutationIsDynamic = this.uiStaticMutationIsDynamic();
        if (currentMutationIsDynamic) {
            writable(element).styleMayMutateDynamically = true;
        }
        const mayReplaceLater =
            currentMutationIsDynamic || element.styleMayMutateDynamically;
        writable(element).styles = mayReplaceLater
            ? [...new EmissionSet([...element.styles, ...styles])]
            : [...new EmissionSet(styles)];
        writable(element).styleShapeKnown = mayReplaceLater ? wasKnown : true;
    }

    public recordUiStaticStyle(value: Value, style: string): void {
        const element = this.uiStaticElement(value);
        if (!element) return;
        this.recordUiStaticStyles(element, [style]);
    }

    public recordUiUnknownStaticStyle(value: Value): void {
        const element = this.uiStaticElement(value);
        if (!element) return;
        if (this.uiStaticMutationIsDynamic()) {
            writable(element).styleMayMutateDynamically = true;
        }
        writable(element).styleShapeKnown = false;
    }

    private static uiStyleWithProperty(
        style: string,
        name: string,
        value: string,
    ): string {
        const declarations: string[] = [];
        UiProjection.forEachUiStyleDeclaration(style, (declaration) => {
            const colon = declaration.indexOf(":");
            if (
                colon < 0 ||
                UiProjection.cssPropertyName(
                    declaration.slice(0, colon).trim(),
                ) !== name
            ) {
                if (declaration.trim()) declarations.push(declaration);
            }
        });
        declarations.push(`${name}:${value}`);
        return declarations.join(";");
    }

    private recordUiStaticStyleProperty(
        value: Value,
        name: string,
        expression: ts.Expression,
        knownValue?: string,
    ): void {
        const element = this.uiStaticElement(value);
        if (!element) return;
        const staticValue = knownValue ?? this.tryUiStaticString(expression);
        const updated = element.styles.map((style) =>
            UiProjection.uiStyleWithProperty(
                style,
                name,
                staticValue ?? "__bbl_dynamic_style_value__",
            ),
        );
        const currentMutationIsDynamic = this.uiStaticMutationIsDynamic();
        if (currentMutationIsDynamic) {
            writable(element).styleMayMutateDynamically = true;
        }
        writable(element).styles =
            currentMutationIsDynamic || element.styleMayMutateDynamically
                ? [...new EmissionSet([...element.styles, ...updated])]
                : [...new EmissionSet(updated)];
    }

    /** A child joining `parent`; one that does not join last leaves the child order unknown. */
    public recordUiStaticAppend(
        parent: Value,
        child: Value,
        last = true,
    ): void {
        const parentElement = this.uiStaticElement(parent);
        if (!parentElement) return;
        if (!last) writable(parentElement).childShapeKnown = false;
        if (child.uiStaticId === undefined) {
            writable(parentElement).childCardinalityKnown = false;
            writable(parentElement).childShapeKnown = false;
            return;
        }
        if (this.uiStaticMutationIsDynamic()) {
            parentElement.children.add(child.uiStaticId);
            writable(parentElement).childCardinalityKnown = false;
            for (const element of this.uiStaticElements.values()) {
                if (element.children.has(child.uiStaticId)) {
                    writable(element).childCardinalityKnown = false;
                }
            }
            return;
        }
        for (const element of this.uiStaticElements.values()) {
            element.children.delete(child.uiStaticId);
        }
        const rootIndex = this.uiStaticRootOrder.indexOf(child.uiStaticId);
        if (rootIndex >= 0) this.uiStaticRootOrder.splice(rootIndex, 1);
        parentElement.children.add(child.uiStaticId);
    }

    public recordUiStaticReplaceChildren(parent: Value): void {
        const element = this.uiStaticElement(parent);
        if (!element) return;
        if (this.uiStaticMutationIsDynamic()) {
            writable(element).childCardinalityKnown = false;
            return;
        }
        element.children.clear();
        writable(element).markupChildren = [];
    }

    private uiStaticMutationIsDynamic(): boolean {
        return (
            this.context.isInRuntimeControlFlow() ||
            this.context.isInFrameCallback()
        );
    }

    public recordUiStaticRootAppend(child: Value): void {
        const id = child.uiStaticId;
        const element = this.uiStaticElement(child);
        if (id === undefined || !element || this.uiStaticMutationIsDynamic()) {
            return;
        }
        const previous = this.uiStaticRootOrder.indexOf(id);
        if (previous >= 0) this.uiStaticRootOrder.splice(previous, 1);
        const body = this.uiDocumentRootIds.get("body");
        if (body !== undefined) {
            const children = this.uiStaticElements.get(body)!.children;
            children.delete(id);
            children.add(id);
            return;
        }
        this.uiStaticRootOrder.push(id);
    }

    public recordUiStaticRemoval(element: Value): void {
        const id = element.uiStaticId;
        const staticElement = this.uiStaticElement(element);
        if (id === undefined || !staticElement) {
            return;
        }
        const dynamic = this.uiStaticMutationIsDynamic();
        for (const parent of this.uiStaticElements.values()) {
            if (!parent.children.has(id)) continue;
            if (dynamic) writable(parent).childCardinalityKnown = false;
            else parent.children.delete(id);
        }
        if (dynamic) {
            if (staticElement.tag === "style") {
                this.uiConditionallyRemovedStyles.add(id);
            }
            return;
        }
        const rootIndex = this.uiStaticRootOrder.indexOf(id);
        if (rootIndex >= 0) this.uiStaticRootOrder.splice(rootIndex, 1);
    }

    private recordUiStaticMarkup(
        ownerId: number | undefined,
        children: UiStaticMarkupNode[],
    ): void {
        if (ownerId === undefined) return;
        const owner = this.uiStaticElements.get(ownerId);
        if (owner) writable(owner.markupChildren).push(...children);
    }

    /**
     * The reviewed retained-UI style surface (AP-3). Every property here was
     * reached by the pinned applications, the audited host companions, or the
     * registered corpus scenes, and lowers with browser-equivalent meaning
     * (directly or through the compatibility rewrites below). A property in
     * none of the four sets refuses at generation naming itself, so an
     * unreviewed declaration can never silently drop into the projection.
     */
    private static readonly PROJECTED_UI_STYLE_PROPERTIES =
        new EmissionSet<string>([
            ...uiLogicalSpacingProperties,
            "appearance",
            "-webkit-appearance",
            "align-content",
            "align-items",
            "align-self",
            "animation",
            "background",
            "background-color",
            "background-clip",
            "background-image",
            "background-size",
            "background-position",
            "background-repeat",
            "background-origin",
            "background-attachment",
            "border",
            "border-color",
            "border-top",
            "border-right",
            "border-bottom",
            "border-left",
            "border-width",
            "border-top-width",
            "border-right-width",
            "border-bottom-width",
            "border-left-width",
            "border-top-color",
            "border-right-color",
            "border-bottom-color",
            "border-left-color",
            "border-image",
            "border-radius",
            "box-sizing",
            "box-shadow",
            "bottom",
            "color",
            "clip",
            "clear",
            "column-gap",
            "cursor",
            "display",
            "grid-template-columns",
            "grid-column",
            "grid-row",
            "grid-auto-columns",
            "grid-auto-rows",
            "isolation",
            "container-type",
            "grid-template-rows",
            "flex",
            "flex-basis",
            "flex-direction",
            "flex-flow",
            "flex-grow",
            "flex-shrink",
            "flex-wrap",
            "filter",
            "float",
            "font",
            "font-family",
            "font-size",
            "font-style",
            "font-weight",
            "gap",
            "height",
            "inset",
            "justify-content",
            "justify-items",
            "justify-self",
            "left",
            "letter-spacing",
            "line-height",
            "margin",
            "margin-bottom",
            "margin-left",
            "margin-right",
            "margin-top",
            "max-height",
            "max-width",
            "min-height",
            "min-width",
            "object-fit",
            "opacity",
            "overflow",
            "overflow-x",
            "overflow-y",
            "overflow-wrap",
            "overscroll-behavior",
            "overscroll-behavior-x",
            "overscroll-behavior-y",
            "padding",
            "padding-bottom",
            "padding-left",
            "padding-right",
            "padding-top",
            "pointer-events",
            "place-items",
            "position",
            "right",
            "row-gap",
            "resize",
            "scale",
            "scrollbar-gutter",
            "scrollbar-width",
            "scrollbar-color",
            "text-align",
            "text-shadow",
            "text-transform",
            "text-overflow",
            "top",
            "transform",
            "transform-origin",
            "transition",
            "vertical-align",
            "visibility",
            "white-space",
            "word-break",
            "word-wrap",
            "width",
            "z-index",
        ]);

    /**
     * Reached hints with no rendering semantics in the retained projection:
     * `will-change`/`touch-action`/`user-select` describe browser scrolling,
     * selection, and compositor behaviour the native input path does not
     * have, and `image-rendering` is superseded by the sampling intent the
     * retained canvas commands already carry per blit.
     */
    private static readonly PRESENTATION_KEYWORDS: ReadonlyMap<
        string,
        readonly string[]
    > = new Map([
        ["visibility", ["visible", "hidden"]],
        [
            "vertical-align",
            [
                "baseline",
                "middle",
                "sub",
                "super",
                "text-top",
                "text-bottom",
                "top",
                "bottom",
            ],
        ],
        ["-webkit-tap-highlight-color", ["transparent"]],
        ["text-transform", ["none", "uppercase", "lowercase", "capitalize"]],
        ["text-overflow", ["clip", "ellipsis"]],
        ["font-style", ["normal", "italic"]],
        ["scrollbar-gutter", ["auto", "stable"]],
        ["container-type", ["normal", "inline-size"]],
        ["overscroll-behavior-x", ["auto", "contain", "none"]],
        ["overscroll-behavior-y", ["auto", "contain", "none"]],
        ["appearance", ["auto", "none"]],
        ["-webkit-appearance", ["auto", "none"]],
        ["-webkit-user-drag", ["none"]],
        ["list-style", ["none"]],
        ["list-style-type", ["none"]],
        ["justify-items", ["start", "end", "center", "stretch"]],
        ["justify-self", ["auto", "start", "end", "center", "stretch"]],
    ]);

    private static readonly INERT_UI_STYLE_PROPERTIES = new EmissionSet<string>(
        [
            "-webkit-user-select",
            "-webkit-tap-highlight-color",
            "-webkit-user-drag",
            "image-rendering",
            "list-style",
            "list-style-type",
            "touch-action",
            "user-select",
            "will-change",
        ],
    );

    /**
     * Reached properties the projection accepts WITHOUT a native rendering:
     * box shadows need saved layer textures and inverse masks, unsupported
     * backdrop functions have no projection, and RmlUi has no numeral
     * variants. Each acceptance is recorded per scene in the
     * `substituted-ui-runtime` fidelity adaptation.
     */
    private static readonly DEGRADED_UI_STYLE_PROPERTIES =
        new EmissionSet<string>([
            "-webkit-backdrop-filter",
            "backdrop-filter",
            "font-feature-settings",
            "font-variant-numeric",
        ]);

    /**
     * CSS admits two transform-origin keywords in either order; RmlUi's
     * shorthand reads the horizontal one first.
     */
    private static readonly UI_TRANSFORM_ORIGIN_KEYWORDS =
        /^\s*(left|center|right|top|bottom)\s+(left|center|right|top|bottom)(\s+[^\s]+)?\s*$/i;

    private static canonicalUiTransformOrigin(value: string): string {
        const keywords = UiProjection.UI_TRANSFORM_ORIGIN_KEYWORDS.exec(value);
        if (!keywords) return value;
        const [, first, second, depth] = keywords;
        return /^(?:top|bottom)$/i.test(first!) ||
            /^(?:left|right)$/i.test(second!)
            ? `${second!} ${first!}${depth ?? ""}`
            : value;
    }

    /** font-feature-settings naming only the numeral variants font-variant-numeric covers. */
    private static readonly UI_NUMERAL_FEATURES = (() => {
        const feature = String.raw`["'](?:tnum|lnum|pnum|onum)["'](?:\s+(?:on|off|0|1))?`;
        return new RegExp(
            String.raw`^(?:normal|${feature}(?:\s*,\s*${feature})*)$`,
        );
    })();

    private static supportedBackdropFilter(value: string): boolean {
        return /^(?:none|blur\(\s*(?:\d+(?:\.\d+)?|\.\d+)px\s*\))$/i.test(
            value.trim(),
        );
    }

    /**
     * Properties consumed by the gradient-text projection (the reached
     * `background-clip:text` shimmer combination). Outside that combination
     * nothing lowers them, so they refuse rather than silently dropping.
     */
    private static readonly GRADIENT_TEXT_UI_STYLE_PROPERTIES =
        new EmissionSet<string>([
            "-webkit-background-clip",
            "-webkit-text-stroke",
            "background-clip",
            "background-size",
            "filter",
        ]);

    /** The one gradient-text `filter` form the projection consumes. */
    private static readonly GRADIENT_TEXT_SHADOW_PATTERN =
        /\bfilter\s*:\s*drop-shadow\(\s*([^\s]+)\s+([^\s]+)\s+(?:[^\s]+\s+)?(rgba?\([^)]*\)|#[0-9a-f]{3,8})\s*\)/i;

    /** The one gradient-text stroke form the projection consumes. */
    private static readonly GRADIENT_TEXT_STROKE_PATTERN =
        /-webkit-text-stroke\s*:\s*([^\s;]+)\s+([^;]+)/i;

    public static readonly UI_IMPLEMENTATION_TAGS = new EmissionSet([
        "bbl-grid-children",
        "bbl-grid-track",
    ]);

    /** The gradient-text projection trigger both the audit and the
     *  projection test on one declaration list. */
    private static readonly GRADIENT_TEXT_CLIP_PATTERN =
        /(?:-webkit-)?background-clip\s*:\s*text/i;

    /** The gradient-text background half of the same combination; group 1
     *  is the gradient's argument list for the projection's colour reads. */
    private static readonly GRADIENT_TEXT_BACKGROUND_PATTERN =
        /\bbackground\s*:\s*linear-gradient\(([^;]*)\)/i;

    /**
     * Walks one inline declaration list, calling `visit` for each
     * declaration split at top-level semicolons only — a `;` inside
     * strings or nested blocks (`url(...)`, a gradient argument) does not end a
     * declaration. The one segmentation authority for the audit and the
     * projection.
     */
    private static forEachUiStyleDeclaration(
        value: string,
        visit: (declaration: string) => void,
    ): void {
        const closingBrackets: string[] = [];
        let quote = "";
        let start = 0;
        for (let index = 0; index <= value.length; index++) {
            const character = value[index];
            if (
                index === value.length ||
                (!quote && closingBrackets.length === 0 && character === ";")
            ) {
                visit(value.slice(start, index));
                start = index + 1;
            } else if (character === "\\") index++;
            else if (quote) {
                if (character === quote) quote = "";
            } else if (character === "/" && value[index + 1] === "*") {
                const end = value.indexOf("*/", index + 2);
                index = end < 0 ? value.length - 1 : end + 1;
            } else if (character === "'" || character === '"')
                quote = character;
            else if (
                character === "(" ||
                character === "[" ||
                character === "{"
            )
                closingBrackets.push(
                    character === "(" ? ")" : character === "[" ? "]" : "}",
                );
            else if (character === closingBrackets.at(-1))
                closingBrackets.pop();
        }
    }

    /** Placeholder for a `;` inside parentheses while the projection's
     *  declaration-scoped rewrites run; restored on the way out. Never
     *  appears in authored CSS. */
    private static readonly UI_MASKED_SEMICOLON = "\u0001";

    /**
     * Style properties accepted with a recorded rendering degradation, for
     * this scene's `substituted-ui-runtime` fidelity adaptation.
     */
    public readonly uiDegradedStyleProperties = new EmissionSet<string>();

    /**
     * Reviewed scoped selectors retained in typed form instead of widened to
     * global rules, recorded in the `substituted-ui-runtime` adaptation.
     */
    public readonly uiScopedSheetSelectors = new EmissionSet<string>();

    /** Construction-site topology used only to prove bounded DOM projections. */
    private readonly uiStaticElements = new EmissionMap<
        number,
        UiStaticElement
    >();

    /** Static element metadata assigned into nullable UI-handle storage. */
    public readonly uiElementMetadataByDataStorage = new EmissionMap<
        string,
        { tag: string; staticId?: number }
    >();

    /** Most recently lowered identity for a createElement expression. */
    public readonly uiStaticIdsByCreation = new EmissionWeakMap<
        ts.CallExpression,
        number
    >();

    public readonly uiPendingClassQueries: UiPendingClassQuery[] =
        emissionArray([]);

    public readonly uiUnknownClassMutations: UiUnknownClassMutation[] =
        emissionArray([]);

    private readonly uiUnknownAttributeMutations: UiUnknownAttributeMutation[] =
        emissionArray([]);

    /** Final direct-document order for statically sequenced root mutations. */
    private readonly uiStaticRootOrder: number[] = emissionArray([]);
    private readonly uiDocumentRootIds = new EmissionMap<string, number>();
    private readonly uiConditionallyRemovedStyles = new EmissionSet<number>();

    @journaled private accessor uiElementIds = 0;

    /**
     * Logical sizes that reached `scale()` calls map exactly onto a retained
     * canvas backing store (`scale(c.width / X, c.height / Y)`), which is
     * what proves a later statically-sized `clearRect(0, 0, X, Y)` covers
     * the full surface.
     */
    private readonly uiCanvasFullClearSizes = new EmissionSet<string>();

    /**
     * Statically-assigned retained-canvas backing sizes, keyed by the
     * canvas's generation identity (`uiCanvasId` — the element and its
     * 2D-context views spell different C++ locals but share the id): the
     * other statically-provable full-surface `clearRect` shape. `pairs`
     * holds every (width, height) state the static assignments provably
     * put THAT canvas through, so a width recorded from one canvas never
     * combines with a height from another into a surface no canvas ever
     * had.
     */
    private readonly uiCanvasStaticSizes = new EmissionMap<
        number,
        {
            readonly width?: number;
            readonly height?: number;
            readonly pairs: Set<string>;
        }
    >();

    /** Mints `uiCanvasId` for each created retained canvas element. */
    @journaled public accessor uiCanvasIds = 0;

    /** Retained canvases by element id: the primary canvas and host canvases. */
    private readonly retainedCanvasIds = new EmissionMap<string, number>();

    private retainedCanvasId(id: string): number {
        let canvasId = this.retainedCanvasIds.get(id);
        if (canvasId === undefined) {
            canvasId = this.uiCanvasIds++;
            this.retainedCanvasIds.set(id, canvasId);
        }
        return canvasId;
    }

    public refuseEngineCanvasContext(site: ts.Node): never {
        return this.context.fail(
            site,
            "The primary canvas already belongs to a Babylon engine; it cannot also acquire a Canvas2D context.",
        );
    }

    /**
     * A host lookup of a canvas the program asks for a 2D context finds a
     * retained canvas, one per id; a canvas handed to createEngine cannot be
     * drawn on as well.
     */
    public hostCanvas(
        id: string,
        tag: string | undefined,
        site: ts.Node,
    ): Pick<Value, "uiCanvas" | "uiCanvasId"> {
        if (tag !== "canvas" || !canvasContextIds(this.context).has(id))
            return {};
        if (engineCanvasIds(this.context).has(id))
            this.refuseEngineCanvasContext(site);
        return { uiCanvas: true, uiCanvasId: this.retainedCanvasId(id) };
    }

    private uiStyleRefusal(
        site: ts.Node | undefined,
        property: string,
        reason: string,
    ): never {
        const message =
            `Retained UI style property '${property}' is not lowered: ` +
            `${reason}. The projected surface is ` +
            `${[...UiProjection.PROJECTED_UI_STYLE_PROPERTIES].join(", ")}; ` +
            "accepted with a recorded degradation: " +
            `${[...UiProjection.DEGRADED_UI_STYLE_PROPERTIES].join(", ")}; ` +
            "accepted inert hints: " +
            `${[...UiProjection.INERT_UI_STYLE_PROPERTIES].join(", ")}.`;
        if (site) this.context.fail(site, message);
        this.context.failAtFile(message);
    }

    /**
     * Enforce the reviewed style surface over one static CSS declaration
     * list (AP-3): a projected property lowers, a reached degraded property
     * is accepted and recorded for the scene's `substituted-ui-runtime`
     * adaptation, an inert hint passes through, and anything else refuses at
     * generation naming the property. Values may be runtime substitutions;
     * only the static property names are policed here.
     */
    private auditUiStyleDeclarations(
        value: string,
        site: ts.Node | undefined,
    ): void {
        const clipsGradientToText =
            UiProjection.GRADIENT_TEXT_CLIP_PATTERN.test(value);
        const hasGradientBackground =
            UiProjection.GRADIENT_TEXT_BACKGROUND_PATTERN.test(value);
        UiProjection.forEachUiStyleDeclaration(value, (declaration) => {
            const colon = declaration.indexOf(":");
            if (colon < 0) {
                // Empty segments between semicolons; a declaration is only
                // a declaration once it names a property.
                return;
            }
            const property = UiProjection.cssPropertyName(
                declaration.slice(0, colon).trim(),
            );
            const literalValue = declaration
                .slice(colon + 1)
                .trim()
                .toLowerCase();
            if (property.length === 0) return;
            if (UiProjection.isCustomStyleProperty(property)) return;
            if (
                property === "place-items" &&
                !/^(?:start|end|center|stretch)(?:\s+(?:start|end|center|stretch))?$/.test(
                    literalValue,
                )
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "only one or two start, end, center or stretch keywords are represented",
                );
            }
            const keywords = UiProjection.PRESENTATION_KEYWORDS.get(property);
            if (keywords && !keywords.includes(literalValue)) {
                this.uiStyleRefusal(
                    site,
                    property,
                    `only ${keywords.join(", ")} are represented`,
                );
            }
            const background = supportedUiImageBackground(
                property,
                literalValue,
            );
            if (background !== undefined && !clipsGradientToText) {
                if (!background)
                    this.uiStyleRefusal(
                        site,
                        property,
                        "only a single raster image with auto, contain, cover or zero sizing and centered or default positioning is represented",
                    );
                return;
            }
            if (property === "scale") {
                if (
                    !/^(?:none|[+]?(?:\d+(?:\.\d*)?|\.\d+))$/.test(literalValue)
                )
                    this.uiStyleRefusal(
                        site,
                        property,
                        "only a nonnegative uniform numeric scale is represented",
                    );
                return;
            }
            if (property === "clip") {
                if (
                    !/^(?:auto|rect\(\s*0(?:px)?\s*,\s*0(?:px)?\s*,\s*0(?:px)?\s*,\s*0(?:px)?\s*\))$/.test(
                        literalValue,
                    )
                )
                    this.uiStyleRefusal(
                        site,
                        property,
                        "only auto or an empty rectangle is represented",
                    );
                return;
            }
            if (
                /^border-(?:top|right|bottom|left)$/.test(property) &&
                !/^(?:none|0|(?:0|\d+(?:\.\d+)?(?:px|em|rem))\s+solid\s+(?:#[0-9a-f]{3,8}|rgba?\([^;]+\)|[a-z]+))$/.test(
                    literalValue,
                )
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "only none, zero or a literal solid width and color are represented",
                );
            }
            if (
                /^border(?:-(?:top|right|bottom|left))?-width$/.test(
                    property,
                ) &&
                (!/^(?:0|\d+(?:\.\d+)?(?:px|em|rem))(?:\s+(?:0|\d+(?:\.\d+)?(?:px|em|rem))){0,3}$/.test(
                    literalValue,
                ) ||
                    (property !== "border-width" && /\s/.test(literalValue)))
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "only nonnegative literal border widths are represented",
                );
            }
            if (
                property === "transform-origin" &&
                !/^(?:(?:left|center|right|top|bottom)|(?:0|[+-]?\d+(?:\.\d+)?(?:px|em|rem|%))|(?:left|center|right|0|[+-]?\d+(?:\.\d+)?(?:px|em|rem|%))\s+(?:top|center|bottom|0|[+-]?\d+(?:\.\d+)?(?:px|em|rem|%))(?:\s+(?:0|[+-]?\d+(?:\.\d+)?(?:px|em|rem)))?)$/.test(
                    UiProjection.canonicalUiTransformOrigin(literalValue),
                )
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "only literal horizontal/vertical origins with an optional depth are represented",
                );
            }
            if (
                property === "object-fit" &&
                !/^(?:fill|contain|cover|none|scale-down)$/.test(literalValue)
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "only fill, contain, cover, none and scale-down are represented",
                );
            }
            if (supportedUiLayoutValue(property, literalValue) === false) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "the value requires layout outside the supported literal flex and box forms",
                );
            }
            if (
                (property === "overflow-wrap" || property === "word-wrap") &&
                !/^(?:normal|break-word|anywhere)$/.test(literalValue)
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "only normal, break-word and anywhere wrapping are represented",
                );
            }
            if (
                property === "word-break" &&
                !/^(?:normal|break-word|break-all)$/.test(literalValue)
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "only normal, break-word and break-all are represented",
                );
            }
            if (
                property === "overscroll-behavior" &&
                !/^(?:auto|contain|none)(?:\s+(?:auto|contain|none))?$/.test(
                    literalValue,
                )
            )
                this.uiStyleRefusal(
                    site,
                    property,
                    "one or two auto, contain or none keywords are represented",
                );
            if (
                property === "scrollbar-width" &&
                !/^(?:auto|thin|none)$/.test(literalValue)
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "only auto, thin and none are represented",
                );
            }
            if (property === "scrollbar-color" && literalValue !== "auto") {
                const color = "(?:#[0-9a-f]{3,8}|rgba?\\([^()]+\\)|[a-z]+)";
                if (
                    !new RegExp(`^${color}\\s+${color}$`).test(literalValue) ||
                    /\b(?:currentcolor|inherit|initial|unset|revert)\b/.test(
                        literalValue,
                    )
                ) {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "only auto or two literal RGB, hex or named colors are represented",
                    );
                }
            }
            if (
                property === "background-clip" &&
                /^(?:inherit|border-box|padding-box|content-box)$/.test(
                    literalValue,
                )
            ) {
                if (
                    /gradient\(/i.test(value) ||
                    /(?:^|;)\s*background(?:-image)?\s*:[^;]*url\(/i.test(value)
                ) {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "box clipping currently applies to solid backgrounds",
                    );
                }
                return;
            }
            if (
                property === "box-sizing" &&
                !/^(?:content-box|border-box)$/.test(literalValue)
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "only content-box and border-box are represented",
                );
            }
            if (
                property === "resize" &&
                literalValue !== "vertical" &&
                literalValue !== "none"
            )
                this.uiStyleRefusal(
                    site,
                    property,
                    "only vertical or none form-control resizing is represented",
                );
            if (property === "mix-blend-mode") {
                if (literalValue !== "difference") {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "only the reached difference-mode crosshair is accepted as a recorded degradation",
                    );
                }
                this.uiDegradedStyleProperties.add(property);
                return;
            }
            if (property === "box-shadow") {
                if (supportedUiBoxShadow(literalValue)) return;
                this.uiStyleRefusal(
                    site,
                    property,
                    "only none or pixel shadow lists with literal or custom-property colors and nonnegative blur are represented",
                );
            }
            if (
                (property === "backdrop-filter" ||
                    property === "-webkit-backdrop-filter") &&
                UiProjection.supportedBackdropFilter(literalValue)
            ) {
                return;
            }
            if (
                property === "font-feature-settings" &&
                !UiProjection.UI_NUMERAL_FEATURES.test(literalValue)
            )
                this.uiStyleRefusal(
                    site,
                    property,
                    "only normal and the numeral variant features tnum, lnum, pnum and onum are accepted, with a recorded degradation",
                );
            if (UiProjection.DEGRADED_UI_STYLE_PROPERTIES.has(property)) {
                this.uiDegradedStyleProperties.add(property);
                return;
            }
            if (property === "outline") {
                if (literalValue === "none") return;
                if (
                    /^(?:\d+(?:\.\d+)?px solid (?:#[0-9a-f]{3,8}|rgba?\([^;]+\)|[a-z]+)|(?:#[0-9a-f]{3,8}|rgba?\([^;]+\)|[a-z]+) solid \d+(?:\.\d+)?px)$/.test(
                        literalValue,
                    )
                )
                    return;
                this.uiStyleRefusal(
                    site,
                    property,
                    "outline requires none or a solid pixel-width color",
                );
            }
            if (
                property === "outline-offset" &&
                /^\d+(?:\.\d+)?px$/.test(literalValue)
            )
                return;
            if (UiProjection.INERT_UI_STYLE_PROPERTIES.has(property)) return;
            if (property === "filter" && !clipsGradientToText) {
                if (!supportedUiFilter(declaration.slice(colon + 1))) {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "only color adjustments, pixel blur and drop shadows with bounded scalar/px math and colors are represented",
                    );
                }
                return;
            }
            if (UiProjection.GRADIENT_TEXT_UI_STYLE_PROPERTIES.has(property)) {
                if (!clipsGradientToText) {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "it is consumed only by the gradient-text " +
                            "projection, which needs background-clip:text " +
                            "in the same declaration list",
                    );
                }
                if (
                    (property === "background-clip" ||
                        property === "-webkit-background-clip") &&
                    !hasGradientBackground
                ) {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "the gradient-text projection needs a " +
                            "linear-gradient background beside " +
                            "background-clip:text",
                    );
                }
                if (
                    property === "filter" &&
                    !UiProjection.GRADIENT_TEXT_SHADOW_PATTERN.test(value)
                ) {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "only the gradient-text drop-shadow(x y color) " +
                            "form is consumed",
                    );
                }
                if (
                    property === "-webkit-text-stroke" &&
                    !UiProjection.GRADIENT_TEXT_STROKE_PATTERN.test(value)
                ) {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "only the gradient-text 'width color' stroke " +
                            "form is consumed",
                    );
                }
                return;
            }
            if (
                (property === "grid-template-columns" ||
                    property === "grid-template-rows" ||
                    property === "grid-auto-columns" ||
                    property === "grid-auto-rows") &&
                !supportedUiGridTracks(
                    literalValue,
                    property.startsWith("grid-auto-"),
                )
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "expected finite auto/px/fr or minmax(auto or px, auto/px/fr) tracks, with bounded repeat only for explicit tracks",
                );
            }
            if (
                (property === "grid-column" || property === "grid-row") &&
                !supportedUiGridPlacement(literalValue)
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "expected auto, nonzero numeric lines, or positive spans, bounded to 256 tracks per axis",
                );
            }
            if (
                property === "isolation" &&
                !/^(?:auto|isolate)$/.test(literalValue.trim().toLowerCase())
            ) {
                this.uiStyleRefusal(site, property, "expected auto or isolate");
            }
            if (UiProjection.PROJECTED_UI_STYLE_PROPERTIES.has(property)) {
                return;
            }
            this.uiStyleRefusal(
                site,
                property,
                "it is outside the reviewed retained-UI surface",
            );
        });
    }

    /**
     * The same reviewed-surface enforcement for one `style.<property>`
     * write or read, where the CSS name is static and the value may be a
     * runtime string.
     */
    public auditUiStylePropertyName(cssName: string, site: ts.Node): void {
        cssName = UiProjection.cssStylePropertyName(cssName);
        if (UiProjection.isCustomStyleProperty(cssName)) return;
        if (UiProjection.DEGRADED_UI_STYLE_PROPERTIES.has(cssName)) {
            this.uiDegradedStyleProperties.add(cssName);
            return;
        }
        if (
            UiProjection.INERT_UI_STYLE_PROPERTIES.has(cssName) ||
            UiProjection.PROJECTED_UI_STYLE_PROPERTIES.has(cssName)
        ) {
            return;
        }
        this.uiStyleRefusal(
            site,
            cssName,
            "it is outside the reviewed retained-UI surface",
        );
    }

    /**
     * True when the expression reads a retained canvas's backing size on
     * the given axis -- directly (`canvas.width`), or through one `const`
     * alias of such a read (`const w = this._canvas.width`), which are the
     * reached shapes. The proof is the compiled value itself: a retained
     * canvas dimension always lowers to `bbl::ui_canvas_<axis>(...)`, so
     * aliasing of the canvas handle cannot defeat it.
     */
    private isUiCanvasSizeRead(
        expression: ts.Expression,
        axis: "width" | "height",
    ): boolean {
        let target = this.context.unwrap(expression);
        if (ts.isIdentifier(target)) {
            // The alias the read's own scope declares: its initializer is
            // compiled here, so an import's is not one to follow.
            const declaration = declaredSymbol(
                this.context.checker,
                target,
            )?.valueDeclaration;
            if (
                declaration &&
                ts.isVariableDeclaration(declaration) &&
                declaration.initializer &&
                (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !==
                    0
            ) {
                target = this.context.unwrap(declaration.initializer);
            }
        }
        if (
            !ts.isPropertyAccessExpression(target) ||
            target.name.text !== axis
        ) {
            return false;
        }
        const value = this.context.compileValue(target);
        return (
            value.kind === "number" &&
            value.cpp.startsWith(`bbl::ui_canvas_${axis}(`)
        );
    }

    /**
     * A reached `scale(c.width / X, c.height / Y)` maps the logical size
     * (X, Y) exactly onto the canvas backing store; remember it so a later
     * statically-sized `clearRect(0, 0, X, Y)` is provably a full-surface
     * clear (the racer minimap's shape). The record is compilation-global
     * rather than per-canvas because the retained clear is full-surface
     * regardless; the check exists to catch an authored partial clear, not
     * to re-derive canvas identity through aliases it cannot track.
     */
    public recordUiCanvasLogicalScale(call: ts.CallExpression): void {
        if (call.arguments.length !== 2) return;
        const logical = (
            argument: ts.Expression,
            axis: "width" | "height",
        ): number | undefined => {
            const expression = this.context.unwrap(argument);
            if (
                !ts.isBinaryExpression(expression) ||
                expression.operatorToken.kind !== ts.SyntaxKind.SlashToken ||
                !this.isUiCanvasSizeRead(expression.left, axis)
            ) {
                return undefined;
            }
            const divisor = this.context.compileValue(
                expression.right,
            ).staticNumber;
            return divisor !== undefined && divisor > 0 ? divisor : undefined;
        };
        const width = logical(argumentAt(call, 0), "width");
        const height = logical(argumentAt(call, 1), "height");
        if (width !== undefined && height !== undefined) {
            this.uiCanvasFullClearSizes.add(`${width}x${height}`);
        }
    }

    /**
     * The retained Canvas2D clear is full-surface: the PAL drops the whole
     * draw list and ignores the rect (`docs/ui.md` Limits). Accept only
     * calls provably equal to the full surface -- origin statically (0, 0)
     * and extents that read the canvas's own width/height (directly or
     * through a const alias), or a statically-sized rect a reached
     * `scale()` maps exactly onto the backing store -- and refuse anything
     * else at generation, so a partial clear can never silently become a
     * full one (AP-2).
     */
    public expectUiCanvasFullSurfaceClear(
        call: ts.CallExpression,
        canvasId: number | undefined,
    ): void {
        if (call.arguments.length !== 4) return;
        const refuse = (shape: string): never =>
            this.context.fail(
                call,
                "Retained Canvas2D clearRect is lowered only as a " +
                    `full-surface clear, and ${shape}. Clear (0, 0, ` +
                    "canvas.width, canvas.height) -- or the logical size " +
                    "a reached scale() maps onto the backing store.",
            );
        for (const index of [0, 1]) {
            const origin = this.context.compileValue(
                argumentAt(call, index),
            ).staticNumber;
            if (origin !== 0) {
                refuse(
                    `argument ${index + 1} is not statically 0, so the ` +
                        "rect origin is not provably the surface origin",
                );
            }
        }
        if (
            this.isUiCanvasSizeRead(argumentAt(call, 2), "width") &&
            this.isUiCanvasSizeRead(argumentAt(call, 3), "height")
        ) {
            return;
        }
        const width = this.context.compileValue(
            argumentAt(call, 2),
        ).staticNumber;
        const height = this.context.compileValue(
            argumentAt(call, 3),
        ).staticNumber;
        if (width !== undefined && height !== undefined) {
            if (this.uiCanvasFullClearSizes.has(`${width}x${height}`)) {
                return;
            }
            // Only a (width, height) pair the static assignments put THIS
            // canvas through proves the rect covers its surface; matching
            // one canvas's width with another's height proves nothing.
            if (
                canvasId !== undefined &&
                this.uiCanvasStaticSizes
                    .get(canvasId)
                    ?.pairs.has(`${width}x${height}`)
            ) {
                return;
            }
            refuse(
                `the static rect ${width}x${height} is neither a ` +
                    "backing size statically assigned to this canvas " +
                    "nor a logical size a reached scale() maps onto one",
            );
        }
        refuse(
            "the extent arguments are not reads of the canvas's own " +
                "width and height",
        );
    }

    /** CSSStyleDeclaration camelCase to the CSS spelling consumed by RmlUi. */
    public nativeUiStyleProperty(property: string): string {
        const cssName = UiProjection.cssStylePropertyName(property);
        if (cssName.startsWith("--")) return cssName;
        if (cssName === "webkit-appearance" || cssName === "-webkit-appearance")
            return "appearance";
        return cssName === "background"
            ? "--bbl-background-color"
            : cssName === "word-wrap"
              ? "overflow-wrap"
              : nativeUiImageProperty(cssName);
    }

    private static cssStylePropertyName(property: string): string {
        if (property === "cssFloat") return "float";
        const css = property.startsWith("--")
            ? property
            : property.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
        return css.startsWith("webkit-") ? `-${css}` : css;
    }

    private static readonly UI_SHORTHAND_RESETS: ReadonlyMap<
        string,
        readonly (readonly [string, string])[]
    > = new Map([
        [
            "background",
            [
                ["background-clip", "border-box"],
                ["background-image", "none"],
                ["background-size", "auto"],
                ["background-position", "0% 0%"],
                ["background-repeat", "repeat"],
                ["background-origin", "padding-box"],
                ["background-attachment", "scroll"],
            ],
        ],
        ["border", [["border-image", "none"]]],
    ]);

    private static uiShorthandResetStyle(property: string): string {
        return (UiProjection.UI_SHORTHAND_RESETS.get(property) ?? [])
            .map(([name, value]) => `${name}:${value};`)
            .join("");
    }

    private lowerUiTextShadow(value: string): string | undefined {
        const shadows: string[] = [];
        let start = 0;
        let depth = 0;
        for (let index = 0; index <= value.length; index++) {
            const character = value[index];
            if (character === "(") depth++;
            if (character === ")") depth--;
            if (index !== value.length && (character !== "," || depth > 0)) {
                continue;
            }
            shadows.push(value.slice(start, index).trim());
            start = index + 1;
        }

        const length = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:px|rem)?`;
        const color = String.raw`(?:#[0-9a-f]{3,8}|rgba?\([^)]*\)|[a-z][a-z0-9-]*)`;
        const pattern = new RegExp(
            String.raw`^(?:(${color})\s+)?(${length})\s+(${length})(?:\s+(${length}))?(?:\s+(${color}))?$`,
            "i",
        );
        const effects: string[] = [];
        for (const shadow of shadows) {
            const match = shadow.match(pattern);
            if (!match) return undefined;
            const shadowColor = match[1] ?? match[5] ?? "currentcolor";
            const offsetX = match[2]!;
            const offsetY = match[3]!;
            const blur = match[4];
            effects.push(
                blur && Number.parseFloat(blur) > 0
                    ? `glow(0px ${blur} ${offsetX} ${offsetY} ${shadowColor})`
                    : `shadow(${offsetX} ${offsetY} ${shadowColor})`,
            );
        }
        return effects.length > 0 ? effects.join(",") : undefined;
    }

    /** Properties whose values RmlUi reads in its own grammar. */
    private static readonly UI_LOWERED_STYLE_VALUES = new EmissionSet([
        "border-image",
        "transform-origin",
    ]);

    /** One property value in RmlUi's grammar, for declaration lists and style writes. */
    private lowerUiStyleValue(
        property: string,
        value: string,
        site?: ts.Node,
    ): string {
        return property === "border-image"
            ? this.lowerUiBorderImage(value, site)
            : UiProjection.canonicalUiTransformOrigin(value);
    }

    private lowerUiBorderImage(value: string, site?: ts.Node): string {
        const image = /__BBLITE_UI_STYLE_\d+__/.test(value)
            ? undefined
            : parseUiBorderImage(value);
        if (image === undefined) {
            return this.uiStyleRefusal(
                site,
                "border-image",
                "only a static raster URL with non-negative slices and widths, zero outset, stretch and no center fill is represented",
            );
        }
        if (image === "none") return image;
        return renderUiBorderImage(
            image,
            this.context.assetRegistry.registerAsset(image.source, "texture")
                .output,
        );
    }

    public lowerUiAttributeLiteral(
        name: string,
        value: string,
        site?: ts.Node,
    ): string {
        if (name === "hidden" && value.toLowerCase() === "until-found") {
            this.context.fail(
                site ?? this.context.sourceFile,
                "UI hidden='until-found' requires find-in-page support.",
            );
        }
        if (name !== "style") return value;
        const customDeclarations: string[] = [];
        const authoredDeclarations: string[] = [];
        UiProjection.forEachUiStyleDeclaration(value, (declaration) => {
            const colon = declaration.indexOf(":");
            authoredDeclarations.push(
                colon >= 0 &&
                    UiProjection.isCustomStyleProperty(
                        declaration.slice(0, colon).trim(),
                    )
                    ? `\u0002${customDeclarations.push(declaration) - 1}\u0002`
                    : declaration,
            );
        });
        value = authoredDeclarations.join(";");
        const authoredDisplay = /(?:^|;)\s*display\s*:/i.test(value);
        this.auditUiStyleDeclarations(value, site);
        {
            const declarations: string[] = [];
            UiProjection.forEachUiStyleDeclaration(value, (declaration) => {
                const colon = declaration.indexOf(":");
                const property = declaration
                    .slice(0, colon)
                    .trim()
                    .toLowerCase();
                if (
                    colon >= 0 &&
                    UiProjection.INERT_UI_STYLE_PROPERTIES.has(property)
                )
                    return;
                let lowered = declaration;
                if (colon >= 0 && property === "-webkit-appearance") {
                    lowered = `appearance:${declaration.slice(colon + 1)}`;
                } else if (
                    colon >= 0 &&
                    UiProjection.UI_LOWERED_STYLE_VALUES.has(property)
                ) {
                    lowered = `${property}:${this.lowerUiStyleValue(property, declaration.slice(colon + 1), site)}`;
                } else if (colon >= 0 && isUiLayoutProperty(property)) {
                    lowered = `${property}:${declaration
                        .slice(colon + 1)
                        .trim()
                        .toLowerCase()}`;
                }
                declarations.push(
                    lowered.replaceAll(";", UiProjection.UI_MASKED_SEMICOLON),
                );
            });
            value = declarations.join(";");
        }
        // From here every read and rewrite is declaration-scoped by
        // regex; masking nested semicolons and custom declarations makes those regexes
        // segment exactly where the audit's splitter did. The mask is
        // restored on the single return below.
        const clipsGradientToText =
            UiProjection.GRADIENT_TEXT_CLIP_PATTERN.test(value);
        const gradientTextColors = clipsGradientToText
            ? (value
                  .match(UiProjection.GRADIENT_TEXT_BACKGROUND_PATTERN)?.[1]
                  ?.match(/#[0-9a-f]{3,8}/gi) ?? [])
            : [];
        const gradientTextColor = gradientTextColors[0];
        const gradientTextDuration = clipsGradientToText
            ? value.match(
                  /\banimation\s*:[^;]*?\b([0-9]+(?:\.[0-9]*)?)s\b/i,
              )?.[1]
            : undefined;
        const gradientTextBackgroundScale = clipsGradientToText
            ? value.match(
                  /\bbackground-size\s*:\s*([0-9]+(?:\.[0-9]*)?)%/i,
              )?.[1]
            : undefined;
        const gradientTextStroke = clipsGradientToText
            ? value.match(UiProjection.GRADIENT_TEXT_STROKE_PATTERN)
            : undefined;
        const gradientTextShadow = clipsGradientToText
            ? value.match(UiProjection.GRADIENT_TEXT_SHADOW_PATTERN)
            : undefined;
        const gradientFontEffects: string[] = [];
        if (gradientTextStroke) {
            gradientFontEffects.push(
                `outline(${gradientTextStroke[1]!} ${gradientTextStroke[2]!.trim()})`,
            );
        }
        if (gradientTextShadow) {
            gradientFontEffects.push(
                `shadow(${gradientTextShadow[1]!} ${gradientTextShadow[2]!} ${gradientTextShadow[3]!})`,
            );
        }
        const sourceValue = gradientTextColor
            ? value.replace(/\bbackground\s*:\s*linear-gradient\([^;]*;?/gi, "")
            : value;
        // RmlUi 6.4 does not accept calc() for positioned offsets. For the
        // static inline CSS surface supported here, preserve the browser
        // equation as a percentage offset plus a same-side pixel margin.
        let lowered = sourceValue
            .replace(/\bposition\s*:\s*fixed\b/gi, "position:absolute")
            .replace(
                /\bfont\s*:\s*(?:(\d+|normal|bold)\s+)?clamp\(\s*[0-9.]+px\s*,\s*[0-9.]+vw\s*,\s*([0-9.]+)px\s*\)\s+([^;]+)\s*;?/gi,
                (_match, weight, maximum, family) =>
                    `${weight ? `font-weight:${weight};` : ""}` +
                    `font-size:${maximum}px;font-family:${String(family)};`,
            )
            .replace(
                /\bfont\s*:\s*(?:(\d+|normal|bold)\s+)?([0-9]+(?:\.[0-9]*)?)(px|rem)(?:\s*\/\s*([0-9]+(?:\.[0-9]*)?(?:px|rem)?))?\s+([^;]+)\s*;?/gi,
                (_match, weight, size, unit, lineHeight, family) =>
                    `${weight ? `font-weight:${weight};` : ""}` +
                    `font-size:${size}${unit};` +
                    `${lineHeight ? `line-height:${lineHeight};` : ""}` +
                    `font-family:${String(family)};`,
            )
            .replace(
                /\bfont\s*:\s*(?:(\d+|normal|bold)\s+)?clamp\(\s*[^,]+,\s*[^,]+,\s*([0-9]+(?:\.[0-9]*)?)(px|rem)\s*\)\s+([^;]+)\s*;?/gi,
                (_match, weight, maximum, unit, family) =>
                    `${weight ? `font-weight:${weight};` : ""}` +
                    `font-size:${maximum}${unit};` +
                    `font-family:${String(family)};`,
            )
            .replace(
                /\binset\s*:\s*([^;]+)\s*;?/gi,
                (_match, offsets: string) => {
                    const parts = offsets.trim().split(/\s+/);
                    const [top, right = top, bottom = top, left = right] =
                        parts;
                    return `top:${top};right:${right};bottom:${bottom};left:${left};`;
                },
            )
            .replace(
                /\bbackground\s*:\s*([^;]+)\s*;?/gi,
                (declaration: string, background: string) => {
                    if (!/(?:linear|radial|conic)-gradient\(/i.test(background))
                        return declaration;
                    const decorators = uiGradientBackground(background);
                    if (decorators === undefined)
                        return this.uiStyleRefusal(
                            site,
                            "background",
                            "gradient layers require supported positions, nonnegative length/percentage sizes and no-repeat",
                        );
                    return `${UiProjection.uiShorthandResetStyle("background")}decorator:${decorators};`;
                },
            )
            // A browser background can combine a fallback colour with a
            // runtime-selected root-relative image. RmlUi exposes the image
            // through its decorator, while generation packages the closed
            // source image directory at the same logical paths.
            .replace(
                /\bbackground\s*:\s*([^;]*?)\s+url\(\s*["']?__BBLITE_UI_STYLE_(\d+)__["']?\s*\)\s+center\s*\/\s*cover\s*;?/gi,
                (_match, color, index) =>
                    `background-color:${String(color).trim()};` +
                    `decorator:image("__BBLITE_UI_ASSET_${String(index)}__" cover);`,
            )
            // RmlUi exposes the colour property explicitly rather than the
            // browser background shorthand used by the reached HUDs.
            .replace(
                /\bbackground\s*:\s*center(?:\s+center)?\s*\/\s*(contain|cover)\s+no-repeat\s*;?/gi,
                "background-color:transparent;background-image:none;background-position:center center;background-size:$1;background-repeat:no-repeat;background-origin:padding-box;background-attachment:scroll;background-clip:border-box;",
            )
            .replace(
                /\bbackground\s*:/gi,
                `${UiProjection.uiShorthandResetStyle("background")}background-color:`,
            )
            .replace(
                /(?:-webkit-)?backdrop-filter\s*:\s*([^;]+)\s*;?/gi,
                (_match, filter) =>
                    UiProjection.supportedBackdropFilter(String(filter))
                        ? `backdrop-filter:${String(filter).trim()};`
                        : "",
            )
            .replace(
                /\boutline-offset\s*:\s*([^;]+)\s*;?/gi,
                "--bbl-outline-offset:$1;",
            )
            .replace(/\boutline\s*:\s*([^;]+)\s*;?/gi, "--bbl-outline:$1;")
            .replace(/\bmix-blend-mode\s*:[^;]*;?/gi, "")
            // RmlUi's border shorthand is `width color`; it deliberately
            // omits CSS border-style because every non-zero border is solid.
            // Translate the ordinary browser spelling instead of letting the
            // entire declaration be rejected by its shorthand parser.
            .replace(
                /\b(border(?:-(?:top|right|bottom|left))?)\s*:\s*([^;\s]+)\s+solid\s+([^;]+)\s*;?/gi,
                "$1:$2 $3;",
            )
            .replace(
                /\b(border(?:-(?:top|right|bottom|left))?)\s*:\s*none\s*;?/gi,
                "$1:0 transparent;",
            )
            .replace(
                /\bborder\s*:/gi,
                `${UiProjection.uiShorthandResetStyle("border")}border:`,
            )
            .replace(/\bbackground-size\s*:[^;]*;?/gi, (declaration) =>
                clipsGradientToText ? "" : declaration,
            )
            .replace(
                /(^|;)\s*(?:-webkit-)?background-clip\s*:\s*text\s*(?=;|$)/gi,
                "$1",
            )
            .replace(/-webkit-text-stroke\s*:[^;]*;?/gi, "")
            .replace(/(^|;)\s*filter\s*:[^;]*/gi, (declaration, separator) =>
                clipsGradientToText
                    ? String(separator)
                    : declaration
                          .replace(/filter\s*:/i, "filter:")
                          .replace(/[a-z-]+(?=\()/gi, (name: string) =>
                              name.toLowerCase(),
                          ),
            )
            .replace(/(^|;)\s*word-wrap\s*:/gi, "$1overflow-wrap:")
            .replace(/\btext-shadow\s*:\s*([^;]+)\s*;?/gi, (_match, shadow) => {
                const effect = this.lowerUiTextShadow(String(shadow));
                if (effect === undefined) {
                    this.uiStyleRefusal(
                        site,
                        "text-shadow",
                        `the shadow list '${String(shadow).trim()}' is ` +
                            "outside the reviewed '[color] x y [blur] " +
                            "[color]' form",
                    );
                }
                return `font-effect:${effect};`;
            })
            .replace(
                /(^|;)\s*color\s*:\s*transparent\s*(?=;|$)/gi,
                (declaration, separator: string) =>
                    gradientTextColor
                        ? `${separator}color:${gradientTextColor}`
                        : declaration,
            )
            .replace(
                /\b(left|top|right|bottom)\s*:\s*calc\(\s*([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))%\s*([+-])\s*([0-9]+(?:\.[0-9]*)?|\.[0-9]+)px\s*\)\s*;?/gi,
                (_match, property, percent, sign, pixels) =>
                    `${String(property).toLowerCase()}:${percent}%;` +
                    `margin-${String(property).toLowerCase()}:` +
                    `${sign === "-" ? "-" : ""}${pixels}px;`,
            );

        if (gradientTextColors.length > 1) {
            // RmlUi has no background-clip:text. Preserve the declarative
            // intent as private PAL metadata so native UI can materialize a
            // per-glyph gradient and advance the reached shimmer animation.
            lowered +=
                `;--bbl-text-gradient:${gradientTextColors.join("|")};` +
                `--bbl-text-gradient-duration:${gradientTextDuration ?? "0"}s;` +
                `--bbl-text-gradient-scale:${gradientTextBackgroundScale ?? "100"}%;`;
            if (gradientFontEffects.length > 0) {
                lowered += `font-effect:${gradientFontEffects.join(",")};`;
            }
        }

        if (/\bposition\s*:\s*absolute\b/i.test(lowered)) {
            const hasWidth = /(?:^|;)\s*width\s*:/i.test(lowered);
            const minimum = lowered
                .match(/(?:^|;)\s*min-width\s*:\s*([^;]+)/i)?.[1]
                ?.trim();
            if (!hasWidth && minimum) {
                // RmlUi cannot complete CSS shrink-to-fit when percentage-
                // width inline children contribute to an absolute block's
                // max-content size. Start from the authored minimum and leave
                // generic measurement metadata for the retained PAL pass.
                lowered += `;--bbl-intrinsic-min-width:${minimum};`;
            } else if (
                !hasWidth &&
                !minimum &&
                !/\bdisplay\s*:/i.test(lowered) &&
                /\bleft\s*:/i.test(lowered) !== /\bright\s*:/i.test(lowered)
            ) {
                lowered += ";--bbl-absolute-inline:1;";
            }
        }
        if (
            /\bdisplay\s*:\s*(?:inline-)?flex\b/i.test(lowered) &&
            /\balign-items\s*:\s*center\b/i.test(lowered) &&
            /\bjustify-content\s*:\s*center\b/i.test(lowered) &&
            !/\bline-height\s*:/i.test(lowered)
        ) {
            const height = lowered.match(
                /(?:^|;)\s*height\s*:\s*([0-9]+(?:\.[0-9]*)?px)/i,
            )?.[1];
            if (height) {
                if (/\bdisplay\s*:\s*inline-flex\b/i.test(lowered)) {
                    // RmlUi does not synthesize the browser's anonymous flex
                    // item for direct text. An inline centred badge needs no
                    // flex distribution beyond that text, so an inline block
                    // with the equivalent line box preserves its layout.
                    lowered = lowered.replace(
                        /\bdisplay\s*:\s*inline-flex\b/gi,
                        "display:inline-block",
                    );
                }
                // RmlUi does not construct an anonymous flex item for a
                // direct text node. A centred fixed-height browser button
                // therefore needs the equivalent line box explicitly.
                lowered += `;line-height:${height};text-align:center;`;
            }
        }
        if (authoredDisplay) lowered += ";--bbl-authored-display:1;";
        const nativeDeclarations: string[] = [];
        UiProjection.forEachUiStyleDeclaration(lowered, (declaration) => {
            const colon = declaration.indexOf(":");
            if (colon < 0) {
                nativeDeclarations.push(declaration);
                return;
            }
            const property = declaration.slice(0, colon).trim().toLowerCase();
            let literal = declaration.slice(colon + 1).trim();
            let nativeProperty = nativeUiImageProperty(property);
            if (property === "background-image") {
                const source = uiBackgroundImageSource(literal);
                if (source !== undefined)
                    literal = JSON.stringify(
                        this.context.assetRegistry.registerAsset(
                            source,
                            "texture",
                        ).output,
                    );
            } else if (property === "clip") {
                nativeProperty = "bbl-zero-clip";
                literal = literal.toLowerCase() === "auto" ? "0" : "1";
            } else if (
                property === "scale" &&
                literal.toLowerCase() === "none"
            ) {
                literal = "1";
            } else if (property === "transition") {
                literal = literal.replace(/\btransform\b/g, "bbl-transform");
            } else if (
                property === "background-clip" &&
                literal === "inherit"
            ) {
                nativeProperty = "--bbl-background-clip";
            } else if (property === "--bbl-outline") {
                literal = literal.replace(
                    /^(.+)\s+solid\s+(\d+(?:\.\d+)?px)$/,
                    "$2 solid $1",
                );
            }
            nativeDeclarations.push(`${nativeProperty}:${literal}`);
        });
        lowered = nativeDeclarations.join(";");
        // eslint-disable-next-line no-control-regex -- Private delimiters protect retained CSS declarations.
        const customPattern = /\u0002(\d+)\u0002/g;
        return lowered
            .replaceAll(UiProjection.UI_MASKED_SEMICOLON, ";")
            .replace(
                customPattern,
                (_match, index: string) => customDeclarations[Number(index)]!,
            );
    }

    /**
     * `@keyframes` blocks are not sheet rules: the whole sheet text also
     * rides `ui_set_text`, and the PAL extracts and projects the keyframes
     * from there (`pal_ui_rml.cpp` `keyframes_from`), so their interior
     * percentage blocks must not reach the rule parser. Mirrors the PAL's
     * brace-depth walk.
     */
    private static splitUiKeyframesBlocks(source: string): {
        rules: string;
        keyframes: string;
    } {
        let rules = "";
        let keyframes = "";
        let cursor = 0;
        let depth = 0;
        for (const index of uiCssSyntaxIndices(source)) {
            if (index < cursor) continue;
            if (
                depth === 0 &&
                source[index] === "@" &&
                /^@keyframes\b/i.test(source.slice(index))
            ) {
                const opening = findUiCssSyntax(source, "{", index);
                if (opening === undefined) break;
                const end = uiCssBlockEnd(source, opening);
                if (end === undefined) break;
                rules += source.slice(cursor, index);
                keyframes += source.slice(index, end);
                cursor = end;
            } else if (source[index] === "{") depth++;
            else if (source[index] === "}") depth--;
        }
        return { rules: rules + source.slice(cursor), keyframes };
    }

    /**
     * Parse the bounded author-sheet surface into typed retained rules. RmlUi
     * receives only selectors this parser names, so its selector engine
     * evaluates hover and max-width state without making arbitrary browser CSS
     * part of the generated runtime.
     */
    private static uiStyleContainsBlock(source: string): boolean {
        for (const index of uiCssSyntaxIndices(source))
            if (source[index] === "{" || source[index] === "}") return true;
        return false;
    }

    private validateUiPartStyle(
        style: string,
        part: UiGeneratedPart | "range",
        site?: ts.Node,
    ): void {
        UiProjection.forEachUiStyleDeclaration(style, (declaration) => {
            if (!declaration.trim()) return;
            const property = declaration
                .slice(0, declaration.indexOf(":"))
                .trim();
            if (
                part === "placeholder" &&
                property !== "color" &&
                property !== "opacity"
            )
                this.uiStyleRefusal(
                    site,
                    property,
                    "placeholder styles currently represent color and opacity",
                );
            if (
                property.startsWith("--bbl-") &&
                !property.startsWith("--bbl-background-") &&
                property !== "--bbl-authored-display"
            )
                this.uiStyleRefusal(
                    site,
                    property,
                    "this layout or decoration adaptation requires an authored retained element",
                );
        });
    }

    private lowerUiRuleDeclarations(
        source: string,
        site?: ts.Node,
    ): { style: string; content?: UiGeneratedContent } {
        let content: UiGeneratedContent | undefined;
        const declarations: string[] = [];
        UiProjection.forEachUiStyleDeclaration(source, (declaration) => {
            const colon = declaration.indexOf(":");
            if (
                colon < 0 ||
                declaration.slice(0, colon).trim().toLowerCase() !== "content"
            ) {
                declarations.push(declaration);
                return;
            }
            content = parseUiGeneratedContent(declaration.slice(colon + 1));
            if (!content)
                this.uiStyleRefusal(
                    site,
                    "content",
                    "only none/normal and lists of CSS strings or attr(name) are represented",
                );
        });
        return {
            style: this.lowerUiAttributeLiteral(
                "style",
                content ? declarations.join(";") : source,
                site,
            ),
            ...(content ? { content } : {}),
        };
    }

    /**
     * The statements that replace a retained `<style>` element's rules with
     * those of `sheet`; the sheet text itself rides `ui_set_text`, from
     * which the PAL reads its keyframes.
     */
    private uiStyleSheetRuleStatements(
        engine: string,
        styleElement: string,
        sheet: string,
        site?: ts.Node,
        ownerId?: number,
        origin?: RefusalSite,
    ): string[] {
        const statements = [
            `bbl::ui_clear_style_rules(${engine}, ${styleElement});`,
        ];
        for (const rule of this.lowerUiStyleSheetLiteral(
            sheet,
            site,
            ownerId,
            origin,
        )) {
            statements.push(
                (rule.kind === "class" || rule.kind === "id") &&
                    !uiStyleRuleNeedsRuntimeMatch(rule) &&
                    !rule.scrollbar &&
                    !rule.range &&
                    !rule.pseudo &&
                    !uiStyleRuleHasConditions(rule)
                    ? `bbl::ui_add_${rule.kind}_style(${engine}, ` +
                          `${styleElement}, ` +
                          `${this.context.cppString(rule.primary)}, ` +
                          `${this.context.cppString(rule.style)});`
                    : `bbl::ui_add_style_rule(${engine}, ${styleElement}, ` +
                          `bbl::UiStyleSelectorKind::${uiStyleSelectorCppKind(rule.kind)}, ` +
                          `${this.context.cppString(rule.primary)}, ` +
                          `${this.context.cppString(rule.secondary ?? "")}, ` +
                          `${this.context.cppString(rule.tag ?? "")}, ` +
                          `${rule.hover ? "true" : "false"}, ` +
                          `${doubleLiteral(rule.maxWidth ?? -1)}, ` +
                          `${this.context.cppString(rule.style)}` +
                          `, bbl::UiScrollbarPart::${uiScrollbarPartCpp(rule.scrollbar)}, ` +
                          `${rule.focusVisible ? "true" : "false"}, ${rule.active ? "true" : "false"}, ` +
                          `bbl::UiMotionPreference::${uiMotionPreferenceCpp(rule.reducedMotion)}` +
                          `${this.uiRuleSuffix(rule)});`,
            );
        }
        return statements;
    }

    private lowerUiStyleSheetLiteral(
        value: string,
        site?: ts.Node,
        ownerId?: number,
        origin?: RefusalSite,
    ): LoweredUiStyleRule[] {
        const rules: LoweredUiStyleRule[] = [];
        // A host file's sheet: refusals point at the line of the rule being
        // lowered, found in the sheet as written.
        const at = origin && { ...origin };
        let searched = 0;
        const enter = (header: string): void => {
            if (!at || !origin) return;
            // The header as written, followed by its block's brace.
            let offset = value.indexOf(header, searched);
            while (
                offset >= 0 &&
                !/^\s*\{/.test(value.slice(offset + header.length))
            )
                offset = value.indexOf(header, offset + 1);
            if (offset < 0) return;
            searched = offset + header.length;
            at.line =
                origin.line + value.slice(0, offset).split("\n").length - 1;
        };
        const refuseSelector = (selector: string): never => {
            const message =
                `Retained stylesheet selector '${selector}' is not ` +
                "lowered: retained sheets accept tag/id/class compounds, attribute presence/equality, " +
                "descendant/child/sibling chains and hover/active/focus/focus-visible/disabled/checked states, " +
                "scrollbar and range thumb/track pseudo-elements, " +
                "'@media (max-width:Npx)', '@media (orientation:portrait|landscape)', '@media (prefers-reduced-motion:reduce|no-preference)', '@container (max-width:Npx)', and '@keyframes' blocks.";
            if (site) this.context.fail(site, message);
            this.context.failAtFile(message);
        };
        const source = UiProjection.splitUiKeyframesBlocks(
            stripUiCssComments(value),
        ).rules;

        const parseBlocks = (
            text: string,
            inheritedMaxWidth?: number,
            inheritedReducedMotion?: boolean,
            inheritedContainerMaxWidth?: number,
            inheritedOrientation?: "portrait" | "landscape",
        ): void => {
            let cursor = 0;
            while (cursor < text.length) {
                while (cursor < text.length && /[\s;]/.test(text[cursor]!)) {
                    cursor++;
                }
                if (cursor >= text.length) break;
                const opening =
                    findUiCssSyntax(text, "{", cursor) ??
                    refuseSelector(text.slice(cursor).trim());
                const header = text.slice(cursor, opening).trim();
                enter(header);
                const end =
                    uiCssBlockEnd(text, opening) ?? refuseSelector(header);
                const body = text.slice(opening + 1, end - 1);
                cursor = end;

                if (/^@media\b/i.test(header)) {
                    if (
                        inheritedMaxWidth !== undefined ||
                        inheritedReducedMotion !== undefined ||
                        inheritedOrientation !== undefined
                    ) {
                        refuseSelector(header);
                    }
                    const orientation =
                        /^@media\s*\(\s*orientation\s*:\s*(portrait|landscape)\s*\)$/i
                            .exec(header)?.[1]
                            ?.toLowerCase();
                    if (
                        orientation === "portrait" ||
                        orientation === "landscape"
                    ) {
                        parseBlocks(
                            body,
                            undefined,
                            undefined,
                            inheritedContainerMaxWidth,
                            orientation,
                        );
                        continue;
                    }
                    const motion =
                        /^@media\s*\(\s*prefers-reduced-motion\s*:\s*(reduce|no-preference)\s*\)$/i.exec(
                            header,
                        );
                    if (motion) {
                        parseBlocks(
                            body,
                            undefined,
                            motion[1]!.toLowerCase() === "reduce",
                            inheritedContainerMaxWidth,
                        );
                        continue;
                    }
                    const media = header.match(
                        /^@media\s*\(\s*max-width\s*:\s*([0-9]+(?:\.[0-9]*)?)px\s*\)$/i,
                    );
                    const maxWidth = Number(media?.[1]);
                    if (!media || !Number.isFinite(maxWidth) || maxWidth < 0) {
                        refuseSelector(header);
                    }
                    parseBlocks(
                        body,
                        maxWidth,
                        undefined,
                        inheritedContainerMaxWidth,
                    );
                    continue;
                }
                if (/^@container\b/i.test(header)) {
                    const query =
                        /^@container\s*\(\s*max-width\s*:\s*([0-9]+(?:\.[0-9]*)?)px\s*\)$/i.exec(
                            header,
                        );
                    const width = Number(query?.[1]);
                    if (
                        !query ||
                        !Number.isFinite(width) ||
                        width < 0 ||
                        width > 3.4028234663852886e38
                    )
                        refuseSelector(header);
                    parseBlocks(
                        body,
                        inheritedMaxWidth,
                        inheritedReducedMotion,
                        Math.min(inheritedContainerMaxWidth ?? Infinity, width),
                        inheritedOrientation,
                    );
                    continue;
                }
                if (header.startsWith("@")) refuseSelector(header);
                if (UiProjection.uiStyleContainsBlock(body)) {
                    refuseSelector(header);
                }

                // Chromium, our control reference, discards an entire selector
                // list containing these Gecko-only pseudo-elements. Do this before
                // declaration admission: those declarations never enter its cascade.
                const selectors = splitUiSelectorList(header);
                if (
                    selectors.some((selector) => {
                        const foreign =
                            /^(.*?)::-moz-range-(?:thumb|track|progress)(?::(?:hover|active))?$/.exec(
                                selector,
                            );
                        return (
                            foreign &&
                            parseUiSelectorSequence(foreign[1] || "*")
                        );
                    })
                )
                    continue;
                const sourceStyle = body.trim();
                for (const selector of selectors) {
                    if (
                        parseUiSelectorSequence(
                            selector.replace(
                                /::(?:before|after|placeholder)$/,
                                "",
                            ),
                        )
                            ?.at(-1)
                            ?.tests.some(
                                (test) =>
                                    test.kind === "tag" &&
                                    (test.name === "path" ||
                                        test.name === "rect"),
                            )
                    ) {
                        const message =
                            `Retained stylesheet selector '${selector}' cannot ` +
                            "target SVG path/rect nodes: LunaSVG receives the " +
                            "validated SVG contents as image data, not RmlUi elements.";
                        if (site) this.context.fail(site, message);
                        this.context.failAtFile(message);
                    }
                }
                const { style, content } = this.lowerUiRuleDeclarations(
                    sourceStyle,
                    site,
                );
                for (const selector of selectors) {
                    const rule =
                        UiProjection.parseUiSelector(selector, style) ??
                        refuseSelector(selector);
                    if (
                        content &&
                        rule.pseudo !== "before" &&
                        rule.pseudo !== "after"
                    )
                        this.uiStyleRefusal(
                            site,
                            "content",
                            "text content lists require a before/after pseudo-element",
                        );
                    if (rule.pseudo)
                        this.validateUiPartStyle(style, rule.pseudo, site);
                    if (rule.range)
                        this.validateUiPartStyle(style, "range", site);
                    if (content) rule.content = content;
                    if (inheritedMaxWidth !== undefined) {
                        rule.maxWidth = inheritedMaxWidth;
                    }
                    if (inheritedReducedMotion !== undefined)
                        rule.reducedMotion = inheritedReducedMotion;
                    if (inheritedContainerMaxWidth !== undefined)
                        rule.containerMaxWidth = inheritedContainerMaxWidth;
                    if (inheritedOrientation !== undefined)
                        rule.orientation = inheritedOrientation;
                    if (site) rule.site = site;
                    if (ownerId !== undefined) rule.ownerId = ownerId;
                    if (
                        !rule.scrollbar &&
                        !rule.range &&
                        (rule.kind === "class-descendant-tag" ||
                            rule.kind === "id-descendant-class")
                    ) {
                        this.uiScopedSheetSelectors.add(selector);
                    }
                    if (!style && !content) continue;
                    rules.push(rule);
                }
            }
        };
        if (at) this.context.attributeRefusalsTo(at, () => parseBlocks(source));
        else parseBlocks(source);
        return rules;
    }

    public uiStaticDescendants(rootId: number): {
        elements: Set<number>;
        markup: UiStaticMarkupNode[];
        complete: boolean;
        markupAlternatives: boolean;
    } {
        const elements = new EmissionSet<number>();
        const markup: UiStaticMarkupNode[] = [];
        let complete = true;
        let markupAlternatives = false;
        const addMarkup = (node: UiStaticMarkupNode): void => {
            markup.push(node);
            for (const child of node.children) addMarkup(child);
        };
        const visit = (id: number): void => {
            markupAlternatives ||= this.uiMarkupAlternativeOwners.has(id);
            const parent = this.uiStaticElements.get(id);
            if (!parent) {
                complete = false;
                return;
            }
            complete = complete && parent.childShapeKnown;
            for (const node of parent.markupChildren) addMarkup(node);
            for (const childId of parent.children) {
                if (elements.has(childId)) continue;
                elements.add(childId);
                visit(childId);
            }
        };
        visit(rootId);
        return { elements, markup, complete, markupAlternatives };
    }

    /**
     * The bounded stylesheet selector grammar, one pattern per kind in the
     * order they are tried; the first match builds the rule and no match is
     * the caller's refusal.
     */
    private static parseUiSelector(
        selector: string,
        style: string,
    ): LoweredUiStyleRule | undefined {
        const generated = /^(.*)::(before|after|placeholder)$/s.exec(selector);
        if (generated) {
            const origin = generated[1]!;
            const sequence = parseUiSelectorSequence(
                !origin || /[\s>+~]$/.test(origin) ? origin + "*" : origin,
            );
            if (!sequence) return undefined;
            return {
                kind: "sequence",
                primary: uiSelectorSequenceCss(sequence),
                sequence,
                hover: false,
                style,
                pseudo:
                    generated[2] === "before"
                        ? "before"
                        : generated[2] === "after"
                          ? "after"
                          : "placeholder",
                selector,
            };
        }
        const range =
            /^(.*?)::-webkit-slider-(thumb|runnable-track)(?::(hover|active))?$/.exec(
                selector,
            );
        if (range) {
            const origin = range[1]!;
            const sequence = parseUiSelectorSequence(
                !origin || /[\s>+~]$/.test(origin) ? origin + "*" : origin,
            );
            if (!sequence) return undefined;
            return {
                kind: "sequence",
                primary: uiSelectorSequenceCss(sequence),
                sequence,
                style,
                selector,
                range: range[2] === "thumb" ? "thumb" : "track",
                hover: range[3] === "hover",
                active: range[3] === "active",
            };
        }
        const scrollbar = selector.match(
            /^(.*?)::-webkit-scrollbar(?:-(thumb|track|button|corner))?(:hover)?$/,
        );
        if (scrollbar) {
            const owner = UiProjection.parseUiSelector(scrollbar[1]!, style);
            const part = scrollbar[2] ?? "scrollbar";
            if (
                !owner ||
                owner.pseudo ||
                owner.range ||
                owner.scrollbar ||
                uiStyleInteractionStateCount(owner) > 0 ||
                !isUiScrollbarPart(part)
            )
                return undefined;
            return {
                ...owner,
                scrollbar: part,
                hover: scrollbar[3] !== undefined,
                selector,
            };
        }
        const state = /:(hover|active|focus-visible)$/i.exec(selector);
        if (
            state &&
            selector.length > state[0].length &&
            !/[\s>+~]$/.test(selector.slice(0, -state[0].length))
        ) {
            const owner = UiProjection.parseUiSelector(
                selector.slice(0, -state[0].length),
                style,
            );
            const property =
                state[1]!.toLowerCase() === "focus-visible"
                    ? "focusVisible"
                    : state[1]!.toLowerCase() === "active"
                      ? "active"
                      : "hover";
            if (
                !owner ||
                owner[property] ||
                owner.scrollbar ||
                owner.range ||
                owner.pseudo
            )
                return undefined;
            return { ...owner, [property]: true, selector };
        }
        const identifier = "[A-Za-z_][A-Za-z0-9_-]*";
        const tag = "[a-z][a-z0-9-]*";
        const forms: readonly (readonly [
            RegExp,
            (match: RegExpMatchArray) => LoweredUiStyleRule,
        ])[] = [
            [
                new RegExp(
                    `^(${tag})\\s*>\\s*\\.(${identifier})(?:\\.(${identifier}))?$`,
                    "i",
                ),
                (match) => ({
                    kind: "tag-child-class",
                    tag: match[1]!.toLowerCase(),
                    primary: match[2]!,
                    ...(match[3] ? { secondary: match[3] } : {}),
                    hover: false,
                    style,
                    selector,
                }),
            ],
            [
                new RegExp(`^#(${identifier})\\s+\\.(${identifier})$`),
                (match) => ({
                    kind: "id-descendant-class",
                    primary: match[1]!,
                    secondary: match[2]!,
                    hover: false,
                    style,
                    selector,
                }),
            ],
            [
                new RegExp(`^\\.(${identifier})\\s+(${tag})$`, "i"),
                (match) => ({
                    kind: "class-descendant-tag",
                    primary: match[1]!,
                    tag: match[2]!.toLowerCase(),
                    hover: false,
                    style,
                    selector,
                }),
            ],
            [
                new RegExp(`^\\.(${identifier})\\.(${identifier})$`),
                (match) => ({
                    kind: "compound-class",
                    primary: match[1]!,
                    secondary: match[2]!,
                    hover: false,
                    style,
                    selector,
                }),
            ],
            [
                new RegExp(`^(${tag})\\.(${identifier})$`, "i"),
                (match) => ({
                    kind: "tag-class",
                    primary: match[2]!,
                    tag: match[1]!.toLowerCase(),
                    hover: false,
                    style,
                    selector,
                }),
            ],
            [
                new RegExp(`^([.#])(${identifier})$`),
                (match) => ({
                    kind: match[1] === "#" ? "id" : "class",
                    primary: match[2]!,
                    hover: false,
                    style,
                    selector,
                }),
            ],
        ];
        for (const [pattern, build] of forms) {
            const match = selector.match(pattern);
            if (match) return build(match);
        }
        const sequence = parseUiSelectorSequence(selector);
        return sequence
            ? {
                  kind: "sequence",
                  primary: uiSelectorSequenceCss(sequence),
                  sequence,
                  hover: false,
                  style,
                  selector,
              }
            : undefined;
    }

    private uiStaticElementAlwaysHasClass(
        element: UiStaticElement,
        className: string,
    ): boolean {
        return (
            element.classAlternatives.length > 0 &&
            element.classAlternatives.every((classes) => classes.has(className))
        );
    }

    public validateUiStaticProjection(): void {
        for (const query of this.uiPendingClassQueries) {
            if (query.root.uiStaticId === undefined) {
                this.context.fail(
                    query.site,
                    "Retained UI querySelectorAll requires a statically-known retained root.",
                );
            }
            const descendants = this.uiStaticDescendants(query.root.uiStaticId);
            const unknownClass = [...descendants.elements].some(
                (id) => !this.uiStaticElements.get(id)?.classShapeKnown,
            );
            const retainedMatches = [...descendants.elements].filter((id) => {
                const element = this.uiStaticElements.get(id);
                return (
                    element !== undefined &&
                    this.uiStaticElementAlwaysHasClass(element, query.className)
                );
            });
            const markupMatches = descendants.markup.filter((node) =>
                node.classes.has(query.className),
            );
            if (
                !descendants.complete ||
                unknownClass ||
                retainedMatches.length === 0 ||
                markupMatches.length > 0
            ) {
                this.context.fail(
                    query.site,
                    `Retained UI querySelectorAll('.${query.className}') ` +
                        "requires a complete statically-known retained subtree " +
                        "with at least one matching retained element and no " +
                        "matching innerHTML-only node.",
                );
            }
        }
    }

    private compileUiStyleString(
        expression: ts.Expression,
        ownerId?: number,
    ): string {
        const staticValue = this.tryUiStaticString(expression);
        if (staticValue !== undefined) {
            const lowered = this.lowerUiAttributeLiteral(
                "style",
                staticValue,
                expression,
            );
            if (ownerId !== undefined) {
                const owner = this.uiStaticElements.get(ownerId);
                if (owner) this.recordUiStaticStyles(owner, [lowered]);
            }
            return this.context.cppString(lowered);
        }
        const unwrapped = this.context.unwrap(expression);
        const recordCandidates = (candidate: ts.Expression): void => {
            if (ownerId === undefined) return;
            const owner = this.uiStaticElements.get(ownerId);
            if (!owner) return;
            const candidates = this.uiStringCandidates(candidate);
            if (!candidates) {
                writable(owner).styleShapeKnown = false;
                return;
            }
            this.recordUiStaticStyles(
                owner,
                candidates.map((value) =>
                    this.lowerUiAttributeLiteral("style", value, expression),
                ),
            );
        };
        if (ts.isConditionalExpression(unwrapped)) {
            recordCandidates(unwrapped);
            return (
                `(${this.context.conditions.compileCondition(unwrapped.condition)} ? ` +
                `${this.compileUiStyleString(unwrapped.whenTrue)} : ` +
                `${this.compileUiStyleString(unwrapped.whenFalse)})`
            );
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken
        ) {
            const containsConditional = (node: ts.Expression): boolean => {
                const current = this.context.unwrap(node);
                return (
                    ts.isConditionalExpression(current) ||
                    (ts.isBinaryExpression(current) &&
                        current.operatorToken.kind ===
                            ts.SyntaxKind.PlusToken &&
                        (containsConditional(current.left) ||
                            containsConditional(current.right)))
                );
            };
            if (containsConditional(unwrapped)) {
                recordCandidates(unwrapped);
                return (
                    `std::string(${this.compileUiStyleString(unwrapped.left)}) + ` +
                    this.compileUiStyleString(unwrapped.right)
                );
            }
        }
        const sourceParts = this.collectUiStringParts(unwrapped);
        if (sourceParts) {
            const substitutions: ts.Expression[] = [];
            let source = "";
            for (const part of sourceParts) {
                if (typeof part === "string") {
                    source += part;
                } else {
                    source += `__BBLITE_UI_STYLE_${substitutions.length}__`;
                    substitutions.push(part);
                }
            }
            const lowered = this.lowerUiAttributeLiteral(
                "style",
                source,
                expression,
            );
            if (ownerId !== undefined) {
                const owner = this.uiStaticElements.get(ownerId);
                if (owner) this.recordUiStaticStyles(owner, [lowered]);
            }
            const chunks = lowered.split(
                /(__BBLITE_UI_(?:STYLE|ASSET)_\d+__)/g,
            );
            const parts: string[] = [];
            for (const chunk of chunks) {
                if (!chunk) continue;
                const marker = chunk.match(
                    /^__BBLITE_UI_(STYLE|ASSET)_(\d+)__$/,
                );
                if (!marker) {
                    parts.push(this.context.cppString(chunk));
                    continue;
                }
                const substitution = this.uiTemplateSubstitutionCpp(
                    substitutions[Number(marker[2])]!,
                    "Native UI cssText",
                );
                parts.push(substitution);
            }
            this.context.reachJsData();
            return `bbl::js::concat(${parts.join(", ")})`;
        }
        this.context.fail(
            expression,
            "Native UI cssText must be a template or static fragments joined by string concatenation or a conditional.",
        );
    }

    /** Classify missing CSS runtime work without swallowing a compiler refusal. */
    private deferredUiStyleCapabilities(
        expression: ts.Expression,
        sheet: boolean,
    ): string[] {
        if (!this.context.options.deferredCapabilities) return [];
        let source = this.tryUiStaticString(expression);
        if (source === undefined) {
            if (sheet) return ["css:runtime-stylesheet-installation-bridge"];
            const parts = this.collectUiStringParts(expression);
            if (!parts) {
                // Conditional/concatenated structures have an existing lowering
                // path. Leave its branch-specific admission authoritative.
                const node = this.context.unwrap(expression);
                return ts.isConditionalExpression(node) ||
                    ts.isBinaryExpression(node)
                    ? []
                    : ["css:runtime-declaration-installation-bridge"];
            }
            source = parts
                .map((part) =>
                    typeof part === "string" ? part : "__BBLITE_DYNAMIC_CSS__",
                )
                .join("");
        }
        const capabilities = new Set<string>();
        const visit = (declarations: string): void => {
            UiProjection.forEachUiStyleDeclaration(
                stripUiCssComments(declarations),
                (declaration) => {
                    const colon = declaration.indexOf(":");
                    if (colon < 0) return;
                    const property = UiProjection.cssPropertyName(
                        declaration.slice(0, colon).trim(),
                    );
                    const capability = deferredUiStyleCapability(
                        property,
                        declaration.slice(colon + 1).trim(),
                    );
                    if (capability) capabilities.add(capability);
                },
            );
        };
        if (sheet) visitUiStyleSheetDeclarations(source, visit);
        else visit(source);
        return [...capabilities];
    }

    /** Evaluate the retained receiver and string normally, then fail at installation. */
    private emitDeferredUiStyle(
        element: Value,
        expression: ts.Expression,
        site: ts.Node,
        capabilities: readonly string[],
        signature: string,
    ): boolean {
        if (!this.context.options.deferredCapabilities || !capabilities.length)
            return false;
        pinDetached(this.context, element, "style_receiver");
        const cpp = this.uiStringCpp(expression, "Deferred UI style operation");
        this.context.emitDiscardedValue({ kind: "string", cpp });
        for (const id of capabilities) {
            const trap = this.context.deferredCapabilities.emitKnown(site, {
                id,
                origin: "css",
                operation: "write",
                signature,
                timing: "throw",
            });
            if (trap) this.context.emitDiscardedValue(trap);
        }
        return true;
    }

    private lowerUiMarkupLiteral(
        value: string,
        site?: ts.Node,
        ownerId?: number,
    ): string {
        const fail = (message: string): never => {
            if (site) this.context.fail(site, `Native UI innerHTML ${message}`);
            this.context.failAtFile(`Native UI innerHTML ${message}`);
        };
        const roots: UiStaticMarkupNode[] = [];
        const stack: UiStaticMarkupNode[] = [];
        const output: string[] = [];
        let nextMarkupNodeId =
            ownerId === undefined
                ? 0
                : (this.uiMarkupNodeIds.get(ownerId) ?? 0);
        const svgPaintStack: Array<{
            usesCurrentColor: boolean;
            usesLiteralPaint: boolean;
            fill: string;
            stroke: string;
            openingOutputIndex?: number;
        }> = [];
        const escapeAttribute = (text: string): string =>
            text
                .replaceAll("&", "&amp;")
                .replaceAll('"', "&quot;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;");
        const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
        const color =
            /^(?:none|currentColor|#[0-9a-f]{3,8}|rgba?\([^)]*\)|[a-z][a-z0-9-]*)$/i;
        const pathData =
            /^(?:(?:[MmLlHhVvCcSsQqTtAaZz])|(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)|[\s,])*$/;
        const svgAttributeSchemas: Record<
            "svg" | "path" | "rect",
            {
                allowed: ReadonlySet<string>;
                numeric: ReadonlySet<string>;
            }
        > = {
            svg: {
                allowed: new EmissionSet([
                    "viewbox",
                    "fill",
                    "stroke",
                    "stroke-width",
                    "stroke-linecap",
                    "stroke-linejoin",
                    "width",
                    "height",
                    "xmlns",
                ]),
                numeric: new EmissionSet(["width", "height", "stroke-width"]),
            },
            path: {
                allowed: new EmissionSet([
                    "d",
                    "fill",
                    "stroke",
                    "stroke-width",
                    "stroke-linecap",
                    "stroke-linejoin",
                ]),
                numeric: new EmissionSet(["stroke-width"]),
            },
            rect: {
                allowed: new EmissionSet([
                    "x",
                    "y",
                    "width",
                    "height",
                    "rx",
                    "ry",
                    "fill",
                    "stroke",
                    "stroke-width",
                ]),
                numeric: new EmissionSet([
                    "x",
                    "y",
                    "width",
                    "height",
                    "rx",
                    "ry",
                    "stroke-width",
                ]),
            },
        };
        let cursor = 0;
        while (cursor < value.length) {
            const opening = value.indexOf("<", cursor);
            if (opening < 0) {
                const text = value.slice(cursor);
                if (
                    stack.some((node) => node.tag === "svg") &&
                    text.trim().length > 0
                ) {
                    fail("does not support text inside <svg>.");
                }
                output.push(text);
                break;
            }
            const text = value.slice(cursor, opening);
            if (
                stack.some((node) => node.tag === "svg") &&
                text.trim().length > 0
            ) {
                fail("does not support text inside <svg>.");
            }
            output.push(text);

            let quote = "";
            let closing = opening + 1;
            for (; closing < value.length; closing++) {
                const character = value[closing]!;
                if (quote) {
                    if (character === quote && value[closing - 1] !== "\\") {
                        quote = "";
                    }
                } else if (character === "'" || character === '"') {
                    quote = character;
                } else if (character === ">") {
                    break;
                }
            }
            if (closing >= value.length) fail("contains an unterminated tag.");
            let token = value.slice(opening + 1, closing).trim();
            cursor = closing + 1;
            if (token.startsWith("!") || token.startsWith("?")) {
                fail(`does not support '<${token}>'.`);
            }
            if (token.startsWith("/")) {
                const tag = token.slice(1).trim().toLowerCase();
                if (!/^(?:div|span|h1|h2|p|button|b|strong|a|svg)$/.test(tag)) {
                    fail(`does not support closing tag '</${tag}>'.`);
                }
                const current = stack.pop();
                if (!current || current.tag !== tag) {
                    fail(`has mismatched closing tag '</${tag}>'.`);
                }
                if (tag === "svg") {
                    const paint = svgPaintStack.pop()!;
                    if (
                        paint.usesCurrentColor &&
                        paint.openingOutputIndex !== undefined
                    ) {
                        const openingTag = output[paint.openingOutputIndex]!;
                        output[paint.openingOutputIndex] =
                            openingTag.slice(0, -1) +
                            ' data-bbl-current-color="true">';
                    }
                }
                output.push(`</${tag}>`);
                continue;
            }

            const selfClosing = /\/\s*$/.test(token);
            if (selfClosing) token = token.replace(/\/\s*$/, "").trim();
            const tagMatch =
                token.match(/^([A-Za-z][A-Za-z0-9-]*)/) ??
                fail(`contains invalid tag '<${token}>'.`);
            const tag = tagMatch[1]!.toLowerCase();
            const insideSvg = stack.some((node) => node.tag === "svg");
            const svgPaint =
                tag === "svg"
                    ? {
                          usesCurrentColor: false,
                          usesLiteralPaint: false,
                          fill: "black",
                          stroke: "none",
                      }
                    : insideSvg
                      ? svgPaintStack[svgPaintStack.length - 1]
                      : undefined;
            if (
                (!insideSvg &&
                    !/^(?:div|span|h1|h2|p|button|b|strong|a|img|svg)$/.test(
                        tag,
                    )) ||
                (insideSvg && !/^(?:path|rect)$/.test(tag))
            ) {
                fail(`tag '<${tag}>' is outside the bounded HTML/SVG subset.`);
            }
            if (
                tag !== "img" &&
                (tag === "path" || tag === "rect") !== selfClosing
            ) {
                fail(`<${tag}> must use the self-closing form.`);
            }
            if (
                /^(?:div|span|h1|h2|p|button|b|strong|a|svg)$/.test(tag) &&
                selfClosing
            ) {
                fail(`<${tag}> must have an explicit closing tag.`);
            }

            const attributes: Array<{ name: string; value: string }> = [];
            let attributeText = token.slice(tagMatch[0].length);
            while (attributeText.trim().length > 0) {
                attributeText = attributeText.trimStart();
                const attribute =
                    attributeText.match(
                        /^([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*=\s*(["'])([\s\S]*?)\2|(?=\s|$))/,
                    ) ??
                    fail(
                        `tag '<${tag}>' has an invalid or unquoted attribute.`,
                    );
                if (
                    attribute[3] === undefined &&
                    !/^(?:hidden|disabled)$/i.test(attribute[1]!)
                )
                    fail(
                        `tag '<${tag}>' has an invalid or unquoted attribute.`,
                    );
                attributes.push({
                    name: attribute[1]!,
                    value: attribute[3] ?? "",
                });
                attributeText = attributeText.slice(attribute[0].length);
            }

            const classes = new EmissionSet<string>();
            const attributeNames = new EmissionSet<string>();
            const loweredAttributes: Array<{ name: string; value: string }> =
                [];
            const validateSharedSvgAttribute = (
                name: string,
                lowerName: string,
                value: string,
            ): string => {
                if (
                    (lowerName === "fill" || lowerName === "stroke") &&
                    !color.test(value)
                ) {
                    fail(
                        `attribute '${name}' on <${tag}> has an unsupported color.`,
                    );
                }
                if (
                    lowerName === "stroke-linecap" &&
                    !/^(?:butt|round|square)$/.test(value)
                ) {
                    fail(
                        "attribute 'stroke-linecap' has an unsupported value.",
                    );
                }
                if (
                    lowerName === "stroke-linejoin" &&
                    !/^(?:miter|round|bevel)$/.test(value)
                ) {
                    fail(
                        "attribute 'stroke-linejoin' has an unsupported value.",
                    );
                }
                return value.toLowerCase() === "currentcolor" ? "white" : value;
            };
            for (const attribute of attributes) {
                const name = attribute.name;
                const lowerName = name.toLowerCase();
                if (attributeNames.has(lowerName)) {
                    fail(`attribute '${name}' is duplicated on <${tag}>.`);
                }
                attributeNames.add(lowerName);
                if (attribute.value.includes("__BBLITE_UI_MARKUP_")) {
                    fail(`requires static attribute '${name}' on <${tag}>.`);
                }
                let attributeValue = attribute.value;
                if (!insideSvg && tag !== "svg") {
                    const allowed = new EmissionSet([
                        "class",
                        "style",
                        "id",
                        "role",
                        "hidden",
                        "draggable",
                        ...(tag === "button" ? ["type", "disabled"] : []),
                        ...(tag === "a" ? ["href", "target", "rel"] : []),
                        ...(tag === "img"
                            ? ["src", "alt", "width", "height", "fetchpriority"]
                            : []),
                    ]);
                    const metadata =
                        /^(?:aria|data)-[a-z][a-z0-9_.-]*$/.test(lowerName) &&
                        !lowerName.startsWith("data-bbl-");
                    if (!allowed.has(lowerName) && !metadata) {
                        fail(
                            `attribute '${name}' is not supported on <${tag}>.`,
                        );
                    }
                    if (tag === "img" && lowerName === "src") {
                        this.registerImageSource(attributeValue);
                    } else if (
                        tag === "img" &&
                        (lowerName === "width" || lowerName === "height") &&
                        !/^\d+$/.test(attributeValue)
                    ) {
                        fail(
                            `<img> ${lowerName} requires a nonnegative integer.`,
                        );
                    } else if (lowerName === "class") {
                        for (const className of attributeValue
                            .split(/\s+/)
                            .filter(Boolean)) {
                            if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(className)) {
                                fail(`class '${className}' is not valid.`);
                            }
                            classes.add(className);
                        }
                    } else if (lowerName === "hidden") {
                        attributeValue = this.lowerUiAttributeLiteral(
                            lowerName,
                            attributeValue,
                            site,
                        );
                    } else if (
                        lowerName === "draggable" &&
                        attributeValue.toLowerCase() !== "false"
                    ) {
                        fail(
                            "draggable supports only 'false'; authored drags are unavailable.",
                        );
                    } else if (
                        lowerName === "fetchpriority" &&
                        !/^(?:auto|high|low)$/i.test(attributeValue)
                    ) {
                        fail("<img> fetchpriority requires auto, high or low.");
                    } else if (lowerName === "style") {
                        attributeValue = this.lowerUiAttributeLiteral(
                            "style",
                            attributeValue,
                            site,
                        );
                        if (/^(?:div|h1|h2|p)$/.test(tag)) {
                            attributeValue = `display:block;${attributeValue}`;
                        }
                    } else if (
                        lowerName === "type" &&
                        attributeValue.toLowerCase() !== "button"
                    ) {
                        fail("<button> supports only type='button'.");
                    } else if (
                        lowerName === "href" &&
                        !/^https:\/\//i.test(attributeValue)
                    ) {
                        fail("<a> requires a static HTTPS href.");
                    } else if (
                        lowerName === "target" &&
                        attributeValue !== "_blank"
                    ) {
                        fail("<a> supports only target='_blank'.");
                    } else if (
                        lowerName === "rel" &&
                        attributeValue !== "noopener"
                    ) {
                        fail("<a> supports only rel='noopener'.");
                    }
                } else {
                    const svgTag = tag as keyof typeof svgAttributeSchemas;
                    const schema = svgAttributeSchemas[svgTag];
                    if (!schema.allowed.has(lowerName)) {
                        fail(
                            `attribute '${name}' is not supported on <${tag}>.`,
                        );
                    }
                    if (
                        schema.numeric.has(lowerName) &&
                        !numeric.test(attributeValue)
                    ) {
                        fail(
                            `attribute '${name}' on <${tag}> must be numeric.`,
                        );
                    }
                    if (
                        tag === "path" &&
                        lowerName === "d" &&
                        !pathData.test(attributeValue)
                    ) {
                        fail(
                            "attribute 'd' contains unsupported SVG path data.",
                        );
                    }
                    if (
                        tag === "svg" &&
                        lowerName === "viewbox" &&
                        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\s+[+-]?(?:\d+(?:\.\d*)?|\.\d+)){3}$/.test(
                            attributeValue.trim(),
                        )
                    ) {
                        fail("attribute 'viewBox' must contain four numbers.");
                    }
                    if (
                        tag === "svg" &&
                        lowerName === "xmlns" &&
                        attributeValue !== "http://www.w3.org/2000/svg"
                    ) {
                        fail("attribute 'xmlns' has an unsupported value.");
                    }
                }
                if (tag === "svg" || tag === "path" || tag === "rect") {
                    attributeValue = validateSharedSvgAttribute(
                        name,
                        lowerName,
                        attributeValue,
                    );
                }
                if (
                    tag === "svg" &&
                    svgPaint &&
                    (lowerName === "fill" || lowerName === "stroke")
                ) {
                    svgPaint[lowerName] = attribute.value.trim().toLowerCase();
                }
                loweredAttributes.push({
                    name: lowerName === "viewbox" ? "viewBox" : lowerName,
                    value: attributeValue,
                });
            }
            if ((tag === "path" || tag === "rect") && svgPaint) {
                const declaredPaint = (name: "fill" | "stroke"): string =>
                    attributes
                        .find(
                            (attribute) =>
                                attribute.name.toLowerCase() === name,
                        )
                        ?.value.trim()
                        .toLowerCase() ?? svgPaint[name];
                for (const paint of [
                    declaredPaint("fill"),
                    declaredPaint("stroke"),
                ]) {
                    if (paint === "none") continue;
                    if (paint === "currentcolor") {
                        svgPaint.usesCurrentColor = true;
                    } else {
                        svgPaint.usesLiteralPaint = true;
                    }
                }
                if (svgPaint.usesCurrentColor && svgPaint.usesLiteralPaint) {
                    fail(
                        "cannot mix currentColor with literal SVG paints (including the implicit default fill:black) because whole-image tinting would recolor the other paint; 'none' is non-paint.",
                    );
                }
            }
            if (tag === "path" && !attributeNames.has("d")) {
                fail("<path> requires static path data in attribute 'd'.");
            }
            if (
                tag === "rect" &&
                !["x", "y", "width", "height"].every((name) =>
                    attributeNames.has(name),
                )
            ) {
                fail("<rect> requires static x, y, width, and height.");
            }
            const node: UiStaticMarkupNode = {
                id: nextMarkupNodeId++,
                tag,
                classes,
                attributes: new EmissionMap(
                    loweredAttributes.map(({ name, value }) => [
                        name.toLowerCase(),
                        value,
                    ]),
                ),
                children: [],
            };
            const parent = stack[stack.length - 1];
            if (parent) parent.children.push(node);
            else roots.push(node);
            const renderedAttributes = loweredAttributes
                .map(
                    ({ name, value: attributeValue }) =>
                        ` ${name}="${escapeAttribute(attributeValue)}"`,
                )
                .join("");
            output.push(
                `<${tag}${renderedAttributes} data-bbl-node="${node.id}"${selfClosing || tag === "img" ? "/" : ""}>`,
            );
            if (tag === "svg") {
                svgPaint!.openingOutputIndex = output.length - 1;
            }
            if (!selfClosing && tag !== "img") {
                stack.push(node);
                if (tag === "svg") svgPaintStack.push(svgPaint!);
            }
            if (tag === "svg") {
                this.context.reachFeature("ui:inline-svg", site);
            }
        }
        if (stack.length > 0) {
            fail(
                `is missing closing tag '</${stack[stack.length - 1]!.tag}>'.`,
            );
        }
        if (ownerId !== undefined)
            this.uiMarkupNodeIds.set(ownerId, nextMarkupNodeId);
        this.recordUiStaticMarkup(ownerId, roots);
        return output.join("");
    }

    private compileUiMarkupString(
        expression: ts.Expression,
        ownerId?: number,
    ): string {
        const staticValue = this.tryUiStaticString(expression);
        if (staticValue !== undefined) {
            return this.context.cppString(
                this.lowerUiMarkupLiteral(staticValue, expression, ownerId),
            );
        }
        const unwrapped = this.context.unwrap(expression);
        if (ts.isConditionalExpression(unwrapped)) {
            return this.compileUiStructuredMarkup(expression, ownerId);
        }
        const sourceParts = this.collectUiStringParts(unwrapped);
        if (
            !sourceParts ||
            sourceParts.some(
                (part) =>
                    typeof part !== "string" &&
                    (ts.isConditionalExpression(this.context.unwrap(part)) ||
                        this.uiStoredMarkupShape(part)),
            )
        )
            return this.compileUiStructuredMarkup(expression, ownerId);
        const substitutions: ts.Expression[] = [];
        let source = "";
        for (const part of sourceParts) {
            if (typeof part === "string") {
                source += part;
            } else {
                source += `__BBLITE_UI_MARKUP_${substitutions.length}__`;
                substitutions.push(part);
            }
        }
        const lowered = this.lowerUiMarkupLiteral(source, expression, ownerId);
        this.context.reachJsData();
        return this.uiMarkupConcat(lowered, (index) =>
            this.uiTemplateSubstitutionCpp(
                substitutions[index]!,
                "Native UI innerHTML",
                true,
            ),
        );
    }

    private uiMarkupConcat(
        lowered: string,
        substitution: (index: number) => string,
    ): string {
        const chunks = lowered.split(/(__BBLITE_UI_MARKUP_\d+__)/g);
        const parts: string[] = [];
        for (const chunk of chunks) {
            if (!chunk) continue;
            const marker = chunk.match(/^__BBLITE_UI_MARKUP_(\d+)__$/);
            if (!marker) {
                parts.push(this.context.cppString(chunk));
                continue;
            }
            parts.push(
                `bbl::ui_escape_rml(${substitution(Number(marker[1]))})`,
            );
        }
        return `bbl::js::concat(${parts.join(", ")})`;
    }

    private uiStoredMarkupShape(
        expression: ts.Expression,
    ): UiMarkupShape | undefined {
        const shape = uiMarkupValueShape(expression, {
            checker: this.context.checker,
            immutable: (node) =>
                this.context.bindings.isImmutableVariable(node),
            rebound: (node) =>
                this.context.sharedClosures.identifierIsRebound(node),
        });
        return shape.some(
            (part) => typeof part === "string" && /[<>]/.test(part),
        )
            ? shape
            : undefined;
    }

    /** Closed structure is parsed after branches are selected; runtime text remains escaped. */
    private compileUiStructuredMarkup(
        expression: ts.Expression,
        ownerId?: number,
    ): string {
        const collect = (source: ts.Expression): UiMarkupPart[] => {
            const exact = this.tryUiStaticString(source);
            if (exact !== undefined) return [exact];
            const node = this.context.unwrap(source);
            if (ts.isTemplateExpression(node))
                return [
                    node.head.text,
                    ...node.templateSpans.flatMap((span) => [
                        ...collect(span.expression),
                        span.literal.text,
                    ]),
                ];
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
                (this.context.checker.getTypeAtLocation(node).flags &
                    ts.TypeFlags.StringLike) !==
                    0
            )
                return [...collect(node.left), ...collect(node.right)];
            if (ts.isConditionalExpression(node))
                return [
                    {
                        kind: "choice",
                        condition: node.condition,
                        yes: collect(node.whenTrue),
                        no: collect(node.whenFalse),
                    },
                ];
            const shape = this.uiStoredMarkupShape(node);
            if (shape) {
                if (shape.filter((part) => part === null).length > 1)
                    this.context.fail(
                        source,
                        "Native UI stored markup requires one runtime text span within fixed authored fragments.",
                    );
                return [{ kind: "stored", expression: source, shape }];
            }
            return [{ kind: "text", expression: source }];
        };
        const sourceParts = collect(expression);
        if (
            sourceParts.length === 1 &&
            typeof sourceParts[0] !== "string" &&
            sourceParts[0]?.kind === "text"
        )
            this.context.fail(
                expression,
                "Native UI innerHTML requires closed authored markup provenance.",
            );
        let remaining = 32;
        const hasChoices = (parts: readonly UiMarkupPart[]): boolean =>
            parts.some(
                (part) => typeof part !== "string" && part.kind === "choice",
            );
        if (ownerId !== undefined && hasChoices(sourceParts))
            this.uiMarkupAlternativeOwners.add(ownerId);
        const snapshot = (source: ts.Expression): string => {
            const value = this.context.bindings.pinValueToTemporary(
                this.context.compileValue(source),
                "markup_text",
                source,
            );
            return this.uiTemplateValueCpp(
                value,
                source,
                "Native UI innerHTML",
            );
        };
        const emit = (
            pending: readonly UiMarkupPart[],
            prefix: string,
            substitutions: readonly string[],
        ): string => {
            let source = prefix;
            const values = [...substitutions];
            const text = (cpp: string): void => {
                source += `__BBLITE_UI_MARKUP_${values.length}__`;
                values.push(cpp);
            };
            for (let index = 0; index < pending.length; index++) {
                const part = pending[index]!;
                if (typeof part === "string") source += part;
                else if (part.kind === "text") text(snapshot(part.expression));
                else if (part.kind === "stored") {
                    const value = snapshot(part.expression);
                    const hole = part.shape.indexOf(null);
                    if (hole < 0) source += part.shape.join("");
                    else {
                        const before = part.shape.slice(0, hole).join("");
                        const after = part.shape.slice(hole + 1).join("");
                        source += before;
                        text(
                            `bbl::js::string_substring(${value}, ${before.length}, bbl::js::string_length(${value}) - ${after.length})`,
                        );
                        source += after;
                    }
                } else {
                    const condition = this.context.conditions.compileCondition(
                        part.condition,
                    );
                    const branch = (parts: UiMarkupPart[]): string => {
                        let result = "";
                        const lines = this.context.captureEmittedLines(() => {
                            this.context.enterRuntimeControlFlow();
                            try {
                                result = emit(
                                    [...parts, ...pending.slice(index + 1)],
                                    source,
                                    values,
                                );
                            } finally {
                                this.context.leaveRuntimeControlFlow();
                            }
                        });
                        return `${lines.join("\n")}\nreturn ${result};`;
                    };
                    return `([&]() -> std::string { if (${condition}) {\n${branch(part.yes)}\n} else {\n${branch(part.no)}\n} }())`;
                }
            }
            if (--remaining < 0)
                this.context.fail(
                    expression,
                    "Native UI innerHTML exceeds 32 closed markup alternatives.",
                );
            const lowered = this.lowerUiMarkupLiteral(
                source,
                expression,
                ownerId,
            );
            return this.uiMarkupConcat(lowered, (index) => values[index]!);
        };
        this.context.reachJsData();
        return emit(sourceParts, "", []);
    }

    /**
     * `element.on<type> = handler`: the HTML event handler of an event the
     * element's listeners represent. The first handler joins the listeners in
     * registration order, a later one replaces it in place and `null` removes
     * it. A handler that can return `false` (which cancels the event) and
     * events without a native listener family refuse.
     */
    private emitUiEventHandlerProperty(
        element: Value,
        property: string,
        receiver: ts.Expression,
        assignment: ts.BinaryExpression,
    ): void {
        const type = property.slice(2);
        const handlerType = this.context.checker.getTypeAtLocation(
            assignment.right,
        );
        const nullish =
            (handlerType.flags &
                (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !==
            0;
        if (!nullish && handlerType.getCallSignatures().length === 0)
            this.context.fail(
                assignment.right,
                `Native UI event handler property '${property}' requires a function or null.`,
            );
        const handler = nullish ? undefined : assignment.right;
        if (handler)
            this.context.callbacks.hoistForwardCallbackBindings(handler);
        if (element.uiFileInput && (type === "change" || type === "input"))
            this.context.reachFeature("browser:file", assignment);
        const family = elementDomHandlerFamily(type);
        if (!family)
            this.context.fail(
                assignment.left,
                `Native UI event handler property '${property}' is not lowered: '${type}' has no native element listener.`,
            );
        emitDomEventHandler(
            this.context,
            element,
            family,
            type,
            handler,
            receiver,
        );
    }

    /**
     * The content attribute a string IDL attribute reflects. `type` is an
     * enumerated attribute whose missing value is not empty, so only its
     * writes reflect; min/max/step belong to inputs.
     */
    public reflectedUiAttribute(
        element: Value,
        property: string,
        receiver: ts.Expression,
        site: ts.Node,
    ): UiReflectedAttribute | undefined {
        const reflected = UI_REFLECTED_ATTRIBUTES.get(property);
        if (
            reflected?.tag !== undefined &&
            this.declaredUiTag(element, receiver) !== reflected.tag
        )
            this.context.fail(
                site,
                `UI ${property} requires an ${reflected.tag} element.`,
            );
        return reflected;
    }

    /** Retained controls dispatching input and change from their own state. */
    public isUiFormControl(element: Value, expression: ts.Expression): boolean {
        return ["input", "textarea", "select"].includes(
            this.declaredUiTag(element, expression) ?? "",
        );
    }

    /**
     * A per-element listener or handler outside shared DOM dispatch (form
     * input/change, a file input's change): it receives a borrowed mouse
     * event view. A handler's false result cancels its event.
     */
    public compileUiElementCallback(
        callback: ts.Expression,
        handler = false,
    ): string {
        const parameter =
            this.context.allocateTemporaryCppName("ui_pointer_event");
        return this.context.callbacks.compilePlatformCallback(
            callback,
            { cppType: "const bbl::PlatformMouseEvent&", name: parameter },
            [{ kind: "platform-mouse-event", cpp: parameter, readOnly: true }],
            undefined,
            true,
            false,
            handler
                ? eventHandlerResult(this.context, parameter, callback)
                : undefined,
        ).cpp;
    }

    public compileUiBrowserFileAttribute(
        element: Value,
        engine: string,
        name: string,
        value: ts.Expression,
        site: ts.Node,
        syntax: "property" | "attribute",
    ): string | undefined {
        if (element.uiTag === "input") {
            if (
                name === "multiple" ||
                name === "webkitdirectory" ||
                name === "directory"
            ) {
                this.context.fail(
                    site,
                    `File input ${syntax} '${name}' is not supported; the native picker accepts one file and no directories.`,
                );
            }
            if (name === "type") {
                const inputType = this.context
                    .compileStringLiteral(value)
                    .toLowerCase();
                if (inputType !== "file") {
                    if (
                        [
                            "text",
                            "password",
                            "range",
                            "checkbox",
                            "color",
                        ].includes(inputType) &&
                        !element.uiFileInput
                    ) {
                        return `bbl::ui_set_attribute(${engine}, ${element.cpp}, "type", ${this.context.cppString(inputType)})`;
                    }
                    this.context.fail(
                        value,
                        `Retained native <input> type '${inputType}' is not represented; static text, password, range, checkbox, color and file inputs are supported, without changing a file input into another control.`,
                    );
                }
                writable(element).uiFileInput = true;
                this.context.reachFeature("browser:file", site);
                return `bbl::ui_set_file_input(${engine}, ${element.cpp})`;
            }
            if (name === "accept") {
                if (!element.uiFileInput) {
                    this.context.fail(
                        site,
                        "input accept requires a preceding static type='file'.",
                    );
                }
                const accept = validateFileAccept(
                    this.context,
                    this.context.compileStringLiteral(value),
                    value,
                );
                this.context.reachFeature("browser:file", site);
                return (
                    `bbl::ui_set_file_accept(${engine}, ${element.cpp}, ` +
                    `${this.context.cppString(accept)})`
                );
            }
        }
        if (element.uiTag !== "a") return undefined;
        if (name === "href") {
            const url = this.context.compileValue(value);
            this.context.expectKind(url, "object-url", value);
            this.context.expectSameEngine(element, url, site);
            this.context.reachFeature("browser:file", site);
            return `bbl::ui_set_download_url(${engine}, ${element.cpp}, ${url.cpp})`;
        }
        if (name === "download") {
            this.context.reachFeature("browser:file", site);
            return (
                `bbl::ui_set_download_name(${engine}, ${element.cpp}, ` +
                `${this.uiStringCpp(value, "anchor download")})`
            );
        }
        return undefined;
    }

    public emitUiPropertyAssignment(expression: ts.BinaryExpression): boolean {
        const globalLeft = this.context.unwrap(expression.left);
        if (
            this.context.options.workers &&
            expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(globalLeft) &&
            ts.isPropertyAccessExpression(globalLeft.expression) &&
            globalLeft.expression.name.text === "dataset" &&
            this.compileUiElementReceiver(globalLeft.expression.expression)
        )
            this.context.fail(
                expression,
                "Compound retained dataset assignments require a represented attribute update.",
            );
        if (
            expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(globalLeft) &&
            (globalLeft.name.text === "textContent" ||
                globalLeft.name.text === "innerText") &&
            this.compileUiElementReceiver(globalLeft.expression)
        )
            this.context.fail(
                expression,
                "Compound retained text assignments require a represented text getter.",
            );
        if (
            this.context.hasFeature("engine:device-recovery") &&
            ts.isPropertyAccessExpression(globalLeft) &&
            ts.isIdentifier(this.context.unwrap(globalLeft.expression)) &&
            this.context.unwrap(globalLeft.expression).getText() ===
                "globalThis" &&
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            (ts.isArrowFunction(expression.right) ||
                ts.isFunctionExpression(expression.right))
        ) {
            this.context.emit({
                kind: "expression",
                code: `bbl::set_global_callback(${this.context.requireDefaultEngine(expression)}, ${this.context.cppString(globalLeft.name.text)}, ${this.context.callbacks.compileVoidCallback(expression.right)});`,
            });
            return true;
        }
        const canvasDataset = this.primaryCanvasDataset(expression.left);
        if (
            canvasDataset &&
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
            if (canvasDataset === "ready") this.primaryCanvasReadyGate = true;
            this.context.emit({
                kind: "expression",
                code: `bbl::set_canvas_dataset(${this.context.requireDefaultEngine(expression)}, ${this.context.cppString(canvasDataset)}, ${this.uiStringCpp(expression.right, "Dataset assignment")});`,
            });
            return true;
        }
        if (
            expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
            !ts.isPropertyAccessExpression(expression.left)
        ) {
            return false;
        }
        const property = expression.left.name.text;
        const dataset = this.context.unwrap(expression.left.expression);
        if (
            this.context.options.workers &&
            ts.isPropertyAccessExpression(dataset) &&
            dataset.name.text === "dataset"
        ) {
            const element = this.compileUiElementReceiver(dataset.expression);
            if (element) {
                if (
                    property === "ready" &&
                    this.context.isCanvasElement(dataset.expression)
                )
                    this.windowCanvasReadyGate = true;
                const name = `data-${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
                this.context.emit({
                    kind: "expression",
                    code: `bbl::ui_set_attribute(${this.context.requireEngine(element, dataset)}, ${element.cpp}, ${this.context.cppString(name)}, ${this.uiStringCpp(expression.right, "Dataset assignment")});`,
                });
                return true;
            }
        }
        const directElement = this.compileUiElementReceiver(
            expression.left.expression,
        );
        if (directElement) {
            const deferredProperty = this.context.deferredCapabilities.property(
                expression.left,
                directElement,
                expression.right,
            );
            if (deferredProperty) {
                this.context.emit({
                    kind: "expression",
                    code: `${deferredProperty.cpp};`,
                });
                return true;
            }
            const engine = this.context.requireEngine(
                directElement,
                expression.left,
            );
            if (property === "checked") {
                if (directElement.uiTag && directElement.uiTag !== "input")
                    this.context.fail(
                        expression.left,
                        "UI checked requires an input element.",
                    );
                this.context.emit({
                    kind: "expression",
                    code: `bbl::ui_set_checked(${engine}, ${directElement.cpp}, ${this.uiBooleanCpp(expression.right, "UI checked")});`,
                });
                return true;
            }
            if (property === "selected") {
                if (directElement.uiTag && directElement.uiTag !== "option")
                    this.context.fail(
                        expression.left,
                        "UI selected requires an option element.",
                    );
                this.context.emit({
                    kind: "expression",
                    code: `bbl::ui_set_selected(${engine}, ${directElement.cpp}, ${this.uiBooleanCpp(expression.right, "UI selected")});`,
                });
                return true;
            }
            const booleanAttribute = this.booleanAttribute(
                directElement,
                property,
                expression.left,
            );
            if (booleanAttribute) {
                this.context.emit({
                    kind: "expression",
                    code: `bbl::ui_set_boolean_attribute(${engine}, ${directElement.cpp}, ${this.context.cppString(booleanAttribute)}, ${this.uiBooleanCpp(expression.right, `UI ${booleanAttribute}`)});`,
                });
                return true;
            }
            if (
                property === "value" &&
                ["textarea", "input", "select", "option", "output"].includes(
                    this.declaredUiTag(
                        directElement,
                        expression.left.expression,
                    ) ?? "",
                ) &&
                !directElement.uiFileInput
            ) {
                this.context.emit({
                    kind: "expression",
                    code: `bbl::ui_set_form_value(${engine}, ${directElement.cpp}, ${this.uiStringCpp(expression.right, "Form value")});`,
                });
                return true;
            }
            const browserFile = this.compileUiBrowserFileAttribute(
                directElement,
                engine,
                property,
                expression.right,
                expression,
                "property",
            );
            if (browserFile) {
                this.context.emit({
                    kind: "expression",
                    code: `${browserFile};`,
                });
                return true;
            }
            if (/^on[a-z]+$/.test(property)) {
                this.emitUiEventHandlerProperty(
                    directElement,
                    property,
                    expression.left.expression,
                    expression,
                );
                return true;
            }
            if (
                directElement.uiCanvas &&
                !directElement.uiCanvasContext &&
                (property === "width" || property === "height")
            ) {
                // The probe and the emission still compile the RHS twice:
                // collapsing them to one `castNumber(size, "double")` is
                // semantically clean, but the duplicate resolution burns
                // anonymous-record counter numbers, and removing it
                // renumbers quake's record types (Record22 -> Record18).
                // Byte identity of generated/ wins until a renumbering
                // window is open.
                const staticSize = this.context.compileValue(
                    expression.right,
                ).staticNumber;
                if (
                    staticSize !== undefined &&
                    directElement.uiCanvasId !== undefined
                ) {
                    const sizes = this.uiCanvasStaticSizes.get(
                        directElement.uiCanvasId,
                    ) ?? { pairs: new EmissionSet<string>() };
                    writable(sizes)[property] = staticSize;
                    if (
                        sizes.width !== undefined &&
                        sizes.height !== undefined
                    ) {
                        sizes.pairs.add(`${sizes.width}x${sizes.height}`);
                    }
                    this.uiCanvasStaticSizes.set(
                        directElement.uiCanvasId,
                        sizes,
                    );
                }
                this.context.emit({
                    kind: "expression",
                    code:
                        `bbl::ui_canvas_set_${property}(${engine}, ${directElement.cpp}, ` +
                        `${this.context.compileNumber(expression.right, "double")});`,
                });
                return true;
            }
            if (directElement.uiCanvasContext) {
                if (property === "fillStyle" || property === "strokeStyle") {
                    this.context.emit({
                        kind: "expression",
                        code:
                            `bbl::ui_canvas_set_${property === "fillStyle" ? "fill_style" : "stroke_style"}(` +
                            `${engine}, ${directElement.cpp}, ` +
                            `${this.uiStringCpp(expression.right, `Canvas2D ${property}`)});`,
                    });
                    return true;
                }
                if (property === "lineWidth") {
                    this.context.emit({
                        kind: "expression",
                        code:
                            `bbl::ui_canvas_set_line_width(${engine}, ${directElement.cpp}, ` +
                            `${this.context.compileNumber(expression.right, "double")});`,
                    });
                    return true;
                }
                if (property === "lineJoin" || property === "lineCap") {
                    this.context.emit({
                        kind: "expression",
                        code:
                            `bbl::ui_canvas_set_${property === "lineJoin" ? "line_join" : "line_cap"}(` +
                            `${engine}, ${directElement.cpp}, ` +
                            `${this.uiStringCpp(expression.right, `Canvas2D ${property}`)});`,
                    });
                    return true;
                }
                if (property === "imageSmoothingEnabled") {
                    this.context.emit({
                        kind: "expression",
                        code:
                            `bbl::ui_canvas_set_image_smoothing(${engine}, ${directElement.cpp}, ` +
                            `${this.context.compileBoolean(expression.right)});`,
                    });
                    return true;
                }
                if (
                    property === "font" ||
                    property === "textBaseline" ||
                    property === "shadowColor"
                ) {
                    const runtimeProperty =
                        property === "textBaseline"
                            ? "text_baseline"
                            : property === "shadowColor"
                              ? "shadow_color"
                              : "font";
                    this.context.emit({
                        kind: "expression",
                        code:
                            `bbl::ui_canvas_set_${runtimeProperty}(${engine}, ${directElement.cpp}, ` +
                            `${this.uiStringCpp(expression.right, `Canvas2D ${property}`)});`,
                    });
                    return true;
                }
                if (property === "shadowBlur") {
                    this.context.emit({
                        kind: "expression",
                        code:
                            `bbl::ui_canvas_set_shadow_blur(${engine}, ${directElement.cpp}, ` +
                            `${this.context.compileNumber(expression.right, "double")});`,
                    });
                    return true;
                }
            }
            if (property === "textContent" || property === "innerText") {
                this.recordUiStaticReplaceChildren(directElement);
                let textCpp: string;
                if (
                    this.uiCreatedElementTag(expression.left.expression) ===
                    "style"
                ) {
                    if (
                        this.emitDeferredUiStyle(
                            directElement,
                            expression.right,
                            expression,
                            this.deferredUiStyleCapabilities(
                                expression.right,
                                true,
                            ),
                            `HTMLStyleElement.${property}: string`,
                        )
                    )
                        return true;
                    const sheet = this.context.compileStringLiteral(
                        expression.right,
                    );
                    textCpp = this.context.cppString(sheet);
                    for (const code of this.uiStyleSheetRuleStatements(
                        engine,
                        directElement.cpp,
                        sheet,
                        expression.right,
                        directElement.uiStaticId,
                    ))
                        this.context.emit({ kind: "expression", code });
                } else {
                    textCpp = this.uiStringCpp(
                        expression.right,
                        `UI ${property}`,
                    );
                }
                this.context.emit({
                    kind: "expression",
                    code:
                        `bbl::ui_set_text(${engine}, ${directElement.cpp}, ` +
                        `${textCpp});`,
                });
                return true;
            }
            if (property === "innerHTML") {
                this.recordUiStaticReplaceChildren(directElement);
                this.context.emit({
                    kind: "expression",
                    code:
                        `bbl::ui_set_inner_rml(${engine}, ${directElement.cpp}, ` +
                        `${this.compileUiMarkupString(
                            expression.right,
                            directElement.uiStaticId,
                        )});`,
                });
                return true;
            }
            const attribute = this.reflectedUiAttribute(
                directElement,
                property,
                expression.left.expression,
                expression.left,
            )?.attribute;
            if (attribute) {
                if (attribute === "class" || attribute === "id") {
                    this.recordUiStaticAttribute(
                        directElement,
                        attribute,
                        expression.right,
                    );
                }
                this.context.emit({
                    kind: "expression",
                    code:
                        `bbl::ui_set_attribute(${engine}, ${directElement.cpp}, ` +
                        `${this.context.cppString(attribute)}, ` +
                        `${this.uiStringCpp(expression.right, `UI ${property}`)});`,
                });
                return true;
            }
        }
        const style = this.context.unwrap(expression.left.expression);
        if (
            !ts.isPropertyAccessExpression(style) ||
            style.name.text !== "style"
        ) {
            return false;
        }
        if (
            property === "cursor" &&
            this.context.isCanvasElement(style.expression)
        ) {
            this.context.emit({
                kind: "expression",
                code:
                    `bbl::set_canvas_cursor(${this.context.requireDefaultEngine(expression)}, ` +
                    `${this.uiStringCpp(expression.right, "canvas style.cursor")});`,
            });
            return true;
        }
        const styleElement = this.compileUiElementReceiver(style.expression);
        if (!styleElement) return false;
        const engine = this.context.requireEngine(
            styleElement,
            expression.left,
        );
        if (property === "cssText") {
            if (
                this.emitDeferredUiStyle(
                    styleElement,
                    expression.right,
                    expression,
                    this.deferredUiStyleCapabilities(expression.right, false),
                    "CSSStyleDeclaration.cssText: string",
                )
            )
                return true;
            this.context.emit({
                kind: "expression",
                code:
                    `bbl::ui_set_attribute(${engine}, ${styleElement.cpp}, ` +
                    `${this.context.cppString("style")}, ${this.compileUiStyleString(
                        expression.right,
                        styleElement.uiStaticId,
                    )});`,
            });
            return true;
        }
        this.emitUiStyleProperty(
            styleElement,
            property,
            expression.right,
            expression.left.name,
        );
        return true;
    }

    public emitUiStyleProperty(
        element: Value,
        property: string,
        valueExpression: ts.Expression,
        site: ts.Node,
    ): void {
        const nativeProperty = this.nativeUiStyleProperty(property);
        const capability =
            this.context.options.deferredCapabilities &&
            deferredUiStyleCapability(
                nativeProperty,
                this.tryUiStaticString(valueExpression),
            );
        if (
            capability &&
            this.emitDeferredUiStyle(
                element,
                valueExpression,
                site,
                [capability],
                `CSSStyleDeclaration.${property}: string`,
            )
        )
            return;
        this.auditUiStylePropertyName(property, site);
        const styleElement = pinDetached(
            this.context,
            element,
            "style_receiver",
        );
        const engine = this.context.requireEngine(styleElement, site);
        if (
            [
                "filter",
                "overflow-wrap",
                "word-break",
                "transform-origin",
            ].includes(nativeProperty) ||
            isUiLayoutProperty(nativeProperty)
        ) {
            const value = this.tryUiStaticString(valueExpression);
            if (value !== undefined && value !== "")
                this.auditUiStyleDeclarations(
                    `${nativeProperty}:${value}`,
                    valueExpression,
                );
        }
        this.recordUiStaticStyleProperty(
            styleElement,
            nativeProperty,
            valueExpression,
        );
        // Border images lower only from static text; other lowered values
        // pass a runtime string through as written.
        const staticValue =
            nativeProperty === "border-image"
                ? this.context.compileStringLiteral(valueExpression)
                : UiProjection.UI_LOWERED_STYLE_VALUES.has(nativeProperty)
                  ? this.tryUiStaticString(valueExpression)
                  : undefined;
        const styleValue =
            staticValue !== undefined
                ? this.context.cppString(
                      this.lowerUiStyleValue(
                          nativeProperty,
                          staticValue,
                          valueExpression,
                      ),
                  )
                : this.uiStringCpp(valueExpression, `UI style.${property}`);
        this.context.emit({
            kind: "expression",
            code:
                `bbl::ui_set_style_property(${engine}, ${styleElement.cpp}, ` +
                `${this.context.cppString(nativeProperty)}, ` +
                `${styleValue});`,
        });
        for (const [name, value] of UiProjection.UI_SHORTHAND_RESETS.get(
            property,
        ) ?? []) {
            this.context.emit({
                kind: "expression",
                code: `bbl::ui_set_style_property(${engine}, ${styleElement.cpp}, ${this.context.cppString(this.nativeUiStyleProperty(name))}, ${this.context.cppString(value)});`,
            });
        }
    }

    public removeUiStyleProperty(
        element: Value,
        property: string,
        site: ts.Expression,
    ): Value {
        const nativeProperty = this.nativeUiStyleProperty(property);
        this.auditUiStylePropertyName(property, site);
        this.recordUiStaticStyleProperty(element, nativeProperty, site, "");
        const engine = this.context.requireEngine(element, site);
        return {
            kind: "string",
            cpp: `bbl::ui_remove_style_property(${engine}, ${element.cpp}, ${this.context.cppString(nativeProperty)})`,
        };
    }

    /**
     * The native document's primary canvas, created on first use under the
     * id the program looks it up by, so a retained-UI `#id` rule or query
     * finds the element the program means. One element carries one id.
     */
    public primaryPresentationCanvas(node: ts.Node): Value {
        const engine = this.context.requirePresentationHost(node);
        if (!this.presentationCanvasValue) {
            const ids = [...primaryCanvasIds(this.context)];
            if (ids.length !== 1)
                this.context.fail(
                    node,
                    `The native primary canvas carries one id; this program looks it up by ${ids.map((id) => JSON.stringify(id)).join(", ")}.`,
                );
            this.context.reachFeature("ui:rml", node);
            this.context.reachFeature("backend:sdl", node);
            this.context.reachFeature("renderer:canvas", node);
            this.presentationCanvasValue = {
                kind: "ui-element",
                cpp: `bbl::ui_primary_canvas(${engine}, ${this.context.cppString(ids[0]!)})`,
                engineCpp: engine,
                uiTag: "canvas",
                uiCanvas: true,
                uiPrimaryCanvas: true,
                uiCanvasId: this.retainedCanvasId(ids[0]!),
                truthinessCpp: "true",
            };
        }
        return this.presentationCanvasValue;
    }

    @journaled public accessor presentationCanvasValue: Value | undefined;

    @journaled public accessor primaryCanvasReadyGate = false;
    @journaled public accessor windowCanvasReadyGate = false;

    private readonly canvasDatasetReads = new EmissionWeakMap<
        ts.SourceFile,
        boolean
    >();

    /** Write-only dataset instrumentation erases; readback requires retained DOM state. */
    private readsCanvasDataset(source: ts.SourceFile): boolean {
        const cached = this.canvasDatasetReads.get(source);
        if (cached !== undefined) return cached;
        let found = false;
        const visit = (node: ts.Node): void => {
            if (found) return;
            if (ts.isPropertyAccessExpression(node)) {
                const dataset = this.context.unwrap(node.expression);
                if (
                    ts.isPropertyAccessExpression(dataset) &&
                    dataset.name.text === "dataset" &&
                    this.context.isCanvasElement(dataset.expression) &&
                    !(
                        ts.isBinaryExpression(node.parent) &&
                        node.parent.left === node &&
                        node.parent.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken
                    )
                ) {
                    found = true;
                    return;
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        this.canvasDatasetReads.set(source, found);
        return found;
    }

    public primaryCanvasDataset(expression: ts.Expression): string | undefined {
        if (this.context.options.workers) return undefined;
        const value = this.context.unwrap(expression);
        if (!ts.isPropertyAccessExpression(value)) return undefined;
        const dataset = this.context.unwrap(value.expression);
        return ts.isPropertyAccessExpression(dataset) &&
            dataset.name.text === "dataset" &&
            this.context.isCanvasElement(dataset.expression) &&
            this.readsCanvasDataset(value.getSourceFile())
            ? value.name.text
            : undefined;
    }

    @journaled public accessor nativeHostUiTagsCache:
        ReadonlyMap<string, string> | undefined;

    public nativeHostUiTags(): ReadonlyMap<string, string> {
        if (this.nativeHostUiTagsCache) return this.nativeHostUiTagsCache;
        const tags = new EmissionMap<string, string>();
        for (const element of nativeHostUiElements(
            this.context.options.nativeHostUi?.elements ?? [],
        )) {
            const id = element.attributes?.id;
            if (id !== undefined) tags.set(id, element.tag.toLowerCase());
        }
        this.nativeHostUiTagsCache = tags;
        return tags;
    }

    /** Checked Document queries reach their retained owner, activating a Window realm when needed. */
    public isNativeHostUiLookup(call: ts.CallExpression): boolean {
        const callee = this.context.unwrap(call.expression);
        if (
            !ts.isPropertyAccessExpression(callee) ||
            !(
                callee.name.text === "getElementById" ||
                callee.name.text === "querySelector" ||
                callee.name.text === "querySelectorAll"
            ) ||
            !isDocumentReceiver(this.context, callee.expression) ||
            call.arguments.length !== 1
        ) {
            return false;
        }
        // The primary presentation canvas already belongs to its scene or
        // standalone Canvas2D host. A lookup cannot activate another owner
        // before that host is constructed. Explicit companion elements and
        // application realms still use the retained document representation.
        if (!this.context.options.workers) {
            const id = this.lookupElementId(call);
            if (
                id !== undefined &&
                primaryCanvasIds(this.context).has(id) &&
                !this.nativeHostUiTags().has(id)
            )
                return false;
        }
        return true;
    }

    /**
     * The id a document `getElementById`/`querySelector` call finds one
     * element by (`documentLookupId`), when its argument is a literal or an
     * inlined helper's parameter bound to one: a demo's
     * `bindToggle(buttonId, ...)` looks its button up by the literal every
     * call site passes, which the inlined binding still carries as a static
     * string.
     */
    public lookupElementId(call: ts.CallExpression): string | undefined {
        const callee = this.context.unwrap(call.expression);
        const argument = this.context.unwrap(argumentAt(call, 0));
        const text =
            ts.isStringLiteral(argument) ||
            ts.isNoSubstitutionTemplateLiteral(argument)
                ? argument.text
                : ts.isIdentifier(argument)
                  ? this.context.bindings.lookupOptional(argument)?.staticString
                  : undefined;
        return ts.isPropertyAccessExpression(callee) && text !== undefined
            ? documentLookupId(callee.name.text, text)
            : undefined;
    }

    /**
     * A local helper returning a scene-created retained element must be
     * inlined before DOM erasure gets to classify its result type. Canvas
     * helpers deliberately do not qualify: live Canvas2D belongs to its own
     * bounded IR rather than the retained element tree.
     */
    private isNativeUiHelperCall(call: ts.CallExpression): boolean {
        const declaration =
            this.context.checker.getResolvedSignature(call)?.declaration;
        if (
            !declaration ||
            (!ts.isFunctionDeclaration(declaration) &&
                !ts.isMethodDeclaration(declaration) &&
                !ts.isFunctionExpression(declaration) &&
                !ts.isArrowFunction(declaration)) ||
            !declaration.body
        ) {
            return false;
        }
        let reached = false;
        const visit = (node: ts.Node): void => {
            if (reached) return;
            if (ts.isCallExpression(node)) {
                if (this.isNativeHostUiLookup(node)) {
                    reached = true;
                    return;
                }
                const callee = this.context.unwrap(node.expression);
                if (
                    ts.isPropertyAccessExpression(callee) &&
                    callee.name.text === "createElement" &&
                    this.context.libraryGlobal(callee.expression) === "document"
                ) {
                    const tag = node.arguments[0];
                    if (
                        tag &&
                        (ts.isStringLiteral(tag) ||
                            ts.isNoSubstitutionTemplateLiteral(tag)) &&
                        tag.text.toLowerCase() !== "canvas"
                    ) {
                        reached = true;
                        return;
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration.body);
        return reached;
    }

    public compileHostUi(startup?: (fileName: string) => string[]): string[] {
        const hostUi = this.context.options.nativeHostUi;
        const primaryIds =
            this.context.options.workers &&
            !this.context.options.workers.namespace &&
            this.context.defaultEngine()
                ? [...engineCanvasIds(this.context)].filter(
                      (id) => !this.nativeHostUiTags().has(id),
                  )
                : [];
        if (!hostUi && primaryIds.length === 0) return [];
        if (primaryIds.length > 1)
            this.context.failAtFile(
                "Multiple implicit engine canvases require explicit host elements.",
            );
        if (this.context.options.workers)
            this.context.reachFeature(
                "platform:window",
                this.context.sourceFile,
            );
        const engine = this.context.options.workers
            ? "bbl::pal::window_document_engine()"
            : this.context.defaultEngine();
        if (!engine) {
            this.context.failAtFile(
                "A native host UI companion requires a scene engine.",
            );
        }
        // The reaching "site" is the audited companion file itself: a
        // companion-only scene has no call in its own source to name, and
        // leaving the site empty would attribute the activation to the
        // compiled scene TypeScript. A scene-source reach recorded during
        // the walk still wins, by `reachFeature`'s first-reach rule.
        this.context.reachFeature(
            "ui:rml",
            hostUi
                ? `${hostUi.sourcePath} (host UI companion)`
                : this.context.sourceFile,
        );
        const indent = "    ".repeat(2);
        const emitted = primaryIds.map(
            (id) =>
                `${indent}static_cast<void>(bbl::ui_primary_canvas(${engine}, ${this.context.cppString(id)}));`,
        );
        const ids = new EmissionSet<string>(primaryIds);
        for (const rule of hostUi ? nativeHostUiStyleRules(hostUi) : []) {
            if (
                rule.scrollbar !== undefined &&
                !isUiScrollbarPart(rule.scrollbar)
            ) {
                this.context.failAtFile(
                    "Native host UI rule has an unsupported scrollbar part.",
                );
            }
            if (
                rule.range !== undefined &&
                (!isUiRangePart(rule.range) ||
                    rule.scrollbar !== undefined ||
                    rule.pseudo !== undefined)
            )
                this.context.failAtFile(
                    "Native host UI range rule requires an exclusive thumb or track target.",
                );
            if (
                rule.pseudo !== undefined &&
                (!isUiGeneratedPart(rule.pseudo) ||
                    rule.scrollbar !== undefined)
            )
                this.context.failAtFile(
                    "Native host UI generated content requires a before/after target without a scrollbar part.",
                );
            const { style: declarations, content } =
                this.lowerUiRuleDeclarations(rule.style);
            if (rule.range) this.validateUiPartStyle(declarations, "range");
            if (rule.pseudo)
                this.validateUiPartStyle(declarations, rule.pseudo);
            if (content && rule.pseudo !== "before" && rule.pseudo !== "after")
                this.context.failAtFile(
                    "Native host UI content lists require a before/after target.",
                );
            const identifier = /^[A-Za-z_][A-Za-z0-9_-]*$/;
            const sequence =
                rule.kind === "sequence"
                    ? parseUiSelectorSequence(rule.primary)
                    : undefined;
            if (
                rule.kind === "sequence"
                    ? !sequence
                    : !identifier.test(rule.primary)
            ) {
                this.context.failAtFile(
                    `Native host UI style target '${rule.primary}' is not valid.`,
                );
            }
            const descriptor = uiStyleSelectorDescriptor(rule.kind);
            if (
                descriptor.needsSecondary !== Boolean(rule.secondary) ||
                (rule.secondary !== undefined &&
                    !identifier.test(rule.secondary))
            ) {
                this.context.failAtFile(
                    `Native host UI ${rule.kind} rule has invalid secondary target.`,
                );
            }
            if (
                descriptor.needsTag !== Boolean(rule.tag) ||
                (rule.tag !== undefined &&
                    !/^[A-Za-z][A-Za-z0-9-]*$/.test(rule.tag))
            ) {
                this.context.failAtFile(
                    `Native host UI ${rule.kind} rule has invalid tag target.`,
                );
            }
            if (
                rule.maxWidth !== undefined &&
                (!Number.isFinite(rule.maxWidth) || rule.maxWidth <= 0)
            ) {
                this.context.failAtFile(
                    "Native host UI style maxWidth must be a positive finite number.",
                );
            }
            const selected =
                rule.pseudo || rule.range
                    ? UiProjection.parseUiSelector(
                          uiStyleSelector(rule),
                          declarations,
                      )
                    : rule;
            if (!selected)
                this.context.failAtFile(
                    "Native host UI pseudo-element has an unsupported originating selector.",
                );
            if (
                rule.containerMaxWidth !== undefined &&
                (!Number.isFinite(rule.containerMaxWidth) ||
                    rule.containerMaxWidth < 0 ||
                    rule.containerMaxWidth > 3.4028234663852886e38)
            )
                this.context.failAtFile(
                    "Native host UI containerMaxWidth must be a non-negative finite native number.",
                );
            const selectedSequence = selected.sequence ?? sequence;
            emitted.push(
                `${indent}bbl::ui_add_host_style_rule(${engine}, ` +
                    `bbl::UiStyleSelectorKind::${uiStyleSelectorCppKind(selected.kind)}, ` +
                    `${this.context.cppString(selected.primary)}, ` +
                    `${this.context.cppString(selected.secondary ?? "")}, ` +
                    `${this.context.cppString(selected.tag ?? "")}, ` +
                    `${selected.hover ? "true" : "false"}, ` +
                    `${doubleLiteral(rule.maxWidth ?? -1)}, ` +
                    `${this.context.cppString(declarations)}` +
                    `, ${selected.focusVisible ? "true" : "false"}, ${selected.active ? "true" : "false"}, ` +
                    `bbl::UiScrollbarPart::${uiScrollbarPartCpp(rule.scrollbar)}, ` +
                    `bbl::UiMotionPreference::${uiMotionPreferenceCpp(rule.reducedMotion)}` +
                    `${this.uiRuleSuffix({
                        ...rule,
                        ...(selectedSequence
                            ? { sequence: selectedSequence }
                            : {}),
                        ...(content ? { content } : {}),
                    })});`,
            );
        }

        // The document's own sheets precede its markup, as a page's head does.
        // Its rules are lowered here; the PAL reads only its keyframes.
        const sheets = hostUi
            ? (hostUi.styleSheets ?? []).map((sheet) => ({
                  text: sheet.text,
                  origin: { file: hostUi.sourcePath, line: sheet.line },
              }))
            : [];
        for (const { text, origin } of sheets) {
            const handle =
                this.context.allocateTemporaryCppName("host_ui_style");
            const { keyframes } = UiProjection.splitUiKeyframesBlocks(
                stripUiCssComments(text),
            );
            emitted.push(
                `${indent}const auto ${handle} = bbl::ui_create_element(${engine}, "style");`,
                ...this.uiStyleSheetRuleStatements(
                    engine,
                    handle,
                    text,
                    undefined,
                    undefined,
                    origin,
                ).map((statement) => indent + statement),
                ...(keyframes
                    ? [
                          `${indent}bbl::ui_set_text(${engine}, ${handle}, ${this.context.cppString(keyframes)});`,
                      ]
                    : []),
                `${indent}bbl::ui_append_child(${engine}, bbl::ui_document_root(${engine}, bbl::UiDocumentPart::Head), ${handle});`,
            );
        }
        for (const [part, attributes] of [
            ["Html", hostUi?.htmlAttributes],
            ["Body", hostUi?.bodyAttributes],
        ] as const) {
            for (const [name, value] of Object.entries(attributes ?? {}))
                emitted.push(
                    `${indent}bbl::ui_set_attribute(${engine}, bbl::ui_document_root(${engine}, bbl::UiDocumentPart::${part}), ` +
                        `${this.context.cppString(name)}, ${this.context.cppString(this.lowerUiAttributeLiteral(name, value))});`,
                );
        }

        const appendElement = (element: NativeHostUiNode, parent?: string) => {
            if (element.tag === undefined) {
                emitted.push(
                    `${indent}bbl::ui_append_text(${engine}, ${parent ?? "{}"}, ${this.context.cppString(element.text)});`,
                );
                return;
            }
            const normalizedTag = element.tag.toLowerCase();
            if (!/^[a-z][a-z0-9-]*$/i.test(element.tag)) {
                this.context.failAtFile(
                    `Native host UI element tag '${element.tag}' is not valid.`,
                );
            }
            if (UiProjection.UI_IMPLEMENTATION_TAGS.has(normalizedTag)) {
                this.context.failAtFile(
                    `Native host UI element tag '${element.tag}' is reserved for the retained projection.`,
                );
            }
            const handle =
                this.context.allocateTemporaryCppName("host_ui_element");
            emitted.push(
                `${indent}const auto ${handle} = ` +
                    `bbl::ui_create_element(${engine}, ${this.context.cppString(normalizedTag)});`,
            );
            if (element.text !== undefined) {
                emitted.push(
                    `${indent}bbl::ui_set_text(${engine}, ${handle}, ` +
                        `${this.context.cppString(element.text)});`,
                );
            }
            for (const [name, sourceValue] of Object.entries(
                element.attributes ?? {},
            )) {
                if (name === "id") {
                    if (ids.has(sourceValue)) {
                        this.context.failAtFile(
                            `Native host UI element id '${sourceValue}' is duplicated.`,
                        );
                    }
                    ids.add(sourceValue);
                }
                const value = this.lowerUiAttributeLiteral(name, sourceValue);
                if (element.tag === "img" && name === "src")
                    this.registerImageSource(value);
                emitted.push(
                    `${indent}bbl::ui_set_attribute(${engine}, ${handle}, ` +
                        `${this.context.cppString(name)}, ${this.context.cppString(value)});`,
                );
                // A canvas's width and height attributes are its backing
                // store's size, parsed as HTML non-negative integers; an
                // unparsable one keeps the default.
                const size = /^[\t\n\f\r ]*\+?(\d+)/.exec(sourceValue)?.[1];
                if (
                    normalizedTag === "canvas" &&
                    (name === "width" || name === "height") &&
                    size !== undefined
                )
                    emitted.push(
                        `${indent}bbl::ui_canvas_set_${name}(${engine}, ${handle}, ${doubleLiteral(Number(size))});`,
                    );
            }
            const attach = parent
                ? `${indent}bbl::ui_append_child(${engine}, ${parent}, ${handle});`
                : `${indent}bbl::ui_append_to_root(${engine}, ${handle});`;
            if (startup) emitted.push(attach);
            for (const child of element.children ?? []) {
                appendElement(child, handle);
            }
            if (!startup) emitted.push(attach);
            if (element.startupScript) {
                if (!startup)
                    this.context.failAtFile(
                        "A host script requires a checked page startup program.",
                    );
                emitted.push(
                    `${indent}bbl::pal::EventLoop::current().dispatch_callback([&] {`,
                    ...startup(element.startupScript).map(
                        (line) => indent + "    " + line,
                    ),
                    `${indent}});`,
                );
            }
        };
        for (const element of hostUi?.elements ?? []) {
            appendElement(element);
        }
        if (this.context.options.workers)
            emitted.push(`${indent}bbl::pal::update_window_document();`);
        return emitted;
    }
}
