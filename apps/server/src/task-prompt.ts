export function buildTaskPrompt(prompt: string, trustedInstructions?: string) {
  return trustedInstructions ? `${trustedInstructions}\n\nЗадание пользователя:\n${prompt}` : prompt;
}
