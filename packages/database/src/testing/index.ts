// `@cgw/database/testing`: the in-memory host, generated databases and a strings provider, for
// tests and the browser harness (bench/editor/database.html). Not for the app.
export { MemoryDatabaseHost, testId, type MemoryHostOptions } from './memoryHost';
export {
  P,
  PEOPLE,
  TASKS_BACK,
  WORKSPACE,
  SECTION,
  page,
  rowRecord,
  seed,
  tasksProperties,
  type Seeded,
} from './fixtures';
export { StringsProvider } from './StringsProvider';
