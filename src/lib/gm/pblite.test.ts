import { describe, expect, test } from "bun:test";
import {
  create,
  createFileRegistry,
  createRegistry,
  equals,
  fromBinary,
  toBinary,
  type DescField,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";
import { reflect } from "@bufbuild/protobuf/reflect";
import { base64Decode } from "@bufbuild/protobuf/wire";
import {
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FileDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";

import {
  DeviceSchema,
  file_authentication,
  SignInGaiaRequest_InnerSchema,
} from "@/gen/gmproto/authentication_pb";
import { file_client, UpdateConversationRequestSchema } from "@/gen/gmproto/client_pb";
import { ConfigSchema, file_config } from "@/gen/gmproto/config_pb";
import { file_conversations } from "@/gen/gmproto/conversations_pb";
import { file_events } from "@/gen/gmproto/events_pb";
import {
  file_rpc,
  OutgoingRPCMessageSchema,
  StartAckMessageSchema,
} from "@/gen/gmproto/rpc_pb";
import { file_settings } from "@/gen/gmproto/settings_pb";
import { file_ukey } from "@/gen/gmproto/ukey_pb";
import { file_util } from "@/gen/gmproto/util_pb";

import fixtures from "./__fixtures__/pblite.json";
import {
  Pblite,
  PbliteFieldError,
  PbliteUnsupportedFieldError,
  PbliteUnsupportedValueError,
} from "./pblite";

const registry = createRegistry(
  file_authentication,
  file_client,
  file_config,
  file_conversations,
  file_events,
  file_rpc,
  file_settings,
  file_ukey,
  file_util,
);

function schemaFor(typeName: string): DescMessage {
  const schema = registry.getMessage(typeName);
  if (schema === undefined) {
    throw new Error(`fixture names unknown message type ${typeName}`);
  }
  return schema;
}

function fieldNamed(desc: DescMessage, name: string): DescField {
  const field = desc.fields.find((f) => f.name === name);
  if (field === undefined) throw new Error(`${desc.typeName} has no field ${name}`);
  return field;
}

function listNamed(desc: DescMessage, name: string): Extract<DescField, { fieldKind: "list" }> {
  const field = fieldNamed(desc, name);
  if (field.fieldKind !== "list") throw new Error(`${name} is not a list`);
  return field;
}

function mapNamed(desc: DescMessage, name: string): Extract<DescField, { fieldKind: "map" }> {
  const field = fieldNamed(desc, name);
  if (field.fieldKind !== "map") throw new Error(`${name} is not a map`);
  return field;
}

// Go's float->int conversions for out-of-range JSON numbers are arch-defined;
// pblite.ts reproduces amd64.
const archMatches = fixtures.goarch === "amd64";

/**
 * Asserts `actual` is the message Go encoded as `goBinaryBase64`. Go and
 * protobuf-es order oneof members differently on the wire, so both sides are
 * compared semantically and in protobuf-es's canonical encoding (which also
 * covers unknown fields).
 */
function expectGoMessage(
  schema: DescMessage,
  actual: MessageShape<DescMessage>,
  goBinaryBase64: string,
): void {
  const expected = fromBinary(schema, base64Decode(goBinaryBase64));
  expect(equals(schema, actual, expected)).toBe(true);
  expect(toBinary(schema, actual)).toEqual(toBinary(schema, expected));
}

describe("encode parity with Go pblite.Marshal", () => {
  for (const c of fixtures.encode) {
    test(c.name, () => {
      const schema = schemaFor(c.protoTypeName);
      const message = fromBinary(schema, base64Decode(c.binaryBase64));
      expect(Pblite.marshal(schema, message)).toBe(c.pbliteJSON);
    });

    test.skipIf(c.roundTripArchDependent && !archMatches)(
      `${c.name}: JSON round trip matches Go`,
      () => {
        const schema = schemaFor(c.protoTypeName);
        const decoded = Pblite.unmarshal(schema, c.pbliteJSON);
        if (decoded.isErr()) throw decoded.error;
        expectGoMessage(schema, decoded.value, c.roundTripBinaryBase64);
      },
    );

    test(`${c.name}: serialize output decodes losslessly`, () => {
      const schema = schemaFor(c.protoTypeName);
      const message = fromBinary(schema, base64Decode(c.binaryBase64));
      const decoded = Pblite.unmarshal(schema, Pblite.serialize(schema, message));
      if (decoded.isErr()) throw decoded.error;
      expectGoMessage(schema, decoded.value, c.binaryBase64);
    });
  }
});

describe("encode errors match Go", () => {
  for (const c of fixtures.encodeErrors) {
    test(c.name, () => {
      const schema = schemaFor(c.protoTypeName);
      const message = fromBinary(schema, base64Decode(c.binaryBase64));
      let thrown: unknown;
      try {
        Pblite.marshal(schema, message);
      } catch (error) {
        thrown = error;
      }
      expect(PbliteUnsupportedFieldError.is(thrown)).toBe(true);
      if (!PbliteUnsupportedFieldError.is(thrown)) return;
      expect(thrown.field).toBe(c.field);
      expect(c.goError).toContain(thrown.fieldType);
    });
  }
});

describe("decode parity with Go pblite.Unmarshal", () => {
  for (const c of fixtures.decode) {
    test.skipIf(c.archDependent && !archMatches)(c.name, () => {
      const schema = schemaFor(c.protoTypeName);
      const decoded = Pblite.unmarshal(schema, c.pbliteJSON);
      if (decoded.isErr()) throw decoded.error;
      expectGoMessage(schema, decoded.value, c.binaryBase64);
    });
  }
});

describe("decode errors match Go", () => {
  for (const c of fixtures.decodeErrors) {
    test(c.name, () => {
      const decoded = Pblite.unmarshal(schemaFor(c.protoTypeName), c.pbliteJSON);
      if (decoded.isOk()) throw new Error(`expected failure, Go said: ${c.goError}`);
      const error = decoded.error;
      const location = c.location;
      if (location === null) {
        expect(error._tag).toBe("PbliteJsonError");
      } else if (location.index === null) {
        expect(error._tag).toBe("PbliteUnsupportedFieldError");
        if (PbliteUnsupportedFieldError.is(error)) expect(error.field).toBe(location.field);
      } else {
        expect(error._tag).toBe("PbliteFieldError");
        if (PbliteFieldError.is(error)) {
          expect(error.field).toBe(location.field);
          expect(error.index).toBe(location.index);
        }
      }
    });
  }
});

// No gmproto message has float, double, map or sint fields, so these use a
// synthetic schema.
const synthetic = createFileRegistry(
  create(FileDescriptorProtoSchema, {
    name: "pblite_test.proto",
    package: "pblitetest",
    syntax: "proto3",
    messageType: [
      {
        name: "Kinds",
        field: [
          {
            name: "doubles",
            number: 1,
            label: FieldDescriptorProto_Label.REPEATED,
            type: FieldDescriptorProto_Type.DOUBLE,
          },
          {
            name: "floats",
            number: 2,
            label: FieldDescriptorProto_Label.REPEATED,
            type: FieldDescriptorProto_Type.FLOAT,
          },
          {
            name: "labels",
            number: 3,
            label: FieldDescriptorProto_Label.REPEATED,
            type: FieldDescriptorProto_Type.MESSAGE,
            typeName: ".pblitetest.Kinds.LabelsEntry",
          },
          {
            name: "zigzag",
            number: 4,
            label: FieldDescriptorProto_Label.OPTIONAL,
            type: FieldDescriptorProto_Type.SINT32,
          },
          {
            name: "single",
            number: 5,
            label: FieldDescriptorProto_Label.OPTIONAL,
            type: FieldDescriptorProto_Type.DOUBLE,
          },
        ],
        nestedType: [
          {
            name: "LabelsEntry",
            options: { mapEntry: true },
            field: [
              {
                name: "key",
                number: 1,
                label: FieldDescriptorProto_Label.OPTIONAL,
                type: FieldDescriptorProto_Type.STRING,
              },
              {
                name: "value",
                number: 2,
                label: FieldDescriptorProto_Label.OPTIONAL,
                type: FieldDescriptorProto_Type.STRING,
              },
            ],
          },
        ],
      },
    ],
  }),
  () => undefined,
);
const Kinds = synthetic.getMessage("pblitetest.Kinds");
if (Kinds === undefined) throw new Error("synthetic schema failed to build");

function float64FromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe("floats", () => {
  test("repeated double formats like Go encoding/json", () => {
    const r = reflect(Kinds);
    const list = r.get(listNamed(Kinds, "doubles"));
    for (const bits of fixtures.floatFormatting.doubleBits) list.add(float64FromBits(bits));
    expect(Pblite.marshal(Kinds, r.message)).toBe(
      `[${fixtures.floatFormatting.doubleJSON},null,null,null,null]`,
    );
  });

  test("repeated float is widened from float32 like Go", () => {
    const r = reflect(Kinds);
    const list = r.get(listNamed(Kinds, "floats"));
    for (const bits of fixtures.floatFormatting.floatSourceBits) {
      list.add(Math.fround(float64FromBits(bits)));
    }
    expect(Pblite.marshal(Kinds, r.message)).toBe(
      `[null,${fixtures.floatFormatting.floatJSON},null,null,null]`,
    );
  });

  test("NaN and Infinity cannot be marshalled", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = reflect(Kinds);
      r.set(fieldNamed(Kinds, "single"), value);
      expect(Pblite.serialize(Kinds, r.message)[4]).toBe(value);
      expect(() => Pblite.marshal(Kinds, r.message)).toThrow(PbliteUnsupportedValueError);
    }
  });

  test("-0 is set under implicit presence and round-trips", () => {
    const r = reflect(Kinds);
    r.set(fieldNamed(Kinds, "single"), -0);
    const json = Pblite.marshal(Kinds, r.message);
    expect(json).toBe("[null,null,null,null,-0]");
    const decoded = Pblite.unmarshal(Kinds, json);
    if (decoded.isErr()) throw decoded.error;
    expect(Object.is(reflect(Kinds, decoded.value).get(fieldNamed(Kinds, "single")), -0)).toBe(true);
  });
});

