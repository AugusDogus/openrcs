package main

import (
	"fmt"

	"go.mau.fi/util/pblite"
	"google.golang.org/protobuf/proto"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

// buildFrames builds incoming long-poll frames the way the phone/Google would
// (encrypted with libgm's AESCTRHelper), serialized with Go pblite.
func buildFrames(ad *libgm.AuthData, activeSession string) ([]frame, error) {
	conversation := &gmproto.Conversation{
		ConversationID:       "conv-1",
		Name:                 "Ünïcode 😀 \"name\" [x]",
		LastMessageTimestamp: 1762435200123456,
		Unread:               true,
		IsGroupChat:          false,
		Participants: []*gmproto.Participant{
			{ID: &gmproto.SmallInfo{Type: gmproto.IdentifierType_PHONE, Number: "+15550001111", ParticipantID: "p-1"}, IsMe: true, SimPayload: &gmproto.SIMPayload{Two: 2, SIMNumber: 1}},
			{ID: &gmproto.SmallInfo{Type: gmproto.IdentifierType_PHONE, Number: "+15550002222", ParticipantID: "p-2"}, FullName: "Friend Two", FormattedNumber: "(555) 000-2222"},
		},
		LatestMessage: &gmproto.LatestMessage{DisplayContent: "see you 👋", DisplayName: "Friend Two"},
	}
	listResp := &gmproto.ListConversationsResponse{Conversations: []*gmproto.Conversation{conversation}, Cursor: &gmproto.Cursor{LastItemID: "conv-1", LastItemTimestamp: 1762435200123456}}
	message := &gmproto.Message{
		MessageID:      "msg-9",
		ConversationID: "conv-1",
		Timestamp:      1762435299000000,
		ParticipantID:  "p-2",
		TmpID:          "",
		MessageInfo: []*gmproto.MessageInfo{
			{Data: &gmproto.MessageInfo_MessageContent{MessageContent: &gmproto.MessageContent{Content: "incoming ✉️ \\ \"x\""}}},
			{Data: &gmproto.MessageInfo_MediaContent{MediaContent: &gmproto.MediaContent{Format: gmproto.MediaFormats_IMAGE_PNG, MediaID: "", ThumbnailMediaID: "thumb-1", MediaName: "photo.png", Size: 12345}}},
		},
		MessageStatus:     &gmproto.MessageStatus{Status: gmproto.MessageStatusType_INCOMING_COMPLETE},
		Reactions:         []*gmproto.ReactionEntry{{Data: &gmproto.ReactionData{Unicode: "❤️"}, ParticipantIDs: []string{"p-1", "p-2"}}},
		ReplyMessage:      &gmproto.ReplyMessage{MessageID: "msg-8"},
		SenderParticipant: &gmproto.Participant{ID: &gmproto.SmallInfo{Number: "+15550002222", ParticipantID: "p-2"}, FirstName: "Friend"},
	}
	updates := &gmproto.UpdateEvents{Event: &gmproto.UpdateEvents_MessageEvent{MessageEvent: &gmproto.MessageEvent{Data: []*gmproto.Message{message}}}}
	account := &gmproto.EncryptedData2Container{AccountChange: &gmproto.AccountChangeOrSomethingEvent{Account: "someone@example.com", Enabled: true}}
	paired := &gmproto.RPCPairData{Event: &gmproto.RPCPairData_Paired{Paired: &gmproto.PairedData{
		Mobile:    &gmproto.Device{UserID: 1, SourceID: "paired-mobile", Network: "Bugle"},
		TokenData: &gmproto.TokenData{TachyonAuthToken: seeded("frames/paired-token", 24), TTL: 86400000000},
		Browser:   &gmproto.Device{UserID: 2, SourceID: "paired-browser", Network: "Bugle"},
	}}}

	enc := func(m proto.Message) ([]byte, error) {
		b, err := proto.MarshalOptions{Deterministic: true}.Marshal(m)
		if err != nil {
			return nil, err
		}
		return ad.RequestCrypto.Encrypt(b)
	}
	listEnc, err := enc(listResp)
	if err != nil {
		return nil, err
	}
	updEnc, err := enc(updates)
	if err != nil {
		return nil, err
	}
	accEnc, err := enc(account)
	if err != nil {
		return nil, err
	}

	type spec struct {
		name  string
		route gmproto.BugleRoute
		data  proto.Message
	}
	specs := []spec{
		{"LIST_CONVERSATIONS response", gmproto.BugleRoute_DataEvent, &gmproto.RPCMessageData{SessionID: "list-request-id", Timestamp: 1762435200000001, Action: gmproto.ActionType_LIST_CONVERSATIONS, EncryptedData: listEnc}},
		{"GET_UPDATES message event", gmproto.BugleRoute_DataEvent, &gmproto.RPCMessageData{SessionID: activeSession, Timestamp: 1762435200000002, Action: gmproto.ActionType_GET_UPDATES, EncryptedData: updEnc}},
		{"GET_UPDATES account change (field 11)", gmproto.BugleRoute_DataEvent, &gmproto.RPCMessageData{SessionID: activeSession, Timestamp: 1762435200000003, Action: gmproto.ActionType_GET_UPDATES, EncryptedData2: accEnc}},
		{"GET_UPDATES logged out", gmproto.BugleRoute_DataEvent, &gmproto.RPCMessageData{SessionID: activeSession, Timestamp: 1762435200000004, Action: gmproto.ActionType_GET_UPDATES, UnencryptedData: []byte{0x72, 0x00}}},
		{"PairEvent paired", gmproto.BugleRoute_PairEvent, paired},
	}
	var out []frame
	for i, s := range specs {
		inner, err := proto.MarshalOptions{Deterministic: true}.Marshal(s.data)
		if err != nil {
			return nil, err
		}
		payload := &gmproto.LongPollingPayload{Data: &gmproto.IncomingRPCMessage{
			ResponseID:        fmt.Sprintf("resp-%d-%s", i, "ü"),
			BugleRoute:        s.route,
			StartExecute:      1762435200000000,
			MessageType:       gmproto.MessageType_BUGLE_MESSAGE,
			FinishExecute:     1762435200000100,
			MicrosecondsTaken: 100,
			Mobile:            ad.Mobile,
			Browser:           ad.Browser,
			MessageData:       inner,
			SignatureID:       "sig-\"]\\[",
			Timestamp:         "1762435200",
		}}
		js, err := pblite.Marshal(payload)
		if err != nil {
			return nil, err
		}
		out = append(out, frame{Name: s.name, JSON: string(js)})
	}
	return out, nil
}
