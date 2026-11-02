//! Registered-project image transport through the real local HTTP service.
mod support;

use reqwest::{Method, RequestBuilder, Response};
use serde_json::{Value, json};
use std::path::PathBuf;
use support::{Options, Service, TempDir};

const SVG: &[u8] =
    b"<svg xmlns=\"http://www.w3.org/2000/svg\"><title>image transport</title></svg>";

async fn fixture(desktop: bool) -> (TempDir, Service, Value, PathBuf) {
    let dir = TempDir::new();
    let service = Service::start(
        &dir.path().join("data"),
        Options {
            args: if desktop {
                vec!["--parent-stdin".into()]
            } else {
                vec![]
            },
            ..Options::default()
        },
    );
    service.ensure_workspace(dir.path()).await;
    let root = dir.path().join("image-fixture");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("favicon.svg"), SVG).unwrap();
    let (status, project) = service
        .send("/api/projects/add", json!({"path":root}))
        .await;
    assert_eq!(status, 201, "{project}");
    assert_eq!(project["trusted"], false);
    (dir, service, project, root)
}
fn image(service: &Service, id: &str, kind: &str, method: Method, path: &str) -> RequestBuilder {
    let request = service.client.request(
        method,
        format!("{}/api/projects/{id}/{kind}/raw", service.url),
    );
    if kind == "images" {
        request.query(&[("path", path)])
    } else {
        request
    }
}
fn header<'a>(response: &'a Response, name: &str) -> &'a str {
    response
        .headers()
        .get(name)
        .map(|value| value.to_str().unwrap())
        .unwrap_or("")
}
fn query_token(request: RequestBuilder, service: &Service) -> RequestBuilder {
    request.query(&[("token", service.token.as_str())])
}

#[tokio::test]
async fn query_token_authorizes_only_exact_image_get_and_head_routes() {
    let (_dir, service, project, _root) = fixture(false).await;
    let id = project["id"].as_str().unwrap();
    for kind in ["icon", "images"] {
        for method in [Method::GET, Method::HEAD] {
            let anonymous = image(&service, id, kind, method.clone(), "favicon.svg")
                .send()
                .await
                .unwrap();
            assert_eq!(anonymous.status(), 401);
            let wrong = image(&service, id, kind, method.clone(), "favicon.svg")
                .query(&[("token", "wrong")])
                .send()
                .await
                .unwrap();
            assert_eq!(wrong.status(), 401);
            let good = query_token(
                image(&service, id, kind, method.clone(), "favicon.svg"),
                &service,
            )
            .send()
            .await
            .unwrap();
            assert_eq!(good.status(), 200, "{kind}/{method}");
            assert_eq!(header(&good, "content-type"), "image/svg+xml");
            assert_eq!(header(&good, "content-length"), SVG.len().to_string());
            assert_eq!(
                good.bytes().await.unwrap().as_ref(),
                if method == Method::HEAD { &[][..] } else { SVG }
            );
        }
        for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
            let denied = query_token(image(&service, id, kind, method, "favicon.svg"), &service)
                .send()
                .await
                .unwrap();
            assert_eq!(denied.status(), 401);
        }
        // A bearer remains valid independently of an irrelevant query token.
        let bearer = image(&service, id, kind, Method::GET, "favicon.svg")
            .bearer_auth(&service.token)
            .query(&[("token", "wrong")])
            .send()
            .await
            .unwrap();
        assert_eq!(bearer.status(), 200);
    }
    for route in [
        format!("/api/projects/{id}/icon"),
        format!("/api/projects/{id}/icon/resource"),
        "/api/projects".into(),
    ] {
        for method in [Method::GET, Method::HEAD] {
            let denied = query_token(
                service
                    .client
                    .request(method, format!("{}{route}", service.url)),
                &service,
            )
            .send()
            .await
            .unwrap();
            assert_eq!(denied.status(), 401, "{route}");
        }
    }
    for route in [
        "/api/settings/projects/image",
        "/api/settings/projects/image-search",
    ] {
        let denied = query_token(
            service.client.post(format!("{}{route}", service.url)),
            &service,
        )
        .json(&json!({}))
        .send()
        .await
        .unwrap();
        assert_eq!(denied.status(), 401, "{route}");
    }
    assert!(
        service
            .json("/api/projects")
            .await
            .as_array()
            .unwrap()
            .contains(&project)
    );
}

