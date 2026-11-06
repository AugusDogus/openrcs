package main

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"fmt"
	"math/big"
	_ "unsafe" // for go:linkname

	"go.mau.fi/mautrix-gmessages/pkg/libgm/crypto"
)

// Unexported libgm internals, pulled in so the fixtures come from libgm's own
// tables and helpers rather than a copy of them. (gen.go imports libgm, which
// links the package these names resolve into.)

//go:linkname pairingEmojisV0 go.mau.fi/mautrix-gmessages/pkg/libgm.pairingEmojisV0
var pairingEmojisV0 []string

//go:linkname pairingEmojisV1 go.mau.fi/mautrix-gmessages/pkg/libgm.pairingEmojisV1
var pairingEmojisV1 []string

//go:linkname encryptionKeyInfo go.mau.fi/mautrix-gmessages/pkg/libgm.encryptionKeyInfo
var encryptionKeyInfo []byte

//go:linkname doHKDF go.mau.fi/mautrix-gmessages/pkg/libgm.doHKDF
func doHKDF(key, salt, info []byte) []byte

//go:linkname byteHash go.mau.fi/mautrix-gmessages/pkg/libgm.byteHash
func byteHash(bytes []byte) int32

// deriveRequestCrypto is the key-derivation block of libgm's
// (*Client).FinishGaiaPairing, verbatim apart from writing into a fresh helper
// instead of c.AuthData.RequestCrypto. doHKDF, byteHash and encryptionKeyInfo
// are libgm's own (linknamed above).
func deriveRequestCrypto(nextKey []byte, keyDerivationVersion int32) (*crypto.AESCTRHelper, error) {
	out := &crypto.AESCTRHelper{}
	ukey2ClientKey := doHKDF(nextKey, encryptionKeyInfo, []byte("client"))
	ukey2ServerKey := doHKDF(nextKey, encryptionKeyInfo, []byte("server"))
	switch keyDerivationVersion {
	case 0:
		out.AESKey = ukey2ClientKey
		out.HMACKey = ukey2ServerKey
	case 1:
		concattedUkeys := make([]byte, 3*32)
		copy(concattedUkeys[0:32], encryptionKeyInfo)
		if byteHash(ukey2ClientKey) < byteHash(ukey2ServerKey) {
			copy(concattedUkeys[32:64], ukey2ClientKey)
			copy(concattedUkeys[64:96], ukey2ServerKey)
		} else {
			copy(concattedUkeys[32:64], ukey2ServerKey)
			copy(concattedUkeys[64:96], ukey2ClientKey)
		}
		concattedHash := sha256.Sum256(concattedUkeys)
		out.AESKey = doHKDF(concattedHash[:], []byte("Ditto salt 1"), []byte("Ditto info 1"))
		out.HMACKey = doHKDF(concattedHash[:], []byte("Ditto salt 2"), []byte("Ditto info 2"))
	default:
		return nil, fmt.Errorf("unsupported key derivation version %d", keyDerivationVersion)
	}
	return out, nil
}

// seeded returns n deterministic bytes for label (SHA-256 counter stream).
func seeded(label string, n int) []byte {
	out := make([]byte, 0, n+32)
	for i := 0; len(out) < n; i++ {
		h := sha256.Sum256([]byte(fmt.Sprintf("openrcs/crypto/%s#%d", label, i)))
		out = append(out, h[:]...)
	}
	return out[:n]
}

// p256Key is a deterministic P-256 key with fixed-width (32-byte) encodings.
type p256Key struct {
	D, X, Y []byte
}

func (k p256Key) ecdsa() *ecdsa.PrivateKey {
	return &ecdsa.PrivateKey{
		PublicKey: ecdsa.PublicKey{
			Curve: elliptic.P256(),
			X:     new(big.Int).SetBytes(k.X),
			Y:     new(big.Int).SetBytes(k.Y),
		},
		D: new(big.Int).SetBytes(k.D),
	}
}

// jwk builds a libgm JWK the way crypto.GenerateECDSAKey does (big.Int.Bytes(),
// so leading zero bytes are dropped).
func (k p256Key) jwk() *crypto.JWK {
	return &crypto.JWK{
		KeyType: "EC",
		Curve:   "P-256",
		D:       new(big.Int).SetBytes(k.D).Bytes(),
		X:       new(big.Int).SetBytes(k.X).Bytes(),
		Y:       new(big.Int).SetBytes(k.Y).Bytes(),
	}
}

func keyFromScalar(d []byte) (p256Key, error) {
	priv, err := ecdh.P256().NewPrivateKey(d)
	if err != nil {
		return p256Key{}, err
	}
	pub := priv.PublicKey().Bytes() // 0x04 || X || Y
	return p256Key{D: d, X: pub[1:33], Y: pub[33:65]}, nil
}

// seededKey returns the first valid P-256 key derived from label whose
// encoding satisfies accept (nil accepts any).
func seededKey(label string, accept func(p256Key) bool) p256Key {
	for c := 0; ; c++ {
		k, err := keyFromScalar(seeded(fmt.Sprintf("%s/%d", label, c), 32))
		if err != nil {
			continue
		}
		if accept == nil || accept(k) {
			return k
		}
	}
}
