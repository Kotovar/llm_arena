const SECRET_FLAGS = new Set(["--api-key", "--token", "--password", "--secret"]);
const URL_CREDENTIALS = /(https?:\/\/)[^/@\s]+@/giu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const patterns = secrets.filter(Boolean).map((secret) => new RegExp(escapeRegExp(secret), "gu"));
  return (text) => {
    let result = text.replace(URL_CREDENTIALS, "$1[REDACTED]@");
    for (const pattern of patterns) result = result.replace(pattern, "[REDACTED]");
    return result;
  };
}

export function redactCommand(argv: readonly string[]): string[] {
  let redactNext = false;
  return argv.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return "[REDACTED]";
    }
    if (SECRET_FLAGS.has(argument)) redactNext = true;
    if (/^(--api-key|--token|--password|--secret)=/iu.test(argument)) {
      return `${argument.slice(0, argument.indexOf("="))}=[REDACTED]`;
    }
    return argument.replace(URL_CREDENTIALS, "$1[REDACTED]@");
  });
}
