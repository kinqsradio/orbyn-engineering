use super::*;
use crate::{
    CoreConfig,
    testing::{TempDir, library, run_git},
};
use orbyn_contracts::{ProjectGroupingOverride, WorkspaceSetup};
use serde_json::json;

async fn core(dir: &TempDir) -> Core {
    let root = library(&dir.path().join("library"));
    let mut config = CoreConfig::new(dir.path().join("data"), "http://127.0.0.1:1".into());
    config.engines.lookup_latest = false;
    let core = Core::open(config).unwrap();
    core.workspace
        .setup(WorkspaceSetup {
            url: None,
            adopt_path: Some(root.to_string_lossy().into_owned()),
        })
        .await
        .unwrap();
    core
}

fn repository(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    run_git(path, &["init", "-q", "-b", "main"]);
    run_git(
        path,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-qm",
            "Fixture",
        ],
    );
}

fn configure(path: &Path, name: &str, remote: &str) {
    run_git(path, &["config", &format!("remote.{name}.url"), remote]);
}

fn group<'a>(catalog: &'a ProjectScopeCatalog, id: &str) -> &'a ProjectScopeGroup {
    catalog
        .groups
        .iter()
        .find(|group| group.members.iter().any(|member| member.project_id == id))
        .unwrap()
}

#[test]
fn remote_equivalence_is_limited_and_never_retains_userinfo() {
    let keys: Vec<_> = [
        "https://alice:PRIVATE@GitHub.COM/Owner/Repo.git?token=PRIVATE#PRIVATE",
        "ssh://git@github.com/Owner/Repo.git",
        "git@github.com:Owner/Repo.git",
    ]
    .into_iter()
    .map(|raw| remote_repository(raw).unwrap())
    .collect();
    assert!(
        keys.iter()
            .all(|key| key.canonical == "github.com/Owner/Repo" && key.label == "Owner/Repo")
    );
    let explicit = remote_repository("https://github.com:443/Owner/Repo.git").unwrap();
    assert_ne!(
        keys[0].canonical, explicit.canonical,
        "explicit ports stay distinct"
    );
    assert_ne!(
        keys[0].canonical,
        remote_repository("git@github.com:Owner/repo.git")
            .unwrap()
            .canonical
    );
    for value in [
        "/tmp/repo.git",
        "../repo",
        "file:///tmp/repo",
        r"C:\work\repo",
        "garbage",
        "https://",
        "https://host/a/../b",
        "ext::command",
        "https://host/a%2fb",
    ] {
        assert!(
            remote_repository(value).is_none(),
            "a local or malformed locator must stay physical"
        );
    }
    assert!(remote_repository(&format!("https://host/{}", "x".repeat(MAX_REMOTE_BYTES))).is_none());
}

#[test]
fn fork_origin_wins_and_local_origins_do_not_merge_unrelated_folders() {
    let parse = |text: &str| {
        repository_from_config(text.as_bytes())
            .unwrap()
            .map(|repo| repo.canonical)
    };
    assert_eq!(
        parse(
            "remote.upstream.url\nhttps://host/Parent/Repo.git\0remote.origin.url\ngit@host:Fork/Repo.git\0"
        ),
        Some("host/Fork/Repo".into())
    );
    assert_eq!(parse("remote.origin.url\n/tmp/shared.git\0"), None);
    assert_eq!(
        parse(
            "remote.origin.url\nrelative/folder:repo.git\0remote.upstream.url\nhttps://host/Parent/Repo.git\0"
        ),
        Some("host/Parent/Repo".into())
    );
    assert_eq!(
        parse("remote.upstream.url\nhttps://host/Parent/Repo.git\0remote.origin.url\nhttps://\0"),
        None,
        "an unparseable fork origin must not merge into upstream"
    );
}