describe("unsupported kinds", () => {
  test("map fields are rejected only when present", () => {
    const empty = reflect(Kinds);
    expect(Pblite.marshal(Kinds, empty.message)).toBe("[null,null,null,null,null]");

    const r = reflect(Kinds);
    r.get(mapNamed(Kinds, "labels")).set("k", "v");
    expect(() => Pblite.marshal(Kinds, r.message)).toThrow(PbliteUnsupportedFieldError);

    const decoded = Pblite.unmarshal(Kinds, `[null,null,[["k","v"]]]`);
    expect(decoded.isErr() && decoded.error._tag).toBe("PbliteUnsupportedFieldError");
    expect(Pblite.unmarshal(Kinds, `[null,null,null]`).isOk()).toBe(true);
  });

  test("sint32 is rejected like Go", () => {
    const decoded = Pblite.unmarshal(Kinds, `[null,null,null,1]`);
    if (decoded.isOk()) throw new Error("expected failure");
    expect(PbliteUnsupportedFieldError.is(decoded.error)).toBe(true);
    if (PbliteUnsupportedFieldError.is(decoded.error)) {
      expect(decoded.error.field).toBe("pblitetest.Kinds.zigzag");
      expect(decoded.error.fieldType).toBe("sint32");
    }
  });
});

