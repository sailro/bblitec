#pragma once

#include <bblite/dom_event_state.hpp>
#include <bblite/pal_event_loop.hpp>
#include <bblite/runtime.hpp>
#include <bblite/uncaught_error.hpp>

#include <iostream>

namespace bbl::pal {

/**
 * Native exception information at the application realm's reporting boundary:
 * the `ErrorEvent` or `PromiseRejectionEvent` the Window receives. Its copies
 * share its dispatch state and canceled flag (`PlatformEventFlags`).
 */
struct ApplicationErrorEvent : PlatformEventFlags {
    std::string message;
};

class ApplicationErrors {
public:
    using Callback = js::Callback<void(ApplicationErrorEvent&)>;
    /** `owner` is the Window's document, which names the events' targets. */
    ApplicationErrors(EventLoop& loop, Engine& owner) : loop_(loop), owner_(owner) {
        loop_.on_error([this](std::exception_ptr error) { report(false, error); });
        loop_.on_unhandled_rejection([this](std::exception_ptr error) { report(true, error); });
    }
    ~ApplicationErrors() {
        run_teardown("ApplicationErrors teardown", [this] {
            loop_.on_error({});
            loop_.on_unhandled_rejection({});
        });
    }
    bool add(bool rejection, std::uint64_t identity, Callback callback, bool once,
             ListenerLeasePtr lease = {}) {
        return listeners(rejection).add(identity, std::move(callback), once, std::move(lease));
    }
    void remove(bool rejection, std::uint64_t identity) { listeners(rejection).remove(identity); }

private:
    PlatformEventListeners<void(ApplicationErrorEvent&)>& listeners(bool rejection) {
        return rejection ? rejections_ : errors_;
    }
    void report(bool rejection, std::exception_ptr error) {
        ApplicationErrorEvent event;
        event.dom = new_dom_event_state();
        auto& state = *event.dom;
        state.type = rejection ? "unhandledrejection" : "error";
        state.target = DomEventTarget::window();
        state.bubbles = false;
        state.composed = false;
        try {
            std::rethrow_exception(error);
        } catch (const WorkerTerminated&) {
            throw;
        } catch (...) {
            event.message = exception_message(std::current_exception());
        }
        // Error listeners can themselves throw. Report those failures without
        // recursively dispatching the same listener list.
        if (!reporting_) {
            reporting_ = true;
            struct Reset {
                bool& flag;
                ~Reset() { flag = false; }
            } reset{reporting_};
            // The Window is the target and the whole path: the listeners see
            // it at the target phase.
            const DomDispatchScope scope(state, &owner_, owner_.lifetime.token());
            state.phase = 2;
            state.current_target = DomEventTarget::window();
            state.path = {DomEventTarget::window()};
            dispatch_platform_event(loop_, listeners(rejection), event);
        }
        if (!event.is_default_prevented())
            std::cerr << (rejection ? std::string_view("Unhandled promise rejection: ")
                                    : uncaught_error_prefix)
                      << event.message << '\n';
    }
    EventLoop& loop_;
    Engine& owner_;
    bool reporting_ = false;
    PlatformEventListeners<void(ApplicationErrorEvent&)> errors_, rejections_;
};

} // namespace bbl::pal
