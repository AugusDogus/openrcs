// Command pblite regenerates the pblite and libgm-constant test fixtures used by
// src/lib/gm/pblite.test.ts and src/lib/gm/constants.test.ts. Every expected
// value is produced by the Go reference implementation (go.mau.fi/util/pblite
// and libgm), never written by hand. See README.md for how to run it.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/util"
	"go.mau.fi/util/pblite"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
)

// encodeCase: pbliteJSON is pblite.Marshal(msg), binaryBase64 is
// proto.Marshal(msg). roundTripBinaryBase64 is proto.Marshal of
// pblite.Unmarshal(pbliteJSON); it differs from binaryBase64 when 64-bit
// integers lose precision as float64 JSON numbers. roundTripArchDependent
// marks round trips that convert out-of-range floats to integers (see
// decodeCase).
type encodeCase struct {
	Name                   string `json:"name"`
	ProtoTypeName          string `json:"protoTypeName"`
	PbliteJSON             string `json:"pbliteJSON"`
	BinaryBase64           string `json:"binaryBase64"`
	RoundTripBinaryBase64  string `json:"roundTripBinaryBase64"`
	RoundTripArchDependent bool   `json:"roundTripArchDependent"`
}

// decodeCase: binaryBase64 is proto.Marshal of pblite.Unmarshal(pbliteJSON).
// archDependent cases convert out-of-range JSON numbers to integers, which the
// Go spec leaves implementation-defined; their expected values are only valid
// for the goarch recorded at the top of the fixture file.
type decodeCase struct {
	Name          string `json:"name"`
	ProtoTypeName string `json:"protoTypeName"`
	PbliteJSON    string `json:"pbliteJSON"`
	BinaryBase64  string `json:"binaryBase64"`
	ArchDependent bool   `json:"archDependent"`
}

// errorLocation names the field the Go error is about. index is the position
// in the enclosing array (field number - 1, or the element position inside a
// repeated field); it is null when Go does not report one.
type errorLocation struct {
	Field string `json:"field"`
	Index *int   `json:"index"`
}

// decodeErrorCase: pblite.Unmarshal(pbliteJSON) fails in Go. location is null
// for whole-document failures (invalid JSON, not an array). The generator
// checks that Go's error message names the same location.
type decodeErrorCase struct {
	Name          string         `json:"name"`
	ProtoTypeName string         `json:"protoTypeName"`
	PbliteJSON    string         `json:"pbliteJSON"`
	GoError       string         `json:"goError"`
	Location      *errorLocation `json:"location"`
}

// encodeErrorCase: pblite.Marshal fails in Go for the message whose binary
// encoding is binaryBase64.
type encodeErrorCase struct {
	Name          string `json:"name"`
	ProtoTypeName string `json:"protoTypeName"`
	BinaryBase64  string `json:"binaryBase64"`
	GoError       string `json:"goError"`
	Field         string `json:"field"`
}

// floatFormatting: no gmproto message has float or double fields, so this
// records encoding/json's output for the values pblite would emit: a repeated
// double serializes each float64 as is, a repeated float serializes
// float64(float32(x)). Values are IEEE-754 float64 bit patterns in hex.
type floatFormatting struct {
	DoubleBits      []string `json:"doubleBits"`
	DoubleJSON      string   `json:"doubleJSON"`
	FloatSourceBits []string `json:"floatSourceBits"`
	FloatJSON       string   `json:"floatJSON"`
}

type pbliteFixtures struct {
	Generator       string            `json:"generator"`
	GoArch          string            `json:"goarch"`
	Encode          []encodeCase      `json:"encode"`
	EncodeErrors    []encodeErrorCase `json:"encodeErrors"`
	Decode          []decodeCase      `json:"decode"`
	DecodeErrors    []decodeErrorCase `json:"decodeErrors"`
	FloatFormatting floatFormatting   `json:"floatFormatting"`
}

type constantsFixtures struct {
	Generator string `json:"generator"`
	// Header maps use lowercased names, as sent on the wire by net/http (HTTP/2).
	RelayHeadersPblite   map[string]string `json:"relayHeadersPblite"`
	RelayHeadersProtobuf map[string]string `json:"relayHeadersProtobuf"`
	RelayHeadersNoBody   map[string]string `json:"relayHeadersNoBody"`
	ConfigHeaders        map[string]string `json:"configHeaders"`
	UploadHeaders        map[string]string `json:"uploadHeaders"`
	MediaUploadStart     map[string]string `json:"mediaUploadStartHeaders"`
	MediaUploadFinalize  map[string]string `json:"mediaUploadFinalizeHeaders"`
	ConfigVersionBase64  string            `json:"configVersionBinaryBase64"`
	BrowserDetailsBase64 string            `json:"browserDetailsBinaryBase64"`
	Strings              map[string]string `json:"strings"`
}

