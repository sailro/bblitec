import { emissionArray, journaled } from "./emission-transaction.js";
import ts from "typescript";
import { noteCameraRecordWrite } from "./intrinsics/camera.js";
import type { Feature, Value } from "./types.js";
import type { PositiveIntegerContext } from "./option-helpers.js";
import type { LoweringServices } from "./lowering-services.js";

/** What the admission recorder reads of the compiler. */
export interface AdmissionContext
    extends
        PositiveIntegerContext,
        Pick<
            LoweringServices,
            | "fail"
            | "isRuntimeResourceConstruction"
            | "sceneManifest"
            | "sourceFile"
        > {
    /** Where `startEngine` landed, once it has. */
    readonly engineStartMark: object | undefined;
    readonly features: ReadonlySet<Feature>;
    /** How many frame callbacks enclose the current emission. */
    readonly frameCallbackDepth: number;
}

/**
 * Capability admissions: the text, node-input, node-geometry, material-color and TAA sites that
 * are refused only when the finished program reaches the capability, and the camera writes and
 * scene registrations those capabilities need to be tracked.
 */
export class AdmissionRecorder {
    constructor(private readonly context: AdmissionContext) {}

    public readonly untrackedTaaCameraWrites: Array<{
        node: ts.Node;
        reason: string;
        cameraVersionSafe?: true;
    }> = emissionArray([]);
    private readonly deferredAdmissionFailures: Array<{
        capability:
            | "taa"
            | "text"
            | "node-input"
            | "node-geometry"
            | "material-colors"
            | "diffuseColor";
        node: ts.Node;
        message: string;
    }> = emissionArray([]);
    private readonly materialColorReads: Array<
        "baseColorFactor" | "diffuseColor"
    > = emissionArray([]);
    @journaled public accessor temporalSceneRegistration: ts.Node | undefined;
    public readonly temporalRegisteredScenes: Array<
        Value["sceneTopologyState"]
    > = emissionArray([]);
    @journaled private accessor temporalControlAttachment: ts.Node | undefined;

    /**
     * Refuses the deferred admission failures whose capability the finished
     * program reached: what a site noted before the program decided whether
     * it reaches the capability its failure concerns.
     */
    public enforceDeferredAdmissions(): void {
        if (
            this.context.sceneManifest.reachedNodeMaterials.length > 0 &&
            this.context.sceneManifest.geometryOutputTasks.length > 0 &&
            this.context.features.has("loader:gltf")
        ) {
            const boundary = this.deferredAdmissionFailures.find(
                (failure) => failure.capability === "node-geometry",
            );
            if (boundary) this.context.fail(boundary.node, boundary.message);
            if (this.context.features.has("animation:property"))
                this.context.fail(
                    this.context.sourceFile,
                    "Node geometry views with glTF do not represent property-animation transform producers.",
                );
        }
        if (this.context.features.has("material:node")) {
            const admission = this.deferredAdmissionFailures.find(
                (failure) => failure.capability === "node-input",
            );
            if (admission) this.context.fail(admission.node, admission.message);
            if (
                this.context.features.has("material:node-inputs") &&
                this.temporalRegisteredScenes.length > 1
            )
                this.context.fail(
                    this.context.sourceFile,
                    "Node input bindings support one registered scene until per-scene binding snapshots are represented.",
                );
        }
        const colorAdmission = this.materialColorReads.includes("diffuseColor")
            ? this.deferredAdmissionFailures.find(
                  (failure) => failure.capability === "diffuseColor",
              )
            : undefined;
        if (colorAdmission)
            this.context.fail(colorAdmission.node, colorAdmission.message);
        if (this.materialColorReads.length) {
            const boundary = this.deferredAdmissionFailures.find(
                (failure) => failure.capability === "material-colors",
            );
            if (boundary) this.context.fail(boundary.node, boundary.message);
            if (this.temporalRegisteredScenes.length > 1)
                this.context.fail(
                    this.context.sourceFile,
                    "Numeric material-color reads currently support one registered scene; independent material-group UBO snapshots are not represented.",
                );
        }
        if (this.context.features.has("text:renderable")) {
            const camera =
                this.textCameraMutation ??
                this.untrackedTaaCameraWrites[0]?.node;
            if (camera)
                this.context.fail(
                    camera,
                    "Text currently requires a static camera; live camera writers and controls are not represented.",
                );
            if (this.temporalRegisteredScenes.length > 1)
                this.context.fail(
                    this.context.sourceFile,
                    "Text currently supports one registered scene; layered text update/draw ordering is not represented.",
                );
            const admission = this.deferredAdmissionFailures.find(
                (failure) => failure.capability === "text",
            );
            if (admission) this.context.fail(admission.node, admission.message);
        }
        if (this.context.features.has("camera:world-matrix-version")) {
            const unsupported = this.untrackedTaaCameraWrites.find(
                (write) => !write.cameraVersionSafe,
            );
            if (unsupported)
                this.context.fail(
                    unsupported.node,
                    `Camera worldMatrixVersion requires tracked mutations: ${unsupported.reason}.`,
                );
        }
        if (
            this.context.sceneManifest.postProcessComposites.some(
                (composite) =>
                    composite.intrinsic === "createTaaPostProcessTask",
            )
        ) {
            const unsupported = this.untrackedTaaCameraWrites[0];
            if (unsupported)
                this.context.fail(
                    unsupported.node,
                    `TAA requires tracked camera mutations: ${unsupported.reason}.`,
                );
            const admission = this.deferredAdmissionFailures.find(
                (failure) => failure.capability === "taa",
            );
            if (admission) this.context.fail(admission.node, admission.message);
        }
    }

