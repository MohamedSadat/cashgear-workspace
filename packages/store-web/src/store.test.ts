import 'fake-indexeddb/auto';
import { uuidv7 } from '@cgw/workspace';
import { describeLocalStore } from '@cgw/workspace/testing';
import { IndexedDbStore } from './store';

describeLocalStore('IndexedDB', () => IndexedDbStore.open(indexedDB, `test-${uuidv7()}`));
