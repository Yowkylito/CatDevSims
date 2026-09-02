//! Short briefs for Claude/ChatGPT. Never a repo dump.
//! Absolute unix/windows paths and obvious repo roots are stripped/rejected.

use crate::types::Owner;

const MAX_BRIEF_CHARS: usize = 720;

/// Detect unix or windows absolute paths / obvious repo-root dumps.
pub fn contains_repo_path(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    if text.contains("/Users/")
        || text.contains("/home/")
        || text.contains("/root/")
        || text.contains("AndroidStudioProjects")
        || text.contains("~\\")
    {
        return true;
    }
    for token in tokenize(text) {
        if is_unix_absolute(token) || is_windows_absolute(token) {
            return true;
        }
    }
    false
}

fn tokenize(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';'))
        .filter(|t| !t.is_empty())
}

fn is_unix_absolute(token: &str) -> bool {
    // /Users/x/repo, /var/repo, /opt/app, /src/foo — at least two segments.
    if !token.starts_with('/') || token.starts_with("//") {
        return false;
    }
    // Do not treat protocol-looking tokens as paths (http:// is not unix abs).
    if token.contains("://") {
        return false;
    }
    token.bytes().filter(|b| *b == b'/').count() >= 2 && token.len() > 3
}

fn is_windows_absolute(token: &str) -> bool {
    let b = token.as_bytes();
    // C:\proj or C:/proj or C:\\proj (after JSON unescape the payload is C:\proj)
    if b.len() < 3 {
        return false;
    }
    b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

pub fn strip_repo_paths(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (i, raw) in text.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        if is_unix_absolute(raw) || is_windows_absolute(raw) || raw.contains("/Users/") {
            out.push_str("[redacted-path]");
        } else {
            out.push_str(raw);
        }
    }
    out
}

/// Claude/ChatGPT get a short brief. Cursor may keep more context (still not a dump).
pub fn build_brief(owner: Owner, prompt: &str) -> String {
    let cleaned = strip_repo_paths(prompt);
    match owner {
        Owner::Claude | Owner::Chatgpt => {
            let clip: String = cleaned.chars().take(MAX_BRIEF_CHARS).collect();
            format!("Brief (no repo dump):\n{clip}")
        }
        Owner::Cursor => cleaned.chars().take(4000).collect(),
        Owner::Local => cleaned.chars().take(2000).collect(),
    }
}
