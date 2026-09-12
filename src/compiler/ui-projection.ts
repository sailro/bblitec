import { valueForKind } from "./types.js";
import { emissionArray, EmissionSet, EmissionMap, EmissionWeakMap } from "./emission-transaction.js";
import ts from "typescript";
import { doubleLiteral } from "../cpp-literals.js";
import { parseUiBorderImage, renderUiBorderImage } from "../ui-border-image.js";
import { supportedUiFilter } from "../ui-filters.js";
import { isUiLayoutProperty, supportedUiLayoutValue } from "../ui-layout.js";
import { nativeHostUiStyleRules, uiStyleSelectorCppKind, uiStyleSelectorDescriptor, uiStyleInteractionStateCount, uiStyleRuleHasMedia, uiMotionPreferenceCpp, isUiScrollbarPart, uiScrollbarPartCpp, type UiStyleSelectorShape, type UiStyleSelectorKind } from "../ui-style-rule.js";
import { validateFileAccept } from "./browser-file.js";
import { CompileError } from "./compile-error.js";
import { documentEngine } from "./window-events.js";
import type { LoweringServices } from "./lowering-services.js";
import { argumentAt } from "./syntax.js";
import type { NativeHostUiElement, Value } from "./types.js";



interface UiGridProjection {
    columns: number;
    cellWidth: number;
    gap: number;
    width: number;
    rowCount?: number;
    rowHeight?: number;
    /** Absent means CSS's initial `normal`, projected as start alignment. */
    authoredJustifyContent?: "start" | "center" | "end";
}


interface LoweredUiStyleRule extends UiStyleSelectorShape {
    // Source-created sheets participate in static grid proofs. Attribute
    // selectors are currently admitted only in audited host companions.
    kind: Exclude<UiStyleSelectorKind, "tag-attribute">;
    hover: boolean;
    maxWidth?: number;
    reducedMotion?: boolean;
    style: string;
    selector: string;
    site?: ts.Node;
    ownerId?: number;
    grid?: UiGridProjection;
}


interface UiStaticMarkupNode {
    id: number;
    tag: string;
    classes: ReadonlySet<string>;
    attributes: ReadonlyMap<string, string>;
    children: UiStaticMarkupNode[];
}


interface UiStaticElement {
    tag: string;
    /** Every exact class set the element can have at a projected boundary. */
    classAlternatives: Set<string>[];
    classMayMutateDynamically: boolean;
    ids: Set<string>;
    children: Set<number>;
    markupChildren: UiStaticMarkupNode[];
    /** Reachable complete inline declaration lists, not assignment history. */
    styles: string[];
    styleShapeKnown: boolean;
    styleMayMutateDynamically: boolean;
    mutableClasses: Set<string>;
    classShapeKnown: boolean;
    /** False when known child construction sites can occur a runtime number of times. */
    childCardinalityKnown: boolean;
    childShapeKnown: boolean;
}


interface UiValidationState {
    activeRules: readonly LoweredUiStyleRule[];
    parentsByChild: ReadonlyMap<number, readonly number[]>;
    ancestorsById: Map<number, UiStaticElement[]>;
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

interface UiProjectionContext extends Pick<LoweringServices,
    "lookupIdentifierValue" |
    "allocateTemporaryCppName" | "sourceFile" |
    "checker" |
    "compileBoolean" |
    "compileCondition" |
    "compileNumber" |
    "compilePlatformCall" |
    "compileStringLiteral" |
    "compileValue" |
    "compileVoidCallback" |
    "cppString" |
    "dataLowerer" |
    "defaultEngine" |
    "emit" |
    "evaluator" |
    "expectKind" |
    "expectSameEngine" |
    "fail" |
    "failAtFile" |
    "hasFeature" |
    "hasPresentationHost" |
    "isCanvasElement" |
    "isDefaultLibraryIdentifier" |
    "isInFrameCallback" |
    "isInRuntimeControlFlow" |
    "lookupOptional" |
    "options" |
    "reachFeature" |
    "registerAsset" |
    "reachJsData" |
    "requireDefaultEngine" |
    "requireEngine" |
    "requirePresentationHost" |
    "resolveRecordMember" |
    "resolveThisField" |
    "symbols" |
    "unwrap"
> {}

export class UiProjection {
    public constructor(private readonly context: UiProjectionContext) {}

    public documentEngine(node: ts.Node): string {
        return documentEngine(this.context, node) ?? this.context.requireDefaultEngine(node);
    }

    public booleanAttribute(element: Value, property: string, site: ts.Node): string | undefined {
        if (property !== "hidden" && property !== "disabled") return undefined;
        if (property === "disabled" && element.uiTag && !["button", "input", "textarea"].includes(element.uiTag)) {
            this.context.fail(site, "UI disabled requires a supported form control.");
        }
        return property;
    }


    public uiElementValue(expression: ts.Expression): Value | undefined {
        const owner = this.context.unwrap(expression);
        const asElement = (value: Value | undefined): Value | undefined => {
            if (this.context.hasPresentationHost() &&
                value?.browserValue?.kind === "object" &&
                value.browserValue.primaryCanvas) {
                return Object.assign(value, this.primaryPresentationCanvas(owner));
            }
            const storedMetadata = value
                ? (this.uiElementMetadataByDataStorage.get(value.cpp) ??
                  (value.optionalStorageCpp
                      ? this.uiElementMetadataByDataStorage.get(
                            value.optionalStorageCpp,
                        )
                      : undefined))
                : undefined;
            const trackedTag = value
                ? (value.uiTag ?? storedMetadata?.tag)
                : undefined;
            const trackedId = value
                ? (value.uiStaticId ?? storedMetadata?.staticId)
                : undefined;
            const withTrackedTag = (element: Value<"ui-element">): Value<"ui-element"> =>
                (trackedTag !== undefined && element.uiTag === undefined) ||
                (trackedId !== undefined && element.uiStaticId === undefined)
                    ? {
                          ...element,
                          ...(trackedTag === undefined ||
                          element.uiTag !== undefined
                              ? {}
                              : { uiTag: trackedTag }),
                          ...(trackedId === undefined ||
                          element.uiStaticId !== undefined
                              ? {}
                              : { uiStaticId: trackedId }),
                      }
                    : element;
            if (value?.kind === "ui-element") {
                return withTrackedTag(value);
            }
            if (value?.kind !== "data" || !value.dataType) {
                return undefined;
            }
            const narrowed = this.context.dataLowerer.narrowOptional(value, owner);
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
            return withTrackedTag(valueForKind("ui-element", {
                ...value,

                cpp: `(*${value.cpp})`,
                dataType: value.dataType.inner,
                optionalFoundCpp:
                    value.optionalFoundCpp ?? `${value.cpp}.has_value()`,
                engineCpp: value.engineCpp ?? this.documentEngine(owner),
            }));
        };
        if (ts.isIdentifier(owner)) {
            return asElement(this.context.lookupOptional(owner));
        }
        if (
            ts.isPropertyAccessExpression(owner) &&
            owner.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
            return asElement(this.context.resolveThisField(owner.name.text));
        }
        if (ts.isPropertyAccessExpression(owner) || ts.isElementAccessExpression(owner)) {
            // This is also an erasure probe, not permission to lower arbitrary
            // members (such as Set.add or a captured GPU device's queue).
            const type = this.context.dataLowerer.dataTypeAt(owner);
            const inner = type?.kind === "optional" ? type.inner : type;
            if (inner?.kind !== "handle" || inner.handle !== "ui-element") {
                return undefined;
            }
        }
        if (ts.isPropertyAccessExpression(owner)) {
            const value =
                this.context.resolveRecordMember(owner) ??
                this.context.dataLowerer.compileDataPath(owner, "read");
            return asElement(value);
        }
        if (ts.isElementAccessExpression(owner)) {
            return asElement(this.context.dataLowerer.compileDataPath(owner, "read"));
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
                (callee.name.text === "querySelector" || this.isNativeHostUiLookup(owner))
            ) {
                return asElement(this.context.compilePlatformCall(owner));
            }
        }
        return undefined;
    }


    public uiCreatedElementTag(expression: ts.Expression): string | undefined {
        const resolvedElement = this.uiElementValue(expression);
        const direct = resolvedElement?.uiTag;
        if (direct) return direct;
        const owner = this.context.unwrap(expression);
        if (!ts.isIdentifier(owner)) return undefined;
        const declaration = this.context.symbols.valueSymbol(owner)?.valueDeclaration;
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
        if (this.primaryCanvasDataset(expression)) return true;
        const value = this.context.unwrap(expression);
        if (
            ts.isPropertyAccessExpression(value) &&
            value.name.text === "activeElement" &&
            ts.isIdentifier(value.expression) &&
            value.expression.text === "document" &&
            this.context.isDefaultLibraryIdentifier(value.expression)
        ) return true;
        if (ts.isElementAccessExpression(value)) {
            const dataType = this.context.dataLowerer.dataTypeAt(value);
            return (
                dataType?.kind === "handle" && dataType.handle === "ui-element"
            );
        }
        if (ts.isIdentifier(value)) {
            return this.context.lookupOptional(value)?.kind === "ui-element";
        }
        if (ts.isPropertyAccessExpression(value)) {
            return this.uiElementValue(value)?.kind === "ui-element";
        }
        if (!ts.isCallExpression(value)) return false;
        // Classifying a lookup must not evaluate its ID argument. The normal
        // call lowerer owns those effects when the expression is reached.
        if (this.isNativeHostUiLookup(value)) return true;
        if (this.uiElementValue(value)?.kind === "ui-element") {
            return true;
        }
        const callee = this.context.unwrap(value.expression);
        const createsElement =
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "createElement" &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === "document" &&
            this.context.isDefaultLibraryIdentifier(callee.expression) &&
            value.arguments[0] !== undefined &&
            (ts.isStringLiteral(value.arguments[0]) ||
                ts.isNoSubstitutionTemplateLiteral(value.arguments[0]));
        return (
            createsElement ||
            this.isNativeHostUiLookup(value) ||
            this.isNativeUiHelperCall(value)
        );
    }


