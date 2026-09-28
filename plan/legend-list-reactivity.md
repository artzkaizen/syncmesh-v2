# LegendList's reactivity graph, and what it means for syncmesh's lists

Studied 2026-09-23 from `LegendApp/legend-list` at `212bc13` (v3.4.0), cloned to `/tmp/legend-list`.
File references below are into that checkout. The question was: how does LegendList update items,
and why does the pattern scroll 120 rows on a phone without the list re-rendering?

## 1. The one-sentence answer

LegendList never re-renders the list when something changes. It runs a hand-written store of named
signals, gives every *physical container* (a recycled `View` slot) its own handful of signals, and
pushes changes to exactly the slot that owns them. React is used for two things only: mounting a
fixed pool of slots once, and re-rendering a single slot when one of *its* signals changes.

Everything else is imperative code over plain arrays and maps, outside React.

## 2. The store: `state.tsx`

`src/state/state.tsx` is 457 lines and is the whole reactive system. Its header comment says it:

> This is an implementation of a simple state management system, inspired by Legend State. It
> stores values and listeners in Maps, with `peek$` and `set$` functions to get and set values.
> The `set$` function also triggers the listeners.

```ts
export function set$(ctx, signalName, value) {
  const { listeners, values } = ctx;
  if (values.get(signalName) !== value) {       // identity dedupe — the one rule
    values.set(signalName, value);
    const setListeners = listeners.get(signalName);
    if (setListeners) for (const listener of setListeners) listener(value);
  }
}
export function peek$(ctx, signalName) { return ctx.values.get(signalName); }
export function listen$(ctx, signalName, cb) { /* add to Set, return remover */ }
```

Three properties matter:

- **Signals are strings, not objects.** `ListenerType` is a union of literal names plus template
  literals like `` `containerPosition${number}` ``. A container's signals are
  `containerItemKey7`, `containerItemIndex7`, `containerItemData7`, `containerPosition7`,
  `containerColumn7`, `containerSpan7`, `containerSticky7`, `containerLayoutReady7`. There is no
  allocation per signal, no proxy, no dependency tracking. The graph is the naming scheme.
- **`set$` dedupes by identity.** Writing the same value is a no-op. This is what lets the hot
  paths call `set$` freely: `calculateItemsInView` may write `containerPosition7` every scroll
  frame, and the slot only wakes when the number actually moved.
- **Reads are `peek$`, not hooks.** All the layout code reads the store with `peek$`, which
  subscribes to nothing. Only components subscribe, and only through `useArr$`.

### The bridge into React: `useArr$`

```ts
export function useArr$(signalNames) {
  const ctx = React.useContext(ContextState);
  const key = signalNames.join("\0");
  const { subscribe, get } = React.useMemo(() => createSelectorFunctionsArr(ctx, names), [ctx, key]);
  return useSyncExternalStore(subscribe, get, get);
}
```

`createSelectorFunctionsArr` reads every named signal with `peek$` and returns the *same array
reference* unless one element changed by identity. `useSyncExternalStore` then compares by
reference and skips the render. One component, N signals, one subscription per signal, one
render when any of them moves. That is the entire reactive surface a component sees.

There is also `useValue$`, which binds a signal to a React Native `Animated.Value` and updates it
in a layout effect with **no render at all**. The old-architecture position view uses this: a
scroll frame moves a `top` on the native side without React involvement.

## 3. The structure: a pool of slots, not a list of items

```
LegendList                       — owns the store (StateProvider), all layout math, onScroll
└─ Containers                    — subscribes to [numContainersPooled, numColumns]; renders N slots
   └─ ContainerSlot(id)          — subscribes to [containerItemKey{id}]; null if unassigned
      └─ Container(id, itemKey)  — subscribes to [column, span, itemData, numColumns, extraData, sticky]
         └─ PositionView(id)     — subscribes to [containerPosition{id}, itemKey, layoutReady]
            └─ ContextContainer.Provider {containerId, triggerLayout}
               └─ renderItem({ item, index, extraData })
```

Key facts about this tree (`src/components/Container*.tsx`, `PositionView*.tsx`):

- **The slot count is a signal, not the data length.** `Containers` renders `numContainersPooled`
  slots, sized from viewport ÷ estimated item size plus draw distance, then padded
  (`containerPool.ts`). For 120 rows on a phone that is a few dozen `View`s, mounted once.
- **Every layer is `memo`.** `Containers`, `ContainerSlot`, `Container`, `PositionView` are all
  `typedMemo`. Props are stable (`getRenderedItem` is memoised once in `LegendList`), so React
  reconciliation never descends into a slot because of a parent render. The only way a slot
  re-renders is one of its own signals changing.