const generatorNote = "tools/vectors/pblite (go run .); do not edit by hand"

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func seqBytes(n int, start byte) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = start + byte(i*7)
	}
	return out
}

func typeName(m proto.Message) string {
	return string(m.ProtoReflect().Descriptor().FullName())
}

func newMessage(name string) proto.Message {
	mt := must(protoregistry.GlobalTypes.FindMessageByName(protoreflect.FullName(name)))
	return mt.New().Interface()
}

func encodeTo(name string, m proto.Message, archDependent bool) encodeCase {
	pbliteJSON := must(pblite.Marshal(m))
	roundTrip := m.ProtoReflect().New().Interface()
	if err := pblite.Unmarshal(pbliteJSON, roundTrip); err != nil {
		panic(fmt.Errorf("encode case %q does not decode: %w", name, err))
	}
	return encodeCase{
		Name:                   name,
		ProtoTypeName:          typeName(m),
		PbliteJSON:             string(pbliteJSON),
		BinaryBase64:           b64(must(proto.Marshal(m))),
		RoundTripBinaryBase64:  b64(must(proto.Marshal(roundTrip))),
		RoundTripArchDependent: archDependent,
	}
}

func enc(name string, m proto.Message) encodeCase { return encodeTo(name, m, false) }

// encArch: the message holds a uint64 above 2^63, whose float64 round trip
// is implementation-defined in Go.
func encArch(name string, m proto.Message) encodeCase { return encodeTo(name, m, true) }

func decodeTo(name, protoTypeName, input string, archDependent bool) decodeCase {
	m := newMessage(protoTypeName)
	if err := pblite.Unmarshal([]byte(input), m); err != nil {
		panic(fmt.Errorf("decode case %q unexpectedly failed: %w", name, err))
	}
	return decodeCase{
		Name:          name,
		ProtoTypeName: protoTypeName,
		PbliteJSON:    input,
		BinaryBase64:  b64(must(proto.Marshal(m))),
		ArchDependent: archDependent,
	}
}

func dec(name, protoTypeName, input string) decodeCase {
	return decodeTo(name, protoTypeName, input, false)
}

func decArch(name, protoTypeName, input string) decodeCase {
	return decodeTo(name, protoTypeName, input, true)
}

func decodeFailure(name, protoTypeName, input string) decodeErrorCase {
	m := newMessage(protoTypeName)
	err := pblite.Unmarshal([]byte(input), m)
	if err == nil {
		panic(fmt.Errorf("decode error case %q unexpectedly succeeded", name))
	}
	return decodeErrorCase{Name: name, ProtoTypeName: protoTypeName, PbliteJSON: input, GoError: err.Error()}
}

// decErrDoc: a whole-document failure with no field location.
func decErrDoc(name, protoTypeName, input string) decodeErrorCase {
	return decodeFailure(name, protoTypeName, input)
}

// decErr: a failure Go reports "at index <index> for ... <field>".
func decErr(name, protoTypeName, input, field string, index int) decodeErrorCase {
	c := decodeFailure(name, protoTypeName, input)
	if !strings.Contains(c.GoError, fmt.Sprintf("at index %d for ", index)) || !strings.Contains(c.GoError, " "+field) {
		panic(fmt.Errorf("decode error case %q: Go error %q does not name index %d field %s", name, c.GoError, index, field))
	}
	c.Location = &errorLocation{Field: field, Index: &index}
	return c
}

// decErrUnsupported: Go rejects the field kind itself and reports no index.
func decErrUnsupported(name, protoTypeName, input, field string) decodeErrorCase {
	c := decodeFailure(name, protoTypeName, input)
	if !strings.HasPrefix(c.GoError, "unsupported field type ") || !strings.HasSuffix(c.GoError, " in "+field) {
		panic(fmt.Errorf("decode error case %q: Go error %q is not an unsupported-kind error for %s", name, c.GoError, field))
	}
	c.Location = &errorLocation{Field: field}
	return c
}

func encErr(name string, m proto.Message, field string) encodeErrorCase {
	_, err := pblite.Marshal(m)
	if err == nil {
		panic(fmt.Errorf("encode error case %q unexpectedly succeeded", name))
	}
	if !strings.HasSuffix(err.Error(), " in "+field) {
		panic(fmt.Errorf("encode error case %q: Go error %q does not name field %s", name, err, field))
	}
	return encodeErrorCase{
		Name:          name,
		ProtoTypeName: typeName(m),
		BinaryBase64:  b64(must(proto.Marshal(m))),
		GoError:       err.Error(),
		Field:         field,
	}
}

func authMessage(requestID string) *gmproto.AuthMessage {
	return &gmproto.AuthMessage{
		RequestID:        requestID,
		Network:          util.QRNetwork,
		TachyonAuthToken: seqBytes(48, 3),
		ConfigVersion:    util.ConfigMessage,
	}
}

