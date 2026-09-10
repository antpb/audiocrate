/**
 * A complete, conforming portable kernel, assembled byte by byte.
 *
 * This is the reference for `renderers/kernels/wasmKernel.ts`'s ABI and the
 * proof that it is small enough to hit from anywhere. The DSP is one
 * multiply, deliberately: what is being demonstrated is the contract, and a
 * gain is the only DSP whose correct output a test can assert exactly.
 *
 * It is written as raw bytes rather than compiled from source because the
 * point is that a portable kernel is *just a freestanding module*. There is
 * no toolchain here, no emscripten runtime, no glue: one memory, one mutable
 * global, six exported functions, and a single import (`env.abort`) that is
 * never called. Anything that can emit that shape can ship a crate kernel.
 *
 * Memory layout, chosen so every pointer is nonzero (0 is how a module says
 * "no such channel"):
 *
 * | Offset | |
 * |---|---|
 * | 1024 | input, left, 128 f32 |
 * | 2048 | output, left |
 * | 3072 | input, right |
 * | 4096 | output, right |
 */

const IN_L = 1024;
const OUT_L = 2048;
const IN_R = 3072;
const OUT_R = 4096;

/** Param id `crate_set_param` accepts. Mirrored by the descriptor below. */
export const FIXTURE_GAIN_PARAM_ID = 0;

// ---- a minimum viable WASM encoder ---------------------------------------