    public noteNodeGeometryMutation(node: ts.Node): void {
        this.deferredAdmissionFailures.push({
            capability: "node-geometry",
            node,
            message:
                "Node geometry views require static imported mesh transforms; mutation, cloning and unproven transform aliases are not represented.",
        });
    }

    public assertNodeInputMutable(node: ts.Node): void {
        if (
            this.context.frameCallbackDepth > 0 ||
            this.context.engineStartMark !== undefined ||
            this.temporalSceneRegistration
        ) {
            this.context.fail(
                node,
                "Node input texture changes require setup before scene registration; captured bind-group replacement is not represented.",
            );
        }
    }

    public noteNodeInputAdmissionFailure(node: ts.Node, message: string): void {
        if (this.context.features.has("material:node"))
            this.context.fail(node, message);
        this.deferredAdmissionFailures.push({
            capability: "node-input",
            node,
            message,
        });
    }

    @journaled private accessor textAttachmentReached = false;
    @journaled public accessor textCameraMutation: ts.Node | undefined;

    public noteTextCameraControl(
        node: ts.Node,
        camera: Value,
        arcRotate: boolean,
    ): void {
        if (
            !arcRotate ||
            (camera.cameraKind !== undefined &&
                camera.cameraKind !== "arc-rotate")
        )
            this.textCameraMutation ??= node;
    }

    public noteTextSceneLifecycle(
        node: ts.Node,
        message = "Text scene disposal, removal and explicit rebuilding require retained binding topology that is not represented.",
    ): void {
        this.deferredAdmissionFailures.push({
            capability: "text",
            node,
            message,
        });
    }

    public noteTextSceneCameraAssignment(node: ts.Node): void {
        if (
            this.context.isRuntimeResourceConstruction() ||
            this.context.engineStartMark !== undefined
        )
            this.textCameraMutation ??= node;
    }

    public assertTextPipelineMutable(node: ts.Node): void {
        if (
            this.context.isRuntimeResourceConstruction() ||
            this.textAttachmentReached ||
            this.context.engineStartMark !== undefined
        ) {
            this.context.fail(
                node,
                "Text pipeline/order changes require definite initialization before text attachment; live pipeline rebinding and list rebuilding are not represented.",
            );
        }
    }

    public recordTextAttachment(node: ts.Node): void {
        if (
            this.context.isRuntimeResourceConstruction() ||
            this.context.engineStartMark !== undefined
        )
            this.context.fail(
                node,
                "Text attachment requires definite initialization; live text list rebuilding is not represented.",
            );
        this.textAttachmentReached = true;
    }

    public assertTextDisposal(node: ts.Node): void {
        if (
            this.textAttachmentReached ||
            this.context.isRuntimeResourceConstruction() ||
            this.context.engineStartMark !== undefined
        ) {
            this.context.fail(
                node,
                "Text disposal requires setup before text attachment; destroying retained draw bindings is not represented.",
            );
        }
    }

