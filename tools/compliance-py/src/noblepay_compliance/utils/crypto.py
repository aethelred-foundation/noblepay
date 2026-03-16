"""Cryptographic hash utilities (SHA-3, HMAC)."""

from __future__ import annotations

import hashlib
import hmac as _hmac


def sha3_256(data: str | bytes) -> str:
    """Return hex-encoded SHA3-256 digest of *data*."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha3_256(data).hexdigest()


def sha3_512(data: str | bytes) -> str:
    """Return hex-encoded SHA3-512 digest of *data*."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha3_512(data).hexdigest()


def hmac_sha256(key: str | bytes, message: str | bytes) -> str:
    """Return hex-encoded HMAC-SHA256 of *message* using *key*."""
    if isinstance(key, str):
        key = key.encode("utf-8")
    if isinstance(message, str):
        message = message.encode("utf-8")
    return _hmac.new(key, message, hashlib.sha256).hexdigest()


def hmac_sha3_256(key: str | bytes, message: str | bytes) -> str:
    """Return hex-encoded HMAC-SHA3-256 of *message* using *key*."""
    if isinstance(key, str):
        key = key.encode("utf-8")
    if isinstance(message, str):
        message = message.encode("utf-8")
    return _hmac.new(key, message, hashlib.sha3_256).hexdigest()


def hash_pii(value: str, salt: str = "") -> str:
    """One-way hash PII for storage.  Uses SHA3-256 with an optional salt."""
    return sha3_256(salt + value)
