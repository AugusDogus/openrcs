package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/crypto"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/util"
)

func generate(outDir string) error {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	steps := []struct {
		file string
		fn   func() (any, error)
	}{
		{"crypto-aes-ctr.json", genAesCtr},
		{"crypto-aes-gcm.json", genAesGcm},
		{"crypto-jwk.json", genJwk},
		{"crypto-emoji.json", genEmoji},
		{"crypto-ukey2.json", genUkey2},
		{"crypto-sapisid.json", genSapisid},
	}
	for _, s := range steps {
		v, err := s.fn()
		if err != nil {
			return fmt.Errorf("%s: %w", s.file, err)
		}
		if err := writeJSON(filepath.Join(outDir, s.file), v); err != nil {
			return err
		}
		fmt.Println("wrote", filepath.Join(outDir, s.file))
	}
	return nil
}

func writeJSON(path string, v any) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

// ---- AES-CTR ----

type aesCase struct {
	Plaintext  string `json:"plaintext"`
	Ciphertext string `json:"ciphertext"`
}

type aesRejected struct {
	Name    string `json:"name"`
	Input   string `json:"input"`
	GoError string `json:"goError"`
}

type aesFixture struct {
	AesKey   string        `json:"aesKey"`
	HmacKey  string        `json:"hmacKey"`
	Cases    []aesCase     `json:"cases"`
	Rejected []aesRejected `json:"rejected"`
}

func genAesCtr() (any, error) {
	helper := &crypto.AESCTRHelper{AESKey: seeded("aes-ctr/aes-key", 32), HMACKey: seeded("aes-ctr/hmac-key", 32)}
	fx := aesFixture{AesKey: hex.EncodeToString(helper.AESKey), HmacKey: hex.EncodeToString(helper.HMACKey)}
	var ciphertexts [][]byte
	for _, n := range []int{0, 1, 15, 16, 17, 31, 32, 33, 100, 1024} {
		pt := seeded(fmt.Sprintf("aes-ctr/plaintext/%d", n), n)
		ct, err := helper.Encrypt(pt)
		if err != nil {
			return nil, err
		}
		ciphertexts = append(ciphertexts, ct)
		fx.Cases = append(fx.Cases, aesCase{Plaintext: hex.EncodeToString(pt), Ciphertext: hex.EncodeToString(ct)})
		// Decrypt works in place, so give it a copy.
		back, err := helper.Decrypt(bytes.Clone(ct))
		if err != nil || !bytes.Equal(back, pt) {
			return nil, fmt.Errorf("go round trip failed for %d bytes: %v", n, err)
		}
	}
	flip := func(b []byte, i int) []byte {
		out := bytes.Clone(b)
		out[i] ^= 0x01
		return out
	}
	empty := ciphertexts[0]  // 48 bytes: iv || mac
	longer := ciphertexts[4] // 17-byte plaintext
	rejected := []struct {
		name  string
		input []byte
	}{
		{"empty input", nil},
		{"47 bytes", empty[:47]},
		{"flipped ciphertext byte", flip(longer, 0)},
		{"flipped iv byte", flip(longer, len(longer)-48)},
		{"flipped hmac byte", flip(longer, len(longer)-1)},
		{"truncated hmac", longer[:len(longer)-1]},
	}
	for _, r := range rejected {
		_, err := helper.Decrypt(bytes.Clone(r.input))
		if err == nil {
			return nil, fmt.Errorf("go accepted rejected case %q", r.name)
		}
		fx.Rejected = append(fx.Rejected, aesRejected{Name: r.name, Input: hex.EncodeToString(r.input), GoError: err.Error()})
	}
	return fx, nil
}

// ---- AES-GCM (media) ----

type gcmCase struct {
	// Plaintext is seeded("aes-gcm/plaintext/<size>", size); only its hash is stored.
	Size            int    `json:"size"`
	PlaintextSha256 string `json:"plaintextSha256"`
	Ciphertext      string `json:"ciphertext"`
}

type gcmFixture struct {
	Key   string    `json:"key"`
	Cases []gcmCase `json:"cases"`
}

