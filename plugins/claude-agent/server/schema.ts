// Compile-time JSON Schema verification helpers tying tool `inputSchema` definitions to `ToolInputs`.

type Permutations<U, A = U> = [U] extends [never] ? [] : A extends unknown ? [A, ...Permutations<Exclude<U, A>>] : never

type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T]

declare const ALL_OF: unique symbol

export type AllOf<V extends string> = readonly V[] & { readonly [ALL_OF]: (value: V) => V }

type HasDuplicate<A extends readonly unknown[]> = A extends readonly [infer H, ...infer R] ? (H extends R[number] ? true : HasDuplicate<R>) : false

type PropertySchema<V> = { description?: string } & (unknown extends V
  ? unknown
  : [V] extends [boolean]
    ? boolean extends V
      ? { type: 'boolean' }
      : never
    : [V] extends [number]
      ? number extends V
        ? { type: 'number' } | { type: 'integer' }
        : never
      : [V] extends [string]
        ? string extends V
          ? { type: 'string' }
          : { type: 'string'; enum: AllOf<V> }
        : [V] extends [readonly (infer I)[]]
          ? { type: 'array'; items: PropertySchema<I> }
          : [V] extends [string | number]
            ? [string | number] extends [V]
              ? { type: readonly ['string', 'number'] } | { type: readonly ['string', 'integer'] }
              : never
            : never)

export type SchemaFor<T> = {
  type: 'object'
  properties: { [K in keyof T]-?: PropertySchema<Required<T>[K]> }
} & ([RequiredKeys<T>] extends [never] ? { required?: [] } : { required: Permutations<RequiredKeys<T>> })

export const allOf =
  <V extends string | undefined>() =>
  <const A extends readonly Exclude<V, undefined>[]>(
    ...values: A &
      (number extends A['length']
        ? never
        : [Exclude<V, undefined | A[number]>] extends [never]
          ? HasDuplicate<A> extends true
            ? never
            : unknown
          : never)
  ): A & AllOf<Exclude<V, undefined>> =>
    values as unknown as A & AllOf<Exclude<V, undefined>>
