package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"time"
	"unsafe"

	"go.mau.fi/util/pblite"
	"google.golang.org/protobuf/proto"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/crypto"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

// capture is one HTTP request libgm made, recorded at the RoundTripper.
type capture struct {
	Path   string
	URL    string
	Header http.Header
	Body   []byte
}

// fakeTransport records every request and answers it with a canned response,
// so libgm's real request-building code paths run unmodified.
type fakeTransport struct {
	mu       sync.Mutex
	captures []capture
	pollMode string // "401" or "open"
	answers  map[string]func(req *http.Request) *http.Response
}

func (t *fakeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var body []byte
	if req.Body != nil {
		body, _ = io.ReadAll(req.Body)
	}
	path := req.URL.Path[strings.LastIndex(req.URL.Path, "/")+1:]
	header := req.Header.Clone()
	t.mu.Lock()
	t.captures = append(t.captures, capture{Path: path, URL: req.URL.String(), Header: header, Body: body})
	mode := t.pollMode
	answer := t.answers[path]
	t.mu.Unlock()
	if path == "ReceiveMessages" {
		if mode == "open" {
			pr, pw := io.Pipe()
			go func() { _, _ = pw.Write([]byte("[[")) }() // then block forever
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {libgm.ContentTypePBLite}}, Body: pr, Request: req}, nil
		}
		return &http.Response{StatusCode: 401, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
	}
	if answer != nil {
		return answer(req), nil
	}
	return pbliteResp(req, &gmproto.OutgoingRPCResponse{}), nil
}

// last returns the newest capture for path, waiting up to 5 s for it to appear
// after `after` captures existed.
func (t *fakeTransport) waitNew(path string, after int) (capture, error) {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		t.mu.Lock()
		for i := after; i < len(t.captures); i++ {
			if t.captures[i].Path == path {
				c := t.captures[i]
				t.mu.Unlock()
				return c, nil
			}
		}
		t.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	return capture{}, fmt.Errorf("no %s request captured", path)
}

func (t *fakeTransport) count() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.captures)
}

func (t *fakeTransport) all(path string, after int) []capture {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []capture
	for i := after; i < len(t.captures); i++ {
		if t.captures[i].Path == path {
			out = append(out, t.captures[i])
		}
	}
	return out
}

func pbliteResp(req *http.Request, msg proto.Message) *http.Response {
	b, err := pblite.Marshal(msg)
	if err != nil {
		panic(err)
	}
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {libgm.ContentTypePBLite}}, Body: io.NopCloser(bytes.NewReader(b)), Request: req}
}

func binaryResp(req *http.Request, msg proto.Message) *http.Response {
	b, err := proto.Marshal(msg)
	if err != nil {
		panic(err)
	}
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {libgm.ContentTypeProtobuf}}, Body: io.NopCloser(bytes.NewReader(b)), Request: req}
}

// newCapturingClient builds a libgm client whose two unexported *http.Client
// fields (http, lphttp) use the fake transport. Nothing else is changed.
func newCapturingClient(ad *libgm.AuthData, t *fakeTransport) *libgm.Client {
	cli := libgm.NewClient(ad, nil, nopLogger())
	hc := &http.Client{Transport: t}
	for _, name := range []string{"http", "lphttp"} {
		f := reflect.ValueOf(cli).Elem().FieldByName(name)
		reflect.NewAt(f.Type(), unsafe.Pointer(f.UnsafeAddr())).Elem().Set(reflect.ValueOf(hc))
	}
	return cli
}

// seeded returns n deterministic bytes for label (SHA-256 counter stream).
func seeded(label string, n int) []byte {
	out := make([]byte, 0, n+32)
	for i := 0; len(out) < n; i++ {
		h := sha256.Sum256([]byte(fmt.Sprintf("openrcs/client/%s#%d", label, i)))
		out = append(out, h[:]...)
	}
	return out[:n]
}

// seededReader is an endless deterministic byte stream, used as uuid's random source.
type seededReader struct {
	label string
	buf   []byte
	i     int
}

func (r *seededReader) Read(p []byte) (int, error) {
	for n := 0; n < len(p); {
		if len(r.buf) == 0 {
			r.buf = seeded(fmt.Sprintf("%s/%d", r.label, r.i), 64)
			r.i++
		}
		c := copy(p[n:], r.buf)
		r.buf = r.buf[c:]
		n += c
	}
	return len(p), nil
}

// seededJWK is the first valid P-256 key derived from label, built like
// crypto.GenerateECDSAKey (big.Int.Bytes widths), plus its 32-byte scalar.
func seededJWK(label string) (*crypto.JWK, []byte) {
	for c := 0; ; c++ {
		d := seeded(fmt.Sprintf("%s/%d", label, c), 32)
		priv, err := ecdh.P256().NewPrivateKey(d)
		if err != nil {
			continue
		}
		pub := priv.PublicKey().Bytes()
		trim := func(b []byte) []byte { return bytes.TrimLeft(b, "\x00") }
		return &crypto.JWK{KeyType: "EC", Curve: "P-256", D: trim(d), X: trim(pub[1:33]), Y: trim(pub[33:65])}, d
	}
}