func genAesGcm() (any, error) {
	key := seeded("aes-gcm/key", 32)
	helper, err := crypto.NewAESGCMHelper(key)
	if err != nil {
		return nil, err
	}
	fx := gcmFixture{Key: hex.EncodeToString(key)}
	// 32740 bytes fill exactly one 32 KiB chunk; 32741 spill into a second.
	for _, n := range []int{1, 100, 32740, 32741} {
		pt := seeded(fmt.Sprintf("aes-gcm/plaintext/%d", n), n)
		ct, err := helper.EncryptData(pt)
		if err != nil {
			return nil, err
		}
		back, err := helper.DecryptData(bytes.Clone(ct))
		if err != nil || !bytes.Equal(back, pt) {
			return nil, fmt.Errorf("go round trip failed for %d bytes: %v", n, err)
		}
		sum := sha256.Sum256(pt)
		fx.Cases = append(fx.Cases, gcmCase{
			Size:            n,
			PlaintextSha256: hex.EncodeToString(sum[:]),
			Ciphertext:      base64.StdEncoding.EncodeToString(ct),
		})
	}
	return fx, nil
}

// ---- JWK / ECDSA ----

type jwkSignature struct {
	RequestID       string `json:"requestId"`
	TimestampMicros string `json:"timestampMicros"`
	Signature       string `json:"signature"`
}

type jwkCase struct {
	Name string `json:"name"`
	// JSON exactly as libgm stores AuthData.RefreshKey (big.Int.Bytes() widths).
	JwkJSON    string         `json:"jwkJson"`
	D          string         `json:"d"`
	X          string         `json:"x"`
	Y          string         `json:"y"`
	Spki       string         `json:"spki"`
	Signatures []jwkSignature `json:"signatures"`
}

type jwkFixture struct {
	Cases []jwkCase `json:"cases"`
}

func genJwk() (any, error) {
	keys := []struct {
		name   string
		accept func(p256Key) bool
	}{
		{"plain", nil},
		{"d with leading zero byte", func(k p256Key) bool { return k.D[0] == 0 }},
		{"x with leading zero byte", func(k p256Key) bool { return k.X[0] == 0 }},
		{"y with leading zero byte", func(k p256Key) bool { return k.Y[0] == 0 }},
	}
	var fx jwkFixture
	for i, kd := range keys {
		k := seededKey(fmt.Sprintf("jwk/%d", i), kd.accept)
		jwk := k.jwk()
		jwkJSON, err := json.Marshal(jwk)
		if err != nil {
			return nil, err
		}
		spki, err := x509.MarshalPKIXPublicKey(jwk.GetPublicKey())
		if err != nil {
			return nil, err
		}
		c := jwkCase{
			Name:    kd.name,
			JwkJSON: string(jwkJSON),
			D:       hex.EncodeToString(k.D),
			X:       hex.EncodeToString(k.X),
			Y:       hex.EncodeToString(k.Y),
			Spki:    hex.EncodeToString(spki),
		}
		for j, ts := range []int64{1730000000000000, 1762435200123000, 1} {
			requestID := uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("jwk/%d/%d", i, j))).String()
			// Same as libgm (*Client).refreshAuthToken.
			signBytes := sha256.Sum256([]byte(fmt.Sprintf("%s:%d", requestID, ts)))
			sig, err := ecdsa.SignASN1(rand.Reader, jwk.GetPrivateKey(), signBytes[:])
			if err != nil {
				return nil, err
			}
			c.Signatures = append(c.Signatures, jwkSignature{
				RequestID:       requestID,
				TimestampMicros: strconv.FormatInt(ts, 10),
				Signature:       hex.EncodeToString(sig),
			})
		}
		fx.Cases = append(fx.Cases, c)
	}
	return fx, nil
}

// ---- Emoji ----

func genEmoji() (any, error) {
	return map[string][]string{"v0": pairingEmojisV0, "v1": pairingEmojisV1}, nil
}

// ---- SAPISIDHASH ----

type sapisidCase struct {
	Origin  string `json:"origin"`
	Sapisid string `json:"sapisid"`
	Unix    int64  `json:"unixSeconds"`
	Hash    string `json:"hash"`
}

func genSapisid() (any, error) {
	inputs := []struct{ origin, sapisid string }{
		{util.MessagesBaseURL, "fakeSapisidValue/AbCdEfGh-ij_KL"},
		{util.MessagesBaseURL, ""},
		{"https://example.test", "ünïcödé value with spaces"},
	}
	var out []sapisidCase
	for _, in := range inputs {
		// libgm reads time.Now() itself; recover the timestamp it used from the output.
		h := libgm.SAPISIDHash(in.origin, in.sapisid)
		rest, ok := strings.CutPrefix(h, "SAPISIDHASH ")
		tsStr, _, ok2 := strings.Cut(rest, "_")
		if !ok || !ok2 {
			return nil, fmt.Errorf("unexpected SAPISIDHash format %q", h)
		}
		ts, err := strconv.ParseInt(tsStr, 10, 64)
		if err != nil {
			return nil, err
		}
		out = append(out, sapisidCase{Origin: in.origin, Sapisid: in.sapisid, Unix: ts, Hash: h})
	}
	return map[string]any{"cases": out}, nil
}