    public uiStringCpp(expression: ts.Expression, purpose: string): string {
        const staticValue = this.tryUiStaticString(expression);
        if (staticValue !== undefined) {
            return this.context.cppString(staticValue);
        }
        const value = this.context.dataLowerer.stringReceiver(this.context.compileValue(expression), expression);
        if (
            value.kind === "string" ||
            (value.kind === "data" && value.dataType?.kind === "string")
        ) {
            return value.cpp;
        }
        this.context.fail(
            expression,
            `${purpose} requires a string, received ${value.kind}.`,
        );
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
            const isString = (value: Value): boolean =>
                value.kind === "string" ||
                (value.kind === "data" && value.dataType?.kind === "string");
            if (isString(left) && isString(right)) {
                return (
                    `(!std::string(${left.cpp}).empty()` +
                    ` ? std::string(${left.cpp})` +
                    ` : std::string(${right.cpp}))`
                );
            }
        }
        const value = this.context.compileValue(expression);
        if (value.staticString !== undefined) {
            return this.context.cppString(value.staticString);
        }
        if (value.staticNumber !== undefined) {
            return this.context.cppString(String(value.staticNumber));
        }
        if (value.kind === "number") {
            return `bbl::js::number_to_string(${value.cpp})`;
        }
        if (
            value.kind === "string" ||
            (value.kind === "data" && value.dataType?.kind === "string")
        ) {
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
            return [...new EmissionSet([...whenTrue, ...whenFalse])].slice(0, budget);
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
            element.classShapeKnown = false;
            return;
        }
        element.classAlternatives = [...unique.values()];
    }


    public recordUiStaticAttribute(
        value: Value,
        name: string,
        expression: ts.Expression,
    ): void {
        const element = this.uiStaticElement(value);
        const candidates = this.uiStringCandidates(expression);
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
                element.classShapeKnown = false;
                return;
            }
            const alternatives: Set<string>[] = [];
            for (const candidate of candidates) {
                const classes = new EmissionSet<string>();
                for (const token of candidate.split(/\s+/).filter(Boolean)) {
                    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(token)) {
                        classes.add(token);
                    } else {
                        element.classShapeKnown = false;
                    }
                }
                alternatives.push(classes);
            }
            const dynamic = this.uiStaticMutationIsDynamic();
            if (dynamic) element.classMayMutateDynamically = true;
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
            element.classMayMutateDynamically = true;
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
            element.styleMayMutateDynamically = true;
        }
        const mayReplaceLater =
            currentMutationIsDynamic || element.styleMayMutateDynamically;
        element.styles = mayReplaceLater
            ? [...new EmissionSet([...element.styles, ...styles])]
            : [...new EmissionSet(styles)];
        element.styleShapeKnown = mayReplaceLater ? wasKnown : true;
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
            element.styleMayMutateDynamically = true;
        }
        element.styleShapeKnown = false;
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
                declaration.slice(0, colon).trim().toLowerCase() !== name
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
    ): void {
        const element = this.uiStaticElement(value);
        if (!element) return;
        const staticValue = this.tryUiStaticString(expression);
        const updated = element.styles.map((style) =>
            UiProjection.uiStyleWithProperty(
                style,
                name,
                staticValue ?? "__bbl_dynamic_style_value__",
            ),
        );
        const currentMutationIsDynamic = this.uiStaticMutationIsDynamic();
        if (currentMutationIsDynamic) {
            element.styleMayMutateDynamically = true;
        }
        element.styles =
            currentMutationIsDynamic || element.styleMayMutateDynamically
                ? [...new EmissionSet([...element.styles, ...updated])]
                : [...new EmissionSet(updated)];
    }


    public recordUiStaticAppend(parent: Value, child: Value): void {
        const parentElement = this.uiStaticElement(parent);
        if (!parentElement) return;
        if (child.uiStaticId === undefined) {
            parentElement.childCardinalityKnown = false;
            parentElement.childShapeKnown = false;
            return;
        }
        if (this.uiStaticMutationIsDynamic()) {
            parentElement.children.add(child.uiStaticId);
            parentElement.childCardinalityKnown = false;
            for (const element of this.uiStaticElements.values()) {
                if (element.children.has(child.uiStaticId)) {
                    element.childCardinalityKnown = false;
                }
            }
            return;
        }
        for (const element of this.uiStaticElements.values()) {
            element.children.delete(child.uiStaticId);
        }
        parentElement.children.add(child.uiStaticId);
    }


    public recordUiStaticReplaceChildren(parent: Value): void {
        const element = this.uiStaticElement(parent);
        if (!element) return;
        if (this.uiStaticMutationIsDynamic()) {
            element.childCardinalityKnown = false;
            return;
        }
        element.children.clear();
        element.markupChildren = [];
    }


    private uiStaticMutationIsDynamic(): boolean {
        return this.context.isInRuntimeControlFlow() || this.context.isInFrameCallback();
    }


    public recordUiStaticRootAppend(child: Value): void {
        const id = child.uiStaticId;
        const element = this.uiStaticElement(child);
        if (id === undefined || !element || this.uiStaticMutationIsDynamic()) {
            if (!element || element.tag === "style") {
                this.uiStaticStyleCascadeKnown = false;
            }
            return;
        }
        const previous = this.uiStaticRootOrder.indexOf(id);
        if (previous >= 0) this.uiStaticRootOrder.splice(previous, 1);
        this.uiStaticRootOrder.push(id);
    }


    public recordUiStaticRemoval(element: Value): void {
        const id = element.uiStaticId;
        const staticElement = this.uiStaticElement(element);
        if (id === undefined || !staticElement) {
            if (!staticElement || staticElement.tag === "style") {
                this.uiStaticStyleCascadeKnown = false;
            }
            return;
        }
        const dynamic = this.uiStaticMutationIsDynamic();
        for (const parent of this.uiStaticElements.values()) {
            if (!parent.children.has(id)) continue;
            if (dynamic) parent.childCardinalityKnown = false;
            else parent.children.delete(id);
        }
        if (dynamic) {
            if (staticElement.tag === "style") {
                this.uiStaticStyleCascadeKnown = false;
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
        if (owner) owner.markupChildren.push(...children);
    }


    /**
     * The reviewed retained-UI style surface (AP-3). Every property here was
     * reached by the pinned applications, the audited host companions, or the
     * registered corpus scenes, and lowers with browser-equivalent meaning
     * (directly or through the compatibility rewrites below). A property in
     * none of the four sets refuses at generation naming itself, so an
     * unreviewed declaration can never silently drop into the projection.
     */
    private static readonly PROJECTED_UI_STYLE_PROPERTIES = new EmissionSet<string>([
        "align-content",
        "align-items",
        "align-self",
        "animation",
        "background",
        "background-color",
        "background-clip",
        "border",
        "border-color",
        "border-image",
        "border-radius",
        "box-sizing",
        "bottom",
        "color",
        "column-gap",
        "cursor",
        "display",
        "flex",
        "flex-basis",
        "flex-direction",
        "flex-flow",
        "flex-grow",
        "flex-shrink",
        "flex-wrap",
        "filter",
        "font",
        "font-family",
        "font-size",
        "font-weight",
        "gap",
        "height",
        "inset",
        "justify-content",
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
        "padding",
        "padding-bottom",
        "padding-left",
        "padding-right",
        "padding-top",
        "pointer-events",
        "position",
        "right",
        "row-gap",
        "resize",
        "scrollbar-width",
        "scrollbar-color",
        "text-align",
        "text-shadow",
        "top",
        "transform",
        "transition",
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
    private static readonly INERT_UI_STYLE_PROPERTIES = new EmissionSet<string>([
        "-webkit-user-select",
        "image-rendering",
        "touch-action",
        "user-select",
        "will-change",
    ]);


    /**
     * Reached properties the projection accepts WITHOUT a native rendering:
     * box shadows need saved layer textures and inverse masks, unsupported
     * backdrop functions have no projection, and RmlUi has no numeral
     * variants. Each acceptance is recorded per scene in the
     * `substituted-ui-runtime` fidelity adaptation.
     */
    private static readonly DEGRADED_UI_STYLE_PROPERTIES = new EmissionSet<string>([
        "-webkit-backdrop-filter",
        "backdrop-filter",
        "box-shadow",
        "font-variant-numeric",
    ]);


    private static insetOutlineBorder(value: string): string | undefined {
        const match = value.match(
            /^inset\s+0(?:px)?\s+0(?:px)?\s+0(?:px)?\s+([0-9]+(?:\.[0-9]*)?px)\s+(.+)$/i,
        );
        return match ? `${match[1]} ${match[2]!.trim()}` : undefined;
    }


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
    private static readonly GRADIENT_TEXT_UI_STYLE_PROPERTIES = new EmissionSet<string>(
        [
            "-webkit-background-clip",
            "-webkit-text-stroke",
            "background-clip",
            "background-size",
            "filter",
        ],
    );


    /** The one gradient-text `filter` form the projection consumes. */
    private static readonly GRADIENT_TEXT_SHADOW_PATTERN =
        /\bfilter\s*:\s*drop-shadow\(\s*([^\s]+)\s+([^\s]+)\s+(?:[^\s]+\s+)?(rgba?\([^)]*\)|#[0-9a-f]{3,8})\s*\)/i;


    /** The one gradient-text stroke form the projection consumes. */
    private static readonly GRADIENT_TEXT_STROKE_PATTERN =
        /-webkit-text-stroke\s*:\s*([^\s;]+)\s+([^;]+)/i;


    /** The reached CSS-grid combination the block projection lowers. */
    private static readonly GRID_TEMPLATE_COLUMNS_PATTERN =
        /\bgrid-template-columns\s*:\s*repeat\(\s*(\d+)\s*,\s*([0-9]+(?:\.[0-9]*)?)px\s*\)\s*;?/i;

    private static readonly GRID_TEMPLATE_ROWS_PATTERN =
        /\bgrid-template-rows\s*:\s*repeat\(\s*(\d+)\s*,\s*([0-9]+(?:\.[0-9]*)?)px\s*\)\s*;?/i;

    private static readonly GRID_GAP_PATTERN =
        /(?:^|;)\s*gap\s*:\s*([0-9]+(?:\.[0-9]*)?)px\s*(?:;|$)/i;

    private static readonly UI_GRID_CHILD_GEOMETRY_PROPERTIES = [
        "width",
        "height",
        "min-width",
        "max-width",
        "min-height",
        "max-height",
        "margin",
        "margin-left",
        "margin-right",
        "margin-top",
        "margin-bottom",
        "padding",
        "padding-left",
        "padding-right",
        "padding-top",
        "padding-bottom",
        "border",
        "border-width",
        "border-left-width",
        "border-right-width",
        "border-top-width",
        "border-bottom-width",
        "box-sizing",
    ] as const;

    private static readonly UI_GRID_CHILD_SPACING_PROPERTIES =
        UiProjection.UI_GRID_CHILD_GEOMETRY_PROPERTIES.filter(
            (property) =>
                property === "margin" ||
                property.startsWith("margin-") ||
                property === "padding" ||
                property.startsWith("padding-"),
        );

    private static readonly UI_GRID_CHILD_BORDER_WIDTH_PROPERTIES =
        UiProjection.UI_GRID_CHILD_GEOMETRY_PROPERTIES.filter(
            (property) =>
                property === "border-width" ||
                /^border-(?:left|right|top|bottom)-width$/.test(property),
        );

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


    /** The `display:grid` half of the grid-projection pairing. */
    private static readonly DISPLAY_GRID_PATTERN = /\bdisplay\s*:\s*grid\b/i;


    private static uiLastStyleProperty(
        declarations: string,
        property: string,
    ): string | undefined {
        let result: string | undefined;
        UiProjection.forEachUiStyleDeclaration(declarations, (declaration) => {
            const colon = declaration.indexOf(":");
            if (
                colon >= 0 &&
                declaration.slice(0, colon).trim().toLowerCase() === property
            ) {
                result = declaration.slice(colon + 1).trim();
            }
        });
        return result;
    }


    /** The grid projection's pairing rule, stated once for the audit and
     *  the projection: `display:grid` lowers only beside the reached
     *  `grid-template-columns:repeat(N, px)` form in the same list. */
    private static projectsUiGrid(declarations: string): boolean {
        return (
            UiProjection.DISPLAY_GRID_PATTERN.test(declarations) &&
            UiProjection.GRID_TEMPLATE_COLUMNS_PATTERN.test(declarations)
        );
    }


    public static fractionalUiGridTracks(declarations: string): string[] | undefined {
        if (UiProjection.uiLastStyleProperty(declarations, "display") !== "grid") return undefined;
        const value = UiProjection.uiLastStyleProperty(declarations, "grid-template-columns");
        const tracks = value?.trim().split(/\s+/);
        return tracks && tracks.length > 1 && tracks.some(track => track.endsWith("fr")) &&
            tracks.every(track => /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|fr)$/.test(track) && parseFloat(track) > 0)
            ? tracks : undefined;
    }


    private static normalizeUiGridJustification(
        value: string | undefined,
    ): "start" | "center" | "end" | undefined {
        const normalized = value?.trim().toLowerCase();
        if (
            normalized === undefined ||
            normalized === "normal" ||
            normalized === "start" ||
            normalized === "flex-start" ||
            normalized === "left"
        ) {
            return "start";
        }
        if (normalized === "center") return "center";
        if (
            normalized === "end" ||
            normalized === "flex-end" ||
            normalized === "right"
        ) {
            return "end";
        }
        return undefined;
    }


    private static uiGridProjection(
        declarations: string,
    ): UiGridProjection | undefined {
        if (!UiProjection.projectsUiGrid(declarations)) return undefined;
        const columnsValue = UiProjection.uiLastStyleProperty(
            declarations,
            "grid-template-columns",
        );
        const columns = columnsValue
            ? `grid-template-columns:${columnsValue};`.match(
                  UiProjection.GRID_TEMPLATE_COLUMNS_PATTERN,
              )
            : undefined;
        if (!columns) return undefined;
        const count = Number(columns[1]);
        const cellWidth = Number(columns[2]);
        const gapValue = UiProjection.uiLastStyleProperty(declarations, "gap");
        const gapMatch = gapValue
            ? `gap:${gapValue};`.match(UiProjection.GRID_GAP_PATTERN)
            : undefined;
        if (gapValue !== undefined && !gapMatch) return undefined;
        const gap = Number(gapMatch?.[1] ?? "0");
        const rowsValue = UiProjection.uiLastStyleProperty(
            declarations,
            "grid-template-rows",
        );
        const rows = rowsValue
            ? `grid-template-rows:${rowsValue};`.match(
                  UiProjection.GRID_TEMPLATE_ROWS_PATTERN,
              )
            : undefined;
        if (rowsValue !== undefined && !rows) return undefined;
        const rowCount = rows ? Number(rows[1]) : undefined;
        const rowHeight = rows ? Number(rows[2]) : undefined;
        const authoredJustification = UiProjection.uiLastStyleProperty(
            declarations,
            "justify-content",
        )
            ?.trim()
            .toLowerCase();
        const justifyContent = UiProjection.normalizeUiGridJustification(
            authoredJustification,
        );
        if (
            !Number.isInteger(count) ||
            count < 1 ||
            !Number.isFinite(cellWidth) ||
            cellWidth <= 0 ||
            !Number.isFinite(gap) ||
            gap < 0 ||
            (rowCount !== undefined &&
                (!Number.isInteger(rowCount) || rowCount < 1)) ||
            (rowHeight !== undefined &&
                (!Number.isFinite(rowHeight) || rowHeight <= 0)) ||
            justifyContent === undefined
        ) {
            return undefined;
        }
        return {
            columns: count,
            cellWidth,
            gap,
            width: count * cellWidth + Math.max(0, count - 1) * gap,
            ...(authoredJustification === undefined
                ? {}
                : { authoredJustifyContent: justifyContent }),
            ...(rowCount === undefined ? {} : { rowCount }),
            ...(rowHeight === undefined ? {} : { rowHeight }),
        };
    }


    /**
     * Walks one inline declaration list, calling `visit` for each
     * declaration split at top-level semicolons only — a `;` inside
     * parentheses (`url(...)`, a gradient argument) does not end a
     * declaration. The one segmentation authority for the audit and the
     * projection.
     */
    private static forEachUiStyleDeclaration(
        value: string,
        visit: (declaration: string) => void,
    ): void {
        let depth = 0;
        let start = 0;
        for (let index = 0; index <= value.length; index++) {
            const character = value[index];
            if (character === "(") depth++;
            if (character === ")") depth--;
            if (index !== value.length && (character !== ";" || depth > 0)) {
                continue;
            }
            visit(value.slice(start, index));
            start = index + 1;
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


    /** Fixed-grid shapes structurally projected through wrapping flex. */
    public readonly uiGridSubstitutions = new EmissionSet<string>();

    /** True even if a later stylesheet assignment replaces the grid rules. */
    private uiSawGridDeclaration = false;


    /** Every compiler-validated author rule, retained for static proofs. */
    private readonly uiStyleRules: LoweredUiStyleRule[] = emissionArray([]);


    /** Construction-site topology used only to prove bounded DOM projections. */
    private readonly uiStaticElements = new EmissionMap<number, UiStaticElement>();

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

    public readonly uiPendingClassQueries: UiPendingClassQuery[] = emissionArray([]);

    public readonly uiUnknownClassMutations: UiUnknownClassMutation[] = emissionArray([]);

    private readonly uiUnknownAttributeMutations: UiUnknownAttributeMutation[] =
        emissionArray([]);

    /** Final direct-document order for statically sequenced root mutations. */
    private readonly uiStaticRootOrder: number[] = emissionArray([]);

    private uiValidation: UiValidationState | undefined;

    /**
     * False once a stylesheet attachment or contents mutation can execute on
     * a path generation cannot order. A fixed-grid proof may not guess which
     * cascade the browser will expose.
     */
    private uiStaticStyleCascadeKnown = true;

    private uiElementIds = 0;


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
        { width?: number; height?: number; pairs: Set<string> }
    >();


    /** Mints `uiCanvasId` for each created retained canvas element. */
    public uiCanvasIds = 0;


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
        const projectsGrid = UiProjection.projectsUiGrid(value);
        const fractionalTracks = UiProjection.fractionalUiGridTracks(value);
        const gridProjection = UiProjection.uiGridProjection(value);
        const finalDisplay = UiProjection.uiLastStyleProperty(value, "display")
            ?.trim()
            .toLowerCase();
        const gridJustification = UiProjection.uiLastStyleProperty(
            value,
            "justify-content",
        )
            ?.trim()
            .toLowerCase();
        if (projectsGrid && finalDisplay !== "grid") {
            this.uiStyleRefusal(
                site,
                "display",
                "conflicting display declarations in one fixed-grid rule are ambiguous; put the reset in a separate cascade rule",
            );
        }
        if (
            projectsGrid &&
            gridJustification !== undefined &&
            !/^(?:normal|start|flex-start|left|center|end|flex-end|right)$/.test(
                gridJustification,
            )
        ) {
            this.uiStyleRefusal(
                site,
                "justify-content",
                `the fixed-grid substitution supports start, center, and end track alignment, not '${gridJustification}'`,
            );
        }
        if (projectsGrid && !gridProjection) {
            this.uiStyleRefusal(
                site,
                "grid-template-columns",
                "the fixed-grid substitution requires repeat(a positive integer, a positive px width) and a non-negative px gap",
            );
        }
        if (
            projectsGrid &&
            UiProjection.uiLastStyleProperty(value, "gap") !== undefined &&
            !/^([0-9]+(?:\.[0-9]*)?)px$/i.test(
                UiProjection.uiLastStyleProperty(value, "gap")!,
            )
        ) {
            this.uiStyleRefusal(
                site,
                "gap",
                "the fixed-grid substitution requires a static non-negative px gap",
            );
        }
        if (
            projectsGrid &&
            UiProjection.uiLastStyleProperty(value, "grid-template-rows") !==
                undefined &&
            !/^repeat\(\s*\d+\s*,\s*[0-9]+(?:\.[0-9]*)?px\s*\)$/i.test(
                UiProjection.uiLastStyleProperty(value, "grid-template-rows")!,
            )
        ) {
            this.uiStyleRefusal(
                site,
                "grid-template-rows",
                "the optional fixed row template must be repeat(integer, px)",
            );
        }
        UiProjection.forEachUiStyleDeclaration(value, (declaration) => {
            const colon = declaration.indexOf(":");
            if (colon < 0) {
                // Empty segments between semicolons; a declaration is only
                // a declaration once it names a property.
                return;
            }
            const property = declaration.slice(0, colon).trim().toLowerCase();
            const literalValue = declaration
                .slice(colon + 1)
                .trim()
                .toLowerCase();
            if (property.length === 0) return;
            if (property === "object-fit" && !/^(?:fill|contain|cover|none|scale-down)$/.test(literalValue)) {
                this.uiStyleRefusal(site, property, "only fill, contain, cover, none and scale-down are represented");
            }
            if (supportedUiLayoutValue(property, literalValue) === false) {
                this.uiStyleRefusal(site, property, "the value requires layout outside the supported literal flex and box forms");
            }
            if ((property === "overflow-wrap" || property === "word-wrap") && !/^(?:normal|break-word|anywhere)$/.test(literalValue)) {
                this.uiStyleRefusal(site, property, "only normal, break-word and anywhere wrapping are represented");
            }
            if (property === "word-break" && !/^(?:normal|break-word|break-all)$/.test(literalValue)) {
                this.uiStyleRefusal(site, property, "only normal, break-word and break-all are represented");
            }
            if (property === "scrollbar-width" && !/^(?:auto|thin|none)$/.test(literalValue)) {
                this.uiStyleRefusal(site, property, "only auto, thin and none are represented");
            }
            if (property === "scrollbar-color" && literalValue !== "auto") {
                const color = "(?:#[0-9a-f]{3,8}|rgba?\\([^()]+\\)|[a-z]+)";
                if (!new RegExp(`^${color}\\s+${color}$`).test(literalValue) || /\b(?:currentcolor|inherit|initial|unset|revert)\b/.test(literalValue)) {
                    this.uiStyleRefusal(site, property, "only auto or two literal RGB, hex or named colors are represented");
                }
            }
            if (property === "background-clip" && /^(?:border-box|padding-box|content-box)$/.test(literalValue)) {
                if (/gradient\(/i.test(value) || /(?:^|;)\s*background(?:-image)?\s*:[^;]*url\(/i.test(value)) {
                    this.uiStyleRefusal(site, property, "box clipping currently applies to solid backgrounds");
                }
                return;
            }
            if (property === "box-sizing" && !/^(?:content-box|border-box)$/.test(literalValue)) {
                this.uiStyleRefusal(site, property, "only content-box and border-box are represented");
            }
            if (property === "resize" && literalValue !== "vertical" && literalValue !== "none") this.uiStyleRefusal(site, property, "only vertical or none form-control resizing is represented");
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
            if (
                property === "box-shadow" &&
                UiProjection.insetOutlineBorder(literalValue) !== undefined
            ) {
                return;
            }
            if (
                (property === "backdrop-filter" ||
                    property === "-webkit-backdrop-filter") &&
                UiProjection.supportedBackdropFilter(literalValue)
            ) {
                return;
            }
            if (UiProjection.DEGRADED_UI_STYLE_PROPERTIES.has(property)) {
                this.uiDegradedStyleProperties.add(property);
                return;
            }
            if (property === "outline") {
                if (literalValue === "none") return;
                if (/^\d+(?:\.\d+)?px solid (?:#[0-9a-f]{3,8}|rgba?\([^;]+\)|[a-z]+)$/.test(literalValue)) return;
                this.uiStyleRefusal(
                    site,
                    property,
                    "outline requires none or a solid pixel-width color",
                );
            }
            if (property === "outline-offset" && /^\d+(?:\.\d+)?px$/.test(literalValue)) return;
            if (UiProjection.INERT_UI_STYLE_PROPERTIES.has(property)) return;
            if (property === "filter" && !clipsGradientToText) {
                if (!supportedUiFilter(declaration.slice(colon + 1))) {
                    this.uiStyleRefusal(site, property, "only color adjustments, pixel blur and drop shadows with literal colors are represented");
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
                property === "grid-template-columns" ||
                property === "grid-template-rows"
            ) {
                if (property === "grid-template-columns" && fractionalTracks) return;
                if (
                    !projectsGrid ||
                    (property === "grid-template-rows" &&
                        !/^repeat\(\s*\d+\s*,\s*[0-9]+(?:\.[0-9]*)?px\s*\)$/i.test(
                            UiProjection.uiLastStyleProperty(
                                value,
                                "grid-template-rows",
                            ) ?? "",
                        ))
                ) {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "the grid projection lowers only display:grid " +
                            "with grid-template-columns:repeat(N, px) in " +
                            "the same declaration list",
                    );
                }
                return;
            }
            if (
                property === "display" &&
                /\bgrid\b/.test(literalValue) &&
                !projectsGrid && !fractionalTracks
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "display:grid lowers only with " +
                        "grid-template-columns:repeat(N, px) in the same " +
                        "declaration list",
                );
            }
            if (
                property === "color" &&
                literalValue === "transparent" &&
                !clipsGradientToText
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "color:transparent is consumed only by the " +
                        "gradient-text projection",
                );
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
            const declaration =
                this.context.checker.getSymbolAtLocation(target)?.valueDeclaration;
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
            const divisor = this.context.compileValue(expression.right).staticNumber;
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
        const width = this.context.compileValue(argumentAt(call, 2)).staticNumber;
        const height = this.context.compileValue(argumentAt(call, 3)).staticNumber;
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
        const cssName = property
            .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
            .toLowerCase();
        return cssName === "background" ? "background-color" : cssName === "word-wrap" ? "overflow-wrap" : cssName;
    }

    private static readonly UI_SHORTHAND_RESETS: ReadonlyMap<string, readonly (readonly [string, string])[]> = new Map([
        ["background", [["background-clip", "border-box"]]],
        ["border", [["border-image", "none"]]],
    ]);

    private static uiShorthandResetStyle(property: string): string {
        return (UiProjection.UI_SHORTHAND_RESETS.get(property) ?? [])
            .map(([name, value]) => `${name}:${value};`).join("");
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


    private lowerUiBorderImage(value: string, site?: ts.Node): string {
        const image = /__BBLITE_UI_STYLE_\d+__/.test(value) ? undefined : parseUiBorderImage(value);
        if (image === undefined) {
            return this.uiStyleRefusal(site, "border-image", "only a static raster URL with non-negative slices and widths, zero outset, stretch and no center fill is represented");
        }
        if (image === "none") return image;
        return renderUiBorderImage(image, this.context.registerAsset(image.source, "texture").output);
    }

    public lowerUiAttributeLiteral(
        name: string,
        value: string,
        site?: ts.Node,
    ): string {
        if (name === "hidden" && value.toLowerCase() === "until-found") {
            this.context.fail(site ?? this.context.sourceFile, "UI hidden='until-found' requires find-in-page support.");
        }
        if (name !== "style") return value;
        this.auditUiStyleDeclarations(value, site);
        {
            const declarations: string[] = [];
            UiProjection.forEachUiStyleDeclaration(value, declaration => {
                const colon = declaration.indexOf(":");
                const property = declaration.slice(0, colon).trim().toLowerCase();
                let lowered = declaration;
                if (colon >= 0 && property === "border-image") {
                    lowered = `border-image:${this.lowerUiBorderImage(declaration.slice(colon + 1), site)}`;
                } else if (colon >= 0 && isUiLayoutProperty(property)) {
                    lowered = `${property}:${declaration.slice(colon + 1).trim().toLowerCase()}`;
                }
                declarations.push(lowered.replaceAll(";", UiProjection.UI_MASKED_SEMICOLON));
            });
            value = declarations.join(";");
        }
        // From here every read and rewrite is declaration-scoped by
        // regex; masking parenthesized semicolons makes those regexes
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
            // RmlUi resolves one family name here rather than a browser-style
            // fallback list. Route generic UI stacks to the system face that
            // the PAL loads, otherwise retain the first requested family.
            .replace(/\bfont-family\s*:\s*([^;]+)\s*;?/gi, (_match, family) => {
                const families = String(family)
                    .split(",")
                    .map((candidate) => candidate.trim())
                    .filter(Boolean);
                const first = families[0] ?? "sans-serif";
                if (/^system-ui$/i.test(first)) {
                    return "font-family:system-ui;";
                }
                if (/^sans-serif$/i.test(first)) {
                    return "font-family:sans-serif;";
                }
                if (/^monospace$/i.test(first)) {
                    return "font-family:monospace;";
                }
                return `font-family:${first};`;
            })
            .replace(
                /\binset\s*:\s*0(?:px)?\s*;?/gi,
                "top:0;right:0;bottom:0;left:0;",
            )
            // The reached voxel HUD spells its crosshair as two centred,
            // non-repeating background gradients. RmlUi gradients cover the
            // entire decorator box and cannot express CSS background sizing,
            // so preserve this exact shape as private PAL metadata. The PAL
            // materializes the vertical and horizontal bars as retained
            // children while the parent continues to own position/opacity.
            .replace(
                /\bbackground\s*:\s*linear-gradient\(\s*(#[0-9a-f]{3,8}|[a-z][a-z0-9-]*)\s*,\s*\1\s*\)\s+center\s*\/\s*2px\s+22px\s+no-repeat\s*,\s*linear-gradient\(\s*\1\s*,\s*\1\s*\)\s+center\s*\/\s*22px\s+2px\s+no-repeat\s*;?/gi,
                "--bbl-crosshair:$1;",
            )
            // RmlUi exposes CSS image gradients through its decorator
            // property. The shared render recorder implements the resulting
            // shader callback once for every PAL graphics backend.
            .replace(
                /\bbackground\s*:\s*((?:repeating-)?(?:linear|radial|conic)-gradient\([^;]*\))\s*;?/gi,
                "decorator:$1;",
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
            .replace(/\bbackground\s*:/gi, `${UiProjection.uiShorthandResetStyle("background")}background-color:`)
            .replace(/(?:-webkit-)?backdrop-filter\s*:\s*([^;]+)\s*;?/gi, (_match, filter) =>
                UiProjection.supportedBackdropFilter(String(filter))
                    ? `backdrop-filter:${String(filter).trim()};` : "")
            .replace(/\boutline-offset\s*:\s*([^;]+)\s*;?/gi, "--bbl-outline-offset:$1;")
            .replace(/\boutline\s*:\s*([^;]+)\s*;?/gi, "--bbl-outline:$1;")
            .replace(/\bbox-shadow\s*:\s*([^;]+)\s*;?/gi, (_match, shadow) => {
                const border = UiProjection.insetOutlineBorder(
                    String(shadow).trim(),
                );
                return border ? `--bbl-inset-outline:${border};` : "";
            })
            .replace(/\bmix-blend-mode\s*:[^;]*;?/gi, "")
            // RmlUi's border shorthand is `width color`; it deliberately
            // omits CSS border-style because every non-zero border is solid.
            // Translate the ordinary browser spelling instead of letting the
            // entire declaration be rejected by its shorthand parser.
            .replace(
                /\bborder\s*:\s*([^;\s]+)\s+solid\s+([^;]+)\s*;?/gi,
                "border:$1 $2;",
            )
            .replace(/\bborder\s*:\s*none\s*;?/gi, "border:0 transparent;")
            .replace(/\bborder\s*:/gi, `${UiProjection.uiShorthandResetStyle("border")}border:`)
            .replace(/\bbackground-size\s*:[^;]*;?/gi, "")
            .replace(
                /(^|;)\s*(?:-webkit-)?background-clip\s*:\s*text\s*(?=;|$)/gi,
                "$1",
            )
            .replace(/-webkit-text-stroke\s*:[^;]*;?/gi, "")
            .replace(/(^|;)\s*filter\s*:[^;]*/gi, (declaration, separator) => clipsGradientToText ? String(separator) : declaration.toLowerCase())
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
                `$1color:${gradientTextColor ?? "#fff"}`,
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

        // RmlUi 6.4 has no CSS Grid formatting context. Mark the reached
        // regular `repeat(N, px)` surface for the PAL to project as a
        // full-width outer box with a centred wrapping-flex inner box. Keeping
        // those boxes separate matters: in the browser the Tetris preview's
        // background spans the panel while only its 4x4 cells are centred.
        const fractionalTracks = UiProjection.fractionalUiGridTracks(lowered);
        if (fractionalTracks) {
            lowered = lowered
                .replace(/\bdisplay\s*:\s*grid\b/gi, "display:flex")
                .replace(/\bgrid-template-columns\s*:[^;]+;?/gi, "") +
                `;--bbl-fr-grid-tracks:${fractionalTracks.join(" ")};`;
        } else if (UiProjection.projectsUiGrid(lowered)) {
            this.uiSawGridDeclaration = true;
            const grid = UiProjection.uiGridProjection(lowered)!;
            const shrinkToTracks =
                /\bposition\s*:\s*absolute\b/i.test(lowered) &&
                !/(?:^|;)\s*width\s*:/i.test(lowered) &&
                /(?:^|;)\s*left\s*:/i.test(lowered) !==
                    /(?:^|;)\s*right\s*:/i.test(lowered);
            lowered =
                lowered
                    .replace(/\bdisplay\s*:\s*grid\b/gi, "display:block")
                    .replace(/\bgrid-template-columns\s*:[^;]+;?/gi, "")
                    .replace(/\bgrid-template-rows\s*:[^;]+;?/gi, "")
                    .replace(/\bgap\s*:[^;]+;?/gi, "")
                    .replace(/\bjustify-content\s*:[^;]+;?/gi, "") +
                (shrinkToTracks ? `;width:${grid.width}px` : "") +
                `;--bbl-grid-columns:${grid.columns};` +
                `--bbl-grid-cell-width:${grid.cellWidth}px;` +
                `--bbl-grid-width:${grid.width}px;` +
                `--bbl-grid-gap:${grid.gap}px;` +
                (grid.authoredJustifyContent === undefined
                    ? ""
                    : `--bbl-grid-justify-content:${grid.authoredJustifyContent};`) +
                (grid.rowHeight === undefined
                    ? ""
                    : `--bbl-grid-row-height:${grid.rowHeight}px;`) +
                (grid.rowCount === undefined
                    ? ""
                    : `--bbl-grid-row-count:${grid.rowCount};`);
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
                lowered += ";display:inline-block;";
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
        return lowered.replaceAll(UiProjection.UI_MASKED_SEMICOLON, ";");
    }


    /**
     * `@keyframes` blocks are not sheet rules: the whole sheet text also
     * rides `ui_set_text`, and the PAL extracts and projects the keyframes
     * from there (`pal_ui_rml.cpp` `keyframes_from`), so their interior
     * percentage blocks must not reach the rule parser. Mirrors the PAL's
     * brace-depth walk.
     */
    private static stripUiKeyframesBlocks(source: string): string {
        let result = "";
        let cursor = 0;
        for (;;) {
            const at = source.indexOf("@keyframes", cursor);
            if (at < 0) {
                result += source.slice(cursor);
                break;
            }
            result += source.slice(cursor, at);
            const opening = source.indexOf("{", at);
            if (opening < 0) break;
            let depth = 0;
            let end = opening;
            for (; end < source.length; end++) {
                if (source[end] === "{") {
                    depth++;
                } else if (source[end] === "}" && --depth === 0) {
                    end++;
                    break;
                }
            }
            cursor = end;
            if (depth !== 0) break;
        }
        return result;
    }


    /**
     * Parse the bounded author-sheet surface into typed retained rules. RmlUi
     * receives only selectors this parser names, so its selector engine
     * evaluates hover and max-width state without making arbitrary browser CSS
     * part of the generated runtime.
     */
    private lowerUiStyleSheetLiteral(
        value: string,
        site?: ts.Node,
        ownerId?: number,
    ): LoweredUiStyleRule[] {
        if (ownerId !== undefined && this.uiStaticMutationIsDynamic()) {
            this.uiStaticStyleCascadeKnown = false;
        }
        if (ownerId !== undefined) {
            for (
                let index = this.uiStyleRules.length - 1;
                index >= 0;
                index--
            ) {
                if (this.uiStyleRules[index]!.ownerId === ownerId) {
                    this.uiStyleRules.splice(index, 1);
                }
            }
        }
        const rules: LoweredUiStyleRule[] = [];
        const refuseSelector = (selector: string): never => {
            const message =
                `Retained stylesheet selector '${selector}' is not ` +
                "lowered: the reviewed sheet surface is exact '.class' and " +
                "'#id' rules, '.classA.classB', 'tag.class', 'tag > .class', statically-proven " +
                "'.ancestor tag', '#id .class' (optionally ':hover', ':active', ':focus-visible'), " +
                "scrollbar/track/thumb/button/corner pseudo-elements, " +
                "'@media (max-width:Npx)', '@media (prefers-reduced-motion:reduce|no-preference)', and '@keyframes' blocks.";
            if (site) this.context.fail(site, message);
            this.context.failAtFile(message);
        };
        const source = UiProjection.stripUiKeyframesBlocks(
            value.replace(/\/\*[\s\S]*?\*\//g, ""),
        );

        const parseBlocks = (
            text: string,
            inheritedMaxWidth?: number,
            inheritedReducedMotion?: boolean,
        ): void => {
            let cursor = 0;
            while (cursor < text.length) {
                while (cursor < text.length && /[\s;]/.test(text[cursor]!)) {
                    cursor++;
                }
                if (cursor >= text.length) break;
                const opening = text.indexOf("{", cursor);
                if (opening < 0) {
                    refuseSelector(text.slice(cursor).trim());
                }
                const header = text.slice(cursor, opening).trim();
                let quote = "";
                let depth = 1;
                let end = opening + 1;
                for (; end < text.length && depth > 0; end++) {
                    const character = text[end]!;
                    if (quote) {
                        if (character === quote && text[end - 1] !== "\\") {
                            quote = "";
                        }
                    } else if (character === "'" || character === '"') {
                        quote = character;
                    } else if (character === "{") {
                        depth++;
                    } else if (character === "}") {
                        depth--;
                    }
                }
                if (depth !== 0) refuseSelector(header);
                const body = text.slice(opening + 1, end - 1);
                cursor = end;

                if (/^@media\b/i.test(header)) {
                    if (inheritedMaxWidth !== undefined || inheritedReducedMotion !== undefined) {
                        refuseSelector(header);
                    }
                    const motion = /^@media\s*\(\s*prefers-reduced-motion\s*:\s*(reduce|no-preference)\s*\)$/i.exec(header);
                    if (motion) {
                        parseBlocks(body, undefined, motion[1]!.toLowerCase() === "reduce");
                        continue;
                    }
                    const media = header.match(
                        /^@media\s*\(\s*max-width\s*:\s*([0-9]+(?:\.[0-9]*)?)px\s*\)$/i,
                    );
                    const maxWidth = Number(media?.[1]);
                    if (!media || !Number.isFinite(maxWidth) || maxWidth < 0) {
                        refuseSelector(header);
                    }
                    parseBlocks(body, maxWidth);
                    continue;
                }
                if (header.startsWith("@")) refuseSelector(header);
                if (body.includes("{") || body.includes("}")) {
                    refuseSelector(header);
                }

                const sourceStyle = body.trim();
                if (inheritedMaxWidth !== undefined) {
                    const mediaProperties = new EmissionSet([
                        "bottom",
                        "font-size",
                        "height",
                        "left",
                        "max-height",
                        "max-width",
                        "min-height",
                        "min-width",
                        "right",
                        "top",
                        "width",
                    ]);
                    UiProjection.forEachUiStyleDeclaration(
                        sourceStyle,
                        (declaration) => {
                            const colon = declaration.indexOf(":");
                            if (colon < 0) return;
                            const property = declaration
                                .slice(0, colon)
                                .trim()
                                .toLowerCase();
                            if (!mediaProperties.has(property)) {
                                this.uiStyleRefusal(
                                    site,
                                    property,
                                    "max-width rules are bounded to the reached position, size, and font-size overrides",
                                );
                            }
                        },
                    );
                }
                const grid = UiProjection.uiGridProjection(sourceStyle);
                if ((grid || UiProjection.fractionalUiGridTracks(sourceStyle)) &&
                    (inheritedMaxWidth !== undefined || inheritedReducedMotion !== undefined)) {
                    this.uiStyleRefusal(
                        site,
                        "display",
                        "the structural grid substitution is not accepted inside a media query",
                    );
                }
                const selectors = header
                    .split(",")
                    .map((selector) => selector.trim());
                for (const selector of selectors) {
                    if (
                        /^\.([A-Za-z_][A-Za-z0-9_-]*)\s+(?:path|rect)(?::hover)?$/i.test(
                            selector,
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
                const style = this.lowerUiAttributeLiteral(
                    "style",
                    sourceStyle,
                    site,
                );
                for (const selector of selectors) {
                    const rule =
                        UiProjection.parseUiSelector(selector, style) ??
                        refuseSelector(selector);
                    if (inheritedMaxWidth !== undefined) {
                        rule.maxWidth = inheritedMaxWidth;
                    }
                    if (inheritedReducedMotion !== undefined) rule.reducedMotion = inheritedReducedMotion;
                    if (site) rule.site = site;
                    if (ownerId !== undefined) rule.ownerId = ownerId;
                    if (grid) {
                        if (
                            uiStyleInteractionStateCount(rule) > 0 ||
                            rule.scrollbar ||
                            (rule.kind !== "class" && rule.kind !== "id")
                        ) {
                            this.uiStyleRefusal(
                                site,
                                "display",
                                "the structural fixed-grid substitution requires one stable '.class' or '#id' target",
                            );
                        }
                        rule.grid = grid;
                    }
                    if (
                        !rule.scrollbar && (
                        rule.kind === "class-descendant-tag" ||
                        rule.kind === "id-descendant-class")
                    ) {
                        this.uiScopedSheetSelectors.add(selector);
                    }
                    if (!style) continue;
                    rules.push(rule);
                    // Anonymous scrollbar controls cannot affect static proofs
                    // over the authored element tree.
                    if (!rule.scrollbar) this.uiStyleRules.push(rule);
                }
            }
        };
        parseBlocks(source);
        return rules;
    }


    public uiStaticDescendants(rootId: number): {
        elements: Set<number>;
        markup: UiStaticMarkupNode[];
        complete: boolean;
    } {
        const elements = new EmissionSet<number>();
        const markup: UiStaticMarkupNode[] = [];
        let complete = true;
        const addMarkup = (node: UiStaticMarkupNode): void => {
            markup.push(node);
            for (const child of node.children) addMarkup(child);
        };
        const visit = (id: number): void => {
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
        return { elements, markup, complete };
    }


    private uiRuleMatchesDirectWithClasses(
        rule: LoweredUiStyleRule,
        element: UiStaticElement,
        classes: ReadonlySet<string>,
    ): boolean {
        if (rule.scrollbar) return false;
        switch (rule.kind) {
            case "class":
                return classes.has(rule.primary);
            case "id":
                return element.ids.has(rule.primary);
            case "compound-class":
                return (
                    classes.has(rule.primary) && classes.has(rule.secondary!)
                );
            case "tag-class":
                return element.tag === rule.tag && classes.has(rule.primary);
            case "class-descendant-tag":
            case "id-descendant-class":
            case "tag-child-class":
                return false;
        }
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
        const scrollbar = selector.match(/^(.*?)::-webkit-scrollbar(?:-(thumb|track|button|corner))?(:hover)?$/);
        if (scrollbar) {
            const owner = UiProjection.parseUiSelector(scrollbar[1]!, style);
            const part = scrollbar[2] ?? "scrollbar";
            if (!owner || owner.scrollbar || uiStyleInteractionStateCount(owner) > 0 || !isUiScrollbarPart(part)) return undefined;
            return { ...owner, scrollbar: part, hover: scrollbar[3] !== undefined, selector };
        }
        const state = /:(hover|active|focus-visible)$/i.exec(selector);
        if (state) {
            const owner = UiProjection.parseUiSelector(selector.slice(0, -state[0].length), style);
            const property = state[1]!.toLowerCase() === "focus-visible" ? "focusVisible" :
                state[1]!.toLowerCase() === "active" ? "active" : "hover";
            if (!owner || owner[property] || owner.scrollbar) return undefined;
            return { ...owner, [property]: true, selector };
        }
        const identifier = "[A-Za-z_][A-Za-z0-9_-]*";
        const tag = "[a-z][a-z0-9-]*";
        const forms: readonly (readonly [
            RegExp,
            (match: RegExpMatchArray) => LoweredUiStyleRule,
        ])[] = [
            [
                new RegExp(`^(${tag})\\s*>\\s*\\.(${identifier})(?:\\.(${identifier}))?$`, "i"),
                (match) => ({kind: "tag-child-class", tag: match[1]!.toLowerCase(), primary: match[2]!, ...(match[3] ? {secondary: match[3]} : {}), hover: false, style, selector}),
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
        return undefined;
    }


    private uiRuleMatchesDirect(
        rule: LoweredUiStyleRule,
        element: UiStaticElement,
    ): boolean {
        return element.classAlternatives.some((classes) =>
            this.uiRuleMatchesDirectWithClasses(rule, element, classes),
        );
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


    private uiRuleSpecificity(rule: LoweredUiStyleRule): number {
        const states = uiStyleInteractionStateCount(rule);
        switch (rule.kind) {
            case "class":
                return (1 + states) * 0x100;
            case "id":
                return 0x10000 + states * 0x100;
            case "compound-class":
                return (2 + states) * 0x100;
            case "class-descendant-tag":
            case "tag-class":
                return (1 + states) * 0x100 + 1;
            case "tag-child-class":
                return (1 + Number(rule.secondary !== undefined) + states) * 0x100 + 1;
            case "id-descendant-class":
                return 0x10000 + (1 + states) * 0x100;
        }
    }


    /**
     * Scene-created sheets participate only while directly attached to the
     * document, in that live order. Rule creation/population order is not CSS
     * source order across sheets.
     */
    private uiActiveStyleRulesInCascade(): readonly LoweredUiStyleRule[] {
        if (this.uiValidation) {
            return this.uiValidation.activeRules;
        }
        const rulesByOwner = new EmissionMap<number, LoweredUiStyleRule[]>();
        for (const rule of this.uiStyleRules) {
            if (rule.ownerId === undefined) continue;
            const owned = rulesByOwner.get(rule.ownerId) ?? [];
            owned.push(rule);
            rulesByOwner.set(rule.ownerId, owned);
        }
        return this.uiStaticRootOrder.flatMap(
            (ownerId) => rulesByOwner.get(ownerId) ?? [],
        );
    }


    private uiStaticAncestors(id: number): UiStaticElement[] {
        const cached = this.uiValidation?.ancestorsById.get(id);
        if (cached) return cached;
        const ancestors: UiStaticElement[] = [];
        const pending = [id];
        const visited = new EmissionSet<number>(pending);
        while (pending.length > 0) {
            const child = pending.pop()!;
            const parentIds = this.uiValidation?.parentsByChild.get(child);
            const candidates = parentIds
                ? parentIds.map(
                      (candidateId) =>
                          [
                              candidateId,
                              this.uiStaticElements.get(candidateId)!,
                          ] as const,
                  )
                : [...this.uiStaticElements].filter(([, candidate]) =>
                      candidate.children.has(child),
                  );
            for (const [candidateId, candidate] of candidates) {
                if (visited.has(candidateId)) continue;
                visited.add(candidateId);
                ancestors.push(candidate);
                pending.push(candidateId);
            }
        }
        this.uiValidation?.ancestorsById.set(id, ancestors);
        return ancestors;
    }


    private uiRuleMatchesStaticElement(
        rule: LoweredUiStyleRule,
        id: number,
        element: UiStaticElement,
    ): boolean {
        return element.classAlternatives.some((classes) =>
            this.uiRuleMatchesStaticElementWithClasses(
                rule,
                id,
                element,
                classes,
            ),
        );
    }


    private uiStaticParentHasTag(id: number, tag: string): boolean {
        if (tag === "body" && this.uiStaticRootOrder.includes(id)) return true;
        const parents = this.uiValidation?.parentsByChild.get(id);
        return parents ? parents.some(parent => this.uiStaticElements.get(parent)?.tag === tag)
            : [...this.uiStaticElements.values()].some(parent => parent.tag === tag && parent.children.has(id));
    }

    private uiRuleMatchesStaticElementWithClasses(
        rule: LoweredUiStyleRule,
        id: number,
        element: UiStaticElement,
        classes: ReadonlySet<string>,
    ): boolean {
        if (rule.kind === "tag-child-class") return classes.has(rule.primary) && (!rule.secondary || classes.has(rule.secondary)) && this.uiStaticParentHasTag(id, rule.tag!);
        if (
            rule.kind !== "class-descendant-tag" &&
            rule.kind !== "id-descendant-class"
        ) {
            return this.uiRuleMatchesDirectWithClasses(rule, element, classes);
        }
        const ancestors = this.uiStaticAncestors(id);
        return rule.kind === "class-descendant-tag"
            ? element.tag === rule.tag &&
                  ancestors.some((ancestor) =>
                      ancestor.classAlternatives.some((ancestorClasses) =>
                          ancestorClasses.has(rule.primary),
                      ),
                  )
            : classes.has(rule.secondary!) &&
                  ancestors.some((ancestor) => ancestor.ids.has(rule.primary));
    }


    private uiRuleDependsOnMutableClass(
        rule: LoweredUiStyleRule,
        id: number,
        element: UiStaticElement,
    ): boolean {
        switch (rule.kind) {
            case "class":
                return element.mutableClasses.has(rule.primary);
            case "id":
                return false;
            case "compound-class":
            case "tag-child-class":
                return (
                    element.mutableClasses.has(rule.primary) ||
                    (rule.secondary !== undefined && element.mutableClasses.has(rule.secondary))
                );
            case "tag-class":
                return (
                    element.tag === rule.tag &&
                    element.mutableClasses.has(rule.primary)
                );
            case "class-descendant-tag":
                return this.uiStaticAncestors(id).some((ancestor) =>
                    ancestor.mutableClasses.has(rule.primary),
                );
            case "id-descendant-class":
                return element.mutableClasses.has(rule.secondary!);
        }
    }


    private uiRuleMentionsClass(
        rule: LoweredUiStyleRule,
        className: string,
    ): boolean {
        switch (rule.kind) {
            case "class":
            case "class-descendant-tag":
            case "tag-class":
                return rule.primary === className;
            case "compound-class":
            case "tag-child-class":
                return (
                    rule.primary === className || rule.secondary === className
                );
            case "id-descendant-class":
                return rule.secondary === className;
            case "id":
                return false;
        }
    }


    private uiRuleCouldMatchGridChildAfterUnknownClassMutation(
        rule: LoweredUiStyleRule,
        className: string,
        childId: number,
        child: UiStaticElement,
    ): boolean {
        switch (rule.kind) {
            case "tag-child-class":
                return this.uiStaticParentHasTag(childId, rule.tag!) && child.classAlternatives.some(classes =>
                    (rule.primary === className && (!rule.secondary || classes.has(rule.secondary))) ||
                    (rule.secondary === className && classes.has(rule.primary)));
            case "class":
                return rule.primary === className;
            case "id":
                return false;
            case "compound-class":
                return (
                    (rule.primary === className &&
                        child.classAlternatives.some((classes) =>
                            classes.has(rule.secondary!),
                        )) ||
                    (rule.secondary === className &&
                        child.classAlternatives.some((classes) =>
                            classes.has(rule.primary),
                        ))
                );
            case "class-descendant-tag":
            case "tag-class":
                return rule.primary === className && child.tag === rule.tag;
            case "id-descendant-class":
                return (
                    rule.secondary === className &&
                    this.uiStaticAncestors(childId).some((ancestor) =>
                        ancestor.ids.has(rule.primary),
                    )
                );
        }
    }


    private uiUnknownAttributeCouldAffectRule(
        mutation: UiUnknownAttributeMutation,
        rule: LoweredUiStyleRule,
        elementId: number,
        element: UiStaticElement,
    ): boolean {
        const sameTarget =
            mutation.targetId === undefined || mutation.targetId === elementId;
        const target =
            mutation.targetId === undefined
                ? undefined
                : this.uiStaticElements.get(mutation.targetId);
        const targetIsAncestor =
            mutation.targetId === undefined ||
            (target !== undefined &&
                this.uiStaticAncestors(elementId).includes(target));
        if (mutation.attribute === "class") {
            switch (rule.kind) {
                case "tag-child-class":
                    return sameTarget && this.uiStaticParentHasTag(elementId, rule.tag!);
                case "class":
                case "compound-class":
                    return sameTarget;
                case "tag-class":
                    return sameTarget && element.tag === rule.tag;
                case "class-descendant-tag":
                    return targetIsAncestor && element.tag === rule.tag;
                case "id-descendant-class":
                    return (
                        sameTarget &&
                        this.uiStaticAncestors(elementId).some((ancestor) =>
                            ancestor.ids.has(rule.primary),
                        )
                    );
                case "id":
                    return false;
            }
        }
        switch (rule.kind) {
            case "id":
                return sameTarget;
            case "id-descendant-class":
                return (
                    targetIsAncestor &&
                    element.classAlternatives.some((classes) =>
                        classes.has(rule.secondary!),
                    )
                );
            case "class":
            case "compound-class":
            case "class-descendant-tag":
            case "tag-class":
            case "tag-child-class":
                return false;
        }
    }


    private uiGridChildGeometryProperty(
        rule: LoweredUiStyleRule,
        includeExplicitRowFlow = false,
    ): string | undefined {
        if (includeExplicitRowFlow) {
            const display = this.uiStaticStyleProperty(rule.style, "display")
                ?.trim()
                .toLowerCase();
            if (display === "none") return "display";
            const position = this.uiStaticStyleProperty(rule.style, "position")
                ?.trim()
                .toLowerCase();
            if (position === "absolute" || position === "fixed") {
                return "position";
            }
        }
        return UiProjection.UI_GRID_CHILD_GEOMETRY_PROPERTIES.find(
            (property) =>
                this.uiStaticStyleProperty(rule.style, property) !== undefined,
        );
    }


    private uiStaticStyleProperty(
        style: string,
        property: string,
    ): string | undefined {
        return UiProjection.uiLastStyleProperty(style, property);
    }


    private uiStaticElementStylePropertyForState(
        id: number,
        property: string,
        classes: ReadonlySet<string>,
        inlineStyle: string,
    ): string | undefined {
        const element = this.uiStaticElements.get(id);
        if (!element) return undefined;
        let result: string | undefined;
        let specificity = -1;
        let sourceOrder = -1;
        const activeRules = this.uiActiveStyleRulesInCascade();
        for (let index = 0; index < activeRules.length; index++) {
            const rule = activeRules[index]!;
            if (
                uiStyleInteractionStateCount(rule) > 0 ||
                uiStyleRuleHasMedia(rule) ||
                !this.uiRuleMatchesStaticElementWithClasses(
                    rule,
                    id,
                    element,
                    classes,
                )
            ) {
                continue;
            }
            const value = this.uiStaticStyleProperty(rule.style, property);
            if (value === undefined) continue;
            const candidateSpecificity = this.uiRuleSpecificity(rule);
            if (
                candidateSpecificity > specificity ||
                (candidateSpecificity === specificity && index > sourceOrder)
            ) {
                result = value;
                specificity = candidateSpecificity;
                sourceOrder = index;
            }
        }
        result = this.uiStaticStyleProperty(inlineStyle, property) ?? result;
        return result;
    }


    private uiStaticElementStylePropertyValues(
        id: number,
        property: string,
    ): Set<string | undefined> {
        const element = this.uiStaticElements.get(id);
        if (!element) return new EmissionSet([undefined]);
        const values = new EmissionSet<string | undefined>();
        for (const classes of element.classAlternatives) {
            for (const style of element.styles) {
                values.add(
                    this.uiStaticElementStylePropertyForState(
                        id,
                        property,
                        classes,
                        style,
                    ),
                );
            }
        }
        return values;
    }


    private uiStaticEffectiveGrid(
        id: number,
        classes: ReadonlySet<string>,
    ):
        | {
              grid: UiGridProjection;
              label: string;
              site?: ts.Node;
          }
        | undefined {
        const element = this.uiStaticElements.get(id);
        if (!element) return undefined;
        interface CascadedValue<T> {
            value: T;
            specificity: number;
            sourceOrder: number;
        }
        let display:
            | CascadedValue<{
                  value: string;
                  grid?: UiGridProjection;
                  label: string;
                  site?: ts.Node;
              }>
            | undefined;
        let justification: CascadedValue<string> | undefined;
        const wins = <T>(
            current: CascadedValue<T> | undefined,
            specificity: number,
            sourceOrder: number,
        ): boolean =>
            current === undefined ||
            specificity > current.specificity ||
            (specificity === current.specificity &&
                sourceOrder >= current.sourceOrder);
        const activeRules = this.uiActiveStyleRulesInCascade();
        const normalizedKeyword = (
            value: string | undefined,
        ): string | undefined => value?.trim().toLowerCase();
        const possibleGrid =
            activeRules.some(
                (rule) =>
                    rule.grid !== undefined &&
                    this.uiRuleMatchesStaticElementWithClasses(
                        rule,
                        id,
                        element,
                        classes,
                    ),
            ) ||
            element.styles.some(
                (style) => this.uiGridFromLoweredStyle(style) !== undefined,
            );
        const refuseAlternative = (
            reason: string,
            rule?: LoweredUiStyleRule,
        ): never => {
            const message =
                `Retained UI fixed-grid projection on <${element.tag}> ` +
                `construction site ${id} ${reason}.`;
            if (rule?.site) this.context.fail(rule.site, message);
            this.context.failAtFile(message);
        };
        if (possibleGrid && !element.styleShapeKnown) {
            refuseAlternative(
                "has a runtime cssText replacement whose final declarations are unknown",
            );
        }
        if (possibleGrid && element.styles.length > 1) {
            const signatures = element.styles.map((style) =>
                JSON.stringify({
                    display: normalizedKeyword(
                        this.uiStaticStyleProperty(style, "display"),
                    ),
                    grid: this.uiGridFromLoweredStyle(style),
                    justification: normalizedKeyword(
                        this.uiStaticStyleProperty(style, "justify-content"),
                    ),
                }),
            );
            if (new EmissionSet(signatures).size > 1) {
                refuseAlternative(
                    "depends on mutually exclusive cssText replacement alternatives",
                );
            }
        }
        const applyCascadeCandidate = (
            style: string,
            grid: UiGridProjection | undefined,
            label: string,
            specificity: number,
            sourceOrder: number,
            site?: ts.Node,
        ): void => {
            const displayValue = grid
                ? "grid"
                : normalizedKeyword(
                      this.uiStaticStyleProperty(style, "display"),
                  );
            if (
                displayValue !== undefined &&
                wins(display, specificity, sourceOrder)
            ) {
                display = {
                    value: {
                        value: displayValue,
                        ...(grid ? { grid } : {}),
                        label,
                        ...(site ? { site } : {}),
                    },
                    specificity,
                    sourceOrder,
                };
            }
            const justifyValue =
                grid?.authoredJustifyContent ??
                normalizedKeyword(
                    this.uiStaticStyleProperty(style, "justify-content"),
                );
            if (
                justifyValue !== undefined &&
                wins(justification, specificity, sourceOrder)
            ) {
                justification = {
                    value: justifyValue,
                    specificity,
                    sourceOrder,
                };
            }
        };
        for (let index = 0; index < activeRules.length; index++) {
            const rule = activeRules[index]!;
            if (
                uiStyleInteractionStateCount(rule) > 0 ||
                uiStyleRuleHasMedia(rule) ||
                !this.uiRuleMatchesStaticElementWithClasses(
                    rule,
                    id,
                    element,
                    classes,
                )
            ) {
                continue;
            }
            applyCascadeCandidate(
                rule.style,
                rule.grid,
                rule.selector,
                this.uiRuleSpecificity(rule),
                index,
                rule.site,
            );
        }

        const inlineSpecificity = 0x1000000;
        for (let index = 0; index < element.styles.length; index++) {
            const style = element.styles[index]!;
            const sourceOrder = activeRules.length + index;
            const grid = this.uiGridFromLoweredStyle(style);
            applyCascadeCandidate(
                style,
                grid,
                `<${element.tag}> construction site ${id}`,
                inlineSpecificity,
                sourceOrder,
            );
        }

        if (
            possibleGrid &&
            (display?.value.value === "__bbl_dynamic_style_value__" ||
                justification?.value === "__bbl_dynamic_style_value__")
        ) {
            const message =
                `Retained UI fixed-grid projection '${display?.value.label ?? `<${element.tag}> construction site ${id}`}' ` +
                "has a runtime structural display or alignment override.";
            if (display?.value.site) this.context.fail(display.value.site, message);
            this.context.failAtFile(message);
        }
        if (display?.value.value === "grid" && !display.value.grid) {
            const message =
                `Retained UI fixed-grid projection '${display.value.label}' ` +
                "is activated by a separate display:grid override whose " +
                "track metadata cannot be proven.";
            if (display.value.site) this.context.fail(display.value.site, message);
            this.context.failAtFile(message);
        }
        if (display?.value.value !== "grid" || !display.value.grid) {
            return undefined;
        }
        const authored = justification?.value.trim().toLowerCase();
        const normalized = UiProjection.normalizeUiGridJustification(authored);
        if (normalized === undefined) {
            const message =
                `Retained UI fixed-grid projection '${display.value.label}' ` +
                `cannot preserve justify-content '${authored}'.`;
            if (display.value.site) this.context.fail(display.value.site, message);
            this.context.failAtFile(message);
        }
        return {
            grid: {
                ...display.value.grid,
                ...(justification === undefined
                    ? {}
                    : { authoredJustifyContent: normalized }),
            },
            label: display.value.label,
            ...(display.value.site ? { site: display.value.site } : {}),
        };
    }


    private uiGridFromLoweredStyle(
        style: string,
    ): UiGridProjection | undefined {
        const columns = Number(
            this.uiStaticStyleProperty(style, "--bbl-grid-columns"),
        );
        const cellWidth = Number.parseFloat(
            this.uiStaticStyleProperty(style, "--bbl-grid-cell-width") ?? "",
        );
        const width = Number.parseFloat(
            this.uiStaticStyleProperty(style, "--bbl-grid-width") ?? "",
        );
        const gap = Number.parseFloat(
            this.uiStaticStyleProperty(style, "--bbl-grid-gap") ?? "",
        );
        const row = this.uiStaticStyleProperty(style, "--bbl-grid-row-height");
        const rowCount = this.uiStaticStyleProperty(
            style,
            "--bbl-grid-row-count",
        );
        const justification = this.uiStaticStyleProperty(
            style,
            "--bbl-grid-justify-content",
        );
        if (
            !Number.isInteger(columns) ||
            columns < 1 ||
            !Number.isFinite(cellWidth) ||
            !Number.isFinite(width) ||
            !Number.isFinite(gap) ||
            (row !== undefined && !Number.isFinite(Number.parseFloat(row))) ||
            (rowCount !== undefined &&
                (!Number.isInteger(Number(rowCount)) || Number(rowCount) < 1))
        ) {
            return undefined;
        }
        return {
            columns,
            cellWidth,
            width,
            gap,
            ...(justification === undefined
                ? {}
                : {
                      authoredJustifyContent:
                          justification === "center" || justification === "end"
                              ? justification
                              : "start",
                  }),
            ...(row === undefined ? {} : { rowHeight: Number.parseFloat(row) }),
            ...(rowCount === undefined ? {} : { rowCount: Number(rowCount) }),
        };
    }


    private validateUiGridProjection(
        parentId: number,
        grid: UiGridProjection,
        label: string,
        site?: ts.Node,
    ): void {
        const fail = (reason: string): never => {
            const message =
                `Retained UI fixed-grid projection '${label}' is not ` +
                `provably equivalent to wrapping flex: ${reason}.`;
            if (site) this.context.fail(site, message);
            this.context.failAtFile(message);
        };
        const parent =
            this.uiStaticElements.get(parentId) ??
            fail("its target construction site is unknown");
        if (!parent.childShapeKnown || parent.children.size === 0) {
            fail("its complete direct-child shape is not statically known");
        }
        if (grid.rowCount !== undefined) {
            if (!parent.childCardinalityKnown) {
                fail(
                    "its explicit row template requires a statically known child count",
                );
            }
            const actualRows = Math.ceil(parent.children.size / grid.columns);
            if (grid.rowCount !== actualRows) {
                fail(
                    `the explicit ${grid.rowCount}-row template does not match ` +
                        `the proven ${actualRows}-row child layout`,
                );
            }
        }
        let childHeight: number | undefined;
        for (const childId of parent.children) {
            const child = this.uiStaticElements.get(childId)!;
            if (!child) {
                fail("a direct child has an unknown construction shape");
            }
            if (
                !child.classShapeKnown &&
                !this.uiUnknownAttributeMutations.some(
                    (mutation) =>
                        mutation.attribute === "class" &&
                        mutation.targetId === childId,
                )
            ) {
                fail(
                    "a direct child has an unknown class or construction shape",
                );
            }
            if (!child.styleShapeKnown) {
                fail("a direct child has an unknown final cssText shape");
            }
            const geometryProperties = [
                ...UiProjection.UI_GRID_CHILD_GEOMETRY_PROPERTIES,
                ...(grid.rowCount === undefined ? [] : ["display", "position"]),
            ];
            const parsePixels = (
                value: string | undefined,
            ): number | undefined => {
                const match = value?.match(/^([0-9]+(?:\.[0-9]*)?)px$/i);
                return match ? Number(match[1]) : undefined;
            };
            const heightValues = this.uiStaticElementStylePropertyValues(
                childId,
                "height",
            );
            const fixedHeight =
                heightValues.size === 1
                    ? parsePixels(heightValues.values().next().value)
                    : undefined;
            const geometryValueIsProvenEqual = (
                property: string,
                value: string | undefined,
            ): boolean => {
                const normalized = value?.trim().toLowerCase();
                if (property === "display") {
                    return (
                        normalized !== "none" &&
                        normalized !== "__bbl_dynamic_style_value__"
                    );
                }
                if (property === "position") {
                    return (
                        normalized !== "absolute" &&
                        normalized !== "fixed" &&
                        normalized !== "__bbl_dynamic_style_value__"
                    );
                }
                const expected = /^(?:min-|max-)?width$/.test(property)
                    ? grid.cellWidth
                    : /^(?:min-|max-)?height$/.test(property)
                      ? fixedHeight
                      : undefined;
                return (
                    expected !== undefined && parsePixels(value) === expected
                );
            };
            const activeRules = this.uiActiveStyleRulesInCascade();
            const changedGeometryProperty = (
                rule: LoweredUiStyleRule,
            ): string | undefined =>
                geometryProperties.find((property) => {
                    const value = this.uiStaticStyleProperty(
                        rule.style,
                        property,
                    );
                    return (
                        value !== undefined &&
                        !geometryValueIsProvenEqual(property, value)
                    );
                });
            const unknownClassSites = new EmissionMap<string, ts.Node>();
            for (const mutation of this.uiUnknownClassMutations) {
                unknownClassSites.set(mutation.className, mutation.site);
            }
            for (const rule of activeRules) {
                if (rule.kind !== "compound-class") continue;
                const property = changedGeometryProperty(rule);
                if (!property) continue;
                const required = new EmissionSet([rule.primary, rule.secondary!]);
                if (
                    [...required].every((name) => unknownClassSites.has(name))
                ) {
                    const lastMutation = [...this.uiUnknownClassMutations]
                        .reverse()
                        .find((mutation) => required.has(mutation.className))!;
                    this.context.fail(
                        lastMutation.site,
                        `Retained UI class mutations '${[...required].join(
                            "', '",
                        )}' have unknown targets and can jointly activate ` +
                            `geometry rule '${rule.selector}', changing ` +
                            `direct-child ${property}.`,
                    );
                }
            }
            for (const rule of activeRules) {
                if (
                    !this.uiRuleMatchesStaticElement(rule, childId, child) ||
                    (!uiStyleRuleHasMedia(rule) &&
                        uiStyleInteractionStateCount(rule) === 0 &&
                        !this.uiRuleDependsOnMutableClass(rule, childId, child))
                ) {
                    continue;
                }
                const property = changedGeometryProperty(rule);
                if (property) {
                    const trigger =
                        uiStyleRuleHasMedia(rule)
                            ? `${rule.maxWidth !== undefined ? "max-width" : "motion preference"} rule '${rule.selector}'`
                            : uiStyleInteractionStateCount(rule) > 0
                              ? `${rule.hover ? "hover" : "interaction"} rule '${rule.selector}'`
                              : `runtime class rule '${rule.selector}'`;
                    fail(`${trigger} can change direct-child ${property}`);
                }
            }
            for (const mutation of this.uiUnknownClassMutations) {
                const rule = activeRules.find(
                    (candidate) =>
                        this.uiRuleCouldMatchGridChildAfterUnknownClassMutation(
                            candidate,
                            mutation.className,
                            childId,
                            child,
                        ) && changedGeometryProperty(candidate) !== undefined,
                );
                if (rule) {
                    const property = changedGeometryProperty(rule)!;
                    fail(
                        `class mutation '${mutation.className}' has an ` +
                            `unknown target and rule '${rule.selector}' can ` +
                            `change direct-child ${property}`,
                    );
                }
            }
            const singleProperty = (property: string): string | undefined => {
                const values = this.uiStaticElementStylePropertyValues(
                    childId,
                    property,
                );
                if (values.size !== 1) {
                    fail(
                        `direct-child ${property} differs across reachable ` +
                            "className or cssText alternatives",
                    );
                }
                return values.values().next().value;
            };
            if (grid.rowCount !== undefined) {
                for (const [property, values] of [
                    [
                        "display",
                        this.uiStaticElementStylePropertyValues(
                            childId,
                            "display",
                        ),
                    ],
                    [
                        "position",
                        this.uiStaticElementStylePropertyValues(
                            childId,
                            "position",
                        ),
                    ],
                ] as const) {
                    const value = [...values].find(
                        (candidate) =>
                            candidate !== undefined &&
                            !geometryValueIsProvenEqual(property, candidate),
                    );
                    if (value !== undefined) {
                        fail(
                            `explicit rows require every counted child to ` +
                                `participate in normal flow; child ${property} ` +
                                `is '${value}'`,
                        );
                    }
                }
            }
            const width = singleProperty("width");
            const height = singleProperty("height");
            const widthPixels = parsePixels(width);
            const heightPixels = parsePixels(height);
            if (widthPixels !== grid.cellWidth || heightPixels === undefined) {
                fail(
                    `every child must have fixed ${grid.cellWidth}px width ` +
                        "and a fixed px height",
                );
            }
            if (childHeight !== undefined && childHeight !== heightPixels) {
                fail("direct-child heights are not uniform");
            }
            childHeight = heightPixels;
            for (const [property, expected] of [
                ["min-width", widthPixels],
                ["max-width", widthPixels],
                ["min-height", heightPixels],
                ["max-height", heightPixels],
            ] as const) {
                const value = singleProperty(property);
                if (value !== undefined && parsePixels(value) !== expected) {
                    fail(
                        `child ${property} '${value}' is not proven equal to ` +
                            `its fixed ${expected}px geometry`,
                    );
                }
            }
            if (
                grid.rowHeight !== undefined &&
                grid.rowHeight !== heightPixels
            ) {
                fail(
                    `the ${grid.rowHeight}px row track does not match the ` +
                        `${heightPixels}px child height`,
                );
            }
            for (const property of UiProjection.UI_GRID_CHILD_SPACING_PROPERTIES) {
                const value = singleProperty(property);
                if (
                    value !== undefined &&
                    !/^(?:0(?:px)?)(?:\s+0(?:px)?){0,3}$/i.test(value)
                ) {
                    fail(
                        `child ${property} '${value}' changes the fixed track`,
                    );
                }
            }
            const border = singleProperty("border");
            if (
                border !== undefined &&
                !/^(?:none|0(?:px)?(?:\s+transparent)?)$/i.test(border)
            ) {
                fail(`child border '${border}' changes the fixed track`);
            }
            for (const property of UiProjection.UI_GRID_CHILD_BORDER_WIDTH_PROPERTIES) {
                const value = singleProperty(property);
                if (value !== undefined && !/^0(?:px)?$/i.test(value)) {
                    fail(
                        `child ${property} '${value}' changes the fixed track`,
                    );
                }
            }
        }
        this.uiGridSubstitutions.add(
            `${label}: repeat(${grid.columns}, ${grid.cellWidth}px), ` +
                `${childHeight}px children, ${grid.gap}px gap` +
                (grid.rowCount === undefined
                    ? ""
                    : `, ${grid.rowCount} explicit rows`),
        );
    }


    public validateUiStaticProjection(): void {
        const activeRules = this.uiActiveStyleRulesInCascade();
        const parentsByChild = new EmissionMap<number, number[]>();
        for (const [parentId, parent] of this.uiStaticElements) {
            for (const childId of parent.children) {
                const parents = parentsByChild.get(childId) ?? [];
                parents.push(parentId);
                parentsByChild.set(childId, parents);
            }
        }
        this.uiValidation = {
            activeRules,
            parentsByChild,
            ancestorsById: new EmissionMap(),
        };
        try {
            for (const [id, element] of this.uiStaticElements) {
                const tracks = this.uiStaticElementStylePropertyValues(id, "--bbl-fr-grid-tracks");
                if ([...tracks].some(value => value !== undefined) && (tracks.size !== 1 || !this.uiStaticStyleCascadeKnown)) {
                    this.context.failAtFile("A fractional UI grid requires one stable track list in a statically known style cascade.");
                }
                for (const value of tracks) {
                    if (value === undefined) continue;
                    const count = value.trim().split(/\s+/).length;
                    if (!element.childShapeKnown || !element.childCardinalityKnown || element.children.size !== count || element.markupChildren.length) {
                        this.context.failAtFile("A fractional UI grid requires one statically known element child per track.");
                    }
                }
            }
            const anyGrid =
                this.uiSawGridDeclaration ||
                this.uiStyleRules.some((rule) => rule.grid !== undefined) ||
                [...this.uiStaticElements.values()].some((element) =>
                    element.styles.some(
                        (style) =>
                            this.uiGridFromLoweredStyle(style) !== undefined,
                    ),
                );
            if (!this.uiStaticStyleCascadeKnown && anyGrid) {
                const gridRule = this.uiStyleRules.find(
                    (rule) => rule.grid !== undefined,
                );
                const message =
                    "Retained UI fixed-grid projection requires a statically " +
                    "ordered stylesheet attachment and contents cascade.";
                if (gridRule?.site) this.context.fail(gridRule.site, message);
                this.context.failAtFile(message);
            }
            for (const mutation of this.uiUnknownClassMutations) {
                const gridRule = activeRules.find(
                    (rule) =>
                        rule.grid !== undefined &&
                        this.uiRuleMentionsClass(rule, mutation.className),
                );
                if (gridRule) {
                    this.context.fail(
                        mutation.site,
                        `Retained UI class mutation '${mutation.className}' has ` +
                            `an unknown target and can activate fixed-grid rule ` +
                            `'${gridRule.selector}'.`,
                    );
                }
            }
            const scopedMatches = (
                rule: LoweredUiStyleRule,
            ): {
                retained: number;
                markup: number;
                complete: boolean;
            } => {
                let retained = 0;
                let markup = 0;
                let complete = true;
                const ancestors = [...this.uiStaticElements.entries()].filter(
                    ([_id, element]) =>
                        rule.kind === "class-descendant-tag"
                            ? element.classAlternatives.some((classes) =>
                                  classes.has(rule.primary),
                              )
                            : element.ids.has(rule.primary),
                );
                for (const [id] of ancestors) {
                    const descendants = this.uiStaticDescendants(id);
                    complete = complete && descendants.complete;
                    if (rule.kind === "class-descendant-tag") {
                        retained += [...descendants.elements].filter(
                            (childId) =>
                                this.uiStaticElements.get(childId)?.tag ===
                                rule.tag,
                        ).length;
                        markup += descendants.markup.filter(
                            (node) => node.tag === rule.tag,
                        ).length;
                    } else {
                        retained += [...descendants.elements].filter(
                            (childId) =>
                                this.uiStaticElements
                                    .get(childId)
                                    ?.classAlternatives.some((classes) =>
                                        classes.has(rule.secondary!),
                                    ),
                        ).length;
                        markup += descendants.markup.filter((node) =>
                            node.classes.has(rule.secondary!),
                        ).length;
                    }
                }
                return { retained, markup, complete };
            };

            for (const rule of activeRules) {
                if (
                    rule.kind === "class-descendant-tag" ||
                    rule.kind === "id-descendant-class"
                ) {
                    const matches = scopedMatches(rule);
                    if (
                        !matches.complete ||
                        matches.retained + matches.markup === 0
                    ) {
                        const reason = !matches.complete
                            ? "the ancestor has a dynamically-shaped retained subtree"
                            : "no statically-known descendant matches it";
                        if (rule.site) {
                            this.context.fail(
                                rule.site,
                                `Retained stylesheet selector '${rule.selector}' cannot be projected: ${reason}.`,
                            );
                        }
                        this.context.failAtFile(
                            `Retained stylesheet selector '${rule.selector}' cannot be projected: ${reason}.`,
                        );
                    }
                }
            }

            const activeGridRules = activeRules.filter(
                (rule) => rule.grid !== undefined,
            );
            for (const rule of activeGridRules) {
                const hasTarget = [...this.uiStaticElements.values()].some(
                    (element) => this.uiRuleMatchesDirect(rule, element),
                );
                if (!hasTarget) {
                    if (rule.site) {
                        this.context.fail(
                            rule.site,
                            `Retained UI fixed-grid selector '${rule.selector}' has no statically-known target.`,
                        );
                    }
                    this.context.failAtFile(
                        `Retained UI fixed-grid selector '${rule.selector}' has no statically-known target.`,
                    );
                }
            }
            const effectiveGrids = new EmissionMap<
                number,
                Array<{
                    grid: UiGridProjection;
                    label: string;
                    site?: ts.Node;
                }>
            >();
            for (const [id, element] of this.uiStaticElements) {
                for (const classes of element.classAlternatives) {
                    const effective = this.uiStaticEffectiveGrid(id, classes);
                    if (effective) {
                        const states = effectiveGrids.get(id) ?? [];
                        states.push(effective);
                        effectiveGrids.set(id, states);
                    }
                }
            }
            for (const mutation of this.uiUnknownAttributeMutations) {
                for (const [id, element] of this.uiStaticElements) {
                    const structuralRule = activeRules.find(
                        (rule) =>
                            (rule.grid !== undefined ||
                                this.uiStaticStyleProperty(
                                    rule.style,
                                    "display",
                                ) !== undefined ||
                                this.uiStaticStyleProperty(
                                    rule.style,
                                    "justify-content",
                                ) !== undefined) &&
                            (rule.grid !== undefined ||
                                effectiveGrids.has(id)) &&
                            this.uiUnknownAttributeCouldAffectRule(
                                mutation,
                                rule,
                                id,
                                element,
                            ),
                    );
                    if (structuralRule) {
                        this.context.fail(
                            mutation.site,
                            `Retained UI runtime-unknown ${mutation.attribute} ` +
                                `mutation can change fixed-grid structural rule ` +
                                `'${structuralRule.selector}'.`,
                        );
                    }
                }
            }
            for (const mutation of this.uiUnknownAttributeMutations) {
                for (const parentId of effectiveGrids.keys()) {
                    const parent = this.uiStaticElements.get(parentId)!;
                    const includesExplicitRows = effectiveGrids
                        .get(parentId)!
                        .some(
                            (effective) =>
                                effective.grid.rowCount !== undefined,
                        );
                    for (const childId of parent.children) {
                        const child = this.uiStaticElements.get(childId);
                        if (!child) continue;
                        const geometryRule = activeRules.find(
                            (rule) =>
                                this.uiGridChildGeometryProperty(
                                    rule,
                                    includesExplicitRows,
                                ) !== undefined &&
                                this.uiUnknownAttributeCouldAffectRule(
                                    mutation,
                                    rule,
                                    childId,
                                    child,
                                ),
                        );
                        if (geometryRule) {
                            this.context.fail(
                                mutation.site,
                                `Retained UI runtime-unknown ${mutation.attribute} ` +
                                    `mutation can alter fixed-grid child ` +
                                    `${this.uiGridChildGeometryProperty(
                                        geometryRule,
                                        includesExplicitRows,
                                    )} ` +
                                    `through rule '${geometryRule.selector}'.`,
                            );
                        }
                    }
                }
            }
            for (const [id, states] of effectiveGrids) {
                for (const effective of states) {
                    this.validateUiGridProjection(
                        id,
                        effective.grid,
                        effective.label,
                        effective.site,
                    );
                }
            }

            for (const query of this.uiPendingClassQueries) {
                if (query.root.uiStaticId === undefined) {
                    this.context.fail(
                        query.site,
                        "Retained UI querySelectorAll requires a statically-known retained root.",
                    );
                }
                const descendants = this.uiStaticDescendants(
                    query.root.uiStaticId,
                );
                const unknownClass = [...descendants.elements].some(
                    (id) => !this.uiStaticElements.get(id)?.classShapeKnown,
                );
                const retainedMatches = [...descendants.elements].filter(
                    (id) => {
                        const element = this.uiStaticElements.get(id);
                        return (
                            element !== undefined &&
                            this.uiStaticElementAlwaysHasClass(
                                element,
                                query.className,
                            )
                        );
                    },
                );
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
        } finally {
            this.uiValidation = undefined;
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
                owner.styleShapeKnown = false;
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
                `(${this.context.compileCondition(unwrapped.condition)} ? ` +
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
        let nextMarkupNodeId = 0;
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
                if (!/^(?:div|span|h1|h2|p|button|b|a|svg)$/.test(tag)) {
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
                    !/^(?:div|span|h1|h2|p|button|b|a|svg)$/.test(tag)) ||
                (insideSvg && !/^(?:path|rect)$/.test(tag))
            ) {
                fail(`tag '<${tag}>' is outside the bounded HTML/SVG subset.`);
            }
            if ((tag === "path" || tag === "rect") !== selfClosing) {
                fail(`<${tag}> must use the self-closing form.`);
            }
            if (
                /^(?:div|span|h1|h2|p|button|b|a|svg)$/.test(tag) &&
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
                        /^([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(["'])([\s\S]*?)\2/,
                    ) ??
                    fail(
                        `tag '<${tag}>' has an invalid or unquoted attribute.`,
                    );
                attributes.push({
                    name: attribute[1]!,
                    value: attribute[3]!,
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
                        ...(tag === "button" ? ["type", "data-action"] : []),
                        ...(tag === "a" ? ["href", "target", "rel"] : []),
                    ]);
                    if (!allowed.has(lowerName)) {
                        fail(
                            `attribute '${name}' is not supported on <${tag}>.`,
                        );
                    }
                    if (lowerName === "class") {
                        for (const className of attributeValue
                            .split(/\s+/)
                            .filter(Boolean)) {
                            if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(className)) {
                                fail(`class '${className}' is not valid.`);
                            }
                            classes.add(className);
                        }
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
                    name: lowerName === "viewbox" ? "viewBox" : name,
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
                `<${tag}${renderedAttributes} data-bbl-node="${node.id}"${selfClosing ? "/" : ""}>`,
            );
            if (tag === "svg") {
                svgPaint!.openingOutputIndex = output.length - 1;
            }
            if (!selfClosing) {
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
            return (
                `(${this.context.compileCondition(unwrapped.condition)} ? ` +
                `${this.compileUiMarkupString(unwrapped.whenTrue, ownerId)} : ` +
                `${this.compileUiMarkupString(unwrapped.whenFalse, ownerId)})`
            );
        }
        const sourceParts = this.collectUiStringParts(unwrapped);
        if (!sourceParts) {
            this.context.fail(
                expression,
                "Native UI innerHTML must be a template or static fragments joined by string concatenation or a conditional.",
            );
        }
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
                `bbl::ui_escape_rml(${this.uiTemplateSubstitutionCpp(
                    substitutions[Number(marker[1])]!,
                    "Native UI innerHTML",
                    true,
                )})`,
            );
        }
        this.context.reachJsData();
        return `bbl::js::concat(${parts.join(", ")})`;
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
                const inputType =
                    this.context.compileStringLiteral(value).toLowerCase();
                if (inputType !== "file") {
                    this.context.fail(
                        value,
                        `Retained native <input> supports only the static type 'file', not '${inputType}'.`,
                    );
                }
                element.uiFileInput = true;
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
        if (this.context.hasFeature("engine:device-recovery") && ts.isPropertyAccessExpression(globalLeft) &&
            ts.isIdentifier(this.context.unwrap(globalLeft.expression)) && this.context.unwrap(globalLeft.expression).getText() === "globalThis" &&
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            (ts.isArrowFunction(expression.right) || ts.isFunctionExpression(expression.right))) {
            this.context.emit(`bbl::set_global_callback(${this.context.requireDefaultEngine(expression)}, ${this.context.cppString(globalLeft.name.text)}, ${this.context.compileVoidCallback(expression.right)});`);
            return true;
        }
        const canvasDataset = this.primaryCanvasDataset(expression.left);
        if (canvasDataset && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            if (canvasDataset === "ready") this.primaryCanvasReadyGate = true;
            this.context.emit(`bbl::set_canvas_dataset(${this.context.requireDefaultEngine(expression)}, ${this.context.cppString(canvasDataset)}, ${this.uiStringCpp(expression.right, "Dataset assignment")});`);
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
        if (this.context.options.workers && ts.isPropertyAccessExpression(dataset) && dataset.name.text === "dataset") {
            const element = this.uiElementValue(dataset.expression);
            if (element) {
                const name = `data-${property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
                this.context.emit(`bbl::ui_set_attribute(${this.context.requireEngine(element, dataset)}, ${element.cpp}, ${this.context.cppString(name)}, ${this.uiStringCpp(expression.right, "Dataset assignment")});`);
                return true;
            }
        }
        const directElement = this.uiElementValue(expression.left.expression);
        if (directElement) {
            const engine = this.context.requireEngine(directElement, expression.left);
            const booleanAttribute = this.booleanAttribute(directElement, property, expression.left);
            if (booleanAttribute) {
                this.context.emit(`bbl::ui_set_boolean_attribute(${engine}, ${directElement.cpp}, ${this.context.cppString(booleanAttribute)}, ${this.context.compileBoolean(expression.right)});`);
                return true;
            }
            if (property === "value" && (directElement.uiTag === "textarea" || directElement.uiTag === "input") && !directElement.uiFileInput) {
                this.context.emit(`bbl::ui_set_form_value(${engine}, ${directElement.cpp}, ${this.uiStringCpp(expression.right, "Form value")});`);
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
                this.context.emit(`${browserFile};`);
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
                    sizes[property] = staticSize;
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
                this.context.emit(
                    `bbl::ui_canvas_set_${property}(${engine}, ${directElement.cpp}, ` +
                        `${this.context.compileNumber(expression.right, "double")});`,
                );
                return true;
            }
            if (directElement.uiCanvasContext) {
                if (property === "fillStyle" || property === "strokeStyle") {
                    this.context.emit(
                        `bbl::ui_canvas_set_${property === "fillStyle" ? "fill_style" : "stroke_style"}(` +
                            `${engine}, ${directElement.cpp}, ` +
                            `${this.uiStringCpp(expression.right, `Canvas2D ${property}`)});`,
                    );
                    return true;
                }
                if (property === "lineWidth") {
                    this.context.emit(
                        `bbl::ui_canvas_set_line_width(${engine}, ${directElement.cpp}, ` +
                            `${this.context.compileNumber(expression.right, "double")});`,
                    );
                    return true;
                }
                if (property === "lineJoin" || property === "lineCap") {
                    this.context.emit(
                        `bbl::ui_canvas_set_${property === "lineJoin" ? "line_join" : "line_cap"}(` +
                            `${engine}, ${directElement.cpp}, ` +
                            `${this.uiStringCpp(expression.right, `Canvas2D ${property}`)});`,
                    );
                    return true;
                }
                if (property === "imageSmoothingEnabled") {
                    this.context.emit(
                        `bbl::ui_canvas_set_image_smoothing(${engine}, ${directElement.cpp}, ` +
                            `${this.context.compileBoolean(expression.right)});`,
                    );
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
                    this.context.emit(
                        `bbl::ui_canvas_set_${runtimeProperty}(${engine}, ${directElement.cpp}, ` +
                            `${this.uiStringCpp(expression.right, `Canvas2D ${property}`)});`,
                    );
                    return true;
                }
                if (property === "shadowBlur") {
                    this.context.emit(
                        `bbl::ui_canvas_set_shadow_blur(${engine}, ${directElement.cpp}, ` +
                            `${this.context.compileNumber(expression.right, "double")});`,
                    );
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
                    const sheet = this.context.compileStringLiteral(expression.right);
                    textCpp = this.context.cppString(sheet);
                    this.context.emit(
                        `bbl::ui_clear_style_rules(${engine}, ${directElement.cpp});`,
                    );
                    for (const rule of this.lowerUiStyleSheetLiteral(
                        sheet,
                        expression.right,
                        directElement.uiStaticId,
                    )) {
                        if (
                            (rule.kind === "class" || rule.kind === "id") &&
                            uiStyleInteractionStateCount(rule) === 0 &&
                            !rule.scrollbar &&
                            !uiStyleRuleHasMedia(rule)
                        ) {
                            this.context.emit(
                                `bbl::ui_add_${rule.kind}_style(${engine}, ` +
                                    `${directElement.cpp}, ` +
                                    `${this.context.cppString(rule.primary)}, ` +
                                    `${this.context.cppString(rule.style)});`,
                            );
                        } else {
                            this.context.emit(
                                `bbl::ui_add_style_rule(${engine}, ${directElement.cpp}, ` +
                                    `bbl::UiStyleSelectorKind::${uiStyleSelectorCppKind(rule.kind)}, ` +
                                    `${this.context.cppString(rule.primary)}, ` +
                                    `${this.context.cppString(rule.secondary ?? "")}, ` +
                                    `${this.context.cppString(rule.tag ?? "")}, ` +
                                    `${rule.hover ? "true" : "false"}, ` +
                                    `${doubleLiteral(rule.maxWidth ?? -1)}, ` +
                                    `${this.context.cppString(rule.style)}` +
                                    `, bbl::UiScrollbarPart::${uiScrollbarPartCpp(rule.scrollbar)}, ` +
                                    `${rule.focusVisible ? "true" : "false"}, ${rule.active ? "true" : "false"}, ` +
                                    `bbl::UiMotionPreference::${uiMotionPreferenceCpp(rule.reducedMotion)});`,
                            );
                        }
                    }
                } else {
                    textCpp = this.uiStringCpp(expression.right, `UI ${property}`);
                }
                this.context.emit(
                    `bbl::ui_set_text(${engine}, ${directElement.cpp}, ` +
                        `${textCpp});`,
                );
                return true;
            }
            if (property === "innerHTML") {
                this.recordUiStaticReplaceChildren(directElement);
                this.context.emit(
                    `bbl::ui_set_inner_rml(${engine}, ${directElement.cpp}, ` +
                        `${this.compileUiMarkupString(
                            expression.right,
                            directElement.uiStaticId,
                        )});`,
                );
                return true;
            }
            const attribute =
                property === "className"
                    ? "class"
                    : property === "id" || property === "type"
                      ? property
                      : undefined;
            if (attribute) {
                if (attribute === "class" || attribute === "id") {
                    this.recordUiStaticAttribute(
                        directElement,
                        attribute,
                        expression.right,
                    );
                }
                this.context.emit(
                    `bbl::ui_set_attribute(${engine}, ${directElement.cpp}, ` +
                        `${this.context.cppString(attribute)}, ` +
                        `${this.uiStringCpp(expression.right, `UI ${property}`)});`,
                );
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
        if (property === "cursor" && this.context.isCanvasElement(style.expression)) {
            this.context.emit(
                `bbl::set_canvas_cursor(${this.context.requireDefaultEngine(expression)}, ` +
                    `${this.uiStringCpp(expression.right, "canvas style.cursor")});`,
            );
            return true;
        }
        const styleElement = this.uiElementValue(style.expression);
        if (!styleElement) return false;
        const engine = this.context.requireEngine(styleElement, expression.left);
        if (property === "cssText") {
            this.context.emit(
                `bbl::ui_set_attribute(${engine}, ${styleElement.cpp}, ` +
                    `${this.context.cppString("style")}, ${this.compileUiStyleString(
                        expression.right,
                        styleElement.uiStaticId,
                    )});`,
            );
            return true;
        }
        const nativeProperty = this.nativeUiStyleProperty(property);
        this.auditUiStylePropertyName(nativeProperty, expression.left.name);
        if (["filter", "overflow-wrap", "word-break"].includes(nativeProperty) || isUiLayoutProperty(nativeProperty)) {
            const value = this.tryUiStaticString(expression.right);
            if (value !== undefined && value !== "") this.auditUiStyleDeclarations(`${nativeProperty}:${value}`, expression.right);
        }
        this.recordUiStaticStyleProperty(
            styleElement,
            nativeProperty,
            expression.right,
        );
        const styleValue = nativeProperty === "border-image"
            ? this.context.cppString(this.lowerUiBorderImage(
                this.context.compileStringLiteral(expression.right), expression.right))
            : this.uiStringCpp(expression.right, `UI style.${property}`);
        this.context.emit(
            `bbl::ui_set_style_property(${engine}, ${styleElement.cpp}, ` +
                `${this.context.cppString(nativeProperty)}, ` +
                `${styleValue});`,
        );
        for (const [name, value] of UiProjection.UI_SHORTHAND_RESETS.get(property) ?? []) {
            this.context.emit(`bbl::ui_set_style_property(${engine}, ${styleElement.cpp}, ${this.context.cppString(name)}, ${this.context.cppString(value)});`);
        }
        return true;
    }


    public primaryPresentationCanvas(node: ts.Node): Value {
        const engine = this.context.requirePresentationHost(node);
        if (!this.presentationCanvasValue) {
            this.context.reachFeature("ui:rml", node);
            this.context.reachFeature("backend:sdl", node);
            this.context.reachFeature("renderer:canvas", node);
            this.presentationCanvasValue = {
                kind: "ui-element",
                cpp: `bbl::ui_primary_canvas(${engine})`,
                engineCpp: engine,
                uiTag: "canvas",
                uiCanvas: true,
                uiPrimaryCanvas: true,
                uiCanvasId: this.uiCanvasIds++,
                truthinessCpp: "true",
            };
        }
        return this.presentationCanvasValue;
    }

    public presentationCanvasValue: Value | undefined;

    public primaryCanvasReadyGate = false;

    private readonly canvasDatasetReads = new EmissionWeakMap<ts.SourceFile, boolean>();


    /** Write-only dataset instrumentation erases; readback requires retained DOM state. */
    private readsCanvasDataset(source: ts.SourceFile): boolean {
        const cached = this.canvasDatasetReads.get(source);
        if (cached !== undefined) return cached;
        let found = false;
        const visit = (node: ts.Node): void => {
            if (found) return;
            if (ts.isPropertyAccessExpression(node)) {
                const dataset = this.context.unwrap(node.expression);
                if (ts.isPropertyAccessExpression(dataset) && dataset.name.text === "dataset" &&
                    this.context.isCanvasElement(dataset.expression) &&
                    !(ts.isBinaryExpression(node.parent) && node.parent.left === node &&
                        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)) {
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
        const value = this.context.unwrap(expression);
        if (!ts.isPropertyAccessExpression(value)) return undefined;
        const dataset = this.context.unwrap(value.expression);
        return ts.isPropertyAccessExpression(dataset) && dataset.name.text === "dataset" && this.context.isCanvasElement(dataset.expression) &&
            this.readsCanvasDataset(value.getSourceFile())
            ? value.name.text : undefined;
    }

    public nativeHostUiTagsCache: ReadonlyMap<string, string> | undefined;


    public nativeHostUiTags(): ReadonlyMap<string, string> {
        if (this.nativeHostUiTagsCache) return this.nativeHostUiTagsCache;
        const tags = new EmissionMap<string, string>();
        const visit = (element: NativeHostUiElement): void => {
            const id = element.attributes?.id;
            if (id !== undefined) tags.set(id, element.tag.toLowerCase());
            for (const child of element.children ?? []) visit(child);
        };
        for (const element of this.context.options.nativeHostUi?.elements ?? []) {
            visit(element);
        }
        this.nativeHostUiTagsCache = tags;
        return tags;
    }


    /**
     * A Window realm owns the whole retained document. Other entries require
     * an id declared by their host companion, including represented canvases.
     */
    public isNativeHostUiLookup(call: ts.CallExpression): boolean {
        const callee = this.context.unwrap(call.expression);
        if (
            !ts.isPropertyAccessExpression(callee) ||
            callee.name.text !== "getElementById" ||
            !ts.isIdentifier(callee.expression) ||
            callee.expression.text !== "document" ||
            !this.context.isDefaultLibraryIdentifier(callee.expression) ||
            call.arguments.length !== 1
        ) {
            return false;
        }
        if (this.context.options.workers) return true;
        const id = this.context.unwrap(argumentAt(call, 0));
        // A literal, or an inlined helper's parameter bound to one: a
        // demo's `bindToggle(buttonId, ...)` looks its button up by the
        // literal every call site passes, which the inlined binding still
        // carries as a static string.
        const text =
            ts.isStringLiteral(id) || ts.isNoSubstitutionTemplateLiteral(id)
                ? id.text
                : ts.isIdentifier(id)
                  ? this.context.lookupIdentifierValue(id)?.staticString
                  : undefined;
        return text !== undefined && this.nativeHostUiTags().has(text);
    }


    /**
     * A local helper returning a scene-created retained element must be
     * inlined before DOM erasure gets to classify its result type. Canvas
     * helpers deliberately do not qualify: live Canvas2D belongs to its own
     * bounded IR rather than the retained element tree.
     */
    public isNativeUiHelperCall(call: ts.CallExpression): boolean {
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
                const callee = this.context.unwrap(node.expression);
                if (
                    ts.isPropertyAccessExpression(callee) &&
                    callee.name.text === "createElement" &&
                    ts.isIdentifier(callee.expression) &&
                    callee.expression.text === "document" &&
                    this.context.isDefaultLibraryIdentifier(callee.expression)
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


    public compileHostUi(): string[] {
        const hostUi = this.context.options.nativeHostUi;
        if (!hostUi) return [];
        if (this.context.options.workers) this.context.reachFeature("platform:window", this.context.sourceFile);
        const engine = this.context.options.workers ? "bbl::pal::window_document_engine()" : this.context.defaultEngine();
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
        this.context.reachFeature("ui:rml", `${hostUi.sourcePath} (host UI companion)`);
        const indent = "    ".repeat(2);
        const emitted: string[] = [];
        const ids = new EmissionSet<string>();
        for (const rule of nativeHostUiStyleRules(hostUi)) {
            if (rule.scrollbar !== undefined && !isUiScrollbarPart(rule.scrollbar)) {
                this.context.failAtFile("Native host UI rule has an unsupported scrollbar part.");
            }
            if (UiProjection.fractionalUiGridTracks(rule.style)) {
                this.context.failAtFile("Fractional host grids require inline tracks beside their complete child list.");
            }
            const identifier = /^[A-Za-z_][A-Za-z0-9_-]*$/;
            if (!identifier.test(rule.primary)) {
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
            emitted.push(
                `${indent}bbl::ui_add_host_style_rule(${engine}, ` +
                    `bbl::UiStyleSelectorKind::${descriptor.cpp}, ` +
                    `${this.context.cppString(rule.primary)}, ` +
                    `${this.context.cppString(rule.secondary ?? "")}, ` +
                    `${this.context.cppString(rule.tag ?? "")}, ` +
                    `${rule.hover ? "true" : "false"}, ` +
                    `${doubleLiteral(rule.maxWidth ?? -1)}, ` +
                    `${this.context.cppString(this.lowerUiAttributeLiteral("style", rule.style))}` +
                    `, ${rule.focusVisible ? "true" : "false"}, ${rule.active ? "true" : "false"}, ` +
                    `bbl::UiScrollbarPart::${uiScrollbarPartCpp(rule.scrollbar)}, ` +
                    `bbl::UiMotionPreference::${uiMotionPreferenceCpp(rule.reducedMotion)});`,
            );
        }

        const appendElement = (
            element: NativeHostUiElement,
            parent?: string,
        ): string => {
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
            const fractionalTracks = UiProjection.fractionalUiGridTracks(element.attributes?.style ?? "");
            if (fractionalTracks && (element.text || element.children?.length !== fractionalTracks.length)) {
                this.context.failAtFile("A fractional host grid requires exactly one element child per track.");
            }
            const handle = this.context.allocateTemporaryCppName("host_ui_element");
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
                emitted.push(
                    `${indent}bbl::ui_set_attribute(${engine}, ${handle}, ` +
                        `${this.context.cppString(name)}, ${this.context.cppString(value)});`,
                );
            }
            for (const child of element.children ?? []) {
                appendElement(child, handle);
            }
            emitted.push(
                parent
                    ? `${indent}bbl::ui_append_child(${engine}, ${parent}, ${handle});`
                    : `${indent}bbl::ui_append_to_root(${engine}, ${handle});`,
            );
            return handle;
        };
        for (const element of hostUi.elements) {
            appendElement(element);
        }
        if (this.context.options.workers) emitted.push(`${indent}bbl::pal::update_window_document();`);
        return emitted;
    }
}
