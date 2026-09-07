import ts from "typescript";
import { browserGlobalNamed } from "./browser-erasure.js";
import type { Value } from "./types.js";
import type { WorkerLoweringContext } from "./workers.js";

interface CanvasContext extends WorkerLoweringContext {
    checker: ts.TypeChecker;
    isCanvasElement(expression: ts.Expression): boolean;
}

function hasDomInterface(context: CanvasContext, expression: ts.Expression, name: string): boolean {
    const symbol = context.checker.getTypeAtLocation(expression).getSymbol();
    return symbol?.name === name && (symbol.declarations?.some(declaration => ts.isInterfaceDeclaration(declaration) &&
        context.isDefaultLibraryIdentifier(declaration.name)) ?? false);
}

function canvasOwner(context: CanvasContext, expression: ts.Expression): Value | undefined {
    const type = context.checker.getTypeAtLocation(expression);
    if (type.getSymbol()?.name !== "OffscreenCanvas") return undefined;
    const mapped = context.dataTypes.fromTsType(type, expression);
    if (mapped?.kind !== "handle" || mapped.handle !== "offscreen-canvas") return undefined;
    return context.compileValue(expression);
}

function requireWindowHost(context: CanvasContext, node: ts.Node): void {
    if (context.options.workers?.namespace || !context.options.nativeHostUi) {
        context.fail(node, "This Window API requires an application realm with a native host UI companion.");
    }
}

