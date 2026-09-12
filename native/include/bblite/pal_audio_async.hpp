#pragma once

#include <bblite/pal_audio.hpp>
#include <bblite/js_promise.hpp>

namespace bbl::pal {

enum class AudioContextAction { Resume, Suspend, Close };

/** Device transitions finish before a task settles the realm-owned promise. */
inline js::Promise<js::PromiseVoid> audio_context_transition(
    AudioContextHandle context, AudioContextAction action)
{
    js::Promise<js::PromiseVoid> promise;
    try {
        if (audio_state(context) == "closed")
            throw std::runtime_error("AudioContext is closed.");
        switch (action) {
            case AudioContextAction::Resume: audio_resume(context); break;
            case AudioContextAction::Suspend: audio_suspend(context); break;
            case AudioContextAction::Close: audio_close_context(context); break;
        }
        EventLoop::current().post([promise] { promise.resolve(js::PromiseVoid{}); });
    } catch (const WorkerTerminated&) { throw; }
    catch (...) { promise.reject(std::current_exception()); }
    return promise;
}

} // namespace bbl::pal
