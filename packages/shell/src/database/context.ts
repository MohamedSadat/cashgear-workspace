// The open workspace's database host, for everything inside the frame that draws a database (a
// database's page, a row's page, a database block in the editor, the dialogs that make one).
import { createContext, useContext } from 'react';
import type { ShellDatabaseHost } from './host';

export const DatabaseHostContext = createContext<ShellDatabaseHost | null>(null);

/** The host, or null outside the workspace (a page shared by link, a test). */
export function useDatabaseHost(): ShellDatabaseHost | null {
  return useContext(DatabaseHostContext);
}