- **Position is split from content.** `PositionView` subscribes to `containerPosition{id}` and
  nothing about the item. `Container` subscribes to the item and nothing about position. A scroll
  that moves a slot re-renders the outer `View`'s style only; the rendered row underneath is the
  same element and React skips it.
- **The row is a memoised call, not a child component.** In `Container`:

  ```ts
  const renderedItemInfo = useMemo(
    () => (itemKey !== undefined ? getRenderedItem(itemKey, id) : null),
    [itemKey, data, extraData],
  );
  ```

  `renderItem` runs only when the slot's key, its data object, or the list's `extraData` changes.
  A user's `renderItem` can be a plain function; it gets `memo` semantics from the slot.
- **Row-level hooks read the slot's signals.** `useRecyclingState`, `useRecyclingEffect`,
  `useIsLastItem`, `useViewability` in `src/state/ContextContainer.ts` take the `containerId` from
  context and call `useArr$` on that slot's `containerItemKey`, `containerItemIndex`,
  `containerItemData`. A row can react to "I was recycled to a different item" without the list
  knowing.

## 4. The update pipeline: what happens when `data` changes

Everything runs synchronously inside `calculateItemsInView` (`src/core/calculateItemsInView.ts`,
971 lines), wrapped in `batchedUpdates` so React commits all the `set$` fallout in one pass.

### 4.1 Detecting the change (during render of `LegendList`)

`LegendList.tsx:446-452`:

```ts
const didDataReferenceChangeLocal = state.props.data !== dataProp;
const didDataChangeLocal =
  didDataKeyChangeLocal || didDataVersionChangeLocal ||
  (didDataReferenceChangeLocal && checkStructuralDataChange(state, dataProp, state.props.data));
```

`checkStructuralDataChange` (`src/core/checkStructuralDataChange.ts`) is a single linear pass:
same length, and for every index where `next[i] !== prev[i]`, same key via `keyExtractor` and
equal via `itemsAreEqual`. If the user gives both, a new array with the same rows is **not a data
change at all**, and nothing below runs. It also memoises the per-index verdict in
`state.pendingDataComparison.byIndex` (0 unknown, 1 equal, 2 changed) so the per-container step
below does not call `itemsAreEqual` twice.

The flags land on `state`, and a `useLayoutEffect` keyed on `[dataProp, dataKey, dataVersion, …]`
calls `checkResetContainers` → `calculateItemsInView(ctx, { dataChanged: true, doMVCP: true })`.

### 4.2 Rebuilding positions (`updateItemPositions.ts`)

One loop from `startIndex` over `data`, filling four plain arrays and one map:
`positions[i]`, `columns[i]`, `columnSpans[i]`, `idCache[i]`, `indexByKey`. Sizes come from
`sizesKnown` (measured) or `getItemSize` (fixed or estimate averaged per item type). On a
non-data-change scroll it breaks early after passing the visible window. On a size change it
starts from `positionRecalculationStartIndex`, the lowest index whose size moved, because every
position after it shifted.

None of this touches React. `set$` is called once, for `totalSize`.

### 4.3 Deciding which slot shows which item

Walk from the previous `startBufferedId` backwards until off-screen, then forwards until past the
buffered bottom, producing `startBuffered..endBuffered`. Compare against `containerItemKeys`
(key → slot id). Rows in range with no slot go into `needNewContainers`.

`findAvailableContainers` (`src/utils/findAvailableContainers.ts`) allocates the whole batch at
once: prefer an unassigned or pending-removal slot, then a slot whose item scrolled *farthest* out
of the buffer, matching `getItemType` first so a header slot is reused for a header. It only
grows the pool if nothing is reusable, and warns in dev when it does. Then it re-pairs requests
with slots in React child order so the DOM/native order stays monotonic.

### 4.4 Publishing to the slots

For each allocation, four `set$` calls on that slot's signals:

```ts
set$(ctx, `containerItemKey${c}`, id);
set$(ctx, `containerItemIndex${c}`, i);
set$(ctx, `containerItemData${c}`, data[i]);
// sticky flag, pool bookkeeping …
```

For every slot that keeps its item, `syncMountedContainer` (`src/core/syncMountedContainer.ts`):

```ts
if (position !== prevPos) set$(ctx, `containerPosition${c}`, position);
if (column   !== prevColumn) set$(ctx, `containerColumn${c}`, column);
if (prevIndex !== itemIndex) set$(ctx, `containerItemIndex${c}`, itemIndex);
if (prevData !== item) {
  // cachedComparison from checkStructuralDataChange, else keyExtractor + itemsAreEqual
  if (changed) set$(ctx, `containerItemData${c}`, item);
}
```

