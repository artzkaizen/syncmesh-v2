/**
 * The ambient types a fresh checkout lacks: Uniwind's `className` props and Expo's CSS imports.
 * Metro writes `src/uniwind-types.d.ts` and `expo-env.d.ts` on first run (both ignored), so a
 * type-check that never ran Metro would otherwise see neither.
 */
/// <reference types="uniwind/types" />
/// <reference types="expo/types" />
