// Test helper — a callable mock type.
//
// vitest 4 overloads `vi.fn` (plain function vs. constructor), so the widespread
// `ReturnType<typeof vi.fn>` idiom resolves to `Mock<Procedure | Constructable>`.
// That union is neither callable nor usable as `.mock.calls[0][0]`, because the
// constructor half contributes an empty `[]` argument tuple.
//
// Most call sites only ever configure the mock (`mockResolvedValue`, `toHaveBeenCalled`),
// which is fine on the union. Use `AnyMock` at the sites that invoke the mock directly
// or read its recorded arguments.
import type { Mock } from 'vitest'

export type AnyMock = Mock<(...args: any[]) => any>