function uleb(value: number): number[] {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

function sleb(value: number): number[] {
  const out: number[] = [];
  let v = value;
  for (;;) {
    const byte = v & 0x7f;
    v >>= 7;
    const signBit = (byte & 0x40) !== 0;
    if ((v === 0 && !signBit) || (v === -1 && signBit)) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

function f32le(value: number): number[] {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, value, true);
  return [buf.getUint8(0), buf.getUint8(1), buf.getUint8(2), buf.getUint8(3)];
}

function name(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  return [...uleb(bytes.length), ...bytes];
}

/** A vector: its length, then its items. */
function vec(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

function section(id: number, content: number[]): number[] {
  return [id, ...uleb(content.length), ...content];
}

// Opcodes used below, named so the bodies read as instructions.
const OP = {
  block: 0x02,
  loop: 0x03,
  if_: 0x04,
  else_: 0x05,
  end: 0x0b,
  br: 0x0c,
  brIf: 0x0d,
  localGet: 0x20,
  localSet: 0x21,
  globalGet: 0x23,
  globalSet: 0x24,
  f32Load: 0x2a,
  f32Store: 0x38,
  i32Const: 0x41,
  f32Const: 0x43,
  i32Eqz: 0x45,
  i32Eq: 0x46,
  i32GeS: 0x4e,
  i32Add: 0x6a,
  i32Mul: 0x6c,
  f32Mul: 0x94,
} as const;

const VOID_BLOCK = 0x40;
const I32 = 0x7f;
const F32 = 0x7d;

const i32c = (v: number): number[] => [OP.i32Const, ...sleb(v)];
const get = (i: number): number[] => [OP.localGet, ...uleb(i)];

/** `base + i * 4`, the byte offset of frame `i` in a f32 block. */
const frameAddr = (local: number, base: number): number[] => [
  ...get(local),
  ...i32c(4),
  OP.i32Mul,
  ...i32c(base),
  OP.i32Add,
];

/** `dst[i] = src[i] * gain`, both addressed off local `i`. */
const scaleFrame = (local: number, src: number, dst: number): number[] => [
  ...frameAddr(local, dst),
  ...frameAddr(local, src),
  OP.f32Load,
  0x02,
  0x00,
  OP.globalGet,
  0x00,
  OP.f32Mul,
  OP.f32Store,
  0x02,
  0x00,
];

/** A function body: its local declarations, its instructions, and `end`. */
function body(locals: number[][], code: number[]): number[] {
  const content = [...vec(locals), ...code, OP.end];
  return [...uleb(content.length), ...content];
}

/**
 * Builds the fixture module. Returns fresh bytes each call so a test can
 * instantiate several independent kernels.
 */
export function buildWasmKernelFixture(): Uint8Array {
  const types = vec([
    [0x60, ...uleb(0), 0x01, I32], // 0: () -> i32
    [0x60, 0x02, I32, I32, 0x01, I32], // 1: (i32, i32) -> i32
    [0x60, 0x02, I32, I32, 0x00], // 2: (i32, i32) -> ()
    [0x60, 0x03, I32, I32, F32, 0x00], // 3: (i32, i32, f32) -> ()
    [0x60, 0x01, I32, 0x01, I32], // 4: (i32) -> i32
  ]);

  // crate_abi_version, crate_init, crate_input_ptr, crate_output_ptr,
  // crate_process, crate_set_param, crate_latency.
  const functions = vec([[0], [1], [1], [1], [2], [3], [4]]);

  const memory = vec([[0x00, ...uleb(1)]]); // one page, no maximum

  const globals = vec([[F32, 0x01, OP.f32Const, ...f32le(1), OP.end]]); // gain, starts at unity

  const exports = vec([
    [...name('memory'), 0x02, ...uleb(0)],
    [...name('crate_abi_version'), 0x00, ...uleb(0)],
    [...name('crate_init'), 0x00, ...uleb(1)],
    [...name('crate_input_ptr'), 0x00, ...uleb(2)],
    [...name('crate_output_ptr'), 0x00, ...uleb(3)],
    [...name('crate_process'), 0x00, ...uleb(4)],
    [...name('crate_set_param'), 0x00, ...uleb(5)],
    [...name('crate_latency'), 0x00, ...uleb(6)],
  ]);

  // `channel == 0 ? left : channel == 1 ? right : 0`. An unknown channel
  // index answers 0 rather than trapping, which is how a module says it does
  // not have that side.
  const channelPtr = (left: number, right: number): number[] => [
    ...get(1),
    OP.i32Eqz,
    OP.if_,
    I32,
    ...i32c(left),
    OP.else_,
    ...get(1),
    ...i32c(1),
    OP.i32Eq,
    OP.if_,
    I32,
    ...i32c(right),
    OP.else_,
    ...i32c(0),
    OP.end,
    OP.end,
  ];

  const code = vec([
    body([], i32c(1)), // crate_abi_version -> 1
    body([], i32c(1)), // crate_init -> handle 1
    body([], channelPtr(IN_L, IN_R)),
    body([], channelPtr(OUT_L, OUT_R)),
    body(
      [[1, I32]], // local 2: the frame counter
      [
        OP.block,
        VOID_BLOCK,
        OP.loop,
        VOID_BLOCK,
        ...get(2),
        ...get(1),
        OP.i32GeS,
        OP.brIf,
        ...uleb(1), // out of the block, past the loop
        ...scaleFrame(2, IN_L, OUT_L),
        ...scaleFrame(2, IN_R, OUT_R),
        ...get(2),
        ...i32c(1),
        OP.i32Add,
        OP.localSet,
        ...uleb(2),
        OP.br,
        ...uleb(0),
        OP.end,
        OP.end,
      ],
    ),
    body(
      [],
      [
        ...get(1),
        OP.i32Eqz, // param id 0 is the gain
        OP.if_,
        VOID_BLOCK,
        ...get(2),
        OP.globalSet,
        ...uleb(0),
        OP.end,
      ],
    ),
    body([], i32c(0)), // crate_latency -> 0
  ]);

  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d, // "\0asm"
    0x01,
    0x00,
    0x00,
    0x00, // version 1
    ...section(1, types),
    ...section(3, functions),
    ...section(5, memory),
    ...section(6, globals),
    ...section(7, exports),
    ...section(10, code),
  ]);
}

/** The descriptor that ships beside those bytes. Plain JSON, on purpose. */
export const WASM_KERNEL_FIXTURE_DESCRIPTOR = {
  abi: 1,
  name: 'fixture.gain',
  mode: 'seam',
  params: { gain: FIXTURE_GAIN_PARAM_ID },
  latencySamples: 0,
} as const;
