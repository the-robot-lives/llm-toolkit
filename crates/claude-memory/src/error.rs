use std::fmt;

/// Typed error with a stable code, per contract:
/// `NOT_FOUND | EXISTS | INVALID_SLUG | NO_PROJECT | IO`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    NotFound(String),
    Exists(String),
    InvalidSlug(String),
    NoProject(String),
    Io(String),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::NotFound(_) => "NOT_FOUND",
            Error::Exists(_) => "EXISTS",
            Error::InvalidSlug(_) => "INVALID_SLUG",
            Error::NoProject(_) => "NO_PROJECT",
            Error::Io(_) => "IO",
        }
    }

    pub fn detail(&self) -> &str {
        match self {
            Error::NotFound(d)
            | Error::Exists(d)
            | Error::InvalidSlug(d)
            | Error::NoProject(d)
            | Error::Io(d) => d,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.detail())
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
