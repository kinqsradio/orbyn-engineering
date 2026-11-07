#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity;
mod core_process;
mod desktop_origin;
mod image_picker;
mod links;
mod menu;
mod restart_policy;
mod shell_state;
mod system;
mod window_actions;

use core_process::{CoreProcess, ServiceMessage};
use links::ServicePort;
use menu::Zoom;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, RunEvent, WebviewWindow, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_updater::{Update, UpdaterExt};

const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

struct Core(Mutex<Option<CoreProcess>>);
/// Fences window requests queued by an earlier service process.
#[derive(Default)]
struct ServiceGeneration(AtomicU64);
/// Whether a crashed service is started again by itself, which happens once.
#[derive(Default)]
struct Restarts(Mutex<restart_policy::RestartPolicy>);
/// The update found by the latest check, installed only when orbynd asks.
struct PendingUpdate(Mutex<Option<Update>>);
/// Links that arrived before the service could take them.
struct WaitingLinks(Mutex<Vec<String>>);

pub(crate) fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

pub(crate) fn reveal(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn show_restarting(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.navigate(desktop_origin::restarting());
    }
}

/// Starts the service again at a person's request, which also gives the next crash
/// its one automatic restart.
pub(crate) fn restart_service(app: &AppHandle) {
    app.state::<Restarts>()
        .0
        .lock()
        .expect("restart policy")
        .reset();
    let app = app.clone();
    std::thread::spawn(move || launch_core(&app));
}

/// Shows the service log in the file manager. The place is the app's own log folder,
/// never one a caller names.
fn reveal_service_log(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let log = core_process::service_log(app)?;
    let shown = if log.exists() {
        app.opener().reveal_item_in_dir(&log)
    } else {
        // No service has written one yet, so open the folder that will hold it.
        let folder = log.parent().ok_or("Cannot find the log folder.")?;
        // A link could point anywhere, so it is not opened.
        if std::fs::symlink_metadata(folder).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err("The log folder is a link, so it is not opened.".into());
        }
        app.opener()
            .open_path(folder.to_string_lossy(), None::<&str>)
    };
    shown.map_err(|error| format!("Cannot show the log: {error}."))
}

pub(crate) fn show_service_log(app: &AppHandle) {
    if let Err(message) = reveal_service_log(app) {
        tell_core(
            app,
            serde_json::json!({ "type": "shell_failed", "message": message }),
        );
    }
}

fn show_failure(app: &AppHandle, reason: &str, repeated: bool) {
    let Some(window) = main_window(app) else {
        return;
    };
    let _ = window.navigate(desktop_origin::failed(reason, repeated));
}

/// Replaces any running core, then supplies its address to the stable asset page.
fn launch_core(app: &AppHandle) {
    let generation = app
        .state::<ServiceGeneration>()
        .0
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    if let Err(error) = close_preview_windows(app) {
        show_failure(app, &error, false);
        return;
    }
    let state = app.state::<Core>();
    let mut slot = state.0.lock().expect("core slot");
    if let Some(previous) = slot.take() {
        previous.stop();
    }
    let watcher = app.clone();
    let messages = app.clone();
    let on_message = move |message: ServiceMessage| match message {
        ServiceMessage::CheckAppUpdate => check_for_update(&messages),
        ServiceMessage::InstallAppUpdate => install_update(&messages),
        ServiceMessage::ShellAction { action } => menu::on_action(&messages, action),
        ServiceMessage::PreviewWindow { thread_id, tab_id } => {
            let app = messages.clone();
            let dispatch = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                if dispatch
                    .state::<ServiceGeneration>()
                    .0
                    .load(Ordering::SeqCst)
                    != generation
                {
                    return;
                }
                if let Err(error) = open_preview_window(&dispatch, &thread_id, &tab_id) {
                    tell_core(
                        &dispatch,
                        serde_json::json!({
                            "type": "shell_failed", "message": error
                        }),
                    );
                }
            }) {
                tell_core(
                    &app,
                    serde_json::json!({
                        "type": "shell_failed",
                        "message": format!("Cannot open the preview window: {error}.")
                    }),
                );
            }
        }
        ServiceMessage::Activity(now) => activity::apply(&messages, now),
        ServiceMessage::ChooseProjectImage { request_id } => {
            image_picker::choose(&messages, request_id)
        }
    };
    let on_exit = move |reason: String| {
        watcher.state::<Core>().0.lock().expect("core slot").take();
        let decision = watcher
            .state::<Restarts>()
            .0
            .lock()
            .expect("restart policy")
            .on_crash(std::time::Instant::now());
        match decision {
            restart_policy::Decision::RestartOnce => {
                show_restarting(&watcher);
                let app = watcher.clone();
                // Not on this thread: starting the service waits for it to be ready.
                std::thread::spawn(move || launch_core(&app));
            }
            restart_policy::Decision::Stop => show_failure(&watcher, &reason, true),
        }
    };
    match CoreProcess::start(app, on_message, on_exit) {
        Ok(core) => {
            let target = core.app_url();
            app.state::<ServicePort>().set(target.port().unwrap_or(0));
            *slot = Some(core);
            drop(slot);
            if let Some(window) = main_window(app) {
                let _ = window.navigate(desktop_origin::application(&target));
            }
            let waiting =
                std::mem::take(&mut *app.state::<WaitingLinks>().0.lock().expect("link queue"));
            for url in waiting {
                tell_core(app, serde_json::json!({ "type": "open_link", "url": url }));
            }
            system::report(app);
        }
        Err(error) => {
            drop(slot);
            show_failure(app, &error, false);
        }
    }
}

