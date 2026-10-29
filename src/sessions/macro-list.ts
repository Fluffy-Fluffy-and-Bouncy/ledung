// The shape of the macro list Settings saves (issue #410); macrosProblem (src/shared/macros.ts) checks the rest.
import { z } from 'zod';
import { MAX_MACRO_NAME, MAX_MACRO_TEXT, MAX_MACROS } from '../shared/macros.ts';

export const MacroList = z.array(z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(MAX_MACRO_NAME + 20),
  text: z.string().min(1).max(MAX_MACRO_TEXT),
  send: z.boolean(),
  key: z.string().max(40).nullable(),
  chip: z.boolean(),
  project: z.string().min(1).max(200).nullable(),
}).strict()).max(MAX_MACROS);
