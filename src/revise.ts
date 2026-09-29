/** Build the user message sent to the model on a "revise" action. */
export function buildReviseMessage(file: string, feedback: string, hunkLines: string[]): string {
  return `Please revise \`${file}\`: ${feedback}. The relevant hunk was: ${hunkLines.join("\n")}`;
}
