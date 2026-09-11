#pragma once

#include <bblite/pal_event_loop.hpp>
#include <bblite/runtime.hpp>

#include <iostream>

namespace bbl::pal {

/** Native exception information at the application realm's reporting boundary. */
struct ApplicationErrorEvent {
    std::string message;
    bool default_prevented = false;
    void prevent_default() { default_prevented = true; }
};

class ApplicationErrors {
  public:
    using Callback = js::Callback<void(ApplicationErrorEvent&)>;
    explicit ApplicationErrors(EventLoop& loop) : loop_(loop) {
        loop_.on_error([this](std::exception_ptr error) { report(false, std::move(error)); });
        loop_.on_unhandled_rejection([this](std::exception_ptr error) { report(true, std::move(error)); });
    }
    ~ApplicationErrors() { loop_.on_error({}); loop_.on_unhandled_rejection({}); }
    void add(bool rejection, std::uint64_t identity, Callback callback, bool once) {
        listeners(rejection).add(identity, std::move(callback), once);
    }
    void remove(bool rejection, std::uint64_t identity) { listeners(rejection).remove(identity); }
  private:
    PlatformEventListeners<void(ApplicationErrorEvent&)>& listeners(bool rejection) {
        return rejection ? rejections_ : errors_;
    }
    void report(bool rejection, std::exception_ptr error) {
        ApplicationErrorEvent event{};
        try { std::rethrow_exception(error); }
        catch (const WorkerTerminated&) { throw; }
        catch (const std::exception& problem) { event.message = problem.what(); }
        catch (...) { event.message = "Unknown native exception"; }
        // Error listeners can themselves throw. Report those failures without
        // recursively dispatching the same listener list.
        if (!reporting_) {
            reporting_ = true;
            struct Reset { bool& flag; ~Reset() { flag = false; } } reset{reporting_};
            dispatch_platform_event(loop_, listeners(rejection), event);
        }
        if (!event.default_prevented) std::cerr << (rejection ? "Unhandled promise rejection: " : "Uncaught application error: ") << event.message << '\n';
    }
    EventLoop& loop_;
    bool reporting_ = false;
    PlatformEventListeners<void(ApplicationErrorEvent&)> errors_, rejections_;
};

} // namespace bbl::pal