That `prevData !== item` branch is the heart of per-item updates. A new `data` array where row 40
is a fresh object but `itemsAreEqual` says it is the same **does not** wake slot 40. A new array
where row 40 genuinely changed wakes slot 40 and only slot 40: `Container` re-renders, its
`useMemo` on `[itemKey, data, extraData]` re-runs `renderItem`, and React diffs that one row.

Slots whose item left the data set are put on `pendingRemoval` and reset: key/index/data to
`undefined`, position to `POSITION_OUT_OF_VIEW` (a large negative), so `ContainerSlot` renders
`null` and the `View` is parked off-screen, ready to be reused.

### 4.5 Measurement feeding back

On the new architecture, a slot's `useLayoutEffect` calls `scheduleContainerLayout(ctx, id)`,
which adds the id to `ctx.pendingContainerIds` and bumps the `containerLayoutEpoch` signal once.
`ContainerLayoutCoordinator`, the *parent* of all slots, subscribes to that epoch and measures
every pending slot in **one** layout effect after all children committed. Sizes go through
`batchItemSizeUpdates` → `updateItemSizesBatch`, which applies every measurement, publishes
`totalSize` once, and runs `calculateItemsInView` once. Many rows changing height in one commit is
one recalculation, not N.

On old arch, or with `getFixedItemSize`, this step is skipped entirely.

### 4.6 Scroll

`onScroll` → `updateScroll` → `calculateItemsInView()` with no `dataChanged`. It first checks the
precomputed `scrollForNextCalculateItemsInView` window: if the buffered range cannot have changed,
it returns after updating viewability. Otherwise it runs the loops above, and because `set$`
dedupes, only slots whose `containerPosition` actually moved wake up. On old arch even that is an
`Animated.Value.setValue`, so zero React renders per frame.

## 5. Why the pattern is powerful

1. **The fan-out is addressed, not broadcast.** Store → slot is 1:1 by name. There is no selector
   run over a big object, no context value that changes identity, no list-level state that a
   child must compare against. Changing row 40 costs O(1) notifications.
2. **The expensive work is outside React and is plain arrays.** Positions, sizes, key→index maps.
   The layout loop is "micro-optimized because it's a hot path" and it can be, because nothing in
   it allocates React elements or triggers reconciliation.
3. **Identity is the only equality.** `set$`, `useArr$`, `syncMountedContainer`,
   `checkStructuralDataChange` all compare with `!==`. Structural equality is delegated to the
   caller through `itemsAreEqual`, once, and cached per index. This is exactly the contract that
   structural-sharing data layers can satisfy for free.
4. **Recycling is safe because the slot's identity is a signal.** A row can ask "who am I now" via
   `useRecyclingState` instead of relying on React `key` semantics. The list can keep `View`s and
   change what they show.
5. **Coalescing is everywhere and cheap.** `batchedUpdates` around the whole recalculation,
   `containerLayoutEpoch` for measurement, `batchItemSizeUpdates`, `ScheduledWork` for
   keyed microtask/frame/timeout work, `useRafCoalescer` on web. Each is ten lines and each turns
   N into 1.
6. **The store is deliberately not general.** The header comment owns it: `use$` is called once
   per unique name, so no disposal bookkeeping. Template-literal signal names give type-safe
   per-slot keys without allocation. This would be a bad general state library and is a very good
   list engine.

## 6. What this means for syncmesh

### 6.1 We already produce the input LegendList wants, and do not tell it

`@syncmesh/drizzle`'s `Live<T>` (`packages/drizzle/src/live.ts`) does exactly the work
`itemsAreEqual` exists to delegate:

```ts
const mergeRows = (current, before, fresh, keyOf) => {
  const rows = fresh.map((row) => {
    const was = before.get(keyOf(row));
    return was === undefined ? row : replaceEqualDeep(was, row);   // keep the old object if equal
  });
  const same = rows.length === current.length && rows.every((row, at) => row === current[at]);
  return same ? current : rows;                                      // keep the old array if equal
};
```

So a fold that changes one issue yields a new `data` array in which 119 row objects are the
*same references* as before and one is new. `checkStructuralDataChange` and
`syncMountedContainer` compare `prev[i] !== next[i]` first; for the 119 rows that is `false` and
they are skipped with no `itemsAreEqual` call. For the one changed row, LegendList wakes one slot.
This already works today and is why the native list survives folds.

