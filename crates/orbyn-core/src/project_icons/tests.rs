use super::*;
use crate::CoreConfig;
use crate::testing::{TempDir, library};
use orbyn_contracts::WorkspaceSetup;

async fn fixture() -> (TempDir, Core, Project, PathBuf) {
    let dir = TempDir::new();
    let library = library(&dir.path().join("library"));
    let mut config = CoreConfig::new(dir.path().join("data"), "http://127.0.0.1:1".into());
    config.engines.lookup_latest = false;
    let core = Core::open(config).unwrap();
    core.workspace
        .setup(WorkspaceSetup {
            url: None,
            adopt_path: Some(library.to_string_lossy().into()),
        })
        .await
        .unwrap();
    let root = dir.path().join("project");
    std::fs::create_dir_all(&root).unwrap();
    let project = core.add_project(root.to_str().unwrap()).await.unwrap();
    (dir, core, project, root)
}
fn write(root: &Path, path: &str, bytes: impl AsRef<[u8]>) {
    let file = root.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, bytes).unwrap();
}
fn bytes(image: &ProjectIconImageData) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(&image.data_base64)
        .unwrap()
}

#[tokio::test]
async fn untrusted_project_hints_are_read_without_execution_or_file_changes() {
    let (_dir, core, project, root) = fixture().await;
    let config = br#"{"iconPath":"assets/../logo.svg","scripts":[{"name":"Never","command":"echo unsafe > executed"}]}"#;
    write(&root, "orbyn.json", config);
    write(&root, "logo.svg", b"<svg>project-file</svg>");
    write(&root, "favicon.svg", b"<svg>automatic</svg>");
    let response = core.project_icon(&project.id).await.unwrap();
    assert_eq!(response.project_id, project.id);
    assert_eq!(response.project_path, project.path);
    let image = response.image.unwrap();
    assert_eq!(image.source, ProjectIconSource::ProjectFile);
    assert_eq!(image.relative_path, "logo.svg");
    assert_eq!(bytes(&image), b"<svg>project-file</svg>");
    assert!(!core.store.project(&project.id).unwrap().trusted);
    assert_eq!(std::fs::read(root.join("orbyn.json")).unwrap(), config);
    assert!(!root.join("executed").exists());
}

#[tokio::test]
async fn config_precedence_bad_hints_and_candidate_order_fall_through() {
    let (_dir, core, project, root) = fixture().await;
    write(&root, "t3.json", br#"{"iconPath":"hint.png"}"#);
    write(&root, "hint.png", b"hint");
    write(&root, "favicon.svg", b"svg");
    write(&root, "favicon.ico", b"ico");
    write(&root, "public/favicon.svg", b"public");
    assert_eq!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .unwrap()
            .source,
        ProjectIconSource::ProjectFile
    );
    write(&root, "orbyn.json", b"broken");
    let image = core.project_icon(&project.id).await.unwrap().image.unwrap();
    assert_eq!(image.source, ProjectIconSource::Automatic);
    assert_eq!(image.relative_path, "favicon.svg");
    write(&root, "orbyn.json", br#"{"iconPath":"../outside.svg"}"#);
    assert_eq!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .unwrap()
            .relative_path,
        "favicon.svg"
    );
    std::fs::remove_file(root.join("favicon.svg")).unwrap();
    assert_eq!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .unwrap()
            .relative_path,
        "favicon.ico"
    );
}

#[tokio::test]
async fn source_hints_use_public_first_and_never_fetch_or_evaluate_source() {
    let (_dir, core, project, root) = fixture().await;
    write(
        &root,
        "index.html",
        br#"<link HREF='/brand.svg?revision=1' REL='shortcut icon'>"#,
    );
    write(&root, "brand.svg", b"root");
    write(&root, "public/brand.svg", b"public");
    assert_eq!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .unwrap()
            .relative_path,
        "public/brand.svg"
    );
    std::fs::remove_file(root.join("index.html")).unwrap();
    write(
        &root,
        "src/routes/__root.tsx",
        br#"metadata: [{ href: '/brand.svg', rel: 'icon' }]; throw new Error('never execute')"#,
    );
    assert_eq!(
        bytes(&core.project_icon(&project.id).await.unwrap().image.unwrap()),
        b"public"
    );
    write(
        &root,
        "src/routes/__root.tsx",
        br#"{ rel: 'icon', href: 'https://example.invalid/icon.svg' }"#,
    );
    assert!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .is_none()
    );
}

