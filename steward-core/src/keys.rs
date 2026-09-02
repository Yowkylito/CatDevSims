//! API keys live in the OS keychain. Never plaintext on disk.

use keyring::Entry;

const SERVICE: &str = "steward";

#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    #[error("keychain error: {0}")]
    Keychain(String),
    #[error("no key stored for {0}")]
    Missing(String),
}

impl From<keyring::Error> for KeyError {
    fn from(e: keyring::Error) -> Self {
        KeyError::Keychain(e.to_string())
    }
}

fn entry(owner: &str) -> Result<Entry, KeyError> {
    Entry::new(SERVICE, owner).map_err(KeyError::from)
}

/// Store a secret in the OS keychain. Never writes a file.
pub fn set_secret(owner: &str, secret: &str) -> Result<(), KeyError> {
    entry(owner)?.set_password(secret)?;
    Ok(())
}

pub fn get_secret(owner: &str) -> Result<String, KeyError> {
    match entry(owner)?.get_password() {
        Ok(s) if !s.is_empty() => Ok(s),
        Ok(_) => Err(KeyError::Missing(owner.to_string())),
        Err(keyring::Error::NoEntry) => Err(KeyError::Missing(owner.to_string())),
        Err(e) => Err(KeyError::from(e)),
    }
}

pub fn delete_secret(owner: &str) -> Result<(), KeyError> {
    match entry(owner)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(KeyError::from(e)),
    }
}
