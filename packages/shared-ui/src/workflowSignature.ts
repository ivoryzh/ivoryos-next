/**
 * A stable fingerprint of what a workflow *is*, used to tell "edited since it was last saved"
 * apart from "just reloaded the page".
 *
 * Block ids are regenerated every time a workflow is rebuilt from disk, and expand/collapse is a
 * view preference rather than content, so both are excluded — otherwise merely reopening a saved
 * workflow would look like an edit and the designer would show "Unsaved" before anyone touched it.
 */
type SignatureBlock = {
  instrument: string;
  method: string;
  params?: Record<string, any>;
  returnVar?: string;
  isHidden?: boolean;
  isBatchAction?: boolean;
};

const normalize = (blocks: SignatureBlock[] = []) =>
  blocks.map(b => ({
    instrument: b.instrument,
    method: b.method,
    params: b.params || {},
    returnVar: b.returnVar || '',
    isHidden: !!b.isHidden,
    isBatchAction: !!b.isBatchAction,
  }));

export function workflowSignature(
  prep: SignatureBlock[],
  sequence: SignatureBlock[],
  cleanup: SignatureBlock[],
  name: string,
  description: string
): string {
  return JSON.stringify({
    name: name || '',
    description: description || '',
    prep: normalize(prep),
    sequence: normalize(sequence),
    cleanup: normalize(cleanup),
  });
}
