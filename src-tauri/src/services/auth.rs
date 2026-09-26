//! 本地 HTTP 鉴权（P2-1 / BUG-002 修复）：Host 校验 + Bearer 令牌比对。
//!
//! 两道闸（壳 `/rpc` 统一走中间件，未来路由自动继承）：
//!
//! 1. **Host 校验**：`Host` 必须是回环名（`127.0.0.1` / `localhost` / `[::1]`，
//!    任意端口）——防 DNS rebinding（恶意页面把自有域名解析转到 127.0.0.1，
//!    绕过浏览器同源策略直连本地服务）。
//! 2. **Bearer 令牌**：`Authorization: Bearer <token>`（或 `x-diver-token` 头）与
//!    壳启动时生成的服务令牌比对；令牌由 app 层注入（services 不依赖 core），
//!    期望令牌为空时一律拒绝（fail closed）。

use axum::http::HeaderMap;

/// 鉴权失败原因（中间件据此回 403 / 401）。
#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    /// Host 非回环名或缺失（疑似 DNS rebinding）。
    Host,
    /// 令牌缺失或不匹配。
    Token,
}

/// Host 必须是回环名（任意端口），缺失/其它一律拒绝。
pub fn host_allowed(headers: &HeaderMap) -> bool {
    headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .map(|host| {
            let h = host.trim().to_ascii_lowercase();
            // 去端口：括号 IPv6（[::1]:12331）先按 ] 断，其余按 : 断。
            let name = match h.split_once(']') {
                Some((head, _)) => format!("{head}]"),
                None => h.split(':').next().unwrap_or("").to_string(),
            };
            matches!(name.as_str(), "127.0.0.1" | "localhost" | "[::1]")
        })
        .unwrap_or(false)
}

/// Bearer 令牌比对（`Authorization: Bearer <token>` 或 `x-diver-token`）。
/// 期望令牌为空时一律拒绝（fail closed）。
pub fn token_ok(headers: &HeaderMap, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    let got = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .or_else(|| headers.get("x-diver-token").and_then(|v| v.to_str().ok()))
        .unwrap_or("");
    constant_eq(got.as_bytes(), expected.as_bytes())
}

/// 组合校验：先 Host 后令牌。
pub fn authorize(headers: &HeaderMap, expected: &str) -> Result<(), AuthError> {
    if !host_allowed(headers) {
        return Err(AuthError::Host);
    }
    if !token_ok(headers, expected) {
        return Err(AuthError::Token);
    }
    Ok(())
}

/// 恒时比较（防时序侧信道）：长度不同也走满比较。
fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        let x = *a.get(i).unwrap_or(&0);
        let y = *b.get(i).unwrap_or(&0);
        diff |= (x ^ y) as usize;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn host_must_be_loopback() {
        assert!(host_allowed(&headers(&[("host", "127.0.0.1:12331")])));
        assert!(host_allowed(&headers(&[("host", "localhost:80")])));
        assert!(host_allowed(&headers(&[("host", "[::1]:12331")])));
        assert!(host_allowed(&headers(&[("host", "LOCALHOST")])));
        assert!(!host_allowed(&headers(&[("host", "evil.example.com")])));
        assert!(!host_allowed(&headers(&[("host", "127.0.0.1.evil.example")])));
        assert!(!host_allowed(&headers(&[("host", "192.168.1.10:80")])));
        assert!(!host_allowed(&headers(&[])));
    }

    #[test]
    fn token_requires_exact_bearer() {
        assert!(token_ok(
            &headers(&[("authorization", "Bearer abc123")]),
            "abc123"
        ));
        assert!(token_ok(&headers(&[("x-diver-token", "abc123")]), "abc123"));
        assert!(!token_ok(&headers(&[("authorization", "Bearer wrong")]), "abc123"));
        assert!(!token_ok(&headers(&[("authorization", "abc123")]), "abc123"));
        assert!(!token_ok(&headers(&[]), "abc123"));
        // fail closed：期望令牌为空时任何值都不过。
        assert!(!token_ok(&headers(&[("authorization", "Bearer ")]), ""));
    }

    #[test]
    fn authorize_checks_host_first() {
        let ok = headers(&[("host", "127.0.0.1:1"), ("authorization", "Bearer t")]);
        assert_eq!(authorize(&ok, "t"), Ok(()));
        let bad_host = headers(&[("host", "evil.example"), ("authorization", "Bearer t")]);
        assert_eq!(authorize(&bad_host, "t"), Err(AuthError::Host));
        let bad_token = headers(&[("host", "127.0.0.1:1")]);
        assert_eq!(authorize(&bad_token, "t"), Err(AuthError::Token));
    }
}
