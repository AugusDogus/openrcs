package main

import (
	"fmt"
	"reflect"
	"unsafe"

	"github.com/google/uuid"
	"go.mau.fi/util/pblite"
	"google.golang.org/protobuf/proto"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/crypto"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

//go:linkname waitResponse go.mau.fi/mautrix-gmessages/pkg/libgm.(*SessionHandler).waitResponse
func waitResponse(s *libgm.SessionHandler, requestID string, action gmproto.ActionType) chan *libgm.IncomingRPCMessage

//go:linkname receiveResponse go.mau.fi/mautrix-gmessages/pkg/libgm.(*SessionHandler).receiveResponse
func receiveResponse(s *libgm.SessionHandler, msg *libgm.IncomingRPCMessage) bool

// acceptance is one libgm receiveResponse decision: a waiter for
// WaiterAction is registered under "req-1", then the frame arrives.
type acceptance struct {
	Name         string `json:"name"`
	Session      string `json:"session"` // "qr" (HasCookies) or "gaiaNoCookies"
	WaiterAction int32  `json:"waiterAction"`
	JSON         string `json:"json"` // LongPollingPayload pblite
	Consumed     bool   `json:"consumed"`
	Delivered    bool   `json:"delivered"`
}

func sessionHandlerOf(cli *libgm.Client) *libgm.SessionHandler {
	f := reflect.ValueOf(cli).Elem().FieldByName("sessionHandler")
	return reflect.NewAt(f.Type(), unsafe.Pointer(f.UnsafeAddr())).Elem().Interface().(*libgm.SessionHandler)
}

// genAcceptance runs libgm's receiveResponse on frames covering its rules:
// payload-required and object-required actions, header-only and field-11
// account frames, and the unencrypted intermediate-frame rule (HasCookies
// sessions only, Gaia pairing actions exempt).
func genAcceptance(fx *fixture) error {
	rc := &crypto.AESCTRHelper{AESKey: seeded("accept/aes", 32), HMACKey: seeded("accept/hmac", 32)}
	fx.Acceptance.Keys = keys{AesKey: hx(rc.AESKey), HmacKey: hx(rc.HMACKey)}
	fx.Acceptance.DestRegID = uuid.NewSHA1(uuid.NameSpaceOID, []byte("openrcs/client/accept/dest-reg")).String()

	enc := func(m proto.Message) []byte {
		b, err := proto.MarshalOptions{Deterministic: true}.Marshal(m)
		if err != nil {
			panic(err)
		}
		out, err := rc.Encrypt(b)
		if err != nil {
			panic(err)
		}
		return out
	}
	list := enc(&gmproto.ListConversationsResponse{Conversations: []*gmproto.Conversation{{ConversationID: "c1"}}})
	msgs := enc(&gmproto.ListMessagesResponse{Messages: []*gmproto.Message{{MessageID: "m1"}}})
	account := enc(&gmproto.EncryptedData2Container{AccountChange: &gmproto.AccountChangeOrSomethingEvent{Account: "someone@example.com"}})

	type spec struct {
		name    string
		waiter  gmproto.ActionType
		request string
		data    *gmproto.RPCMessageData
	}
	const (
		LC = gmproto.ActionType_LIST_CONVERSATIONS
		LM = gmproto.ActionType_LIST_MESSAGES
		GC = gmproto.ActionType_GET_CONVERSATION
		SM = gmproto.ActionType_SEND_MESSAGE
		GI = gmproto.ActionType_CREATE_GAIA_PAIRING_CLIENT_INIT
	)
	specs := []spec{
		{"payload answers a listing", LC, "req-1", &gmproto.RPCMessageData{Action: LC, EncryptedData: list}},
		{"header-only answers a listing", LC, "req-1", &gmproto.RPCMessageData{Action: LC}},
		{"header-only cannot answer an object lookup", GC, "req-1", &gmproto.RPCMessageData{Action: GC}},
		{"field 5 only, listing", LM, "req-1", &gmproto.RPCMessageData{Action: LM, UnencryptedData: []byte{1, 2, 3}}},
		{"field 5 only, object lookup", GC, "req-1", &gmproto.RPCMessageData{Action: GC, UnencryptedData: []byte{1, 2, 3}}},
		{"field 5 with payload", LM, "req-1", &gmproto.RPCMessageData{Action: LM, UnencryptedData: []byte{1}, EncryptedData: msgs}},
		{"field 11 account only, listing", LC, "req-1", &gmproto.RPCMessageData{Action: LC, EncryptedData2: account}},
		{"field 11 account only, send", SM, "req-1", &gmproto.RPCMessageData{Action: SM, EncryptedData2: account}},
		{"header-only answers a send", SM, "req-1", &gmproto.RPCMessageData{Action: SM}},
		{"field 5 only, Gaia CLIENT_INIT (exempt)", GI, "req-1", &gmproto.RPCMessageData{Action: GI, UnencryptedData: []byte{9, 9}}},
		{"another request's answer", LC, "req-2", &gmproto.RPCMessageData{Action: LC, EncryptedData: list}},
	}
	for _, session := range []string{"qr", "gaiaNoCookies"} {
		for _, s := range specs {
			ad := &libgm.AuthData{RequestCrypto: rc}
			if session == "gaiaNoCookies" {
				ad.DestRegID = uuid.MustParse(fx.Acceptance.DestRegID)
			}
			cli := libgm.NewClient(ad, nil, nopLogger())
			s.data.SessionID = s.request
			inner, err := proto.MarshalOptions{Deterministic: true}.Marshal(s.data)
			if err != nil {
				return err
			}
			raw := &gmproto.IncomingRPCMessage{ResponseID: "resp-" + s.request, BugleRoute: gmproto.BugleRoute_DataEvent, MessageType: gmproto.MessageType_BUGLE_MESSAGE, MessageData: inner}
			js, err := pblite.Marshal(&gmproto.LongPollingPayload{Data: raw})
			if err != nil {
				return err
			}
			sh := sessionHandlerOf(cli)
			ch := waitResponse(sh, "req-1", s.waiter)
			msg, err := decryptInternalMessage(cli, raw)
			if err != nil {
				return fmt.Errorf("%s: %w", s.name, err)
			}
			a := acceptance{Name: s.name, Session: session, WaiterAction: int32(s.waiter), JSON: string(js), Consumed: receiveResponse(sh, msg)}
			select {
			case <-ch:
				a.Delivered = true
			default:
			}
			fx.Acceptance.Cases = append(fx.Acceptance.Cases, a)
		}
	}
	return nil
}