#[tokio::test]
async fn local_clones_group_by_repository_with_forks_and_physical_overrides_separate() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let source = dir.path().join("first");
    repository(&source);
    let clone = dir.path().join("second");
    run_git(
        dir.path(),
        &[
            "clone",
            "-q",
            "--no-hardlinks",
            source.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    let fork = dir.path().join("fork");
    run_git(
        dir.path(),
        &[
            "clone",
            "-q",
            "--no-hardlinks",
            source.to_str().unwrap(),
            fork.to_str().unwrap(),
        ],
    );
    configure(
        &source,
        "origin",
        "https://user:PRIVATE@host/Owner/Repo.git?key=PRIVATE",
    );
    configure(&clone, "origin", "git@host:Owner/Repo.git");
    configure(&fork, "origin", "ssh://git@host/Fork/Repo.git");
    configure(&fork, "upstream", "https://host/Owner/Repo.git");
    let a = core.add_project(source.to_str().unwrap()).await.unwrap();
    let b = core.add_project(clone.to_str().unwrap()).await.unwrap();
    let c = core.add_project(fork.to_str().unwrap()).await.unwrap();
    let mut query = ProjectScopesQuery::default();
    let catalog = core.project_scope_catalog(&query).await.unwrap();
    assert!(catalog.metadata_complete);
    assert_eq!(group(&catalog, &a.id).members.len(), 2);
    assert_eq!(group(&catalog, &a.id).key, group(&catalog, &b.id).key);
    assert_ne!(group(&catalog, &a.id).key, group(&catalog, &c.id).key);
    assert!(!serde_json::to_string(&catalog).unwrap().contains("PRIVATE"));
    assert!(
        !serde_json::to_string(&catalog)
            .unwrap()
            .contains("https://")
    );
    let original_key = group(&catalog, &a.id).key.clone();
    core.rename_project(&a.id, "Unrelated title").unwrap();
    let renamed = core.project_scope_catalog(&query).await.unwrap();
    assert_eq!(original_key, group(&renamed, &a.id).key);
    assert_eq!(
        catalog.version, renamed.version,
        "names are not membership identity"
    );
    query.recipe.mode = ProjectGroupingMode::RepositoryPath;
    let by_path = core.project_scope_catalog(&query).await.unwrap();
    assert_eq!(group(&by_path, &a.id).key, group(&by_path, &b.id).key);
    assert_eq!(
        group(&by_path, &a.id).members[0]
            .repository_relative_path
            .as_deref(),
        Some("")
    );
    query.recipe.overrides.push(ProjectGroupingOverride {
        project_id: b.id.clone(),
        mode: ProjectGroupingMode::Separate,
    });
    let separated = core.project_scope_catalog(&query).await.unwrap();
    assert_ne!(group(&separated, &a.id).key, group(&separated, &b.id).key);
    assert_ne!(by_path.version, separated.version);
    query.recipe.mode = ProjectGroupingMode::Separate;
    assert_eq!(
        core.project_scope_catalog(&query)
            .await
            .unwrap()
            .groups
            .len(),
        3
    );
}

#[tokio::test]
async fn physical_fallbacks_and_stale_selections_never_broaden_to_all() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let a_path = dir.path().join("a");
    let b_path = dir.path().join("b");
    repository(&a_path);
    repository(&b_path);
    configure(&a_path, "origin", "/tmp/same.git");
    configure(&b_path, "origin", "/tmp/same.git");
    let a = core.add_project(a_path.to_str().unwrap()).await.unwrap();
    let b = core.add_project(b_path.to_str().unwrap()).await.unwrap();
    let mut query = ProjectScopesQuery::default();
    let before = core.project_scope_catalog(&query).await.unwrap();
    assert!(before.metadata_complete);
    assert_ne!(group(&before, &a.id).key, group(&before, &b.id).key);
    assert!(group(&before, &a.id).members[0].repository_key.is_none());
    query.selection = Some(ProjectSettingsSelection::ProjectGroup {
        group_key: "stale".into(),
    });
    assert!(matches!(
        core.project_scope_catalog(&query).await.unwrap().selection,
        ResolvedProjectSettingsScope::Unavailable { .. }
    ));
    query.selection = Some(ProjectSettingsSelection::Checkout {
        group_key: group(&before, &a.id).key.clone(),
        project_id: b.id.clone(),
    });
    assert!(matches!(
        core.project_scope_catalog(&query).await.unwrap().selection,
        ResolvedProjectSettingsScope::Unavailable {
            reason: ProjectScopeUnavailableReason::CheckoutMissing
        }
    ));
    std::fs::remove_dir_all(&a_path).unwrap();
    query.selection = Some(ProjectSettingsSelection::Checkout {
        group_key: group(&before, &a.id).key.clone(),
        project_id: a.id.clone(),
    });
    let after = core.project_scope_catalog(&query).await.unwrap();
    assert_ne!(before.version, after.version);
    assert!(matches!(
        after.selection,
        ResolvedProjectSettingsScope::Unavailable {
            reason: ProjectScopeUnavailableReason::CheckoutMissing
        }
    ));
    query.recipe.overrides.push(ProjectGroupingOverride {
        project_id: "removed".into(),
        mode: ProjectGroupingMode::Separate,
    });
    assert!(matches!(
        core.project_scope_catalog(&query).await,
        Err(CoreError::NotFound(_))
    ));
}

