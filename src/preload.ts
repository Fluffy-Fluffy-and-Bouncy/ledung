// Loaded with --import before Ledung's core by the `ledung` command (src/cli.ts): drops Node's SQLite
// ExperimentalWarning and no other (#428, src/platform/node-warnings.ts).
import { dropSqliteWarning } from './platform/node-warnings.ts';

dropSqliteWarning();
