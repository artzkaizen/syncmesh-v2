# SQLite state schema
import { Tabs, TabItem } from '@astrojs/starlight/components';
LiveStore provides a schema definition language for defining your database tables and mutation definitions using explicit column configurations. LiveStore automatically migrates your database schema when you change your schema definitions.
> **Alternative Approach**: You can also define tables using [Effect Schema with annotations](/building-with-livestore/state/sqlite-schema-effect) for type-safe schema definitions.
### Example
## `reference/state/sqlite-schema/schema.ts`
```ts filename="reference/state/sqlite-schema/schema.ts"
import { Events, makeSchema, Schema, SessionIdSymbol, State } from '@livestore/livestore'
// You can model your state as SQLite tables (https://docs.livestore.dev/reference/state/sqlite-schema)
export const tables = {
 todos: State.SQLite.table({
 name: 'todos',
 columns: {
 id: State.SQLite.text({ primaryKey: true }),
 text: State.SQLite.text({ default: '' }),
 completed: State.SQLite.boolean({ default: false }),
 deletedAt: State.SQLite.integer({ nullable: true, schema: Schema.DateFromMillis }),
 },
 }),
 // Client documents can be used for local-only state (e.g. form inputs)
 uiState: State.SQLite.clientDocument({
 name: 'uiState',
 schema: Schema.Struct({ newTodoText: Schema.String, filter: Schema.Literals(['all', 'active', 'completed']) }),
 default: { id: SessionIdSymbol, value: { newTodoText: '', filter: 'all' } },
 }),
}
// Events describe data changes (https://docs.livestore.dev/reference/events)
export const events = {
 todoCreated: Events.synced({
 name: 'v1.TodoCreated',
 schema: Schema.Struct({ id: Schema.String, text: Schema.String }),
 }),
 todoCompleted: Events.synced({
 name: 'v1.TodoCompleted',
 schema: Schema.Struct({ id: Schema.String }),
 }),
 todoUncompleted: Events.synced({
 name: 'v1.TodoUncompleted',
 schema: Schema.Struct({ id: Schema.String }),
 }),
 todoDeleted: Events.synced({
 name: 'v1.TodoDeleted',
 schema: Schema.Struct({
 id: Schema.String,
 deletedAt: Schema.DateFromString.check(Schema.isDateValid()),
 }),
 }),
 todoClearedCompleted: Events.synced({
 name: 'v1.TodoClearedCompleted',
 schema: Schema.Struct({ deletedAt: Schema.DateFromString.check(Schema.isDateValid()) }),
 }),
 uiStateSet: tables.uiState.set,
}
// Materializers are used to map events to state (https://docs.livestore.dev/reference/state/materializers)
const materializers = State.SQLite.materializers(events, {
 'v1.TodoCreated': ({ id, text }) => tables.todos.insert({ id, text, completed: false }),
 'v1.TodoCompleted': ({ id }) => tables.todos.update({ completed: true }).where({ id }),
 'v1.TodoUncompleted': ({ id }) => tables.todos.update({ completed: false }).where({ id }),
 'v1.TodoDeleted': ({ id, deletedAt }) => tables.todos.update({ deletedAt }).where({ id }),
 'v1.TodoClearedCompleted': ({ deletedAt }) => tables.todos.update({ deletedAt }).where({ completed: true }),
})
const state = State.SQLite.makeState({ tables, materializers })
export const schema = makeSchema({ events, state })
```
## Defining tables
Define SQLite tables using explicit column definitions:
## `reference/state/sqlite-schema/columns/table-basic.ts`
```ts filename="reference/state/sqlite-schema/columns/table-basic.ts"
import { State } from '@livestore/livestore'
export const userTable = State.SQLite.table({
 name: 'users',
 columns: {
 id: State.SQLite.text({ primaryKey: true }),
 email: State.SQLite.text(),
 name: State.SQLite.text(),
 age: State.SQLite.integer({ default: 0 }),
 isActive: State.SQLite.boolean({ default: true }),
 metadata: State.SQLite.json({ nullable: true }),
 },
 indexes: [{ name: 'idx_users_email', columns: ['email'], isUnique: true }],
})
```
Use the optional `indexes` array to declare secondary indexes or enforce uniqueness (set `isUnique: true`).
## Column types
You can use these column types when defining tables:
### Core SQLite column types
- `State.SQLite.text`: A text field, returns `string`.
- `State.SQLite.integer`: An integer field, returns `number`.
- `State.SQLite.real`: A real field (floating point number), returns `number`.
- `State.SQLite.blob`: A blob field (binary data), returns `Uint8Array`.
### Higher level column types
- `State.SQLite.boolean`: An integer field that stores `0` for `false` and `1` for `true` and returns a `boolean`.
- `State.SQLite.json`: A text field that stores a stringified JSON object and returns a decoded JSON value.
- `State.SQLite.datetime`: A text field that stores dates as ISO 8601 strings and returns a `Date`.
- `State.SQLite.datetimeInteger`: A integer field that stores dates as the number of milliseconds since the epoch and returns a `Date`.
### Custom column schemas
You can also provide a custom schema for a column which is used to automatically encode and decode the column value.
### Example: JSON-encoded struct
## `reference/state/sqlite-schema/columns/json-struct.ts`
```ts filename="reference/state/sqlite-schema/columns/json-struct.ts"
import { Schema, State } from '@livestore/livestore'
export const UserMetadata = Schema.Struct({
 petName: Schema.String,
 favoriteColor: Schema.Literals(['red', 'blue', 'green']),
})
export const userTable = State.SQLite.table({
 name: 'user',
 columns: {
 id: State.SQLite.text({ primaryKey: true }),
 name: State.SQLite.text(),
 metadata: State.SQLite.json({ schema: UserMetadata }),
 },
})
```
### Schema migrations
Migration strategies:
- `auto`: Automatically migrate the database to the newest schema and rematerializes the state from the eventlog.
- `manual`: Manually migrate the database to the newest schema.
## Client documents
- Meant for convenience
- Client-only
- Goal: Similar ease of use as `React.useState()`
- When schema changes in a non-backwards compatible way, previous events are dropped and the state is reset
 - Don't use client documents for sensitive data which must not be lost