// ---- UKEY2 / Gaia pairing ----

type ukeyClient struct {
	PrivateKey    string `json:"privateKey"`
	Random        string `json:"random"`
	InitPayload   string `json:"initPayload"`
	FinishPayload string `json:"finishPayload"`
}

type ukeyServerInit struct {
	Name                    string `json:"name"`
	Client                  int    `json:"client"`
	Container               string `json:"container"`
	VerificationCodeVersion int32  `json:"verificationCodeVersion"`
	KeyDerivationVersion    int32  `json:"keyDerivationVersion"`
	Emoji                   string `json:"emoji"`
	NextKey                 string `json:"nextKey"`
	AesKey                  string `json:"aesKey"`
	HmacKey                 string `json:"hmacKey"`
}

type ukeyRejected struct {
	Name      string `json:"name"`
	Client    int    `json:"client"`
	Container string `json:"container"`
	GoError   string `json:"goError"`
}

type byteHashCase struct {
	Input string `json:"input"`
	Hash  int32  `json:"hash"`
}

type ukeyFixture struct {
	EncryptionKeyInfo  string           `json:"encryptionKeyInfo"`
	Clients            []ukeyClient     `json:"clients"`
	ServerInits        []ukeyServerInit `json:"serverInits"`
	RejectedServerInit []ukeyRejected   `json:"rejectedServerInits"`
	ByteHash           []byteHashCase   `json:"byteHash"`
}

// serverInitSpec describes one synthetic Ukey2ServerInit. Zero-valued
// overrides mean "use the well-formed default".
type serverInitSpec struct {
	key                     p256Key
	random                  []byte
	version                 int32
	cipher                  gmproto.Ukey2HandshakeCipher
	x, y                    []byte // encoded coordinates; nil means 0x00 || 32-byte
	noPublicKey             bool
	messageType             gmproto.Ukey2Message_Type
	rawServerInit           []byte // replaces the marshaled Ukey2ServerInit
	rawData                 []byte // replaces the whole Ukey2Message
	verificationCodeVersion int32
	keyDerivationVersion    int32
}

func prefixed(b []byte) []byte { return append([]byte{0}, b...) }

func (s serverInitSpec) container(sessionUUID string) ([]byte, *gmproto.GaiaPairingResponseContainer, error) {
	data := s.rawData
	if data == nil {
		payload := s.rawServerInit
		if payload == nil {
			x, y := s.x, s.y
			if x == nil {
				x = prefixed(s.key.X)
			}
			if y == nil {
				y = prefixed(s.key.Y)
			}
			si := &gmproto.Ukey2ServerInit{
				Version:         s.version,
				Random:          s.random,
				HandshakeCipher: s.cipher,
			}
			if !s.noPublicKey {
				si.PublicKey = &gmproto.GenericPublicKey{
					Type: gmproto.PublicKeyType_EC_P256,
					PublicKey: &gmproto.GenericPublicKey_EcP256PublicKey{
						EcP256PublicKey: &gmproto.EcP256PublicKey{X: x, Y: y},
					},
				}
			}
			var err error
			if payload, err = proto.Marshal(si); err != nil {
				return nil, nil, err
			}
		}
		var err error
		data, err = proto.Marshal(&gmproto.Ukey2Message{MessageType: s.messageType, MessageData: payload})
		if err != nil {
			return nil, nil, err
		}
	}
	msg := &gmproto.GaiaPairingResponseContainer{
		UnknownInt3:                      1,
		SessionUUID:                      sessionUUID,
		Data:                             data,
		ConfirmedVerificationCodeVersion: s.verificationCodeVersion,
		ConfirmedKeyDerivationVersion:    s.keyDerivationVersion,
	}
	raw, err := proto.Marshal(msg)
	return raw, msg, err
}

