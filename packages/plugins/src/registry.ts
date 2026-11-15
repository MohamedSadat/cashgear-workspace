// The definitions a build has, by type. First-party definitions are compiled into the app; a type
// a registry does not have is drawn by the editor as a placeholder and kept as it is.
import type { BlockDefinition } from './types';

export interface PluginRegistry {
  has(type: string): boolean;
  get(type: string): BlockDefinition | undefined;
  /** In the order given, for the slash menu. */
  list(): readonly BlockDefinition[];
}

/**
 * A definition as a registry holds it: its props' type erased. Safe because a definition's props
 * only ever go from its own `props.read` to its own `render` and `toPlainText` (`readBlock`).
 */
export function untyped<Props extends object>(definition: BlockDefinition<Props>): BlockDefinition {
  return definition as unknown as BlockDefinition;
}

/** Types are names like `cashgear.chart`: lower-case words joined by dots, 3 to 64 characters. */
const TYPE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export function createRegistry(definitions: readonly BlockDefinition[]): PluginRegistry {
  const byType = new Map<string, BlockDefinition>();
  for (const definition of definitions) {
    if (!TYPE.test(definition.type) || definition.type.length > 64)
      throw new Error(`A plugin type is a dotted lower-case name: ${definition.type}`);
    if (!Number.isInteger(definition.version) || definition.version < 1)
      throw new Error(`A plugin's version is a whole number from 1: ${definition.type}`);
    if (byType.has(definition.type))
      throw new Error(`A plugin type is defined twice: ${definition.type}`);
    byType.set(definition.type, definition);
  }
  const list = [...byType.values()];
  return {
    has: (type) => byType.has(type),
    get: (type) => byType.get(type),
    list: () => list,
  };
}