#[tokio::test]
async fn known_git_paths_and_unsupported_image_hints_never_become_payloads() {
    let (_dir, core, project, root) = fixture().await;
    write(&root, ".git/private.svg", b"private");
    write(&root, ".GIT/private.svg", b"private");
    write(&root, "credentials.json", b"do not read as an image");
    for hint in [
        ".git/private.svg",
        ".GIT/private.svg",
        "credentials.json",
        "../outside.svg",
    ] {
        write(
            &root,
            "orbyn.json",
            serde_json::json!({"iconPath":hint}).to_string(),
        );
        assert!(
            core.project_icon(&project.id)
                .await
                .unwrap()
                .image
                .is_none(),
            "{hint}"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn image_config_and_source_links_cannot_escape_the_selected_root() {
    let (dir, core, project, root) = fixture().await;
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    write(
        &root,
        "inside.svg",
        b"should not be selected via outside config/source",
    );
    write(&outside, "outside.json", br#"{"iconPath":"inside.svg"}"#);
    std::os::unix::fs::symlink(outside.join("outside.json"), root.join("orbyn.json")).unwrap();
    assert!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .is_none()
    );
    std::fs::remove_file(root.join("orbyn.json")).unwrap();
    write(
        &outside,
        "index.html",
        br#"<link rel='icon' href='inside.svg'>"#,
    );
    std::os::unix::fs::symlink(outside.join("index.html"), root.join("index.html")).unwrap();
    assert!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .is_none()
    );
    write(&outside, "private.svg", b"outside image");
    std::os::unix::fs::symlink(outside.join("private.svg"), root.join("favicon.svg")).unwrap();
    assert!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .is_none()
    );
}

#[tokio::test]
async fn selected_children_are_independent_and_size_limits_fall_back() {
    let (_dir, core, project, root) = fixture().await;
    write(&root, "favicon.svg", b"parent");
    let child = root.join("child");
    std::fs::create_dir_all(&child).unwrap();
    let child_project = core.add_project(child.to_str().unwrap()).await.unwrap();
    assert!(
        core.project_icon(&child_project.id)
            .await
            .unwrap()
            .image
            .is_none()
    );
    write(&child, "favicon.svg", b"child");
    assert_eq!(
        bytes(
            &core
                .project_icon(&child_project.id)
                .await
                .unwrap()
                .image
                .unwrap()
        ),
        b"child"
    );
    write(
        &root,
        "orbyn.json",
        serde_json::json!({"iconPath":"large.png"}).to_string(),
    );
    write(&root, "large.png", vec![0; IMAGE_LIMIT + 1]);
    assert_eq!(
        bytes(&core.project_icon(&project.id).await.unwrap().image.unwrap()),
        b"parent"
    );
    std::fs::remove_file(root.join("favicon.svg")).unwrap();
    write(
        &root,
        "index.html",
        format!(
            "{}<link rel='icon' href='child/favicon.svg'>",
            " ".repeat(TEXT_LIMIT)
        ),
    );
    assert!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .is_none()
    );
}

#[tokio::test]
async fn bounded_reader_detects_growth_and_stops_at_the_probe_byte() {
    let mut reader = std::io::Cursor::new(vec![1; 100]);
    let result = bounded_read(&mut reader, 8).await.unwrap();
    assert_eq!(result.len(), 9);
    assert_eq!(reader.position(), 9);
}

#[tokio::test]
async fn revisions_include_bytes_and_media_type_and_missing_files_recover() {
    let (_dir, core, project, root) = fixture().await;
    assert!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .is_none()
    );
    write(&root, "favicon.png", b"first");
    let first = core.project_icon(&project.id).await.unwrap().image.unwrap();
    write(&root, "favicon.png", b"second");
    let second = core.project_icon(&project.id).await.unwrap().image.unwrap();
    assert_ne!(first.revision, second.revision);
    std::fs::remove_file(root.join("favicon.png")).unwrap();
    write(&root, "favicon.svg", b"second");
    let svg = core.project_icon(&project.id).await.unwrap().image.unwrap();
    assert_ne!(svg.revision, second.revision);
    std::fs::remove_file(root.join("favicon.svg")).unwrap();
    assert!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .is_none()
    );
}

fn png(width: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    bytes.extend(width.to_be_bytes());
    bytes.extend(width.to_be_bytes());
    bytes
}
fn icns(images: &[Vec<u8>]) -> Vec<u8> {
    let length = 8 + images.iter().map(|image| 8 + image.len()).sum::<usize>();
    let mut bytes = b"icns".to_vec();
    bytes.extend(u32::try_from(length).unwrap().to_be_bytes());
    for image in images {
        bytes.extend(b"ic07");
        bytes.extend(u32::try_from(image.len() + 8).unwrap().to_be_bytes());
        bytes.extend(image);
    }
    bytes
}

#[tokio::test]
async fn icns_extracts_a_bounded_preferred_png_and_bad_lengths_fall_back() {
    let (_dir, core, project, root) = fixture().await;
    let preferred = png(128);
    let packed = icns(&[png(32), png(256), preferred.clone()]);
    write(&root, "AppIcon.icns", packed);
    let image = core.project_icon(&project.id).await.unwrap().image.unwrap();
    assert_eq!(image.media_type, ProjectIconMediaType::Png);
    assert_eq!(bytes(&image), preferred);
    assert_eq!(icns_png(&icns(&[png(32), png(64)])), Some(png(64)));
    assert!(icns_png(b"icns\xff\xff\xff\xffic07\xff\xff\xff\xff").is_none());
    write(&root, "AppIcon.icns", b"icns\0\0\0\x10ic07\0\0\0\0");
    assert!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .is_none()
    );
}