func wellFormed(label string, vcv, kdv int32) serverInitSpec {
	return serverInitSpec{
		key:                     seededKey("ukey2/server/"+label, nil),
		random:                  seeded("ukey2/server-random/"+label, 32),
		version:                 1,
		cipher:                  gmproto.Ukey2HandshakeCipher_P256_SHA512,
		messageType:             gmproto.Ukey2Message_SERVER_INIT,
		verificationCodeVersion: vcv,
		keyDerivationVersion:    kdv,
	}
}

const clientCount = 4

func genUkey2() (any, error) {
	fx := ukeyFixture{EncryptionKeyInfo: hex.EncodeToString(encryptionKeyInfo)}

	sessions := make([]*libgm.PairingSession, clientCount)
	for i := range sessions {
		k := seededKey(fmt.Sprintf("ukey2/client/%d", i), nil)
		ps := &libgm.PairingSession{
			UUID:          uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("ukey2/session/%d", i))),
			Start:         time.UnixMilli(1762435200000),
			PairingKeyDSA: k.ecdsa(),
		}
		// libgm's PreparePayloads draws Random from random.Bytes(32); we record the
		// value it picked (parsed back out of InitPayload) rather than replacing it.
		init, finish, err := ps.PreparePayloads()
		if err != nil {
			return nil, err
		}
		random, err := clientInitRandom(init)
		if err != nil {
			return nil, err
		}
		sessions[i] = ps
		fx.Clients = append(fx.Clients, ukeyClient{
			PrivateKey:    hex.EncodeToString(k.D),
			Random:        hex.EncodeToString(random),
			InitPayload:   hex.EncodeToString(init),
			FinishPayload: hex.EncodeToString(finish),
		})
	}

	type named struct {
		name string
		spec serverInitSpec
	}
	var accepted []named
	for _, vcv := range []int32{0, 1} {
		for _, kdv := range []int32{0, 1} {
			for i := 0; i < 64; i++ {
				label := fmt.Sprintf("vcv%d/kdv%d/%d", vcv, kdv, i)
				accepted = append(accepted, named{label, wellFormed(label, vcv, kdv)})
			}
		}
	}
	// Coordinate encodings other than the canonical 0x00 || 32 bytes.
	unprefixed := wellFormed("coords/32-byte", 1, 1)
	unprefixed.x, unprefixed.y = unprefixed.key.X, unprefixed.key.Y
	doubleZero := wellFormed("coords/34-byte", 0, 1)
	doubleZero.x, doubleZero.y = append([]byte{0, 0}, doubleZero.key.X...), append([]byte{0, 0}, doubleZero.key.Y...)
	minimal := wellFormed("coords/minimal", 1, 0)
	minimal.key = seededKey("ukey2/server/coords/minimal", func(k p256Key) bool { return k.X[0] == 0 })
	minimal.x, minimal.y = minimal.key.X[1:], minimal.key.Y
	accepted = append(accepted,
		named{"coords: unprefixed 32-byte x and y", unprefixed},
		named{"coords: 34-byte x and y with two leading zeros", doubleZero},
		named{"coords: 31-byte minimal x, 32-byte y", minimal},
	)

	coverage := map[int32]map[string]bool{0: {}, 1: {}}
	for i, a := range accepted {
		clientIdx := i % clientCount
		ps := sessions[clientIdx]
		raw, msg, err := a.spec.container(fmt.Sprintf("server-session-%d", i))
		if err != nil {
			return nil, err
		}
		emoji, err := ps.ProcessServerInit(msg)
		if err != nil {
			return nil, fmt.Errorf("libgm rejected %q: %w", a.name, err)
		}
		derived, err := deriveRequestCrypto(ps.NextKey, msg.GetConfirmedKeyDerivationVersion())
		if err != nil {
			return nil, err
		}
		coverage[msg.GetConfirmedVerificationCodeVersion()][emoji] = true
		fx.ServerInits = append(fx.ServerInits, ukeyServerInit{
			Name:                    a.name,
			Client:                  clientIdx,
			Container:               hex.EncodeToString(raw),
			VerificationCodeVersion: msg.GetConfirmedVerificationCodeVersion(),
			KeyDerivationVersion:    msg.GetConfirmedKeyDerivationVersion(),
			Emoji:                   emoji,
			NextKey:                 hex.EncodeToString(ps.NextKey),
			AesKey:                  hex.EncodeToString(derived.AESKey),
			HmacKey:                 hex.EncodeToString(derived.HMACKey),
		})
	}
	fmt.Printf("ukey2: %d accepted server inits, distinct emoji v0=%d/%d v1=%d/%d\n",
		len(fx.ServerInits), len(coverage[0]), len(pairingEmojisV0), len(coverage[1]), len(pairingEmojisV1))

	truncated := []byte{0x12, 0x05, 0x01} // field 2, length 5, only one byte present
	rejected := []named{}
	add := func(name string, mutate func(*serverInitSpec)) {
		s := wellFormed("rejected/"+name, 1, 1)
		mutate(&s)
		rejected = append(rejected, named{name, s})
	}
	add("data is not a Ukey2Message", func(s *serverInitSpec) { s.rawData = truncated })
	add("message type CLIENT_INIT", func(s *serverInitSpec) { s.messageType = gmproto.Ukey2Message_CLIENT_INIT })
	add("message type unset", func(s *serverInitSpec) { s.messageType = gmproto.Ukey2Message_UNKNOWN_DO_NOT_USE })
	add("payload is not a Ukey2ServerInit", func(s *serverInitSpec) { s.rawServerInit = truncated })
	add("version 0", func(s *serverInitSpec) { s.version = 0 })
	add("version 2", func(s *serverInitSpec) { s.version = 2 })
	add("cipher CURVE25519_SHA512", func(s *serverInitSpec) { s.cipher = gmproto.Ukey2HandshakeCipher_CURVE25519_SHA512 })
	add("cipher unset", func(s *serverInitSpec) { s.cipher = gmproto.Ukey2HandshakeCipher_RESERVED })
	add("random 31 bytes", func(s *serverInitSpec) { s.random = s.random[:31] })
	add("random 33 bytes", func(s *serverInitSpec) { s.random = append(s.random, 7) })
	add("x prefix 1", func(s *serverInitSpec) { s.x = append([]byte{1}, s.key.X...) })
	add("y prefix 0xff", func(s *serverInitSpec) { s.y = append([]byte{0xff}, s.key.Y...) })
	add("point not on curve", func(s *serverInitSpec) {
		y := prefixed(s.key.Y)
		y[32] ^= 1
		s.y = y
	})
	add("x overflows 256 bits", func(s *serverInitSpec) { s.x = append([]byte{1, 0}, s.key.X...) })
	// libgm checks both prefixes before validating either coordinate's value.
	add("x overflows 256 bits and y prefix 1", func(s *serverInitSpec) {
		s.x = append([]byte{1, 0}, s.key.X...)
		s.y = append([]byte{1}, s.key.Y...)
	})
	add("no public key", func(s *serverInitSpec) { s.noPublicKey = true })
	add("verification code version 2", func(s *serverInitSpec) { s.verificationCodeVersion = 2 })
	add("verification code version -1", func(s *serverInitSpec) { s.verificationCodeVersion = -1 })
	for i, r := range rejected {
		clientIdx := i % clientCount
		raw, msg, err := r.spec.container(fmt.Sprintf("rejected-session-%d", i))
		if err != nil {
			return nil, err
		}
		_, err = sessions[clientIdx].ProcessServerInit(msg)
		if err == nil {
			return nil, fmt.Errorf("libgm accepted rejected case %q", r.name)
		}
		fx.RejectedServerInit = append(fx.RejectedServerInit, ukeyRejected{
			Name: r.name, Client: clientIdx, Container: hex.EncodeToString(raw), GoError: err.Error(),
		})
	}

	hashInputs := [][]byte{{}, {0x00}, {0x7f}, {0x80}, {0xff}, bytes.Repeat([]byte{0xff}, 32), bytes.Repeat([]byte{0x80}, 32)}
	for i := 0; i < 16; i++ {
		hashInputs = append(hashInputs, seeded(fmt.Sprintf("byte-hash/%d", i), 32))
	}
	for _, in := range hashInputs {
		fx.ByteHash = append(fx.ByteHash, byteHashCase{Input: hex.EncodeToString(in), Hash: byteHash(in)})
	}
	return fx, nil
}

func clientInitRandom(init []byte) ([]byte, error) {
	var msg gmproto.Ukey2Message
	if err := proto.Unmarshal(init, &msg); err != nil {
		return nil, err
	}
	var ci gmproto.Ukey2ClientInit
	if err := proto.Unmarshal(msg.GetMessageData(), &ci); err != nil {
		return nil, err
	}
	if len(ci.GetRandom()) != 32 {
		return nil, errors.New("client init random is not 32 bytes")
	}
	return ci.GetRandom(), nil
}