/// The main thread serializes cleanup with pending preview-window creation.
fn close_preview_windows(app: &AppHandle) -> Result<(), String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let windows = app.clone();
    app.run_on_main_thread(move || {
        let result = windows
            .webview_windows()
            .into_iter()
            .filter(|(label, _)| label.starts_with("preview-"))
            .try_for_each(|(_, window)| window.destroy())
            .map_err(|error| format!("Cannot close an old preview window: {error}."));
        let _ = sender.send(result);
    })
    .map_err(|error| format!("Cannot close old preview windows: {error}."))?;
    receiver
        .recv()
        .map_err(|_| "Cannot close old preview windows: the main thread stopped.".to_owned())?
}

/// Each preview has one separate window. Reopening it brings that window forward.
fn open_preview_window(app: &AppHandle, thread_id: &str, tab_id: &str) -> Result<(), String> {
    let service = app.state::<Core>();
    let target = service
        .0
        .lock()
        .expect("core slot")
        .as_ref()
        .and_then(|core| desktop_origin::preview(&core.app_url(), thread_id, tab_id))
        .ok_or("The preview window could not be opened.")?;
    // Hex encoding makes the two identifiers unambiguous in Tauri window labels.
    let encode = |id: &str| {
        id.bytes()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    let label = format!("preview-{}-{}", encode(thread_id), encode(tab_id));
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    let navigating = app.clone();
    let opening = app.clone();
    WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(target))
        .title("Preview")
        .inner_size(1000.0, 720.0)
        .min_inner_size(320.0, 240.0)
        .on_navigation(move |url| links::on_navigation(&navigating, url))
        .on_new_window(move |url, _| {
            links::open_outside(&opening, &url);
            NewWindowResponse::Deny
        })
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// The startup document is the only caller of the three commands below. Each takes no
/// argument from the page, and each checks the address its window shows now.
fn require_startup(window: &WebviewWindow) -> Result<(), String> {
    desktop_origin::require_startup(&window.url().map_err(|error| error.to_string())?)
}

#[tauri::command]
fn restart_core(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_startup(&window)?;
    restart_service(&app);
    Ok(())
}

/// Shows the service log, for a start that failed.
#[tauri::command]
fn show_core_log(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_startup(&window)?;
    reveal_service_log(&app)
}

/// Closes the app from the startup document, where there may be no service to ask.
#[tauri::command]
fn quit_core(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_startup(&window)?;
    app.exit(0);
    Ok(())
}

pub(crate) fn tell_core(app: &AppHandle, message: serde_json::Value) {
    if let Some(core) = app.state::<Core>().0.lock().expect("core slot").as_ref() {
        core.send(&message);
    }
}

/// A link is for the service, which decides where it goes. Until the service runs it
/// waits here, as when the link is what started the app. This runs on the main
/// thread, so it never waits on a service that is still starting: the queue's lock,
/// taken first, keeps the start from emptying the queue before the link is in it.
fn open_link(app: &AppHandle, url: String) {
    reveal(app);
    let waiting = app.state::<WaitingLinks>();
    let mut waiting = waiting.0.lock().expect("link queue");
    let state = app.state::<Core>();
    match state.0.try_lock().as_deref() {
        Ok(Some(core)) => core.send(&serde_json::json!({ "type": "open_link", "url": url })),
        _ => waiting.push(url),
    }
}

/// Builds the window here rather than from the config, for its navigation rules.
fn open_window(app: &AppHandle) -> tauri::Result<()> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .ok_or(tauri::Error::WindowNotFound)?
        .clone();
    config.url = tauri::WebviewUrl::External(desktop_origin::startup());
    let navigating = app.clone();
    let opening = app.clone();
    let window = WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(move |url| links::on_navigation(&navigating, url))
        .on_new_window(move |url, _| {
            links::open_outside(&opening, &url);
            NewWindowResponse::Deny
        })
        .build()?;
    shell_state::load(app);
    let zoom = *app.state::<Zoom>().0.lock().expect("zoom");
    window.set_zoom(zoom)?;
    Ok(())
}