- Implies
 - Table with `id` and `value` columns
 - `${MyTable}Set` event + materializer (which are auto-registered)
### Basic usage
## `reference/state/sqlite-schema/columns/client-document-basic.tsx`
```tsx filename="reference/state/sqlite-schema/columns/client-document-basic.tsx"
import React from 'react'
import type { Store } from '@livestore/livestore'
import { tables } from '../../../framework-integrations/react/schema.ts'
import { useAppStore } from '../../../framework-integrations/react/store.ts'
export const readUiState = (store: Store): { newTodoText: string; filter: 'all' | 'active' | 'completed' } =>
 store.query(tables.uiState.get())
export const setNewTodoText = (store: Store, newTodoText: string): void => {
 store.commit(tables.uiState.set({ newTodoText }))
}
export const UiStateFilter: React.FC = () => {
 const store = useAppStore()
 const [state, setState] = store.useClientDocument(tables.uiState)
 const showActive = React.useCallback(() => {
 setState({ filter: 'active' })
 }, [setState])
 const showAll = React.useCallback(() => {
 setState({ filter: 'all' })
 }, [setState])
 return (
 All
 Active ({state.filter === 'active' ? 'selected' : 'select'})
 )
}
```
### `reference/framework-integrations/react/schema.ts`
```ts filename="reference/framework-integrations/react/schema.ts"
import { defineMaterializer, Events, makeSchema, Schema, SessionIdSymbol, State } from '@livestore/livestore'
export const tables = {
 todos: State.SQLite.table({
 name: 'todos',
 columns: {
 id: State.SQLite.text({ primaryKey: true }),
 text: State.SQLite.text(),
 completed: State.SQLite.boolean({ default: false }),
 createdAt: State.SQLite.datetime(),
 },
 }),
 uiState: State.SQLite.clientDocument({
 name: 'UiState',
 schema: Schema.Struct({
 newTodoText: Schema.String,
 filter: Schema.Literals(['all', 'active', 'completed']),
 }),
 default: { id: SessionIdSymbol, value: { newTodoText: '', filter: 'all' } },
 }),
} as const
export const events = {
 todoCreated: Events.synced({
 name: 'v1.TodoCreated',
 schema: Schema.Struct({
 id: Schema.String,
 text: Schema.String,
 createdAt: Schema.DateFromString.check(Schema.isDateValid()),
 }),
 }),
} as const
const materializers = State.SQLite.materializers(events, {
 [events.todoCreated.name]: defineMaterializer(events.todoCreated, ({ id, text, createdAt }) =>
 tables.todos.insert({ id, text, completed: false, createdAt }),
 ),
})
const state = State.SQLite.makeState({ tables, materializers })
export const schema = makeSchema({ events, state })
```
### `reference/framework-integrations/react/store.ts`
```ts filename="reference/framework-integrations/react/store.ts"
import { unstable_batchedUpdates as batchUpdates } from 'react-dom'
import { makeInMemoryAdapter } from '@livestore/adapter-web'
import { useStore } from '@livestore/react'
import { schema } from './schema.ts'
const adapter = makeInMemoryAdapter()
export const useAppStore = () =>
 useStore({
 storeId: 'app-root',
 schema,
 adapter,
 batchUpdates,
 })
```
### KV-style client document
Sometimes you want a simple key-value store for arbitrary values without partial merging. You can model this by using `Schema.Any` as the value schema. With `Schema.Any`, updates fully replace the stored value (no partial merge semantics).
## `reference/state/sqlite-schema/columns/client-document-kv.tsx`
```tsx filename="reference/state/sqlite-schema/columns/client-document-kv.tsx"
import { type FC, useCallback } from 'react'
import { Schema, State, type Store } from '@livestore/livestore'
import { useAppStore } from '../../../framework-integrations/react/store.ts'
export const kv = State.SQLite.clientDocument({
 name: 'Kv',
 schema: Schema.Any,
 default: { value: null },
})
export const readKvValue = (store: Store, id: string): unknown => store.query(kv.get(id))
export const setKvValue = (store: Store, id: string, value: unknown): void => {
 store.commit(kv.set(value, id))
}
export const KvViewer: FC = ({ id }) => {
 const store = useAppStore()
 const [value, setValue] = store.useClientDocument(kv, id)
 const handleClick = useCallback(() => {
 setValue('hello')
 }, [setValue])
 return (
 Current value: {JSON.stringify(value)}
 )
}
```
### `reference/framework-integrations/react/schema.ts`
```ts filename="reference/framework-integrations/react/schema.ts"
import { defineMaterializer, Events, makeSchema, Schema, SessionIdSymbol, State } from '@livestore/livestore'
export const tables = {
 todos: State.SQLite.table({
 name: 'todos',
 columns: {
 id: State.SQLite.text({ primaryKey: true }),
 text: State.SQLite.text(),
 completed: State.SQLite.boolean({ default: false }),
 createdAt: State.SQLite.datetime(),
 },
 }),
 uiState: State.SQLite.clientDocument({
 name: 'UiState',
 schema: Schema.Struct({
 newTodoText: Schema.String,
 filter: Schema.Literals(['all', 'active', 'completed']),
 }),
 default: { id: SessionIdSymbol, value: { newTodoText: '', filter: 'all' } },
 }),
} as const
export const events = {
 todoCreated: Events.synced({
 name: 'v1.TodoCreated',
 schema: Schema.Struct({
 id: Schema.String,
 text: Schema.String,
 createdAt: Schema.DateFromString.check(Schema.isDateValid()),
 }),
 }),
} as const
const materializers = State.SQLite.materializers(events, {
 [events.todoCreated.name]: defineMaterializer(events.todoCreated, ({ id, text, createdAt }) =>
 tables.todos.insert({ id, text, completed: false, createdAt }),
 ),
})
const state = State.SQLite.makeState({ tables, materializers })
export const schema = makeSchema({ events, state })
```
### `reference/framework-integrations/react/store.ts`
```ts filename="reference/framework-integrations/react/store.ts"
import { unstable_batchedUpdates as batchUpdates } from 'react-dom'
import { makeInMemoryAdapter } from '@livestore/adapter-web'
import { useStore } from '@livestore/react'
import { schema } from './schema.ts'
const adapter = makeInMemoryAdapter()
export const useAppStore = () =>
 useStore({
 storeId: 'app-root',
 schema,
 adapter,
 batchUpdates,
 })
```
## Column types
You can use these column types:
#### Core SQLite column types
- `State.SQLite.text`: A text field, returns `string`.
- `State.SQLite.integer`: An integer field, returns `number`.
- `State.SQLite.real`: A real field (floating point number), returns `number`.
- `State.SQLite.blob`: A blob field (binary data), returns `Uint8Array`.
#### Higher level column types
- `State.SQLite.boolean`: An integer field that stores `0` for `false` and `1` for `true` and returns a `boolean`.
- `State.SQLite.json`: A text field that stores a stringified JSON object and returns a decoded JSON value.
- `State.SQLite.datetime`: A text field that stores dates as ISO 8601 strings and returns a `Date`.
- `State.SQLite.datetimeInteger`: A integer field that stores dates as the number of milliseconds since the epoch and returns a `Date`.
#### Custom column schemas
You can also provide a custom schema for a column which is used to automatically encode and decode the column value.
#### Example: JSON-encoded struct
## `reference/state/sqlite-schema/columns/json-struct.ts`
```ts filename="reference/state/sqlite-schema/columns/json-struct.ts"
import { Schema, State } from '@livestore/livestore'
export const UserMetadata = Schema.Struct({
 petName: Schema.String,
 favoriteColor: Schema.Literals(['red', 'blue', 'green']),
})
export const userTable = State.SQLite.table({
 name: 'user',
 columns: {
 id: State.SQLite.text({ primaryKey: true }),
 name: State.SQLite.text(),
 metadata: State.SQLite.json({ schema: UserMetadata }),
 },
})
```
## Best practices
### Column configuration
- Use appropriate SQLite column types for your data (text, integer, real, blob)
- Set `primaryKey: true` for primary key columns
- Use `nullable: true` for columns that can contain NULL values
- Provide meaningful `default` values where appropriate
- Add unique constraints via table `indexes` using `isUnique: true`
### Schema design
- Choose column types that match your data requirements
- Use custom schemas with `State.SQLite.json()` for complex data structures
- Group related table definitions in the same module
- Use descriptive table and column names
### General practices
- It's usually recommend to **not distinguish** between app state vs app data but rather keep all state in LiveStore.
	- This means you'll rarely use `React.useState()` when using LiveStore
- In some cases for "fast changing values" it can make sense to keep a version of a state value outside of LiveStore with a reactive setter for React and a debounced setter for LiveStore to avoid excessive LiveStore mutations. Cases where this can make sense can include:
 - Text input / rich text editing
 - Scroll position tracking, resize events, move/drag events
 - ...
