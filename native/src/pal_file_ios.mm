#include "pal_file_ios.hpp"
#include "pal_file_dialog.hpp"

#include <SDL3/SDL.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

#include <atomic>
#include <exception>
#include <memory>

@class BbliteDocumentPickerDelegate;

namespace bbl::pal {
namespace {

struct DocumentDialog {
    std::atomic<bool> complete = false;
    std::optional<SelectedFileSnapshot> selected;
    std::exception_ptr failure;
    bool exporting = false;
    bool exported = false;
    bool owns_picker = false;
    UIDocumentPickerViewController* __strong picker = nil;
    BbliteDocumentPickerDelegate* __strong delegate = nil;
};

bool picker_active = false;

std::string error_text(NSString* message) {
    const char* text = message.UTF8String;
    return text ? text : "unknown UIKit file-provider error";
}

std::runtime_error file_error(std::string_view operation, NSError* error) {
    return std::runtime_error(std::string(operation) + ": " + error_text(error.localizedDescription));
}

NSString* native_string(std::string_view value) {
    NSString* result = [[NSString alloc] initWithBytes:value.data() length:value.size() encoding:NSUTF8StringEncoding];
    if (!result) throw std::runtime_error("iOS file dialog requires valid UTF-8.");
    return result;
}

void on_main_thread(const std::function<void()>& work) {
    struct Invocation {
        const std::function<void()>& work;
        std::exception_ptr failure;
    } invocation{work, {}};
    if (!SDL_RunOnMainThread([](void* data) {
        auto& invocation = *static_cast<Invocation*>(data);
        try {
            @try {
                @autoreleasepool { invocation.work(); }
            } @catch (NSException* error) {
                throw std::runtime_error("iOS document picker: " + error_text(error.reason));
            }
        } catch (...) {
            invocation.failure = std::current_exception();
        }
    }, &invocation, true)) {
        throw std::runtime_error("Unable to dispatch iOS document picker: " + std::string(SDL_GetError()));
    }
    if (invocation.failure) std::rethrow_exception(invocation.failure);
}

UIViewController* presenter() {
    for (UIScene* scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        if (scene.activationState != UISceneActivationStateForegroundActive &&
            scene.activationState != UISceneActivationStateForegroundInactive) continue;
        for (UIWindow* window in ((UIWindowScene*)scene).windows) {
            if (!window.isKeyWindow || !window.rootViewController) continue;
            UIViewController* controller = window.rootViewController;
            while (controller.presentedViewController) controller = controller.presentedViewController;
            if (!controller.view.window || controller.isBeingDismissed) continue;
            return controller;
        }
    }
    throw std::runtime_error("iOS document picker requires an active application window.");
}

void read_selection(const std::shared_ptr<DocumentDialog>& state, NSURL* url) {
    const bool scoped = [url startAccessingSecurityScopedResource];
    @try {
        NSError* error = nil;
        NSFileCoordinator* coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
        [coordinator coordinateReadingItemAtURL:url options:NSFileCoordinatorReadingWithoutChanges error:&error
            byAccessor:^(NSURL* readable) {
                try {
                    const char* path = readable.fileSystemRepresentation;
                    if (!path) throw std::runtime_error("The selected iOS file has no filesystem representation.");
                    state->selected = detail::selected_file_snapshot(detail::utf8_file_path(path));
                    const char* name = url.lastPathComponent.UTF8String;
                    if (!name || !*name) throw std::runtime_error("The selected iOS file has no display name.");
                    state->selected->display_name = name;
                } catch (...) {
                    state->failure = std::current_exception();
                }
            }];
        if (error) state->failure = std::make_exception_ptr(file_error("Unable to read selected iOS document", error));
        if (!state->selected && !state->failure) {
            state->failure = std::make_exception_ptr(std::runtime_error("The file provider did not supply the selected document."));
        }
    } @finally {
        if (scoped) [url stopAccessingSecurityScopedResource];
    }
}

}
}

@interface BbliteDocumentPickerDelegate : NSObject <UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate> {
@public
    std::shared_ptr<bbl::pal::DocumentDialog> state;
}
@end

@implementation BbliteDocumentPickerDelegate
- (void)documentPicker:(UIDocumentPickerViewController*)controller didPickDocumentsAtURLs:(NSArray<NSURL*>*)urls {
    (void)controller;
    if (!state || state->complete.load(std::memory_order_acquire)) return;
    try {
        @try {
            if (urls.count != 1 || !urls.firstObject.isFileURL) {
                throw std::runtime_error("iOS document selection requires one file URL.");
            }
            if (state->exporting) state->exported = true;
            else bbl::pal::read_selection(state, urls.firstObject);
        } @catch (NSException* error) {
            throw std::runtime_error("iOS file provider: " + bbl::pal::error_text(error.reason));
        }
    } catch (...) {
        state->failure = std::current_exception();
    }
    if (state) state->complete.store(true, std::memory_order_release);
}
- (void)documentPickerWasCancelled:(UIDocumentPickerViewController*)controller {
    (void)controller;
    if (state) state->complete.store(true, std::memory_order_release);
}
- (void)presentationControllerDidDismiss:(UIPresentationController*)controller {
    (void)controller;
    if (state) state->complete.store(true, std::memory_order_release);
}
@end

