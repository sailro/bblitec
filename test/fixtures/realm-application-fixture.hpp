// The window application a fixture's generated `main` runs: an application
// realm on one event loop, without a window. Loop errors and unhandled
// rejections fail the run unless FIXTURE_APPLICATION_ERRORS is defined
// first, which registers the window's error listeners on an
// ApplicationErrors over the loop (it reports what none handles).
// FIXTURE_APPLICATION_TIMEOUT_MS closes the loop after that long, reporting
// "application did not finish" on stderr. FIXTURE_DEVICE_PIXEL_RATIO gives
// the realm a Window's devicePixelRatio.
#ifdef FIXTURE_APPLICATION_ERRORS
#include <bblite/pal_application_errors.hpp>
#endif
#ifdef FIXTURE_APPLICATION_TIMEOUT_MS
#include <iostream>
#endif

namespace bbl::pal {
#ifdef FIXTURE_APPLICATION_ERRORS
inline ApplicationErrors* fixture_application_errors = nullptr;
bool window_on_application_error(bool rejection, std::uint64_t identity,
                                 ApplicationErrors::Callback callback, bool once,
                                 ListenerLeasePtr lease) {
    return fixture_application_errors->add(rejection, identity, std::move(callback), once,
                                           std::move(lease));
}
#endif
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
#ifdef FIXTURE_DEVICE_PIXEL_RATIO
    realm.provide_device_pixel_ratio([] { return double{FIXTURE_DEVICE_PIXEL_RATIO}; });
#endif
#ifdef FIXTURE_APPLICATION_ERRORS
    ApplicationErrors handlers(loop);
    fixture_application_errors = &handlers;
#else
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.on_unhandled_rejection([](std::exception_ptr error) { std::rethrow_exception(error); });
#endif
#ifdef FIXTURE_APPLICATION_TIMEOUT_MS
    loop.set_timeout(
        [&] {
            std::cerr << "application did not finish";
            loop.close();
        },
        FIXTURE_APPLICATION_TIMEOUT_MS);
#endif
    loop.run([&] { initialize(realm); });
#ifdef FIXTURE_APPLICATION_ERRORS
    fixture_application_errors = nullptr;
#endif
    return 0;
}
} // namespace bbl::pal
