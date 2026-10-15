const KNOWN_SECRET_FORMATS = [
  { name: "provider_key", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}\b/u },
  { name: "provider_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u },
  { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u },
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { name: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
];

/** Detect common credential formats without returning the matched secret. */
export function findKnownSecretFormats(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return KNOWN_SECRET_FORMATS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ name }) => name);
}
