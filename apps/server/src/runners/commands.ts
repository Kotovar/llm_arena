export function buildOmpCommand(exec: readonly string[], workspace: string, modelAlias: string, prompt: string, useAgentEnvironment = false): string[] {
  return [
    ...exec,
    "--mode",
    "json",
    "--print",
    "--no-session",
    ...(useAgentEnvironment ? [] : ["--no-extensions", "--no-skills", "--no-rules"]),
    "--cwd",
    workspace,
    "--model",
    `llama.cpp/${modelAlias}`,
    "--approval-mode",
    "yolo",
    prompt,
  ];
}

export function buildClaudeCommand(exec: readonly string[], model: string, effort: string | null | undefined, prompt: string): string[] {
  return [
    ...exec,
    "-p",
    "--safe-mode",
    "--no-session-persistence",
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    model,
    ...(effort ? ["--effort", effort] : []),
    prompt,
  ];
}

export function buildCodexCommand(exec: readonly string[], workspace: string, model: string, effort?: string | null): string[] {
  return [
    ...exec,
    "-s",
    "workspace-write",
    "-a",
    "never",
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-C",
    workspace,
    ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
    "-m",
    model,
    "-",
  ];
}
