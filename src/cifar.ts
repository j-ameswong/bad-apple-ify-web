import { BufferReader, Parser } from 'pickleparser';

const CIFAR_ROW_BYTES = 32 * 32 * 3;
const MAX_PICKLE_BYTES = 512 * 1024 * 1024;
const MAX_IMAGES = Math.floor(MAX_PICKLE_BYTES / CIFAR_ROW_BYTES);

class BytePreservingReader extends BufferReader {
  override string(size: number, encoding: 'ascii' | 'utf-8'): string {
    const bytes = this.bytes(size);
    if (encoding === 'utf-8') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Pickle BINSTRING is a byte sequence; TextDecoder('ascii') maps bytes 0x80-ff
    // through Windows-1252 and corrupts genuine CIFAR pixels.
    return bytes as unknown as string;
  }
  override line(): string {
    const chars: number[] = [];
    let byte: number;
    while ((byte = this.byte()) !== 10) {
      if (chars.length >= 4096) throw new RangeError('CIFAR pickle text line exceeds 4 KiB');
      chars.push(byte);
    }
    return String.fromCharCode(...chars);
  }
}

class SafeDType {
  readonly code: string;
  constructor(code: unknown) { this.code = byteString(code); }
  __setstate__(_state: unknown): void {
    if (!['u1', '|u1', '<u1'].includes(this.code)) throw new TypeError('CIFAR array dtype must be uint8');
  }
}
class SafeArray {
  shape: number[] = [];
  data: Uint8Array = new Uint8Array();
  __setstate__(state: unknown): void {
    if (!Array.isArray(state) || state.length !== 5) throw new TypeError('invalid CIFAR ndarray state');
    const [version, shape, dtype, fortran, data] = state;
    validateShape(shape);
    if (version !== 1 || !(dtype instanceof SafeDType) || !['u1', '|u1', '<u1'].includes(dtype.code) || fortran !== false || !(data instanceof Uint8Array) || data.byteLength !== shape[0] * CIFAR_ROW_BYTES) throw new TypeError('invalid CIFAR ndarray dtype, layout, or data length');
    this.shape = shape;
    this.data = data;
  }
}

const resolver = {
  resolve(module: string, name: string): (...args: never[]) => unknown {
    if ((module === 'numpy.core.multiarray' || module === 'numpy._core.multiarray') && name === '_reconstruct') return (() => new SafeArray()) as (...args: never[]) => unknown;
    if (module === 'numpy' && name === 'ndarray') return (() => undefined) as (...args: never[]) => unknown;
    if (module === 'numpy' && name === 'dtype') return ((code: unknown) => new SafeDType(code)) as (...args: never[]) => unknown;
    if ((module === 'numpy.core.numeric' || module === 'numpy._core.numeric') && name === '_frombuffer') return ((data: unknown, dtype: unknown, shape: unknown, order: unknown) => {
      validateShape(shape);
      if (!(dtype instanceof SafeDType) || !['u1', '|u1', '<u1'].includes(dtype.code) || order !== 'C' || !(data instanceof Uint8Array) || data.byteLength !== (shape as number[])[0] * CIFAR_ROW_BYTES) throw new TypeError('invalid CIFAR frombuffer array');
      const arr = new SafeArray(); arr.shape = shape as number[]; arr.data = data; return arr;
    }) as (...args: never[]) => unknown;
    if (module === '_codecs' && name === 'encode') return ((value: unknown, encoding: unknown) => {
      if (typeof value !== 'string' || encoding !== 'latin1') throw new TypeError('unsupported CIFAR pickle codec');
      const bytes = new Uint8Array(value.length);
      for (let i = 0; i < value.length; i++) { const c = value.charCodeAt(i); if (c > 255) throw new TypeError('invalid latin1 CIFAR bytes'); bytes[i] = c; }
      return bytes;
    }) as (...args: never[]) => unknown;
    throw new TypeError(`unsupported pickle global ${module}.${name}`);
  },
};

function byteString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array && value.length <= 4) return String.fromCharCode(...value);
  throw new TypeError('invalid CIFAR dtype descriptor');
}
function validateShape(shape: unknown): asserts shape is [number, number] {
  if (!Array.isArray(shape) || shape.length !== 2 || !Number.isSafeInteger(shape[0]) || shape[0] <= 0 || shape[0] > MAX_IMAGES || shape[1] !== CIFAR_ROW_BYTES) throw new RangeError('CIFAR data must have shape (count, 3072) with a bounded positive count');
}

/** Safely decode NumPy's CIFAR `data` array without allowing arbitrary pickle globals. */
export function parseCifarBatch(buffer: Uint8Array): { count: number; planarRgb: Uint8Array } {
  if (!(buffer instanceof Uint8Array) || buffer.byteLength === 0 || buffer.byteLength > MAX_PICKLE_BYTES) throw new RangeError('CIFAR pickle size must be between 1 byte and 512 MiB');
  try {
    const parser = new Parser({ nameResolver: resolver, unpicklingTypeOfDictionary: 'Map' });
    const result = parser.read<Map<unknown, unknown>>(new BytePreservingReader(buffer));
    // Python 2 CIFAR dictionaries serialize the ASCII key as BINSTRING, while
    // Python 3 uses a Unicode key. Map preserves both representations safely.
    const array = result instanceof Map ? (result.get('data') ?? [...result].find(([key]) => key instanceof Uint8Array && key.length === 4 && key[0] === 100 && key[1] === 97 && key[2] === 116 && key[3] === 97)?.[1]) : undefined;
    if (!(array instanceof SafeArray)) throw new TypeError('CIFAR pickle does not contain a supported data array');
    validateShape(array.shape);
    if (array.data.byteLength !== array.shape[0] * CIFAR_ROW_BYTES) throw new TypeError('CIFAR data length does not match its shape');
    return { count: array.shape[0], planarRgb: array.data };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(`invalid or unsupported CIFAR pickle: ${detail}`, { cause: error });
  }
}
