export const REGISTER_NAMES = ["A", "B", "C", "D"] as const;

export type RegisterName = (typeof REGISTER_NAMES)[number];

export type Operand =
  | { kind: "register"; name: RegisterName }
  | { kind: "memory"; address: number }
  | { kind: "indirectRegister"; register: RegisterName }
  | { kind: "indirectMemory"; pointerAddress: number }
  | { kind: "immediate"; value: bigint };

export type OpcodeName =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "mod"
  | "and"
  | "or"
  | "xor"
  | "shl"
  | "shr"
  | "ushr"
  | "rol"
  | "ror"
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "mov"
  | "neg"
  | "not"
  | "inc"
  | "dec"
  | "rand"
  | "jmp"
  | "jz"
  | "jnz"
  | "nop"
  | "halt"
  | "insert"
  | "delete"
  | "change";

export interface Instruction {
  id: number;
  opcode: OpcodeName;
  operands: Operand[];
  sourceLine?: number;
  generated?: boolean;
}

export interface Program {
  instructions: Instruction[];
  labels: Record<string, number>;
}

export interface SourceLocation {
  line: number;
  column: number;
}

export class EasmError extends Error {
  constructor(
    message: string,
    readonly location?: SourceLocation,
  ) {
    super(message);
    this.name = "EasmError";
  }
}

export type VmStatus = "ready" | "running" | "halted" | "error" | "limit";

export interface MutationEvent {
  step: number;
  kind: "insert" | "delete" | "change";
  index: number;
  before?: string;
  after?: string;
}

export interface TraceEvent {
  step: number;
  pc: number;
  instructionId: number;
  instruction: string;
}

export interface VmOptions {
  memorySize?: number;
  addressLimit?: number;
  initialMemory?: readonly bigint[];
  seed?: bigint;
  maxSteps?: number;
  traceLimit?: number;
}

export interface VmSnapshot {
  status: VmStatus;
  reason: string;
  pc: number | null;
  steps: number;
  registers: Record<RegisterName, string>;
  memory: string[];
  program: Array<{ id: number; text: string; generated: boolean }>;
  mutations: MutationEvent[];
  trace: TraceEvent[];
}