func browserDevice() *gmproto.Device {
	return &gmproto.Device{UserID: 1234567890123456789, SourceID: "a1b2c3d4e5f60718", Network: util.QRNetwork}
}

// trickyString exercises every escaping rule in encoding/json: all C0
// controls, quotes, backslash, HTML-sensitive characters, DEL, U+2028/2029,
// non-ASCII, astral-plane emoji and U+FFFD.
func trickyString() string {
	var sb strings.Builder
	for c := 0; c < 0x20; c++ {
		sb.WriteByte(byte(c))
	}
	sb.WriteString(`"\/<>&'` + "\x7f")
	sb.WriteString("\u2028\u2029 \u00e9 \u00df \u65e5\u672c\u8a9e \u00a0 \ufeff \ufffd \U0001F600 \U0001F469\u200d\U0001F4BB \U0001F1FA\U0001F1F8")
	return sb.String()
}

func encodeCases() []encodeCase {
	return []encodeCase{
		enc("RegisterRefreshRequest with push keys", &gmproto.RegisterRefreshRequest{
			MessageAuth:       authMessage("3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f"),
			CurrBrowserDevice: browserDevice(),
			UnixTimestamp:     1730000000123456,
			Signature:         seqBytes(71, 0x30),
			Parameters: &gmproto.RegisterRefreshRequest_Parameters{
				EmptyArr: &gmproto.EmptyArr{},
				MoreParameters: &gmproto.RegisterRefreshRequest_MoreParameters{
					Three: 3,
					PushReg: &gmproto.RegisterRefreshRequest_PushRegistration{
						Type:   "messages_web",
						Url:    "https://push.example.com/wpush/v2/gAAAAABk?x=1&y=<2>",
						P256Dh: base64.RawURLEncoding.EncodeToString(seqBytes(65, 4)),
						Auth:   base64.RawURLEncoding.EncodeToString(seqBytes(16, 9)),
					},
				},
			},
			MessageType: 2,
		}),
		enc("RegisterRefreshRequest without push keys", &gmproto.RegisterRefreshRequest{
			MessageAuth:       authMessage("00000000-0000-4000-8000-000000000000"),
			CurrBrowserDevice: browserDevice(),
			UnixTimestamp:     1700000000000000,
			Signature:         seqBytes(70, 0x30),
			Parameters:        &gmproto.RegisterRefreshRequest_Parameters{EmptyArr: &gmproto.EmptyArr{}},
			MessageType:       2,
		}),
		enc("ReceiveMessagesRequest", &gmproto.ReceiveMessagesRequest{
			Auth: authMessage("listen-req-id"),
			Unknown: &gmproto.ReceiveMessagesRequest_UnknownEmptyObject2{
				Unknown: &gmproto.ReceiveMessagesRequest_UnknownEmptyObject1{},
			},
		}),
		enc("OutgoingRPCMessage with destRegistrationIDs and TTL", &gmproto.OutgoingRPCMessage{
			Mobile: &gmproto.Device{UserID: 987654321, SourceID: "mobile-source", Network: util.QRNetwork},
			Data: &gmproto.OutgoingRPCMessage_Data{
				RequestID:   "req-1",
				BugleRoute:  gmproto.BugleRoute_DataEvent,
				MessageData: seqBytes(100, 1),
				MessageTypeData: &gmproto.OutgoingRPCMessage_Data_Type{
					EmptyArr:    &gmproto.EmptyArr{},
					MessageType: gmproto.MessageType_BUGLE_MESSAGE,
				},
			},
			Auth: &gmproto.OutgoingRPCMessage_Auth{
				RequestID:        "req-1",
				TachyonAuthToken: seqBytes(32, 5),
				ConfigVersion:    util.ConfigMessage,
			},
			TTL:                 2592000000000,
			DestRegistrationIDs: []string{"6c2f7a1e-0d3b-4f5a-8e9c-112233445566", "second-ü"},
		}),
		enc("OutgoingRPCMessage without TTL or destinations", &gmproto.OutgoingRPCMessage{
			Data: &gmproto.OutgoingRPCMessage_Data{
				RequestID:  "req-2",
				BugleRoute: gmproto.BugleRoute_PairEvent,
				MessageTypeData: &gmproto.OutgoingRPCMessage_Data_Type{
					EmptyArr:    &gmproto.EmptyArr{},
					MessageType: gmproto.MessageType_GAIA_2,
				},
			},
			Auth:                &gmproto.OutgoingRPCMessage_Auth{RequestID: "req-2", ConfigVersion: util.ConfigMessage},
			DestRegistrationIDs: []string{},
		}),
		enc("SignInGaiaRequest with pblite_binary someData", &gmproto.SignInGaiaRequest{
			AuthMessage: &gmproto.AuthMessage{
				RequestID:     "5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716",
				Network:       util.GoogleNetwork,
				ConfigVersion: util.ConfigMessage,
			},
			Inner: &gmproto.SignInGaiaRequest_Inner{
				DeviceID: &gmproto.SignInGaiaRequest_Inner_DeviceID{
					UnknownInt1: 3,
					DeviceID:    "messages-web-0123456789abcdef0123456789abcdef",
				},
				SomeData: &gmproto.SignInGaiaRequest_Inner_Data{SomeData: seqBytes(91, 0x30)},
			},
			UnknownInt3: 1,
			Network:     util.GoogleNetwork,
		}),
		enc("SignInGaiaRequest with empty pblite_binary message", &gmproto.SignInGaiaRequest{
			Inner: &gmproto.SignInGaiaRequest_Inner{SomeData: &gmproto.SignInGaiaRequest_Inner_Data{}},
		}),
		enc("AckMessageRequest with repeated acks", &gmproto.AckMessageRequest{
			AuthData: authMessage("ack-req"),
			EmptyArr: &gmproto.EmptyArr{},
			Acks: []*gmproto.AckMessageRequest_Message{
				{RequestID: "ack-1", Device: browserDevice()},
				{RequestID: "ack-2", Device: browserDevice()},
				{RequestID: "ack-3"},
				{},
			},
		}),
		enc("AuthMessage with escaping-sensitive strings", &gmproto.AuthMessage{
			RequestID: trickyString(),
			Network:   `<script>alert("x&y")</script>`,
		}),
		encArch("SignInGaiaResponse with non-ASCII pblite_binary string", &gmproto.SignInGaiaResponse{
			Header:           &gmproto.SignInGaiaResponse_Header{UnknownInt2: 18446744073709551615, UnknownTimestamp: -9223372036854775808},
			MaybeBrowserUUID: "ünïcödé <&> 😀",
		}),
		encArch("RPCGaiaData with uint64, negative int64 and nested pblite_binary", &gmproto.RPCGaiaData{
			Command: -1,
			MaybeServerData: &gmproto.RPCGaiaData_UnknownContainer{
				Item2: &gmproto.RPCGaiaData_UnknownContainer_Item2{
					Item1: []*gmproto.RPCGaiaData_UnknownContainer_Item2_Item1{
						{DestOrSourceUUID: "9a8b7c6d-5e4f-4a3b-2c1d-0e0f10111213", UnknownInt4: 1, LanguageCode: "en-US", UnknownBigInt7: 18446744073709551615},
						{DestOrSourceUUID: "local", UnknownInt4: 6, UnknownBigInt7: 9007199254740993},
					},
				},
				UnknownTimestampMicroseconds: -1730000000123456,
				Item4: []*gmproto.RPCGaiaData_UnknownContainer_Item4{
					{
						DestOrSourceUUID:             "9a8b7c6d-5e4f-4a3b-2c1d-0e0f10111213",
						UnknownInt3:                  1,
						UnknownInt4:                  6,
						UnknownTimestampMicroseconds: 1730000000654321,
						Item8:                        &gmproto.RPCGaiaData_UnknownContainer_Item4_Item8{UnknownInt1: 1, UnknownTimestamp: -2147483648, UnknownBytes: []byte{0xff, 0x00, 0xfe}},
					},
					{Item8: &gmproto.RPCGaiaData_UnknownContainer_Item4_Item8{}},
				},
			},
		}),
		enc("Config with oneof members including zero values", &gmproto.Config{
			MoreFlags: &gmproto.Config_MoreFlags{
				WrappedFlags: []*gmproto.Config_WrappedFlag{
					{Key: "int-zero", Value: &gmproto.Config_WrappedFlag_Value{Value: &gmproto.Config_WrappedFlag_Value_IntVal{IntVal: 0}}},
					{Key: "str-empty", Value: &gmproto.Config_WrappedFlag_Value{Value: &gmproto.Config_WrappedFlag_Value_StrVal{StrVal: ""}}},
					{Key: "int", Value: &gmproto.Config_WrappedFlag_Value{Value: &gmproto.Config_WrappedFlag_Value_IntVal{IntVal: -42}}},
					{Key: "unset", Value: &gmproto.Config_WrappedFlag_Value{}},
				},
			},
		}),
		enc("UpdateConversationRequest with oneof message member", &gmproto.UpdateConversationRequest{
			Action:         gmproto.ConversationActionStatus_BLOCK,
			ConversationID: "conv-1",
			Data:           &gmproto.UpdateConversationRequest_UpdateData{UpdateData: &gmproto.UpdateConversationData{ConversationID: "conv-1", Data: &gmproto.UpdateConversationData_Status{Status: gmproto.ConversationStatus_UNKNOWN_CONVERSATION_STATUS}}},
		}),
		enc("StartAckMessage with explicit-presence zero", &gmproto.StartAckMessage{Count: proto.Int32(0)}),
		enc("GetOrCreateConversationRequest with explicit-presence empty and false", &gmproto.GetOrCreateConversationRequest{
			RCSGroupName:   proto.String(""),
			CreateRCSGroup: proto.Bool(false),
		}),
		enc("RPCMessageData with bools and bytes", &gmproto.RPCMessageData{
			SessionID:       "session",
			Timestamp:       1730000000999999,
			Action:          gmproto.ActionType_LIST_CONVERSATIONS,
			UnencryptedData: []byte{0},
			Bool1:           true,
			Bool3:           true,
			EncryptedData:   seqBytes(17, 200),
		}),
		enc("Config with repeated uint32 and int64", &gmproto.Config{
			ClientVersion: "20260318",
			UnknownInts:   []uint32{0, 1, 4294967295, 7},
			GeneratedAtMS: 1730000000123,
			IntFlags: []*gmproto.Config_Flag{
				{Key: "k", Value: 1, UnknownField4: proto.String("")},
			},
		}),
		enc("Settings.SomeData with repeated bytes including empty", &gmproto.SomeData{
			PushEnabled: true,
			SomeEmojis:  [][]byte{{0xf0, 0x9f, 0x98, 0x80}, {}, seqBytes(5, 250)},
			JsonData:    `{"a":"<b>"}`,
		}),
		enc("ThumbnailData with unset fixed64 member", &gmproto.ThumbnailData{
			ImageBuffer:    []byte{1, 2, 3},
			SomeInt:        -7,
			MysteriousData: &gmproto.ThumbnailData_MysteriousData{},
		}),
		enc("BrowserDetails (libgm BrowserDetailsMessage)", util.BrowserDetailsMessage),
		enc("ConfigVersion (libgm ConfigMessage)", util.ConfigMessage),
		enc("EmptyArr", &gmproto.EmptyArr{}),
		enc("AuthMessage with nothing set", &gmproto.AuthMessage{}),
	}
}

