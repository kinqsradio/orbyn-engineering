#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core_process;
mod links;

use core_process::{CoreProcess, ServiceMessage};
use links::ServicePort;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, RunEvent, WebviewWindow, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_updater::{Update, UpdaterExt};

const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

struct Core(Mutex<Option<CoreProcess>>);
/// The update found by the latest check, installed only when orbynd asks.
struct PendingUpdate(Mutex<Option<Update>>);
/// Links that arrived before the service could take them.
struct WaitingLinks(Mutex<Vec<String>>);

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn reveal(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn show_failure(app: &AppHandle, message: &str) {
    let Some(window) = main_window(app) else {
        return;
    };
    let mut url = match cfg!(debug_assertions) {
        true => url::Url::parse("tauri://localhost/index.html"),
        false if cfg!(windows) => url::Url::parse("http://tauri.localhost/index.html"),
        false => url::Url::parse("tauri://localhost/index.html"),
    }
    .expect("static loader URL");
    url.query_pairs_mut().append_pair("error", message);
    let _ = window.navigate(url);
}

/// Replaces any running core, then points the window at the new origin.
fn launch_core(app: &AppHandle) {
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
    };
    let on_exit = move |reason: String| {
        watcher.state::<Core>().0.lock().expect("core slot").take();
        show_failure(&watcher, &reason);
    };
    match CoreProcess::start(app, on_message, on_exit) {
        Ok(core) => {
            let target = core.app_url();
            app.state::<ServicePort>().set(target.port().unwrap_or(0));
            *slot = Some(core);
            drop(slot);
            if let Some(window) = main_window(app) {
                let _ = window.navigate(target);
            }
            let waiting = std::mem::take(
                &mut *app.state::<WaitingLinks>().0.lock().expect("link queue"),
            );
            for url in waiting {
                tell_core(app, serde_json::json!({ "type": "open_link", "url": url }));
            }
        }
        Err(error) => {
            drop(slot);
            show_failure(app, &error);
        }
    }
}

#[tauri::command]
fn restart_core(app: AppHandle) {
    std::thread::spawn(move || launch_core(&app));
}

fn tell_core(app: &AppHandle, message: serde_json::Value) {
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
    let config = app
        .config()
        .app
        .windows
        .first()
        .ok_or(tauri::Error::WindowNotFound)?
        .clone();
    let navigating = app.clone();
    let opening = app.clone();
    WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(move |url| links::on_navigation(&navigating, url))
        .on_new_window(move |url, _| {
            links::open_outside(&opening, &url);
            NewWindowResponse::Deny
        })
        .build()?;
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
            Err(message) => serde_json::json!({ "type": "app_update_failed", "message": message }),
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
    let mut tray = TrayIconBuilder::new()
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
        // First, so a second launch hands over before it starts anything.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _| {
            reveal(app);
            // Elsewhere the plugin passes these to the deep link handler.
            #[cfg(target_os = "macos")]
            for url in links::links_in(&_args) {
                open_link(app, url);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Core(Mutex::new(None)))
        .manage(PendingUpdate(Mutex::new(None)))
        .manage(WaitingLinks(Mutex::new(Vec::new())))
        .manage(ServicePort::default())
        .invoke_handler(tauri::generate_handler![restart_core])
        .setup(|app| {
            let handle = app.handle().clone();
            open_window(&handle)?;
            install_tray(&handle)?;
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
        .on_window_event(|window, event| {
            // Closing keeps agents running; Quit in the tray stops them.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("build Tauri application");

    app.run(|app, event| match event {
        RunEvent::Exit => {
            if let Some(core) = app.state::<Core>().0.lock().expect("core slot").take() {
                core.stop();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => reveal(app),
        _ => {}
    });
}