What we do not do is tell LegendList that our identity *is* structural equality. Without
`itemsAreEqual`, `checkStructuralDataChange` returns `true` ("structural change") the moment any
index differs by reference, which forces the full `dataChanged` path (reset layout caches, rebuild
`indexByKey`, walk from index 0, run MVCP). Passing

```tsx
<LegendList itemsAreEqual={(a, b) => a === b} … />
```

is correct for us precisely because `replaceEqualDeep` made reference equality mean "unchanged".
Then a fold that changes one row's title is *not* a structural change: no cache reset, no
full-position walk, no MVCP pass. Only the per-container `prevData !== item` branch runs and
wakes one slot.

### 6.2 The native list screen rebuilds `lines` and defeats that

`apps/issues-native/app/index.tsx` builds `lines` from `addressable` with `useMemo`, producing
a fresh array of fresh `{ kind, key, issue }` wrappers whenever `issues.data` changes. Every
wrapper is a new object, so every index differs by reference, and `itemsAreEqual` would be asked
120 times (or, absent it, the structural path runs). The rows inside are shared, the wrappers are
not.

Two fixes, either is enough:

- Cache wrappers by key across `lines` rebuilds (a `Map<string, Line>` in a ref; reuse the wrapper
  when `held.issue === row`). Then wrappers are stable too and `a === b` holds for unchanged rows.
- Or give `itemsAreEqual` the one-level rule: `a.kind === b.kind && (a.kind === "header" ?
  a.count === b.count : a.issue === b.issue)`. Cheap, and correct given `replaceEqualDeep`.

Headers are the other reason `lines` changes: a status count moves when a row changes status.
That is a genuine change to two header items and LegendList will wake exactly those two slots.

### 6.3 `extraData` as a string is the right idea, applied bluntly

The screen passes `extraData={`${personOf.size}:${keyOf.size}`}` so a recycled row learns that
the people map changed. `Container` re-runs `renderItem` on `[itemKey, data, extraData]`, so a
changed `extraData` re-renders **every visible slot**. Sizes only change on add/remove, so a
rename of a person does not propagate at all, and a new person re-renders all rows including ones
that do not reference them.

The LegendList-native answer is to move the lookup *into the row* and make it a subscription
the row owns: an `assignee` read that only that row holds. That is §6.4.

### 6.4 The lesson for our React layer: addressed subscriptions for rows

`useLiveQuery` is a single `useSyncExternalStore` over a `Live` whose snapshot carries
`state: ReadonlyMap<key, row>` and `diff: { added, removed, changed }`. The consumer gets the
whole array and re-renders for any change. That is the right shape for a screen, and the wrong
shape for a row. LegendList's slot signals are the model for what a row wants:

```ts
// sketch — not implemented
const row = useLiveRow(mesh.api.issues.list(input), id);     // re-renders when *this* row changes
const person = useLiveRow(mesh.api.members.list(input), assigneeId);
```

A `Live<T>` can hand this out with no extra queries: it already holds `state` by key and a
`diff` per fold. A per-key listener map on the `Live` (`Map<key, Set<listener>>`), notified from
`diff.changed`/`added`/`removed`, gives the same O(1) fan-out LegendList gets from
`containerItemData{id}`. The row subscribes to its key; the list subscribes to the array. A fold
that changes one issue wakes one row and, if ordering did not move, nothing else.

That would let the native screen drop `extraData` and the `personOf` prop plumbing: `IssueRow`
would read its own assignee, and a renamed person would re-render only rows showing them.

### 6.5 Things we should *not* copy

- The string-keyed store is right for a list engine with a fixed slot vocabulary. It is not right
  for a general client; our `~mesh` descriptors and `Live` already carry identity as keys.
- `useRecyclingState` exists because LegendList reuses `View`s. Our rows are stateless by design
  (`row.tsx` says so); we get recycling for free and should keep it that way.
- The `Animated.Value` no-render path is old-architecture only and the authors note it makes
  position updates asynchronous with the rest of state. Not worth reaching for.

## 7. Concrete follow-ups (none started)

1. `apps/issues-native/app/index.tsx`: pass `itemsAreEqual` and stabilise `lines` wrappers by key.
   Measurable on the fold path with the existing `[join]` timeline.
2. `packages/drizzle` `Live<T>`: per-key `subscribeRow(key, listener)` driven by `diff`. Small.
3. `packages/react`: `useLiveRow(call, key)` over it. Would resolve the `extraData` hack and is the
   piece that makes rows addressable the way LegendList's slots are.
4. Web `list.tsx` is not virtualised. If it ever is, the same two inputs (`keyExtractor`,
   `itemsAreEqual = (a, b) => a === b`) are what to hand any virtualiser.