func decodeCases() []decodeCase {
	return []decodeCase{
		dec("int64 as decimal string, trailing extra elements, nulls", "authentication.RegisterRefreshRequest",
			`[[ "req" , null, "Bugle", "AQID", [null,null,2026,3,18,null,4,null,6]], ["-42","src"], "1730000000123456", "c2lnbmF0dXJl", null, null, null, null, null, null, null, null, [null,null,null,null,null,null,null,null,[],null,null,null,null,null,null,null,null,null,null,null,null,null,[3]], null, null, 2, "extra", {"ignored": true}, [1,2,3], 4.5]`),
		dec("int64 as JSON number above 2^53 rounds through float64", "authentication.Device",
			`[1700000000000000123, "s", "n"]`),
		dec("int64 as JSON number with exponent and fraction", "authentication.RegisterRefreshRequest",
			`[null, [-3.99e2], 1.73e15]`),
		dec("int32 from strings with sign and leading zeros", "authentication.ConfigVersion",
			`[null, null, "2026", "+3", "-018", null, "007", null, "-2147483648"]`),
		dec("int32 from fractional numbers truncates toward zero", "authentication.ConfigVersion",
			`[null, null, 3.9, -3.9, 0.5, null, 2147483647, null, -0]`),
		dec("uint64 from decimal string beyond 2^53", "authentication.SignInGaiaResponse",
			`[[null, "18446744073709551615", null, "-9223372036854775808"]]`),
		dec("bool from number and bool", "rpc.RPCMessageData",
			`[null, null, null, null, null, 1, 0, null, 2.5]`),
		dec("bool false and zero values stay unset", "rpc.RPCMessageData",
			`["", null, 0, 0, "", false, false, "", 0, null, ""]`),
		dec("enum from number", "authentication.BrowserDetails",
			`["ua", 2.0, "os", null, null, 3]`),
		dec("empty arrays set sub-messages but not lists", "client.AckMessageRequest",
			`[[], [], null, []]`),
		dec("repeated messages and empty elements", "client.AckMessageRequest",
			`[null, [], null, [["a", ["1", "s"]], [], ["c"]]]`),
		dec("pblite_binary message and string", "authentication.SignInGaiaRequest",
			`[null, [[3, "dev"], null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, "GgMBAgM="], 1, "GDitto"]`),
		dec("pblite_binary string with non-ASCII UTF-8", "authentication.SignInGaiaResponse",
			`[null, "w7xuw69jw7Zkw6kgPCY+IPCfmIA="]`),
		dec("repeated pblite_binary strings", "rpc.OutgoingRPCMessage",
			`[null, null, null, null, "2592000000000", null, null, null, ["YWJj", "", "w7w="]]`),
		dec("base64 with embedded newlines and non-zero trailing bits", "rpc.RPCMessageData",
			"[null, null, null, null, \"YWJj\\r\\nZGVm\", null, null, \"AB==\", null, null, \"QUJD\\nRA==\"]"),
		dec("oneof: last declared member wins", "client.UpdateConversationRequest",
			`[["from-updateData"], 1, "c", null, null, ["from-deleteData"]]`),
		dec("oneof scalar zero is selected", "config.Config.WrappedFlag.Value",
			`[null, 0]`),
		dec("oneof scalar: later member overrides earlier", "config.Config.WrappedFlag.Value",
			`[null, 7, "seven"]`),
		dec("explicit presence zero values are kept", "client.GetOrCreateConversationRequest",
			`[null, [], "", false]`),
		dec("JSON escapes, surrogate pairs and lone surrogates", "authentication.AuthMessage",
			`["\u003c\u0026\u003e \ud83d\ude00 \u00e9 \n\t\"\\/", null, "lone \ud800 surrogate \udc00 end"]`),
		dec("optional message heartbeat", "rpc.LongPollingPayload",
			`[null, null, [], [0]]`),
		dec("whitespace around JSON", "util.EmptyArr", " \n [ ] \t"),
		dec("list of strings with empty element", "client.GetThumbnailRequest",
			`[["a", "b", ""]]`),
		dec("repeated uint32 from numbers and strings", "config.Config",
			`["v", null, [["k", "3", null, ""]], null, null, null, null, [0, "4294967295", 1.9, "007"], "-1730000000123"]`),
		dec("repeated bytes", "settings.SomeData",
			`[null, null, 1, null, null, null, null, null, null, null, null, null, null, null, ["8J+YgA==", "", "AQ=="]]`),
		dec("null fixed64 value is skipped", "client.ThumbnailData.MysteriousData",
			`[null, null, null, null, null, null, null, null, null, null, null, null, null]`),
		decArch("int32 from out-of-range numbers", "authentication.ConfigVersion",
			`[null, null, 3e9, -3e9, 2147483648, null, -2147483649, null, 1e300]`),
		decArch("enum from out-of-range number", "authentication.BrowserDetails",
			`[null, 3e9, null, null, null, -2147483649]`),
		decArch("int64 from out-of-range numbers", "authentication.RegisterRefreshRequest",
			`[null, [9.3e18], -1e300]`),
		decArch("uint32 list from negative and out-of-range numbers", "config.Config",
			`[null, null, null, null, null, null, null, [-1, -1.5, -3e9, 5e9, 4294967296, 9.3e18, -1e300]]`),
		decArch("uint64 from negative numbers and values at or above 2^63", "rpc.IncomingRPCMessage",
			`[null, null, -1, null, null, 9.3e18, 1.8446744073709552e19]`),
		decArch("uint64 from large negative and huge numbers", "rpc.IncomingRPCMessage",
			`[null, null, -9.3e18, null, null, 2e19, -1.5]`),
	}
}

