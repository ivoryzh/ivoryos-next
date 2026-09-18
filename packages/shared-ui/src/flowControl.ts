/**
 * The designer's own built-in steps, described the same way an instrument's methods are.
 *
 * Flow control is not introspected from any driver, so it has no entry in `/api/status` — which
 * meant a block rebuilt from saved JSON (`toSequenceBlock`) found no schema and rendered with no
 * fields at all. The values were still in `params` and still ran correctly; they were simply
 * invisible and uneditable, so reopening a saved workflow lost the ability to change an `If`
 * condition or a `User_Input` prompt.
 *
 * Keyed by the method name that is actually *executed* and stored (`If`, `End_While`), not by the
 * toolbox entry a person drags in (`If_Else_Block`, which expands into three of these). The two
 * namespaces are easy to confuse and were exactly the reason the lookup silently missed.
 *
 * Mirrors `FLOW_CONTROL_METHODS` in `edge_server/ivoryos_edge/agent/deck.py`, which describes the
 * same steps to a language model, and `queue.py`, which executes them. Three copies of one
 * vocabulary is two too many, but they serve different runtimes; keep them in step.
 */

export const FLOW_CONTROL_INSTRUMENTS = ['Flow_Control', 'Flow Control'];

export const isFlowControlInstrument = (instrument: string | undefined): boolean =>
  FLOW_CONTROL_INSTRUMENTS.includes(String(instrument || ''));

export const FLOW_CONTROL_SCHEMAS: Record<string, any> = {
  If: {
    description: 'Run the following steps only when the condition holds.',
    parameters: { condition: { type: 'str', required: true } },
    return_type: 'None',
  },
  Else: {
    description: 'The alternative branch of the enclosing If.',
    parameters: {},
    return_type: 'None',
  },
  End_If: {
    description: 'Closes the enclosing If.',
    parameters: {},
    return_type: 'None',
  },
  While: {
    description: 'Repeat the following steps while the condition holds.',
    parameters: { condition: { type: 'str', required: true } },
    return_type: 'None',
  },
  End_While: {
    description: 'Closes the enclosing While.',
    parameters: {},
    return_type: 'None',
  },
  Sleep: {
    description: 'Pause execution for a number of seconds.',
    parameters: { duration_seconds: { type: 'float', required: true } },
    return_type: 'None',
  },
  User_Input: {
    description: 'Pause and ask a person to type in a value (human-in-the-loop).',
    parameters: {
      prompt: { type: 'str', required: true },
      variable_name: { type: 'str', required: true },
      input_type: { type: 'str', required: false, default: 'str', options: ['str', 'int', 'float', 'bool'] },
    },
    return_type: 'None',
  },
  Comment: {
    description: "Add a note to the run log — like Python's print().",
    parameters: { message: { type: 'str', required: true } },
    return_type: 'None',
  },
};

/** The schema for a built-in step, or undefined if `method` is not one. */
export function flowControlSchema(instrument: string | undefined, method: string | undefined): any {
  if (!isFlowControlInstrument(instrument)) return undefined;
  return FLOW_CONTROL_SCHEMAS[String(method || '')];
}