export function compileCanvasValue(context: CanvasContext, expression: ts.Expression): Value | undefined {
    if (!context.options.workers) return undefined;
    const node = context.unwrap(expression);
    if (ts.isPropertyAccessExpression(node) && node.name.text === "devicePixelRatio" &&
        ["globalThis", "window"].includes(browserGlobalNamed(context, node.expression)?.text ?? "")) {
        requireWindowHost(context, node);
        return { kind: "number", cpp: "bbl::pal::window_device_pixel_ratio()", dataType: { kind: "number" } };
    }
    if (ts.isTypeOfExpression(node)) {
        const member = context.unwrap(node.expression);
        if (ts.isPropertyAccessExpression(member) && member.name.text === "transferControlToOffscreen" &&
            context.isCanvasElement(member.expression)) {
            return { kind: "string", cpp: 'std::string("function")', staticString: "function" };
        }
    }
    if (ts.isTypeOfExpression(node) && browserGlobalNamed(context, node.expression)?.text === "Worker") {
        return { kind: "string", cpp: 'std::string("function")', staticString: "function" };
    }
    if (ts.isNewExpression(node) && browserGlobalNamed(context, node.expression)?.text === "OffscreenCanvas") {
        if (node.arguments?.length !== 2) return context.fail(node, "OffscreenCanvas requires width and height.");
        const argumentsCpp = node.arguments.map(argument => {
            const temporary = context.allocateTemporaryCppName("canvas_dimension");
            context.emit(`const double ${temporary} = ${context.compileNumber(argument, "double")};`);
            return temporary;
        });
        return { kind: "offscreen-canvas", dataType: { kind: "handle", handle: "offscreen-canvas" },
            cpp: `bbl::pal::create_offscreen_canvas(${argumentsCpp.join(", ")}, bbl::pal::WorkerRealm::current().host_services())`, impure: true };
    }
    if (!context.options.workers.namespace && ts.isNewExpression(node) &&
        browserGlobalNamed(context, node.expression)?.text === "ResizeObserver") {
        if (node.arguments?.length !== 1) return context.fail(node, "ResizeObserver requires one callback.");
        requireWindowHost(context, node);
        return { kind: "worker-resize-observer", cpp: `bbl::pal::create_resize_observer(${context.compileFrameCallback(node.arguments[0]!, "void")})`, impure: true };
    }
    if (ts.isCallExpression(node)) {
        const callee = context.unwrap(node.expression);
        if (!context.options.workers.namespace && browserGlobalNamed(context, callee)?.text === "matchMedia") {
            if (node.arguments.length !== 1) return context.fail(node, "matchMedia requires one media query string.");
            requireWindowHost(context, node);
            return { kind: "worker-media-query", cpp: `bbl::pal::create_media_query(${context.dataLowerer.compileForSink(node.arguments[0]!, { kind: "string" })})`, impure: true };
        }
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "addEventListener" &&
            hasDomInterface(context, callee.expression, "MediaQueryList")) {
            const owner = context.compileValue(callee.expression);
            const event = node.arguments[0];
            if (owner.kind !== "worker-media-query" || node.arguments.length !== 2 ||
                !event || !ts.isStringLiteralLike(event) || event.text !== "change") {
                return context.fail(node, "MediaQueryList requires an admitted change listener.");
            }
            return { kind: "void", cpp: `${owner.cpp}->add_change_listener(${context.compileFrameCallback(node.arguments[1]!, "void")})` };
        }
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "transferControlToOffscreen" &&
            context.isCanvasElement(callee.expression)) {
            if (node.arguments.length) return context.fail(node, "transferControlToOffscreen accepts no arguments.");
            const owner = context.compileValue(callee.expression);
            if (owner.kind !== "ui-element") return context.fail(node, "Canvas transfer requires a retained Window canvas.");
            return { kind: "offscreen-canvas", dataType: { kind: "handle", handle: "offscreen-canvas" },
                cpp: `bbl::pal::window_canvas(${owner.cpp})->transfer_control_to_offscreen()`, impure: true };
        }
        if (ts.isPropertyAccessExpression(callee) && ["observe", "unobserve", "disconnect"].includes(callee.name.text) &&
            hasDomInterface(context, callee.expression, "ResizeObserver")) {
            const owner = context.compileValue(callee.expression);
            if (owner.kind === "worker-resize-observer") {
                const argument = node.arguments[0];
                if (callee.name.text === "disconnect" && !argument) return { kind: "void", cpp: `${owner.cpp}->disconnect()` };
                if (!argument || node.arguments.length !== 1) return context.fail(node, "Resize observation requires one element.");
                const element = context.compileValue(argument);
                if (element.kind !== "ui-element") return context.fail(argument, "Resize observation requires a retained Window element.");
                return { kind: "void", cpp: `${owner.cpp}->${callee.name.text}(${element.cpp})` };
            }
        }
    }
    if (ts.isPropertyAccessExpression(node) && ["clientWidth", "clientHeight"].includes(node.name.text) && context.isCanvasElement(node.expression)) {
        const owner = context.compileValue(node.expression);
        if (owner.kind === "ui-element") return { kind: "number", dataType: { kind: "number" },
            cpp: `bbl::pal::window_element_size(${owner.cpp}).${node.name.text === "clientWidth" ? "width" : "height"}` };
    }
    if (ts.isPropertyAccessExpression(node) && ["width", "height"].includes(node.name.text)) {
        const owner = canvasOwner(context, node.expression);
        if (owner) return { kind: "number", cpp: `static_cast<double>(${owner.cpp}->${node.name.text}())`, dataType: { kind: "number" } };
    }
    return undefined;
}

export function emitCanvasAssignment(context: CanvasContext, expression: ts.BinaryExpression): boolean {
    if (!context.options.workers) return false;
    const target = context.unwrap(expression.left);
    if (!ts.isPropertyAccessExpression(target) || !["width", "height"].includes(target.name.text)) return false;
    const owner = canvasOwner(context, target.expression);
    if (!owner) return false;
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return context.fail(expression, "Canvas dimensions currently support direct assignment.");
    const temporary = context.allocateTemporaryCppName("canvas_receiver");
    context.emit(`auto ${temporary} = ${owner.cpp};`);
    const value = context.compileNumber(expression.right, "double");
    context.emit(`${temporary}->set_${target.name.text}(${value});`);
    return true;
}