func encodeErrorCases() []encodeErrorCase {
	return []encodeErrorCase{
		encErr("fixed64 field is unsupported", &gmproto.ThumbnailData_MysteriousData{MaybeAHash: 1}, "client.ThumbnailData.MysteriousData.maybeAHash"),
		encErr("unsupported field nested in a sub-message", &gmproto.ThumbnailData{
			ImageBuffer:    []byte{1},
			MysteriousData: &gmproto.ThumbnailData_MysteriousData{MaybeAHash: 18446744073709551615},
		}, "client.ThumbnailData.MysteriousData.maybeAHash"),
	}
}

func decodeErrorCases() []decodeErrorCase {
	return []decodeErrorCase{
		decErrDoc("invalid JSON", "authentication.AuthMessage", `[1,`),
		decErrDoc("top-level object", "authentication.AuthMessage", `{"a":1}`),
		decErrDoc("top-level string", "authentication.AuthMessage", `"abc"`),
		decErrDoc("top-level null", "authentication.AuthMessage", `null`),
		decErrDoc("number overflowing float64", "authentication.AuthMessage", `[null, null, null, null, null, null, null, 1e400]`),
		decErrDoc("byte order mark before JSON", "authentication.AuthMessage", "\ufeff[]"),
		decErrUnsupported("fixed64 value present", "client.ThumbnailData.MysteriousData", `[null, null, null, null, null, null, null, null, null, null, null, null, 5]`, "client.ThumbnailData.MysteriousData.maybeAHash"),
		decErr("string field given number", "authentication.AuthMessage", `[1]`, "authentication.AuthMessage.requestID", 0),
		decErr("int32 field given bool", "authentication.ConfigVersion", `[null, null, true]`, "authentication.ConfigVersion.Year", 2),
		decErr("int32 string out of range", "authentication.ConfigVersion", `[null, null, null, "2147483648"]`, "authentication.ConfigVersion.Month", 3),
		decErr("int32 string not decimal", "authentication.ConfigVersion", `[null, null, null, null, "0x10"]`, "authentication.ConfigVersion.Day", 4),
		decErr("int64 string with fraction", "authentication.Device", `["1.5"]`, "authentication.Device.userID", 0),
		decErr("uint64 string negative", "authentication.SignInGaiaResponse.Header", `[null, "-1"]`, "authentication.SignInGaiaResponse.Header.unknownInt2", 1),
		decErr("uint64 string with plus sign", "authentication.SignInGaiaResponse.Header", `[null, "+1"]`, "authentication.SignInGaiaResponse.Header.unknownInt2", 1),
		decErr("bytes invalid base64 length", "authentication.AuthMessage", `[null, null, null, null, null, "abc"]`, "authentication.AuthMessage.tachyonAuthToken", 5),
		decErr("bytes invalid base64 alphabet", "authentication.AuthMessage", `[null, null, null, null, null, "ab-_"]`, "authentication.AuthMessage.tachyonAuthToken", 5),
		decErr("bytes base64 without padding", "authentication.AuthMessage", `[null, null, null, null, null, "YWI"]`, "authentication.AuthMessage.tachyonAuthToken", 5),
		decErr("bytes data after padding", "authentication.AuthMessage", `[null, null, null, null, null, "YQ==YQ=="]`, "authentication.AuthMessage.tachyonAuthToken", 5),
		decErr("bytes given array", "authentication.AuthMessage", `[null, null, null, null, null, [1]]`, "authentication.AuthMessage.tachyonAuthToken", 5),
		decErr("message field given string", "authentication.AuthMessage", `[null, null, null, null, null, null, "x"]`, "authentication.AuthMessage.configVersion", 6),
		decErr("nested message error reports nested field", "authentication.AuthMessage", `[null, null, null, null, null, null, [null, null, "y"]]`, "authentication.ConfigVersion.Year", 2),
		decErr("repeated field given object", "client.AckMessageRequest", `[null, null, null, {"a": 1}]`, "client.AckMessageRequest.acks", 3),
		decErr("null element inside repeated messages", "client.AckMessageRequest", `[null, null, null, [["a"], null]]`, "client.AckMessageRequest.acks", 1),
		decErr("null element inside repeated strings", "client.GetThumbnailRequest", `[["a", null]]`, "client.GetThumbnailRequest.identifiers", 1),
		decErr("enum given string", "authentication.BrowserDetails", `[null, "1"]`, "authentication.BrowserDetails.browserType", 1),
		decErr("bool given string", "rpc.RPCMessageData", `[null, null, null, null, null, "true"]`, "rpc.RPCMessageData.bool1", 5),
		decErr("pblite_binary message given array", "authentication.SignInGaiaRequest.Inner", `[null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, []]`, "authentication.SignInGaiaRequest.Inner.someData", 35),
		decErr("pblite_binary message with truncated protobuf", "authentication.SignInGaiaRequest.Inner", `[null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, "GgU="]`, "authentication.SignInGaiaRequest.Inner.someData", 35),
		decErr("pblite_binary string invalid base64", "authentication.SignInGaiaResponse", `[null, "@@@@"]`, "authentication.SignInGaiaResponse.maybeBrowserUUID", 1),
		decErr("repeated pblite_binary string element invalid base64", "rpc.OutgoingRPCMessage", `[null, null, null, null, null, null, null, null, ["YWJj", "!"]]`, "rpc.OutgoingRPCMessage.destRegistrationIDs", 1),
	}
}