#[tokio::test]
async fn selected_and_candidate_images_share_range_conditions_and_protect_image_headers() {
    let (_dir, service, project, root) = fixture(false).await;
    let id = project["id"].as_str().unwrap();
    for kind in ["icon", "images"] {
        let whole = query_token(
            image(&service, id, kind, Method::GET, "favicon.svg"),
            &service,
        )
        .send()
        .await
        .unwrap();
        assert_eq!(whole.status(), 200);
        let tag = header(&whole, "etag").to_owned();
        assert!(tag.starts_with('"') && tag.ends_with('"'));
        assert_eq!(header(&whole, "accept-ranges"), "bytes");
        assert_eq!(header(&whole, "cache-control"), "private, no-cache");
        assert_eq!(header(&whole, "referrer-policy"), "no-referrer");
        assert_eq!(header(&whole, "x-content-type-options"), "nosniff");
        assert!(header(&whole, "content-disposition").starts_with("inline;"));
        assert!(header(&whole, "content-security-policy").contains("sandbox"));
        assert_eq!(
            header(&whole, "cross-origin-resource-policy"),
            "same-origin"
        );
        assert_eq!(whole.bytes().await.unwrap().as_ref(), SVG);
        let part = query_token(
            image(&service, id, kind, Method::GET, "favicon.svg"),
            &service,
        )
        .header("range", "bytes=8-15")
        .header("if-range", &tag)
        .send()
        .await
        .unwrap();
        assert_eq!(part.status(), 206);
        assert_eq!(
            header(&part, "content-range"),
            format!("bytes 8-15/{}", SVG.len())
        );
        assert_eq!(header(&part, "content-length"), "8");
        assert_eq!(part.bytes().await.unwrap().as_ref(), &SVG[8..16]);
        let suffix = query_token(
            image(&service, id, kind, Method::GET, "favicon.svg"),
            &service,
        )
        .header("range", "bytes=-5")
        .send()
        .await
        .unwrap();
        assert_eq!(suffix.status(), 206);
        assert_eq!(
            suffix.bytes().await.unwrap().as_ref(),
            &SVG[SVG.len() - 5..]
        );
        for method in [Method::GET, Method::HEAD] {
            let unchanged = query_token(image(&service, id, kind, method, "favicon.svg"), &service)
                .header("if-none-match", &tag)
                .send()
                .await
                .unwrap();
            assert_eq!(unchanged.status(), 304);
            assert_eq!(header(&unchanged, "etag"), tag);
            assert!(unchanged.bytes().await.unwrap().is_empty());
        }
        let past = query_token(
            image(&service, id, kind, Method::GET, "favicon.svg"),
            &service,
        )
        .header("range", format!("bytes={}-", SVG.len()))
        .send()
        .await
        .unwrap();
        assert_eq!(past.status(), 416);
        assert_eq!(
            header(&past, "content-range"),
            format!("bytes */{}", SVG.len())
        );
        assert!(past.bytes().await.unwrap().is_empty());
        // MIME/content hashing, rather than mtime timing, detects this replacement.
        let newer =
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><title>changed content</title></svg>";
        std::fs::write(root.join("favicon.svg"), newer).unwrap();
        let stale = query_token(
            image(&service, id, kind, Method::GET, "favicon.svg"),
            &service,
        )
        .header("range", "bytes=0-1")
        .header("if-range", &tag)
        .send()
        .await
        .unwrap();
        assert_eq!(stale.status(), 200);
        assert_ne!(header(&stale, "etag"), tag);
        assert_eq!(stale.bytes().await.unwrap().as_ref(), newer);
        std::fs::write(root.join("favicon.svg"), SVG).unwrap();
    }
}