#[tokio::test]
async fn scratch_library_and_removed_project_identity_are_refused() {
    let (_dir, core, project, root) = fixture().await;
    let library = core.workspace.root().unwrap();
    let mut protected = project.clone();
    protected.path = library.to_string_lossy().into_owned();
    assert!(ImageScope::new(&protected, &library).is_err());
    protected = project.clone();
    protected.scratch = true;
    assert!(ImageScope::new(&protected, &library).is_err());
    assert!(core.project_icon("missing").await.is_err());
    let mut context = ImageScope::new(&project, &library).unwrap();
    context.source_budget = 0;
    write(&root, "index.html", b"<link rel='icon' href='inside.svg'>");
    write(&root, "inside.svg", b"hint");
    assert!(context.resolve().await.unwrap().is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn a_replaced_registered_root_is_not_followed() {
    let (dir, core, project, root) = fixture().await;
    let moved = dir.path().join("moved");
    std::fs::rename(&root, &moved).unwrap();
    let outside = dir.path().join("outside");
    write(&outside, "favicon.svg", b"outside");
    std::os::unix::fs::symlink(&outside, &root).unwrap();
    assert!(matches!(
        core.project_icon(&project.id).await,
        Err(CoreError::StaleOwner)
    ));
}

#[tokio::test]
async fn actual_handle_identity_rejects_outside_or_git_bytes_despite_safe_current_path() {
    let (dir, core, project, root) = fixture().await;
    let library = core.workspace.root().unwrap();
    let scope = ImageScope::new(&project, &library).unwrap();
    write(&root, "folder/icon.svg", b"original");
    let opened = std::fs::File::open(root.join("folder/icon.svg")).unwrap();
    let outside = dir.path().join("moved-outside");
    std::fs::rename(root.join("folder"), &outside).unwrap();
    write(&root, "folder/icon.svg", b"safe replacement path");
    assert!(
        scope
            .opened_relative(&opened, "folder/icon.svg", ReadKind::Image)
            .is_none(),
        "checking only the safe replacement path would authorize the wrong open handle"
    );
    let fresh = std::fs::File::open(root.join("folder/icon.svg")).unwrap();
    assert_eq!(
        scope
            .opened_relative(&fresh, "folder/icon.svg", ReadKind::Image)
            .as_deref(),
        Some("folder/icon.svg")
    );
    write(&root, ".git/secret.svg", b"synthetic metadata");
    let git = std::fs::File::open(root.join(".git/secret.svg")).unwrap();
    assert!(
        scope
            .opened_relative(&git, "folder/icon.svg", ReadKind::Image)
            .is_none()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn in_root_config_and_source_aliases_and_nonimage_aliases_are_not_consumed() {
    let (_dir, core, project, root) = fixture().await;
    write(
        &root,
        "auth.json",
        br#"{"iconPath":"inside.svg","synthetic":"not real credentials"}"#,
    );
    write(&root, "inside.svg", b"not selected through metadata alias");
    std::os::unix::fs::symlink("auth.json", root.join("orbyn.json")).unwrap();
    assert!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .is_none()
    );
    std::fs::remove_file(root.join("orbyn.json")).unwrap();
    std::os::unix::fs::symlink("auth.json", root.join("favicon.svg")).unwrap();
    assert!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .is_none()
    );
    std::fs::remove_file(root.join("favicon.svg")).unwrap();
    write(
        &root,
        "source.html",
        br#"<link rel='icon' href='inside.svg'>"#,
    );
    std::os::unix::fs::symlink("source.html", root.join("index.html")).unwrap();
    assert!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .is_none()
    );
    // Image aliases are permitted when the actual target is a safe image.
    std::os::unix::fs::symlink("inside.svg", root.join("favicon.png")).unwrap();
    let image = core.project_icon(&project.id).await.unwrap().image.unwrap();
    assert_eq!(image.relative_path, "inside.svg");
    assert_eq!(image.media_type, ProjectIconMediaType::Svg);
}

#[test]
fn source_extraction_retains_pinned_literal_key_and_fragment_behavior() {
    assert_eq!(
        icon_href(r#"{ 'rel': 'icon', 'href': 'quoted.svg' }"#),
        None
    );
    assert_eq!(
        icon_href(r#"{ "rel": "icon", "href": "quoted.svg" }"#),
        None
    );
    assert_eq!(
        icon_href(r#"{ rel: 'icon', href: 'literal.svg#part' }"#),
        Some("literal.svg#part")
    );
}

#[tokio::test]
async fn a_directory_is_not_a_project_file_and_does_not_mask_t3_json() {
    let (_dir, core, project, root) = fixture().await;
    std::fs::create_dir_all(root.join("orbyn.json")).unwrap();
    write(&root, "t3.json", br#"{"iconPath":"hint.svg"}"#);
    write(&root, "hint.svg", b"hint");
    assert_eq!(
        core.project_icon(&project.id)
            .await
            .unwrap()
            .image
            .unwrap()
            .relative_path,
        "hint.svg"
    );
}
