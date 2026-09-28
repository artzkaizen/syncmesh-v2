/**
 * React Native's dev-server lookup, typed here because the package ships no declaration for it.
 *
 * The deep path is the supported way to reach it — there is no public re-export — and the shape is
 * stated rather than inferred so a change upstream is a type error here instead of a silent `any`.
 *
 * **Not named after the module it declares**, which is the obvious thing to do and does not work:
 * TypeScript treats a `foo.d.ts` beside a `foo.ts` as that file's own emitted declaration and drops
 * it from the program, so the ambient declaration silently disappears and the import that needs it
 * reports `TS7016` instead.
 */
declare module "react-native/Libraries/Core/Devtools/getDevServer" {
  const getDevServer: () => {
    /** e.g. `http://10.1.72.5:8081/`; the host is the machine that served this bundle. */
    readonly url: string;
    readonly bundleLoadedFromServer: boolean;
  };
  export default getDevServer;
}
