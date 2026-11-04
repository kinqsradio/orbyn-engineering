//! Published agent pages through the real service: what is stored, what is served
//! back, which images are copied and what a thread's deletion takes with it.

mod support;

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use support::{Options, Service, TempDir, setup};

/// The exact policy a published page and its images are served with.
const CSP: &str = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

fn header<'a>(response: &'a reqwest::Response, name: &str) -> &'a str {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

async fn publish(service: &Service, thread: &str, html: &str) -> (u16, Value) {
    service
        .send(
            &format!("/api/threads/{thread}/renders"),
            json!({ "html": html }),
        )
        .await
}

async fn checkout(service: &Service, thread: &str) -> PathBuf {
    let body = service.json(&format!("/api/threads/{thread}")).await;
    body["cwd"].as_str().unwrap().into()
}

fn render_root(dir: &TempDir, thread: &str) -> PathBuf {
    dir.path().join("data/renders").join(thread)
}

fn folders(folder: &Path) -> Vec<String> {
    let Ok(items) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut names: Vec<String> = items
        .flatten()
        .filter(|item| item.file_type().unwrap().is_dir())
        .map(|item| item.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[tokio::test]
async fn a_published_page_is_served_with_its_hardening_headers() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let html = "<!doctype html><title>report</title><p>hello</p>";

    let (status, body) = publish(&service, &thread, html).await;
    assert_eq!(status, 201, "{body}");
    let id = body["id"].as_str().unwrap().to_owned();
    assert_eq!(body["images"], 0);
    assert_eq!(body["bytes"], html.len());
    assert_eq!(
        body["url"].as_str().unwrap(),
        format!("/api/threads/{thread}/renders/{id}")
    );

    let url = body["url"].as_str().unwrap().to_owned();
    let response = service.get(&url).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        header(&response, "content-type"),
        "text/html; charset=utf-8"
    );
    assert_eq!(header(&response, "content-security-policy"), CSP);
    assert!(!header(&response, "content-security-policy").contains("allow-same-origin"));
    assert_eq!(header(&response, "x-content-type-options"), "nosniff");
    assert_eq!(
        header(&response, "cross-origin-resource-policy"),
        "same-origin"
    );
    assert_eq!(header(&response, "referrer-policy"), "no-referrer");
    assert_eq!(header(&response, "cache-control"), "private, no-cache");
    assert_eq!(response.text().await.unwrap(), html);

    // An iframe cannot set a header, so the page route takes the token in the URL,
    // and publishing a render is not a read and does not.
    let anonymous = service
        .client
        .get(format!("{}{url}", service.url))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), 401);
    let in_url = service
        .client
        .get(format!("{}{url}?token={}", service.url, service.token))
        .send()
        .await
        .unwrap();
    assert_eq!(in_url.status(), 200);
    let publish_token = service
        .client
        .post(format!("{}/api/threads/{thread}/renders", service.url))
        .query(&[("token", service.token.as_str())])
        .json(&json!({ "html": html }))
        .send()
        .await
        .unwrap();
    assert_eq!(publish_token.status(), 401);
}

#[tokio::test]
async fn a_checkout_image_is_copied_and_its_src_rewritten() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let root = checkout(&service, &thread).await;
    let png: Vec<u8> = (0..=255).collect();
    std::fs::write(root.join("logo.png"), &png).unwrap();
    std::fs::create_dir_all(root.join("art")).unwrap();
    std::fs::write(root.join("art/deep.svg"), b"<svg/>").unwrap();
    let absolute = root.join("abs.webp");
    std::fs::write(&absolute, b"webp").unwrap();

    let html = format!(
        "<!doctype html><img src=\"logo.png\"><img src='art/deep.svg'>\
         <img src=\"{}\"><img src=https://example.test/remote.png><img src=\"data:image/gif;base64,AA\">",
        absolute.to_str().unwrap()
    );
    let (status, body) = publish(&service, &thread, &html).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["images"], 3, "{body}");
    let url = body["url"].as_str().unwrap().to_owned();

    let page = service
        .get(&url)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(page.contains("src=\"image-1.png\""), "{page}");
    assert!(page.contains("src='image-2.svg'"), "{page}");
    assert!(page.contains("src=\"image-3.webp\""), "{page}");
    assert!(!page.contains("logo.png"), "{page}");
    assert!(!page.contains("deep.svg"), "{page}");
    assert!(!page.contains(absolute.to_str().unwrap()), "{page}");
    // A remote src is left exactly as written; the sandbox CSP stops it loading.
    assert!(
        page.contains("src=https://example.test/remote.png"),
        "{page}"
    );
    assert!(page.contains("data:image/gif;base64,AA"), "{page}");

    let image = service
        .get(&format!("{url}/image-1.png"))
        .send()
        .await
        .unwrap();
    assert_eq!(image.status(), 200);
    assert_eq!(header(&image, "content-type"), "image/png");
    assert_eq!(header(&image, "content-security-policy"), CSP);
    assert_eq!(header(&image, "x-content-type-options"), "nosniff");
    assert_eq!(image.bytes().await.unwrap().to_vec(), png);

    let svg = service
        .get(&format!("{url}/image-2.svg"))
        .send()
        .await
        .unwrap();
    assert_eq!(svg.status(), 200);
    assert_eq!(header(&svg, "content-type"), "image/svg+xml");

    // Nothing else in the render folder is reachable by name.
    for name in [
        "index.html",
        "logo.png",
        "image-1.txt",
        "image-1.png.html",
        "%2e%2e%2findex.html",
        "..",
        "image-1.png/",
    ] {
        let refused = service.get(&format!("{url}/{name}")).send().await.unwrap();
        assert_eq!(refused.status(), 404, "{name}");
    }
}

