package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	"google.golang.org/protobuf/proto"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/crypto"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

// tsOutputs is what tools/vectors/crypto/emit-ts-outputs.ts writes.
type tsOutputs struct {
	Jwk []struct {
		JwkJSON         string `json:"jwkJson"`
		Spki            string `json:"spki"`
		RequestID       string `json:"requestId"`
		TimestampMicros string `json:"timestampMicros"`
		Signature       string `json:"signature"`
	} `json:"jwk"`
	AesCtr struct {
		AesKey  string `json:"aesKey"`
		HmacKey string `json:"hmacKey"`
		Cases   []struct {
			Plaintext  string `json:"plaintext"`
			Ciphertext string `json:"ciphertext"`
		} `json:"cases"`
	} `json:"aesCtr"`
	Ukey2 []struct {
		PrivateKey    string `json:"privateKey"`
		Random        string `json:"random"`
		InitPayload   string `json:"initPayload"`
		FinishPayload string `json:"finishPayload"`
	} `json:"ukey2"`
}

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(fmt.Errorf("bad hex %q: %w", s, err))
	}
	return b
}

func verify(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var in tsOutputs
	if err := json.Unmarshal(raw, &in); err != nil {
		return err
	}
	if len(in.Jwk) == 0 || len(in.AesCtr.Cases) == 0 || len(in.Ukey2) == 0 {
		return fmt.Errorf("input has no jwk, aesCtr or ukey2 cases")
	}

	for i, c := range in.Jwk {
		var jwk crypto.JWK
		if err := json.Unmarshal([]byte(c.JwkJSON), &jwk); err != nil {
			return fmt.Errorf("jwk %d: libgm could not load TS JWK JSON: %w", i, err)
		}
		spki, err := x509.MarshalPKIXPublicKey(jwk.GetPublicKey())
		if err != nil {
			return fmt.Errorf("jwk %d: %w", i, err)
		}
		if !bytes.Equal(spki, mustHex(c.Spki)) {
			return fmt.Errorf("jwk %d: SPKI mismatch", i)
		}
		ts, err := strconv.ParseInt(c.TimestampMicros, 10, 64)
		if err != nil {
			return fmt.Errorf("jwk %d: %w", i, err)
		}
		digest := sha256.Sum256([]byte(fmt.Sprintf("%s:%d", c.RequestID, ts)))
		if !ecdsa.VerifyASN1(jwk.GetPublicKey(), digest[:], mustHex(c.Signature)) {
			return fmt.Errorf("jwk %d: Go rejected TS signature", i)
		}
	}
	fmt.Printf("jwk: %d TS keys loaded by libgm, SPKI equal, signatures verified\n", len(in.Jwk))

	helper := &crypto.AESCTRHelper{AESKey: mustHex(in.AesCtr.AesKey), HMACKey: mustHex(in.AesCtr.HmacKey)}
	for i, c := range in.AesCtr.Cases {
		pt, err := helper.Decrypt(mustHex(c.Ciphertext))
		if err != nil {
			return fmt.Errorf("aes %d: libgm rejected TS ciphertext: %w", i, err)
		}
		if !bytes.Equal(pt, mustHex(c.Plaintext)) {
			return fmt.Errorf("aes %d: plaintext mismatch", i)
		}
	}
	fmt.Printf("aes-ctr: %d TS ciphertexts decrypted by libgm\n", len(in.AesCtr.Cases))

	for i, c := range in.Ukey2 {
		k, err := keyFromScalar(mustHex(c.PrivateKey))
		if err != nil {
			return fmt.Errorf("ukey2 %d: %w", i, err)
		}
		ps := &libgm.PairingSession{PairingKeyDSA: k.ecdsa()}
		goInit, goFinish, err := ps.PreparePayloads()
		if err != nil {
			return fmt.Errorf("ukey2 %d: %w", i, err)
		}
		if !bytes.Equal(goFinish, mustHex(c.FinishPayload)) {
			return fmt.Errorf("ukey2 %d: finish payload differs from libgm", i)
		}
		// libgm picked its own random; swap in the TS one and re-marshal.
		var msg gmproto.Ukey2Message
		var ci gmproto.Ukey2ClientInit
		if err := proto.Unmarshal(goInit, &msg); err != nil {
			return err
		}
		if err := proto.Unmarshal(msg.GetMessageData(), &ci); err != nil {
			return err
		}
		ci.Random = mustHex(c.Random)
		if msg.MessageData, err = proto.Marshal(&ci); err != nil {
			return err
		}
		want, err := proto.Marshal(&msg)
		if err != nil {
			return err
		}
		if !bytes.Equal(want, mustHex(c.InitPayload)) {
			return fmt.Errorf("ukey2 %d: init payload differs from libgm", i)
		}
	}
	fmt.Printf("ukey2: %d TS sessions produce libgm-identical init/finish payloads\n", len(in.Ukey2))
	return nil
}