    public noteCameraVectorSet(
        vector: NonNullable<Value["cameraVector"]>,
        site: ts.Node,
    ): void {
        this.textCameraMutation ??= site;
        noteCameraRecordWrite(
            this.context,
            vector.owner,
            vector.field,
            undefined,
            false,
        );
        if (vector.field !== "target")
            this.untrackedTaaCameraWrites.push({
                node: site,
                reason: `camera.${vector.field} is not the arc camera's observable target`,
                ...(vector.owner.cameraKind === "free"
                    ? { cameraVersionSafe: true as const }
                    : {}),
            });
    }

    public noteCameraVectorCopy(value: Value, site: ts.Node): void {
        if (value.cameraVector)
            this.untrackedTaaCameraWrites.push({
                node: site,
                reason: "an observable camera vector cannot be copied into a plain data aggregate",
            });
    }

    public noteTemporalAdmissionFailure(node: ts.Node, message: string): void {
        this.deferredAdmissionFailures.push({
            capability: "taa",
            node,
            message,
        });
    }

    public noteMaterialColorRead(
        property: "baseColorFactor" | "diffuseColor",
    ): void {
        this.materialColorReads.push(property);
    }

    public noteLegacyDiffuseColorWrite(node: ts.Node): void {
        this.deferredAdmissionFailures.push({
            capability: "diffuseColor",
            node,
            message:
                "Reading material.diffuseColor requires retained numeric-array producers; the legacy color producer cannot preserve its source shape.",
        });
    }

    public noteMaterialColorRenderBoundary(
        node: ts.Node,
        reason: string,
        always = false,
    ): void {
        if (
            always ||
            this.context.frameCallbackDepth > 0 ||
            this.context.engineStartMark !== undefined ||
            this.temporalSceneRegistration
        ) {
            this.deferredAdmissionFailures.push({
                capability: "material-colors",
                node,
                message: `Numeric material-color reads do not yet represent per-group UBO snapshots for ${reason}.`,
            });
        }
    }

    public noteTemporalRecordBoundary(
        node: ts.Node,
        reason: string,
        mode: "runtime" | "registration" | "always" = "runtime",
        scene?: Value,
    ): void {
        const runtime =
            this.context.frameCallbackDepth > 0 ||
            this.context.engineStartMark !== undefined;
        if (
            mode === "always" ||
            runtime ||
            (mode !== "registration" && this.temporalSceneRegistration)
        ) {
            this.noteTemporalAdmissionFailure(
                node,
                `TAA task record epochs are not represented for ${runtime ? `runtime ${reason}` : reason}.`,
            );
        }
        if (
            runtime ||
            (mode !== "registration" && this.temporalSceneRegistration) ||
            reason === "rebuildSceneRenderables"
        ) {
            this.deferredAdmissionFailures.push({
                capability: "node-input",
                node,
                message: `Node material binding snapshots do not cover ${runtime ? `runtime ${reason}` : reason}.`,
            });
        }
        if (mode === "registration") {
            this.temporalSceneRegistration ??= node;
            const identity = scene?.sceneTopologyState;
            if (
                !identity ||
                !this.temporalRegisteredScenes.includes(identity)
            ) {
                if (!identity || this.temporalRegisteredScenes.length > 0)
                    this.noteTemporalAdmissionFailure(
                        node,
                        "TAA task record epochs are not represented for TAA supports one proven registered scene until per-scene update/record ordering is represented.",
                    );
                this.temporalRegisteredScenes.push(identity);
            }
        }
    }

    public noteTemporalCameraControl(
        node: ts.Node,
        tracksWorldMatrixVersion = false,
    ): void {
        if (
            this.temporalControlAttachment ||
            this.context.frameCallbackDepth > 0 ||
            this.context.engineStartMark !== undefined
        ) {
            this.untrackedTaaCameraWrites.push({
                node,
                reason: "TAA supports one startup control attachment until per-attachment inertia callbacks are represented",
                ...(tracksWorldMatrixVersion && !this.temporalControlAttachment
                    ? { cameraVersionSafe: true as const }
                    : {}),
            });
        }
        this.temporalControlAttachment ??= node;
    }
}
