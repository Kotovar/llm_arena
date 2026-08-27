export function buildTaskPrompt(prompt: string, trustedInstructions?: string) {
  return trustedInstructions ? `${trustedInstructions}\n\nUser task:\n${prompt}` : prompt;
}