#[tokio::test]
async fn registered_linked_worktrees_are_real_checkout_members() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let root = dir.path().join("repo");
    repository(&root);
    configure(&root, "origin", "git@host:Owner/Repo.git");
    let linked = dir.path().join("linked");
    run_git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "linked",
            linked.to_str().unwrap(),
        ],
    );
    let a = core.add_project(root.to_str().unwrap()).await.unwrap();
    let b = core.add_project(linked.to_str().unwrap()).await.unwrap();
    let catalog = core
        .project_scope_catalog(&ProjectScopesQuery::default())
        .await
        .unwrap();
    let members = &group(&catalog, &a.id).members;
    assert_eq!(members.len(), 2);
    assert_ne!(members[0].physical_key, members[1].physical_key);
    assert_eq!(group(&catalog, &a.id).key, group(&catalog, &b.id).key);
    assert!(
        members
            .iter()
            .all(|member| member.repository_relative_path.as_deref() == Some(""))
    );
}

#[tokio::test]
async fn metadata_deadline_stops_and_reaps_its_owned_git_process() {
    let dir = TempDir::new();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        metadata(
            dir.path(),
            &[
                "-c",
                "alias.scope-wait=!(sleep 1; echo late > late) & wait",
                "scope-wait",
            ],
            Instant::now() + Duration::from_millis(100),
        ),
    )
    .await
    .unwrap();
    assert!(result.is_none());
    let late = tokio::time::timeout(Duration::from_secs(2), async {
        while !dir.path().join("late").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(
        late.is_err(),
        "a cancelled metadata helper wrote after its owner returned"
    );
}

#[tokio::test]
async fn registration_records_the_actual_root_and_plain_folders_are_complete() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let root = dir.path().join("repo");
    repository(&root);
    std::fs::create_dir_all(root.join("nested")).unwrap();
    let project = core
        .add_project(root.join("nested").to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(Path::new(&project.path), root);
    let plain = dir.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let plain = core.add_project(plain.to_str().unwrap()).await.unwrap();
    let catalog = core
        .project_scope_catalog(&ProjectScopesQuery::default())
        .await
        .unwrap();
    assert_eq!(
        group(&catalog, &project.id).members[0]
            .repository_relative_path
            .as_deref(),
        Some("")
    );
    let member = &group(&catalog, &plain.id).members[0];
    assert!(member.metadata_complete && member.repository_key.is_none());
    assert!(member.repository_relative_path.is_none());
}

#[test]
fn explicit_null_and_malformed_selections_are_not_default_all() {
    assert!(
        serde_json::from_value::<ProjectScopesQuery>(json!({}))
            .unwrap()
            .selection
            .is_none()
    );
    for value in [
        json!({ "selection": null }),
        json!({ "selection": {} }),
        json!({ "selection": { "kind": "all_projects", "group_key": "stale" } }),
    ] {
        assert!(
            serde_json::from_value::<ProjectScopesQuery>(value.clone()).is_err(),
            "{value}"
        );
    }
}

#[tokio::test]
async fn exhausted_metadata_budget_is_unknown_and_cannot_hide_group_members() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let path = dir.path().join("repo");
    repository(&path);
    configure(&path, "origin", "https://host/Owner/Repo.git");
    let project = core.add_project(path.to_str().unwrap()).await.unwrap();
    let member = checkout(project, ProjectGroupingMode::Repository, Instant::now()).await;
    assert!(!member.metadata_complete && member.repository_key.is_none());
    let catalog = core
        .project_scope_catalog(&ProjectScopesQuery::default())
        .await
        .unwrap();
    let key = &catalog.groups[0].key;
    assert!(matches!(
        resolve_project_settings_scope(
            &catalog.groups,
            Some(&ProjectSettingsSelection::ProjectGroup {
                group_key: key.clone()
            }),
            false
        ),
        ResolvedProjectSettingsScope::Unavailable {
            reason: ProjectScopeUnavailableReason::MetadataUnavailable
        }
    ));
    assert!(matches!(
        resolve_project_settings_scope(
            &catalog.groups,
            Some(&ProjectSettingsSelection::Checkout {
                group_key: key.clone(),
                project_id: catalog.groups[0].members[0].project_id.clone()
            }),
            false
        ),
        ResolvedProjectSettingsScope::Checkout { .. }
    ));
    assert_eq!(
        resolve_project_settings_scope(&catalog.groups, None, false),
        ResolvedProjectSettingsScope::AllProjects
    );
}

