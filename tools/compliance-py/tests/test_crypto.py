"""Tests for cryptographic hash utilities."""

from __future__ import annotations

import pytest

from noblepay_compliance.utils.crypto import (
    hash_pii,
    hmac_sha256,
    hmac_sha3_256,
    sha3_256,
    sha3_512,
)


class TestSHA3:
    def test_sha3_256_str(self):
        digest = sha3_256("hello")
        assert isinstance(digest, str)
        assert len(digest) == 64  # 256 bits = 64 hex chars

    def test_sha3_256_bytes(self):
        digest = sha3_256(b"hello")
        assert digest == sha3_256("hello")

    def test_sha3_256_deterministic(self):
        assert sha3_256("test") == sha3_256("test")

    def test_sha3_256_different_inputs(self):
        assert sha3_256("a") != sha3_256("b")

    def test_sha3_512_str(self):
        digest = sha3_512("hello")
        assert len(digest) == 128  # 512 bits = 128 hex chars

    def test_sha3_512_bytes(self):
        digest = sha3_512(b"hello")
        assert digest == sha3_512("hello")

    def test_sha3_512_deterministic(self):
        assert sha3_512("test") == sha3_512("test")

    def test_sha3_512_different_inputs(self):
        assert sha3_512("a") != sha3_512("b")


class TestHMAC:
    def test_hmac_sha256(self):
        mac = hmac_sha256("key", "message")
        assert isinstance(mac, str)
        assert len(mac) == 64

    def test_hmac_sha256_deterministic(self):
        assert hmac_sha256("k", "m") == hmac_sha256("k", "m")

    def test_hmac_sha256_different_keys(self):
        assert hmac_sha256("key1", "msg") != hmac_sha256("key2", "msg")

    def test_hmac_sha256_bytes(self):
        mac1 = hmac_sha256(b"key", b"message")
        mac2 = hmac_sha256("key", "message")
        assert mac1 == mac2

    def test_hmac_sha3_256(self):
        mac = hmac_sha3_256("key", "message")
        assert isinstance(mac, str)
        assert len(mac) == 64

    def test_hmac_sha3_256_bytes(self):
        mac1 = hmac_sha3_256(b"key", b"message")
        mac2 = hmac_sha3_256("key", "message")
        assert mac1 == mac2


class TestHashPII:
    def test_hash_pii(self):
        h = hash_pii("john@example.com")
        assert isinstance(h, str)
        assert len(h) == 64

    def test_hash_pii_with_salt(self):
        h1 = hash_pii("john@example.com", salt="salt1")
        h2 = hash_pii("john@example.com", salt="salt2")
        assert h1 != h2

    def test_hash_pii_deterministic(self):
        assert hash_pii("data", "s") == hash_pii("data", "s")
