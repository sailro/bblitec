// Video producers for the executed-video gate: one bounded, and the shapes it declines.

function waitForData(video: HTMLVideoElement): Promise<void> {
    if (video.readyState >= video.HAVE_CURRENT_DATA) return Promise.resolve();
    return new Promise((resolve) => {
        video.addEventListener("loadeddata", () => resolve(), { once: true });
    });
}

function drawSource(): HTMLCanvasElement {
    const source = document.createElement("canvas");
    source.width = 4;
    source.height = 4;
    const context = source.getContext("2d")!;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 4, 4);
    context.fillStyle = "#000000";
    context.fillRect(0, 0, 2, 2);
    return source;
}

export async function createStillVideo(): Promise<{ video: HTMLVideoElement; dispose(): void }> {
    const stream = drawSource().captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    const playing = video.play();
    track.requestFrame();
    await playing;
    await waitForData(video);
    return {
        video,
        dispose(): void {
            video.pause();
            track.stop();
            video.srcObject = null;
        },
    };
}

export async function createSizedVideo(size: number): Promise<HTMLVideoElement> {
    const video = document.createElement("video");
    video.width = size;
    return video;
}

export async function createNoVideo(): Promise<HTMLCanvasElement> {
    return drawSource();
}

export async function createVideoWithAccessor(): Promise<{ video: HTMLVideoElement; readonly ready: boolean }> {
    const video = document.createElement("video");
    return {
        video,
        get ready(): boolean {
            return video.readyState >= video.HAVE_CURRENT_DATA;
        },
    };
}

export async function createVideoReachingDocument(): Promise<{ video: HTMLVideoElement; show(): void }> {
    const video = document.createElement("video");
    return {
        video,
        show(): void {
            document.body.appendChild(video);
        },
    };
}

export async function createVideoWithTwoMethods(): Promise<{ video: HTMLVideoElement; pause(): void; stop(): void }> {
    const video = document.createElement("video");
    return {
        video,
        pause(): void {
            video.pause();
        },
        stop(): void {
            video.srcObject = null;
        },
    };
}

export async function createBareVideo(): Promise<HTMLVideoElement> {
    const stream = drawSource().captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    const playing = video.play();
    track.requestFrame();
    await playing;
    await waitForData(video);
    return video;
}