#[test]
fn first_fetch_url_is_authoritative_and_unobserved_config_is_not_guessed() {
    let repo = repository_from_config(b"remote.origin.url\nhttps://host/First/Repo.git\0remote.origin.url\nhttps://host/Second/Repo.git\0").unwrap().unwrap();
    assert_eq!(repo.canonical, "host/First/Repo");
    assert!(
        repository_from_config(
            b"remote.origin.url\n/tmp/local.git\0remote.origin.url\nhttps://host/Second/Repo.git\0"
        )
        .unwrap()
        .is_none()
    );
    for bytes in [
        b"include.path\n/not/read\0".as_slice(),
        b"includeif.gitdir:/x.path\n/not/read\0",
        b"url.https://host/.insteadof\nshort:\0",
    ] {
        assert!(repository_from_config(bytes).is_err());
    }
}

#[tokio::test]
async fn worktree_origin_is_observed_without_overriding_first_common_fetch_url() {
    let dir = TempDir::new();
    let core = core(&dir).await;
    let root = dir.path().join("repo");
    repository(&root);
    configure(&root, "upstream", "https://host/Parent/Repo.git");
    run_git(&root, &["config", "extensions.worktreeConfig", "true"]);
    let linked = dir.path().join("linked");
    run_git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "linked",
            linked.to_str().unwrap(),
        ],
    );
    run_git(
        &linked,
        &[
            "config",
            "--worktree",
            "remote.origin.url",
            "https://host/Fork/Repo.git",
        ],
    );
    let a = core.add_project(root.to_str().unwrap()).await.unwrap();
    let b = core.add_project(linked.to_str().unwrap()).await.unwrap();
    let query = ProjectScopesQuery::default();
    let catalog = core.project_scope_catalog(&query).await.unwrap();
    assert!(catalog.metadata_complete);
    assert_ne!(group(&catalog, &a.id).key, group(&catalog, &b.id).key);
    assert_eq!(
        group(&catalog, &b.id).members[0]
            .repository_label
            .as_deref(),
        Some("Fork/Repo")
    );
    configure(&root, "origin", "https://host/Parent/Repo.git");
    let catalog = core.project_scope_catalog(&query).await.unwrap();
    assert_eq!(group(&catalog, &a.id).key, group(&catalog, &b.id).key);
    // This file must not be followed, even by the subsequent root probe.
    let include = dir.path().join("invalid-include");
    std::fs::write(&include, "INVALID FIXTURE CONFIG\n").unwrap();
    run_git(
        &root,
        &["config", "include.path", include.to_str().unwrap()],
    );
    let catalog = core.project_scope_catalog(&query).await.unwrap();
    assert!(!catalog.metadata_complete);
    assert!(group(&catalog, &a.id).members[0].repository_key.is_none());
}