func floatBits(values []float64) []string {
	out := make([]string, len(values))
	for i, v := range values {
		out[i] = fmt.Sprintf("%016x", math.Float64bits(v))
	}
	return out
}

func floats() floatFormatting {
	negZero := math.Copysign(0, -1)
	doubles := []float64{
		0, negZero, 0.1, -2.5, 100, 1e20, 1e21, 1.5e21, 0.000001, 9.999999999999999e-7,
		1e-7, 1.5e-7, 2.5e-5, 123456789.123, 1e15 + 0.3, 9007199254740993, 5e-324,
		math.MaxFloat64, -1e300, math.SmallestNonzeroFloat64 * 3,
	}
	sources := []float64{0.1, 1.0 / 3, 3.4028234663852886e38, 1e-45, 16777217, negZero, 1e21, 1e-7, 2.5, 123456.789}
	widened := make([]float64, len(sources))
	for i, v := range sources {
		widened[i] = float64(float32(v))
	}
	return floatFormatting{
		DoubleBits:      floatBits(doubles),
		DoubleJSON:      string(must(json.Marshal(doubles))),
		FloatSourceBits: floatBits(sources),
		FloatJSON:       string(must(json.Marshal(widened))),
	}
}

func headerMap(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	keys := make([]string, 0, len(h))
	for k := range h {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		vals := h.Values(k)
		if len(vals) != 1 {
			panic(fmt.Errorf("header %s has %d values", k, len(vals)))
		}
		out[strings.ToLower(k)] = vals[0]
	}
	return out
}