#[tokio::test]
async fn icns_ranges_and_head_describe_only_the_embedded_png_extent() {
    let (_dir, service, project, root) = fixture(false).await;
    let id = project["id"].as_str().unwrap();
    let png: Vec<u8> = vec![
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
        0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 96, 96, 96, 248, 15,
        0, 1, 4, 1, 0, 95, 229, 195, 75, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];
    let mut container = b"icns".to_vec();
    container.extend(((8 + 12 + 8 + png.len()) as u32).to_be_bytes());
    container.extend(b"junk");
    container.extend(12u32.to_be_bytes());
    container.extend([0xa5; 4]);
    container.extend(b"ic07");
    container.extend(((8 + png.len()) as u32).to_be_bytes());
    container.extend(&png);
    std::fs::write(root.join("choice space.icns"), container).unwrap();
    std::fs::write(
        root.join("orbyn.json"),
        r#"{"iconPath":"choice space.icns"}"#,
    )
    .unwrap();
    let resource = service
        .json(&format!("/api/projects/{id}/icon/resource"))
        .await;
    assert_eq!(resource["image"]["size"], png.len());
    assert_eq!(resource["image"]["media_type"], "png");
    for kind in ["icon", "images"] {
        let whole = query_token(
            image(&service, id, kind, Method::GET, "choice space.icns"),
            &service,
        )
        .send()
        .await
        .unwrap();
        assert_eq!(whole.status(), 200);
        let tag = header(&whole, "etag").to_owned();
        assert_eq!(header(&whole, "content-length"), png.len().to_string());
        assert_eq!(header(&whole, "content-type"), "image/png");
        assert_eq!(whole.bytes().await.unwrap().as_ref(), png);
        let part = query_token(
            image(&service, id, kind, Method::GET, "choice space.icns"),
            &service,
        )
        .header("range", "bytes=8-23")
        .header("if-range", &tag)
        .send()
        .await
        .unwrap();
        assert_eq!(part.status(), 206);
        assert_eq!(
            header(&part, "content-range"),
            format!("bytes 8-23/{}", png.len())
        );
        assert_eq!(part.bytes().await.unwrap().as_ref(), &png[8..24]);
        let head = query_token(
            image(&service, id, kind, Method::HEAD, "choice space.icns"),
            &service,
        )
        .send()
        .await
        .unwrap();
        assert_eq!(head.status(), 200);
        assert_eq!(header(&head, "etag"), tag);
        assert_eq!(header(&head, "content-length"), png.len().to_string());
        assert!(head.bytes().await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn native_image_cors_is_exact_and_does_not_replace_authentication() {
    let (_dir, service, project, _root) = fixture(true).await;
    let id = project["id"].as_str().unwrap();
    for origin in ["tauri://localhost", "http://tauri.localhost"] {
        for kind in ["icon", "images"] {
            let preflight = image(&service, id, kind, Method::OPTIONS, "favicon.svg")
                .header("origin", origin)
                .header("access-control-request-method", "GET")
                .header(
                    "access-control-request-headers",
                    "range,if-range,if-none-match",
                )
                .send()
                .await
                .unwrap();
            assert_eq!(preflight.status(), 204);
            assert_eq!(header(&preflight, "access-control-allow-origin"), origin);
            for method in [Method::GET, Method::HEAD] {
                let response =
                    query_token(image(&service, id, kind, method, "favicon.svg"), &service)
                        .header("origin", origin)
                        .send()
                        .await
                        .unwrap();
                assert_eq!(response.status(), 200);
                assert_eq!(header(&response, "access-control-allow-origin"), origin);
                assert!(header(&response, "access-control-expose-headers").contains("etag"));
                assert!(header(&response, "vary").contains("Origin"));
            }
            let part = query_token(
                image(&service, id, kind, Method::GET, "favicon.svg"),
                &service,
            )
            .header("origin", origin)
            .header("range", "bytes=0-7")
            .send()
            .await
            .unwrap();
            assert_eq!(part.status(), 206);
            assert_eq!(header(&part, "access-control-allow-origin"), origin);
            let tag = header(&part, "etag").to_owned();
            assert_eq!(part.bytes().await.unwrap().as_ref(), &SVG[..8]);
            let unchanged = query_token(
                image(&service, id, kind, Method::GET, "favicon.svg"),
                &service,
            )
            .header("origin", origin)
            .header("if-none-match", tag)
            .send()
            .await
            .unwrap();
            assert_eq!(unchanged.status(), 304);
            assert_eq!(header(&unchanged, "access-control-allow-origin"), origin);
            assert_eq!(
                image(&service, id, kind, Method::GET, "favicon.svg")
                    .header("origin", origin)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                401
            );
        }
    }
    for origin in [
        "null",
        "https://tauri.localhost",
        "http://tauri.localhost:9999",
        "tauri://evil",
        "http://evil.test",
    ] {
        let denied = query_token(
            image(&service, id, "images", Method::GET, "favicon.svg"),
            &service,
        )
        .header("origin", origin)
        .send()
        .await
        .unwrap();
        assert_eq!(denied.status(), 403, "{origin}");
    }
    let invalid = image(&service, id, "images", Method::OPTIONS, "favicon.svg")
        .header("origin", "tauri://localhost")
        .header("access-control-request-method", "GET")
        .header("access-control-request-headers", "x-private-capability")
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), 403);
    let (_plain_dir, plain, plain_project, _root) = fixture(false).await;
    assert_eq!(
        query_token(
            image(
                &plain,
                plain_project["id"].as_str().unwrap(),
                "icon",
                Method::GET,
                "favicon.svg"
            ),
            &plain
        )
        .header("origin", "tauri://localhost")
        .send()
        .await
        .unwrap()
        .status(),
        403
    );
}
