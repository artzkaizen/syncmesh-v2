// Expo writes the same reference to the gitignored expo-env.d.ts when it starts; this one is
// committed so a type check that never ran Expo still knows `import "../global.css"`.
/// <reference types="expo/types" />
