//! Test-only Git replacement: holds a socket in both leader and descendant.
use std::{fs, net::TcpListener, process::Command, thread, time::Duration};

fn main() {
    let helper = std::env::args().any(|arg| arg == "--helper");
    let prefix = std::env::var_os("ORBYN_TEST_GIT_RECORD").expect("fixture record");
    let prefix = std::path::PathBuf::from(prefix);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    if !helper {
        Command::new(std::env::current_exe().unwrap())
            .arg("--helper")
            .spawn()
            .unwrap();
        fs::write(prefix.with_extension("pid"), std::process::id().to_string()).unwrap();
    }
    fs::write(
        prefix.with_extension(if helper { "helper" } else { "leader" }),
        listener.local_addr().unwrap().to_string(),
    )
    .unwrap();
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}