function encodeFixture(name: string): (typeof fixtures.encode)[number] {
  const found = fixtures.encode.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no encode fixture named ${name}`);
  return found;
}

// JS numbers can hold values Go's integer fields cannot: -0, fractions and
// out-of-range numbers in explicit-presence, oneof and repeated fields.
describe("integer values Go's types cannot hold", () => {
  test("-0 in integer and enum fields is written as Go writes 0", () => {
    const startAck = encodeFixture("StartAckMessage with explicit-presence zero");
    const negZeroAck = create(StartAckMessageSchema, { count: -0 });
    expect(Pblite.marshal(StartAckMessageSchema, negZeroAck)).toBe(startAck.pbliteJSON);

    const uints = encodeFixture("Config with repeated uint32 and int64");
    const config = fromBinary(ConfigSchema, base64Decode(uints.binaryBase64));
    expect(config.unknownInts[0]).toBe(0);
    config.unknownInts[0] = -0;
    expect(Pblite.marshal(ConfigSchema, config)).toBe(uints.pbliteJSON);

    const oneofEnum = encodeFixture("UpdateConversationRequest with oneof message member");
    const update = fromBinary(
      UpdateConversationRequestSchema,
      base64Decode(oneofEnum.binaryBase64),
    );
    if (update.data.case !== "updateData" || update.data.value.data.case !== "status") {
      throw new Error("fixture no longer holds an updateData status");
    }
    update.data.value.data.value = -0;
    expect(Pblite.marshal(UpdateConversationRequestSchema, update)).toBe(
      oneofEnum.pbliteJSON,
    );
  });

  test("fractions and out-of-range values are rejected, as by toBinary", () => {
    const cases: Array<[DescMessage, MessageShape<DescMessage>]> = [
      [StartAckMessageSchema, create(StartAckMessageSchema, { count: 1.5 })],
      [StartAckMessageSchema, create(StartAckMessageSchema, { count: 2 ** 31 })],
      [ConfigSchema, create(ConfigSchema, { unknownInts: [-1] })],
      [ConfigSchema, create(ConfigSchema, { unknownInts: [2 ** 32] })],
      [DeviceSchema, create(DeviceSchema, { userID: 1n << 63n })],
    ];
    for (const [schema, message] of cases) {
      expect(() => toBinary(schema, message)).toThrow();
      expect(() => Pblite.serialize(schema, message)).toThrow(PbliteUnsupportedValueError);
    }
  });
});

describe("JS-specific inputs", () => {
  test("serialize keeps 64-bit integers exact as bigint", () => {
    const device = create(DeviceSchema, {
      userID: 9007199254740993n,
      sourceID: "s",
    });
    expect(Pblite.serialize(DeviceSchema, device)).toEqual([9007199254740993n, "s", null]);
    expect(Pblite.marshal(DeviceSchema, device)).toBe(`[9007199254740993,"s",null]`);
  });

  test("lone surrogates are written as U+FFFD, matching their UTF-8 form", () => {
    const lone = String.fromCharCode(0xd800);
    const device = create(DeviceSchema, { sourceID: `a${lone}b` });
    const replacement = String.fromCharCode(0xfffd);
    expect(Pblite.marshal(DeviceSchema, device)).toBe(`[null,"a${replacement}b",null]`);
  });

  test("array input may contain undefined holes and bigint integers", () => {
    const decoded = Pblite.unmarshal(DeviceSchema, [-5n, undefined, "Bugle"]);
    if (decoded.isErr()) throw decoded.error;
    expect(decoded.value.userID).toBe(-5n);
    expect(decoded.value.network).toBe("Bugle");
  });

  test("out-of-range bigint is a field error", () => {
    const decoded = Pblite.unmarshal(DeviceSchema, [1n << 63n]);
    if (decoded.isOk()) throw new Error("expected failure");
    expect(decoded.error).toBeInstanceOf(PbliteFieldError);
  });

  test("errors do not echo field values", () => {
    const secret = "c2VjcmV0LXRva2Vu!";
    const decoded = Pblite.unmarshal(OutgoingRPCMessageSchema, [null, null, ["r", null, null, null, null, secret]]);
    if (decoded.isOk()) throw new Error("expected failure");
    expect(decoded.error.message).not.toContain(secret);
    expect(JSON.stringify(decoded.error)).not.toContain(secret);
  });

  test("pblite_binary message decodes into a typed sub-message", () => {
    const inner = Pblite.unmarshal(
      SignInGaiaRequest_InnerSchema,
      [null, ...Array<null>(34).fill(null), "GgMBAgM="],
    );
    if (inner.isErr()) throw inner.error;
    expect(inner.value.someData?.someData).toEqual(new Uint8Array([1, 2, 3]));
  });
});
