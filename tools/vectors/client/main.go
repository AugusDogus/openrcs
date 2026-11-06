// Command client generates the libgm client parity fixtures used by
// src/lib/gm/*.test.ts (src/lib/gm/__fixtures__/client.json). See README.md.
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	_ "unsafe" // go:linkname

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"go.mau.fi/util/pblite"
	"google.golang.org/protobuf/proto"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/crypto"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

// Unexported libgm methods, called through go:linkname so the fixtures come
// from libgm's own code rather than a copy of it.

//go:linkname refreshAuthToken go.mau.fi/mautrix-gmessages/pkg/libgm.(*Client).refreshAuthToken
func refreshAuthToken(c *libgm.Client, pushKeyOverride *libgm.PushKeys) error

//go:linkname decryptInternalMessage go.mau.fi/mautrix-gmessages/pkg/libgm.(*Client).decryptInternalMessage
func decryptInternalMessage(c *libgm.Client, data *gmproto.IncomingRPCMessage) (*libgm.IncomingRPCMessage, error)

func nopLogger() zerolog.Logger { return zerolog.Nop() }

func main() {
	out := flag.String("out", "../../../src/lib/gm/__fixtures__/client.json", "fixture file to write")
	flag.Parse()
	fx, err := generate()
	if err != nil {
		fmt.Fprintln(os.Stderr, "gen failed:", err)
		os.Exit(1)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(fx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, buf.Bytes(), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("wrote", *out)
}

// ---- fixture types ----

type authState struct {
	Token     string `json:"token"`
	TTL       string `json:"ttlMicros"`
	Mobile    string `json:"mobile"`
	Browser   string `json:"browser"`
	DestRegID string `json:"destRegId"`
}

type outgoing struct {
	Name        string            `json:"name"`
	URL         string            `json:"url"`
	RequestID   string            `json:"requestId"`
	SessionID   string            `json:"sessionId"`
	Action      int32             `json:"action"`
	MessageType int32             `json:"messageType"`
	TTL         string            `json:"ttl"`
	Auth        authState         `json:"auth"`
	Payload     string            `json:"payload"` // "encrypted", "plain" or "none"
	Plaintext   string            `json:"plaintext"`
	IV          string            `json:"iv"`
	Body        string            `json:"body"`
	Headers     map[string]string `json:"headers"`
}

type plainRequest struct {
	Name      string            `json:"name"`
	URL       string            `json:"url"`
	RequestID string            `json:"requestId"`
	Auth      authState         `json:"auth"`
	Body      string            `json:"body"`    // pblite text, when pblite
	BodyHex   string            `json:"bodyHex"` // raw body
	Headers   map[string]string `json:"headers"`
}

type registerRefresh struct {
	plainRequest
	TimestampMicros string `json:"timestampMicros"`
	Signature       string `json:"signature"`
}

type ack struct {
	plainRequest
	AckIDs []string `json:"ackIds"`
}

type qrURL struct {
	PairingKey string `json:"pairingKey"`
	URL        string `json:"url"`
}

type sendPayload struct {
	ConversationID string `json:"conversationId"`
	Text           string `json:"text"`
	ReplyToID      string `json:"replyToId"`
	ParticipantID  string `json:"participantId"`
	SIMTwo         int32  `json:"simTwo"`
	SIMNumber      int32  `json:"simNumber"`
	TmpID          string `json:"tmpId"`
	Binary         string `json:"binary"`
}

type frame struct {
	Name          string `json:"name"`
	JSON          string `json:"json"`
	ResponseID    string `json:"responseId"`
	Route         int32  `json:"route"`
	Action        int32  `json:"action"`
	DecryptedData string `json:"decryptedData"`
	DecodedType   string `json:"decodedType"`
	Decoded       string `json:"decoded"`
	HasPayload    bool   `json:"hasPayload"`
	HasUnencrypt  bool   `json:"hasUnencrypted"`
	HasAccount    bool   `json:"hasAccountField"`
	AccountSwitch bool   `json:"accountSwitch"`
	Pair          string `json:"pair"`
}

type event struct {
	Type    string `json:"type"`
	Message string `json:"message,omitempty"`
	Account string `json:"account,omitempty"`
	IsFake  bool   `json:"isFake,omitempty"`
	IsOld   bool   `json:"isOld,omitempty"`
}

type keys struct {
	AesKey     string `json:"aesKey"`
	HmacKey    string `json:"hmacKey"`
	RefreshKey string `json:"refreshKeyD"`
	SessionID  string `json:"sessionId"`
}

type fixture struct {
	QR struct {
		Keys               keys            `json:"keys"`
		RegisterPhoneRelay plainRequest    `json:"registerPhoneRelay"`
		QR                 qrURL           `json:"qr"`
		ReceivePairing     plainRequest    `json:"receiveMessagesPairing"`
		RefreshPhoneRelay  plainRequest    `json:"refreshPhoneRelay"`
		QRRefreshed        qrURL           `json:"qrRefreshed"`
		RegisterRefresh    registerRefresh `json:"registerRefresh"`
		Outgoing           []outgoing      `json:"outgoing"`
		Frames             []frame         `json:"frames"`
		Events             []event         `json:"events"`
		ReceiveLoggedIn    plainRequest    `json:"receiveMessagesLoggedIn"`
		Ack                ack             `json:"ack"`
		RevokeRelay        plainRequest    `json:"revokeRelayPairing"`
	} `json:"qr"`
	Gaia struct {
		Keys        keys              `json:"keys"`
		Cookies     map[string]string `json:"cookies"`
		SignIn      plainRequest      `json:"signInGaia"`
		Receive     plainRequest      `json:"receiveMessages"`
		Outgoing    []outgoing        `json:"outgoing"`
		InitPayload string            `json:"initPayload"`
		AttemptID   string            `json:"attemptId"`
		StartMillis int64             `json:"startMillis"`
	} `json:"gaia"`
	SendPayload sendPayload `json:"sendPayload"`
	Acceptance  struct {
		Keys      keys         `json:"keys"`
		DestRegID string       `json:"destRegId"`
		Cases     []acceptance `json:"cases"`
	} `json:"acceptance"`
}

// ---- helpers ----

func hx(b []byte) string { return hex.EncodeToString(b) }

func deviceHex(d *gmproto.Device) string {
	if d == nil {
		return ""
	}
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(d)
	if err != nil {
		panic(err)
	}
	return hx(b)
}

func state(ad *libgm.AuthData) authState {
	s := authState{Token: hx(ad.TachyonAuthToken), TTL: fmt.Sprint(ad.TachyonTTL), Mobile: deviceHex(ad.Mobile), Browser: deviceHex(ad.Browser)}
	if ad.DestRegID != uuid.Nil {
		s.DestRegID = ad.DestRegID.String()
	}
	return s
}

func headers(h http.Header) map[string]string {
	out := map[string]string{}
	for name, values := range h {
		v := values[0]
		if strings.EqualFold(name, "Cookie") {
			// Go adds cookies in random map order; normalise to sorted pairs.
			parts := strings.Split(strings.Join(values, "; "), "; ")
			sort.Strings(parts)
			v = strings.Join(parts, "; ")
		}
		out[strings.ToLower(name)] = v
	}
	return out
}

func plain(name string, c capture, ad *libgm.AuthData, requestID string) plainRequest {
	return plainRequest{Name: name, URL: c.URL, RequestID: requestID, Auth: state(ad), Body: string(c.Body), BodyHex: hx(c.Body), Headers: headers(c.Header)}
}

func decodeOutgoing(name string, c capture, ad *libgm.AuthData) (outgoing, error) {
	var msg gmproto.OutgoingRPCMessage
	if err := pblite.Unmarshal(c.Body, &msg); err != nil {
		return outgoing{}, fmt.Errorf("%s: %w", name, err)
	}
	var data gmproto.OutgoingRPCData
	if err := proto.Unmarshal(msg.GetData().GetMessageData(), &data); err != nil {
		return outgoing{}, fmt.Errorf("%s: %w", name, err)
	}
	o := outgoing{
		Name:        name,
		URL:         c.URL,
		RequestID:   data.RequestID,
		SessionID:   data.SessionID,
		Action:      int32(data.Action),
		MessageType: int32(msg.GetData().GetMessageTypeData().GetMessageType()),
		TTL:         fmt.Sprint(msg.TTL),
		Auth:        state(ad),
		Payload:     "none",
		Body:        string(c.Body),
		Headers:     headers(c.Header),
	}
	switch {
	case data.EncryptedProtoData != nil:
		enc := data.EncryptedProtoData
		pt, err := ad.RequestCrypto.Decrypt(bytes.Clone(enc))
		if err != nil {
			return outgoing{}, fmt.Errorf("%s: decrypt: %w", name, err)
		}
		o.Payload, o.Plaintext, o.IV = "encrypted", hx(pt), hx(enc[len(enc)-48:len(enc)-32])
	case data.UnencryptedProtoData != nil:
		o.Payload, o.Plaintext = "plain", hx(data.UnencryptedProtoData)
	}
	return o, nil
}

func authRequestID(body []byte, binary bool) string {
	var c gmproto.AuthenticationContainer
	if binary {
		_ = proto.Unmarshal(body, &c)
	}
	return c.GetAuthMessage().GetRequestID()
}

// buildSendPayloadWithTmpID is openmessage internal/app/gm.go
// BuildSendPayloadWithTmpID, copied verbatim (internal packages cannot be
// imported from outside that module), minus the tmp id generation branch.
func buildSendPayloadWithTmpID(conversationID, message, replyToID, participantID string, sim *gmproto.SIMPayload, tmpID string) *gmproto.SendMessageRequest {
	req := &gmproto.SendMessageRequest{
		ConversationID: conversationID,
		MessagePayload: &gmproto.MessagePayload{
			TmpID:                 tmpID,
			MessagePayloadContent: nil,
			MessageInfo: []*gmproto.MessageInfo{{
				Data: &gmproto.MessageInfo_MessageContent{MessageContent: &gmproto.MessageContent{
					Content: message,
				}},
			}},
			ConversationID: conversationID,
			ParticipantID:  participantID,
			TmpID2:         tmpID,
		},
		SIMPayload: sim,
		TmpID:      tmpID,
	}
	if replyToID != "" {
		req.Reply = &gmproto.ReplyPayload{
			MessageID: replyToID,
		}
	}
	return req
}

// newContactNumbers is openmessage internal/app/gm.go NewContactNumbers, copied verbatim.
func newContactNumbers(phones []string) []*gmproto.ContactNumber {
	numbers := make([]*gmproto.ContactNumber, len(phones))
	for i, phone := range phones {
		numbers[i] = &gmproto.ContactNumber{
			MysteriousInt: 7,
			Number:        phone,
			Number2:       phone,
		}
	}
	return numbers
}

func generate() (*fixture, error) {
	uuid.SetRand(&seededReader{label: "uuid"})
	fx := &fixture{}
	if err := genQR(fx); err != nil {
		return nil, fmt.Errorf("qr: %w", err)
	}
	if err := genGaia(fx); err != nil {
		return nil, fmt.Errorf("gaia: %w", err)
	}
	if err := genAcceptance(fx); err != nil {
		return nil, fmt.Errorf("acceptance: %w", err)
	}
	sim := &gmproto.SIMPayload{Two: 2, SIMNumber: 1}
	sp := buildSendPayloadWithTmpID("conv-42", "héllo 😀 <b>&amp;", "reply-msg-7", "+15550001111", sim, "tmp_000000000042")
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(sp)
	if err != nil {
		return nil, err
	}
	fx.SendPayload = sendPayload{ConversationID: "conv-42", Text: "héllo 😀 <b>&amp;", ReplyToID: "reply-msg-7", ParticipantID: "+15550001111", SIMTwo: 2, SIMNumber: 1, TmpID: "tmp_000000000042", Binary: hx(b)}
	return fx, nil
}

var errExpected = errors.New("expected")

func genQR(fx *fixture) error {
	jwk, d := seededJWK("qr/refresh-key")
	ad := &libgm.AuthData{
		RequestCrypto: &crypto.AESCTRHelper{AESKey: seeded("qr/aes", 32), HMACKey: seeded("qr/hmac", 32)},
		RefreshKey:    jwk,
	}
	fx.QR.Keys = keys{AesKey: hx(ad.RequestCrypto.AESKey), HmacKey: hx(ad.RequestCrypto.HMACKey), RefreshKey: hx(d), SessionID: ad.SessionID.String()}
	relayToken := seeded("qr/relay-token", 20)
	pairingKey := seeded("qr/pairing-key", 32)
	pairKey := seeded("qr/pair-key-refreshed", 32)
	pairedToken := seeded("qr/paired-token", 24)
	refreshedToken := seeded("qr/refreshed-token", 24)
	t := &fakeTransport{pollMode: "401", answers: map[string]func(*http.Request) *http.Response{
		"RegisterPhoneRelay": func(r *http.Request) *http.Response {
			return binaryResp(r, &gmproto.RegisterPhoneRelayResponse{PairingKey: pairingKey, AuthKeyData: &gmproto.TokenData{TachyonAuthToken: relayToken, TTL: 86400000000}})
		},
		"RefreshPhoneRelay": func(r *http.Request) *http.Response {
			return binaryResp(r, &gmproto.RefreshPhoneRelayResponse{PairKey: pairKey})
		},
		"RegisterRefresh": func(r *http.Request) *http.Response {
			return pbliteResp(r, &gmproto.RegisterRefreshResponse{TokenData: &gmproto.TokenData{TachyonAuthToken: refreshedToken, TTL: 72000000000}})
		},
		"RevokeRelayPairing": func(r *http.Request) *http.Response {
			return binaryResp(r, &gmproto.RevokeRelayPairingResponse{})
		},
	}}
	cli := newCapturingClient(ad, t)
	cli.SetRequestTimeout(time.Millisecond)
	// Events emitted while HandleRPCMsg processes the incoming frames.
	var recorded []event
	recording := false
	cli.SetEventHandler(func(evt any) {
		if !recording {
			return
		}
		switch e := evt.(type) {
		case *libgm.WrappedMessage:
			b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(e.Message)
			recorded = append(recorded, event{Type: "message", Message: hx(b), IsOld: e.IsOld})
		case *events.AccountChange:
			recorded = append(recorded, event{Type: "accountChange", Account: e.GetAccount(), IsFake: e.IsFake})
		case *events.GaiaLoggedOut:
			recorded = append(recorded, event{Type: "gaiaLoggedOut"})
		default:
			recorded = append(recorded, event{Type: fmt.Sprintf("%T", evt)})
		}
	})

	// StartLogin: RegisterPhoneRelay, then the not-logged-in long poll.
	n := t.count()
	qr, err := cli.StartLogin()
	if err != nil {
		return err
	}
	reg, err := t.waitNew("RegisterPhoneRelay", n)
	if err != nil {
		return err
	}
	fx.QR.RegisterPhoneRelay = plain("RegisterPhoneRelay", reg, ad, authRequestID(reg.Body, true))
	fx.QR.QR = qrURL{PairingKey: hx(pairingKey), URL: qr}
	poll, err := t.waitNew("ReceiveMessages", n)
	if err != nil {
		return err
	}
	var rmr gmproto.ReceiveMessagesRequest
	if err := pblite.Unmarshal(poll.Body, &rmr); err != nil {
		return err
	}
	fx.QR.ReceivePairing = plain("ReceiveMessages (pairing)", poll, ad, rmr.GetAuth().GetRequestID())

	n = t.count()
	qr2, err := cli.RefreshPhoneRelay()
	if err != nil {
		return err
	}
	ref, err := t.waitNew("RefreshPhoneRelay", n)
	if err != nil {
		return err
	}
	fx.QR.RefreshPhoneRelay = plain("RefreshPhoneRelay", ref, ad, authRequestID(ref.Body, true))
	fx.QR.QRRefreshed = qrURL{PairingKey: hx(pairKey), URL: qr2}

	// As if PairEvent Paired arrived.
	ad.Browser = &gmproto.Device{UserID: 123456789, SourceID: "browser-source-id", Network: "Bugle"}
	ad.Mobile = &gmproto.Device{UserID: 987654321, SourceID: "mobile-source-id", Network: "Bugle"}
	ad.TachyonAuthToken = pairedToken
	ad.TachyonTTL = 86400000000
	ad.TachyonExpiry = time.Time{}

	n = t.count()
	before := state(ad)
	if err := refreshAuthToken(cli, nil); err != nil {
		return err
	}
	rr, err := t.waitNew("RegisterRefresh", n)
	if err != nil {
		return err
	}
	var rrq gmproto.RegisterRefreshRequest
	if err := pblite.Unmarshal(rr.Body, &rrq); err != nil {
		return err
	}
	fx.QR.RegisterRefresh = registerRefresh{
		plainRequest:    plain("RegisterRefresh", rr, ad, rrq.GetMessageAuth().GetRequestID()),
		TimestampMicros: fmt.Sprint(rrq.UnixTimestamp),
		Signature:       hx(rrq.Signature),
	}
	fx.QR.RegisterRefresh.Auth = before

	type call struct {
		name string
		fn   func() error
	}
	cursor := &gmproto.Cursor{LastItemID: "last-item", LastItemTimestamp: 1762435200123456}
	calls := []call{
		{"SetActiveSession", cli.SetActiveSession},
		{"ListConversations first", func() error { _, err := cli.ListConversations(25, gmproto.ListConversationsRequest_INBOX); return err }},
		{"ListConversations cursor", func() error {
			_, err := cli.ListConversationsWithCursor(50, gmproto.ListConversationsRequest_ARCHIVE, cursor)
			return err
		}},
		{"FetchMessages", func() error { _, err := cli.FetchMessages("conv-1", 30, cursor); return err }},
		{"GetConversation", func() error { _, err := cli.GetConversation("conv-1"); return err }},
		{"GetOrCreateConversation", func() error {
			_, err := cli.GetOrCreateConversation(&gmproto.GetOrCreateConversationRequest{Numbers: newContactNumbers([]string{"+15551234567"})})
			return err
		}},
		{"SendMessage", func() error {
			_, err := cli.SendMessage(buildSendPayloadWithTmpID("conv-1", "hello ✨ \"quoted\"", "", "+15550001111", &gmproto.SIMPayload{Two: 2, SIMNumber: 1}, "tmp_000000000007"))
			return err
		}},
		{"MarkRead", func() error { return cli.MarkRead("conv-1", "msg-1") }},
		{"ListContacts", func() error { _, err := cli.ListContacts(); return err }},
		{"ListTopContacts", func() error { _, err := cli.ListTopContacts(); return err }},
	}
	for _, c := range calls {
		n = t.count()
		_ = c.fn() // libgm.ErrPhoneNotResponding after 1 ms: the fake phone never answers
		cp, err := t.waitNew("SendMessage", n)
		if err != nil {
			return fmt.Errorf("%s: %w", c.name, err)
		}
		o, err := decodeOutgoing(c.name, cp, ad)
		if err != nil {
			return err
		}
		fx.QR.Outgoing = append(fx.QR.Outgoing, o)
	}
	activeSession := fx.QR.Outgoing[0].RequestID

	frames, err := buildFrames(ad, activeSession)
	if err != nil {
		return err
	}
	for _, f := range frames {
		var payload gmproto.LongPollingPayload
		if err := pblite.Unmarshal([]byte(f.JSON), &payload); err != nil {
			return fmt.Errorf("%s: %w", f.Name, err)
		}
		msg, err := decryptInternalMessage(cli, payload.GetData())
		if err != nil {
			return fmt.Errorf("%s: %w", f.Name, err)
		}
		f.ResponseID = payload.GetData().GetResponseID()
		f.Route = int32(payload.GetData().GetBugleRoute())
		if msg.Message != nil {
			f.Action = int32(msg.Message.Action)
		}
		f.DecryptedData = hx(msg.DecryptedData)
		if msg.DecryptedMessage != nil {
			f.DecodedType = string(msg.DecryptedMessage.ProtoReflect().Descriptor().FullName())
			b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(msg.DecryptedMessage)
			f.Decoded = hx(b)
		}
		if msg.Pair != nil {
			b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(msg.Pair)
			f.Pair = hx(b)
		}
		f.HasPayload, f.HasUnencrypt, f.HasAccount, f.AccountSwitch = msg.Shape.HasPayload, msg.Shape.HasUnencrypted, msg.Shape.HasAccountField, msg.Shape.AccountSwitch
		fx.QR.Frames = append(fx.QR.Frames, f)
		if f.Route == int32(gmproto.BugleRoute_DataEvent) {
			recording = true
			cli.HandleRPCMsg(payload.GetData()) // queues the ack and emits events
			recording = false
		}
	}
	fx.QR.Events = recorded

	// ConnectBackground: logged-in long poll (answered 401), then sendAckRequest.
	n = t.count()
	if err := cli.ConnectBackground(); err == nil {
		return fmt.Errorf("ConnectBackground: %w", errExpected)
	}
	lp, err := t.waitNew("ReceiveMessages", n)
	if err != nil {
		return err
	}
	var lpr gmproto.ReceiveMessagesRequest
	if err := pblite.Unmarshal(lp.Body, &lpr); err != nil {
		return err
	}
	fx.QR.ReceiveLoggedIn = plain("ReceiveMessages (logged in)", lp, ad, lpr.GetAuth().GetRequestID())
	ak, err := t.waitNew("AckMessages", n)
	if err != nil {
		return err
	}
	var akr gmproto.AckMessageRequest
	if err := pblite.Unmarshal(ak.Body, &akr); err != nil {
		return err
	}
	fx.QR.Ack = ack{plainRequest: plain("AckMessages", ak, ad, akr.GetAuthData().GetRequestID())}
	for _, a := range akr.Acks {
		fx.QR.Ack.AckIDs = append(fx.QR.Ack.AckIDs, a.RequestID)
	}

	n = t.count()
	if _, err := cli.UnpairBugle(); err != nil {
		return err
	}
	rv, err := t.waitNew("RevokeRelayPairing", n)
	if err != nil {
		return err
	}
	var rvr gmproto.RevokeRelayPairingRequest
	_ = proto.Unmarshal(rv.Body, &rvr)
	fx.QR.RevokeRelay = plain("RevokeRelayPairing", rv, ad, rvr.GetAuthMessage().GetRequestID())
	return nil
}

func genGaia(fx *fixture) error {
	jwk, d := seededJWK("gaia/refresh-key")
	cookies := map[string]string{"SID": "sid-value", "HSID": "hsid-value", "SSID": "ssid-value", "APISID": "apisid-value", "SAPISID": "sapisid/Value_1", "__Secure-1PSID": "secure-1psid", "OSID": "osid-value"}
	ad := &libgm.AuthData{
		RequestCrypto: &crypto.AESCTRHelper{AESKey: seeded("gaia/aes", 32), HMACKey: seeded("gaia/hmac", 32)},
		RefreshKey:    jwk,
		Cookies:       map[string]string{},
	}
	for k, v := range cookies {
		ad.Cookies[k] = v
	}
	fx.Gaia.Keys = keys{AesKey: hx(ad.RequestCrypto.AESKey), HmacKey: hx(ad.RequestCrypto.HMACKey), RefreshKey: hx(d), SessionID: ad.SessionID.String()}
	fx.Gaia.Cookies = cookies
	destRegID := uuid.NewSHA1(uuid.NameSpaceOID, []byte("openrcs/client/gaia/dest-reg"))
	gaiaToken := seeded("gaia/token", 24)
	t := &fakeTransport{pollMode: "open", answers: map[string]func(*http.Request) *http.Response{
		"SignInGaia": func(r *http.Request) *http.Response {
			return pbliteResp(r, &gmproto.SignInGaiaResponse{
				DeviceData: &gmproto.SignInGaiaResponse_DeviceData{
					DeviceWrapper: &gmproto.SignInGaiaResponse_DeviceData_DeviceWrapper{Device: &gmproto.Device{UserID: 4242, SourceID: "GAIA-Browser-Source", Network: "GDitto"}},
					UnknownItems2: []*gmproto.RPCGaiaData_UnknownContainer_Item2_Item1{
						{DestOrSourceUUID: destRegID.String(), UnknownInt4: 1, LanguageCode: "en", UnknownBigInt7: 42},
					},
					UnknownItems3: []*gmproto.RPCGaiaData_UnknownContainer_Item4{
						{DestOrSourceUUID: destRegID.String(), UnknownTimestampMicroseconds: 1762435200000000},
					},
				},
				TokenData: &gmproto.TokenData{TachyonAuthToken: gaiaToken, TTL: 86400000000},
			})
		},
	}}
	cli := newCapturingClient(ad, t)

	n := t.count()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	_, _, err := cli.StartGaiaPairing(ctx)
	cancel()
	if !errors.Is(err, libgm.ErrPairingInitTimeout) {
		return fmt.Errorf("StartGaiaPairing: expected init timeout, got %v", err)
	}
	si, err := t.waitNew("SignInGaia", n)
	if err != nil {
		return err
	}
	var sir gmproto.SignInGaiaRequest
	if err := pblite.Unmarshal(si.Body, &sir); err != nil {
		return err
	}
	fx.Gaia.SignIn = plain("SignInGaia", si, ad, sir.GetAuthMessage().GetRequestID())
	fx.Gaia.SignIn.Auth = authState{}
	rm, err := t.waitNew("ReceiveMessages", n)
	if err != nil {
		return err
	}
	var rmr gmproto.ReceiveMessagesRequest
	if err := pblite.Unmarshal(rm.Body, &rmr); err != nil {
		return err
	}
	fx.Gaia.Receive = plain("ReceiveMessages (gaia)", rm, ad, rmr.GetAuth().GetRequestID())
	sends := t.all("SendMessage", n)
	if len(sends) != 2 {
		return fmt.Errorf("expected CLIENT_INIT and CANCEL, got %d sends", len(sends))
	}
	for i, name := range []string{"CREATE_GAIA_PAIRING_CLIENT_INIT", "CANCEL_GAIA_PAIRING (init timeout)"} {
		o, err := decodeOutgoing(name, sends[i], ad)
		if err != nil {
			return err
		}
		fx.Gaia.Outgoing = append(fx.Gaia.Outgoing, o)
	}
	var container gmproto.GaiaPairingRequestContainer
	init, _ := hex.DecodeString(fx.Gaia.Outgoing[0].Plaintext)
	if err := proto.Unmarshal(init, &container); err != nil {
		return err
	}
	fx.Gaia.InitPayload = hx(container.Data)
	fx.Gaia.AttemptID = container.PairingAttemptID
	fx.Gaia.StartMillis = container.StartTimestamp

	// FinishGaiaPairing, cancelled while waiting: CLIENT_FINISHED then CANCEL.
	key, _ := seededJWK("gaia/pairing-key")
	ps := &libgm.PairingSession{UUID: uuid.MustParse(fx.Gaia.AttemptID), Start: time.UnixMilli(fx.Gaia.StartMillis), PairingKeyDSA: key.GetPrivateKey()}
	if _, _, err := ps.PreparePayloads(); err != nil {
		return err
	}
	n = t.count()
	fctx, fcancel := context.WithCancel(context.Background())
	go func() {
		if _, err := t.waitNew("SendMessage", n); err == nil {
			fcancel()
		}
	}()
	if _, err := cli.FinishGaiaPairing(fctx, ps); !errors.Is(err, context.Canceled) {
		fcancel()
		return fmt.Errorf("FinishGaiaPairing: expected cancel, got %v", err)
	}
	fcancel()
	if _, err := t.waitNew("SendMessage", n+1); err != nil {
		return err
	}
	sends = t.all("SendMessage", n)
	if len(sends) != 2 {
		return fmt.Errorf("expected CLIENT_FINISHED and CANCEL, got %d sends", len(sends))
	}
	for i, name := range []string{"CREATE_GAIA_PAIRING_CLIENT_FINISHED", "CANCEL_GAIA_PAIRING (finish cancelled)"} {
		o, err := decodeOutgoing(name, sends[i], ad)
		if err != nil {
			return err
		}
		fx.Gaia.Outgoing = append(fx.Gaia.Outgoing, o)
	}

	ad.PairingID = uuid.MustParse(fx.Gaia.AttemptID)
	n = t.count()
	if err := cli.UnpairGaia(); err != nil {
		return err
	}
	up, err := t.waitNew("SendMessage", n)
	if err != nil {
		return err
	}
	o, err := decodeOutgoing("UNPAIR_GAIA_PAIRING", up, ad)
	if err != nil {
		return err
	}
	fx.Gaia.Outgoing = append(fx.Gaia.Outgoing, o)
	return nil
}
