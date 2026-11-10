/** A reviewed finding written as prose, cut into what to read first and the
 * evidence that follows. The words are never changed or shortened: the first
 * sentence leads and every other sentence is listed as its own finding, so a
 * long note reads as a point and its support instead of one grey block.
 *
 * A new sentence starts only where a full stop (or ! or ?, optionally followed
 * by a closing quote or bracket) is followed by a space and a capital letter or
 * an opening quote. A bracket never starts one, so "S.A. (Panama)" stays whole,
 * and a number such as 3.0 or $0.9k has no space after its full stop. */
export interface EvidenceNote {
  /** The first sentence. */
  lead: string;
  /** Every following sentence, in order. */
  findings: string[];
}

export function evidenceNote(text: string | null | undefined): EvidenceNote {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return { lead: "", findings: [] };
  const sentences = clean
    .split(/(?<=[.!?][”’'")\]]?)\s+(?=[A-Z“‘"'])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const [lead = "", ...findings] = sentences;
  return { lead, findings };
}
