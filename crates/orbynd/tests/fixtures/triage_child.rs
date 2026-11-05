//! Standalone native double compiled by the CLI integration test, never a provider.
use std::io::{self, Read};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let record = std::env::var_os("TRIAGE_TEST_RECORD").expect("fixture record");
    let mut text = format!("cwd={}\n", std::env::current_dir().unwrap().display());
    for arg in args {
        text.push_str(&format!("arg={arg}\n"));
    }
    std::fs::write(record, text).unwrap();
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    println!("fixture-out:{input}");
    eprintln!("fixture-err:{input}");
    std::process::exit(std::env::var("TRIAGE_TEST_EXIT").unwrap().parse().unwrap());
}