namespace bbl::pal {
namespace {

void close_dialog(const std::shared_ptr<DocumentDialog>& state) {
    on_main_thread([state] {
        if (!state->owns_picker) return;
        state->picker.delegate = nil;
        state->picker.presentationController.delegate = nil;
        if (state->picker.presentingViewController) {
            [state->picker dismissViewControllerAnimated:NO completion:nil];
        }
        if (state->delegate) state->delegate->state.reset();
        state->picker = nil;
        state->delegate = nil;
        state->owns_picker = false;
        picker_active = false;
    });
}

std::shared_ptr<DocumentDialog> run_document_picker(const FileDialogOptions& options, NSURL* export_url) {
    auto state = std::make_shared<DocumentDialog>();
    state->exporting = export_url != nil;
    try {
        on_main_thread([state, options, export_url] {
            if (picker_active) throw std::runtime_error("An iOS document picker is already active.");
            UIViewController* host = presenter();
            if (export_url) {
                state->picker = [[UIDocumentPickerViewController alloc] initForExportingURLs:@[export_url] asCopy:YES];
            } else {
                NSMutableArray<UTType*>* types = [NSMutableArray new];
                for (const auto& extension : detail::file_dialog_extensions(options.filter_pattern)) {
                    UTType* type = [UTType typeWithFilenameExtension:native_string(extension)];
                    if (!type) throw std::runtime_error("iOS cannot represent the requested file extension: " + extension);
                    [types addObject:type];
                }
                if (!types.count) [types addObject:UTTypeData];
                state->picker = [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:types asCopy:NO];
                state->picker.allowsMultipleSelection = NO;
            }
            if (!state->picker) throw std::runtime_error("Unable to create the iOS document picker.");
            NSURL* documents = [NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
            if (!documents) throw std::runtime_error("iOS document storage is unavailable.");
            // Files hides empty application containers. A real local save
            // directory makes first-use exports possible without iCloud.
            NSURL* files = [documents URLByAppendingPathComponent:@"Files" isDirectory:YES];
            NSError* directory_error = nil;
            if (![NSFileManager.defaultManager createDirectoryAtURL:files withIntermediateDirectories:YES attributes:nil error:&directory_error]) {
                throw file_error("Unable to prepare iOS document storage", directory_error);
            }
            state->picker.directoryURL = files;
            state->owns_picker = true;
            picker_active = true;
            state->delegate = [BbliteDocumentPickerDelegate new];
            if (!state->delegate) throw std::runtime_error("Unable to create the iOS document picker delegate.");
            state->delegate->state = state;
            state->picker.delegate = state->delegate;
            state->picker.title = native_string(options.title);
            state->picker.modalPresentationStyle = UIModalPresentationFormSheet;
            [host presentViewController:state->picker animated:YES completion:nil];
            if (host.presentedViewController != state->picker) {
                throw std::runtime_error("Unable to present the iOS document picker.");
            }
            state->picker.presentationController.delegate = state->delegate;
        });
        // Pump UIKit without dispatching queued application input or reentering JS.
        while (!state->complete.load(std::memory_order_acquire)) {
            if (SDL_IsMainThread()) SDL_PumpEvents();
            SDL_Delay(10);
        }
        close_dialog(state);
    } catch (...) {
        const auto failure = std::current_exception();
        try { close_dialog(state); }
        catch (const std::exception& cleanup) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "iOS document picker cleanup: %s", cleanup.what());
        }
        std::rethrow_exception(failure);
    }
    if (state->failure) std::rethrow_exception(state->failure);
    return state;
}

class ExportStaging {
  public:
    ExportStaging() {
        const char* temporary = NSTemporaryDirectory().fileSystemRepresentation;
        if (!temporary) throw std::runtime_error("iOS temporary storage is unavailable.");
        directory_ = detail::utf8_file_path(temporary) / ("bblite-export-" + detail::random_staging_token());
        if (!std::filesystem::create_directory(directory_)) {
            throw std::runtime_error("Unable to create exclusive iOS export staging.");
        }
    }
    ~ExportStaging() {
        std::error_code error;
        std::filesystem::remove_all(directory_, error);
        if (error) SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "iOS export staging cleanup: %s", error.message().c_str());
    }
    ExportStaging(const ExportStaging&) = delete;
    ExportStaging& operator=(const ExportStaging&) = delete;
    const std::filesystem::path& directory() const { return directory_; }
  private:
    std::filesystem::path directory_;
};

}

std::optional<SelectedFileSnapshot> choose_ios_open_file(const FileDialogOptions& options) {
    @autoreleasepool {
        return std::move(run_document_picker(options, nil)->selected);
    }
}

bool export_ios_file(const FileDialogOptions& options, std::span<const std::uint8_t> bytes) {
    @autoreleasepool {
        const auto& name = options.suggested_name;
        if (name.empty() || name == "." || name == ".." || name.find_first_of("/\\") != std::string::npos ||
            name.find('\0') != std::string::npos) {
            throw std::runtime_error("iOS export requires a filename without directory components.");
        }
        ExportStaging staging;
        const auto file = staging.directory() / detail::utf8_file_path(name);
        detail::write_file_atomically(file, bytes, detail::maximum_selected_file_bytes, "exported file");
        NSURL* url = [NSURL fileURLWithPath:native_string(file.string())];
        return run_document_picker(options, url)->exported;
    }
}

}
