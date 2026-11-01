mod support;
use serde_json::{Value, json};
use support::{Options, Service, TempDir};

#[tokio::test]
async fn repository_star_check_is_a_bounded_fixed_get_without_a_star_mutation() {
    let dir = TempDir::new();
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::copy(
        env!("CARGO_BIN_EXE_orbyn-fake-engine"),
        bin.join(format!("gh{}", std::env::consts::EXE_SUFFIX)),
    )
    .unwrap();
    let state = dir.path().join("star-state");
    let arguments = dir.path().join("star-arguments");
    std::fs::write(&state, "starred").unwrap();
    let path = std::env::join_paths(
        std::iter::once(bin).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    let service = Service::start(
        &dir.path().join("data"),
        Options {
            env: vec![
                ("PATH".into(), path.to_string_lossy().into_owned()),
                (
                    "ORBYN_FAKE_GH_STAR_STATE".into(),
                    state.to_string_lossy().into_owned(),
                ),
                (
                    "ORBYN_FAKE_GH_ARGUMENTS".into(),
                    arguments.to_string_lossy().into_owned(),
                ),
            ],
            ..Options::default()
        },
    );
    assert_eq!(
        service.json("/api/source-control/repository-star").await,
        json!({"starred":true})
    );
    let call: Value = serde_json::from_slice(&std::fs::read(&arguments).unwrap()).unwrap();
    assert_eq!(
        call["args"],
        json!([
            "api",
            "--method",
            "GET",
            "--hostname",
            "github.com",
            "user/starred/kinqsradio/orbyn-engineering",
            "--silent"
        ])
    );
    std::fs::write(&state, "not-starred").unwrap();
    assert_eq!(
        service.json("/api/source-control/repository-star").await,
        json!({"starred":false})
    );
    std::fs::write(&state, "hang").unwrap();
    let start = std::time::Instant::now();
    assert_eq!(
        service.json("/api/source-control/repository-star").await,
        json!({"starred":false})
    );
    assert!(start.elapsed() < std::time::Duration::from_secs(8));
    service.stop().await;
}