/// Read-only: reports what is available and leaves installing to the service,
/// which refuses while runs are active.
fn check_for_update(app: &AppHandle) {
    let (Some(pubkey), Some(endpoint)) = (
        option_env!("ORBYN_UPDATE_PUBKEY"),
        option_env!("ORBYN_UPDATE_ENDPOINT").and_then(|value| url::Url::parse(value).ok()),
    ) else {
        tell_core(
            app,
            serde_json::json!({ "type": "app_update_unconfigured" }),
        );
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match app
            .updater_builder()
            .pubkey(pubkey)
            .endpoints(vec![endpoint])
        {
            Ok(builder) => match builder.build() {
                Ok(updater) => updater.check().await.map_err(|error| error.to_string()),
                Err(error) => Err(error.to_string()),
            },
            Err(error) => Err(error.to_string()),
        };
        let message = match result {
            Ok(Some(update)) => {
                let message = serde_json::json!({
                    "type": "app_update_available",
                    "version": update.version,
                    "notes": update.body,
                });
                *app.state::<PendingUpdate>().0.lock().expect("update slot") = Some(update);
                message
            }
            Ok(None) => serde_json::json!({ "type": "app_update_none" }),
            Err(message) => {
                serde_json::json!({ "type": "app_update_check_failed", "message": message })
            }
        };
        tell_core(&app, message);
    });
}

fn install_update(app: &AppHandle) {
    let pending = app
        .state::<PendingUpdate>()
        .0
        .lock()
        .expect("update slot")
        .take();
    let Some(update) = pending else {
        tell_core(
            app,
            serde_json::json!({ "type": "app_update_failed", "message": "No update is ready." }),
        );
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let progress = app.clone();
        let mut downloaded = 0u64;
        let on_chunk = move |chunk: usize, total: Option<u64>| {
            downloaded += chunk as u64;
            tell_core(
                &progress,
                serde_json::json!({
                    "type": "app_update_progress",
                    "downloaded": downloaded,
                    "total": total,
                }),
            );
        };
        match update.download_and_install(on_chunk, || {}).await {
            Ok(()) => app.restart(),
            Err(error) => tell_core(
                &app,
                serde_json::json!({ "type": "app_update_failed", "message": error.to_string() }),
            ),
        }
    });
}

fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Orbyn Engineering", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id(activity::TRAY)
        .tooltip("Orbyn Engineering")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => reveal(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .register_uri_scheme_protocol("orbyn-startup", |_context, request| {
            let valid = request.uri().path() == "/index.html";
            tauri::http::Response::builder()
                .status(if valid { 200 } else { 404 })
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Cache-Control", "no-store")
                .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ipc: http://ipc.localhost; base-uri 'none'; frame-ancestors 'none'")
                .body(if valid { include_bytes!("../../loader/index.html").to_vec() } else { Vec::new() })
                .expect("static startup response")
        })
        // First, so a second launch hands over before it starts anything.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _| {
            reveal(app);
            // Elsewhere the plugin passes these to the deep link handler.
            #[cfg(target_os = "macos")]
            for url in links::links_in(&_args) {
                open_link(app, url);
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Core(Mutex::new(None)))
        .manage(Restarts::default())
        .manage(ServiceGeneration::default())
        .manage(PendingUpdate(Mutex::new(None)))
        .manage(WaitingLinks(Mutex::new(Vec::new())))
        .manage(ServicePort::default())
        .manage(Zoom::default())
        .manage(activity::KeepAwake::default())
        .manage(menu::QuitItem::default())
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .invoke_handler(tauri::generate_handler![restart_core, show_core_log, quit_core])
        .setup(|app| {
            core_process::startup_phase("setup-started");
            let handle = app.handle().clone();
            open_window(&handle)?;
            core_process::startup_phase("window-ready");
            install_tray(&handle)?;
            core_process::startup_phase("tray-ready");
            let links = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    open_link(&links, url.to_string());
                }
            });
            // The installer registers the scheme; a portable copy does it here.
            #[cfg(windows)]
            let _ = app.deep_link().register("orbyn");
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    open_link(&handle, url.to_string());
                }
            }
            std::thread::spawn(move || {
                launch_core(&handle);
                loop {
                    check_for_update(&handle);
                    std::thread::sleep(UPDATE_CHECK_INTERVAL);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing keeps agents running; Quit in the tray stops them.
            WindowEvent::CloseRequested { api, .. } if window_actions::hide_on_close(window.label()) => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Destroyed => {
                window.app_handle().state::<Zoom>().1.lock().expect("viewer zoom").forget(window.label());
            }
            // A permission is granted in System Settings, away from this window.
            WindowEvent::Focused(true) => system::report(window.app_handle()),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("build Tauri application");

    app.run(|app, event| match event {
        RunEvent::Exit => {
            app.state::<activity::KeepAwake>().set(false);
            if let Some(core) = app.state::<Core>().0.lock().expect("core slot").take() {
                core.stop();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => reveal(app),
        _ => {}
    });
}