#[tokio::test]
async fn a_src_outside_the_checkout_is_left_alone_and_the_page_still_publishes() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let root = checkout(&service, &thread).await;
    std::fs::write(root.join("inside.png"), b"in").unwrap();
    std::fs::write(dir.path().join("outside.png"), b"out").unwrap();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::write(root.join(".git/config"), b"secret").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(dir.path().join("outside.png"), root.join("link.png")).unwrap();

    let external = dir.path().join("outside.png");
    let html = format!(
        "<img src=\"../outside.png\"><img src=\"{}\"><img src=\"inside.png\">\
         <img src=\".git/config\"><img src=\"{}\">\
         <img src=\"link.png\"><img src=\"missing.png\">",
        external.to_str().unwrap(),
        root.join(".git/config").to_str().unwrap()
    );
    let (status, body) = publish(&service, &thread, &html).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["images"], 1, "{body}");

    let url = body["url"].as_str().unwrap().to_owned();
    let page = service
        .get(&url)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    for kept in [
        "src=\"../outside.png\"",
        "src=\".git/config\"",
        "src=\"link.png\"",
        "src=\"missing.png\"",
    ] {
        assert!(page.contains(kept), "{kept}: {page}");
    }
    assert!(page.contains("src=\"image-1.png\""), "{page}");
    assert!(page.contains(external.to_str().unwrap()), "{page}");

    let gone = service
        .get(&format!("{url}/image-2.png"))
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), 404);
}

#[tokio::test]
async fn html_over_the_limit_is_refused() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let limit = 512 * 1024;
    let (status, body) = publish(&service, &thread, &"a".repeat(limit + 1)).await;
    assert_eq!(status, 400, "{body}");
    assert!(
        body["message"]
            .as_str()
            .is_some_and(|text| text.contains("512 KiB")),
        "{body}"
    );
    assert!(folders(&render_root(&dir, &thread)).is_empty());

    let (status, body) = publish(&service, &thread, &"a".repeat(limit)).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["bytes"], limit);
}

#[tokio::test]
async fn an_unknown_render_id_or_thread_is_not_found() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let (status, body) = publish(&service, &thread, "<p>one</p>").await;
    assert_eq!(status, 201, "{body}");

    let missing = service
        .get(&format!(
            "/api/threads/{thread}/renders/01jc8xw9kq0000000000000000"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);

    let shape = service
        .get(&format!("/api/threads/{thread}/renders/index.html"))
        .send()
        .await
        .unwrap();
    assert_eq!(shape.status(), 404);

    let no_thread = service
        .get("/api/threads/01jc8xw9kq0000000000000000/renders/01jc8xw9kq0000000000000001")
        .send()
        .await
        .unwrap();
    assert_eq!(no_thread.status(), 404);
}

#[tokio::test]
async fn another_thread_cannot_read_this_render() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let project = service.json(&format!("/api/threads/{thread}")).await["project_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let sibling = service.thread(&project, "codex").await;
    let root = checkout(&service, &thread).await;
    std::fs::write(root.join("logo.png"), b"png").unwrap();

    let (status, body) = publish(&service, &thread, "<img src=\"logo.png\">").await;
    assert_eq!(status, 201, "{body}");
    let id = body["id"].as_str().unwrap().to_owned();

    for path in [
        format!("/api/threads/{sibling}/renders/{id}"),
        format!("/api/threads/{sibling}/renders/{id}/image-1.png"),
    ] {
        let refused = service.get(&path).send().await.unwrap();
        assert_eq!(refused.status(), 404, "{path}");
        let with_token = service
            .client
            .get(format!("{}{path}?token={}", service.url, service.token))
            .send()
            .await
            .unwrap();
        assert_eq!(with_token.status(), 404, "{path}");
    }
    // The thread that published it still reads it.
    let mine = service
        .get(&format!("/api/threads/{thread}/renders/{id}/image-1.png"))
        .send()
        .await
        .unwrap();
    assert_eq!(mine.status(), 200);
    assert_eq!(mine.bytes().await.unwrap().to_vec(), b"png");
}

#[tokio::test]
async fn deleting_a_thread_removes_its_renders() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let (status, _) = publish(&service, &thread, "<p>gone</p>").await;
    assert_eq!(status, 201);
    assert!(render_root(&dir, &thread).is_dir());

    let response = service
        .client
        .delete(format!("{}/api/threads/{thread}", service.url))
        .bearer_auth(&service.token)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success(), "{}", response.status());
    assert!(!render_root(&dir, &thread).exists());
}

#[tokio::test]
async fn the_twenty_first_publish_evicts_the_oldest() {
    let dir = TempDir::new();
    let (service, thread) = setup(&dir, Options::default(), "codex").await;
    let mut ids = Vec::new();
    for index in 0..21 {
        let (status, body) = publish(&service, &thread, &format!("<p>{index}</p>")).await;
        assert_eq!(status, 201, "{body}");
        ids.push(body["id"].as_str().unwrap().to_owned());
    }
    let kept = folders(&render_root(&dir, &thread));
    assert_eq!(kept.len(), 20, "{kept:?}");
    assert!(!kept.contains(&ids[0]), "{:?}", ids[0]);
    assert!(kept.contains(&ids[20]));
    assert!(!render_root(&dir, &thread).join(&ids[0]).exists());

    // The oldest page is gone and the newest still serves.
    let oldest = service
        .get(&format!("/api/threads/{thread}/renders/{}", ids[0]))
        .send()
        .await
        .unwrap();
    assert_eq!(oldest.status(), 404);
    let newest = service
        .get(&format!("/api/threads/{thread}/renders/{}", ids[20]))
        .send()
        .await
        .unwrap();
    assert_eq!(newest.status(), 200);
    assert_eq!(newest.text().await.unwrap(), "<p>20</p>");
}