func relayHeaders(contentType, accept string) map[string]string {
	req := must(http.NewRequest(http.MethodPost, util.SendMessageURL, nil))
	util.BuildRelayHeaders(req, contentType, accept)
	return headerMap(req.Header)
}

// configHeaders mirrors (*libgm.Client).fetchConfig.
func configHeaders() map[string]string {
	req := must(http.NewRequest(http.MethodGet, util.ConfigURL, nil))
	util.BuildRelayHeaders(req, "", "*/*")
	req.Header.Set("sec-fetch-site", "same-origin")
	req.Header.Del("x-user-agent")
	req.Header.Del("origin")
	return headerMap(req.Header)
}

func uploadHeaders() map[string]string {
	req := must(http.NewRequest(http.MethodPost, util.UploadMediaURL, nil))
	util.BuildUploadHeaders(req, "bWV0YWRhdGE=")
	return headerMap(req.Header)
}

func constants() constantsFixtures {
	return constantsFixtures{
		Generator:            generatorNote,
		RelayHeadersPblite:   relayHeaders("application/json+protobuf", "*/*"),
		RelayHeadersProtobuf: relayHeaders("application/x-protobuf", "*/*"),
		RelayHeadersNoBody:   relayHeaders("", "*/*"),
		ConfigHeaders:        configHeaders(),
		UploadHeaders:        uploadHeaders(),
		MediaUploadStart:     headerMap(*util.NewMediaUploadHeaders("12345", "start", "", "image/jpeg", "resumable")),
		MediaUploadFinalize:  headerMap(*util.NewMediaUploadHeaders("12345", "upload, finalize", "0", "image/jpeg", "")),
		ConfigVersionBase64:  b64(must(proto.Marshal(util.ConfigMessage))),
		BrowserDetailsBase64: b64(must(proto.Marshal(util.BrowserDetailsMessage))),
		Strings: map[string]string{
			"GoogleAPIKey":             util.GoogleAPIKey,
			"UserAgent":                util.UserAgent,
			"SecUA":                    util.SecUA,
			"UAPlatform":               util.UAPlatform,
			"XUserAgent":               util.XUserAgent,
			"QRCodeURLBase":            util.QRCodeURLBase,
			"SecUAMobile":              util.SecUAMobile,
			"QRNetwork":                util.QRNetwork,
			"GoogleNetwork":            util.GoogleNetwork,
			"MessagesBaseURL":          util.MessagesBaseURL,
			"GoogleAuthenticationURL":  util.GoogleAuthenticationURL,
			"GoogleTimesourceURL":      util.GoogleTimesourceURL,
			"UploadMediaURL":           util.UploadMediaURL,
			"RegisterPhoneRelayURL":    util.RegisterPhoneRelayURL,
			"RefreshPhoneRelayURL":     util.RefreshPhoneRelayURL,
			"GetWebEncryptionKeyURL":   util.GetWebEncryptionKeyURL,
			"RevokeRelayPairingURL":    util.RevokeRelayPairingURL,
			"ReceiveMessagesURL":       util.ReceiveMessagesURL,
			"SendMessageURL":           util.SendMessageURL,
			"AckMessagesURL":           util.AckMessagesURL,
			"ReceiveMessagesURLGoogle": util.ReceiveMessagesURLGoogle,
			"SendMessageURLGoogle":     util.SendMessageURLGoogle,
			"AckMessagesURLGoogle":     util.AckMessagesURLGoogle,
			"SignInGaiaURL":            util.SignInGaiaURL,
			"RegisterRefreshURL":       util.RegisterRefreshURL,
			"ConfigURL":                util.ConfigURL,
		},
	}
}

func writeJSON(path string, v any) {
	var buf bytes.Buffer
	e := json.NewEncoder(&buf)
	e.SetEscapeHTML(false)
	e.SetIndent("", "  ")
	if err := e.Encode(v); err != nil {
		panic(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		panic(err)
	}
	fmt.Fprintf(os.Stderr, "wrote %s\n", path)
}

func main() {
	out := flag.String("out", "../../../src/lib/gm/__fixtures__", "fixture output directory")
	flag.Parse()
	if err := os.MkdirAll(*out, 0o755); err != nil {
		panic(err)
	}
	writeJSON(filepath.Join(*out, "pblite.json"), pbliteFixtures{
		Generator:       generatorNote,
		GoArch:          runtime.GOARCH,
		Encode:          encodeCases(),
		EncodeErrors:    encodeErrorCases(),
		Decode:          decodeCases(),
		DecodeErrors:    decodeErrorCases(),
		FloatFormatting: floats(),
	})
	writeJSON(filepath.Join(*out, "pblite-constants.json"), constants())
}
