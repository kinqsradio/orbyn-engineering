use std::{
    io::Write,
    net::TcpListener,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::Duration,
};
fn main() {
    let record = PathBuf::from(std::env::var_os("ORBYN_PIPE_RECORD").unwrap());
    eprintln!("fixture entry: {}", std::process::id());
    if std::env::args().any(|a| a == "--helper") {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        std::fs::write(
            &record,
            format!("{} {}", std::process::id(), listener.local_addr().unwrap()),
        )
        .unwrap();
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }
    let _child = Command::new(std::env::current_exe().unwrap())
        .arg("--helper")
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    eprintln!("fixture waiting for descendant record");
    while !record.exists() {
        thread::sleep(Duration::from_millis(10));
    }
    println!("leader stdout");
    eprintln!("leader stderr");
    std::io::stdout().flush().unwrap();
}
