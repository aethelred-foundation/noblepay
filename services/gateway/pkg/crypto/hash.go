package crypto

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

// SHA256Hex returns the hex-encoded SHA-256 hash of data.
func SHA256Hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

// HMACSHA256Hex returns the hex-encoded HMAC-SHA256 of data using the given key.
func HMACSHA256Hex(key, data []byte) string {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyHMAC checks whether the provided HMAC hex string matches the expected HMAC of data.
func VerifyHMAC(key, data []byte, expectedHex string) bool {
	actual := HMACSHA256Hex(key, data)
	return hmac.Equal([]byte(actual), []byte(expectedHex))
}
